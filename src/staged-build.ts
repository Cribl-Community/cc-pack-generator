/**
 * The 3-stage (extraction → mapping → optimization) pipeline builder, extracted
 * from App.tsx so it can run outside the browser (a Cribl Backend Function has
 * no React tree). Pure — no closures over component state; every dependency is
 * an explicit parameter. `logScore` is required rather than defaulted so every
 * call site is forced to say what it wants for completion logging, instead of
 * a silent default quietly changing behavior at a call site nobody re-checked.
 *
 * `noAi` (build 712) disables every AI-fallback branch (the Cribl schematizer
 * agent call, AI parse, AI mapping, and their second-model retries) so a
 * caller that must stay inside a short, bounded execution window — a Backend
 * Function invocation — can request a build that only ever takes the golden/
 * static/Search-datatype paths. Pair it with `hasGoldenFormatPath` +
 * `goldenPathMatchesSample` (pack-builder.ts) as an eligibility pre-check;
 * this flag does not predict eligibility, it just refuses to ever call AI.
 *
 * The build also sets it by itself when the sample may not reach the AI
 * provider (`aiSampleRefusal`: customer events, not sanitised, and Settings →
 * "Require sanitised samples" on). Every AI branch here sends sample text — the
 * schematizer and AI mapping included — so the privacy gate has to be this one
 * switch, not a check at each call.
 */
import type { AiParseFunctions } from './api';
import {
  aiMapping, aiParse, deploy, fetchReferenceLookups, getGoldenPart, goldenHashOf, goldenPartStoreKey, healLookup,
  logPipelineScore, observeGolden, patchPipeline, previewPipeline, publishGoldenPart, saveGoldenPart,
  schematizerMapping,
} from './api';
import { goldenServingDecision, storedTrustState } from './golden-trust';
import { buildGoldenEvidence } from './golden-evidence';
import { describeSampleProvenance } from './sample-provenance';
import { isStageAbortError, stageAbortError } from './ai-budget';
import { TraceRecorder, type BuildTrace } from './build-trace';
import { functionComposition, functionCompositionTelemetry } from './function-composition';
import { auditCefFormat } from './cef-format';
import { auditRawFidelity, rawFidelityIssues } from './raw-fidelity';
import { scoreOcsfAgainstSchema, groundOcsfPipeline, OCSF_SCHEMA_VERSION } from './ocsf-schema';
import { buildOcsfOutputShaping, pruneOcsfDeadFields } from './ocsf-finalize';
import { dropFabricatedZeroDefaults } from './zero-defaults';
import { acceptAugmented, gateField, gateFunctions, groupByShape, jsonExtraction, lagReason, laggingEvents, perEventCoverage } from './event-coverage';
import { assessSampleUsable, sampleSubtypeMismatch } from './sample-gate';
import { resolveSentinelTable } from './sentinel-knowledge';
import { loadQualitySettings } from './ai-client';
import { KNOWN_PARSER_SOURCETYPES } from './pack-orchestrator';
import { aiSampleRefusal, aiSampleSnippet, UnsanitisedSampleError } from './sample-sanitise';
import { goldenWireFormatForSample } from './golden-variant';
import {
  buildAiMappingFunctions, buildGoldenFormatMapping, buildPackReadme, buildXsiamTagging,
  capMappingScore, concretizeAsimFormat, concretizeCimFormat, concretizeOcsfFormat,
  dedupeAliasedSerializeFields, extractionCarriedSourceData, fingerprintsMatch,
  getCompactOutputFunctions, getDatatypeParserFunctions, getMappingFunctions,
  getParserFieldNames, getParserForSourcetype,
  getSampleName, goldenPathMatchesSample, hasGoldenFormatPath, isCefFormat, isCimFormat, isOcsfFormat,
  isNextGenRawFidelityFormat, isOcsfScoredFormat, isWindowsCodeFamily, nextGenRawRestoreFunction, nextGenRawSnapshotFunction, ocsfStructuralAudit, preferNativeVocabularyValues, preserveNativeVocabularyValues,
  canonicalizeSourcetype, recognizeSourcetype, resolveOutputSourcetype, sampleFingerprint, sourceNativeSplunkSource, sampleMatchesSourceExpectation, sanitizeCriblFunctions, withJsonEmptyFieldFilter,
  scoreGoldenSpecCoverage, scoreSchemaMappingFromExtraction, scoreSentinelTableCoverage,
  scoreValueCoverage, scoreXsiamOptimizationStage, scoreXsiamPayloadStage, scoreOcsfMappingCarry,
  validateOutputAgainstSpec, withSchematizerCanonicalAliases, withWindowsOcsfDispatch,
} from './pack-builder';
import {
  assemblePipelineFunctions, averageStageScores, canScoreOptimization, shouldAcceptCombinedCandidate,
  validateExtractionStage, validateMappingInputs, withoutOutputCompaction,
} from './pipeline-stages';
import { buildXsiamBreakerYml, resolveXsiamForBuild, XsiamBuildError } from './xsiam-builder';
import { buildSourceOptimizationFunctions, withSourceOptimizationOff } from './source-optimization';
import { buildDestinationMetadataFunctions } from './destination-metadata';
import { elasticIntegrationStamp } from './elastic-integration';
import { secopsLogTypeStamp } from './secops-log-types';


export type ExpStageId = 'extraction' | 'mapping' | 'optimization';
export interface ExpStageResult {
  stage: ExpStageId;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  score: number | null;          // null = N/A (e.g. mapping for JSON) or not yet run
  band: 'good' | 'warn' | 'fail' | 'na';
  source: 'search' | 'golden' | 'copilot' | 'ai' | 'static' | 'none';  // where this stage's functions came from
  reasons: string[];             // why the score is what it is
  message?: string;
  // Debug detail shown on the card so a low score is easy to diagnose:
  debug?: {
    sampleRaw?: string;                       // one raw input event (extraction)
    extractedFields?: Record<string, any>;    // fields the stage produced (first event)
    mappings?: { from: string; to: string; expr: string }[];  // the full field mapping
    outputEvent?: Record<string, any>;        // first output event of this stage
    schemaFieldCount?: number;                // how many fields the dest schema defines
    unmappedFields?: string[];                // extracted fields with no schema home
    appliedOptimizations?: { label: string; description: string; reduction?: number }[];  // optimization stage: which reductions were applied
    stats?: ExpStageStats;                    // per-stage timing + byte sizes (for the Event Journey stats panel)
  };
}

// Per-stage measured statistics surfaced in the Event Journey "Pipeline
// statistics" panel. Sizes are computed over the previewed sample events (up to
// 8), durationMs is the wall-clock time this stage's build+preview+score took.
export interface ExpStageStats {
  durationMs?: number;   // wall-clock time spent producing this stage
  events?: number;       // number of previewed events measured
  bytesIn?: number;      // total input bytes into the pipeline (raw sample) — set on the extraction stage
  bytesOut?: number;     // total serialized output bytes of this stage's events
  rawBytesIn?: number;   // total _raw bytes of the input sample — set on the extraction stage
  rawBytesOut?: number;  // total _raw bytes in this stage's output events
}

/**
 * Every Cribl/AI operation the staged builder performs, as one injectable bag.
 *
 * Production callers omit it and get the real `./api` functions — the defaults ARE
 * the imports, so there is no second code path to keep in sync. It exists because
 * the stage machine is pure orchestration: the only way to prove a resumed stage
 * makes no second AI call, or that a stop boundary returns before the next stage
 * deploys anything, is to run the REAL candidate loops against deterministic
 * fakes. `logScore` was already injected for the same reason (see the option).
 */
export interface StagedBuildOps {
  deploy: typeof deploy;
  patchPipeline: typeof patchPipeline;
  previewPipeline: typeof previewPipeline;
  fetchReferenceLookups: typeof fetchReferenceLookups;
  healLookup: typeof healLookup;
  getGoldenPart: typeof getGoldenPart;
  saveGoldenPart: typeof saveGoldenPart;
  publishGoldenPart: typeof publishGoldenPart;
  /** A reused golden's verdict, written back to the record (golden-trust R3). */
  observeGolden: typeof observeGolden;
  aiParse: typeof aiParse;
  aiMapping: typeof aiMapping;
  schematizerMapping: typeof schematizerMapping;
}

const REAL_STAGED_BUILD_OPS: StagedBuildOps = {
  deploy, patchPipeline, previewPipeline, fetchReferenceLookups, healLookup,
  getGoldenPart, saveGoldenPart, publishGoldenPart, observeGolden, aiParse, aiMapping, schematizerMapping,
};

/**
 * Golden sub-parts are filed under the CANONICAL sourcetype, so a typed name
 * (`checkpoint_firewall_cef`) and its canonical form (`checkpoint_firewall`)
 * share ONE golden instead of splitting the corpus into two keys that each learn
 * separately. The wire variant (`@cef`) still keeps formats apart. Lookups try
 * the canonical key first, then the raw name, so a part written under a raw name
 * before this still replays; saves and publishes use the canonical key only.
 */
export function goldenSourcetypeKeys(sourcetype: string): string[] {
  const canonical = canonicalizeSourcetype(sourcetype);
  return canonical && canonical !== sourcetype ? [canonical, sourcetype] : [sourcetype];
}

async function getGoldenPartForSourcetype(
  get: StagedBuildOps['getGoldenPart'], stage: Parameters<typeof getGoldenPart>[0],
  sourcetype: string, destFormat: string, wire: ReturnType<typeof goldenWireFormatForSample>,
): ReturnType<typeof getGoldenPart> {
  return (await findGoldenPartForSourcetype(get, stage, sourcetype, destFormat, wire))?.rec ?? null;
}

/** As above, plus the store key the part was read from — what a verdict is written back to. */
async function findGoldenPartForSourcetype(
  get: StagedBuildOps['getGoldenPart'], stage: Parameters<typeof getGoldenPart>[0],
  sourcetype: string, destFormat: string, wire: ReturnType<typeof goldenWireFormatForSample>,
): Promise<{ rec: NonNullable<Awaited<ReturnType<typeof getGoldenPart>>>; key: string } | null> {
  for (const st of goldenSourcetypeKeys(sourcetype)) {
    const rec = await get(stage, st, destFormat, wire);
    // The key the store ACTUALLY resolved (a variant lookup falls back to the
    // plain key; a mapping part to its format family). Recomputing it here sent
    // most verdicts to a key that does not exist.
    if (rec) return { rec, key: rec.storeKey || goldenPartStoreKey(stage, st, destFormat, wire) };
  }
  return null;
}

// ---- OCSF "keep original _raw" helpers (see finishBuild) ----
// No leading underscores: cleanup evals commonly remove `__*` temporaries.
/**
 * The route.yml a new staged pack starts with. Its one route takes every event
 * the master route sends in (`true`) unless the caller gave a filter: the demo
 * passes each pipeline's lane filter, so the FIRST pipeline must honour it too —
 * with `true` it also processed every other lane's events.
 */
export function stagedPackRouteYml(pipelineId: string, routeFilter?: string): string {
  return `id: default\nroutes:\n  - id: default\n    name: default\n    filter: ${JSON.stringify(routeFilter || 'true')}\n    pipeline: ${pipelineId}\n    output: default\n    final: true`;
}

export const ORIGINAL_RAW_COPY = 'pg_original_raw_copy';
/** Adds the raw-copy field to every remove:['*'] keep-list so it survives cleanup. */
export function keepOriginalRawCopy(fns: any[]): any[] {
  return fns.map(f => Array.isArray(f?.conf?.keep) && !f.conf.keep.includes(ORIGINAL_RAW_COPY)
    ? { ...f, conf: { ...f.conf, keep: [...f.conf.keep, ORIGINAL_RAW_COPY] } }
    : f);
}
/** Copies the untouched _raw aside, ahead of all extraction functions. */
export function withOriginalRawCopy(fns: any[]): any[] {
  return [
    { id: 'eval', filter: 'true', description: 'Keep original _raw (compliance copy)', conf: { add: [{ name: ORIGINAL_RAW_COPY, value: '_raw' }] } },
    ...keepOriginalRawCopy(fns),
  ];
}
/**
 * OCSF raw_data is a string_t. A copy that is not a string (an input that hands
 * the pipeline an object `_raw`) is serialized, never shipped as an object.
 */
export const RAW_DATA_AS_STRING_EXPR = (src: string) =>
  `${src} == null || typeof ${src} == 'string' ? ${src} : JSON.stringify(${src})`;
/** Final step: carry the original event in the OCSF raw_data attribute. */
export const ORIGINAL_RAW_TO_RAW_DATA = {
  id: 'eval', filter: 'true', description: 'Carry the original event as OCSF raw_data',
  conf: { add: [{ name: 'raw_data', value: RAW_DATA_AS_STRING_EXPR(ORIGINAL_RAW_COPY) }], remove: [ORIGINAL_RAW_COPY] },
};

export function resolveStagedBuildOps(overrides?: Partial<StagedBuildOps>): StagedBuildOps {
  return overrides ? { ...REAL_STAGED_BUILD_OPS, ...overrides } : REAL_STAGED_BUILD_OPS;
}

export function extractParsedFieldNames(parseFns: AiParseFunctions | null): string[] {
  const names: string[] = [];
  if (!parseFns?.functions) return names;
  for (const fn of parseFns.functions) {
    if (fn.id === 'regex_extract' && fn.conf.regex) {
      for (const m of String(fn.conf.regex).matchAll(/\?<(\w+)>/g)) names.push(m[1]);
    }
    if (fn.id === 'code' && fn.conf.code) {
      for (const m of String(fn.conf.code).matchAll(/__e\['(\w+)'\]\s*=/g)) names.push(m[1]);
    }
  }
  return [...new Set(names)];
}

export async function resolveParseFunctions(opts: {
  sourcetype: string;
  sampleEvents: string;
  log?: (detail: string) => void;
  model?: string;        // optional AI model override (second-model retry)
  /* Where the events came from, for the un-sanitised-data guard. Defaults to the
     non-customer case: the demo and a store-fed batch row resolve their samples from
     bundled reference data or AI generation, which never carried a privacy question.
     The wizard passes its real source mode; a batch row with its own `sample` cell
     passes 'paste' (src/batch-row-sample.ts). */
  sourceMode?: string;
  sanitised?: boolean;
  /* Ask the AI even for a built-in sourcetype and skip the auto-promote replay:
     the per-event gap pass sends only the events the chosen parser missed. */
  forceAi?: boolean;
  /* Injectable Cribl/AI operations — see StagedBuildOps. Omitted in production. */
  ops?: Partial<StagedBuildOps>;
}): Promise<{ aiParseFns: AiParseFunctions | null; parsedFieldNames: string[] }> {
  const { sourcetype, sampleEvents, log, model } = opts;
  const { aiParse, getGoldenPart } = resolveStagedBuildOps(opts.ops);
  const isKnown = !opts.forceAi && KNOWN_PARSER_SOURCETYPES.includes(sourcetype);

  // Auto-promote replay: a custom source that once passed is now built-in
  // quality — replay its verified parser, but only when THIS sample's structure
  // matches the fingerprint the recipe was proven against.
  if (!isKnown && !opts.forceAi && sampleEvents) {
    try {
      const rec = await getGoldenPartForSourcetype(getGoldenPart, 'extraction', sourcetype, '', goldenWireFormatForSample(sampleEvents));
      if (rec?.functions?.length && fingerprintsMatch(rec.recipe?.fingerprint, sampleFingerprint(sampleEvents))) {
        const replayed = { functions: rec.functions } as AiParseFunctions;
        const names = extractParsedFieldNames(replayed);
        log?.(`Step 1 — replaying verified ${sourcetype} parser (auto-promoted, no AI) — extracts: ${names.slice(0, 8).join(', ')}…`);
        return { aiParseFns: replayed, parsedFieldNames: names };
      }
    } catch { /* store unavailable — fall through to AI */ }
  }

  if (!isKnown) {
    if (!sampleEvents) { log?.('Step 1 — no sample available, skipping AI parse (extraction will fall back per format).'); return { aiParseFns: null, parsedFieldNames: [] }; }
    // Only the AI parse sends the sample anywhere — a replayed or built-in
    // parser never does, so the privacy guard is asked here and nowhere above.
    let sampleSnippet: string;
    try {
      sampleSnippet = aiSampleSnippet({
        sampleEvents, sourceMode: opts.sourceMode || '', sanitised: opts.sanitised,
        required: loadQualitySettings().requireSanitisedSamples,
      });
    } catch (err) {
      if (!(err instanceof UnsanitisedSampleError)) throw err;
      log?.(`Step 1 — AI parse skipped for ${sourcetype}: the sample is not sanitised and Samples → Sharing → "Require sanitised samples before any AI call" is on; extraction will use the non-AI paths.`);
      return { aiParseFns: null, parsedFieldNames: [] };
    }
    try {
      let reason = '';
      const parseFns = await aiParse(sourcetype, sampleSnippet, (step, detail) => {
        if (step === 'error' && detail) reason = detail;
      }, model);
      if (parseFns?.functions?.length) {
        const names = extractParsedFieldNames(parseFns);
        log?.(`Step 1 — ${parseFns.functions.length} parse function(s) generated${model ? ` (model: ${model})` : ''} — extracts: ${names.slice(0, 8).join(', ')}…`);
        return { aiParseFns: parseFns, parsedFieldNames: names };
      }
      // Empty (non-throw) result — the AI returned no functions. Make this
      // VISIBLE: a silent null here means the prepared-parser reuse can't engage
      // and every format re-runs the AI parse from scratch (slow + non-deterministic).
      log?.(`⚠ Step 1 — AI parse returned no functions for ${sourcetype}${model ? ` (model: ${model})` : ''}${reason ? `: ${reason}` : ''}; extraction will be re-derived per format.`);
    } catch (err) {
      log?.(`⚠ Step 1 — AI parse FAILED for ${sourcetype}${model ? ` (model: ${model})` : ''}: ${err instanceof Error ? err.message : String(err)}; extraction will be re-derived per format.`);
    }
    return { aiParseFns: null, parsedFieldNames: [] };
  }

  const names = getParserFieldNames(sourcetype);
  log?.(`Step 1 — built-in ${sourcetype} parser extracts: ${names.slice(0, 8).join(', ')}…`);
  return { aiParseFns: null, parsedFieldNames: names };
}

// Wrap an arbitrary function list into a Cribl pipeline conf (mirrors
// buildPipelineConfWithMappings' output shape).
export const expConf = (functions: any[]) => ({
  output: 'default', streamtags: [] as string[], groups: {}, asyncFuncTimeout: 1000,
  functions: (functions || []).map((f: any) => {
    const e: Record<string, unknown> = { id: f.id, filter: f.filter || 'true', disabled: f.disabled || false, conf: f.conf };
    if (f.description) e.description = f.description;
    if (f.final) e.final = true;
    return e;
  }),
  description: 'Experimental staged pipeline',
});

export const hydrateRawForScoring = (events: any[]): any[] => {
    if (!Array.isArray(events) || events.length === 0) return events;
    return events.map(e => {
      if (!e || typeof e._raw !== 'string' || !e._raw.startsWith('{')) return e;
      let parsed: any;
      try { parsed = JSON.parse(e._raw); } catch { return e; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return e;
      return { ...parsed, ...e };
    });
  };

/**
 * The OCSF columns of a build's completion event: the class the mapped output
 * emits (the most frequent `class_uid`), the class this source should be, the
 * output's real-schema score, and the structural cap that bound the mapping
 * score (null when none did). Empty for any other destination.
 */
export function ocsfMappingTelemetry(destFormat: string, sourcetype: string, rawEvents: string[], mappingOut: any[] | undefined): {
  ocsf_class_uid?: number | null; ocsf_expected_class_uid?: number | null; ocsf_schema_score?: number | null; ocsf_cap?: number | null;
} {
  if (!isOcsfScoredFormat(destFormat)) return {};
  const events = hydrateRawForScoring(mappingOut || []);
  const counts = new Map<number, number>();
  for (const e of events) {
    const n = e && e.class_uid != null && String(e.class_uid).trim() !== '' ? Number(e.class_uid) : NaN;
    if (Number.isFinite(n)) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const emitted = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const oracle = scoreOcsfAgainstSchema(events, destFormat);
  const structural = ocsfStructuralAudit(destFormat, sourcetype, rawEvents.join('\n'), events);
  return {
    ocsf_class_uid: emitted,
    ocsf_expected_class_uid: structural.classAudit?.expectedUid ?? null,
    ocsf_schema_score: oracle.supported ? oracle.score : null,
    ocsf_cap: structural.cap != null && oracle.supported && oracle.score > structural.cap ? structural.cap : null,
  };
}

export const scoreStage = (
    stage: ExpStageId,
    destFormat: string,
    sourcetype: string,
    rawEvents: string[],
    outputEventsRaw: any[],
    prevOutputRaw: any[],   // output BEFORE this stage's functions (for optimization delta)
    keptContract?: string[],   // (optimization only) the field names the stage is CONTRACTED to keep; loss is only counted among these
  ): { score: number | null; band: ExpStageResult['band']; reasons: string[] } => {
    const isSchema = !['json', 'manual', 'raw', 'raw_fields', 'passthrough', ''].includes(destFormat);
    const isXsiam = destFormat === 'xsiam';
    const isPassthrough = destFormat === 'passthrough';
    const isNextGen = isNextGenRawFidelityFormat(destFormat);
    // Hydrate _raw JSON → top-level so shape (fields-in-_raw) doesn't zero the
    // mapping/optimization score. NOT for extraction (it uses ignoreRaw:true to
    // avoid crediting values still sitting in an untransformed _raw — hydrating
    // would make a failed serde look like a perfect extract) and NOT for XSIAM
    // (its contract explicitly validates the _raw passthrough shape).
    const hydrate = stage !== 'extraction' && !isXsiam;
    const outputEvents = hydrate ? hydrateRawForScoring(outputEventsRaw) : outputEventsRaw;
    const prevOutput = hydrate ? hydrateRawForScoring(prevOutputRaw) : prevOutputRaw;
    if (stage === 'extraction') {
      // Passthrough: the pipeline intentionally transforms nothing — every input
      // event reaches the output verbatim (_raw preserved). There is no
      // extraction AND no mapping to measure, so BOTH stages (and therefore the
      // overall) report N/A, never a number. Scoring it 100 was a fake perfect
      // score: it minted a 100 for doing nothing, inflated the deployment_score
      // average, and read as validated transformation work — exactly the
      // "distrust bare 100s / not-measurable ≠ a pass" trap closed everywhere
      // else. N/A is the honest report (mapping already returns n/a below).
      if (isPassthrough) return { score: null, band: 'na', reasons: ['Passthrough — events forwarded unchanged (_raw preserved); nothing to extract or map, so there is nothing to score.'] };
      if (isXsiam) return scoreXsiamPayloadStage(rawEvents, sourcetype);
      // Extraction ONLY: did sample values land in named fields? Mapping/keep is
      // irrelevant here (ignoreRaw so untransformed _raw cannot fake a pass).
      const r = scoreValueCoverage(rawEvents, outputEvents, true);
      if (!r.supported) {
        return { score: null, band: 'na', reasons: [
          outputEvents.length === 0
            ? 'Extraction not scorable: the pipeline returned no preview events.'
            : 'Extraction not scorable: no measurable values in the sample to check against.',
        ] };
      }
      const reason = r.score >= 85
        ? `Extraction pulled ${r.coveredValues}/${r.totalValues} sample values into named fields — mapping is not part of this score.`
        : r.lostValues?.length
          ? `Extraction missed ${r.totalValues - r.coveredValues}/${r.totalValues} sample values (e.g. ${r.lostValues.slice(0, 6).join(', ')}${r.lostValues.length > 6 ? '…' : ''}) — mapping cannot invent those.`
          : `Extraction covered ${r.coveredValues}/${r.totalValues} sample values into named fields.`;
      return { score: r.score, band: r.score >= 85 ? 'good' : r.score >= 60 ? 'warn' : 'fail', reasons: [reason] };
    }
    if (stage === 'optimization' && isPassthrough) {
      return { score: null, band: 'na', reasons: ['Passthrough — no optimization; events are forwarded unchanged.'] };
    }
    if (stage === 'optimization' && isXsiam) {
      return scoreXsiamOptimizationStage(prevOutput, outputEvents, sourcetype);
    }
    // NG SIEM: nothing is mapped (the connector's vendor parser reads the line), and
    // the optimization stage ends with the restore, so that is where the delivery is
    // graded — unhydrated, since the contract is `_raw` itself.
    if (stage === 'mapping' && isNextGen) {
      return { score: null, band: 'na', reasons: ['NG SIEM: nothing is mapped — the connector’s vendor parser reads the original _raw.'] };
    }
    if (stage === 'optimization' && isNextGen) {
      const f = auditRawFidelity(rawEvents, outputEventsRaw);
      if (!f.applicable || f.cap == null) {
        return { score: null, band: 'na', reasons: ['Raw fidelity not scorable: the pipeline returned no preview events.'] };
      }
      const issues = rawFidelityIssues(f);
      return {
        score: f.cap, band: f.cap >= 85 ? 'good' : f.cap >= 60 ? 'warn' : 'fail',
        reasons: [`Raw fidelity: ${f.faithful}/${f.events} events carry the original line in _raw and nothing else.`, ...issues],
      };
    }
    if (stage === 'mapping') {
      if (!isSchema) {
        return { score: null, band: 'na', reasons: [`Destination "${destFormat || 'JSON'}" needs no schema mapping — events pass through as-is.`] };
      }
      // Mapping is judged ONLY on what EXTRACTION delivered. Sample values that
      // never became named fields are extraction's problem, not mapping's.
      const extractedKeys = Array.from(new Set(
        prevOutput.flatMap(e => Object.keys(e || {}).filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_'))),
      ));
      if (extractedKeys.length === 0) {
        return {
          score: null,
          band: 'na',
          reasons: ['Mapping cannot be scored: extraction delivered no named fields. Mapping cannot invent missing fields — fix extraction first.'],
        };
      }
      if (isXsiam) {
        const contract = validateOutputAgainstSpec('xsiam', outputEvents, extractedKeys, sourcetype);
        const score = contract.outputFormatOk ? contract.score : 0;
        const reasons = contract.outputFormatOk
          ? [`Mapping satisfied ${contract.populatedFields}/${contract.checkedFields} XSIAM contract checks from the ${extractedKeys.length} extracted fields.`]
          : (contract.findings || []).filter((f: any) => f.severity === 'high').map((f: any) => f.issue);
        return { score, band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail', reasons: reasons.length ? reasons.slice(0, 1) : ['XSIAM mapping failed the routing/payload contract.'] };
      }
      // OCSF: grade against the REAL OCSF schema, keyed on the class the pipeline
      // ACTUALLY produced (its class_uid) — not our concretized guess. This is the
      // honest lens (project_ocsf_library_plan P1) and removes the old penalty
      // where the Copilot schematizer built one OCSF class and we scored it
      // against a different golden spec. Falls through to the golden lens only
      // when the output carries nothing identifiable as OCSF.
      if (isOcsfScoredFormat(destFormat)) {
        const oracle = scoreOcsfAgainstSchema(outputEvents, destFormat);
        if (oracle.supported) {
          const cls = oracle.detectedClass ? `${oracle.detectedClass} (${oracle.classUid})` : destFormat.toUpperCase();
          const c = oracle.checks;
          const typeStr = c.typeChecked ? `, ${c.typeValid}/${c.typeChecked} valid types` : '';
          const unknownStr = oracle.unknownAttrs.length ? `, ${oracle.unknownAttrs.length} non-schema attr(s)` : '';
          const reason = `OCSF ${OCSF_SCHEMA_VERSION} · ${cls}: ${c.requiredPresent}/${c.requiredTotal} required attrs, ${c.enumValid}/${c.enumChecked} valid enums${typeStr}, ${c.recommendedPresent}/${c.recommendedTotal} recommended${unknownStr}. ${oracle.reasons[0] || ''}`.trim();
          // The oracle grades the class the output CLAIMS. It cannot see that a
          // firewall mapped to Email is the wrong class, and a flat event scored
          // against a hinted class still earns partial credit, so the same two
          // structural caps `scoreAuthoritative` applies bound it here. A cap
          // only lowers, and is named first on the card.
          const structural = ocsfStructuralAudit(destFormat, sourcetype, rawEvents.join('\n'), outputEvents);
          // Shape alone is half the story: a schema-perfect event that dropped
          // most extracted values is a bad mapping. Blend the oracle 50/50 with
          // value carry (typed attr = 1, `unmapped` only = 0.25, lost = 0).
          const carry = scoreOcsfMappingCarry(rawEvents, prevOutput, outputEvents, destFormat);
          const blended = carry.supported ? Math.round(0.5 * oracle.score + 0.5 * carry.score) : oracle.score;
          const carryStr = carry.supported
            ? ` Carry ${carry.score}: ${carry.typedValues}/${carry.totalValues} extracted values in typed OCSF attributes, ${carry.unmappedValues} only in unmapped${carry.lostValues.length ? ` (lost e.g. ${carry.lostValues.slice(0, 4).join(', ')})` : ''}.`
            : '';
          const score = structural.cap != null && blended > structural.cap ? structural.cap : blended;
          const reasons = score < blended ? [`${structural.reason} Schema score ${oracle.score}: ${reason}${carryStr}`] : [`${reason}${carryStr}`];
          return { score, band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail', reasons };
        }
      }
      // CEF wire-format check: unlike OCSF (a schema oracle that REPLACES the
      // score), CEF validity is orthogonal to value coverage, so it only GATES —
      // a malformed CEF (bad header/severity/escaping) visibly fails the mapping
      // stage with the specific reason; a well-formed CEF falls through to the
      // coverage lens below. Non-standard extension keys are advisory only.
      if (isCefFormat(destFormat)) {
        const cef = auditCefFormat(outputEvents);
        if (cef.applicable && cef.validEvents < cef.totalEvents) {
          const keyStr = cef.unknownKeys.length ? ` ${cef.unknownKeys.length} non-standard key(s).` : '';
          return { score: cef.score, band: cef.band, reasons: [`${cef.reasons[0] || 'CEF wire format invalid.'}${keyStr}`] };
        }
      }
      // Nested OCSF-style specs: filled/fillable dest ratio from extracted keys.
      const golden = scoreGoldenSpecCoverage(destFormat, outputEvents, sourcetype, rawEvents.join('\n'), extractedKeys);
      if (golden.supported) {
        const reason = golden.missing?.length
          ? `Mapping filled ${golden.populated}/${golden.expected} ${destFormat.toUpperCase()} fields from extracted data; still empty: ${golden.missing.slice(0, 8).join(', ')}${golden.missing.length > 8 ? '…' : ''}.`
          : `Mapping filled ${golden.populated}/${golden.expected} ${destFormat.toUpperCase()} fields that extraction made available.`;
        return { score: golden.score, band: golden.score >= 85 ? 'good' : golden.score >= 60 ? 'warn' : 'fail', reasons: [reason] };
      }
      // Flat schemas (CIM/ECS): prefer the source-relative spec lens when the
      // extracted keys can fill enough dests (Copilot names like source__ip are
      // aliased in the golden exprs). Lists empty dests by field name.
      const v = validateOutputAgainstSpec(destFormat, outputEvents, extractedKeys, sourcetype, rawEvents.join('\n')) as any;
      if (v && v.supported) {
        const missing = (v.missingFields || []).slice(0, 8).join(', ');
        const reason = missing
          ? `Mapping filled ${v.populatedFields}/${v.checkedFields} ${destFormat.toUpperCase()} fields from extracted data; empty: ${missing}${(v.missingFields || []).length > 8 ? '…' : ''}.`
          : `Mapping filled ${v.populatedFields}/${v.checkedFields} ${destFormat.toUpperCase()} fields that extraction made available.`;
        return { score: v.score, band: v.score >= 85 ? 'good' : v.score >= 60 ? 'warn' : 'fail', reasons: [reason] };
      }
      // Fallback: extracted VALUES into the DESTINATION schema fields only.
      // Full-event coverage would credit vendor leftovers still sitting next to
      // empty `src`/`dest` before the keep-list runs.
      const schemaMap = scoreSchemaMappingFromExtraction(destFormat, prevOutput, outputEvents, sourcetype, rawEvents.join('\n'));
      if (schemaMap.supported) {
        const filled = schemaMap.populatedFields.slice(0, 8).join(', ');
        const empty = schemaMap.emptyFields.slice(0, 8).join(', ');
        const reason = schemaMap.score >= 85
          ? `Mapping carried ${schemaMap.coveredValues}/${schemaMap.totalValues} extracted values into ${destFormat.toUpperCase()} fields (${schemaMap.populatedFields.length} schema fields filled${filled ? `: ${filled}` : ''}).`
          : `Mapping carried ${schemaMap.coveredValues}/${schemaMap.totalValues} extracted values into ${destFormat.toUpperCase()} fields (${schemaMap.populatedFields.length} filled${filled ? `: ${filled}` : ''}${empty ? `; empty: ${empty}${schemaMap.emptyFields.length > 8 ? '…' : ''}` : ''}).`;
        return { score: schemaMap.score, band: schemaMap.score >= 85 ? 'good' : schemaMap.score >= 60 ? 'warn' : 'fail', reasons: [reason] };
      }
      // Sentinel: score values present AFTER extraction into table columns — never
      // the raw sample (that would punish mapping for extraction gaps).
      const extractedLines = prevOutput.map((e: any) => {
        const parts: string[] = [];
        for (const [k, val] of Object.entries(e || {})) {
          if (k === '_raw' || k.startsWith('__') || k.startsWith('cribl_')) continue;
          if (val == null || val === '') continue;
          parts.push(String(val));
        }
        return parts.join(' ');
      }).filter(Boolean);
      if (!extractedLines.length) {
        return {
          score: null,
          band: 'na',
          reasons: ['Mapping cannot be scored: extraction produced field names but no measurable values to carry into the destination.'],
        };
      }
      const sent = scoreSentinelTableCoverage(destFormat, outputEvents, extractedLines);
      if (sent?.supported) {
        const reason = `Mapping carried ${sent.coveredValues}/${sent.totalValues} extracted values into ${sent.table} columns.`;
        return { score: sent.score, band: sent.score >= 85 ? 'good' : sent.score >= 60 ? 'warn' : 'fail', reasons: [reason] };
      }
      return { score: null, band: 'na', reasons: [`Mapping not scorable for ${destFormat} with this extraction output.`] };
    }
    // optimization: reduction achieved WITHOUT losing kept fields
    const fieldCount = (evs: any[]) => { const s = new Set<string>(); evs.forEach(e => Object.keys(e || {}).forEach(k => { if (k !== '_raw') s.add(k); })); return s; };
    const before = fieldCount(prevOutput), after = fieldCount(outputEvents);
    // If the prior stages produced no real output (no named fields AND no
    // events), there is nothing to optimize — a "no fields lost" result here is
    // vacuous, not a success. Don't award the 80 baseline for an empty pipeline;
    // that masked broken extraction/mapping as a passing optimization stage.
    if (before.size === 0 && after.size === 0) {
      return { score: 0, band: 'fail', reasons: ['No mapped/extracted fields to optimize — upstream extraction and mapping produced nothing.'] };
    }
    // A field is "lost" only if it was part of the stage's KEEP contract (the
    // mapped model) yet vanished. Compaction is DESIGNED to drop the verbose
    // vendor-raw intermediates (Corelight _path/uid/id.orig_h…, Zscaler raw
    // fields) that the mapping read but that never belong in the output — those
    // must NOT count as loss (they made optimization score 0 despite a correct
    // pipeline). When no explicit contract is supplied, fall back to the old
    // "any field present-before-gone-after" rule.
    const contract = keptContract && keptContract.length ? new Set(keptContract) : null;
    const lost = [...before].filter(k => !after.has(k) && (!contract || contract.has(k)));
    // Reduction % measures the PHYSICAL payload change, so use the un-hydrated
    // events (hydration re-inflates fields-in-_raw back to the top level, which
    // would understate CIM's real reduction and mask the bonus entirely).
    const beforeSize = JSON.stringify(prevOutputRaw).length || 1;
    const afterSize = JSON.stringify(outputEventsRaw).length;
    const reductionPct = Math.max(0, Math.round((1 - afterSize / beforeSize) * 100));
    // A good optimization reduces volume without dropping mapped/kept fields.
    // Dropping a contracted field is a hard defect and dominates the score.
    // One-line reason for the score card (reasons[0]).
    if (lost.length > 0) {
      const score = Math.max(0, 70 - lost.length * 10);
      return {
        score,
        band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail',
        reasons: [`Optimization dropped ${lost.length} mapped field(s) (${lost.slice(0, 6).join(', ')}${lost.length > 6 ? '…' : ''}) while reducing payload ~${reductionPct}%.`],
      };
    }
    // Nothing in the keep-contract was lost. Measure whether SOURCE data still
    // reaches the destination (value coverage), plus a small bounded bonus for
    // genuine byte reduction. Not measurable → 'na', never a fabricated pass.
    const vc = scoreValueCoverage(rawEvents, outputEvents, false);
    if (!vc.supported) {
      return {
        score: null,
        band: 'na',
        reasons: [`Optimization kept mapped fields and reduced payload ~${reductionPct}%, but no measurable sample values were available to verify the output.`],
      };
    }
    const bonus = Math.min(10, Math.round(reductionPct / 5));
    const score = Math.min(100, vc.score + bonus);
    const lostHint = vc.lostValues?.length
      ? ` Missing from output: ${vc.lostValues.slice(0, 6).join(', ')}${vc.lostValues.length > 6 ? '…' : ''}.`
      : '';
    return {
      score,
      band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail',
      reasons: [`Optimization kept mapped fields; ${vc.coveredValues}/${vc.totalValues} source values still reach the destination after ~${reductionPct}% reduction${bonus ? ` (+${bonus} size bonus)` : ''}.${lostHint}`],
    };
  };

  // ---- Shared 3-stage builder -------------------------------------------------
  // Headless core of the 3-stage best-score-wins build, used by BOTH the
  // experiment UI (runStagedExperiment) and the Create/Clean demo-environment
  // flow. Creates the pack ONCE (deferDeploy) then PATCHes candidate pipelines
  // in for preview/scoring — no deploy-per-step. Does NOT commit+deploy; the
  // caller does that once at the end (so the demo can batch it with routes).
  // Returns the winning function list + per-stage results.
export interface StagedStageResult { stage: ExpStageId; source: ExpStageResult['source']; score: number | null; band: ExpStageResult['band']; reasons: string[]; out: any[]; decidesOverall?: boolean; detail?: { from: string; to: string; expr: string }[]; appliedOptimizations?: { label: string; description: string; reduction?: number }[]; stats?: ExpStageStats; }
  // Reusable extraction result — computed once per sourcetype, shared across a
  // pack's pipelines (Phase 2 of the sample/extraction de-duplication).
  // `extractionClass` keys the reuse: 'mapped' (schema dest, canonical field
  // names) vs 'raw' (json/raw, Search-native names) pick DIFFERENT parsers
  // (Rule 10), so a result is only reusable within the same class.
export interface PreparedExtraction { fns: any[]; out: any[]; score: number | null; band: ExpStageResult['band']; reasons: string[]; source: ExpStageResult['source']; extractionClass: 'mapped' | 'raw'; }

/**
 * The ONE definition of a destination's extraction class (Hard Rule 27). An
 * orchestrator caches a prepared extraction per class and hands it to sibling
 * formats, so a second spelling of this exclusion list in a driver would hand a
 * JSON pipeline a canonical-name parser the first time the list moved. Callers
 * pass the format they hold — bare or concretized, both resolve the same, since
 * concretizing only ever turns a schema family into another schema key.
 */
export function extractionClassOf(destFormat: string): 'mapped' | 'raw' {
  return ['json', 'manual', 'raw', 'raw_fields', 'passthrough', ''].includes(destFormat) ? 'raw' : 'mapped';
}

// Eligibility pre-check for a `noAi: true` build (build 713): true only when the
// WHOLE build is guaranteed to have a deterministic candidate at every stage, so
// there is never a need to fall back to AI. This is a PREDICTION check, distinct
// from `noAi` itself (which structurally refuses AI regardless) — pair them: use
// this to decide whether a row belongs in a no-AI run at all, and pass
// `noAi: true` to actually build it so a false-positive here still can't reach AI.
// - xsiam/passthrough add no parser/mapping at all — always eligible.
// - everything else needs BOTH a deterministic extraction candidate (golden/
//   static/Search datatype — `hasGoldenFormatPath`) AND that candidate's sample
//   fit to hold (`goldenPathMatchesSample`); mirrors the schema-family
//   concretization `buildStagedPipeline` itself does, so callers can check
//   eligibility against the same bare 'cim'/'asim'/'ocsf' the CSV/UI carries.
export function isBackgroundEligible(sourcetype: string, destFormatRaw: string, sampleEvents: string, cimModel?: string): boolean {
  let destFormat = destFormatRaw;
  if (destFormat === 'cim') destFormat = concretizeCimFormat('cim', sourcetype, sampleEvents, cimModel);
  else if (destFormat === 'asim') destFormat = concretizeAsimFormat('asim', sourcetype, sampleEvents);
  else if (destFormat === 'ocsf' || destFormat === 'nextgen') destFormat = concretizeOcsfFormat(destFormat, sourcetype, sampleEvents);
  if (destFormat === 'xsiam' || destFormat === 'passthrough') return true;
  return hasGoldenFormatPath(sourcetype, destFormat, sampleEvents) && goldenPathMatchesSample(sourcetype, destFormat, sampleEvents);
}

/** The historic complete-build result — what every regular caller receives. */
export interface StagedBuildResult {
  finalFns: any[];
  stages: StagedStageResult[];
  referenceLookups: any[];
  trace: BuildTrace;
  extractionForReuse?: PreparedExtraction | null;
}

/**
 * Stage boundary a caller may stop at. Mirrors the durable row state machine in
 * the Background Batch design: extraction → mapping → optimization → finalize.
 */
export type StagedStopAfter = 'extraction' | 'mapping' | 'optimization' | 'finalize';

/**
 * The checkpoint a stopped build hands back and a resumed build reads.
 *
 * Each entry is the FINISHED product of one stage — the functions that stage
 * contributed plus the scored output it was measured on. A stage present here is
 * never recomputed, which is what makes "one durable transition per invocation"
 * possible without a second copy of the candidate logic.
 */
export interface StagedBuildArtifact {
  extraction?: PreparedExtraction;
  mapping?: StagedStageResult & { fns: any[] };
  optimization?: StagedStageResult & { fns: any[] };
  /**
   * Epoch SECONDS of the FIRST invocation. Carried so the completion event's
   * start_time/build_ms describe the whole run rather than whichever invocation
   * happened to finalize it — a per-invocation clock would report a multi-minute
   * background build as a few seconds of work (Hard Rule 32).
   */
  startedAt?: number;
  /**
   * The extraction/mapping entries came from ONE delegated schematizer build
   * (parse+map+enrich in a single inseparable pipeline), so `extraction.fns` is
   * the whole pipeline and must never be offered to a sibling format as a
   * reusable parser (Hard Rule 27). Held here rather than in an invocation-local
   * flag: a resumed finalize has no memory of how the stages were produced, and
   * would otherwise hand the combined pipeline out as an extraction.
   */
  combinedBuild?: boolean;
  /**
   * Whether the pack/route for this build has already been CREATED. `mode:'new'`
   * creates the pack and `mode:'add-pipeline'` adds the pipeline+route; both are
   * properties of the RUN, not of one invocation. A resumed invocation that
   * started from a fresh flag would create the pack a second time, discarding
   * whatever the earlier invocations deployed into it.
   */
  packDeployed?: boolean;
  /**
   * Reference lookups, already self-healed against the sample. Resolved once per
   * run: the fetch is a network call and the heal is real work against the
   * sample, and neither can change between invocations of the same build.
   */
  referenceLookups?: any[];
  /** Serializable recorder state carried across durable stage invocations. */
  trace?: BuildTrace;
}

/** What a caller that passes `stopAfter`/`resume` receives. */
export interface StagedBuildProgress {
  complete: boolean;
  /** The phase the NEXT invocation should run. Absent once the build is complete. */
  nextPhase?: StagedStopAfter;
  artifact: StagedBuildArtifact;
  /** Only set on the invocation that finalized the build. */
  result?: StagedBuildResult;
}

/**
 * What makes a call a CONTINUATION call — and therefore what makes returning
 * `StagedBuildProgress` sound.
 *
 * The runtime rule is "`stopAfter` or `resume` is DEFINED", so the type has to
 * require a defined value too. Typing the progress overload as plain
 * `StagedBuildOptions` promised the wrapper to a caller whose options may hold
 * `undefined` for both at runtime — a driver selecting the phase dynamically
 * would then read `.complete` off the historic result, see `undefined`, and
 * treat a finished build as unfinished forever.
 *
 * A driver that cannot name a stop boundary passes the artifact it has instead;
 * `{}` is the valid "nothing done yet" checkpoint and still yields progress.
 */
export type StagedContinuation =
  | { stopAfter: StagedStopAfter; resume?: StagedBuildArtifact }
  | { resume: StagedBuildArtifact; stopAfter?: StagedStopAfter };

export interface StagedBuildOptions {
  sourcetype: string; destFormat: string; sampleEvents: string;
  group: string; packId: string; pipelineId: string; packageJson: any;
  reductionToggles: Record<string, boolean>;
  thresholds: { extraction: number; mapping: number; optimization: number };
  shareOn: boolean; satisfied?: number;
  // 'new' (default) creates the pack fresh (deferDeploy); 'add-pipeline' adds
  // this pipeline into an EXISTING pack (used by batch when several rows share
  // one pack) — the pack isn't recreated, we just PATCH the pipeline in.
  mode?: 'new' | 'add-pipeline';
  // Whether to (re)upload the sample when ADDING a pipeline to an existing pack.
  // The sample is keyed by sourcetype and shared across every destination, so
  // once the first format uploaded `<sourcetype>_sample.log` the sibling
  // formats reference it without re-uploading. Default true so batch (whose
  // rows can carry DIFFERENT sourcetypes into one pack) still uploads each
  // sourcetype's sample; the 3-stage multi-format loop sets it false for the
  // sibling formats of a single sourcetype. mode:'new' always uploads (pack
  // creation needs its sample) regardless of this flag.
  uploadSample?: boolean;
  routeFilter?: string;
  // ALL destination formats going into this pack — used to write a pack README
  // that documents every pipeline, not just the one this call builds. The
  // README is attached on the mode:'new' deploy (pack creation) only.
  allFormats?: string[];
  origin?: string;   // which UI flow: 'create' | 'demo' | 'batch' | 'experiment'
  // AI parse functions already generated ONCE by prepareSource for this source.
  // Threaded in so each format's extraction stage REUSES them (highest-priority
  // candidate) instead of re-running the AI parse per format — the prep call is
  // the single source of truth for a new/unknown source's parser. Without this
  // an unknown source (no golden/static/search parser) fell to a JSON-serde
  // fallback that scores 0 on non-JSON, then re-ran AI 1-2× per format: slow AND
  // frequently 0. Null/empty for known sources (they use static/golden parsers).
  preparedParseFns?: any[];
  // Fully-resolved extraction stage (functions + parsed events + score),
  // computed ONCE per sourcetype by the orchestrator and reused across this
  // pack's sibling pipelines. Extraction is destination-independent WITHIN an
  // extraction class (mapped-schema vs raw/json — see `isSchema`), so the
  // orchestrator caches per class and passes the matching one here. When set
  // (and not passthrough/XSIAM), this call SKIPS the candidate loop, AI retries
  // and golden save — it just re-deploys these functions onto its own pipeline
  // (so the pipeline has a parser) and reuses the parsed output for mapping.
  preparedExtraction?: PreparedExtraction | null;
  allowCode?: boolean;   // let the built-in parser use a Code function (off by default)
  cimModel?: string;     // selected Splunk CIM data model (grounds CIM mapping)
  // Source-native sourcetype to emit in the output (e.g. Splunk's `cisco:asa`)
  // while `sourcetype` above stays canonical (`cisco_asa`) for behavior/golden
  // lookups. Defaults to the canonical form when not supplied.
  outputSourcetype?: string;
  // The destination the pipeline FEEDS when `destFormat` is only how it is built
  // (Build pack flow: `splunk_raw` builds as passthrough, `splunk_json` as json).
  // Selects the destination-metadata contract (src/destination-metadata.ts); omit
  // it and `destFormat` decides (a `cim#*` pipeline is Splunk either way).
  destinationKey?: string;
  // Sample provenance from prepareSource, logged with the score so a low stage
  // score can be read against the sample tier it was built on.
  sampleTier?: string;
  sampleReason?: string;
  sampleSourceMode?: string;
  sampleSanitised?: boolean;
  prepareMs?: number;
  // Disables every AI-fallback branch (the Cribl schematizer agent call, AI
  // parse, AI mapping, and their second-model retries) — see module header.
  // Default false (unchanged behavior for every existing caller).
  noAi?: boolean;
  // ---- continuation (build 731) ---------------------------------------------
  // A checkpoint from an earlier invocation. Every stage present is treated as
  // FINISHED: it is restored (so the stage list and completion event still
  // describe the whole run) and never recomputed.
  resume?: StagedBuildArtifact;
  // Stop once this stage is done and hand the checkpoint back. A Backend Function
  // invocation is bounded (120s), so Background Batch performs ONE durable
  // transition per tick. Regular callers omit this and run straight through.
  //
  // 'finalize' is NOT a stop boundary — there is nothing after finalize, so it
  // means "run to completion" and returns `{complete:true, artifact, result}`.
  // It is accepted so a driver can name the phase it is resuming INTO
  // symmetrically with the other three (`stopAfter: nextPhase`), which is how
  // the background stage machine drives its last tick.
  stopAfter?: StagedStopAfter;
  // Injectable Cribl/AI operations — see StagedBuildOps. Production callers omit it.
  ops?: Partial<StagedBuildOps>;
  // ---- stage deadline (build 738) -------------------------------------------
  // The background stage's abort signal. A Backend Function invocation is
  // bounded, and "the stage ran out of time" must mean this function performs
  // NO further deploy or patch — not that something outside stopped waiting
  // while this one kept deploying. The signal is checked after AI/network
  // preparation and immediately before every side effect, and the build unwinds
  // by throwing (`isStageAbortError`). Only the background runner passes it:
  // undefined everywhere else, so the iframe and standalone paths are unchanged.
  signal?: AbortSignal;
  // Required, not defaulted: forces every call site to say what it wants for
  // completion logging rather than silently losing the interactive app's Lake
  // tally (see maybeLogScore in App.tsx) at a call site nobody re-checked.
  logScore: typeof logPipelineScore;
  log: (m: string) => void;
  onStage?: (r: StagedStageResult) => void;
  /** Receives durable snapshots after each stage and at completion. */
  onTrace?: (trace: BuildTrace) => void;
}

/**
 * Build one pipeline through the 3 scored stages.
 *
 * Two contracts, one implementation. A caller that passes neither `stopAfter`
 * nor `resume` gets the historic `StagedBuildResult` it always got — the wizard,
 * demo, experiment, rerun and batch flows are untouched. A caller that passes
 * either (see `StagedContinuation` — the value must be DEFINED, which is what
 * keeps the promise sound for a driver that picks the phase at runtime) gets
 * `StagedBuildProgress`, so it can persist the checkpoint and come back for the
 * next stage in a later invocation.
 *
 * The four `stopAfter` values are not symmetric. 'extraction', 'mapping' and
 * 'optimization' are real boundaries: the run halts there and returns
 * `{complete:false, nextPhase, artifact}` with no final result and no completion
 * event. **'finalize' is not a boundary** — nothing follows it — so it means
 * "run to completion" and returns `{complete:true, artifact, result}`. It exists
 * so a driver can pass the phase it is resuming INTO on every tick, including
 * the last one, instead of special-casing the end of the run.
 */
export async function buildStagedPipeline(
  opts: StagedBuildOptions & StagedContinuation,
): Promise<StagedBuildProgress | null>;
export async function buildStagedPipeline(
  opts: StagedBuildOptions & { resume?: undefined; stopAfter?: undefined },
): Promise<StagedBuildResult | null>;
export async function buildStagedPipeline(
  opts: StagedBuildOptions,
): Promise<StagedBuildResult | StagedBuildProgress | null> {
    const { sourcetype, sampleEvents, group, packId, pipelineId, packageJson, reductionToggles: rt, thresholds: thr, shareOn } = opts;
    const externalLog = opts.log;
    // The real `./api` functions unless a test injected fakes. Destructured under
    // the SAME names as the imports, so every call site below reads unchanged.
    const {
      deploy, patchPipeline, previewPipeline, fetchReferenceLookups, healLookup,
      getGoldenPart, saveGoldenPart, publishGoldenPart, observeGolden, aiMapping, schematizerMapping,
    } = resolveStagedBuildOps(opts.ops);
    // Customer events that may not leave the building turn every AI branch off
    // (module header) — logged once `log` exists, below.
    const aiRefusal = aiSampleRefusal({
      sampleEvents, sourceMode: opts.sampleSourceMode || '', sanitised: opts.sampleSanitised,
      required: loadQualitySettings().requireSanitisedSamples,
    });
    const noAi = (opts.noAi ?? false) || aiRefusal != null;
    // The stage deadline. `ensureLive` is called at entry, after every AI call
    // (the AI branches CATCH their own failures, so an aborted provider request
    // cannot be relied on to propagate) and inside `deployStage`/`preview` —
    // which are the only places this function writes to or reads from the
    // leader. A caller with no signal never sees any of it.
    const ensureLive = (where: string): void => {
      if (opts.signal?.aborted) throw stageAbortError(where);
    };
    ensureLive('starting the stage');
    // XmlWinEventLog channels + PowerShell ALWAYS allow a code function (Hard
    // Rule 3 + standing rule 2026-08-31): these Windows event logs are too
    // irregular to parse with regex_extract alone. Forced ON here — the single
    // choke point every flow (demo/create/batch) passes through — so it holds
    // even for the batch path, which passes no allowCode at all.
    const allowCode = (opts.allowCode ?? false) || isWindowsCodeFamily(sourcetype);
    const cimModel = opts.cimModel;
    // Concretize bare schema families ONCE, here — so the AI mapping call AND the
    // mapping SCORER use the SAME concrete golden key. The scorer concretizes via
    // resolveGoldenFormat(destFormat, sourcetype, sample) regardless; if the AI is
    // handed bare 'cim' it gets NO golden target-field grounding (loadGoldenTargetFields
    // keys on 'cim#change', not 'cim') and free-forms CIM names (user vs user_name)
    // that the concretized spec then grades as empty (measured: github_audit CIM=17).
    // Batch/demo already concretize before calling — this is a no-op there (an
    // already-concrete 'cim#change' can't match the bare guard) — and closes the gap
    // for the interactive Create-new-pack + Rerun paths, which pass bare 'cim'.
    let destFormat = opts.destFormat;
    if (destFormat === 'cim') destFormat = concretizeCimFormat('cim', sourcetype, sampleEvents, cimModel);
    else if (destFormat === 'asim') destFormat = concretizeAsimFormat('asim', sourcetype, sampleEvents);
    else if (destFormat === 'ocsf' || destFormat === 'nextgen') destFormat = concretizeOcsfFormat(destFormat, sourcetype, sampleEvents);
    // Final OCSF shape for a mapping-stage function list ([] for non-OCSF, for
    // NextGen raw-fidelity, or when there is no separate mapping stage).
    const ocsfShapingFor = (mapFns: any[]): any[] => (/^ocsf(#|$)/.test(destFormat) && mapFns.length
      ? buildOcsfOutputShaping({ mappingFns: mapFns, destFormat }).functions
      : []);
    // What an OCSF build DEPLOYS: the stage lists minus the adds it cannot ship
    // (no-op schematizer aliases, another model's copies/constants — see
    // pruneOcsfDeadFields). The stage lists stay whole: the extraction golden is
    // shared with CIM builds, which read those aliases.
    const ocsfDeployed = (extFns: any[], mapFns: any[]) => (/^ocsf(#|$)/.test(destFormat) && mapFns.length
      ? pruneOcsfDeadFields({ extractionFns: extFns, mappingFns: mapFns, destFormat })
      : { extractionFns: extFns, mappingFns: mapFns, removed: [] as string[] });
    const outputSourcetype = opts.outputSourcetype;
    // Destination metadata contract (Splunk: host/source/sourcetype), stamped at
    // the HEAD of the optimization slot — after mapping, before compaction strips
    // the fields its host chain reads. A per-destination requirement, not learned
    // shaping, so it never enters a golden optimization sub-part. [] = no contract.
    const destinationMetadataFns = buildDestinationMetadataFunctions(opts.destinationKey || destFormat, {
      sourcetype: resolveOutputSourcetype(outputSourcetype, sourcetype, canonicalizeSourcetype(sourcetype)),
      source: sourceNativeSplunkSource(outputSourcetype || sourcetype) || undefined,
      force: true,
      elastic: elasticIntegrationStamp(canonicalizeSourcetype(sourcetype)),
      secops: secopsLogTypeStamp(canonicalizeSourcetype(sourcetype)),
    });
    const mode = opts.mode ?? 'new';
    const origin = opts.origin ?? 'create';
    const routeFilter = opts.routeFilter ?? `sourcetype=='${sourcetype}'`;
    const SATISFIED = opts.satisfied ?? 90;
    // Second AI model (from Settings). When a stage's first AI attempt stays
    // BELOW the golden threshold, we make ONE more AI attempt with this model
    // and keep whichever result scores higher. Only used if it differs from the
    // primary model (no point re-running the same one).
    const qSettings = loadQualitySettings();
    // Quality → "Drop null and blank fields when parsing JSON" (default off).
    const sanitizeOpts = { dropEmptyJsonFields: !!qSettings.dropEmptyJsonFields };
    const secondModel = (qSettings.repairModel && qSettings.repairModel !== qSettings.normalModel) ? qSettings.repairModel : null;
    const isSchema = !['json', 'manual', 'raw', 'raw_fields', 'passthrough', ''].includes(destFormat);
    // XSIAM is source-native passthrough (Simon's PR #53): no parser / AI
    // extraction and no field mapping are added — the pipeline just validates
    // the payload + tags routing metadata. Guards below skip parser candidates,
    // golden storage, and mapping for this format.
    const isXsiam = destFormat === 'xsiam';
    // Passthrough is the purest form of the same idea: forward events EXACTLY as
    // received (no parse, no map, no optimize, no tagging) — for a Lake/destination
    // that just wants a raw copy of the data. `isNativePass` groups the two formats
    // that add no extraction/mapping/optimization and store no golden sub-parts;
    // the XSIAM-only bits (payload scoring, routing tagging) stay keyed on isXsiam.
    const isPassthrough = destFormat === 'passthrough';
    const isNativePass = isXsiam || isPassthrough;
    // Extraction class (see PreparedExtraction): a mapped-schema destination pulls
    // the canonical field model, raw/json wants the Search-native names, so the two
    // classes may pick different parsers and can't share one prepared extraction.
    const extractionClass = extractionClassOf(destFormat);
    // Reuse the orchestrator-computed extraction only when its class matches and
    // this isn't a native passthrough (which adds no parser at all).
    const reuseExtraction = !!(opts.preparedExtraction && !isNativePass && opts.preparedExtraction.extractionClass === extractionClass);
    const providedRawEvents = sampleEvents.trim().split('\n').filter(Boolean);
    const rawEvents = providedRawEvents.slice(0, 8);
    const sampleName = getSampleName(sourcetype);
    const sampleFp = sampleFingerprint(sampleEvents);
    // The wire format the stage goldens are filed under (golden-variant.ts): a
    // FortiGate CEF build reads and writes `fortinet_fortigate@cef`, never the
    // key=value golden. Null (empty / mixed sample) is the plain legacy key.
    const sampleWire = goldenWireFormatForSample(sampleEvents);
    // Saves file under the canonical sourcetype (goldenSourcetypeKeys).
    const goldenSourcetype = goldenSourcetypeKeys(sourcetype)[0];
    // Evidence for a stage measurement (golden-trust R1): the score, plus what it
    // was measured ON — every line of the sample, its store tier and how many of
    // its lines a model wrote (src/sample-provenance.ts). Without it a stored part
    // is refused, and a reuse verdict is not recorded.
    const stageEvidence = (stage: 'extraction' | 'mapping', score: number | null | undefined, band?: string) => buildGoldenEvidence({
      score: score ?? null, real: typeof score === 'number', scoreSource: `stage-${stage}`, band,
      sampleEvents, context: { sampleTier: opts.sampleTier, sourceMode: opts.sampleSourceMode },
    });
    // A reused golden's verdict goes back to the record it judged, whatever the
    // score — the low one is what lets a golden that stopped working be
    // quarantined (R3/R5). Never fails or slows the build meaningfully.
    const goldenVerdicts: { key: string; stage: string; recorded: number | null; observed: number }[] = [];
    const observeReuse = async (found: { rec: { functions?: unknown[]; functionsHash?: string; score?: number; evidence?: { score?: number } | null }; key: string } | null, stage: 'extraction' | 'mapping', score: number | null | undefined, band?: string) => {
      if (!found || typeof score !== 'number') return;
      goldenVerdicts.push({ key: found.key, stage, recorded: found.rec.evidence?.score ?? found.rec.score ?? null, observed: score });
      const r = await observeGolden(found.key, stageEvidence(stage, score, band), goldenHashOf(found.rec)).catch(() => null);
      if (r?.action === 'observe') log(`[${stage}] golden verdict recorded (${score})${r.reasons.length ? ` — ${r.reasons.join('; ')}` : ''}.`);
    };
    const traceRecorder = new TraceRecorder({
      sourcetype,
      requestedDestFormat: opts.destFormat,
      destFormat,
      workerGroup: group,
      packId,
      pipelineId,
      origin,
      mode,
      sampleName,
      sampleEvents: rawEvents.join('\n'),
      sampleProvidedEventCount: providedRawEvents.length,
      sampleTier: opts.sampleTier,
      sampleReason: opts.sampleReason,
      sampleSourceMode: opts.sampleSourceMode,
      sampleSanitised: opts.sampleSanitised,
      sampleFingerprint: sampleFp,
      recognition: recognizeSourcetype(sourcetype, { destFormat }),
    }, opts.resume?.trace);
    if (!opts.resume?.trace) traceRecorder.setDestination(destFormat);
    const publishTrace = (): BuildTrace => {
      const trace = traceRecorder.snapshot();
      opts.onTrace?.(trace);
      return trace;
    };
    const log = (message: string): void => {
      traceRecorder.log(message);
      externalLog(message);
    };
    if (aiRefusal && !opts.noAi) {
      log('AI steps skipped: this sample is the user\'s own events, not sanitised, and Samples → Sharing → "Require sanitised samples before any AI call" is on. '
        + 'The build uses the golden, built-in and Search-datatype paths only.');
    }
    if (rawEvents.length === 0) {
      log('No sample events — cannot build.');
      traceRecorder.fail('No sample events — cannot build.');
      publishTrace();
      return null;
    }
    // A refusal-text / bare-value sample is NOT MEASURABLE — building on it mints
    // a scored pack for a log nobody ships (packtester audit 2026-10-02).
    const usability = assessSampleUsable(rawEvents);
    if (!usability.usable) {
      const msg = `Sample not usable (${usability.kind}) — cannot build: ${usability.reason}`;
      log(msg);
      traceRecorder.fail(msg);
      publishTrace();
      return null;
    }
    const subtypeGap = sampleSubtypeMismatch(sourcetype, rawEvents, packageJson?.name || packId);
    if (subtypeGap) log(`⚠ ${subtypeGap.reason}`);
    // ONE sample per sourcetype (destination-independent) — every format's
    // pipeline in this pack parses the same `<sourcetype>_sample.log`, so the
    // pack holds a single sample rather than a duplicate per destination.
    const sampleData = rawEvents.map(r => ({ _raw: r, _time: Date.now() / 1000 }));
    const resume = opts.resume;
    const stopAfter = opts.stopAfter;
    // A caller that passes neither option is a regular caller and gets the
    // historic result shape back (see the overloads).
    const wantsProgress = stopAfter !== undefined || resume !== undefined;
    const buildStart = resume?.startedAt ?? Math.floor(Date.now() / 1000);
    const stages: StagedStageResult[] = [];
    // --- per-stage measurement for the Event Journey "Pipeline statistics" panel.
    const byteLen = (s: string) => new TextEncoder().encode(s).length;
    const bytesIn = byteLen(rawEvents.join('\n'));   // raw sample = pipeline input (each line IS the _raw)
    let stageClock = performance.now();              // wall-clock delta between emits = per-stage duration
    const sizeStats = (r: StagedStageResult): ExpStageStats => {
      const outStr = (r.out || []).map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
      const rawBytesOut = (r.out || []).reduce((n, e) => n + (e && typeof e._raw === 'string' ? byteLen(e._raw) : 0), 0);
      return {
        events: (r.out || []).length,
        bytesOut: byteLen(outStr),
        rawBytesOut,
        ...(r.stage === 'extraction' ? { bytesIn, rawBytesIn: bytesIn } : {}),
      };
    };
    const emit = (r: StagedStageResult) => {
      const now = performance.now();
      r.stats = {
        durationMs: Math.round(now - stageClock),
        ...sizeStats(r),
      };
      stageClock = now;
      stages.push(r);
      traceRecorder.recordStage(r);
      opts.onStage?.(r);
      publishTrace();
    };
    // A checkpointed stage was measured in an EARLIER invocation. Report it again
    // (so a resumed run still shows the whole stage list and the completion event
    // still sees every score) but keep the duration it was actually measured with:
    // re-timing it here would publish this invocation's clock as that stage's
    // work, which is a fabricated measurement (Hard Rule 32).
    const restore = (r: StagedStageResult) => {
      const restored: StagedStageResult = { ...r, stats: r.stats ?? sizeStats(r) };
      if (!opts.resume?.trace) traceRecorder.recordStage(restored);
      stages.push(restored); opts.onStage?.(restored);
    };
    // Field names extraction really produced (the "did it pull anything real out
    // of _raw" test). Recomputed from the artifact rather than carried as a flag,
    // so a resumed build derives it exactly as an uninterrupted one does.
    const realFieldNames = (event: any): string[] => (event
      ? Object.keys(event).filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_'))
      : []);
    const extractionHasFields = (pe: PreparedExtraction): boolean =>
      isNativePass || realFieldNames(pe.out[0]).length > 0;
    const extractionMetThreshold = (pe: PreparedExtraction): boolean =>
      isNativePass || (pe.score != null && pe.score >= thr.extraction);
    // The artifact is the checkpoint: resumed stages are copied in as finished and
    // each stage this invocation runs adds its own entry.
    const artifact: StagedBuildArtifact = { startedAt: buildStart, trace: publishTrace() };
    const stageOnly = (entry: StagedStageResult & { fns: any[] }): StagedStageResult => {
      const { fns: _fns, ...stage } = entry;
      return stage;
    };
    if (resume?.extraction) {
      artifact.extraction = resume.extraction;
      const pe = resume.extraction;
      restore({ stage: 'extraction', source: pe.source, score: pe.score, band: pe.band, reasons: pe.reasons, out: pe.out });
    }
    if (resume?.mapping) { artifact.mapping = resume.mapping; restore(stageOnly(resume.mapping)); }
    if (resume?.optimization) { artifact.optimization = resume.optimization; restore(stageOnly(resume.optimization)); }
    if (resume?.combinedBuild) artifact.combinedBuild = true;
    // Carried FORWARD, not just read: an invocation whose stage happens to
    // deploy nothing (a JSON mapping stage contributes no functions) would
    // otherwise hand on a checkpoint that has forgotten the pack exists, and
    // the invocation after it would create the pack again.
    if (resume?.packDeployed) artifact.packDeployed = true;

    // Reference lookups (self-healed against the sample). Resolved ONCE per run
    // and carried in the checkpoint: the fetch is a network call and the heal is
    // real work against the sample, and neither can produce a different answer
    // on a later invocation of the same build.
    let referenceLookups: any[] = [];
    if (resume?.referenceLookups) {
      referenceLookups = resume.referenceLookups;
    } else {
      try {
        referenceLookups = await fetchReferenceLookups(sourcetype);
        if (referenceLookups.length) {
          try {
            const heal = await healLookup(sourcetype, sampleEvents);
            if (heal.repaired?.length && heal.file && heal.content) {
              const idx = referenceLookups.findIndex(l => l.file === heal.file);
              if (idx >= 0) referenceLookups[idx] = { ...referenceLookups[idx], content: heal.content };
              log(`[extraction] self-healed lookup (${heal.repaired.length} fix(es)).`);
            }
          } catch { /* best-effort */ }
        }
      } catch { /* lookups optional */ }
    }
    artifact.referenceLookups = referenceLookups;

    // Create-once + patch model. mode:'new' creates the pack fresh (deferDeploy);
    // mode:'add-pipeline' adds this pipeline+route into an existing pack via the
    // deploy handler once, then PATCHes candidates in for scoring.
    //
    // Seeded from the checkpoint: "the pack exists" is a property of the RUN. A
    // resumed invocation starting from `false` would re-run pack CREATION and
    // throw away the pipelines the earlier invocations deployed into it.
    let firstDone = resume?.packDeployed === true;
    const xsiamBreakerYml = isXsiam
      ? buildXsiamBreakerYml(resolveXsiamForBuild(sourcetype, sampleEvents).breakerRulesets)
      : null;
    const deployStage = async (functions: any[]) => {
      // THE choke point: every pack create, pipeline add and candidate patch in
      // this builder goes through here, so one check covers every write.
      ensureLive('deploying pipeline config');
      // Static and golden parsers never pass through sanitizeCriblFunctions, so
      // the JSON empty-field filter is applied here too — at the one write path.
      // Stored goldens keep their original Parser; the filter is added on deploy.
      const conf = expConf(sanitizeOpts.dropEmptyJsonFields ? functions.map(f => withJsonEmptyFieldFilter(f, sanitizeOpts)) : functions);
      if (!firstDone) {
        if (mode === 'add-pipeline') {
          // Skip re-uploading the shared sourcetype sample when a sibling format
          // already put it in the pack (uploadSample:false). Still pass sampleName
          // so the pipeline references the existing shared sample for preview.
          const addSample = (opts.uploadSample ?? true) ? sampleData : undefined;
          await deploy({
            mode: 'add-pipeline', packId, pipelineId, workerGroup: group, packageJson,
            pipelineYml: JSON.stringify(conf), pipelineConf: conf,
            sourcetype, routeFilter, sampleData: addSample, sampleName, referenceLookups, deferDeploy: true,
            breakerYml: xsiamBreakerYml,
          }, log);
        } else {
          // Pack README (with the build-number footer) — attached only here, on
          // pack creation. Regenerated via buildPackReadme so the staged path
          // ships the same README the interactive buildPack() produces.
          const readme = buildPackReadme({
            sourcetype, destFormat, allFormats: opts.allFormats,
            packName: packageJson?.name || packId,
            displayName: packageJson?.displayName,
            routeFilter, workerGroup: group,
            reductionToggles: rt, allowCodeFunctions: allowCode,
            pipelineId, cimModel,
          });
          await deploy({
            mode: 'new', packId, pipelineId, workerGroup: group, packageJson,
            routeYml: stagedPackRouteYml(pipelineId, opts.routeFilter),
            pipelineYml: JSON.stringify(conf), pipelineConf: conf,
            sourcetype, routeFilter, sampleData, sampleName, referenceLookups, deferDeploy: true,
            readme,
            breakerYml: xsiamBreakerYml,
          }, log);
        }
        firstDone = true;
        artifact.packDeployed = true;
      } else {
        await patchPipeline(packId, pipelineId, group, conf);
      }
    };
    const preview = async () => {
      ensureLive('previewing the pipeline');
      return await previewPipeline({ workerGroup: group, packId, pipelineId, sourcetype, destFormat, sampleName });
    };
    const mappingsFromFns = (fns: any[]) => fns.flatMap((f: any) => (f?.conf?.add || []).map((a: any) => ({ from: '', to: a.name, expr: String(a.value) })));

    // ---- SCHEMATIZER SHORT-CIRCUIT (OCSF; ecs/udm later) ----------------------
    // For destinations Cribl's Copilot schematizer supports, delegate the WHOLE
    // parse+map+enrich to it — it returns one complete pipeline. We then bypass
    // our extraction + mapping candidate loops and score that single pipeline
    // through BOTH lenses (value-coverage → Extraction card; golden-spec-coverage
    // → Mapping card) so the two cards stay meaningfully different. It's still a
    // scored candidate: if it fails/scores low we fall through to golden→AI. To
    // A schematizer result is intentionally NOT cached as extraction/mapping
    // sub-parts: it is one inseparable parse+map+enrich pipeline and therefore
    // violates both sealed stage contracts.
    const SCHEMATIZER_DESTS = ['ocsf', 'ecs', 'chronicle'];   // chronicle = Google Chronicle UDM (schematizer family udm@)
    // destFormat was concretized above (ocsf/nextgen → 'ocsf#network' etc.), but the
    // schematizer works at the FAMILY level. Gate on the family prefix, or every OCSF
    // build silently skips the schematizer and falls to golden→AI (build 586 bug).
    const schematizerFamily = destFormat.split('#')[0];
    // Resolves extraction AND mapping in one delegated build, or null to fall
    // through to the independent stages below. Returned as the same two artifact
    // entries the normal stages produce, so the optimization/finalize operations
    // (and a resumed invocation) cannot tell the two paths apart.
    async function trySchematizerCombined(): Promise<{
      extraction: PreparedExtraction; mapping: StagedStageResult & { fns: any[] };
    } | null> {
    if (!noAi && !isXsiam && SCHEMATIZER_DESTS.includes(schematizerFamily)) {
      // Skip if we already have BOTH golden sub-parts for this sample (replay).
      const gExt = await getGoldenPartForSourcetype(getGoldenPart, 'extraction', sourcetype, destFormat, sampleWire).catch(() => null);
      const gMap = await getGoldenPartForSourcetype(getGoldenPart, 'mapping', sourcetype, destFormat, sampleWire).catch(() => null);
      // BOTH parts must be replayable onto THIS sample, not merely present. The
      // mapping stage below replays a part only when its OWN fingerprint matches
      // (a part with no stored fingerprint is never replayed — the auto-promote
      // guard), so checking only extraction's would skip the delegation in favour
      // of a mapping golden that then gets skipped too, leaving spec/AI mapping
      // where Copilot would have run. Bare-format parts promoted by
      // golden-format-fallback.ts are exactly that case: they carry no recipe.
      const goldenReplayable = gExt?.functions?.length && gMap?.functions?.length
        && fingerprintsMatch(gExt.recipe?.fingerprint, sampleFp)
        && fingerprintsMatch(gMap.recipe?.fingerprint, sampleFp);
      if (!goldenReplayable) {
        log(`[schematizer] delegating ${sourcetype} → ${destFormat.toUpperCase()} to Cribl Copilot…`);
        // Deploy the pack+sample first so the agent's sample reference resolves.
        await deployStage(getParserForSourcetype(sourcetype, allowCode) || []);
        let schema: Awaited<ReturnType<typeof schematizerMapping>> = null;
        try { schema = await schematizerMapping(sourcetype, destFormat, sampleName, sampleData, group); } catch { /* soft */ }
        // The catch above is deliberate (a failed delegation falls back to the
        // normal staged build) — which is exactly why the deadline has to be
        // re-checked here rather than left to the error it swallowed.
        ensureLive('scoring the delegated pipeline');
        if (schema?.functions?.length) {
          // The agent's functions must pass our Cribl-safety sanitizer before
          // deploy — it sometimes emits bare regexes (no /…/), @-prefixed names,
          // etc. that Cribl rejects at pipeline-write (500). sanitizeCriblFunctions
          // slash-wraps regexes and drops/fixes unsafe eval/rename entries.
          const sanitized = sanitizeCriblFunctions(schema.functions, sanitizeOpts);
          let schemaFns = sanitized.functions;
          if (sanitized.dropped.length) log(`[schematizer] sanitized: ${sanitized.dropped.length} unsafe item(s) fixed/dropped.`);
          // P3 (project_ocsf_library_plan): ground Copilot's OCSF output against the
          // vendored schema BEFORE deploy/score — derive type_uid/category_uid and
          // stamp metadata.version. Deterministic, non-guessing; closes the gaps the
          // Phase-1 oracle would otherwise penalize (type_uid math + a required attr).
          if (isOcsfFormat(destFormat)) {
            const grounded = groundOcsfPipeline(schemaFns);
            schemaFns = grounded.functions;
            log(`[schematizer] OCSF schema grounding: ${grounded.added.join(', ')} (v${OCSF_SCHEMA_VERSION}).`);
          }
          await deployStage(schemaFns);
          const out = await preview();
          // Two lenses on the ONE schematizer pipeline.
          const sExt = scoreStage('extraction', destFormat, sourcetype, rawEvents, out, []);
          const sMap = scoreStage('mapping', destFormat, sourcetype, rawEvents, out, out);
          log(`[schematizer] ${schema.schemaId || destFormat}: extraction ${sExt.score}, mapping ${sMap.score}`);
          // A combined candidate does not get a weaker quality bar merely because
          // no deterministic fallback was registered. That accepted the seLab
          // GCP Audit OCSF pipeline at E8/M6 and then advertised O100. Both
          // independent stage lenses must pass before this inseparable pipeline
          // is allowed to short-circuit the normal staged builder.
          if (!shouldAcceptCombinedCandidate(
            sExt.score,
            sMap.score,
            thr.extraction,
            thr.mapping,
          )) {
            log(`[schematizer] rejected: extraction ${sExt.score ?? 'n/a'} / mapping ${sMap.score ?? 'n/a'} did not meet ${thr.extraction}/${thr.mapping}; falling back to independent stages.`);
          } else {
            const extractionStage: StagedStageResult = { stage: 'extraction', source: 'copilot', score: sExt.score, band: sExt.band, reasons: [`Cribl schematizer (${schema.schemaId || destFormat}) — one combined build. ${sExt.reasons[0] || ''}`], out };
            emit(extractionStage);
            const mappingStage: StagedStageResult = { stage: 'mapping', source: 'copilot', score: sMap.score, band: sMap.band, reasons: [`Cribl schematizer (${schema.schemaId || destFormat}) — one combined build. ${sMap.reasons[0] || ''}`], out, detail: mappingsFromFns(schemaFns) };
            emit(mappingStage);
            log('[schematizer] combined pipeline accepted for this build only; stage golden caches remain unchanged.');
            // Optimization runs on top of the schematizer pipeline; then finish
            // (same STAGE 3 + completion-logging path as the normal flow). The
            // whole pipeline IS the extraction stage here and its mapping already
            // lives inside it, so the mapping artifact contributes no functions.
            return {
              extraction: { fns: schemaFns, out, score: sExt.score, band: sExt.band, reasons: extractionStage.reasons, source: 'copilot', extractionClass },
              mapping: { ...mappingStage, fns: [] },
            };
          }
        } else {
          log(`[schematizer] unavailable or produced no pipeline — falling back to golden/AI.`);
        }
      } else {
        log(`[schematizer] replaying cached golden sub-parts for ${sourcetype} → ${destFormat.toUpperCase()} (no agent call).`);
      }
    }
    return null;
    }

    // ---- STAGE 1: EXTRACTION (Search → golden → pack → AI) ----
    // XSIAM: no extraction — the source-native payload passes through untouched
    // (a single no-op candidate so the pipeline validates + tags, adds no parser).
    // Shared extraction outputs — populated by EITHER the reuse fast-path (a
    // sibling format already resolved extraction for this sourcetype) or the full
    // candidate loop below. Declared here so both branches converge on the same
    // variables that mapping/optimization read.
    //
    // ONE candidate loop, for every flow and both continuation modes: a resumed
    // build restores this stage's artifact instead of re-entering the loop, so
    // there is no background-only copy of the ordering/threshold/retry policy.
    // `measured` = the candidate deployed and its preview was scored. A candidate
    // Cribl rejected (or a deploy that timed out) still RANKS as 0, but is not a
    // measurement of it — so it never becomes a reuse verdict (golden-trust R5).
    type ScoredExtraction = { source: ExpStageResult['source']; fns: any[]; out: any[]; score: number; scoreRaw: number | null; band: ExpStageResult['band']; reasons: string[]; measured?: boolean };
    async function runExtractionStage(): Promise<PreparedExtraction> {
    let best1: ScoredExtraction | null = null;
    let extractionFns: any[];
    let extSource: ExpStageResult['source'];
    let out1: any[];
    let s1: { score: number | null; band: ExpStageResult['band']; reasons: string[] };
    let extractedRealFieldCount: number;
    let extractionProducedFields: boolean;
    if (reuseExtraction) {
      // FAST PATH: reuse the extraction the orchestrator computed once for this
      // sourcetype. Still deploy the shared parser onto THIS pipeline (creates it
      // + uploads the sample per mode) so the pipeline has a working first stage;
      // no candidate loop, no AI calls, no golden re-save.
      const pe = opts.preparedExtraction!;
      extractionFns = pe.fns; extSource = pe.source; out1 = pe.out;
      s1 = { score: pe.score, band: pe.band, reasons: pe.reasons };
      await deployStage(extractionFns);
      extractedRealFieldCount = out1[0] ? Object.keys(out1[0]).filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_')).length : 0;
      extractionProducedFields = extractedRealFieldCount > 0;
      log(`[extraction] reused pack extraction (${extSource}, score ${s1.score ?? 'not measurable'}) — computed once for ${sourcetype}, shared across this pack's formats.`);
    } else {
    const extCandidates: { source: ExpStageResult['source']; label: string; fns: any[] }[] = [];
    // The stored extraction golden that entered the contest, with its store key —
    // so its verdict can be written back (observeReuse).
    let goldenExtFound: Awaited<ReturnType<typeof findGoldenPartForSourcetype>> = null;
    if (isNativePass) {
      if (isXsiam) {
        log(`[extraction] XSIAM native-payload passthrough for ${sourcetype} — no parser/AI extraction added.`);
        extCandidates.push({ source: 'copilot', label: 'XSIAM native-payload passthrough', fns: [] });
      } else {
        // Passthrough: a single self-documenting comment marks intent; the pipeline
        // adds NO transform, so every event is forwarded unchanged (_raw preserved).
        log(`[extraction] passthrough for ${sourcetype} — no parser/AI extraction; events forwarded unchanged.`);
        extCandidates.push({ source: 'none', label: 'passthrough (raw copy — no transform)', fns: [{ id: 'comment', conf: { comment: '--- Passthrough: events forwarded unchanged (_raw preserved) — no transformation applied ---' } }] });
      }
    } else {
      const dtp = getDatatypeParserFunctions(sourcetype);
      const searchCand = dtp?.functions?.length
        ? { source: 'search' as ExpStageResult['source'], label: `Search datatype (${dtp.searchDatatypeId})`, fns: dtp.functions }
        : null;
      goldenExtFound = await findGoldenPartForSourcetype(getGoldenPart, 'extraction', sourcetype, destFormat, sampleWire).catch(() => null);
      const goldenExt = goldenExtFound?.rec ?? null;
      let goldenCand: { source: ExpStageResult['source']; label: string; fns: any[] } | null = null;
      // The wire-format guard gates the stored golden exactly as it gates the
      // built-in parser below (golden-trust R7): a golden is at least as capable
      // of being wrong about the format as a static parser is.
      const sourceExpectation = sampleMatchesSourceExpectation(sourcetype, sampleEvents);
      if (goldenExt?.functions?.length) {
        const gfp = goldenExt.recipe?.fingerprint;
        const serving = goldenServingDecision({
          state: storedTrustState(goldenExt),
          fingerprintMatch: fingerprintsMatch(gfp, sampleFp),
          expectation: sourceExpectation,
        });
        if (!serving.serve) {
          log(`[extraction] skipping golden — ${serving.reason}${serving.reason?.includes('fingerprint') ? ` (golden ${gfp?.format || 'unknown'}, sample ${sampleFp.format})` : ''}.`);
        }
        else goldenCand = { source: 'golden', label: 'golden sub-part', fns: goldenExt.functions };
      }
      let staticCand: { source: ExpStageResult['source']; label: string; fns: any[] } | null = null;
      if (sourceExpectation === 'mismatch') {
        log(`[extraction] skipping built-in parser — sample wire format does not match the selected ${sourcetype} source contract.`);
      } else {
        try { const pk = getParserForSourcetype(sourcetype, allowCode); if (pk?.length) staticCand = { source: 'static', label: 'built-in / pack parser', fns: pk }; } catch { /* none */ }
      }
      // Ordering matters because the loop early-breaks at SATISFIED. For a MAPPED
      // schema destination (CIM/OCSF/ECS/CEF/CSL) the downstream mapper reads the
      // CANONICAL field model (src_ip/dest_port/session_id…). The curated golden
      // and static parsers emit exactly those names; the stock Search datatype
      // emits vendor-native names (srcip/dstport/sessionid) that score identically
      // on value-coverage but leave the mapper with nothing to read (Rule 10).
      // So try curated-first for schema dests, and Search-first for raw/JSON where
      // no mapping happens and the datatype's native names are the desired output.
      const isMappedSchema = ![
        'json', 'manual', 'raw', 'raw_fields', 'passthrough', '',
      ].includes(destFormat);
      // Parser already AI-generated ONCE by prepareSource for this source — the
      // single source of truth for an unknown source's extraction. Added as a
      // candidate (LAST, so a verified golden/static/search parser still wins the
      // early-break) so we never RE-RUN the AI parse per format. That per-format
      // re-derivation was the slowness; for unknown sources with no static parser
      // it also let each format fall to a JSON-serde fallback that scored 0.
      let preparedCand: { source: ExpStageResult['source']; label: string; fns: any[] } | null = null;
      if (opts.preparedParseFns?.length) {
        const sanitized = sanitizeCriblFunctions(opts.preparedParseFns, sanitizeOpts);
        if (sanitized.dropped.length) {
          log(`[extraction] sanitized prepared AI parse: ${sanitized.dropped.length} unsafe item(s) fixed/dropped.`);
        }
        preparedCand = { source: 'ai', label: 'prepared AI parse', fns: sanitized.functions };
      }
      const ordered = isMappedSchema
        ? [goldenCand, staticCand, searchCand, preparedCand]
        : [searchCand, goldenCand, staticCand, preparedCand];
      // A golden or AI extraction for a Windows channel gets the OCSF class
      // dispatcher its built-in parser carries (withWindowsOcsfDispatch).
      for (const c of ordered) if (c) extCandidates.push({ ...c, fns: withWindowsOcsfDispatch(sourcetype, c.fns) });
    }
    // If prepareSource already produced the AI parse, treat AI as "tried" so the
    // fallback re-run below doesn't fire a duplicate AI call for the same source.
    let aiParseTried = !!(opts.preparedParseFns && opts.preparedParseFns.length);
    const buildAiParseCandidate = async (model?: string) => {
      aiParseTried = true;
      try {
        const parse = await resolveParseFunctions({ sourcetype, sampleEvents, log, model, sourceMode: opts.sampleSourceMode, sanitised: opts.sampleSanitised, ops: opts.ops });
        if (parse.aiParseFns?.functions?.length) {
          // AI parse output MUST pass the Cribl-safety sanitizer before deploy —
          // reasoning models (opus-5) emit regex_extract with `regexList` as a
          // bare string[] (Cribl rejects: "/regexList/0 should be object"), bare
          // (unslashed) regex literals, unsafe eval, etc. Without this the whole
          // ~30s AI attempt is wasted on a 500 at pipeline-write.
          const sanitized = sanitizeCriblFunctions(parse.aiParseFns.functions, sanitizeOpts);
          if (sanitized.dropped.length) log(`[extraction] sanitized AI parse: ${sanitized.dropped.length} unsafe item(s) fixed/dropped.`);
          return { source: 'ai' as ExpStageResult['source'], label: model ? `AI parse (${model})` : 'AI parse', fns: withWindowsOcsfDispatch(sourcetype, sanitized.functions) };
        }
      } catch { /* */ }
      return null;
    };
    // The AI parse branch above swallows its own failures too (an unusable
    // parser degrades to the deterministic candidates), so the deadline is
    // asked directly rather than inferred from an error that never arrives.
    const buildAiCandidate = async (model?: string) => {
      const candidate = await buildAiParseCandidate(model);
      ensureLive('scoring the AI parse candidate');
      return candidate;
    };
    // `score` is the RANKING number (unmeasurable = 0, so a measured candidate
    // always wins); `scoreRaw` is what we REPORT — null when the stage could not
    // be measured at all. Keeping only the ranking number defeated the
    // "NOT MEASURABLE ≠ FAILED" rule below: scoreStage returned null, `?? 0`
    // turned it into a hard 0, and the user saw a stage that had failed.
    const tryExt = async (c: { source: ExpStageResult['source']; label: string; fns: any[] }) => {
      log(`[extraction] trying ${c.label}…`);
      // Keep the vendor's own token for anything the parser normalizes in place
      // (`action = action === 'ACCEPT' ? 'allowed' : …` destroys ACCEPT), so a
      // vendor-native destination can still reach it. One choke point covers all
      // candidate sources — static, golden, Search datatype and AI — and the
      // transformed list is what gets deployed, scored and stored as golden.
      c.fns = preserveNativeVocabularyValues(c.fns);
      // A single malformed candidate (e.g. a golden/AI eval Cribl rejects with
      // "could not find function factory") must NOT abort the whole build — it
      // scores 0 and best-score-wins moves on to the next candidate.
      try {
        await deployStage(c.fns);
        const out = await preview();
        const s = scoreStage('extraction', destFormat, sourcetype, rawEvents, out, []);
        log(`[extraction] ${c.label}: score ${s.score ?? 'not measurable'}`);
        return { source: c.source, fns: c.fns, out, score: s.score ?? 0, scoreRaw: s.score, band: s.band, reasons: s.reasons, measured: true } satisfies ScoredExtraction;
      } catch (e) {
        log(`[extraction] ${c.label} FAILED to deploy (${e instanceof Error ? e.message : String(e)}) — skipping.`);
        // A candidate Cribl rejected IS measured — it produced nothing. 0, not null.
        return { source: c.source, fns: c.fns, out: [], score: 0, scoreRaw: 0, band: 'fail' as const, reasons: [`Candidate rejected by Cribl: ${e instanceof Error ? e.message : String(e)}`] } satisfies ScoredExtraction;
      }
    };
    for (const c of extCandidates) {
      const scored = await tryExt(c);
      if (c.source === 'golden' && scored.measured) await observeReuse(goldenExtFound, 'extraction', scored.scoreRaw, scored.band);
      if (!best1 || scored.score > best1.score) best1 = scored;
      if (best1.score >= SATISFIED) break;
    }
    if (!noAi && !isNativePass && (best1?.score ?? 0) < SATISFIED && !aiParseTried) {
      const aiC = await buildAiCandidate(qSettings.normalModel);
      if (aiC) {
        const scored = await tryExt(aiC);
        if (!best1 || scored.score > best1.score) best1 = scored;
      }
    }
    // Second-model retry: only worth a second ~30s reasoning call when the first
    // result is within STRIKING DISTANCE of the golden threshold. A second model
    // reliably closes a small gap (observed: mapping 83→100) but NOT a large one
    // (observed: 20→50, 43→57 — both still failed, the extra call was pure cost).
    // Skip the retry when the gap is too large to plausibly clear; the best-effort
    // result is stored either way. RETRY_REACH is the max gap we'll pay to close.
    const RETRY_REACH = 25;
    const extScore = best1?.score ?? 0;
    if (!noAi && !isNativePass && secondModel && extScore < thr.extraction && extScore >= thr.extraction - RETRY_REACH) {
      log(`[extraction] ${extScore} is within ${RETRY_REACH} of golden ${thr.extraction} — retrying with second model ${secondModel}…`);
      const aiC2 = await buildAiCandidate(secondModel);
      if (aiC2) {
        const scored = await tryExt(aiC2);
        if (!best1 || scored.score > best1.score) best1 = scored;
      }
    }
    extractionFns = best1 ? best1.fns : (isNativePass ? [] : getParserForSourcetype(sourcetype, allowCode));
    extSource = best1 ? best1.source : (isXsiam ? 'copilot' : (isPassthrough ? 'none' : 'static'));
    if (best1 && extCandidates[extCandidates.length - 1]?.fns !== best1.fns) await deployStage(extractionFns);
    out1 = best1 ? best1.out : [];
    s1 = best1
      ? { score: best1.scoreRaw, band: best1.band, reasons: best1.reasons }
      : { score: 0, band: 'fail' as const, reasons: ['No extraction produced output.'] };
    // Extraction health gate: did extraction actually pull REAL named source
    // fields out of _raw? When it didn't AND AI wasn't tried yet, retry with a
    // format-aware prompt so the second attempt knows the sample structure.
    extractedRealFieldCount = out1[0]
      ? Object.keys(out1[0]).filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_')).length
      : 0;
    extractionProducedFields = isNativePass || extractedRealFieldCount > 0;
    if (!noAi && !extractionProducedFields && !isNativePass && !aiParseTried) {
      log(`[extraction] produced no fields — retrying AI parse with format-aware prompt…`);
      const aiRetry = await buildAiCandidate(qSettings.normalModel);
      if (aiRetry) {
        const scored = await tryExt(aiRetry);
        if (scored.score > (best1?.score ?? 0)) {
          best1 = scored;
          extractionFns = scored.fns; extSource = scored.source;
          out1 = scored.out; s1 = { score: scored.scoreRaw, band: scored.band, reasons: scored.reasons };
          extractedRealFieldCount = out1[0] ? Object.keys(out1[0]).filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_')).length : 0;
          extractionProducedFields = extractedRealFieldCount > 0;
          if (extractionProducedFields) await deployStage(extractionFns);
        }
      }
    }
    // Per-event gaps (event-coverage.ts): events the winner left unextracted get
    // an extraction gated to them, kept only if it helps; otherwise reported.
    if (!isNativePass && best1 && out1.length) {
      const cov = perEventCoverage(rawEvents, out1);
      const lagging = cov ? laggingEvents(cov) : [];
      if (cov && lagging.length) {
        log(`[extraction] ${lagging.length}/${rawEvents.length} event(s) left behind by ${extSource} (event ${lagging.map(i => i + 1).join(', ')}) — trying a gated extraction for them…`);
        let fns = extractionFns;
        let n = 0;
        for (const group of groupByShape(rawEvents, lagging)) {
          const field = gateField(cov, group, lagging);
          if (!field) { log(`[extraction] no field separates event ${group.map(i => i + 1).join(', ')} from the handled ones — not gated.`); continue; }
          let extra = jsonExtraction(rawEvents, group, fns);
          if (!extra && !noAi) {
            try {
              const parse = await resolveParseFunctions({ sourcetype, sampleEvents: group.map(i => rawEvents[i]).join('\n'), log, model: qSettings.normalModel, sourceMode: opts.sampleSourceMode, sanitised: opts.sampleSanitised, forceAi: true, ops: opts.ops });
              if (parse.aiParseFns?.functions?.length) extra = sanitizeCriblFunctions(parse.aiParseFns.functions, sanitizeOpts).functions;
            } catch { /* reported below */ }
            ensureLive('scoring the per-event gap extraction');
          }
          if (extra?.length) fns = [...fns, ...gateFunctions(extra, field, ++n)];
        }
        let fixed = false;
        if (fns !== extractionFns) {
          const scored = await tryExt({ source: extSource, label: `${extSource} + gated extraction for ${lagging.length} left-behind event(s)`, fns });
          if (acceptAugmented(cov, perEventCoverage(rawEvents, scored.out), lagging, best1.score, scored.score)) {
            best1 = scored; fixed = true;
            extractionFns = scored.fns; out1 = scored.out;
            s1 = { score: scored.scoreRaw, band: scored.band, reasons: scored.reasons };
            extractedRealFieldCount = out1[0] ? Object.keys(out1[0]).filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_')).length : 0;
            extractionProducedFields = extractedRealFieldCount > 0;
          } else {
            log(`[extraction] gated extraction did not help (${scored.score} vs ${best1.score}) — keeping ${extSource}.`);
            await deployStage(extractionFns);
          }
        }
        const still = fixed ? laggingEvents(perEventCoverage(rawEvents, out1) || []) : lagging;
        if (still.length) s1 = { ...s1, reasons: [...s1.reasons, lagReason(rawEvents, still, rawEvents.length, false)] };
        else if (fixed) s1 = { ...s1, reasons: [...s1.reasons, lagReason(rawEvents, lagging, rawEvents.length, true)] };
      }
    }
    } // end of the compute-extraction (non-reuse) branch
    if (!isNativePass && !extractionCarriedSourceData(s1.score)) {
      log(`[extraction] ⚠ carried NO source values into named fields (score ${s1.score ?? 'not measurable'}${extractionProducedFields ? `; ${extractedRealFieldCount} field name(s) present, but empty or constant` : '; no named fields at all'}) — mapping cannot carry real data; its score will be capped and no golden stored.`);
    }
    emit({ stage: 'extraction', source: extSource, score: s1.score, band: s1.band, reasons: s1.reasons, out: out1 });
    // XSIAM / passthrough add no parser → nothing to store as an extraction golden.
    // When reusing the pack-level extraction, the FIRST format build already saved
    // + published this golden — re-saving here is redundant (and idempotent), so skip.
    if (!isNativePass && !reuseExtraction && extSource !== 'golden' && (s1.score ?? 0) >= thr.extraction) {
      const contract = validateExtractionStage(extractionFns);
      if (contract.valid) {
        ensureLive('storing the verified extraction golden');
        const saved = await saveGoldenPart('extraction', goldenSourcetype, destFormat, extractionFns, s1.score!, null, sampleFp, sampleWire, stageEvidence('extraction', s1.score, s1.band));
        // An injected store that reports nothing (tests) counts as stored.
        const extStored = !saved || ['create', 'replace', 'observe'].includes(saved.action);
        ensureLive('sharing the verified extraction golden');
        if (extStored) await publishGoldenPart('extraction', goldenSourcetype, destFormat, extractionFns, s1.score!, thr.extraction, null, sampleFp, sampleWire).catch(() => {});
        log(extStored
          ? `[extraction] stored as golden (≥${thr.extraction})${shareOn ? ' + offered to the pool' : ''}.`
          : `[extraction] golden not stored: ${saved?.reasons?.join('; ') || saved?.action || 'store unavailable'}.`);
      } else {
        log(`[extraction] NOT stored: parser-only contract failed (${contract.reasons.join('; ')}).`);
      }
    }
    return { fns: extractionFns, out: out1, score: s1.score, band: s1.band, reasons: s1.reasons, source: extSource, extractionClass };
    }

    // ---- STAGE 2: MAPPING (golden → Copilot → AI → static) ----
    // Reads the FINISHED extraction stage, whether this invocation computed it or
    // restored it from a checkpoint — one mapping candidate loop for both.
    async function runMappingStage(ext: PreparedExtraction): Promise<StagedStageResult & { fns: any[] }> {
    const extractionFns = ext.fns;
    const out1 = ext.out;
    const s1 = { score: ext.score, band: ext.band, reasons: ext.reasons };
    const extractionProducedFields = extractionHasFields(ext);
    // WHOLE-BUILD GOLDEN GATE. A pipeline is only a trustworthy recipe if its
    // EXTRACTION was measured and passed on this very sample. Storing mapping /
    // optimization sub-parts independently produced 37 orphan mapping goldens in
    // the local store — mapping saved at 90-100 with no matching extraction
    // golden, because a mapping can score high while filling nothing but constant
    // schema-envelope values. This single flag gates every downstream save AND
    // publish, so the rule holds for any future sourcetype without per-source
    // logic. `score: null` (not measurable) deliberately fails the gate.
    const extractionPassed = extractionMetThreshold(ext);
    let mappingFns: any[] = []; let mapSource: ExpStageResult['source'] = 'none';
    let mapDetail: { from: string; to: string; expr: string }[] = [];
    let out2: any[] = out1; let s2: { score: number | null; band: ExpStageResult['band']; reasons: string[] } = { score: null, band: 'na', reasons: [] };
    if (isXsiam) {
      try {
        mappingFns = buildXsiamTagging(sourcetype, sampleEvents);
      } catch (err) {
        const msg = err instanceof XsiamBuildError ? err.message : String(err);
        log(`[mapping] XSIAM build failed: ${msg}`);
        throw err;
      }
      mapSource = 'static';
      mapDetail = mappingsFromFns(mappingFns);
      await deployStage([...extractionFns, ...mappingFns]);
      out2 = await preview();
      s2 = scoreStage('mapping', destFormat, sourcetype, rawEvents, out2, out1);
      log(`[mapping] XSIAM routing contract: score ${s2.score ?? 'n/a'}`);
    } else if (isNextGenRawFidelityFormat(destFormat)) {
      // NG SIEM maps nothing: the minimal envelope + vendor tag that the drops and
      // routing read, all removed again by the restore. No golden, Copilot or AI
      // candidate — each would be an OCSF mapping the destination never receives.
      mappingFns = getMappingFunctions(sourcetype, destFormat);
      mapSource = 'static';
      mapDetail = mappingsFromFns(mappingFns);
      await deployStage([...extractionFns, ...mappingFns]);
      out2 = await preview();
      s2 = scoreStage('mapping', destFormat, sourcetype, rawEvents, out2, out1);
    } else if (!isSchema) {
      mapSource = 'none';
      s2 = { score: null, band: 'na', reasons: [`Destination "${destFormat || 'JSON'}" has no schema — serialized as-is.`] };
    } else {
      const mapCandidates: { source: ExpStageResult['source']; label: string; fns: any[]; detail: typeof mapDetail }[] = [];
      const goldenMapFound = await findGoldenPartForSourcetype(getGoldenPart, 'mapping', sourcetype, destFormat, sampleWire).catch(() => null);
      const goldenMap = goldenMapFound?.rec ?? null;
      if (goldenMap?.functions?.length) {
        const serving = goldenServingDecision({
          state: storedTrustState(goldenMap),
          fingerprintMatch: fingerprintsMatch(goldenMap.recipe?.fingerprint, sampleFp),
          expectation: sampleMatchesSourceExpectation(sourcetype, sampleEvents),
        });
        if (serving.serve) {
          mapCandidates.push({ source: 'golden', label: 'golden sub-part', fns: goldenMap.functions, detail: mappingsFromFns(goldenMap.functions) });
        } else if (serving.reason?.includes('fingerprint')) {
          log('[mapping] skipping golden — source sample fingerprint does not match the mapping contract.');
        } else {
          log(`[mapping] skipping golden — ${serving.reason}.`);
        }
      }
      if (hasGoldenFormatPath(sourcetype, destFormat, rawEvents.join('\n'))) { const f = buildGoldenFormatMapping(sourcetype, destFormat, outputSourcetype, rawEvents.join('\n')); mapCandidates.push({ source: 'copilot', label: 'Copilot schema mapping', fns: f, detail: mappingsFromFns(f) }); }
      let aiMapTried = false;
      // Use REAL extracted fields from stage 1 output — not getParserFieldNames()
      // which is empty for AI-parsed sources, causing mapping to reference invented
      // field names that don't exist in the extraction output.
      const realExtractedFields = validateMappingInputs([], out1).populatedFields;
      const buildAiMap = async (model?: string) => {
        aiMapTried = true;
        const parsedNames = realExtractedFields.length > 0 ? realExtractedFields : getParserFieldNames(sourcetype);
        const m = await aiMapping(sourcetype, destFormat, rawEvents.slice(0, 15).join('\n'), undefined, parsedNames.length ? parsedNames : undefined, undefined, model, isCimFormat(destFormat) ? cimModel : undefined).catch(() => null);
        // `.catch(() => null)` swallows an aborted request, so ask the signal.
        ensureLive('building the AI mapping candidate');
        if (m?.mappings?.length) return { source: 'ai' as ExpStageResult['source'], label: model ? `AI mapping (${model})` : 'AI mapping', fns: buildAiMappingFunctions(m, sourcetype, destFormat, outputSourcetype), detail: m.mappings.map((x: any) => ({ from: x.sourceField || '', to: x.destField, expr: String(x.expression ?? x.sourceField ?? '') })) };
        return null;
      };
      const staticMapFns = getMappingFunctions(sourcetype, destFormat);
      // `score` ranks, `scoreRaw` reports — see ScoredExtraction. This is where a
      // Sentinel-native-table pack reported "M 0": no spec matched the table, the
      // scorer honestly returned null, and `?? 0` published it as a failure — which
      // also set the pack's overall/deployment score to 0 (see `overall` below).
      type ScoredMapping = { source: ExpStageResult['source']; fns: any[]; detail: typeof mapDetail; out: any[]; score: number; scoreRaw: number | null; band: ExpStageResult['band']; reasons: string[]; inputValid: boolean; measured?: boolean };
      let best2: ScoredMapping | null = null;
      const betterMapping = (current: ScoredMapping | null, candidate: ScoredMapping): ScoredMapping =>
        !current
        || (candidate.inputValid && !current.inputValid)
        || (candidate.inputValid === current.inputValid && candidate.score > current.score)
          ? candidate
          : current;
      const tryMap = async (c: { source: ExpStageResult['source']; label: string; fns: any[]; detail: typeof mapDetail }) => {
        log(`[mapping] trying ${c.label}…`);
        // Copilot/schematizer → canonical before any dest map; strip mid-map
        // serialize/keep so stale Copilot cleanup cannot wipe the candidate.
        // A stored golden carries the `Number(x || 0)` defaults it was built
        // with; guard them here so every candidate leaves a missing value missing.
        c.fns = dropFabricatedZeroDefaults(withoutOutputCompaction(withSchematizerCanonicalAliases(c.fns)));
        // A vendor-native Sentinel column expects the VENDOR's value (AWSVPCFlow
        // Action = ACCEPT/REJECT), not the canonical vocabulary the extraction
        // normalized to. Rewrites a pure `action` read to `vendor_action ||
        // action`, and only when extraction really produced that field — so it
        // also self-heals a stale golden mapping sub-part, like the CIM shape above.
        c.fns = preferNativeVocabularyValues(destFormat, c.fns, realExtractedFields);
        // With extraction + schematizer aliases + mapping all visible, drop raw
        // alias fields (uri→url, bytes→bytes_out, timestamp→log_time) from a
        // Sentinel AdditionalExtensions capture so they don't duplicate a column.
        c.fns = dedupeAliasedSerializeFields(c.fns, [...extractionFns, ...c.fns]);
        c.detail = mappingsFromFns(c.fns);
        const inputContract = validateMappingInputs(c.fns, out1);
        if (!inputContract.valid) {
          const reason = `Candidate rejected before deploy: ${inputContract.reason}.`;
          log(`[mapping] ${c.label} ${reason}`);
          return { source: c.source, fns: c.fns, detail: c.detail, out: out1, score: 0, scoreRaw: 0, band: 'fail' as const, reasons: [reason], inputValid: false } satisfies ScoredMapping;
        }
        log(`[mapping] ${c.label} input contract: ${inputContract.reason}.`);
        // A malformed mapping candidate must not abort the build (see tryExt).
        try {
          // OCSF: score the SHAPED output (vendor leftovers folded into `unmapped`,
          // numeric attrs typed) — the same shaping finishBuild appends, so the
          // mapping score grades exactly what ships.
          const dep = ocsfDeployed(extractionFns, c.fns);
          await deployStage([...dep.extractionFns, ...dep.mappingFns, ...ocsfShapingFor(c.fns)]);
          const out = await preview();
          const s = scoreStage('mapping', destFormat, sourcetype, rawEvents, out, out1);
          log(`[mapping] ${c.label}: score ${s.score ?? 'n/a'}`);
          return { source: c.source, fns: c.fns, detail: c.detail, out, score: s.score ?? 0, scoreRaw: s.score, band: s.band, reasons: s.reasons, inputValid: true, measured: true } satisfies ScoredMapping;
        } catch (e) {
          log(`[mapping] ${c.label} FAILED to deploy (${e instanceof Error ? e.message : String(e)}) — skipping.`);
          return { source: c.source, fns: c.fns, detail: c.detail, out: out1, score: 0, scoreRaw: 0, band: 'fail' as const, reasons: [`Candidate rejected by Cribl: ${e instanceof Error ? e.message : String(e)}`], inputValid: true } satisfies ScoredMapping;
        }
      };
      for (const c of mapCandidates) {
        const scored = await tryMap(c);
        if (c.source === 'golden' && scored.measured) await observeReuse(goldenMapFound, 'mapping', scored.scoreRaw, scored.band);
        best2 = betterMapping(best2, scored);
        if (best2?.score >= SATISFIED) break;
      }
      if (!noAi && (best2?.score ?? 0) < SATISFIED && !aiMapTried) {
        const aiC = await buildAiMap(qSettings.normalModel);
        if (aiC) {
          const scored = await tryMap(aiC);
          best2 = betterMapping(best2, scored);
        }
      }
      // Mapping health gate: detect when the AI mapping produced output with mostly
      // empty values (mapped to "" or null) — this means it referenced field names
      // that don't exist in the extraction output. Retry with second model using
      // the real extracted fields (already set in realExtractedFields above).
      if (!noAi && (best2?.score ?? 0) < 30 && best2?.source === 'ai' && extractionProducedFields && realExtractedFields.length > 0) {
        const outSample = best2!.out[0] || {};
        const rawJson = outSample._raw || outSample;
        let emptyRatio = 0;
        try {
          const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
          const vals = Object.values(parsed);
          const emptyCount = vals.filter((v: any) => v === '' || v === null || v === undefined || v === 'unknown').length;
          emptyRatio = vals.length > 0 ? emptyCount / vals.length : 0;
        } catch { /* not JSON */ }
        if (emptyRatio > 0.5) {
          log(`[mapping] ⚠ ${Math.round(emptyRatio * 100)}% of mapped values are empty — field name mismatch detected. Retrying with real extracted fields: ${realExtractedFields.slice(0, 10).join(', ')}…`);
          aiMapTried = false;
          const aiRetry = await buildAiMap(secondModel || qSettings.normalModel);
          if (aiRetry) {
            const scored = await tryMap(aiRetry);
            best2 = betterMapping(best2, scored);
          }
        }
      }
      // Second-model retry: same striking-distance gate as extraction — a second
      // ~30s reasoning call only pays off when the first mapping is within reach
      // of the golden threshold (small gaps close, large ones don't). Best-effort
      // mapping is kept regardless.
      const MAP_RETRY_REACH = 25;
      const mapScore = best2?.score ?? 0;
      if (!noAi && secondModel && mapScore < thr.mapping && mapScore >= thr.mapping - MAP_RETRY_REACH) {
        log(`[mapping] ${mapScore} is within ${MAP_RETRY_REACH} of golden ${thr.mapping} — retrying with second model ${secondModel}…`);
        const aiC2 = await buildAiMap(secondModel);
        if (aiC2) {
          const scored = await tryMap(aiC2);
          best2 = betterMapping(best2, scored);
        }
      }
      if ((best2?.score ?? 0) < SATISFIED && staticMapFns.length) {
        best2 = betterMapping(best2, await tryMap({ source: 'static', label: 'static mapping', fns: staticMapFns, detail: mappingsFromFns(staticMapFns) }));
      }
      if (!best2) best2 = await tryMap({ source: 'static', label: 'static mapping', fns: staticMapFns, detail: mappingsFromFns(staticMapFns) });
      mappingFns = best2!.fns; mapSource = best2!.source; mapDetail = best2!.detail;
      out2 = best2!.out; s2 = { score: best2!.scoreRaw, band: best2!.band, reasons: best2!.reasons };
      // P2: fail-closed on a degenerate schema mapping. Every mapping builder
      // (golden/Copilot/AI/CEF/static) emits at least one real mapped field; a
      // final mapping that carries ONLY the envelope (sourcetype/_time/
      // TimeGenerated) or nothing means the source could not be mapped to this
      // schema and all retries above are exhausted. Shipping it produces a
      // serde-only pack that LOOKS built but only re-serializes _raw (e.g. the
      // deployed CiscoPrime_OCSF). Throw so the batch marks the row failed
      // instead of storing a misleading score. (XSIAM handled separately above;
      // schematizer OCSF/ECS/UDM returns before this block.)
      const ENVELOPE_ONLY = new Set(['sourcetype', '_time', 'TimeGenerated', 'index', 'source', 'host']);
      const producedRealMapping = mappingFns.some((f: any) =>
        Array.isArray(f?.conf?.add) && f.conf.add.some((a: any) => a?.name && !ENVELOPE_ONLY.has(a.name)));
      if (!producedRealMapping) {
        const why = `no source fields could be mapped to ${destFormat} — serde-only output (all mapping candidates empty).`;
        log(`[mapping] ✗ FAIL-CLOSED: ${why}`);
        throw new Error(`Mapping failed: ${why}`);
      }
      // Extraction-health cap: with no extracted source VALUES the mapping can only
      // be filling constant schema-envelope fields, however many "expected fields"
      // its lens saw populated. Cap below the golden threshold so it is never read
      // as a passing mapping (and never stored as golden below).
      //
      // Gated on the measured extraction SCORE, not on `extractionProducedFields`.
      // That flag is a presence test over the output's field names, and a static
      // parser emits constants whether or not one regex matched — which is how five
      // build-435 f5_bigip pipelines passed this cap with extraction measured at 0
      // and shipped a mapping of 90-100. See `capMappingScore`.
      if (!isXsiam) {
        const cap = capMappingScore(s2.score, s1.score, thr.mapping);
        if (cap.capped) s2 = { score: cap.score, band: cap.score! >= 60 ? 'warn' : 'fail', reasons: [cap.reason!, ...s2.reasons] };
      }
      if (mapCandidates[mapCandidates.length - 1]?.fns !== mappingFns) await deployStage([...extractionFns, ...mappingFns]);
    }
    const extractedNames = out1[0] ? Object.keys(out1[0]).filter(k => k !== '_raw') : [];
    const referenced = new Set<string>();
    for (const md of mapDetail) { const src = `${md.from} ${md.expr}`; for (const n of extractedNames) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(src)) referenced.add(n); }
    // Report the fields ACTUALLY carried to the output, not just explicit eval add[].
    // Flat formats (JSON) map by passing every extracted field through with no add[],
    // so mapDetail is empty even though every field reaches the output — which read
    // as "only a few fields mapped". Synthesise a passthrough detail from the real
    // mapping-stage output field names so the report matches what ships.
    let reportDetail = mapDetail;
    if (mapDetail.length === 0 && out2[0]) {
      const carried = Object.keys(out2[0]).filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_'));
      if (carried.length) reportDetail = carried.map(name => ({ from: name, to: name, expr: '(passthrough)' }));
    }
    const mappingStage: StagedStageResult = { stage: 'mapping', source: mapSource, score: s2.score, band: s2.band, reasons: s2.reasons, out: out2, detail: reportDetail };
    emit(mappingStage);
    if (!isXsiam && isSchema && mapSource !== 'golden' && (s2.score ?? 0) >= thr.mapping) {
      if (!extractionPassed) {
        // No silent caps: say exactly why a passing mapping was withheld.
        log(`[mapping] ${s2.score} NOT stored as golden: this build's extraction scored ${s1.score ?? 'n/a'} (< ${thr.extraction}), so the mapping is not proven to carry real source data.`);
      } else {
        ensureLive('storing the verified mapping golden');
        const saved = await saveGoldenPart('mapping', goldenSourcetype, destFormat, mappingFns, s2.score!, null, sampleFp, sampleWire, stageEvidence('mapping', s2.score, s2.band));
        // An injected store that reports nothing (tests) counts as stored.
        const mapStored = !saved || ['create', 'replace', 'observe'].includes(saved.action);
        ensureLive('sharing the verified mapping golden');
        if (mapStored) await publishGoldenPart('mapping', goldenSourcetype, destFormat, mappingFns, s2.score!, thr.mapping, null, sampleFp, sampleWire).catch(() => {});
        log(mapStored
          ? `[mapping] stored as golden (≥${thr.mapping})${shareOn ? ' + offered to the pool' : ''}.`
          : `[mapping] golden not stored: ${saved?.reasons?.join('; ') || saved?.action || 'store unavailable'}.`);
      }
    }
    return { ...mappingStage, fns: mappingFns };
    }

    // ---- STAGE 3: OPTIMIZATION (shared by the normal flow AND the
    // schematizer short-circuit). optimization runs on the given ext+map fns;
    // for the schematizer path, extractionFns = the whole pipeline and
    // mappingFns = [] (its mapping is already inside the pipeline). Assembles and
    // deploys the final pipeline, then scores what it deployed — so the caller
    // gets back both the assembled list and the optimization checkpoint. ----
    async function finishBuild(
      extractionFns: any[],
      mappingFns: any[],
      out2: any[],
      _extractionHealthy?: boolean,
      extractionScore?: number | null,
      mappingScore?: number | null,
    ): Promise<{ finalFns: any[]; optimization: StagedStageResult & { fns: any[] } }> {
      // Legacy sourcetype/raw-field reduction rules are retired. This final
      // stage now performs destination-required output shaping only; OCSF
      // optimization belongs exclusively to the Post-Processing flow.
      let optFns: any[] = []; let optSource: ExpStageResult['source'];
      let compactFns: any[] = [];
      // Names the mapping stage produced (eval add[].name). For CIM this lets the
      // compaction ALLOWLIST the clean CIM model into _raw and drop the verbose
      // vendor-raw fields (srcip/payload/junk keys) — otherwise _raw bloats to
      // 60+ keys (fortigate/zscaler bug) instead of ~20.
      const mappedNames = mappingFns.flatMap((f: any) => (f?.conf?.add || []).map((a: any) => a?.name)).filter(Boolean);
      // Compaction (keep-list → serialize→_raw) MUST run AFTER mapping, else it
      // strips the raw fields the mapping evals read (corelight_conn::cim
      // collapsed to an empty _raw when a stored optimization sub-part replayed
      // its compaction BEFORE mapping). So compaction is ALWAYS recomputed fresh
      // here (with the correct mapped-name allowlist) and appended after mapping;
      // a golden optimization sub-part contributes only its noise-drop prefix.
      const computeCompact = () => {
        const rawAlreadyRebuilt = JSON.stringify(mappingFns).includes('"dstField":"_raw"');
        if (rawAlreadyRebuilt) return [];
        // OCSF output shape is structural: only class attributes at the top
        // level, vendor leftovers in `unmapped` (no packtester pack used it).
        if (/^ocsf(#|$)/.test(destFormat)) return ocsfShapingFor(mappingFns);
        // CIM serialization (fields → _raw JSON → strip top-level) is a STRUCTURAL
        // requirement, not an optional optimization. Without it CIM fields leak as
        // top-level keys alongside _raw — wrong shape for Splunk HEC / tstats.
        // Always run for CIM regardless of the compact_output toggle.
        //
        // A Sentinel native table (CommonSecurityLog or anything resolveSentinelTable
        // knows) is structural for the SAME reason, in the opposite direction: the DCR
        // accepts only the table's own columns, so the shaping step must strip the
        // vendor + canonical intermediates and leave the columns top-level.
        // getCompactOutputFunctions has always had that branch — but this gate only
        // let non-schema formats and CIM reach it, so every Sentinel pack shipped
        // unshaped: original text _raw plus ~25 intermediates alongside the columns
        // (pack `aaaaa`, aws_vpc_flow → AWSVPCFlow).
        const isCimMandatory = isCimFormat(destFormat);
        const isSentinelTableDest = !!resolveSentinelTable(destFormat);
        const shapingIsStructural = isCimMandatory || isSentinelTableDest;
        if ((shapingIsStructural || !isSchema) && (!isSchema || shapingIsStructural)) {
          // CIM: preserve the "keep unmapped source fields in _raw" toggle (default
          // on) so a rebuild doesn't compact away fields the original build kept.
          const keepUnmappedCim = isCimFormat(destFormat) && (rt['cim_keep_unmapped'] ?? true);
          // CIM flat output (default OFF): emit CIM fields as top-level indexed
          // fields instead of serializing them into _raw (Splunk-HEC default).
          const cimFlat = isCimFormat(destFormat) && (rt['cim_flat'] ?? false);
          return getCompactOutputFunctions(sourcetype, destFormat, true, mappedNames, keepUnmappedCim, cimFlat);
        }
        return [];
      };
      if (isNativePass) optSource = 'none';
      else {
        compactFns = computeCompact();
        optSource = compactFns.length ? 'static' : 'none';
      }
      // OCSF "keep original _raw" (compliance, default OFF). The OCSF cleanup
      // drops _raw, so copy it aside before extraction touches anything, let it
      // survive every remove:['*'] keep-list, and land it in the OCSF `raw_data`
      // attribute at the very end. Not part of the golden optimization sub-part —
      // it is a per-build toggle, not learned shaping. raw_data is excluded from
      // value-coverage scoring so carrying the source can't inflate a score.
      const keepRawOcsf = rt['ocsf_keep_raw'] === true && /^ocsf(#|$)/.test(destFormat);
      if (keepRawOcsf) {
        extractionFns = withOriginalRawCopy(extractionFns);
        mappingFns = keepOriginalRawCopy(mappingFns);
      }
      // NG-SIEM: the vendor parser reads the ORIGINAL line, and some parsers
      // rewrite _raw (Windows, Zscaler). Same copy field, restored last instead of
      // landing in raw_data. Always on: it is the destination contract, not a toggle.
      const keepRawNextGen = isNextGenRawFidelityFormat(destFormat);
      if (keepRawNextGen) {
        extractionFns = [nextGenRawSnapshotFunction(), ...keepOriginalRawCopy(extractionFns)];
        mappingFns = keepOriginalRawCopy(mappingFns);
      }
      // Source optimization ("Build pack flow" only, opt-in per card): the
      // per-sourcetype drops/suppression from the Cribl packs. Placed at the
      // HEAD of the optimization slot — after mapping (which adds fields but
      // keeps the parser's, so the filters still see their names) and before
      // compaction strips them. That keeps a re-split (splitPipelineFunctions)
      // order-stable: lookup plumbing lands in mapping, drops in optimization,
      // relative order unchanged. Never for OCSF or native-pass
      // (formatSupportsSourceOptimization). A per-build toggle, not learned
      // shaping, so it is kept out of the golden sub-part.
      const srcOpt = isNativePass
        ? null
        : buildSourceOptimizationFunctions(sourcetype, destFormat, rt, referenceLookups.map((l: any) => l?.file).filter(Boolean));
      const srcOptFns = srcOpt?.functions ?? [];
      if (srcOptFns.length && optSource === 'none') optSource = 'static';
      const deployedStages = ocsfDeployed(extractionFns, mappingFns);
      if (deployedStages.removed.length) log(`[optimization] OCSF: left out ${deployedStages.removed.length} add(s) the output cannot carry (no-op aliases, copies, constants): ${[...new Set(deployedStages.removed)].join(', ')}.`);
      const assemble = (src: any[]) => assemblePipelineFunctions({
        extraction: deployedStages.extractionFns,
        mapping: deployedStages.mappingFns,
        optimization: keepRawOcsf
          ? [...keepOriginalRawCopy([...destinationMetadataFns, ...optFns, ...compactFns]), ORIGINAL_RAW_TO_RAW_DATA]
          : keepRawNextGen
            ? [...keepOriginalRawCopy([...destinationMetadataFns, ...src, ...optFns, ...compactFns]), nextGenRawRestoreFunction()]
            : [...destinationMetadataFns, ...src, ...optFns, ...compactFns],
      });
      const finalFns = assemble(srcOptFns);
      // Scoring stays honest: dropped sample events are neither "lost fields"
      // nor a byte-reduction bonus. When a drop is live, score the pipeline with
      // every source-optimization action off, then deploy the real one and
      // report the drop rate separately. Final deploy is always the real one.
      const srcOptLive = srcOpt ? srcOpt.applied.length > 0 : false;
      let out3: any[];
      let srcOptReason: string | null = null;
      if (srcOptLive) {
        await deployStage(assemble(withSourceOptimizationOff(srcOptFns)));
        out3 = await preview();
        await deployStage(finalFns);
        const kept = (await preview()).length;
        const dropped = Math.max(0, out3.length - kept);
        srcOptReason = `Source optimization (${srcOpt!.applied.map(a => a.label).join(', ')}) dropped ${dropped} of ${out3.length} sample event(s). Not part of the score: it was measured with those rules off.`;
      } else {
        await deployStage(finalFns);
        out3 = await preview();
      }
      // A rule whose fields aren't on the mapped events will never fire — say
      // so rather than let "Optimize" imply it works.
      const seen = new Set<string>(out2.flatMap((e: any) => Object.keys(e || {})));
      const blind = (srcOpt?.appliedRules ?? []).filter(r => !r.reads.some(f => seen.has(f))).map(r => r.label);
      if (blind.length && out2.length) {
        srcOptReason = `${srcOptReason ? `${srcOptReason} ` : ''}Won't fire here (fields not on the mapped events): ${blind.join(', ')}.`;
      }
      if (srcOpt?.skipped.length) {
        srcOptReason = `${srcOptReason ? `${srcOptReason} ` : ''}Left out (lookup not in the pack): ${srcOpt.skipped.join(', ')}.`;
      }
      // Optimization's job is to drop volume WITHOUT losing the fields the mapping
      // was contracted to produce. The verbose vendor-raw intermediates that
      // compaction strips (Corelight uid/id.orig_h…, raw KVP keys) are NOT part
      // of that contract — pass the mapped names so their intentional removal
      // isn't scored as field loss (was making CIM optimization score 0).
      const keptContract = mappedNames.length ? [...mappedNames, '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe'] : undefined;
      // NG SIEM's delivery check does not depend on the parse: score it regardless.
      const upstreamPassed = isNextGenRawFidelityFormat(destFormat) || canScoreOptimization(
        extractionScore,
        mappingScore,
        thr.extraction,
        thr.mapping,
      );
      const s3 = upstreamPassed
        ? scoreStage('optimization', destFormat, sourcetype, rawEvents, out3, out2, keptContract)
        : {
            score: null,
            band: 'na' as const,
            reasons: ['Optimization quality is blocked until extraction and mapping meet their thresholds.'],
          };
      const optimizationStage: StagedStageResult = {
        stage: 'optimization', source: optSource, score: s3.score, band: s3.band,
        reasons: srcOptReason ? [...s3.reasons, srcOptReason] : s3.reasons, out: out3,
        appliedOptimizations: srcOpt?.applied ?? [],
        ...(isNextGenRawFidelityFormat(destFormat) ? { decidesOverall: true } : {}),
      };
      emit(optimizationStage);
      const optGoldenFns = [...optFns, ...compactFns];
      return { finalFns, optimization: { ...optimizationStage, fns: optGoldenFns } };
    }

    // ---- FINALIZE: the completion event + the assembled result ----------------
    // Deliberately the LAST durable transition and deliberately tiny: by the time
    // it runs, the final pipeline is already deployed and every stage is scored,
    // so a resumed finalize must redeploy/re-preview/re-score NOTHING. It only
    // reports — which is also why the ONE completion event per pipeline lives
    // here and not in a stage that a later invocation might re-run.
    function finalizeBuild(finalFns: any[]): StagedBuildResult {
      // Log ONE rich completion event to the Lake dataset — environment, group,
      // pack, pipeline, the 3 stage scores + where each came from, build, user,
      // datetime (all staged flows share this). Server adds user/env/build.
      const ex = stages.find(s => s.stage === 'extraction');
      const mp = stages.find(s => s.stage === 'mapping');
      const op = stages.find(s => s.stage === 'optimization');
      // null (N/A) → logged as null, NOT 0. The dashboard averages on
      // deployment_score (coalesced with score); a 0 for a passthrough that
      // extracted/mapped nothing would tank that average just as a fake 100 would
      // have inflated it. A null row records the build but is excluded from AVG.
      const overall = averageStageScores(ex?.score, mp?.score, op);
      void opts.logScore({
        sourcetype, pack_id: packId, pipeline_id: pipelineId, dest_format: destFormat,
        score: overall, sample_name: sampleName, model_used: '', tokens_input: 0, tokens_output: 0,
        worker_group: group, is_golden_path: ex?.source === 'golden' || mp?.source === 'golden',
        generation_mode: 'staged', findings_count: 0, status: 'success', deploy_message: `3-stage build (${origin})`,
        flow: 'normal', builder: 'staged', build_mode: mode, origin,
        first_score: overall, final_score: overall, deployment_score: overall,
        extraction_score: ex?.score ?? null, mapping_score: mp?.score ?? null, optimization_score: op?.score ?? null,
        extraction_source: ex?.source, mapping_source: mp?.source, optimization_source: op?.source,
        start_time: buildStart, end_time: Math.floor(Date.now() / 1000),
        sample_tier: opts.sampleTier, sample_reason: opts.sampleReason, prepare_ms: opts.prepareMs,
        // The exact store tier + AI-written line count (src/sample-provenance.ts),
        // so a later server-side re-score (/pack-quality-check) can store a golden
        // with honest evidence instead of an unknown provenance it must refuse.
        ...(() => {
          const prov = describeSampleProvenance(sampleEvents, { sampleTier: opts.sampleTier, sourceMode: opts.sampleSourceMode });
          return { sample_store_tier: prov.sampleTier, sample_synthetic_count: prov.syntheticCount };
        })(),
        // Reuse verdict (golden-trust R3) — the FIRST golden this build measured;
        // every one is also written back to its record by observeReuse.
        ...(goldenVerdicts.length ? {
          golden_key: goldenVerdicts[0].key,
          golden_origin: goldenVerdicts.map(v => v.stage).join(','),
          golden_recorded_score: goldenVerdicts[0].recorded,
          golden_observed_score: goldenVerdicts[0].observed,
        } : {}),
        build_ms: Math.max(0, Date.now() - buildStart * 1000),
        ...functionCompositionTelemetry(functionComposition(finalFns)),
        ...ocsfMappingTelemetry(destFormat, sourcetype, rawEvents, mp?.out),
      });

      traceRecorder.complete(finalFns);
      artifact.trace = publishTrace();
      return { finalFns, stages, referenceLookups, trace: artifact.trace };
    }

    // ---- The stage machine ---------------------------------------------------
    // One pass over the four boundaries. A stage already in the artifact (because
    // an earlier invocation checkpointed it) is skipped, never recomputed; a
    // `stopAfter` boundary returns before the next stage does any work.
    const halt = (nextPhase: StagedStopAfter): StagedBuildProgress => {
      artifact.trace = publishTrace();
      return { complete: false, nextPhase, artifact };
    };

    try {
      // A combined schematizer pipeline is one inseparable parse+map+enrich build,
      // so it yields no extraction stage a sibling format could reuse. Recorded in
      // the ARTIFACT, not a local: the invocation that finalizes a background build
      // may not be the one that delegated it.
      if (!artifact.extraction && !artifact.mapping) {
        const combined = await trySchematizerCombined();
        if (combined) {
          artifact.extraction = combined.extraction;
          artifact.mapping = combined.mapping;
          artifact.combinedBuild = true;
        }
      }

      if (!artifact.extraction) artifact.extraction = await runExtractionStage();
      if (stopAfter === 'extraction') return halt('mapping');

      if (!artifact.mapping) artifact.mapping = await runMappingStage(artifact.extraction);
      if (stopAfter === 'mapping') return halt('optimization');

      // The complete path keeps the list finishBuild actually deployed; a resumed
      // finalize re-assembles it from the checkpoint, which is the same list by
      // construction (optimization.fns IS the noise-drop + compaction tail).
      let deployedFinalFns: any[] | null = null;
      if (!artifact.optimization) {
        const optimized = await finishBuild(
          artifact.extraction.fns, artifact.mapping.fns, artifact.mapping.out,
          extractionHasFields(artifact.extraction), artifact.extraction.score, artifact.mapping.score,
        );
        artifact.optimization = optimized.optimization;
        deployedFinalFns = optimized.finalFns;
      }
      if (stopAfter === 'optimization') return halt('finalize');

      const resumedStages = ocsfDeployed(artifact.extraction.fns, artifact.mapping.fns);
      const finalFns = deployedFinalFns ?? assemblePipelineFunctions({
        extraction: resumedStages.extractionFns,
        mapping: resumedStages.mappingFns,
        optimization: [...destinationMetadataFns, ...artifact.optimization.fns],
      });
      const built = finalizeBuild(finalFns);
      // Hand the fully-resolved extraction stage back to the orchestrator so sibling
      // formats in the SAME pack can reuse it (see PreparedExtraction / reuseExtraction).
      // Passthrough/XSIAM add no parser → nothing to reuse, and a combined
      // schematizer build's "extraction" is the WHOLE parse+map+enrich pipeline —
      // reusing that as a sibling's parser would deploy one format's finished
      // pipeline as another's extraction stage. Both say so explicitly with null.
      // When this build itself reused the extraction, pass the same object straight
      // through (idempotent).
      const result: StagedBuildResult = {
        ...built,
        extractionForReuse: (artifact.combinedBuild || isNativePass) ? null : artifact.extraction,
      };
      return wantsProgress ? { complete: true, artifact, result } : result;
    } catch (err) {
      // A build that throws must not leave its trace reading `running` — the
      // batch export and the trace download would show an unfinished build with
      // no cause. A stage-deadline abort is the one exception: the background
      // runner retries that stage from the checkpoint, so the build IS still
      // running.
      if (!isStageAbortError(err instanceof Error ? err.message : err)) {
        traceRecorder.fail(err);
        artifact.trace = publishTrace();
      }
      throw err;
    }
  }
