/**
 * The demo environment deployer (spec R17, Phase 3b): what `handleCreateDemo` in
 * App.tsx did, as one function the screens call — moved, not rewritten. Same steps,
 * same order, same log lines:
 *
 *   1 samples per source          (a failed source is skipped; all failed = throw)
 *   2 main packs, one pipeline per format (OCSF last), extraction reused per class
 *   3 OCSF → post-processing packs, fed by the OCSF pipeline's own preview output
 *   4 datagens: one lane per main-pack format + the OCSF replay
 *   5 Cribl Lake dataset (whiteboard demos) → Lake output
 *   6 the demo route block in its namespace → one commit + deploy
 *
 * React state stays in App.tsx: everything the deploy reads comes in `input`,
 * everything it calls comes in `deps`, progress goes out through `deps.log` and
 * `deps.result`. The optional Search experience (step 7, off in the UI) stays in
 * App and runs on what this returns.
 */
import type { BatchPhase } from './batch-runtime';
import { createAsyncCache } from './batch-runtime';
import { DEMO_EVENTS_PER_SEC, DEMO_LAKE_OUTPUT, DEMO_TERMINATOR_ID, demoNames, ocsfReplayLine, type DemoPlan } from './demo-flow';
import { flowBuildFormat, flowFormatInfo, ppEffectiveFormat, ppOutputLabel, type FlowPpOutput } from './flow-builder';
import { concretizeAsimFormat, concretizeCimFormat, concretizeOcsfFormat, getSampleName, isOcsfScoredFormat, sampleFingerprint } from './pack-builder';
import { averageStageScores } from './pipeline-stages';
import { postProcessSampleEvents } from './postprocess-builder';
import type { DeployedPipelineRef as DeployedPipeline } from './quality-flow';
import type { buildStagedPipeline, PreparedExtraction, resolveParseFunctions } from './staged-build';
import type { DestFormat } from './types';
import type { createDemoDatagen, ensureLakeDataset, ensureLakeOutput, fetchReferenceLookups, logPipelineScore, setMasterRoutes } from './api';

export interface DemoSource {
  sourcetype: string;       // canonical sourcetype
  allowCodeFunctions: boolean;
}

/** One built demo combination, for the live list and the done screen. */
export interface DemoResult {
  sourcetype: string;
  /** Flow format key (main pack pipeline) or `pp:<fmt>` (post-processing pack). */
  format: string;
  kind: 'main' | 'pp';
  label: string;
  status: 'pending' | 'running' | 'success' | 'error';
  phase?: BatchPhase;              // truthful per-combination phase (shared with batch UI)
  score?: number | null;          // null = N/A (e.g. a passthrough raw copy — nothing to score)
  // Per-stage scores from the 3-stage builder (null = N/A, e.g. mapping for JSON).
  stageScores?: { extraction: number | null; mapping: number | null; optimization: number | null };
  packId?: string;
  pipelineId?: string;
  message?: string;
}

export interface DemoDeployInput {
  group: string;
  plan: DemoPlan;
  sources: DemoSource[];
  /** The demo's Cribl Lake dataset (routes to DEMO_LAKE_OUTPUT go there); `create` = a whiteboard's new dataset. */
  lake: { datasetId: string; create?: { retentionPeriodInDays: number } } | null;
  reductionToggles: Record<string, boolean>;
  thresholds: { extraction: number; mapping: number; optimization: number };
  shareOn: boolean;
  normalModel?: string;
}

type PostProcessResult = { packId?: string; pipelineId?: string; optimize?: boolean; error?: string };

export interface DemoDeployDeps {
  api: {
    ensureLakeDataset: typeof ensureLakeDataset;
    ensureLakeOutput: typeof ensureLakeOutput;
    createDemoDatagen: typeof createDemoDatagen;
    setMasterRoutes: typeof setMasterRoutes;
    fetchReferenceLookups: typeof fetchReferenceLookups;
  };
  buildStagedPipeline: typeof buildStagedPipeline;
  resolveParseFunctions: typeof resolveParseFunctions;
  /** A real reference sample, else AI-generated (App's resolveDemoSampleEvents). */
  resolveSample(sourcetype: string, log: (m: string) => void): Promise<string>;
  /** The OCSF pipeline's live preview output (App's upstreamOcsfOutputEvents). */
  upstreamOcsfOutputEvents(upstream: DeployedPipeline, log: (m: string) => void): Promise<Record<string, unknown>[]>;
  buildPostProcessPacks(
    outputs: FlowPpOutput[], group: string, log: (m: string) => void,
    onProgress: (i: number, p: { state?: string; error?: string }) => void,
    over: { sourcetype: string; upstreamEvents: Record<string, unknown>[]; packIdFor: (o: FlowPpOutput) => string; displayNameFor: (o: FlowPpOutput) => string },
  ): Promise<PostProcessResult[]>;
  /** Route filter clean-up the master table needs (App's sanitizeFilter). */
  sanitizeFilter(filter: string): string;
  logScore: typeof logPipelineScore;
  log(line: string): void;
  /** The whole result list after every change (the screen re-renders from it). */
  results(rows: DemoResult[]): void;
  /** 'iframe' | 'standalone' — only for the no-sample hint wording. */
  runMode: string;
}

export interface DemoDeploySummary {
  results: DemoResult[];
  datagenIds: string[];
  routeCount: number;
  lakeOutputId: string | null;
  replay: boolean;
  /** Per source, the sample events the demo sends (the Search step reuses them). */
  eventsBySource: Record<string, string>;
  /** Per source, the built pipeline whose route sends to the Cribl Lake dataset (the dashboard reads its output). */
  lakeFeeds: Record<string, DeployedPipeline>;
  /** The deploy's own caches, so the optional Search step reuses exactly what the build prepared. */
  resolveSourceSample(sourcetype: string, log: (m: string) => void): Promise<string>;
  resolveSourceExtraction(sourcetype: string, sampleEvents: string, log: (m: string) => void): Promise<PreparedSource>;
}

export interface PreparedSource {
  aiParseFns: Awaited<ReturnType<typeof resolveParseFunctions>>['aiParseFns'];
  parsedFieldNames: string[];
  referenceLookups: Awaited<ReturnType<typeof fetchReferenceLookups>>;
}

export async function runDemoDeploy(input: DemoDeployInput, deps: DemoDeployDeps): Promise<DemoDeploySummary> {
  const { group, plan, sources } = input;
  const dlog = deps.log;
  const names = demoNames(plan.ns);
  const fmtLabel = (fmt: string) => flowFormatInfo(fmt).label;

  // Seed the result list up-front so every pipeline and post pack shows a live phase.
  const results: DemoResult[] = [
    ...plan.packs.flatMap(pk => pk.pipelines.map(pl => ({
      sourcetype: pk.sourcetype, format: pl.fmt, kind: 'main' as const,
      label: pl.fmt === 'ocsf' && !plan.routes.some(r => r.sourcetype === pk.sourcetype && r.kind === 'main' && r.target === 'ocsf') ? `${fmtLabel('ocsf')} (feeds post-processing)` : fmtLabel(pl.fmt),
      status: 'pending' as const, phase: 'queued' as BatchPhase,
    }))),
    ...plan.ppPacks.map(pp => ({
      sourcetype: pp.sourcetype, format: pp.target, kind: 'pp' as const,
      label: `OCSF → ${ppOutputLabel(pp.output)}`, status: 'pending' as const, phase: 'queued' as BatchPhase,
    })),
  ];
  const idxOf = (st: string, fmt: string) => results.findIndex(r => r.sourcetype === st && r.format === fmt);
  const patchResult = (i: number, patch: Partial<DemoResult>) => {
    if (i < 0) return;
    results[i] = { ...results[i], ...patch };
    deps.results([...results]);
  };
  deps.results([...results]);

  // Sample choice and extraction preparation are separate sealed stages.
  // Resolve the sample first so format/schema decisions cannot trigger parser
  // generation; resolve extraction later and cache it once per source sample.
  const sampleCache = createAsyncCache<string, string>();
  const extractionPrepCache = createAsyncCache<string, PreparedSource>();
  const resolveSourceSample = (sourcetype: string, log: (m: string) => void) => {
    const cached = sampleCache.getOrCreate(sourcetype, () => deps.resolveSample(sourcetype, log));
    if (cached.reused) log(`Reusing resolved ${sourcetype} sample.`);
    return cached.value;
  };
  const resolveSourceExtraction = (sourcetype: string, sampleEvents: string, log: (m: string) => void) => {
    const cacheKey = `${sourcetype}::${JSON.stringify(sampleFingerprint(sampleEvents))}`;
    const cached = extractionPrepCache.getOrCreate(cacheKey, async () => {
      const [parseResult, referenceLookups] = await Promise.all([
        deps.resolveParseFunctions({ sourcetype, sampleEvents, log, model: input.normalModel }),
        deps.api.fetchReferenceLookups(sourcetype).catch(() => []),
      ]);
      return { aiParseFns: parseResult.aiParseFns, parsedFieldNames: parseResult.parsedFieldNames, referenceLookups };
    });
    if (cached.reused) log(`Reusing prepared ${sourcetype} extraction and lookups.`);
    return cached.value;
  };

  // 1. Resolve sample events per source (via the cache — shared with the pack
  //    builds below so each source is prepared exactly once).
  dlog(`Preparing ${sources.length} source(s)…`);
  const eventsBySource: Record<string, string> = {};
  const sampleFailures: Record<string, string> = {};
  for (const src of sources) {
    dlog(`• ${src.sourcetype}`);
    results.forEach((r, k) => { if (r.sourcetype === src.sourcetype) patchResult(k, { status: 'running', phase: 'preparing', message: 'Preparing source data…' }); });
    try {
      eventsBySource[src.sourcetype] = await resolveSourceSample(src.sourcetype, dlog);
    } catch (e) {
      eventsBySource[src.sourcetype] = '';
      sampleFailures[src.sourcetype] = e instanceof Error ? e.message : 'unknown error';
    }
  }
  if (!sources.some(src => eventsBySource[src.sourcetype])) {
    // Name the real reason per source. Tailscale is a standalone concept — in
    // the iframe the model is called from the browser, so pointing there sent
    // people to check a VPN that has nothing to do with the failure.
    const failed = sources.map(src => `${src.sourcetype}: ${sampleFailures[src.sourcetype] || 'no sample available'}`);
    const hint = deps.runMode === 'iframe'
      ? 'AI runs in your browser here — check the API key and model in Settings.'
      : 'Check AI/Tailscale connectivity and retry.';
    throw new Error(`Could not obtain sample events for any source. ${failed.join('; ')}. ${hint}`);
  }

  // 2. Main packs — one per source, one pipeline per format (OCSF last), the
  //    Build pack flow loop: first pipeline creates the pack, the rest are
  //    added; extraction is reused per class. Each pipeline's route inside the
  //    pack is its lane filter, so the master route picks the pipeline by input.
  const built = new Set<string>();                       // `${st}::${fmt}`
  const deployedBy = new Map<string, DeployedPipeline>(); // same key
  const ocsfBySource = new Map<string, DeployedPipeline>();
  const scoresOf = (stages: { stage: string; score: number | null }[]) => {
    const at = (k: string) => stages.find(x => x.stage === k)?.score ?? null;
    return { extraction: at('extraction'), mapping: at('mapping'), optimization: at('optimization') };
  };
  for (const pk of plan.packs) {
    const st = pk.sourcetype;
    const src = sources.find(x => x.sourcetype === st);
    const sampleEvents = eventsBySource[st];
    if (!sampleEvents) {
      const why = `No sample: ${sampleFailures[st] || 'none available'}`;
      results.forEach((r, k) => { if (r.sourcetype === st) patchResult(k, { status: 'error', phase: 'done', message: why }); });
      dlog(`  ✗ [${st}] ${why} — nothing built for this source.`);
      continue;
    }
    const prep = await resolveSourceExtraction(st, sampleEvents, dlog);
    const packageJson = {
      version: '1.0.0', author: 'Cribl Pack Generator (demo)', tags: { streamtags: [] }, exports: [],
      displayName: `[DEMO] ${st}`, name: pk.packId,
      description: `[DEMO] ${st} to ${pk.pipelines.map(pl => fmtLabel(pl.fmt)).join(', ')} — one pipeline per format, picked by the demo lane datagen.`,
    };
    const extractionByClass = new Map<'mapped' | 'raw', PreparedExtraction>();
    const extractionClassOf = (f: string): 'mapped' | 'raw' =>
      ['json', 'manual', 'raw', 'raw_fields', 'passthrough', 'splunk_csv', ''].includes(flowBuildFormat(f)) ? 'raw' : 'mapped';
    let firstBuilt = false;
    dlog(`[${st}] Building pack ${pk.packId} (${pk.pipelines.length} pipeline${pk.pipelines.length > 1 ? 's' : ''})…`);
    for (const pl of pk.pipelines) {
      const ri = idxOf(st, pl.fmt);
      // The demo has no per-format table / model / class picker: resolve each
      // Flow key to the concrete golden-keyed format from this source's sample
      // ('sentinel' → commonsecuritylog, asim/cim/ocsf → the sample's class).
      let buildFmt = flowBuildFormat(pl.fmt);
      if (buildFmt === 'sentinel') buildFmt = 'commonsecuritylog';
      buildFmt = concretizeAsimFormat(buildFmt as DestFormat, st, sampleEvents);
      buildFmt = concretizeCimFormat(buildFmt as DestFormat, st, sampleEvents);
      buildFmt = concretizeOcsfFormat(buildFmt as DestFormat, st, sampleEvents);
      if (buildFmt !== flowBuildFormat(pl.fmt)) dlog(`  [${st}] ${fmtLabel(pl.fmt)} → ${buildFmt} (concrete golden format).`);
      patchResult(ri, { status: 'running', phase: 'building', message: `Building ${pl.pipelineId} (3-stage)…` });
      try {
        const out = await deps.buildStagedPipeline({
          sourcetype: st, destFormat: buildFmt, sampleEvents, group, packId: pk.packId, pipelineId: pl.pipelineId,
          packageJson, reductionToggles: input.reductionToggles, thresholds: input.thresholds, shareOn: input.shareOn,
          origin: 'demo', mode: firstBuilt ? 'add-pipeline' : 'new', uploadSample: !firstBuilt,
          routeFilter: pl.routeFilter, destinationKey: pl.fmt,
          preparedExtraction: extractionByClass.get(extractionClassOf(pl.fmt)) ?? null,
          allFormats: pk.pipelines.map(x => x.fmt),
          allowCode: src?.allowCodeFunctions, log: dlog, logScore: deps.logScore,
          preparedParseFns: prep.aiParseFns?.functions,
          onStage: (r) => patchResult(ri, { phase: r.stage === 'optimization' ? 'scoring' : 'building', message: `${r.stage}: ${r.score ?? 'n/a'}` }),
        });
        if (!out) {
          patchResult(ri, { status: 'error', phase: 'done', message: 'No sample events — nothing built.' });
          dlog(`  ⚠ [${st} to ${fmtLabel(pl.fmt)}] no sample — skipped.`);
          continue;
        }
        firstBuilt = true;
        built.add(`${st}::${pl.fmt}`);
        deployedBy.set(`${st}::${pl.fmt}`, { pipelineId: pl.pipelineId, destFormat: buildFmt, sourcetype: st, packId: pk.packId, workerGroup: group, sampleName: getSampleName(st) });
        if (out.extractionForReuse && !extractionByClass.has(out.extractionForReuse.extractionClass)) {
          extractionByClass.set(out.extractionForReuse.extractionClass, out.extractionForReuse);
        }
        if (isOcsfScoredFormat(buildFmt)) {  // NG SIEM ships raw, never OCSF to post-process
          ocsfBySource.set(st, { pipelineId: pl.pipelineId, destFormat: buildFmt, sourcetype: st, packId: pk.packId, workerGroup: group, sampleName: getSampleName(st) });
        }
        const stageScores = scoresOf(out.stages);
        // null (N/A) when there is nothing to score — e.g. a passthrough raw
        // copy. Never coerce that to 0: a 0 reads as a failed build.
        // NG SIEM: the optimization stage grades what the destination receives
        // (raw fidelity) and decides the overall — see averageStageScores.
        const score = averageStageScores(stageScores.extraction, stageScores.mapping, out.stages.find(x => x.stage === 'optimization'));
        patchResult(ri, { status: 'success', phase: 'done', score, stageScores, packId: pk.packId, pipelineId: pl.pipelineId, message: `score ${score ?? 'N/A'}` });
        dlog(`✓ [${st} to ${fmtLabel(pl.fmt)}] ${pl.pipelineId} — extraction ${stageScores.extraction ?? 'n/a'} · mapping ${stageScores.mapping ?? 'n/a'} · output shaping ${stageScores.optimization ?? 'n/a'}.`);
      } catch (err) {
        patchResult(ri, { status: 'error', phase: 'done', message: err instanceof Error ? err.message : 'build failed' });
        dlog(`  ✗ [${st} to ${fmtLabel(pl.fmt)}] ${err instanceof Error ? err.message : 'failed'} (no route written).`);
      }
    }
  }

  // 3. OCSF → post-processing. The post packs' sample AND the replay feed are
  //    the OCSF pipeline's own preview output, so the replay datagen sends
  //    exactly what the live chain would deliver (the curated OCSF set only
  //    when that preview returns nothing).
  const ppOk = new Set<string>();                        // `${st}::${target}`
  const replaySources: { sourcetype: string; events: string[] }[] = [];
  for (const st of [...new Set(plan.ppPacks.map(pp => pp.sourcetype))]) {
    const mine = plan.ppPacks.filter(pp => pp.sourcetype === st);
    const upstream = ocsfBySource.get(st);
    if (!upstream) {
      mine.forEach(pp => patchResult(idxOf(st, pp.target), { status: 'error', phase: 'done', message: 'Skipped: the OCSF pipeline was not built' }));
      dlog(`⚠ [${st}] OCSF pipeline was not built — skipping its post-processing packs (they read its output).`);
      continue;
    }
    const upstreamEvents = await deps.upstreamOcsfOutputEvents(upstream, dlog);
    if (plan.replaySourcetypes.includes(st)) {
      const recorded = upstreamEvents.length
        ? upstreamEvents
        : postProcessSampleEvents('ocsf').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Record<string, unknown>[];
      if (recorded.length) replaySources.push({ sourcetype: st, events: recorded.map(ocsfReplayLine) });
    }
    const ppResults = await deps.buildPostProcessPacks(
      mine.map(pp => pp.output), group, dlog,
      (i, p) => {
        const status = p.state === 'running' ? 'running' : p.state === 'error' ? 'error' : p.state === 'done' ? 'success' : null;
        if (status) patchResult(idxOf(st, mine[i].target), { status, phase: status === 'running' ? 'building' : 'done', ...(p.error ? { message: p.error } : {}) });
      },
      {
        sourcetype: st, upstreamEvents,
        packIdFor: o => names.ppPackId(st, ppEffectiveFormat(o)),
        displayNameFor: o => `[DEMO] ${st} OCSF to ${ppOutputLabel(o)}`,
      },
    );
    ppResults.forEach((r, i) => {
      if (r.error) return;
      ppOk.add(`${st}::${mine[i].target}`);
      patchResult(idxOf(st, mine[i].target), { packId: r.packId, pipelineId: r.pipelineId, message: r.optimize ? 'optimized by category' : 'full copy' });
    });
  }

  // 4. Datagens: one lane per main-pack format (only sources whose pipeline
  //    was built), plus the OCSF replay. Inactive until the deploy below.
  const datagenIds: string[] = [];
  for (const lane of plan.lanes) {
    const members = lane.sourcetypes.filter(st => built.has(`${st}::${lane.fmt}`) && eventsBySource[st]);
    if (!members.length) continue;
    const dg = await deps.api.createDemoDatagen(group, members.map(st => ({ sourcetype: st, events: eventsBySource[st].split('\n').filter(Boolean) })), { datagenId: lane.id, eventsPerSec: DEMO_EVENTS_PER_SEC });
    datagenIds.push(dg.datagenId);
    dlog(`✓ Lane datagen "${dg.datagenId}" (${fmtLabel(lane.fmt)}): ${members.join(', ')} at ${DEMO_EVENTS_PER_SEC} ev/s each.`);
  }
  const replayed = replaySources.filter(r => plan.ppPacks.some(pp => pp.sourcetype === r.sourcetype && ppOk.has(`${r.sourcetype}::${pp.target}`)));
  if (replayed.length) {
    const dg = await deps.api.createDemoDatagen(group, replayed, { datagenId: plan.replayId, eventsPerSec: DEMO_EVENTS_PER_SEC });
    datagenIds.push(dg.datagenId);
    dlog(`✓ OCSF replay datagen "${dg.datagenId}": ${replayed.map(r => `${r.sourcetype} (${r.events.length} recorded event${r.events.length === 1 ? '' : 's'})`).join(', ')}.`);
  }
  if (!datagenIds.length) throw new Error('Nothing was built — no datagen or route was created. See the log above.');

  // 5. "Cribl Lake" outputs resolve to the demo dataset's cribl_lake output.
  let lakeOutputId: string | null = null;
  if (plan.routes.some(r => r.output === DEMO_LAKE_OUTPUT) && input.lake) {
    const { datasetId, create } = input.lake;
    if (create) {
      dlog(`Ensuring Cribl Lake dataset "${datasetId}" (${create.retentionPeriodInDays} days)…`);
      const ds = await deps.api.ensureLakeDataset(datasetId, create.retentionPeriodInDays);
      dlog(ds.created ? `✓ Lake dataset ${ds.id} created` : `✓ Lake dataset ${ds.id} already exists — reused, not changed`);
    }
    dlog(`Ensuring Cribl Lake output → dataset "${datasetId}"…`);
    lakeOutputId = await deps.api.ensureLakeOutput(group, datasetId);
    dlog(`✓ Lake output: ${lakeOutputId}`);
  }

  // 6. The demo route block, one commented group per source, then the
  //    terminator. Cribl keys each comment by its position in the COMBINED
  //    comments+routes list — addComment() computes that index.
  const demoRouteBlock: any[] = [];
  const demoComments: { comment: string; index: number }[] = [];
  const addComment = (comment: string) => demoComments.push({ comment, index: demoRouteBlock.length + demoComments.length });
  const live = plan.routes.filter(r => r.kind === 'pp' ? ppOk.has(`${r.sourcetype}::${r.target}`) : built.has(`${r.sourcetype}::${r.target}`));
  for (const src of sources) {
    const mine = live.filter(r => r.sourcetype === src.sourcetype);
    if (!mine.length) continue;
    const outs = [...new Set(mine.map(r => (r.output === DEMO_LAKE_OUTPUT ? 'Cribl Lake' : r.output)))];
    addComment(names.comment(`${src.sourcetype} — ${mine.map(r => r.name.replace(`[DEMO] ${src.sourcetype} `, '')).join(', ')}; sends to ${outs.join(' / ')}`));
    for (const r of mine) {
      const output = r.output === DEMO_LAKE_OUTPUT ? lakeOutputId : r.output;
      demoRouteBlock.push({
        id: r.id, name: r.name, filter: deps.sanitizeFilter(r.filter), pipeline: r.pipeline, output,
        final: false, disabled: false,
        description: `[DEMO] ${r.name.replace('[DEMO] ', '')}; sends to ${output}`,
        clones: [], enableOutputExpression: false,
      });
    }
  }
  addComment(names.comment('Terminator — drop all demo data so it never reaches the production routes below'));
  demoRouteBlock.push({
    id: DEMO_TERMINATOR_ID,
    name: '[DEMO] terminator - drop demo data',
    filter: plan.terminatorFilter,
    pipeline: 'devnull', output: 'devnull',
    final: true, disabled: false,
    description: '[DEMO] Final catch-all so demo events never reach production routes.',
    clones: [], enableOutputExpression: false,
  });

  // 6b. Write the demo block in its namespace on TOP of the master table — the
  //     one commit + deploy that makes the packs, datagens and routes live together.
  dlog(`Writing ${demoRouteBlock.length} demo route(s) + ${demoComments.length} comment(s) on top of the master routing table…`);
  const routeResult = await deps.api.setMasterRoutes(group, demoRouteBlock, demoComments, plan.ns);
  dlog(`✓ Routing table updated (${routeResult.demoCount} demo of ${routeResult.routeCount} total). Committed ${routeResult.commit}.`);

  const lakeFeeds: Record<string, DeployedPipeline> = {};
  for (const r of live) {
    const feed = r.kind !== 'pp' && r.output === DEMO_LAKE_OUTPUT && lakeOutputId ? deployedBy.get(`${r.sourcetype}::${r.target}`) : undefined;
    if (feed && !lakeFeeds[r.sourcetype]) lakeFeeds[r.sourcetype] = feed;
  }

  return {
    results: [...results], datagenIds, routeCount: routeResult.demoCount, lakeOutputId,
    replay: plan.ppPacks.length > 0, eventsBySource, lakeFeeds, resolveSourceSample, resolveSourceExtraction,
  };
}
