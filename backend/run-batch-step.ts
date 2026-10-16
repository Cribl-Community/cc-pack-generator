/**
 * "Batch — Background" Backend Function — the scheduled stage runner.
 *
 * This file is WIRING. Every decision about what happens next lives in the pure
 * `backend/background-runner.ts`; here we parse the request, build the real
 * dependencies (App KV, the shared staged builder, commit/deploy, Backend
 * Schedules) and turn a runner status into an HTTP status.
 *
 * Two modes, distinguished by the body:
 *
 * - `{ action: 'kickoff', runId }` — the browser's start call. Validates the
 *   run, makes sure its one-minute schedule exists, marks it running and
 *   returns 202. It does NO build work: the iframe's fetch bridge cancels any
 *   proxied request that has not answered in 30 seconds (Hard Rule 21), so a
 *   kickoff that built anything would be cancelled mid-write.
 * - `{ runId, scheduledFor? }` — a scheduled tick. Runs at most ONE durable
 *   stage of ONE row and checkpoints it.
 *
 * Why the AI settings are re-installed on every tick: a Backend Function is a
 * fresh process with no browser storage, so the run's own snapshot (non-secret
 * provider/model only — credentials stay in the platform's proxy injection) is
 * what makes extraction/mapping AI available at all.
 *
 * Bundling notes that are load-bearing (verified against a real org, build
 * 722-723): Cribl's sandbox has its own restricted module loader, so this graph
 * is bundled with esbuild's `platform: 'browser'` (scripts/pkgutil.mjs) — every
 * file under `src/` was already written to run in a browser sandbox. And all
 * Cribl API calls use relative `/api/v1/...` (Hard Rule 17): a Backend Function
 * has no Vite middleware, so the local dev proxy routes do not exist here.
 */
import {
  runBackgroundKickoff,
  runBackgroundTick,
  sanitizeRunnerMessage,
  type BackgroundRunnerDeps,
  type QualityStageOutcome,
  type QualityStageRequest,
  type SampleStageOutcome,
  type SampleStageRequest,
  type StageOutcome,
  type StageRequest,
} from './background-runner';
import { backgroundBatchStore } from '../src/background-batch-store';
import { backgroundScheduleId, type BackgroundAiSnapshot } from '../src/background-batch';
import { aiSamples, backgroundBatchSchedulePayload, commitDeploy, criblQualityOperations, getApiBase, logPipelineScore } from '../src/api';
import {
  DEFAULT_QUALITY_THRESHOLD, runQualityTransition, type QualityPipelineRef,
} from '../src/quality-stage';
import { buildStagedPipeline, type StagedBuildOptions, type StagedContinuation } from '../src/staged-build';
import { toKebab } from '../src/pack-builder';
import { installBackendAiSnapshot, loadQualitySettingsAsync, type QualitySettings } from '../src/settings-store';
import {
  aiTimeoutsObserved, isProxyTimeout, isStageAbortError, setBackendStageSignal,
  BACKEND_STAGE_ABORT_GRACE_MS, BACKEND_STAGE_DEADLINE_MS, sampleGenerationAttemptModes,
} from '../src/ai-budget';
import { GENERATED_SAMPLE_COUNT } from '../src/sample-library';
import type { PreparedExtraction, StagedBuildArtifact, StagedStopAfter } from '../src/staged-build';

// --- schedules ---------------------------------------------------------------

async function createSchedule(runId: string): Promise<string> {
  const payload = backgroundBatchSchedulePayload(runId);
  const response = await fetch(`${getApiBase()}/backend-schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Background schedule create failed (${response.status}).`);
  return payload.id;
}

async function removeSchedule(scheduleId: string | undefined): Promise<void> {
  if (!scheduleId) return;
  const response = await fetch(`${getApiBase()}/backend-schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Background schedule delete failed (${response.status}).`);
  }
}

// --- the stage adapter -------------------------------------------------------

let installedSnapshot: string | null = null;

async function ensureAiSnapshot(snapshot: BackgroundAiSnapshot | undefined): Promise<void> {
  if (!snapshot) return;
  const fingerprint = `${snapshot.provider}:${snapshot.model}:${snapshot.normalModel}:${snapshot.repairModel}`;
  if (installedSnapshot === fingerprint) return;
  await installBackendAiSnapshot(snapshot);
  installedSnapshot = fingerprint;
}

function thresholdsFrom(q: QualitySettings) {
  return {
    extraction: q.expExtractionThreshold ?? 80,
    mapping: q.expMappingThreshold ?? 80,
    optimization: q.expOptimizationThreshold ?? 80,
  };
}

/**
 * The staged-builder options for one row. Pure and exported so the option
 * contract — one sample per sourcetype, the row's own conflict mode, AI ENABLED
 * (extraction and mapping may use it; sample creation is its own stage) —
 * is asserted directly rather than inferred from a build.
 */
export function stageBuildOptions(
  request: StageRequest,
  quality: QualitySettings,
): StagedBuildOptions & StagedContinuation {
  const { row, checkpoint } = request;
  // The runner already resolved the identity (with the same `toKebab` this
  // module injects) and used it to decide new-vs-add-pipeline. Deriving it a
  // second time here is how the two decisions drift apart.
  const packId = request.packId;
  return {
    sourcetype: row.sourcetype,
    outputSourcetype: row.outputSourcetype,
    destFormat: row.destFormat,
    // From the row's artifact (see StageRequest) — the manifest carries no
    // customer event text.
    sampleEvents: request.sampleEvents,
    // Provenance, from the same artifact: these become `sample_tier` and
    // `prepare_ms` on the score event. Spread conditionally so an unrecorded
    // tier stays unrecorded instead of being logged as an empty string.
    ...(request.sampleTier ? { sampleTier: request.sampleTier } : {}),
    ...(request.prepareMs != null ? { prepareMs: request.prepareMs } : {}),
    // The row's own CSV sample is the user's data: the builder's privacy gate
    // needs to know, exactly as the foreground build tells it.
    ...(request.sampleSourceMode ? { sampleSourceMode: request.sampleSourceMode } : {}),
    ...(request.sampleSanitised ? { sampleSanitised: true } : {}),
    group: checkpoint.workerGroup,
    packId,
    pipelineId: row.pipelineId,
    packageJson: {
      version: '1.0.0',
      author: 'Cribl Pack Generator (batch — background)',
      tags: { streamtags: [] },
      exports: [],
      displayName: row.packName,
      name: packId,
      description: `${row.sourcetype} to ${row.destFormat.toUpperCase()} (3-stage, background).`,
    },
    reductionToggles: { drop_noise: false, remove_null_fields: true, compact_output: false, field_cleanup: true },
    thresholds: thresholdsFrom(quality),
    shareOn: false,
    mode: request.mode,
    uploadSample: request.uploadSample,
    preparedExtraction: request.preparedExtraction,
    origin: 'batch',
    cimModel: row.cimModel,
    // The operator's own CSV filter. Omitted when the row has none, so the
    // builder applies its `sourcetype=='<st>'` default rather than an empty
    // filter that would match everything.
    ...(row.routeFilter ? { routeFilter: row.routeFilter } : {}),
    stopAfter: request.stopAfter,
    resume: request.resume,
    logScore: logPipelineScore,
    log: () => {},
  };
}

/** Did the stage actually produce the thing this boundary exists to produce? */
function stageProducedResult(artifact: StagedBuildArtifact | undefined, stopAfter: StagedStopAfter): boolean {
  if (!artifact) return false;
  if (stopAfter === 'extraction') return !!artifact.extraction;
  if (stopAfter === 'mapping') return !!artifact.mapping;
  if (stopAfter === 'optimization') return !!artifact.optimization;
  return !!artifact.extraction && !!artifact.mapping;
}

interface StageObservation {
  progress?: { complete: boolean; artifact: StagedBuildArtifact; result?: { extractionForReuse?: unknown } } | null;
  error?: unknown;
  /** Provider requests that timed out DURING this stage (src/ai-budget.ts). */
  aiTimeouts: number;
  stopAfter: StagedStopAfter;
}

/**
 * What one stage attempt means. Pure, and exported so the classification is
 * tested directly rather than inferred from a real build.
 *
 * The distinction that matters is "the model never answered" vs "it answered
 * badly", and it cannot be read from the return value alone: `buildStagedPipeline`
 * CATCHES its own AI failures by design, so a timed-out `aiParse` degrades to a
 * deterministic candidate and the builder returns normally. That is why the
 * timeout branch used to be unreachable outside a fake.
 *
 * So a timeout is either (a) one that propagated out, or (b) an AI request
 * that timed out during the stage AND left this boundary with nothing to
 * checkpoint. A stage that still produced its result keeps it — a degraded but
 * real result is a result, and discarding it would throw away work and retry
 * into the same wall.
 */
export function classifyStageOutcome(observation: StageObservation): StageOutcome {
  const { error, progress, aiTimeouts, stopAfter } = observation;

  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A stage that hit its deadline ran out of INVOCATION, not out of options:
    // the row is retried from its last checkpoint, not blamed.
    if (isStageAbortError(message) || isProxyTimeout(message) || aiTimeouts > 0) {
      return { kind: 'timeout', message };
    }
    return { kind: 'error', message };
  }

  if (!progress) return { kind: 'error', message: 'No sample events — nothing to build.' };

  const { artifact } = progress;
  if (aiTimeouts > 0 && !stageProducedResult(artifact, stopAfter)) {
    return { kind: 'timeout', message: `AI request timed out and the ${stopAfter} stage produced nothing.` };
  }

  return {
    kind: 'stage',
    artifact,
    complete: progress.complete,
    scores: {
      extraction: artifact.extraction?.score ?? null,
      mapping: artifact.mapping?.score ?? null,
      optimization: artifact.optimization?.score ?? null,
    },
    extractionForReuse: (progress.result?.extractionForReuse ?? null) as PreparedExtraction | null,
    // The builder deploys (deferred) the candidates it scores, so an attempted
    // stage always leaves config to commit.
    wroteConfig: true,
  };
}

export interface StageDeadlineOutcome<T> {
  value?: T;
  error?: unknown;
  /** The deadline fired. */
  aborted: boolean;
  /**
   * The work SETTLED — so nothing from this stage is still running. False means
   * the abort did not reach it, and the caller must behave as if the build is
   * still deploying: no commit, and above all no lease release.
   */
  unwound: boolean;
}

/**
 * Run work under the stage deadline, as an ABORT rather than a race.
 *
 * The deadline aborts a signal the work itself is holding: the staged builder
 * checks it before every deploy/patch and the AI transport aborts the request
 * in flight. So the normal path is "the stage stops and unwinds, and we await
 * it" — not "we stop waiting while it keeps deploying".
 *
 * The grace wait after the abort is the ONE exception, and it is deliberately
 * not treated as a result: some hang inside a Cribl API call has no signal to
 * receive, and the honest report is `unwound: false` — which the runner turns
 * into "keep the lease, commit nothing" (Hard Rule 32: a measurement that
 * failed must not look like one that succeeded).
 */
export async function runUnderStageDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  { deadlineMs = BACKEND_STAGE_DEADLINE_MS, graceMs = BACKEND_STAGE_ABORT_GRACE_MS } = {},
): Promise<StageDeadlineOutcome<T>> {
  const controller = new AbortController();
  let aborted = false;
  const deadline = setTimeout(() => { aborted = true; controller.abort(); }, deadlineMs);

  // Settled either way, so the emergency wait below can never leave an
  // unhandled rejection behind.
  const work = start(controller.signal).then(
    (value: T) => ({ value }),
    (error: unknown) => ({ error }),
  );
  // Starts counting only once the abort has fired.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<'still-alive'>(resolve => {
    controller.signal.addEventListener('abort', () => {
      graceTimer = setTimeout(() => resolve('still-alive'), graceMs);
    }, { once: true });
  });

  try {
    const settled = await Promise.race([work, grace]);
    if (settled === 'still-alive') return { aborted: true, unwound: false };
    return { ...settled, aborted, unwound: true };
  } finally {
    clearTimeout(deadline);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

/**
 * Run one stage under the deadline, with the signal threaded into BOTH places
 * that can otherwise outlive it: the staged builder (deploy/patch checks) and
 * the AI transport (registered for the duration of this stage only).
 */
async function runStage(request: StageRequest): Promise<StageOutcome> {
  await ensureAiSnapshot(request.checkpoint.ai);
  const quality = await loadQualitySettingsAsync();
  const timeoutsBefore = aiTimeoutsObserved();

  const outcome = await runUnderStageDeadline(async signal => {
    setBackendStageSignal(signal);
    try {
      return await buildStagedPipeline({ ...stageBuildOptions(request, quality), signal });
    } finally {
      setBackendStageSignal(null);
    }
  });

  if (outcome.aborted && !outcome.unwound) {
    // The signal could not reach whatever this stage is doing. Say so: the
    // runner keeps the lease until it expires rather than letting a second
    // invocation build the same row alongside it.
    return {
      kind: 'timeout',
      stageAlive: true,
      message: 'The stage passed its deadline and did not stop — the row will be retried after the lease expires.',
    };
  }

  return classifyStageOutcome({
    progress: outcome.value,
    error: outcome.error,
    aiTimeouts: aiTimeoutsObserved() - timeoutsBefore,
    stopAfter: request.stopAfter,
  });
}

// --- the sample adapter ------------------------------------------------------

/**
 * Generate ONE sample under the stage deadline — the same `aiSamples` call,
 * count and mode ladder the foreground uses (attempt 0 'fast', the retry
 * 'balanced'). It only generates: whether the events are usable is the
 * runner's verification gate, not this adapter's.
 */
async function createSample(request: SampleStageRequest): Promise<SampleStageOutcome> {
  await ensureAiSnapshot(request.checkpoint.ai);
  const modes = sampleGenerationAttemptModes();
  const mode = modes[Math.min(request.attempt, modes.length - 1)]!;

  const outcome = await runUnderStageDeadline(async signal => {
    setBackendStageSignal(signal);
    try {
      return await aiSamples(request.sourcetype, GENERATED_SAMPLE_COUNT, mode, undefined, request.grounding || undefined);
    } finally {
      setBackendStageSignal(null);
    }
  });

  if (outcome.aborted && !outcome.unwound) {
    return { kind: 'timeout', stageAlive: true, message: 'Sample creation passed its deadline and did not stop.' };
  }
  if (outcome.error) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    if (outcome.aborted || isStageAbortError(message) || isProxyTimeout(message)) return { kind: 'timeout', message };
    return { kind: 'error', message };
  }
  return { kind: 'sample', events: Array.isArray(outcome.value?.events) ? outcome.value.events : [] };
}

// --- the quality adapter -----------------------------------------------------

/**
 * ONE durable Repair/Scorecard transition, under the same deadline and abort
 * discipline as a build stage.
 *
 * The policy is entirely in `src/quality-stage.ts`; this only supplies the real
 * operations and translates the transition into the runner's outcome — so the
 * background run, the foreground wizard and the `/pack-quality-check` skill all
 * repair by the same rules.
 */
async function runQualityStage(request: QualityStageRequest): Promise<QualityStageOutcome> {
  await ensureAiSnapshot(request.checkpoint.ai);
  const quality = await loadQualitySettingsAsync();
  const { row, checkpoint } = request;
  const ref: QualityPipelineRef = {
    workerGroup: checkpoint.workerGroup,
    packId: request.packId,
    pipelineId: row.pipelineId,
    sourcetype: row.sourcetype,
    destFormat: row.destFormat,
    sampleName: request.sampleName,
    sampleEvents: request.sampleEvents,
  };

  const outcome = await runUnderStageDeadline(async signal => {
    setBackendStageSignal(signal);
    try {
      return await runQualityTransition({
        phase: request.phase,
        // The ROW's action, never the saved artifact's: a stale artifact must
        // not be what decides whether a pipeline may be written to. The engine
        // refuses the pair if they disagree.
        action: request.action,
        ref,
        artifact: request.artifact,
        ops: criblQualityOperations({ model: quality.repairModel }),
        threshold: quality.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD,
      });
    } finally {
      setBackendStageSignal(null);
    }
  });

  if (outcome.aborted && !outcome.unwound) {
    return {
      kind: 'timeout',
      stageAlive: true,
      message: 'The quality stage passed its deadline and did not stop — the row will be retried after the lease expires.',
    };
  }
  if (outcome.error) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    // Same distinction as a build stage: out of INVOCATION (retry from the same
    // phase) versus genuinely broken (end the row).
    if (isStageAbortError(message) || isProxyTimeout(message)) return { kind: 'timeout', message };
    return { kind: 'error', message };
  }
  const transition = outcome.value;
  if (!transition) return { kind: 'error', message: 'The quality stage returned nothing.' };

  return {
    kind: 'quality',
    artifact: transition.artifact,
    nextPhase: transition.nextPhase,
    status: transition.status,
    // Only a REPAIR that patched live config owes the run its second commit;
    // `changed` is false for every scorecard, at any score.
    changed: transition.artifact.changed,
    message: transition.message,
    ...(transition.result ? { result: transition.result } : {}),
  };
}

// --- handler -----------------------------------------------------------------

function makeDeps(): BackgroundRunnerDeps {
  return {
    store: backgroundBatchStore,
    now: () => Date.now(),
    // Identifies THIS invocation for lease ownership. Random rather than
    // time-based alone: two ticks can start in the same millisecond.
    invocationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    // The ONE pack identity: the runner decides new-vs-add-pipeline with it and
    // hands the resolved id back for the stage to deploy into.
    packId: toKebab,
    runStage,
    createSample,
    runQualityStage,
    commitDeploy: (workerGroup, message) => commitDeploy(workerGroup, message),
    ensureSchedule: cp => createSchedule(cp.runId),
    deleteSchedule: id => removeSchedule(id),
    // Run/invocation identifiers only — never row content (Hard Rule 32's
    // no-customer-data rule applies to the platform log as much as to KV).
    log: message => console.log('[runBatchStep]', sanitizeRunnerMessage(message)),
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Runner status → HTTP status. The caller is a Cribl Schedule, and a 200 body
 * that happens to say `status:'error'` reads as a tick that went fine — so
 * anything that is not a delivered tick answers non-2xx while KEEPING the
 * honest status in the body (`{ok:false, status, reason}`), rather than being
 * flattened into a generic 500.
 *
 * Absent from this table = a delivered tick, and those stay 200: running,
 * busy, done, awaiting-quality, stopping.
 */
export const STATUS_CODES: Record<string, number> = {
  missing: 404,
  stale: 409,
  invalid: 400,
  // The run itself failed (an unusable AI snapshot, a manifest that cannot be
  // executed) — nothing will build until someone changes something.
  error: 500,
  // Config was written and the commit did not land. Recoverable (the next tick
  // retries it), but never a success: the pipelines are not live.
  'deploy-failed': 502,
};

export async function onRequest(request: Request): Promise<Response> {
  try {
    return await handleRequest(request);
  } catch (error) {
    const message = sanitizeRunnerMessage(error instanceof Error ? error.message : error);
    console.error('[runBatchStep] unhandled error', message);
    return json({ ok: false, error: message }, 500);
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as
    | { action?: string; runId?: unknown; scheduledFor?: string; scheduleId?: string }
    | null;
  const runId = typeof body?.runId === 'string' ? body.runId.trim() : '';
  if (!runId) {
    // Never fall back to "whatever run is active": a schedule that outlived its
    // run would then start building against a different one.
    return json({ ok: false, reason: 'A runId is required.' }, 400);
  }

  const deps = makeDeps();

  if (body?.action === 'kickoff') {
    const result = await runBackgroundKickoff(runId, deps);
    if (result.status !== 'started') {
      return json({ ok: false, status: result.status, reason: result.message }, STATUS_CODES[result.status] ?? 200);
    }
    return json({ ok: true, status: 'started', scheduleId: result.scheduleId || backgroundScheduleId(runId) }, 202);
  }

  const result = await runBackgroundTick(runId, deps);
  const code = STATUS_CODES[result.status];
  if (code) return json({ ok: false, status: result.status, reason: result.message }, code);
  return json({ ok: true, status: result.status, processed: result.processed, reason: result.message });
}
