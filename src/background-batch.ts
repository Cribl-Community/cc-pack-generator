/**
 * Checkpoint shape shared between the browser (src/App.tsx, via api.ts) and
 * the "Batch — Background" Backend Function (backend/run-batch-step.ts).
 * Living in `src/` (not `backend/`) keeps the dependency direction one-way —
 * the backend function imports from `src/`, never the reverse.
 */
import type { BackgroundAiSnapshot } from './settings-store';
import type { StagedBuildArtifact } from './staged-build';
import type { QualityArtifact } from './quality-stage';
import type { SampleGrounding } from './pack-builder';
export type { BackgroundAiSnapshot } from './settings-store';

export type BackgroundConflictAction = 'overwrite' | 'skip' | 'repair' | 'scorecard';
export type BackgroundPhase =
  | 'queued' | 'sample' | 'extraction' | 'mapping' | 'optimization' | 'finalize'
  | 'repair-score' | 'repair-round' | 'repair-rescore' | 'repair-finalize'
  | 'success' | 'error' | 'skipped';

export interface BackgroundBatchRow {
  rowId: string;
  order: number;
  resultGroup: 'build' | 'quality';
  action: BackgroundConflictAction;
  phase: BackgroundPhase;
  attempt: number;
  artifactKey: string;
  sourcetype: string;
  outputSourcetype?: string;
  packName: string;
  pipelineId: string;
  destFormat: string;
  cimModel?: string;
  /**
   * The route filter the CSV asked for, already normalized. Carried so a
   * background run routes the same slice of data the same CSV routes in the
   * foreground; absent means the builder's own `sourcetype=='<st>'` default.
   */
  routeFilter?: string;
  /**
   * No store had a sample for this source when the run started, so the row's
   * FIRST background stage creates one (Cribl AI) and verifies it before any
   * extraction runs. Set by the manifest builder only.
   */
  needsSample?: boolean;
  /** The sample stage produced a verified sample — durable proof for the rail. */
  sampleCreated?: boolean;
  message?: string;
  /** The row's headline score — the overall below, kept for existing readers. */
  score?: number | null;
  /**
   * Per-stage scores, recorded as each stage checkpoints so a run that is still
   * mid-flight (or ended early) still reports what it measured. `overall` is
   * `(extraction + mapping) / 2` — the authoritative pack score — and is never
   * derived from optimization.
   */
  scores?: {
    extraction?: number | null;
    mapping?: number | null;
    optimization?: number | null;
    overall?: number | null;
  };
  /**
   * What a Repair/Scorecard row measured, as BOUNDED metadata. The full report
   * and findings stay in the row artifact; these are the fields the final report
   * and the completion event need, and they are the ones Hard Rule 15 names:
   * first score, deployment score, the per-trial scores, the flow and whether a
   * golden was stored. Every score here may legitimately be NULL — an unscored
   * row must never be reported as a zero (Hard Rule 32).
   */
  quality?: {
    action: 'repair' | 'scorecard';
    flow: 'normal' | 'repair';
    firstScore: number | null;
    finalScore: number | null;
    deploymentScore: number | null;
    trialScores: (number | null)[];
    rounds: number;
    stored: boolean;
    storedValue: number | null;
    /** A repair PATCHed live config, so this run owes exactly one more commit. */
    changed: boolean;
  };
}

export interface BackgroundBatchCheckpoint {
  runId: string;
  workerGroup: string;
  /**
   * `awaiting-quality` is LEGACY and no runner produces it any more: quality
   * rows now run on the same schedule, straight after the build commit. It
   * survives in this union only because manifests written by an earlier build
   * are still in KV, and the runner resumes those to `running` on sight.
   */
  status: 'starting' | 'running' | 'stopping' | 'committing' | 'awaiting-quality' | 'done' | 'error';
  ai: BackgroundAiSnapshot;
  /** Why the run is in its current state, when that needs saying (run-level faults). */
  message?: string;
  scheduleId?: string;
  deployStatus: 'not-needed' | 'pending' | 'deployed' | 'failed';
  /**
   * The SECOND deployment, owed only by Repair rows that actually changed live
   * config. Kept apart from `deployStatus` on purpose: the build commit must
   * land BEFORE any quality row reads a live pipeline, and the repair commit
   * must land exactly once AFTER every quality row is done — never one per
   * round and never one per row. A Scorecard never sets it, so a read-only run
   * deploys nothing a second time.
   *
   * `blocked` is a refusal, not a failure to retry: a repair candidate is live,
   * nobody could measure it and nobody could put the best configuration back,
   * so the deploy would ship exactly what best-score-wins exists to prevent.
   * An un-deployed candidate is recoverable; a deployed one is not.
   */
  qualityDeployStatus?: 'not-needed' | 'pending' | 'deployed' | 'failed' | 'blocked';
  lease?: { owner: string; expiresAt: number };
  rows: BackgroundBatchRow[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Everything UNBOUNDED about a row, kept out of the manifest.
 *
 * The checkpoint above is polled by the browser every few seconds and rewritten
 * by the runner on every stage, so it must stay small, bounded metadata. A
 * row's sample is customer event text and its staged-build checkpoint holds
 * preview events and function bodies — both belong in the run-scoped artifact,
 * which is read once per stage and written once per stage.
 *
 * `sampleEvents` is either resolved in the foreground pre-flight (a store,
 * library or uploaded sample) or, for a row marked `needsSample`, left empty
 * and written ONCE by the row's sample stage — which generates with Cribl AI
 * inside one 280-second stage and keeps the events only if they pass
 * `verifyGeneratedSample`. After that it is immutable for the life of the run.
 */
export interface BackgroundRowArtifact {
  /** The exact pre-flight sample text this row builds from. Never logged. */
  sampleEvents: string;
  /** Which tier supplied the sample — provenance for the score event, not data. */
  sampleTier?: string;
  /**
   * `'paste'` when the sample is the row's own CSV cell (src/batch-row-sample.ts):
   * the user's events, which "Require sanitised samples" keeps out of AI prompts.
   * Absent for a store-resolved sample.
   */
  sampleSourceMode?: string;
  /** True after the foreground reviewer applied the shared sanitizer. */
  sampleSanitised?: boolean;
  /** How long the foreground took to resolve it, when pre-flight measured it. */
  prepareMs?: number;
  /**
   * What the sample stage generates from, for a `needsSample` row: the key the
   * sample is resolved under (the raw channel for Windows), and the grounding
   * the foreground would have used — computed at handoff from the row's
   * destination formats, which the runner no longer has.
   */
  sampleRequest?: { sourcetype: string; grounding?: SampleGrounding };
  /** The verification verdict of a background-created sample. */
  sampleVerdict?: 'pass' | 'unverified';
  /** The resumable staged-build checkpoint, written by each completed stage. */
  build?: StagedBuildArtifact;
  /**
   * The resumable quality checkpoint for a Repair/Scorecard row, written after
   * EVERY transition. It holds the best conf the rollback restores, so losing
   * it would cost best-score-wins its baseline.
   */
  quality?: QualityArtifact;
}

/** One run-scoped artifact document to write before a run may be scheduled. */
export interface BackgroundArtifactWrite {
  key: string;
  value: BackgroundRowArtifact;
}

export const backgroundScheduleId = (runId: string): string => `batch-bg-${runId}`;

// The one KV key both sides read/write — a single source of truth so the
// browser and the backend function can't drift onto different keys.
export const BATCH_BG_KV_KEY = 'batch-run/background';
