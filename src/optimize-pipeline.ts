import { aiMapping, aiParse } from './api';
import {
  buildAiMappingFunctions,
  buildGoldenFormatMapping,
  getCompactOutputFunctions,
  getMappingFunctions,
  getParserForSourcetype,
  hasGoldenFormatPath,
  isCimFormat,
  isOcsfScoredFormat,
  sanitizeCriblFunctions,
  withSchematizerCanonicalAliases,
} from './pack-builder';
import {
  splicePipelineStage,
  splitPipelineFunctions,
  type PipelineStageId,
} from './pipeline-stages';
import { ocsfClassByUid, ocsfClassDef, parseOcsfGuidance, type OcsfGuidance } from './ocsf-schema';

export type OptimizeGoal = 'sample' | 'extraction' | 'mapping' | 'optimization';

export interface OptimizeStageContext {
  currentFunctions: any[];
  workerGroup: string;
  packId: string;
  pipelineId: string;
  sourcetype: string;
  destFormat: string;
  sampleEvents: string;
  guidance?: string;
  /** CIM flat-output preference — carried so a repair/optimize doesn't revert a
   * flat-CIM build back to the serialized-_raw (Splunk-HEC) shape. */
  cimFlat?: boolean;
}

export interface OptimizePipelineArgs {
  workerGroup: string;
  packId: string;
  pipelineId: string;
  sourcetype: string;
  destFormat: string;
  sampleEvents: string;
  cimFlat?: boolean;
  baselineFunctions: any[];
  goals: OptimizeGoal[];
  guidance?: string;
  /** OCSF class the user asked for; parsed from `guidance` when omitted. */
  guidedOcsf?: OcsfGuidance | null;
  thresholds: { extraction: number; mapping: number; optimization: number };
  log: (m: string) => void;
  onStage?: (r: OptimizeStageResult) => void;
  /** Live status line for the UI while a stage is running. */
  onStatus?: (message: string) => void;
  improveExtraction?: (ctx: OptimizeStageContext) => Promise<any[]>;
  improveMapping?: (ctx: OptimizeStageContext) => Promise<any[]>;
  improveOptimization?: (ctx: OptimizeStageContext) => Promise<any[]>;
  /**
   * Score a full function list for best-wins. `stage` selects the metric:
   * extraction → extraction score, mapping → mapping score, optimization →
   * average of extraction+mapping (the user-facing total).
   */
  scoreFns?: (fns: any[], stage: PipelineStageId) => Promise<number | null>;
}

export interface OptimizeStageResult {
  stage: OptimizeGoal;
  score: number | null;
  kept: 'new' | 'baseline';
  /** Human-readable note of what this stage did (or why it kept baseline). */
  summary?: string;
  /** Plain-language outcome of an OCSF class the user asked for in guidance. */
  guidanceNote?: string;
}

/** A guided-class candidate is accepted unless it scores more than this many points under the baseline. */
export const GUIDED_CLASS_TOLERANCE = 5;

/** The OCSF class_uid literals a pipeline sets (`class_uid` or `<envelope>.class_uid`). */
export function emittedOcsfClassUids(functions: any[]): number[] {
  const uids = new Set<number>();
  for (const fn of functions || []) {
    if (fn?.id !== 'eval') continue;
    for (const add of fn?.conf?.add || []) {
      const name = String(add?.name ?? '');
      if (name !== 'class_uid' && !name.endsWith('.class_uid')) continue;
      const m = String(add?.value ?? '').trim().match(/^['"]?(\d{1,4})['"]?$/);
      if (m) uids.add(Number(m[1]));
    }
  }
  return [...uids];
}

function classLabel(uid: number | undefined): string {
  if (uid == null) return 'the current class';
  const name = ocsfClassByUid(uid);
  return (name && ocsfClassDef(name)?.caption) || `class ${uid}`;
}

/**
 * Best-wins with the user's OCSF class choice taken into account. A candidate
 * that emits the class the guidance asked for (and the baseline does not) is
 * kept unless it scores more than GUIDED_CLASS_TOLERANCE under the baseline; the
 * note says why in plain words either way. Without a guided class this is plain
 * best-wins and the note is empty.
 */
export function guidedAcceptance(opts: {
  candidateScore: number | null;
  baselineScore: number | null;
  guided?: OcsfGuidance | null;
  candidateFunctions: any[];
  baselineFunctions: any[];
}): { keep: boolean; note?: string } {
  const { candidateScore, baselineScore, guided } = opts;
  const plain = candidateScore !== null && (baselineScore === null || candidateScore >= baselineScore);
  const want = guided?.classUid;
  if (want == null) return { keep: plain };
  const candUids = emittedOcsfClassUids(opts.candidateFunctions);
  const baseUids = emittedOcsfClassUids(opts.baselineFunctions);
  const wantLabel = `${want} (${classLabel(want)})`;
  if (baseUids.length === 1 && baseUids[0] === want) return { keep: plain };
  const baseLabel = baseUids.length === 1 ? `${baseUids[0]} (${classLabel(baseUids[0])})` : 'the current mapping';
  if (!candUids.includes(want)) {
    return { keep: plain, note: `Your guidance asked for class_uid ${wantLabel}, but the candidate mapping did not emit it${candUids.length ? ` (it emitted ${candUids.join(', ')})` : ''}.` };
  }
  if (candidateScore === null) {
    return { keep: false, note: `The ${wantLabel} mapping could not be scored, so the deployed ${baseLabel} was kept.` };
  }
  const vs = `the ${want} mapping scored ${candidateScore} vs ${baselineScore ?? 'n/a'} for ${baseLabel}`;
  if (plain) return { keep: true, note: `Accepted per your guidance: ${vs}.` };
  if (baselineScore !== null && candidateScore >= baselineScore - GUIDED_CLASS_TOLERANCE) {
    return { keep: true, note: `Accepted per your guidance: ${vs} (within ${GUIDED_CLASS_TOLERANCE} points).` };
  }
  return { keep: false, note: `Kept the deployed mapping: ${vs}, more than ${GUIDED_CLASS_TOLERANCE} points worse.` };
}

const STAGE_ORDER: OptimizeGoal[] = ['sample', 'extraction', 'mapping', 'optimization'];

function parsedFieldNames(functions: any[]): string[] {
  const names = new Set<string>();
  for (const fn of functions) {
    for (const add of fn?.conf?.add || []) {
      if (typeof add?.name === 'string') names.add(add.name);
    }
    for (const field of fn?.conf?.fields || []) {
      if (typeof field === 'string') names.add(field);
    }
    const regex = fn?.conf?.regex;
    if (typeof regex === 'string') {
      for (const match of regex.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) names.add(match[1]);
    }
  }
  return [...names];
}

function mappedFieldNames(functions: any[]): string[] {
  return functions.flatMap(fn => (fn?.conf?.add || [])
    .map((add: any) => add?.name)
    .filter((name: unknown): name is string => typeof name === 'string'));
}

async function defaultExtraction(ctx: OptimizeStageContext): Promise<any[]> {
  const generated = await aiParse(ctx.sourcetype, ctx.sampleEvents, undefined, undefined, ctx.guidance);
  const functions = generated?.functions?.length
    ? generated.functions
    : getParserForSourcetype(ctx.sourcetype, false);
  return sanitizeCriblFunctions(functions).functions;
}

async function defaultMapping(ctx: OptimizeStageContext): Promise<any[]> {
  const extraction = splitPipelineFunctions(ctx.currentFunctions).extraction;
  const parsedNames = parsedFieldNames(extraction);

  // Prefer deterministic golden/static mapping when we have a known path.
  // Always prepend Copilot→canonical aliases and strip mid-map serialize/keep
  // so every optimize path matches new-pack / batch assembly.
  if (hasGoldenFormatPath(ctx.sourcetype, ctx.destFormat, ctx.sampleEvents)) {
    const golden = buildGoldenFormatMapping(ctx.sourcetype, ctx.destFormat, undefined, ctx.sampleEvents);
    if (golden.length) {
      return withSchematizerCanonicalAliases(sanitizeCriblFunctions(golden).functions);
    }
  }
  const staticMap = getMappingFunctions(ctx.sourcetype, ctx.destFormat);
  if (staticMap.length) {
    return withSchematizerCanonicalAliases(sanitizeCriblFunctions(staticMap).functions);
  }

  const mapping = await aiMapping(
    ctx.sourcetype,
    ctx.destFormat,
    ctx.sampleEvents,
    undefined,
    parsedNames.length ? parsedNames : undefined,
    { guidance: ctx.guidance, currentFunctions: ctx.currentFunctions },
  );
  if (!mapping) {
    return withSchematizerCanonicalAliases(splitPipelineFunctions(ctx.currentFunctions).mapping);
  }
  return withSchematizerCanonicalAliases(sanitizeCriblFunctions(
    buildAiMappingFunctions(mapping, ctx.sourcetype, ctx.destFormat),
  ).functions);
}

async function defaultOptimization(ctx: OptimizeStageContext): Promise<any[]> {
  // Legacy raw-field reduction rules are retired. Keep only destination output
  // shaping here so mapping repair cannot leave CIM/Sentinel in an invalid
  // envelope. OCSF optimization is owned by Post-Processing.
  const mappingFields = mappedFieldNames(splitPipelineFunctions(ctx.currentFunctions).mapping);
  return getCompactOutputFunctions(
    ctx.sourcetype,
    ctx.destFormat,
    true,
    mappingFields,
    isCimFormat(ctx.destFormat),
    isCimFormat(ctx.destFormat) && !!ctx.cimFlat,
  );
}

export async function optimizePipelineStages(args: OptimizePipelineArgs): Promise<{
  finalFunctions: any[];
  stageResults: OptimizeStageResult[];
}> {
  let current = args.baselineFunctions.slice();
  const stageResultsArr: OptimizeStageResult[] = [];
  const goals = new Set(args.goals);
  // An OCSF class named in Additional guidance (class_uid=3003, "Authorize
  // Session") becomes the mapping target and relaxes best-wins for it.
  const guided = args.guidedOcsf !== undefined
    ? args.guidedOcsf
    : (isOcsfScoredFormat(args.destFormat) ? parseOcsfGuidance(args.guidance) : null);
  const destFormat = guided?.key && isOcsfScoredFormat(args.destFormat) ? guided.key : args.destFormat;
  if (guided?.key && destFormat !== args.destFormat) args.log(`Guidance targets OCSF ${guided.caption} (${guided.classUid}) — mapping to ${destFormat}.`);

  const context = (): OptimizeStageContext => ({
    currentFunctions: current,
    workerGroup: args.workerGroup,
    packId: args.packId,
    pipelineId: args.pipelineId,
    sourcetype: args.sourcetype,
    destFormat,
    sampleEvents: args.sampleEvents,
    guidance: args.guidance,
    cimFlat: args.cimFlat,
  });

  const improvers: Record<PipelineStageId, (ctx: OptimizeStageContext) => Promise<any[]>> = {
    extraction: args.improveExtraction || defaultExtraction,
    mapping: args.improveMapping || defaultMapping,
    optimization: args.improveOptimization || defaultOptimization,
  };

  for (const stage of STAGE_ORDER) {
    if (!goals.has(stage)) continue;

    if (stage === 'sample') {
      const result: OptimizeStageResult = {
        stage,
        score: null,
        kept: 'baseline',
        summary: 'Sample handled by the caller — pipeline functions unchanged.',
      };
      stageResultsArr.push(result);
      args.onStage?.(result);
      args.log('Sample optimization is handled by the caller; pipeline functions are unchanged.');
      continue;
    }

    let result: OptimizeStageResult;
    try {
      args.onStatus?.(`Improving ${stage}…`);
      args.log(`Starting ${stage} improvement…`);

      // Re-score the current pipeline with THIS stage's metric so best-wins
      // never compares extraction scores against mapping totals.
      const baselineForStage = args.scoreFns ? await args.scoreFns(current, stage) : null;
      args.onStatus?.(`Building a better ${stage} candidate…`);
      const candidateStage = await improvers[stage](context());
      const spliced = splicePipelineStage(current, stage, candidateStage);
      // Mapping replace drops stale compact (see splicePipelineStage). Attach a
      // fresh compact for scoring so best-wins sees real CIM output, not an empty
      // wipe from an older keep-list.
      const scoredCandidate = stage === 'mapping'
        ? [...spliced, ...getCompactOutputFunctions(
          args.sourcetype,
          destFormat,
          true,
          mappedFieldNames(candidateStage),
          isCimFormat(destFormat),
          isCimFormat(destFormat) && !!args.cimFlat,
        )]
        : spliced;
      args.onStatus?.(`Scoring ${stage} candidate against the live baseline…`);
      const candidateScore = args.scoreFns ? await args.scoreFns(scoredCandidate, stage) : null;
      // An unmeasurable candidate is never evidence of improvement. A measured
      // candidate may replace an unmeasurable baseline, otherwise best score wins.
      // A guided OCSF class is judged on the stage that sets class_uid: mapping.
      const verdict = guidedAcceptance({
        candidateScore,
        baselineScore: baselineForStage,
        guided: stage === 'mapping' ? guided : null,
        candidateFunctions: spliced,
        baselineFunctions: current,
      });
      const keepNew = verdict.keep;
      const stageDescs = candidateStage
        .map((fn: any) => fn?.description || fn?.id)
        .filter(Boolean)
        .slice(0, 4) as string[];

      if (keepNew) {
        // `scoredCandidate` only carries a temporary fresh compact so the preview
        // reflects the destination shape. Never persist that optimization code as
        // part of a mapping replacement; `spliced` retains the real optimization
        // stage at the end of the pipeline.
        current = spliced;
      }
      result = {
        stage,
        score: candidateScore,
        kept: keepNew ? 'new' : 'baseline',
        summary: keepNew
          ? `Replaced ${stage} (${candidateStage.length} function${candidateStage.length === 1 ? '' : 's'}${stageDescs.length ? `: ${stageDescs.join('; ')}` : ''}).`
          : `Kept existing ${stage} — candidate score ${candidateScore ?? 'n/a'} did not beat ${baselineForStage ?? 'baseline'}.`,
        ...(verdict.note ? { guidanceNote: verdict.note } : {}),
      };
      if (verdict.note) args.log(verdict.note);
      const threshold = args.thresholds[stage];
      args.log(`${stage}: ${result.kept} (${candidateScore === null ? 'not scored' : `${candidateScore}/${threshold}`})`);
      args.onStatus?.(
        keepNew
          ? `${stage}: kept the new candidate (${candidateScore ?? 'n/a'}/100).`
          : `${stage}: kept the baseline (${baselineForStage ?? 'n/a'}/100 beat candidate ${candidateScore ?? 'n/a'}).`,
      );
    } catch (error) {
      args.log(`${stage}: kept baseline after improve failed: ${error instanceof Error ? error.message : String(error)}`);
      args.onStatus?.(`${stage}: improve failed — keeping baseline.`);
      result = {
        stage,
        score: null,
        kept: 'baseline',
        summary: `Kept existing ${stage} — improve failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    stageResultsArr.push(result);
    args.onStage?.(result);
  }

  args.onStatus?.('Optimization stages finished.');
  return { finalFunctions: current, stageResults: stageResultsArr };
}
