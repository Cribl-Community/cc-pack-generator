/**
 * Pure durable background-batch domain helpers — no network, React, or App APIs.
 */
import type {
  BackgroundBatchCheckpoint,
  BackgroundBatchRow,
  BackgroundPhase,
} from './background-batch';
import { backgroundRunIdOf, isBackgroundBatchTransientReadError } from './background-batch-errors';

const TERMINAL_PHASES = new Set<BackgroundPhase>(['success', 'error', 'skipped']);

const BUILD_SEQUENCE: BackgroundPhase[] = [
  'queued', 'extraction', 'mapping', 'optimization', 'finalize', 'success',
];

const REPAIR_SEQUENCE: BackgroundPhase[] = [
  'repair-score', 'repair-round', 'repair-rescore', 'repair-finalize', 'success',
];

function advanceInSequence(current: BackgroundPhase, sequence: BackgroundPhase[]): BackgroundPhase {
  const idx = sequence.indexOf(current);
  if (idx < 0 || idx >= sequence.length - 1) return current;
  return sequence[idx + 1]!;
}

const RESULT_GROUP_ORDER: Record<BackgroundBatchRow['resultGroup'], number> = {
  build: 0,
  quality: 1,
};

/**
 * A group this build has never heard of sorts after the ones it has. The
 * manifest is durable, so a run written by a later version can be read here —
 * and an unknown key used to make the comparator return NaN, which leaves the
 * ENTIRE ledger in whatever order the engine happened to produce.
 */
const resultGroupRank = (group: BackgroundBatchRow['resultGroup']): number =>
  RESULT_GROUP_ORDER[group] ?? Object.keys(RESULT_GROUP_ORDER).length;

export function orderedBackgroundRows(rows: BackgroundBatchRow[]): BackgroundBatchRow[] {
  return [...rows].sort((a, b) => {
    const g = resultGroupRank(a.resultGroup) - resultGroupRank(b.resultGroup);
    if (g !== 0) return g;
    return a.order - b.order;
  });
}

export function nextBackgroundPhase(row: BackgroundBatchRow): BackgroundPhase {
  if (TERMINAL_PHASES.has(row.phase)) return row.phase;

  if (row.action === 'skip') {
    if (row.phase === 'queued') return 'skipped';
    return row.phase;
  }

  if (row.action === 'scorecard') {
    if (row.phase === 'queued') return 'repair-score';
    if (row.phase === 'repair-score') return 'success';
    return row.phase;
  }

  if (row.action === 'repair') {
    if (row.phase === 'queued') return 'repair-score';
    return advanceInSequence(row.phase, REPAIR_SEQUENCE);
  }

  // A row with no sample creates one first; every other row starts at
  // extraction. 'sample' is outside BUILD_SEQUENCE so a queued row that already
  // has its events never detours through it.
  if (row.phase === 'queued' && row.needsSample) return 'sample';
  if (row.phase === 'sample') return 'extraction';
  return advanceInSequence(row.phase, BUILD_SEQUENCE);
}

export function claimLease(
  cp: BackgroundBatchCheckpoint,
  owner: string,
  now: number,
  ttlMs: number,
): BackgroundBatchCheckpoint | null {
  if (cp.lease && cp.lease.expiresAt > now && cp.lease.owner !== owner) return null;
  return {
    ...cp,
    updatedAt: now,
    lease: { owner, expiresAt: now + ttlMs },
  };
}

export function releaseLease(cp: BackgroundBatchCheckpoint, owner: string): BackgroundBatchCheckpoint {
  if (!cp.lease || cp.lease.owner !== owner) return cp;
  const { lease: _lease, ...rest } = cp;
  return { ...rest, updatedAt: cp.updatedAt };
}

/** What the operator may do about a run, and what it should be called. */
export interface BackgroundRunPresentation {
  /** Work is genuinely still moving — a tick may run at any moment. */
  active: boolean;
  /** Offer Stop. */
  stoppable: boolean;
  /** Offer a way out: the run will never move again on its own. */
  dismissible: boolean;
  /** One phrase for the operator. Never "running" unless it is. */
  label: string;
}

const RUN_PRESENTATION: Record<BackgroundBatchCheckpoint['status'], BackgroundRunPresentation> = {
  starting: { active: true, stoppable: true, dismissible: false, label: 'Starting' },
  running: { active: true, stoppable: true, dismissible: false, label: 'Running' },
  committing: { active: true, stoppable: true, dismissible: false, label: 'Committing and deploying' },
  // Stop has already been asked for; the next tick winds the run down. Asking
  // again would write the same flag a second time and say nothing new.
  stopping: { active: true, stoppable: false, dismissible: false, label: 'Stopping' },
  // The three states that will never move again on their own. Each needs an
  // escape, or the operator is left with a banner they cannot clear and a
  // Start they cannot reach. `awaiting-quality` is LEGACY — quality rows now
  // run on the run's own schedule and the runner resumes a parked manifest on
  // sight — but a manifest written before that is still in KV, and until its
  // owner presses Start it must stay dismissible rather than look active.
  'awaiting-quality': { active: false, stoppable: false, dismissible: true, label: 'Parked — waiting to resume its quality rows' },
  done: { active: false, stoppable: false, dismissible: true, label: 'Finished' },
  error: { active: false, stoppable: false, dismissible: true, label: 'Failed' },
};

const NO_RUN: BackgroundRunPresentation = { active: false, stoppable: false, dismissible: false, label: '' };

export function backgroundStatusPresentation(
  status: BackgroundBatchCheckpoint['status'] | undefined,
): BackgroundRunPresentation {
  if (!status) return NO_RUN;
  return RUN_PRESENTATION[status] ?? NO_RUN;
}

export function backgroundRunPresentation(
  cp: BackgroundBatchCheckpoint | null | undefined,
): BackgroundRunPresentation {
  return backgroundStatusPresentation(cp?.status);
}

export type BackgroundPollOutcome =
  | { ok: true; checkpoint: BackgroundBatchCheckpoint | null }
  | {
    ok: false;
    error: string;
    /**
     * Repeating this read cannot fix it (a corrupt document, a refusal) — as
     * opposed to the transient default, which very likely succeeds next tick.
     * Opt-in: an unclassified failure is read as transient, because that is the
     * reading that keeps the run on screen and offers nothing destructive.
     */
    permanent?: boolean;
    /** The run the read was about, when the caller knew but got no manifest. */
    runId?: string;
  };

/**
 * Turn a caught read error into the outcome the fold expects.
 *
 * There are three places a background read can fail — the mount/Retry read of
 * the active pointer, the 4-second poll, and the reload Stop does after its
 * write — and the classification has to be identical in all three. It was not:
 * only the mount read worked out whether a failure was permanent, so the SAME
 * corrupt document was an escapable dead end when the app was reopened and an
 * endless "could not be read just now" when the progress screen happened to be
 * the one that found it. Which timer catches a failure cannot be what decides
 * whether the operator is offered a way out.
 *
 * `runId` is passed by the callers that read by id; the one that reads
 * "whatever is active" has no id until the failed read hands it back.
 */
export function backgroundReadFailure(error: unknown, runId?: string): BackgroundPollOutcome {
  const id = runId ?? backgroundRunIdOf(error);
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    // Anything the store did not call transient will answer the same way
    // forever: a corrupt document, a refusal, a path that does not exist.
    permanent: !isBackgroundBatchTransientReadError(error),
    ...(id ? { runId: id } : {}),
  };
}

export const BACKGROUND_READ_UNAVAILABLE =
  'The background run could not be read just now — showing the last state it reported.';

/**
 * Fold a poll/reload result into what the screen should show.
 *
 * The rule is Hard Rule 32 applied to a read: a read that failed must not
 * present itself as a result. Blanking the checkpoint on a failed or empty read
 * would report a run that is still ticking on the server as gone — and the
 * operator's next move (press Start again) would then collide with it. So the
 * last known state stays on screen and the failure is said out loud; only a
 * successful read replaces it, and only an explicit dismiss clears it.
 */
export function reconcileBackgroundPoll(
  previous: BackgroundBatchCheckpoint | null,
  outcome: BackgroundPollOutcome,
): { checkpoint: BackgroundBatchCheckpoint | null; error: string } {
  if (!outcome.ok) return { checkpoint: previous, error: outcome.error };
  if (outcome.checkpoint) return { checkpoint: outcome.checkpoint, error: '' };
  // Nothing known and nothing found is the ordinary "no background run
  // exists" answer on mount, not a fault.
  return { checkpoint: previous, error: previous ? BACKGROUND_READ_UNAVAILABLE : '' };
}

export function shouldRetryTimedOutStage(row: BackgroundBatchRow): boolean {
  return row.attempt === 0;
}

export function markTimedOutStage(row: BackgroundBatchRow): BackgroundBatchRow {
  if (TERMINAL_PHASES.has(row.phase)) return row;
  if (shouldRetryTimedOutStage(row)) {
    return { ...row, attempt: row.attempt + 1 };
  }
  return { ...row, phase: 'error', attempt: row.attempt + 1 };
}
