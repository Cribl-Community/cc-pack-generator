// Batch time estimates — measured only, never guessed.
//
// A batch row's build time depends almost entirely on its path: a golden row
// reuses a tested parser and mapping, an AI row asks the model for both. So the
// only honest estimate is a per-path average of rows this browser actually
// built. It is saved when a batch finishes; with nothing saved yet the Run
// setup screen says "after first rows" and the Build screen shows time left
// once rows of this run have finished.
//
// Pure functions plus a thin localStorage wrapper, no React.

export type BuildPath = 'golden' | 'ai';

export interface PathAverage {
  /** Rows the average is made of (capped, so old batches fade out). */
  n: number;
  avgMs: number;
}

export interface RowTimingStats {
  golden: PathAverage;
  ai: PathAverage;
  /** Batches that contributed at least one timed row. */
  batches: number;
}

export interface TimedRow {
  path: BuildPath;
  totalMs: number;
}

export const ROW_TIMINGS_KEY = 'pg.batch.rowTimings.v1';
/** A running average over at most this many rows per path. */
export const ROW_TIMINGS_WINDOW = 200;
/** Background runs advance one row per scheduled tick (`* * * * *`). */
export const BACKGROUND_TICK_MS = 60_000;

export const EMPTY_ROW_TIMINGS: RowTimingStats = {
  golden: { n: 0, avgMs: 0 },
  ai: { n: 0, avgMs: 0 },
  batches: 0,
};

/**
 * The build path a finished row took: golden when any stage reused a golden,
 * otherwise AI. `fallback` is the path pre-flight predicted, for rows without a
 * stage report.
 */
export function rowBuildPath(stageSources: readonly (string | undefined)[] | undefined, fallback: BuildPath): BuildPath {
  if (!stageSources || stageSources.length === 0) return fallback;
  return stageSources.some(s => s === 'golden') ? 'golden' : 'ai';
}

function validMs(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
}

function fold(avg: PathAverage, samples: number[]): PathAverage {
  let { n, avgMs } = avg;
  for (const ms of samples) {
    n = Math.min(n + 1, ROW_TIMINGS_WINDOW);
    avgMs = avgMs + (ms - avgMs) / n;
  }
  return { n, avgMs: Math.round(avgMs) };
}

/** Fold one finished batch's timed rows into the saved averages. */
export function recordBatchTimings(prev: RowTimingStats, rows: readonly TimedRow[]): RowTimingStats {
  const golden = rows.filter(r => r.path === 'golden' && validMs(r.totalMs)).map(r => r.totalMs);
  const ai = rows.filter(r => r.path === 'ai' && validMs(r.totalMs)).map(r => r.totalMs);
  if (golden.length === 0 && ai.length === 0) return prev;
  return {
    golden: fold(prev.golden, golden),
    ai: fold(prev.ai, ai),
    batches: prev.batches + 1,
  };
}

function parseAverage(v: unknown): PathAverage {
  const o = v as Partial<PathAverage> | null;
  const n = Number(o?.n);
  const avgMs = Number(o?.avgMs);
  return Number.isFinite(n) && n > 0 && validMs(avgMs)
    ? { n: Math.min(Math.floor(n), ROW_TIMINGS_WINDOW), avgMs: Math.round(avgMs) }
    : { n: 0, avgMs: 0 };
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KV | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadRowTimings(storage: KV | null = defaultStorage()): RowTimingStats {
  try {
    const raw = storage?.getItem(ROW_TIMINGS_KEY);
    if (!raw) return EMPTY_ROW_TIMINGS;
    const o = JSON.parse(raw);
    const batches = Number(o?.batches);
    return {
      golden: parseAverage(o?.golden),
      ai: parseAverage(o?.ai),
      batches: Number.isFinite(batches) && batches > 0 ? Math.floor(batches) : 0,
    };
  } catch {
    return EMPTY_ROW_TIMINGS;
  }
}

export function saveRowTimings(stats: RowTimingStats, storage: KV | null = defaultStorage()): void {
  try { storage?.setItem(ROW_TIMINGS_KEY, JSON.stringify(stats)); } catch { /* quota / private mode: estimate stays unmeasured */ }
}

/** "~45 s", "~6 min", "~1 h 20 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `~${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `~${h} h ${rest} min` : `~${h} h`;
}

/** A rough span: "6–12 min", "4–7 h". Over an hour it rounds to whole hours. */
export function formatRoughRange(loMs: number, hiMs: number): string {
  const loMin = Math.max(1, Math.round(loMs / 60_000));
  const hiMin = Math.max(loMin, Math.round(hiMs / 60_000));
  if (hiMin < 60) return loMin === hiMin ? `${loMin} min` : `${loMin}–${hiMin} min`;
  const loH = Math.max(1, Math.round(loMin / 60));
  const hiH = Math.max(loH, Math.round(hiMin / 60));
  return loH === hiH ? `${loH} h` : `${loH}–${hiH} h`;
}

export interface RunShape {
  /** In this tab: rows at a time. Background always runs 1 per tick. */
  concurrency: number;
  background: boolean;
}

export interface BatchEstimate {
  /** False when a path in this batch has no measured rows yet. */
  measured: boolean;
  ms?: number;
  /** Short value for the summary strip: "~6 min" or "After first rows". */
  label: string;
  /** One sentence on where the number comes from. */
  detail: string;
}

function rowWallMs(avgMs: number, background: boolean): number {
  // One row per tick: a row that takes 70 s still waits for the next minute.
  return background ? Math.ceil(avgMs / BACKGROUND_TICK_MS) * BACKGROUND_TICK_MS : avgMs;
}

function totalMs(stats: RowTimingStats, counts: { golden: number; ai: number }, run: RunShape): number {
  const work = counts.golden * rowWallMs(stats.golden.avgMs, run.background)
    + counts.ai * rowWallMs(stats.ai.avgMs, run.background);
  return run.background ? work : work / Math.max(1, run.concurrency);
}

/** The Run setup estimate for a batch of `counts` rows. */
export function estimateBatch(stats: RowTimingStats, counts: { golden: number; ai: number }, run: RunShape): BatchEstimate {
  const missing = (counts.golden > 0 && stats.golden.n === 0) || (counts.ai > 0 && stats.ai.n === 0);
  if (counts.golden + counts.ai === 0) {
    return { measured: false, label: '—', detail: 'Nothing to build.' };
  }
  if (missing) {
    const which = counts.golden > 0 && stats.golden.n === 0 && counts.ai > 0 && stats.ai.n === 0
      ? 'No earlier batches to measure yet.'
      : `No earlier ${stats.golden.n === 0 ? '★ golden' : '✦ AI'} rows to measure yet.`;
    return {
      measured: false,
      label: 'After first rows',
      detail: `${which} The time left appears on the Build screen once the first rows finish.`,
    };
  }
  const ms = totalMs(stats, counts, run);
  const parts = [
    counts.golden > 0 ? `★ golden rows took ${formatDuration(stats.golden.avgMs)}` : '',
    counts.ai > 0 ? `✦ AI rows ${formatDuration(stats.ai.avgMs)}` : '',
  ].filter(Boolean).join(', ');
  const from = stats.batches === 1 ? 'From your last batch' : `From your last ${stats.batches} batches`;
  const shape = run.background ? 'one at a time, one row per minute tick' : `${run.concurrency} at a time`;
  return {
    measured: true,
    ms,
    label: formatDuration(ms),
    detail: `${from}: ${parts}. ${counts.golden} golden + ${counts.ai} AI, ${shape}.`,
  };
}

/**
 * Time left on the Build screen, from rows of THIS run that finished. A path
 * with no finished row yet borrows the saved average; with neither there is no
 * number to show, so it returns null.
 */
export function measuredTimeLeft(
  finished: readonly TimedRow[],
  remaining: { golden: number; ai: number },
  run: RunShape,
  saved: RowTimingStats = EMPTY_ROW_TIMINGS,
): { ms: number; label: string; basis: string } | null {
  if (remaining.golden + remaining.ai === 0) return null;
  const done = finished.filter(r => validMs(r.totalMs));
  const avgOf = (path: BuildPath): number | null => {
    const own = done.filter(r => r.path === path);
    if (own.length) return own.reduce((a, r) => a + r.totalMs, 0) / own.length;
    return saved[path].n > 0 ? saved[path].avgMs : null;
  };
  const g = remaining.golden > 0 ? avgOf('golden') : 0;
  const a = remaining.ai > 0 ? avgOf('ai') : 0;
  if (g == null || a == null || done.length === 0 && saved.batches === 0) return null;
  const stats: RowTimingStats = { golden: { n: 1, avgMs: g }, ai: { n: 1, avgMs: a }, batches: 0 };
  const ms = totalMs(stats, remaining, run);
  const basis = done.length
    ? `Measured on the ${done.length} row${done.length === 1 ? '' : 's'} that finished, split by golden and AI rows`
    : 'Measured on your earlier batches, split by golden and AI rows';
  return { ms, label: `${formatDuration(ms)} left`, basis };
}
