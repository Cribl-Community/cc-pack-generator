// Batch Build screen (in this tab): rows grouped into pack cards, a stage rail
// per row, the header tallies and the timed rows the "time left" reads from.
// Pure data over the BatchResult fields the screen needs, no React. The
// background screen keeps its own projection (buildBackgroundRunView); both
// render with the same rail states so the two screens look the same.

import type { BatchPhase } from './batch-runtime';
import type { BuildPath, TimedRow } from './batch-estimate';
import type { RailStepState } from './background-progress-view';

export type BuildRowStatus =
  | 'pending' | 'running' | 'success' | 'error' | 'skipped'
  | 'awaiting-confirmation' | 'awaiting-sample';

export interface BuildRowLike {
  row: { pack_name: string };
  status: BuildRowStatus;
  phase?: BatchPhase;
  stageReport?: { source: string }[];
  timings?: { totalMs?: number };
  repairedAfterBuild?: boolean;
}

export interface RailStep { key: string; label: string; state: RailStepState }

const STAGES = [
  { key: 'prepare', label: 'Prepare', phases: ['preparing'] },
  { key: 'build', label: 'Build', phases: ['building'] },
  { key: 'deploy', label: 'Deploy', phases: ['deploying', 'deployed'] },
  { key: 'score', label: 'Score', phases: ['scoring'] },
  { key: 'repair', label: 'Repair', phases: ['repairing'] },
] as const;

function stageIndex(phase: BatchPhase | undefined): number {
  if (!phase || phase === 'queued') return -1;
  if (phase === 'done') return STAGES.length;
  return STAGES.findIndex(s => (s.phases as readonly string[]).includes(phase));
}

export const needsYou = (r: Pick<BuildRowLike, 'status'>) =>
  r.status === 'awaiting-confirmation' || r.status === 'awaiting-sample';

export const isSettled = (r: Pick<BuildRowLike, 'status' | 'phase'>) =>
  r.phase === 'done' || r.status === 'error' || r.status === 'skipped';

/** Prepare → Build → Deploy → Score → Repair for one in-tab row. */
export function foregroundRail(r: BuildRowLike): RailStep[] {
  const at = stageIndex(r.phase);
  const failed = r.status === 'error';
  const parked = needsYou(r);
  return STAGES.map((s, i) => {
    let state: RailStepState;
    if (at >= STAGES.length) {
      // Finished: Repair only counts as done when a repair actually ran.
      state = s.key === 'repair' && !r.repairedAfterBuild ? 'skipped' : 'done';
      if (failed && i === STAGES.length - 1) state = 'failed';
    } else if (i < at) state = 'done';
    else if (i === at) state = failed ? 'failed' : parked ? 'pending' : 'active';
    else state = r.status === 'skipped' ? 'skipped' : 'pending';
    // A row that failed before any stage started marks Prepare as the failure.
    if (failed && at < 0 && i === 0) state = 'failed';
    return { key: s.key, label: s.label, state };
  });
}

export type PackCardState = 'run' | 'ok' | 'err' | 'warn' | 'q';

export interface PackCard {
  id: string;
  name: string;
  /** Indexes into the results array, in file order. */
  rows: number[];
  state: PackCardState;
  stateLabel: string;
}

function cardState(rows: BuildRowLike[]): { state: PackCardState; label: string } {
  if (rows.some(needsYou)) return { state: 'warn', label: 'Needs you' };
  if (rows.some(r => r.status === 'error')) return { state: 'err', label: `${rows.filter(r => r.status === 'error').length} failed` };
  if (rows.every(isSettled)) {
    return rows.every(r => r.status === 'skipped')
      ? { state: 'q', label: 'Skipped' }
      : { state: 'ok', label: 'Built' };
  }
  if (rows.some(r => r.status === 'running' || (r.phase && r.phase !== 'queued' && r.phase !== 'done'))) return { state: 'run', label: 'Building' };
  return { state: 'q', label: 'Queued' };
}

/** Rows grouped by pack id, in the order each pack first appears in the file. */
export function packCards(results: readonly BuildRowLike[], packId: (name: string) => string): PackCard[] {
  const order: string[] = [];
  const byId = new Map<string, { name: string; rows: number[] }>();
  results.forEach((r, i) => {
    const id = packId(r.row.pack_name);
    if (!byId.has(id)) { byId.set(id, { name: r.row.pack_name, rows: [] }); order.push(id); }
    byId.get(id)!.rows.push(i);
  });
  return order.map(id => {
    const g = byId.get(id)!;
    const { state, label } = cardState(g.rows.map(i => results[i]));
    return { id, name: g.name, rows: g.rows, state, stateLabel: label };
  });
}

export interface BuildCounts {
  building: number;
  built: number;
  needYou: number;
  failed: number;
  queued: number;
  skipped: number;
  settled: number;
  total: number;
}

export function buildCounts(results: readonly BuildRowLike[]): BuildCounts {
  const c: BuildCounts = { building: 0, built: 0, needYou: 0, failed: 0, queued: 0, skipped: 0, settled: 0, total: results.length };
  for (const r of results) {
    if (isSettled(r)) c.settled++;
    if (needsYou(r)) c.needYou++;
    else if (r.status === 'error') c.failed++;
    else if (r.status === 'skipped') c.skipped++;
    else if (r.status === 'success' && r.phase === 'done') c.built++;
    else if (!r.phase || r.phase === 'queued' || r.status === 'pending') c.queued++;
    else c.building++;
  }
  return c;
}

/** Finished rows of this run with their measured path, for measuredTimeLeft. */
export function timedRows(results: readonly BuildRowLike[], fallback: BuildPath = 'ai'): TimedRow[] {
  return results
    .filter(r => r.status === 'success' && typeof r.timings?.totalMs === 'number' && r.timings.totalMs > 0)
    .map(r => ({
      path: r.stageReport?.length ? (r.stageReport.some(s => s.source === 'golden') ? 'golden' : 'ai') : fallback,
      totalMs: r.timings!.totalMs!,
    }));
}
