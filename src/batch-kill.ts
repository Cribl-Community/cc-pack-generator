// Kill — the escape hatch for when Stop does not work.
//
// Stop is cooperative in both run modes. In the foreground it only prevents NEW
// rows from starting and waits for the rows in flight; one request that never
// settles (an AI call, a preview) keeps the screen on "Stopping…" forever. In the
// background it writes `status: 'stopping'` and waits for the next tick to wind
// the run down — but a tick only does that once it holds the lease, and an
// invocation that hung mid-stage keeps the lease, so every tick answers `busy`.
//
// Kill does not wait for anything. It ends the run NOW and abandons whatever is
// still in flight: those rows are recorded as killed, not as built, and nothing
// is committed. Config an abandoned row already wrote stays uncommitted on the
// worker group (the batch defers every deploy to one commit at the end).

import type { BackgroundBatchCheckpoint } from './background-batch';
import { fitRunManifest } from './background-batch-store';

export const KILL_LABEL = '✖ Kill';
export const KILL_CONFIRM_LABEL = 'Confirm kill — abandon rows in flight';

export const KILLED_ROW_MESSAGE = 'Killed by user — abandoned mid-build; any config it wrote is not committed.';
export const KILLED_PENDING_MESSAGE = 'Killed by user';
export const KILLED_RUN_MESSAGE = 'Killed by user; unfinished rows abandoned, nothing committed.';

/** The statuses a foreground row can be in while the run still owes it work. */
const FOREGROUND_UNSETTLED = new Set(['pending', 'running']);

/**
 * Settle every foreground row the run still owes: a row that was mid-build is an
 * error (it did NOT finish), a row that never started is skipped. Rows parked on
 * a user decision (awaiting-confirmation/-sample) are left alone — they are not
 * part of the hung loop and their buttons still work.
 */
export function killForegroundResults<T extends { status: string; phase?: string; message?: string }>(results: readonly T[]): T[] {
  return results.map(r => {
    if (!FOREGROUND_UNSETTLED.has(r.status)) return r;
    return r.status === 'running'
      ? { ...r, status: 'error', phase: 'done', message: KILLED_ROW_MESSAGE } as T
      : { ...r, status: 'skipped', phase: 'done', message: KILLED_PENDING_MESSAGE } as T;
  });
}

const BACKGROUND_TERMINAL = new Set(['success', 'error', 'skipped']);

/**
 * The manifest a Kill writes: terminal (`error`, so every runner tick from here
 * on is a no-op and Dismiss is offered), lease dropped, and every unfinished
 * row settled by PHASE alone — a row past `queued` was in flight (error), one
 * still `queued` never started (skipped). No per-row message: the run message
 * says what happened, and a kill must never be the write that overflows.
 */
export function killBackgroundCheckpoint(cp: BackgroundBatchCheckpoint, now: number): BackgroundBatchCheckpoint {
  const { lease: _lease, ...rest } = cp;
  return fitRunManifest({
    ...rest,
    status: 'error',
    message: KILLED_RUN_MESSAGE,
    rows: cp.rows.map(r => {
      if (BACKGROUND_TERMINAL.has(r.phase)) return r;
      const { message: _m, ...row } = r;
      return { ...row, phase: r.phase === 'queued' ? 'skipped' as const : 'error' as const };
    }),
    updatedAt: now,
  });
}
