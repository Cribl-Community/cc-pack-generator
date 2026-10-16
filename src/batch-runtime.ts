export type BatchPhase = 'queued' | 'preparing' | 'building' | 'deploying' | 'deployed' | 'scoring' | 'repairing' | 'done';

// How many packs the batch may build at once. Sample generation alone scales
// well past 12 concurrent, but each staged row also does dozens of
// patch+preview cycles against the leader. At 8–12 that flood of browser
// fetches produced widespread "Failed to fetch" after extraction had already
// scored (E set, M/O blank). Cap at 6 — still 6× sequential throughput, with
// room for the transient-fetch retries to absorb drops. Rows sharing a pack id
// still run sequentially; one commit+deploy at the end.
export const MAX_BATCH_CONCURRENCY = 6;
// A foreground ("In this tab") run always builds this many packs at once —
// there is no selector. Background runs advance one row per tick and ignore it.
export const BATCH_FOREGROUND_CONCURRENCY = 4;
// A background run takes at most this many pipelines (CSV rows): it advances one
// row per tick, so a bigger file would run for hours on the group's workers.
export const BATCH_BACKGROUND_MAX_ROWS = 200;

export interface BatchRunChoice { ok: boolean; reason?: string; concurrency: number }

/**
 * Where a batch may run. Outside Cribl (local dev server) there is no
 * background and no Cribl AI: always this tab, BATCH_FOREGROUND_CONCURRENCY at a
 * time. Inside Cribl both are offered; this tab runs one row at a time on
 * Cribl AI (it serializes every call), and background always runs one row at a
 * time and takes at most BATCH_BACKGROUND_MAX_ROWS pipelines.
 */
export function batchRunChoices(o: { inCribl: boolean; criblAi: boolean; rows: number }): { foreground: BatchRunChoice; background: BatchRunChoice } {
  const foreground: BatchRunChoice = { ok: true, concurrency: o.inCribl && o.criblAi ? 1 : BATCH_FOREGROUND_CONCURRENCY };
  const background: BatchRunChoice = !o.inCribl
    ? { ok: false, reason: 'Only available when the app runs inside Cribl.', concurrency: 1 }
    : o.rows > BATCH_BACKGROUND_MAX_ROWS
      ? { ok: false, reason: `A background run takes at most ${BATCH_BACKGROUND_MAX_ROWS} pipelines; this file has ${o.rows}. Split it, or run in this tab.`, concurrency: 1 }
      : { ok: true, concurrency: 1 };
  return { foreground, background };
}

export interface PackGroupFailure { group: number; error: Error }

/**
 * A CSV filter, made safe to hand to Cribl.
 *
 * Spreadsheets substitute typographic quotes, and a route filter carrying them
 * is not valid JS — the route silently matches nothing. Shared so the
 * foreground batch and the background manifest normalize identically: the two
 * must route the same slice of data from the same CSV.
 */
export function sanitizeRouteFilter(filter: string): string {
  return filter
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

/**
 * Run pack-groups concurrently, each group's own rows sequentially.
 *
 * Extracted from `handleBatchDeploy` so the slot accounting is testable: the
 * inline version decremented `active` AFTER awaiting the group's rows, so a row
 * that REJECTED leaked its slot permanently. With every slot leaked the outer
 * promise never resolved — `batchRunning` stayed true and, worse, the single
 * final commit+deploy never ran, leaving every pack created but not live. The
 * release is in a `finally` here, and a failing group is reported rather than
 * being able to strand the batch. Probability of hitting that grew with
 * concurrency, which is exactly what this change raises.
 */
export async function runPackGroups(
  groups: number[][],
  concurrency: number,
  runRow: (index: number, mode: 'new' | 'add-pipeline') => Promise<void>,
): Promise<PackGroupFailure[]> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, MAX_BATCH_CONCURRENCY));
  const failures: PackGroupFailure[] = [];
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= groups.length) return;
      try {
        const rows = groups[index] || [];
        for (let j = 0; j < rows.length; j++) {
          await runRow(rows[j], j === 0 ? 'new' : 'add-pipeline');
        }
      } catch (err) {
        // One pack cannot strand the rest. `runRow` records its own row error;
        // this only catches a rejection that escaped it.
        failures.push({ group: index, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, worker));
  return failures;
}

/**
 * Patch ONE row by index, returning a new array.
 *
 * The batch run used to write React state as `setBatchResults([...results])` —
 * a whole-array overwrite from its own local snapshot. Row actions
 * (Improve/Rerun/Show) are gated only on `batchRowBusy`, never on
 * `batchRunning`, so they legitimately run DURING a batch; the run's snapshot
 * knows nothing about their writes and reverted them on the next row that
 * finished. More rows in flight means more overwrites, so raising concurrency
 * without this is a regression.
 */
export function applyRowPatch<T>(rows: T[], index: number, partial: Partial<T>): T[] {
  return rows.map((row, i) => (i === index ? { ...row, ...partial } : row));
}

export function createAsyncCache<K, V>() {
  const values = new Map<K, Promise<V>>();
  return {
    getOrCreate(key: K, factory: () => Promise<V>): { value: Promise<V>; reused: boolean } {
      const existing = values.get(key);
      if (existing) return { value: existing, reused: true };
      const value = factory().catch((error) => {
        values.delete(key);
        throw error;
      });
      values.set(key, value);
      return { value, reused: false };
    },
    size: () => values.size,
  };
}

export function batchPhaseLabel(phase: BatchPhase | undefined): string {
  switch (phase) {
    case 'preparing': return 'Preparing';
    case 'building': return 'Building';
    case 'deploying': return 'Deploying';
    case 'deployed': return 'Deployed';
    case 'scoring': return 'Scoring';
    case 'repairing': return 'Improving';
    case 'done': return 'Done';
    default: return 'Waiting';
  }
}

export function isBatchPhaseTerminal(phase: BatchPhase | undefined): boolean {
  return phase === 'done';
}

/**
 * Which tier a pre-flight-cached sample should REPORT as `sample_tier`.
 *
 * "preflight" is a cache, not a source. Reporting it hid the one thing the
 * field exists to answer — was this row built from a real vendor log or from a
 * generated one — and it disagreed with the background runner, which records
 * the origin the pre-flight resolved (`reference` / `bundled` / `ai-generated`)
 * on the row artifact. One origin, one word for it, or the scores dataset
 * cannot group the two engines together.
 *
 * An unrecorded origin stays `preflight`: we know it came from the cache and
 * nothing more, and guessing a tier would report a generated sample as a log.
 * `uploaded` is the row's own `sample` cell (src/batch-row-sample.ts).
 */
export type PreflightSampleTier = 'preflight' | 'uploaded' | 'reference' | 'ai-generated' | 'bundled' | 'none';

const PREFLIGHT_ORIGIN_TIERS = new Set<PreflightSampleTier>(['uploaded', 'reference', 'bundled', 'ai-generated']);

export function preflightSampleTier(origin: string | undefined | null): PreflightSampleTier {
  return PREFLIGHT_ORIGIN_TIERS.has(origin as PreflightSampleTier)
    ? (origin as PreflightSampleTier)
    : 'preflight';
}

/**
 * Why a worker group cannot be picked, or null. Two cases need a live worker:
 * a background batch (its Backend Function executes on the group's workers),
 * and any run on Cribl AI — every preview and score goes through the group, and
 * on a group with none connected each one waits out the platform's 30s proxy
 * ceiling and fails as a bare "Request timeout", one row after another.
 * Unloaded health is unknown, not a refusal: a zero-worker group is simply
 * absent from a loaded map, so blocking before it loads would block everything.
 */
export function groupPickBlock(o: {
  group: string;
  background: boolean;
  criblAi: boolean;
  health: Record<string, { total: number; healthy: number }> | null | undefined;
}): string | null {
  if (!o.background && !o.criblAi) return null;
  if (!o.health) return null;
  const gh = o.health[o.group];
  if (gh && gh.healthy >= 1) return null;
  const why = o.background
    ? 'a background run executes on its workers and would have nothing to run on'
    : 'with Cribl AI every preview and score runs on its workers, so each would end in "Request timeout"';
  return `No connected workers${gh ? ` (${gh.total} configured, 0 healthy)` : ''} — ${why}.`;
}
