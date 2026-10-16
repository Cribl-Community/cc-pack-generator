/**
 * The durable Background Batch stage machine.
 *
 * PURE by construction: every effect — App KV, the staged build, commit/deploy,
 * Backend Schedules — arrives as an injected dependency, so this module holds
 * only the rules that decide what happens next. `backend/run-batch-step.ts`
 * supplies the real implementations; the tests supply deterministic fakes and
 * drive the same orchestration.
 *
 * The invariants it exists to keep:
 *
 * - ONE durable transition per invocation. A Backend Function is bounded (120s)
 *   and its schedule fires every minute, so a tick runs a single stage and
 *   persists it. Predictability beats throughput here: an interrupted tick costs
 *   one stage, never a whole row.
 * - A tick that cannot prove it owns the run does nothing. The active-run
 *   pointer is checked before any work and the lease is written and then RE-READ
 *   before the first stage — App KV has no compare-and-swap, so ownership is
 *   verified, never assumed.
 * - Run status is re-read before each stage and before each write. Stop is a
 *   concurrent writer; a tick that wrote back a status it read a minute ago
 *   would silently resurrect a stopped run.
 * - Stage side effects are PENDING deployment. Pipelines are patched with
 *   deferDeploy, so the run commits exactly once, after every build row is
 *   terminal — never per row.
 * - A run has TWO halves and at most TWO deploys. Build rows first, then their
 *   ONE commit; only then the Repair/Scorecard rows, which read LIVE pipelines
 *   and therefore cannot start before that commit lands. Whatever the repairs
 *   patched shares a SECOND commit at the very end — one for all of them, and
 *   none at all if nothing changed (a Scorecard never changes anything).
 * - A measurement that failed never looks like one that succeeded (Hard Rule
 *   32): a timed-out stage is retried once and then marked error on that row
 *   alone; a failed commit is visible as `deployStatus: 'failed'` and leaves the
 *   run recoverable rather than reporting a deploy that never happened.
 */
import type {
  BackgroundBatchCheckpoint,
  BackgroundBatchRow,
  BackgroundPhase,
  BackgroundRowArtifact,
} from '../src/background-batch';
import { backgroundScheduleId } from '../src/background-batch';
import type { BackgroundBatchStore } from '../src/background-batch-store';
import { kvSafeSegment, rowArtifactKey } from '../src/background-batch-store';
import {
  claimLease,
  markTimedOutStage,
  nextBackgroundPhase,
  orderedBackgroundRows,
  releaseLease,
} from '../src/background-batch-runtime';
import { averageStageScores } from '../src/pipeline-stages';
import { getSampleName, type SampleGrounding } from '../src/pack-builder';
import {
  FIRST_QUALITY_PHASE,
  beginQualityRecovery,
  initialQualityArtifact,
  isQualityPhase,
  phaseMayPatchConfig,
  qualityNeedsRollback,
  type QualityAction,
  type QualityArtifact,
  type QualityPhase,
  type QualityResult,
} from '../src/quality-stage';
import { canBackgroundUseProvider } from '../src/settings-store';
import type { AiProvider } from '../src/settings-store';
import { credentialLikeMatch, verifyGeneratedSample } from '../src/sample-library';
import { sampleContentId } from '../src/batch-row-sample';
import { isEmptyEvent } from '../src/sample-gate';
import { BACKEND_FUNCTION_CEILING_MS } from '../src/ai-budget';
import { extractionClassOf } from '../src/staged-build';
import type {
  PreparedExtraction,
  StagedBuildArtifact,
  StagedStopAfter,
} from '../src/staged-build';

/**
 * Lease lifetime. Longer than the longest invocation that can hold it: the
 * platform kills a Backend Function at `BACKEND_FUNCTION_CEILING_MS`, and a
 * lease that expired before that would let the next schedule tick start a
 * SECOND build of the row the dying invocation is still deploying. A stage is
 * awaited in full, so the lease is never dropped while work is in flight;
 * this margin only covers a process that was killed outright.
 */
export const BACKGROUND_LEASE_TTL_MS = BACKEND_FUNCTION_CEILING_MS + 30_000;

/** Row/response messages are short, single-line, and never echo event text. */
export const BACKGROUND_MESSAGE_MAX_CHARS = 200;

const TERMINAL_PHASES: BackgroundPhase[] = ['success', 'error', 'skipped'];
const isTerminal = (row: BackgroundBatchRow): boolean => TERMINAL_PHASES.includes(row.phase);

/**
 * The build phases a stage can be asked to stop after. A lookup MISS is a
 * rejection, never a default: falling back to 'extraction' (as an earlier
 * version did) re-ran the wrong stage for a repair phase and reported it as
 * progress.
 */
const BUILD_STOP_AFTER: Record<BuildTargetPhase, StagedStopAfter> = {
  extraction: 'extraction',
  mapping: 'mapping',
  optimization: 'optimization',
  finalize: 'finalize',
  // A row that checkpointed AT finalize without completing advances to
  // 'success' by name only — the finalize stage still has to run.
  success: 'finalize',
};

/**
 * The only phases a BUILD stage can be asked to reach. Membership is checked
 * before the table above is indexed, so a repair phase or anything an older
 * manifest carries can never resolve to a stage by accident.
 */
type BuildTargetPhase = 'extraction' | 'mapping' | 'optimization' | 'finalize' | 'success';
const BUILD_TARGET_PHASES: BuildTargetPhase[] = ['extraction', 'mapping', 'optimization', 'finalize', 'success'];
const isBuildTargetPhase = (phase: BackgroundPhase): phase is BuildTargetPhase =>
  (BUILD_TARGET_PHASES as BackgroundPhase[]).includes(phase);

const BUILD_ACTIONS = new Set<BackgroundBatchRow['action']>(['overwrite', 'skip']);
const QUALITY_ACTIONS = new Set<BackgroundBatchRow['action']>(['repair', 'scorecard']);

/** What this tick should do with one row. */
export type RowWork =
  /** Already finished. */
  | { kind: 'done' }
  /** Terminal without any stage work (Skip). */
  | { kind: 'terminal'; phase: BackgroundPhase }
  /** Create and verify this row's sample — the first stage of a `needsSample` row. */
  | { kind: 'sample' }
  /** Run one build stage, stopping after this boundary. */
  | { kind: 'stage'; stopAfter: StagedStopAfter }
  /** Run one durable Repair/Scorecard transition. */
  | { kind: 'quality'; phase: QualityPhase }
  /** The row cannot be executed as written. */
  | { kind: 'reject'; reason: string };

/**
 * The one place that decides what a row means. Every mismatch is explicit:
 * a manifest can be written by the browser, resumed weeks later and replayed by
 * a schedule, so "action the group cannot carry" and "phase with no stage" are
 * real inputs, not impossible states.
 */
export function planRowWork(row: BackgroundBatchRow): RowWork {
  if (isTerminal(row)) return { kind: 'done' };

  const allowed = row.resultGroup === 'build' ? BUILD_ACTIONS : QUALITY_ACTIONS;
  if (!allowed.has(row.action)) {
    return { kind: 'reject', reason: `A ${row.resultGroup} row cannot carry the "${row.action}" action.` };
  }
  if (row.resultGroup === 'quality') {
    // A quality row's phase IS its position in the quality machine, so it is
    // resumed from exactly where it checkpointed. Anything else on a quality row
    // (a build phase left by a hand-edited or older manifest) has no transition
    // and must be rejected rather than silently restarted.
    if (row.phase === 'queued') return { kind: 'quality', phase: FIRST_QUALITY_PHASE };
    if (isQualityPhase(row.phase)) return { kind: 'quality', phase: row.phase };
    return { kind: 'reject', reason: `No quality stage exists for phase "${row.phase}".` };
  }
  if (row.action === 'skip') return { kind: 'terminal', phase: 'skipped' };

  const target = nextBackgroundPhase(row);
  if (target === 'sample') return { kind: 'sample' };
  // VALIDATE, then index. A phase this sequence does not advance (a repair
  // phase on a build row, an unknown one from an older manifest) is not a build
  // target at all, so the table is never consulted for it — defaulting the
  // lookup ('extraction' was the previous behaviour) reran an unrelated stage
  // and reported it as progress.
  if (target === row.phase || !isBuildTargetPhase(target)) {
    return { kind: 'reject', reason: `No build stage exists for phase "${row.phase}".` };
  }
  return { kind: 'stage', stopAfter: BUILD_STOP_AFTER[target] };
}

/** Per-stage scores as the row records them. */
export interface BackgroundStageScores {
  extraction?: number | null;
  mapping?: number | null;
  optimization?: number | null;
}

/**
 * Everything a stage needs. Assembled here so the adapter stays a thin call.
 *
 * Deliberately carries NO deadline: a stage is awaited in full. Bounding it
 * from the outside means resolving while `buildStagedPipeline` keeps deploying,
 * so the runner would checkpoint an outcome for a build still in progress. The
 * bound is the backend AI request timeout (src/ai-budget.ts), which is derived
 * from the platform ceiling precisely so this one is not needed.
 */
export interface StageRequest {
  checkpoint: BackgroundBatchCheckpoint;
  row: BackgroundBatchRow;
  /** The resolved pack identity — the SAME value that decided `mode`. */
  packId: string;
  /** Always DEFINED — the shared builder's progress contract requires it. */
  stopAfter: StagedStopAfter;
  /** The persisted checkpoint of earlier stages; `{}` for an unstarted row. */
  resume: StagedBuildArtifact;
  /**
   * The pre-flight sample, read from the row's artifact. It never travels on
   * the manifest row: the checkpoint is polled and rewritten constantly, and
   * customer event text does not belong in it.
   */
  sampleEvents: string;
  /**
   * Where that sample came from, and how long the foreground spent getting it.
   * Both are recorded by pre-flight and carried on the same artifact, so the
   * score event a background build logs names its tier exactly as a foreground
   * build does.
   */
  sampleTier?: string;
  prepareMs?: number;
  /** From the same artifact: `'paste'` for the row's own CSV sample, else absent. */
  sampleSourceMode?: string;
  /** From the same artifact: the foreground sanitizer was applied. */
  sampleSanitised?: boolean;
  mode: 'new' | 'add-pipeline';
  uploadSample: boolean;
  preparedExtraction: PreparedExtraction | null;
}

export type StageOutcome =
  | {
      kind: 'stage';
      artifact: StagedBuildArtifact;
      complete: boolean;
      scores?: BackgroundStageScores;
      extractionForReuse?: PreparedExtraction | null;
      /** Whether this stage wrote pack/pipeline config that must be deployed. */
      wroteConfig?: boolean;
      message?: string;
    }
  | {
      kind: 'timeout';
      message?: string;
      /**
       * The stage did NOT stop when its deadline fired, so its work may still
       * be deploying. The runner must not commit, and must not release the
       * lease — the TTL (longer than any invocation) is what frees it.
       */
      stageAlive?: boolean;
    }
  | { kind: 'error'; message: string };

/** What a sample stage generates from — carried on the row artifact. */
export interface SampleStageRequest {
  checkpoint: BackgroundBatchCheckpoint;
  row: BackgroundBatchRow;
  /** The lookup key the sample is resolved under (raw channel for Windows). */
  sourcetype: string;
  grounding?: SampleGrounding;
  /** 0 on the first try, 1 on the retry — the adapter picks a mode from it. */
  attempt: number;
}

export type SampleStageOutcome =
  | { kind: 'sample'; events: string[] }
  | { kind: 'timeout'; message?: string; stageAlive?: boolean }
  | { kind: 'error'; message: string };

/**
 * Everything one durable Repair/Scorecard transition needs.
 *
 * The sample and the quality checkpoint both come from the row's ARTIFACT, for
 * the same reason the build stages do: the manifest is polled and rewritten
 * constantly and must hold no customer event text, and the best-conf baseline
 * behind best-score-wins is far too large for it.
 */
export interface QualityStageRequest {
  checkpoint: BackgroundBatchCheckpoint;
  row: BackgroundBatchRow;
  /** The resolved pack identity — the same `packId` the build rows deploy into. */
  packId: string;
  /** Which transition to run. Resumed from the row's own phase. */
  phase: QualityPhase;
  /**
   * Repair or Scorecard, as the ROW asks for it. Carried explicitly so the
   * adapter cannot take it from the saved artifact instead: a stale artifact
   * would then decide whether a pipeline may be written to.
   */
  action: QualityAction;
  /** The checkpoint of earlier transitions; a fresh one for an unstarted row. */
  artifact: QualityArtifact;
  /** ONE sample per sourcetype (Hard Rule 27), never per pipeline. */
  sampleName: string;
  /** The pre-flight sample text from the row artifact; '' when the row has none. */
  sampleEvents: string;
}

export type QualityStageOutcome =
  | {
      kind: 'quality';
      artifact: QualityArtifact;
      /** NULL = this row is finished; `result` is then set. */
      nextPhase: QualityPhase | null;
      status: 'running' | 'success' | 'error';
      /** A repair PATCHed live config — the run owes ONE more commit. */
      changed: boolean;
      message?: string;
      result?: QualityResult;
    }
  | { kind: 'timeout'; message?: string; stageAlive?: boolean }
  | { kind: 'error'; message: string };

export interface BackgroundRunnerDeps {
  store: BackgroundBatchStore;
  now(): number;
  invocationId: string;
  /**
   * Pack name → pack id. Injected so that "has this pack been created yet"
   * and "which pack does this stage deploy into" are literally the same
   * function: two spellings disagree on names like `My Pack` vs `my-pack`, and
   * the second row then recreates (and overwrites) the first row's pack.
   */
  packId(packName: string): string;
  runStage(request: StageRequest): Promise<StageOutcome>;
  /** Generate one sample (Cribl AI) under the stage deadline. Verified by the runner. */
  createSample(request: SampleStageRequest): Promise<SampleStageOutcome>;
  runQualityStage(request: QualityStageRequest): Promise<QualityStageOutcome>;
  commitDeploy(workerGroup: string, message: string): Promise<unknown>;
  ensureSchedule(cp: BackgroundBatchCheckpoint): Promise<string>;
  deleteSchedule(id?: string): Promise<void>;
  leaseTtlMs?: number;
  log?(message: string): void;
}

export type BackgroundTickStatus =
  | 'missing' | 'stale' | 'invalid' | 'busy'
  | 'running' | 'deploy-failed'
  | 'done' | 'error' | 'stopping';

export interface BackgroundTickResult {
  status: BackgroundTickStatus;
  processed: number;
  message?: string;
}

export interface BackgroundKickoffResult {
  status: 'started' | 'missing' | 'stale' | 'invalid' | 'done' | 'error';
  scheduleId?: string;
  message?: string;
}

/**
 * Credential shapes that turn up in the text a FAILING provider or proxy hands
 * back — an echoed `Authorization` header, a rejected key quoted back at you,
 * a URL with the token still in the query string. These are REDACTION patterns,
 * which is a different job from `sample-library`'s detection list (used as the
 * backstop below): they must match the assignment as well as the value, and
 * they deliberately include bearer JWTs, which that list excludes because
 * `eyJ…` is ordinary content inside a customer log.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*"?[^\s"',;]{6,}"?/gi,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9._-]+)*/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Shapes that only a customer EVENT has. A Cribl API error habitually quotes
 * the event it choked on, and truncating that to 200 characters still publishes
 * the first 200 characters of somebody's production log into KV and the
 * platform log. Each of these collapses to a marker, leaving the part of the
 * message that says what actually went wrong.
 */
const SAMPLE_FRAGMENT_PATTERNS: RegExp[] = [
  // A JSON object/array literal — the commonest way an event is quoted back.
  /[{[][^{}[\]]*["}\]][^{}[\]]*[}\]]/g,
  // CEF/LEEF headers, and everything after them.
  /\b(?:CEF|LEEF):\d[^\s]*.*/gi,
  // A syslog priority/timestamp preamble and the line it introduces.
  /<\d{1,3}>.*/g,
  // Three or more key=value pairs in a row: a kvp event, not a sentence.
  /\b[\w.[\]-]+=[^\s,;]+(?:[\s,;]+[\w.[\]-]+=[^\s,;]+){2,}/g,
];

/**
 * One line, bounded, no control characters, no credentials, no event text.
 * Everything a row or a response can say passes through here: stage errors are
 * third-party text (a Cribl API body, a provider error) and must never become a
 * channel for sample content or for the key the provider just rejected. A row
 * message is read in the UI and written to the platform log, so it has two
 * audiences and neither of them needs either.
 */
export function sanitizeRunnerMessage(message: unknown): string {
  if (message == null) return '';
  // \p{C}: control, format and other invisible categories — a log line and a KV
  // message are both read by humans, and a smuggled newline is how one message
  // becomes two.
  let flat = String(message).replace(/\p{C}+/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) flat = flat.replace(pattern, '[redacted]');
  // Credentials first: a secret inside a quoted event must be redacted as a
  // secret even though the fragment rule would have covered the whole line.
  for (const pattern of SAMPLE_FRAGMENT_PATTERNS) flat = flat.replace(pattern, '[sample omitted]');
  flat = flat.replace(/\s+/g, ' ').trim();
  // Backstop: the shared provider-issued credential detector (the one the
  // sample pool gates on) gets the last word, so a shape this file has not
  // learned yet costs the message rather than leaking it.
  if (credentialLikeMatch(flat)) {
    return 'Message withheld — it contained credential-like material.';
  }
  return flat.length > BACKGROUND_MESSAGE_MAX_CHARS ? flat.slice(0, BACKGROUND_MESSAGE_MAX_CHARS) : flat;
}

/**
 * Where a source's reusable extraction lives for the rest of the run. Keyed by
 * sourcetype AND extraction class because the two classes legitimately pick
 * different parsers (Hard Rule 10/27), AND by the sample's content, because two
 * packs of one source can carry different CSV samples (a FortiGate key=value
 * row and a FortiGate CEF row): a parser proven on one must not be replayed on
 * the other. Store-fed siblings share one sample text, so they still share one
 * extraction. Run-scoped so dismissing a run removes it with everything else.
 */
export function backgroundExtractionReuseKey(
  runId: string,
  sourcetype: string,
  extractionClass: 'mapped' | 'raw',
  sampleEvents: string,
): string {
  return rowArtifactKey(runId, `extraction.${kvSafeSegment(sourcetype)}.${extractionClass}.${sampleContentId(sampleEvents)}`);
}

/**
 * Head of a stage's preview output kept in the checkpoint. Verbose sources
 * (aws_cloudtrail, corelight_conn, fortinet_fortigate, zscaler_web) put a full
 * 20-event `.out` per stage over App KV's ~100 KB per-doc ceiling and the row
 * FAILED after a clean build — see BACKGROUND_ROW_ARTIFACT_MAX_BYTES. The next
 * tick only reads this `.out` as (a) the mapping-input gate + field detection
 * (`validateMappingInputs` unions populated fields, `extractionHasFields` reads
 * out[0]) and (b) a scoring BASELINE for the delta — the authoritative stage
 * score always comes from that stage's own full re-preview, never this head. 8
 * is the house preview count (ExpStageStats, the report sample), enough for the
 * gate and field union while small enough to fit.
 */
const CHECKPOINT_STAGE_OUT_MAX = 8;

const boundStageOut = <T extends { out?: any[] }>(stage: T): T =>
  (stage.out && stage.out.length > CHECKPOINT_STAGE_OUT_MAX)
    ? { ...stage, out: stage.out.slice(0, CHECKPOINT_STAGE_OUT_MAX) }
    : stage;

/**
 * What survives a stage, minus anything the next tick gets back for free.
 *
 * The reference lookup CSVs are half a cisco_asa checkpoint on their own, and a
 * Backend Function carries that corpus embedded (Hard Rule 34) while lookup
 * HEALING is backend-unavailable by design — so re-selecting them costs nothing
 * and cannot produce a different answer. Persisting them only pushed the
 * document into App KV's 413.
 *
 * The preview `.out` of each present stage is bounded to a head for the same
 * reason (see CHECKPOINT_STAGE_OUT_MAX) — a blanket strip would break resume
 * (mapping fail-closes on empty input), a bounded head does not.
 */
export function checkpointableBuild(artifact: StagedBuildArtifact): StagedBuildArtifact {
  if (!artifact) return artifact;
  const { referenceLookups: _rederived, ...rest } = artifact;
  const slim = rest as StagedBuildArtifact;
  if (slim.extraction) slim.extraction = boundStageOut(slim.extraction);
  if (slim.mapping) slim.mapping = boundStageOut(slim.mapping);
  if (slim.optimization) slim.optimization = boundStageOut(slim.optimization);
  return slim;
}

/**
 * A pack exists only once a row actually BUILT into it. A failed or skipped row
 * deployed nothing, so its sibling must still create the pack (`mode: 'new'`)
 * rather than add a pipeline to something that is not there. The shared sample
 * is per sourcetype (Hard Rule 27), so a sibling format of an already-built
 * sourcetype references it instead of uploading it again.
 *
 * `packId` is the SAME function the stage deploys with — see the dep's comment.
 */
export function packBuildContext(
  cp: BackgroundBatchCheckpoint,
  row: BackgroundBatchRow,
  packId: (packName: string) => string,
): { packId: string; mode: 'new' | 'add-pipeline'; uploadSample: boolean } {
  const id = packId(row.packName);
  const siblings = cp.rows.filter(r => r.rowId !== row.rowId && r.phase === 'success' && packId(r.packName) === id);
  const created = siblings.length > 0;
  return {
    packId: id,
    mode: created ? 'add-pipeline' : 'new',
    // mode:'new' uploads regardless (pack creation needs its sample); this flag
    // only decides whether an ADDED pipeline re-uploads the shared sample.
    uploadSample: !created || !siblings.some(r => r.sourcetype === row.sourcetype),
  };
}

/**
 * Why this run can never do AI work, or null. A run-level fault: no row can fix
 * it, so failing rows one per tick (as an unguarded stage would) turns one bad
 * setting into a whole run of individually-blamed rows and a schedule that
 * keeps firing.
 */
export function backgroundAiFault(cp: BackgroundBatchCheckpoint): string | null {
  const provider = cp.ai?.provider as AiProvider | undefined;
  if (!provider) return 'The run has no AI provider snapshot — it cannot build in the background.';
  const eligibility = canBackgroundUseProvider(provider);
  return eligibility.ok ? null : (eligibility.reason || `AI provider "${provider}" cannot be used by a background worker.`);
}

/** The next build row to work on: strictly in order, one row at a time. */
function selectBuildRow(cp: BackgroundBatchCheckpoint): BackgroundBatchRow | null {
  return orderedBackgroundRows(cp.rows).find(r => r.resultGroup === 'build' && !isTerminal(r)) ?? null;
}

/**
 * Is the config every quality row is about to INSPECT actually live?
 *
 * Repair and Scorecard both preview a deployed pipeline. Running one against
 * config that was PATCHed with deferDeploy and never committed measures the
 * previous version, so the score would be real, reproducible and about the
 * wrong pipeline.
 */
function buildDeployReady(cp: BackgroundBatchCheckpoint): boolean {
  return cp.deployStatus === 'deployed' || cp.deployStatus === 'not-needed';
}

/**
 * The next quality row — but ONLY once every build row is terminal and the
 * build config is deployed. Both halves are load-bearing; see above.
 */
function selectQualityRow(cp: BackgroundBatchCheckpoint): BackgroundBatchRow | null {
  if (!buildDeployReady(cp)) return null;
  if (selectBuildRow(cp)) return null;
  return orderedBackgroundRows(cp.rows).find(r => r.resultGroup === 'quality' && !isTerminal(r)) ?? null;
}

function withRow(cp: BackgroundBatchCheckpoint, updated: BackgroundBatchRow): BackgroundBatchCheckpoint {
  return { ...cp, rows: cp.rows.map(r => (r.rowId === updated.rowId ? updated : r)) };
}

/** Finished for good — the only state this runner will not act on. */
const isRunInactive = (cp: BackgroundBatchCheckpoint): boolean => cp.status === 'done' || cp.status === 'error';

/**
 * `awaiting-quality` is LEGACY. An earlier build parked a run whose build rows
 * were deployed but whose Repair/Scorecard rows it could not perform, and
 * deleted the schedule. This runner performs them, so it never parks — but a
 * manifest written by that build can still be sitting in App KV, and it must
 * resume rather than stall forever. Normalising it to `running` on the way in
 * is the whole migration: the rows and artifacts are exactly where the build
 * left them.
 */
function resumeParkedRun(cp: BackgroundBatchCheckpoint): BackgroundBatchCheckpoint {
  return cp.status === 'awaiting-quality' ? { ...cp, status: 'running' } : cp;
}

/**
 * Removing a schedule is tidying up, never the outcome. A run that finished
 * and then failed to delete its schedule is still finished — reporting that as
 * an error would make the next tick redo the whole finish path.
 *
 * Which is exactly why a stored id cannot be the only way to name the schedule.
 * A delete that FAILED leaves a schedule nothing knows how to remove — and a
 * legacy parked manifest has already forgotten its `scheduleId` — firing every
 * minute against a run with no work, forever. The schedule's id is DERIVED from
 * the run id, so falling back to it recovers the orphan and can only ever name
 * this run's own schedule — never another run's.
 * The delete is idempotent (a 404 is success), so retrying it costs nothing.
 */
async function bestEffortDeleteSchedule(
  deps: BackgroundRunnerDeps,
  runId: string,
  scheduleId?: string,
): Promise<void> {
  try {
    await deps.deleteSchedule(scheduleId || backgroundScheduleId(runId));
  } catch (error) {
    deps.log?.(`Background batch schedule not removed: ${sanitizeRunnerMessage(error instanceof Error ? error.message : error)}`);
  }
}

function validateManifest(cp: BackgroundBatchCheckpoint, runId: string): string | null {
  if (cp.runId !== runId) return 'The stored manifest does not match the requested run.';
  if (!cp.workerGroup) return 'The run manifest has no worker group.';
  if (!Array.isArray(cp.rows) || cp.rows.length === 0) return 'The run manifest has no rows.';
  return null;
}

type InactiveStatus = 'missing' | 'stale' | 'invalid' | 'done' | 'error';

type OwnedRun =
  | { ok: true; cp: BackgroundBatchCheckpoint }
  | { ok: false; status: InactiveStatus; cp?: BackgroundBatchCheckpoint; message?: string };

/**
 * Load the run and prove this invocation may act on it: the manifest exists, it
 * IS the active run, it is executable as written, and it has not finished.
 */
async function loadOwnedRun(runId: string, deps: BackgroundRunnerDeps): Promise<OwnedRun> {
  const stored = await deps.store.loadRun(runId);
  if (!stored) return { ok: false, status: 'missing' };
  const active = await deps.store.loadActiveRunId();
  if (active !== runId) return { ok: false, status: 'stale' };
  const invalid = validateManifest(stored, runId);
  if (invalid) return { ok: false, status: 'invalid', cp: stored, message: invalid };
  if (isRunInactive(stored)) return { ok: false, status: stored.status as InactiveStatus, cp: stored, message: stored.message };
  return { ok: true, cp: stored };
}

/**
 * Start a run: validate it, make sure a schedule exists, mark it running, and
 * return. Deliberately does NO stage work — the browser call that triggers it
 * has to come back inside the iframe bridge's 30-second ceiling.
 */
export async function runBackgroundKickoff(
  runId: string,
  deps: BackgroundRunnerDeps,
): Promise<BackgroundKickoffResult> {
  const owned = await loadOwnedRun(runId, deps);
  if (!owned.ok) return { status: owned.status, message: owned.message };
  const cp = owned.cp;

  // A run whose provider a background worker cannot use would fail its first
  // stage and every stage after it. Refuse before it costs a schedule.
  const aiFault = backgroundAiFault(cp);
  if (aiFault) return { status: 'invalid', message: aiFault };

  const scheduleId = cp.scheduleId || (await deps.ensureSchedule(cp));
  // Stop may already have been pressed; kickoff must not revert it. A legacy
  // parked run resumes here (see resumeParkedRun) — Start is exactly the moment
  // its owner asked for its quality rows to be run.
  const status = cp.status === 'stopping' ? 'stopping' : 'running';
  if (cp.scheduleId !== scheduleId || cp.status !== status) {
    await deps.store.saveRun({ ...cp, scheduleId, status, updatedAt: deps.now() });
  }
  return { status: 'started', scheduleId };
}

/**
 * One scheduled invocation: at most one durable stage, then whatever the run's
 * state now requires (finish a stopped run, commit once, or leave it running).
 */
export async function runBackgroundTick(
  runId: string,
  deps: BackgroundRunnerDeps,
): Promise<BackgroundTickResult> {
  const owned = await loadOwnedRun(runId, deps);
  if (!owned.ok) {
    // A run that is finished but whose schedule is still firing: stop the
    // ticking. The checkpoint stays in KV until the user dismisses it.
    if (owned.status === 'done' || owned.status === 'error') {
      await bestEffortDeleteSchedule(deps, runId, owned.cp?.scheduleId);
    }
    return { status: owned.status, processed: 0, message: owned.message };
  }

  // A provider a background worker cannot use is a RUN-level fault: it would
  // otherwise fail exactly one row per tick, blaming rows for a setting.
  const aiFault = backgroundAiFault(owned.cp);
  if (aiFault) return failRun(runId, deps, aiFault);

  // Claim onto a manifest re-read HERE. Everything above involved awaits, and
  // Stop is a concurrent writer: merging the lease into the copy loaded before
  // those awaits would write its `status` back too, resurrecting a stopped run.
  const fresh = await deps.store.loadRun(runId);
  if (!fresh) return { status: 'missing', processed: 0 };
  if (isRunInactive(fresh)) return { status: fresh.status as BackgroundTickStatus, processed: 0, message: fresh.message };

  // A legacy parked manifest becomes `running` with the lease claim — one
  // write, so a resumed run never sits in a state the UI calls "parked" while
  // this invocation is working on it.
  const leased = claimLease(resumeParkedRun(fresh), deps.invocationId, deps.now(), deps.leaseTtlMs ?? BACKGROUND_LEASE_TTL_MS);
  if (!leased) return { status: 'busy', processed: 0 };
  await deps.store.saveRun(leased);

  // App KV has no CAS: the write above is a CLAIM, not an acquisition. Read it
  // back and only proceed if this invocation is still the owner.
  const verified = await deps.store.loadRun(runId);
  if (!verified || verified.lease?.owner !== deps.invocationId) return { status: 'busy', processed: 0 };

  let processed = 0;
  // Set only when a stage passed its deadline WITHOUT stopping. While it is
  // true this invocation cannot know what the build is still doing, so it
  // neither commits nor releases the lease.
  let stageMayBeAlive = false;
  try {
    let cp = verified;

    if (cp.status !== 'stopping') {
      // Rows that cannot be executed as written are failed up front, so an
      // unrunnable row can never hold the run open waiting for work nobody
      // will do.
      cp = await rejectUnrunnableRows(deps, cp);

      const row = selectBuildRow(cp);
      const plan = row ? planRowWork(row) : null;
      if (row && plan?.kind === 'terminal') {
        // Skip is terminal by definition — no stage, no side effects.
        cp = await persistRow(runId, deps, {
          ...row,
          phase: plan.phase,
          message: sanitizeRunnerMessage(row.message || 'Skipped — existing pack left untouched.'),
        });
      } else if (row && plan?.kind === 'sample') {
        const staged = await runOneSampleStage(runId, deps, cp, row, () => { stageMayBeAlive = true; });
        cp = staged.cp;
        stageMayBeAlive = stageMayBeAlive || staged.stageAlive;
        processed = 1;
      } else if (row && plan?.kind === 'stage') {
        // Awaited in FULL: the stage is bounded by an abort it can act on, not
        // by a timer that returns while it keeps deploying (see StageRequest).
        const staged = await runOneStage(runId, deps, cp, row, plan.stopAfter, () => { stageMayBeAlive = true; });
        cp = staged.cp;
        stageMayBeAlive = stageMayBeAlive || staged.stageAlive;
        processed = 1;
      } else if (!row) {
        // Build rows are ALL terminal. `selectQualityRow` additionally refuses
        // until the build config is deployed, so a Repair/Scorecard can never
        // measure config that was patched and never committed.
        const qualityRow = selectQualityRow(cp);
        const qualityPlan = qualityRow ? planRowWork(qualityRow) : null;
        if (qualityRow && qualityPlan?.kind === 'quality') {
          const staged = await runOneQualityStage(runId, deps, cp, qualityRow, qualityPlan.phase, () => { stageMayBeAlive = true; });
          cp = staged.cp;
          stageMayBeAlive = stageMayBeAlive || staged.stageAlive;
          processed = 1;
        }
      }
    }

    if (stageMayBeAlive) {
      // Deliberately does NOT finish the tick: committing now could deploy
      // half-written config from a build that is still running.
      deps.log?.(`Background batch stage did not stop at its deadline; holding the lease for run ${runId}.`);
      return { status: 'running', processed, message: 'A stage passed its deadline without stopping — waiting for its lease to expire.' };
    }

    return await finishTick(runId, deps, cp, processed);
  } finally {
    // Reached only after the stage settled — EXCEPT when the stage ignored its
    // abort, and then the lease is deliberately left in place to expire, so no
    // second invocation can build the same row alongside work that may still
    // be alive.
    if (!stageMayBeAlive) await releaseOwnedLease(runId, deps);
  }
}

/**
 * Fail the whole run, once. Writes nothing if it has already failed, so a
 * schedule that keeps firing cannot turn one fault into a write per minute.
 */
async function failRun(runId: string, deps: BackgroundRunnerDeps, reason: string): Promise<BackgroundTickResult> {
  const message = sanitizeRunnerMessage(reason);
  const fresh = await deps.store.loadRun(runId);
  if (!fresh) return { status: 'missing', processed: 0 };
  if (fresh.status !== 'error') {
    await deps.store.saveRun({ ...fresh, status: 'error', message, updatedAt: deps.now() });
  }
  await bestEffortDeleteSchedule(deps, runId, fresh.scheduleId);
  return { status: 'error', processed: 0, message };
}

/**
 * Mark every row this runner can never execute — a group/action mismatch, a
 * phase with no stage — as failed, in ONE write, with the reason on the row.
 */
async function rejectUnrunnableRows(
  deps: BackgroundRunnerDeps,
  cp: BackgroundBatchCheckpoint,
): Promise<BackgroundBatchCheckpoint> {
  const reasons = new Map<string, string>();
  for (const row of cp.rows) {
    const plan = planRowWork(row);
    if (plan.kind === 'reject') reasons.set(row.rowId, plan.reason);
  }
  if (!reasons.size) return cp;

  const next = {
    ...cp,
    rows: cp.rows.map(r => (reasons.has(r.rowId) ? failedRow(r, reasons.get(r.rowId)!) : r)),
    updatedAt: deps.now(),
  };
  await deps.store.saveRun(next);
  return next;
}

/**
 * A row that ended without finishing. Its OVERALL score is null — an
 * unfinished pipeline was never measured end to end, and a number here would
 * read as a result (Hard Rule 32) — while the stage-native scores stay as
 * diagnostics for whoever looks at why it stopped.
 */
function failedRow(row: BackgroundBatchRow, message: string): BackgroundBatchRow {
  return {
    ...row,
    phase: 'error',
    score: null,
    scores: { ...(row.scores ?? {}), overall: null },
    message: sanitizeRunnerMessage(message),
  };
}

/**
 * Which of the run's TWO deployments a row's writes belong to. They are
 * separate because they land at different moments: the build commit before any
 * quality row reads a live pipeline, the quality commit once after all of them.
 *
 * `quality-blocked` is the third answer, and the important one: a repair
 * candidate is live, nobody could verify it and nobody could put the best conf
 * back. Deploying then would ship exactly the thing best-wins exists to
 * prevent, so the quality deploy is refused rather than retried.
 */
type PendingDeploy = 'build' | 'quality' | 'quality-blocked' | null;

/**
 * Persist a row update onto the FRESHEST manifest, never onto a stale copy —
 * one read and one write, since every artifact write already costs three KV
 * round trips of its own.
 */
async function persistRow(
  runId: string,
  deps: BackgroundRunnerDeps,
  row: BackgroundBatchRow,
  pending: PendingDeploy = null,
): Promise<BackgroundBatchCheckpoint> {
  const fresh = await deps.store.loadRun(runId);
  if (!fresh) throw new Error('The background run manifest disappeared mid-tick.');
  // Killed while this stage ran: the kill already settled this row; a late
  // result must not reopen it.
  if (isRunInactive(fresh)) return fresh;
  // `fresh.status` is written back as read — a Stop that landed while this stage
  // ran stays stopped.
  const next = { ...withRow(fresh, row), updatedAt: deps.now() };
  // Config was written with deferDeploy — it is live only after the ONE commit.
  if (pending === 'build' && next.deployStatus === 'not-needed') next.deployStatus = 'pending';
  if (pending === 'quality' && (next.qualityDeployStatus ?? 'not-needed') === 'not-needed') {
    next.qualityDeployStatus = 'pending';
  }
  // Blocking wins over any pending: the commit is for the whole worker group,
  // so shipping another row's verified repair would ship this row's unverified
  // candidate with it.
  if (pending === 'quality-blocked') next.qualityDeployStatus = 'blocked';
  await deps.store.saveRun(next);
  return next;
}

interface StageTickResult {
  cp: BackgroundBatchCheckpoint;
  /** See `StageOutcome.stageAlive` — the tick must not commit or release. */
  stageAlive: boolean;
}

async function runOneStage(
  runId: string,
  deps: BackgroundRunnerDeps,
  cp: BackgroundBatchCheckpoint,
  row: BackgroundBatchRow,
  stopAfter: StagedStopAfter,
  // Called the moment a stage is known not to have stopped — before any KV
  // write, so no persist failure can unwind the tick while the caller still
  // thinks the stage settled.
  markStageAlive: () => void,
): Promise<StageTickResult> {
  // One document per row: the immutable pre-flight sample plus the mutable
  // staged-build checkpoint. Read together so a stage write can never drop the
  // sample the next stage needs.
  const stored = await deps.store.loadArtifact<BackgroundRowArtifact>(row.artifactKey);
  const sampleEvents = typeof stored?.sampleEvents === 'string' ? stored.sampleEvents : '';
  if (!sampleEvents.trim()) {
    // Start persists an artifact for every executable row before the schedule
    // exists, and a `needsSample` row only reaches a build stage after its
    // sample stage wrote the events — so this means the document was lost or
    // dismissed mid-run. Building from nothing would score a zero that reads as
    // a failed pipeline rather than a missing input.
    return {
      cp: await persistRow(runId, deps, failedRow(row, 'The row artifact holding this source\'s sample is missing — start the run again.')),
      stageAlive: false,
    };
  }
  const resume = stored?.build ?? {};
  const extractionClass = extractionClassOf(row.destFormat);
  const reuseKey = backgroundExtractionReuseKey(runId, row.sourcetype, extractionClass, sampleEvents);
  // Only the first stage of a row can use a sibling's extraction; after that the
  // row's own artifact already holds one.
  const preparedExtraction = resume.extraction
    ? null
    : await deps.store.loadArtifact<PreparedExtraction>(reuseKey);
  const { packId, mode, uploadSample } = packBuildContext(cp, row, deps.packId);

  // A stage that throws is THIS ROW's failure, not the tick's: the adapter
  // already classifies what it can, so anything still escaping would otherwise
  // fail the invocation and be retried forever on the next schedule.
  let outcome: StageOutcome;
  try {
    outcome = await deps.runStage({
      checkpoint: cp,
      row,
      packId,
      stopAfter,
      resume,
      sampleEvents,
      sampleTier: stored?.sampleTier,
      prepareMs: stored?.prepareMs,
      ...(stored?.sampleSourceMode ? { sampleSourceMode: stored.sampleSourceMode } : {}),
      ...(stored?.sampleSanitised ? { sampleSanitised: true } : {}),
      mode,
      uploadSample,
      preparedExtraction: preparedExtraction ?? null,
    });
  } catch (error) {
    outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  // A stage that got far enough to score a candidate has already PATCHed
  // pipeline config (deferred, not deployed). So every attempt — including one
  // that failed part-way — leaves deployment pending: finishing the run without
  // a commit would leave that config written but never deployed.
  const mayHaveWrittenConfig: PendingDeploy = outcome.kind !== 'stage' || outcome.wroteConfig !== false ? 'build' : null;

  if (outcome.kind === 'timeout') {
    if (outcome.stageAlive === true) {
      // The stage ignored its abort. Tell the tick BEFORE touching KV: writing
      // the row is a persist like any other and can fail transiently, and a
      // failure that unwound the tick with the flag still unset would release
      // the lease — which is the one thing that must not happen while that
      // build may still be deploying.
      markStageAlive();
      const timedOut = markTimedOutStage(row);
      const message = sanitizeRunnerMessage(outcome.message || 'The stage passed its deadline without stopping.');
      // Record the attempt so the retry count is honest — and nothing else,
      // because this invocation cannot know what that build is still writing.
      // A terminal one is a row that ended without finishing, so it loses its
      // aggregate score like any other (see failedRow).
      const recorded = timedOut.phase === 'error' ? failedRow(timedOut, message) : { ...timedOut, message };
      try {
        return { cp: await persistRow(runId, deps, recorded, 'build'), stageAlive: true };
      } catch (error) {
        // Losing the record costs the row one attempt of its retry budget. It
        // must not cost the lease, so this is reported and NOT rethrown.
        deps.log?.(`Background batch could not record a non-unwound stage: ${sanitizeRunnerMessage(error instanceof Error ? error.message : error)}`);
        return { cp, stageAlive: true };
      }
    }
    // First timeout retries the SAME phase on a later tick; the second ends
    // this row and only this row. The message is the RUNNER's, not the
    // adapter's — a terminal row that says "will be retried" is a lie the UI
    // then repeats.
    const timedOut = markTimedOutStage(row);
    if (timedOut.phase === 'error') {
      return {
        cp: await persistRow(runId, deps, failedRow(timedOut, 'The stage timed out twice — the row was stopped and will not be retried.'), mayHaveWrittenConfig),
        stageAlive: false,
      };
    }
    return {
      cp: await persistRow(runId, deps, {
        ...timedOut,
        message: 'The stage timed out — it will be retried on the next tick.',
      }, mayHaveWrittenConfig),
      stageAlive: false,
    };
  }

  if (outcome.kind === 'error') {
    return { cp: await persistRow(runId, deps, failedRow(row, outcome.message), mayHaveWrittenConfig), stageAlive: false };
  }

  try {
    // Rewrite the WRAPPER, not just the build checkpoint: the sample is what
    // every later stage of this row builds from.
    await deps.store.saveArtifact<BackgroundRowArtifact>(row.artifactKey, {
      ...(stored ?? { sampleEvents }),
      sampleEvents,
      build: checkpointableBuild(outcome.artifact),
    });
  } catch (error) {
    // A stage whose checkpoint cannot be persisted (over the per-artifact byte
    // cap, say) would be redone from the same phase on every future tick. End
    // the row instead, with the reason on it.
    return {
      cp: await persistRow(
        runId, deps,
        failedRow(row, `Stage checkpoint could not be saved: ${error instanceof Error ? error.message : error}`),
        mayHaveWrittenConfig,
      ),
      stageAlive: false,
    };
  }

  if (outcome.complete && outcome.extractionForReuse) {
    // First writer wins: a later row of the same source/class reuses this one.
    // Best effort — losing the shared copy only costs the next sibling a
    // re-derived parser, so it must never fail a row that already built.
    try {
      const existing = await deps.store.loadArtifact<PreparedExtraction>(reuseKey);
      // Bound the head too: a verbose source's full `.out` overflows the same
      // cap, and a silent overflow here makes every sibling re-derive its
      // parser. A sibling consumes `pe.out` only as its mapping-input gate,
      // which the head satisfies (see CHECKPOINT_STAGE_OUT_MAX).
      if (!existing) await deps.store.saveArtifact(reuseKey, boundStageOut(outcome.extractionForReuse));
    } catch (error) {
      deps.log?.(`Background batch extraction reuse not stored: ${sanitizeRunnerMessage(error instanceof Error ? error.message : error)}`);
    }
  }

  const scores = outcome.scores ?? {};
  const overall = averageStageScores(scores.extraction, scores.mapping);
  const updated: BackgroundBatchRow = {
    ...row,
    // An incomplete stage records the boundary it reached — never the NAME of
    // the next phase, which for finalize would be 'success'.
    phase: outcome.complete ? 'success' : (stopAfter as BackgroundPhase),
    attempt: 0,
    scores: {
      extraction: scores.extraction ?? null,
      mapping: scores.mapping ?? null,
      optimization: scores.optimization ?? null,
      overall,
    },
    score: overall,
    message: sanitizeRunnerMessage(outcome.message || (outcome.complete ? 'Built' : `Completed ${stopAfter}`)),
  };
  return { cp: await persistRow(runId, deps, updated, mayHaveWrittenConfig), stageAlive: false };
}

/**
 * The run-scoped copy of a created sample, shared by every row of the same
 * source so 3 pipelines of one source cost one generation, not three.
 */
export const backgroundSampleReuseKey = (runId: string, sourcetype: string): string =>
  rowArtifactKey(runId, `sample.${kvSafeSegment(sourcetype)}`);

interface SharedSample { sampleEvents: string; sampleVerdict: 'pass' | 'unverified' }

/**
 * Create this row's sample — the first stage of a `needsSample` row.
 *
 * A generated sample is never trusted as written: the events must pass
 * `verifyGeneratedSample` (synthetic) — refusal text, bare values, events the
 * source's own parser cannot read and logs written from the sourcetype key all
 * FAIL. 'unverified' (no parser exists to check against) is accepted and
 * recorded as such. A failing sample is regenerated once, on the next tick; a
 * second failure ends the row with the reason, and nothing is saved.
 *
 * Writes no pipeline config, so nothing here ever owes the run a deploy.
 */
async function runOneSampleStage(
  runId: string,
  deps: BackgroundRunnerDeps,
  cp: BackgroundBatchCheckpoint,
  row: BackgroundBatchRow,
  markStageAlive: () => void,
): Promise<StageTickResult> {
  const stored = await deps.store.loadArtifact<BackgroundRowArtifact>(row.artifactKey);
  const request = stored?.sampleRequest;
  if (!stored || !request?.sourcetype) {
    return {
      cp: await persistRow(runId, deps, failedRow(row, 'The row artifact describing which sample to create is missing — start the run again.')),
      stageAlive: false,
    };
  }

  const advance = async (sampleEvents: string, sampleVerdict: 'pass' | 'unverified', message: string): Promise<StageTickResult> => {
    // An earlier tick may have written the artifact and then lost the row
    // update; writing the same events again is harmless.
    if (stored.sampleEvents !== sampleEvents) {
      try {
        await deps.store.saveArtifact<BackgroundRowArtifact>(row.artifactKey, {
          ...stored, sampleEvents, sampleTier: 'ai-generated', sampleVerdict,
        });
      } catch (error) {
        return {
          cp: await persistRow(runId, deps, failedRow(row, `The created sample could not be saved: ${error instanceof Error ? error.message : error}`)),
          stageAlive: false,
        };
      }
    }
    return {
      cp: await persistRow(runId, deps, {
        ...row, phase: 'sample', attempt: 0, sampleCreated: true, message: sanitizeRunnerMessage(message),
      }),
      stageAlive: false,
    };
  };

  if (stored.sampleEvents?.trim() && stored.sampleVerdict) {
    return advance(stored.sampleEvents, stored.sampleVerdict, 'Sample created and verified');
  }

  // A sibling row of the same source already created one. Only this stage
  // writes that key, and only after verification, so its verdict is trusted.
  const reuseKey = backgroundSampleReuseKey(runId, request.sourcetype);
  const shared = await deps.store.loadArtifact<SharedSample>(reuseKey).catch(() => null);
  if (shared?.sampleEvents?.trim() && (shared.sampleVerdict === 'pass' || shared.sampleVerdict === 'unverified')) {
    return advance(shared.sampleEvents, shared.sampleVerdict, 'Reused the sample created for this source');
  }

  let outcome: SampleStageOutcome;
  try {
    outcome = await deps.createSample({
      checkpoint: cp, row, sourcetype: request.sourcetype, grounding: request.grounding, attempt: row.attempt,
    });
  } catch (error) {
    outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  if (outcome.kind === 'timeout') {
    if (outcome.stageAlive === true) markStageAlive();
    const timedOut = markTimedOutStage(row);
    const recorded = timedOut.phase === 'error'
      ? failedRow(timedOut, 'Sample creation timed out twice — the row was stopped and will not be retried.')
      : { ...timedOut, message: 'Sample creation timed out — it will be retried on the next tick.' };
    try {
      return { cp: await persistRow(runId, deps, recorded), stageAlive: outcome.stageAlive === true };
    } catch (error) {
      if (outcome.stageAlive !== true) throw error;
      deps.log?.(`Background batch could not record a non-unwound sample stage: ${sanitizeRunnerMessage(error instanceof Error ? error.message : error)}`);
      return { cp, stageAlive: true };
    }
  }

  // `{}` padding holds no value and is dropped; refusal lines stay in so the
  // verifier sees them and fails the sample (src/sample-gate.ts splitNonEvents).
  const events = outcome.kind === 'sample' ? outcome.events.filter(e => typeof e === 'string' && e.trim() && !isEmptyEvent(e)) : [];
  const verification = outcome.kind === 'sample' ? verifyGeneratedSample(request.sourcetype, events, { synthetic: true }) : null;
  if (!verification || verification.verdict === 'fail') {
    const reason = outcome.kind === 'error'
      ? outcome.message
      : `the sample failed verification: ${verification?.reasons[0] || 'no usable events'}`;
    if (row.attempt === 0) {
      return {
        cp: await persistRow(runId, deps, {
          ...row, attempt: 1, message: sanitizeRunnerMessage(`Sample rejected — regenerating on the next tick: ${reason}`),
        }),
        stageAlive: false,
      };
    }
    return {
      cp: await persistRow(runId, deps, failedRow(
        { ...row, attempt: row.attempt + 1 },
        `No usable sample could be created for this source (${reason}). Upload a sample for it and start again.`,
      )),
      stageAlive: false,
    };
  }

  const sampleEvents = events.join('\n');
  const sampleVerdict = verification.verdict === 'pass' ? 'pass' : 'unverified';
  // First writer wins, best effort: losing the shared copy only costs a sibling
  // one more generation.
  try {
    const existing = await deps.store.loadArtifact<SharedSample>(reuseKey);
    if (!existing) await deps.store.saveArtifact<SharedSample>(reuseKey, { sampleEvents, sampleVerdict });
  } catch (error) {
    deps.log?.(`Background batch sample reuse not stored: ${sanitizeRunnerMessage(error instanceof Error ? error.message : error)}`);
  }
  return advance(
    sampleEvents,
    sampleVerdict,
    sampleVerdict === 'pass'
      ? `Sample created and verified (${events.length} events)`
      : `Sample created (${events.length} events) — no parser exists to verify this format against`,
  );
}

/**
 * Run ONE durable Repair/Scorecard transition for one row.
 *
 * Mirrors `runOneStage` — same lease, timeout and artifact discipline — but
 * the durable unit is a quality phase, and the config it writes belongs to the
 * run's SECOND deploy: only a transition that reports `changed` marks it, so a
 * Scorecard (which writes nothing, at any score) can never cause a deploy.
 */
async function runOneQualityStage(
  runId: string,
  deps: BackgroundRunnerDeps,
  cp: BackgroundBatchCheckpoint,
  row: BackgroundBatchRow,
  phase: QualityPhase,
  markStageAlive: () => void,
): Promise<StageTickResult> {
  const stored = await deps.store.loadArtifact<BackgroundRowArtifact>(row.artifactKey);
  const sampleEvents = typeof stored?.sampleEvents === 'string' ? stored.sampleEvents : '';
  if (!sampleEvents.trim()) {
    // Value coverage is measured against the SAMPLE (Hard Rule 12), so without
    // it there is nothing to score — and a scoreless row must not be given a
    // number (Hard Rule 32).
    return {
      cp: await persistRow(runId, deps, failedRow(row, 'The row artifact holding this source\'s sample is missing — start the run again.')),
      stageAlive: false,
    };
  }

  const action: QualityAction = row.action === 'scorecard' ? 'scorecard' : 'repair';
  const artifact = stored?.quality ?? initialQualityArtifact(action);
  if (artifact.action !== action) {
    // One of the two is stale — a manifest edited between runs, a row reused.
    // Guessing which could repair a pack somebody asked only to measure, so the
    // row ends here, having written nothing.
    //
    // Ending it is not enough on its own: the run that wrote that artifact may
    // have left a candidate live. This row is a Scorecard (the only way the two
    // can disagree while the artifact is a repair), so it may not put the best
    // conf back — the deploy is BLOCKED instead, which is the refusal that does
    // not require a write.
    const stranded = qualityNeedsRollback(artifact);
    return {
      cp: await persistRow(runId, deps, failedRow(row,
        `This ${action} row carries saved ${artifact.action} state — it was not run.`
        + `${stranded ? ' An unverified repair candidate is live on it, so the quality deploy is blocked.' : ''}`
        + ' Start the run again.'),
      stranded ? 'quality-blocked' : null),
      stageAlive: false,
    };
  }
  // Which phases can leave config behind if they do not report back: the round
  // that patches a candidate, the re-score that may roll it back, and a finalize
  // that still OWES a rollback. `repair-score` only reads, a scorecard only ever
  // reaches `repair-score`, and a finalize with nothing live writes only the
  // golden store — pre-marking that one would invent a candidate.
  const phaseMayWriteConfig = phaseMayPatchConfig(phase, artifact);
  /**
   * Could the LIVE pipeline be holding a candidate nobody verified once this
   * transition is over — including if it never reports back?
   *
   * The artifact only learns that a round patched when the round RETURNS, so a
   * stage that dies between its PATCH and its answer would look clean. This is
   * therefore pessimistic by construction: any write-capable phase with a best
   * conf to lose is treated as if it patched, and the same pessimism is written
   * to KV below so the NEXT invocation sees it too.
   */
  const mayHavePatched = qualityNeedsRollback(artifact) || (phaseMayWriteConfig && !!artifact.bestConf);

  /**
   * A repair that ends BADLY still owes the pipeline its best configuration.
   *
   * The failure itself is not the dangerous part — the live candidate nobody
   * measured is, because the run's second commit would deploy it. So instead of
   * ending the row here, the intent is written into the artifact and the row is
   * pointed at `repair-finalize`, which restores the exact best conf, stores no
   * golden and ends the row in error. If that recovery is itself impossible,
   * the quality deploy is BLOCKED rather than retried.
   */
  const windDown = async (message: string): Promise<StageTickResult> => {
    const owed: PendingDeploy = mayHavePatched ? 'quality-blocked' : null;
    if (!mayHavePatched || artifact.recovery) {
      return { cp: await persistRow(runId, deps, failedRow(row, message), owed), stageAlive: false };
    }
    try {
      await deps.store.saveArtifact<BackgroundRowArtifact>(row.artifactKey, {
        ...(stored ?? { sampleEvents }),
        sampleEvents,
        quality: beginQualityRecovery({ ...artifact, liveIsBest: false }, sanitizeRunnerMessage(message)),
      });
    } catch {
      return { cp: await persistRow(runId, deps, failedRow(row, message), 'quality-blocked'), stageAlive: false };
    }
    return {
      cp: await persistRow(runId, deps, {
        ...row,
        phase: 'repair-finalize',
        attempt: 0,
        message: sanitizeRunnerMessage(`${message} Restoring the best configuration.`),
      }),
      stageAlive: false,
    };
  };

  if (mayHavePatched && artifact.liveIsBest) {
    // Written BEFORE the stage runs, and deliberately not handed to the engine:
    // the stored copy records "a PATCH may be in flight", while the transition
    // itself still sees the true state (so it does not restore a conf that was
    // never replaced). A successful transition overwrites this with the truth.
    try {
      await deps.store.saveArtifact<BackgroundRowArtifact>(row.artifactKey, {
        ...(stored ?? { sampleEvents }),
        sampleEvents,
        quality: { ...artifact, liveIsBest: false },
      });
    } catch (error) {
      return {
        cp: await persistRow(runId, deps, failedRow(row,
          `The quality checkpoint could not be saved before the repair: ${error instanceof Error ? error.message : error}`)),
        stageAlive: false,
      };
    }
  }

  let outcome: QualityStageOutcome;
  try {
    outcome = await deps.runQualityStage({
      checkpoint: cp,
      row,
      packId: deps.packId(row.packName),
      phase,
      action,
      artifact,
      // Hard Rule 27: every pipeline of a sourcetype parses the SAME sample.
      sampleName: getSampleName(row.sourcetype),
      sampleEvents,
    });
  } catch (error) {
    outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  if (outcome.kind === 'timeout') {
    if (outcome.stageAlive === true) {
      // See runOneStage: tell the tick before any KV write, so a persist that
      // fails cannot release the lease while a repair may still be PATCHing.
      markStageAlive();
      const timedOut = markTimedOutStage(row);
      const message = sanitizeRunnerMessage(outcome.message || 'The quality stage passed its deadline without stopping.');
      const recorded = timedOut.phase === 'error' ? failedRow(timedOut, message) : { ...timedOut, message };
      try {
        // A repair that may still be alive may already have written config, so
        // the second commit is owed whether or not it reports back.
        return { cp: await persistRow(runId, deps, recorded, phaseMayWriteConfig ? 'quality' : null), stageAlive: true };
      } catch (error) {
        deps.log?.(`Background batch could not record a non-unwound quality stage: ${sanitizeRunnerMessage(error instanceof Error ? error.message : error)}`);
        return { cp, stageAlive: true };
      }
    }
    // Same conservatism as a build stage: a transition that ended part-way may
    // already have PATCHed, so the second commit is owed either way. Committing
    // config nobody deploys is the failure this avoids.
    const owed: PendingDeploy = phaseMayWriteConfig ? 'quality' : null;
    const timedOut = markTimedOutStage(row);
    if (timedOut.phase === 'error') {
      // Out of retries — but not out of obligations: the rollback is the one
      // piece of work a dead row is still allowed to cause.
      return windDown('The quality stage timed out twice — the row was stopped and will not be retried.');
    }
    return {
      cp: await persistRow(runId, deps, {
        ...timedOut,
        message: 'The quality stage timed out — it will be retried on the next tick.',
      }, owed),
      stageAlive: false,
    };
  }

  if (outcome.kind === 'error') return windDown(outcome.message);

  try {
    await deps.store.saveArtifact<BackgroundRowArtifact>(row.artifactKey, {
      ...(stored ?? { sampleEvents }),
      sampleEvents,
      quality: outcome.artifact,
    });
  } catch (error) {
    return {
      cp: await persistRow(
        runId, deps,
        failedRow(row, `Quality checkpoint could not be saved: ${error instanceof Error ? error.message : error}`),
        outcome.changed ? 'quality' : null,
      ),
      stageAlive: false,
    };
  }

  const result = outcome.result;
  const nextPhase: BackgroundPhase = outcome.nextPhase
    ?? (outcome.status === 'error' ? 'error' : 'success');
  const updated: BackgroundBatchRow = {
    ...row,
    phase: nextPhase,
    attempt: 0,
    // The headline score is the score the run DEPLOYED — the best measured one,
    // not whatever the last trial happened to produce.
    score: result ? result.deploymentScore : (row.score ?? null),
    quality: result
      ? {
          action,
          flow: result.flow,
          firstScore: result.firstScore,
          finalScore: result.finalScore,
          deploymentScore: result.deploymentScore,
          trialScores: result.trialScores,
          rounds: result.rounds,
          stored: result.stored,
          storedValue: result.storedValue,
          changed: result.changed,
        }
      : row.quality,
    message: sanitizeRunnerMessage(outcome.message || row.message || `Completed ${phase}`),
  };
  return {
    cp: await persistRow(runId, deps, updated, outcome.changed ? 'quality' : null),
    stageAlive: false,
  };
}

/**
 * Decide what the run's state is now: still working, deployed and done, or
 * stuck on a failed commit.
 */
async function finishTick(
  runId: string,
  deps: BackgroundRunnerDeps,
  current: BackgroundBatchCheckpoint,
  processed: number,
): Promise<BackgroundTickResult> {
  let cp = (await deps.store.loadRun(runId)) ?? current;
  // Killed (or failed) while this invocation was mid-stage: the run is over and
  // nothing from here may commit — a Kill promises the operator exactly that.
  if (isRunInactive(cp)) return { status: cp.status as BackgroundTickStatus, processed, message: cp.message };
  const stopping = cp.status === 'stopping';

  if (stopping) {
    // Stop is allowed exactly one kind of work, and it is not new work: putting
    // the best conf back under any repair candidate that is live but unverified.
    // Skipping the row without it would leave that candidate to be committed
    // and deployed by the very next lines.
    cp = await rollBackStoppedRepairs(deps, cp);
    const unfinished = cp.rows.filter(r => !isTerminal(r));
    if (unfinished.length) {
      cp = {
        ...cp,
        rows: cp.rows.map(r => (isTerminal(r) ? r : { ...r, phase: 'skipped' as const, message: 'Stopped by user' })),
        updatedAt: deps.now(),
      };
      await deps.store.saveRun(cp);
    }
  } else if (selectBuildRow(cp)) {
    return { status: 'running', processed };
  }

  // Every build row is terminal (or the run was stopped): commit ONCE.
  const build = await commitOnce(runId, deps, cp, 'build', stopping, processed);
  if (!build.ok) return build.result;
  cp = build.cp;

  // Repair/Scorecard read LIVE pipelines, so they run only now — after the
  // build commit above deployed what they are about to measure. They are NOT
  // parked: the run stays `running` on its existing schedule and takes one
  // quality transition per tick (see `selectQualityRow`).
  if (!stopping && selectQualityRow(cp)) {
    return { status: 'running', processed };
  }

  // The SECOND and last deploy of the run, and only if a repair actually
  // rewrote config: every repair PATCH deferred its deploy, so this is one
  // commit for all of them together rather than one per round.
  const quality = await commitOnce(runId, deps, cp, 'quality', stopping, processed);
  if (!quality.ok) return quality.result;
  cp = quality.cp;

  cp = { ...cp, status: 'done', updatedAt: deps.now() };
  await deps.store.saveRun(cp);
  // Terminal completion is the ONLY time the schedule goes away — and the
  // manifest stays until the user dismisses it.
  await bestEffortDeleteSchedule(deps, runId, cp.scheduleId);
  return { status: 'done', processed };
}

/**
 * Put the best measured configuration back under every repair the Stop caught
 * mid-flight, before the run's last commit.
 *
 * The rollback runs through the ordinary `repair-finalize` transition (marked
 * as a recovery, so it restores and stores nothing) rather than a second,
 * Stop-only code path — the same rules, minus the new work. A rollback that
 * cannot be performed BLOCKS the quality deploy: leaving a candidate live but
 * undeployed is recoverable, deploying it is not.
 */
async function rollBackStoppedRepairs(
  deps: BackgroundRunnerDeps,
  current: BackgroundBatchCheckpoint,
): Promise<BackgroundBatchCheckpoint> {
  let cp = current;
  for (const row of cp.rows) {
    if (row.resultGroup !== 'quality' || isTerminal(row)) continue;
    let stored: BackgroundRowArtifact | null = null;
    try {
      stored = await deps.store.loadArtifact<BackgroundRowArtifact>(row.artifactKey);
    } catch {
      continue;
    }
    const sampleEvents = typeof stored?.sampleEvents === 'string' ? stored.sampleEvents : '';
    const artifact = stored?.quality;
    if (!artifact || !qualityNeedsRollback(artifact)) continue;

    const outcome = await deps.runQualityStage({
      checkpoint: cp,
      row,
      packId: deps.packId(row.packName),
      phase: 'repair-finalize',
      action: 'repair',
      artifact: beginQualityRecovery(artifact, 'Stopped by user'),
      sampleName: getSampleName(row.sourcetype),
      sampleEvents,
    }).catch(error => ({ kind: 'error' as const, message: error instanceof Error ? error.message : String(error) }));

    if (outcome.kind !== 'quality') {
      deps.log?.(`Background batch could not restore ${row.pipelineId} after Stop — the quality deploy is blocked.`);
      cp = { ...cp, qualityDeployStatus: 'blocked', updatedAt: deps.now() };
      await deps.store.saveRun(cp);
      continue;
    }
    try {
      await deps.store.saveArtifact<BackgroundRowArtifact>(row.artifactKey, { ...stored, sampleEvents, quality: outcome.artifact });
    } catch {
      // The pipeline is restored; only the record of it was lost.
    }
  }
  return cp;
}

type CommitAttempt =
  | { ok: true; cp: BackgroundBatchCheckpoint }
  | { ok: false; result: BackgroundTickResult };

/**
 * Commit+deploy one of the run's two deployments, if it has anything pending.
 * A run reaches this twice — once for the build config, once for whatever the
 * repair rounds rewrote — and each is a no-op unless a row marked it pending,
 * so a run with no repairs deploys exactly once.
 */
async function commitOnce(
  runId: string,
  deps: BackgroundRunnerDeps,
  current: BackgroundBatchCheckpoint,
  which: Exclude<PendingDeploy, null>,
  stopping: boolean,
  processed: number,
): Promise<CommitAttempt> {
  let cp = current;
  const status = which === 'build' ? cp.deployStatus : (cp.qualityDeployStatus ?? 'not-needed');
  if (status !== 'pending' && status !== 'failed') return { ok: true, cp };

  const write = (value: 'deployed' | 'failed'): BackgroundBatchCheckpoint =>
    which === 'build' ? { ...cp, deployStatus: value } : { ...cp, qualityDeployStatus: value };

  cp = { ...cp, status: stopping ? 'stopping' : 'committing', updatedAt: deps.now() };
  await deps.store.saveRun(cp);
  try {
    await deps.commitDeploy(cp.workerGroup, `Deploy background batch ${runId}`);
    // Written back immediately: the build commit is followed by the quality
    // rows, and a manifest left saying `committing` while those run would tell
    // the UI a deploy is in flight for as long as they take.
    cp = { ...write('deployed'), status: stopping ? 'stopping' : 'running', updatedAt: deps.now() };
    await deps.store.saveRun(cp);
    return { ok: true, cp };
  } catch (error) {
    // Visible failure, recoverable run: the schedule stays, and the next tick
    // retries the commit. Never report a deploy that did not happen.
    const message = sanitizeRunnerMessage(error instanceof Error ? error.message : error);
    cp = { ...write('failed'), status: stopping ? 'stopping' : 'running', updatedAt: deps.now() };
    await deps.store.saveRun(cp);
    deps.log?.(`Background batch commit failed: ${message}`);
    return { ok: false, result: { status: 'deploy-failed', processed, message } };
  }
}

/**
 * Drop the lease without touching anything else. Re-reads first so a Stop (or a
 * row result) written by someone else since our last write survives.
 */
async function releaseOwnedLease(runId: string, deps: BackgroundRunnerDeps): Promise<void> {
  try {
    const fresh = await deps.store.loadRun(runId);
    if (!fresh || fresh.lease?.owner !== deps.invocationId) return;
    await deps.store.saveRun(releaseLease(fresh, deps.invocationId));
  } catch (error) {
    // A lease that cannot be released simply expires; never fail a tick on it.
    deps.log?.(`Background batch lease release failed: ${sanitizeRunnerMessage(error instanceof Error ? error.message : error)}`);
  }
}
