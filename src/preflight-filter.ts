// Batch pre-check counters ARE the filters.
//
// The pre-flight screen summarises a batch as "N recognized · N to confirm · N
// unknown (blocks build) · N without a sample". Only the unknown count had a way
// to see the rows behind it ("Check unknown records"); every other count was a
// dead number on a table that can be 500 rows long — so "12 to confirm" told the
// user twelve rows needed attention and nothing about WHICH twelve.
//
// One predicate per counter, defined once here and used BOTH to count and to
// filter, so a count can never promise a set the filter doesn't show.

export type PreflightFilter =
  | 'recognized'
  | 'identified'
  | 'confirm'
  | 'checking'
  | 'unknown'
  | 'sample-found'
  | 'sample-generated'
  | 'sample-thin'
  | 'sample-missing';

/** Reads as "Showing 12 rows <label> of 73". */
export const PREFLIGHT_FILTER_LABEL: Record<PreflightFilter, string> = {
  recognized: 'recognized',
  identified: 'identified (build via AI)',
  confirm: 'awaiting confirmation',
  checking: 'being identified',
  unknown: 'unrecognized',
  'sample-found': 'with a resolved sample',
  'sample-generated': 'with a generated sample',
  'sample-thin': 'with a sample too thin to measure',
  'sample-missing': 'without a sample',
};

/** The shape of a pre-flight row this module needs — a subset of PreflightSourcetypeRow. */
export interface PreflightFilterRow {
  recognized?: string;
  recStatus?: string;
  needsConfirm?: boolean;
  aiChecking?: boolean;
}

/** The shape of a resolved sample row this module needs. */
export interface PreflightFilterSample {
  status?: string;
  /** Real, but below SAMPLE_EXTEND_FLOOR — found, and not yet measurable. */
  thin?: boolean;
}

/**
 * Settle every item through a fixed-size worker pool.
 *
 * Result order matches input order, and failures are returned as rejected results
 * instead of aborting the queue. A worker always advances after rejection, so one
 * failed model call cannot leak a slot and deadlock the remaining pre-flight work.
 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export interface IdentifyUniqueNamesOptions<T> {
  concurrency: number;
  isFamilyToken: (name: string) => boolean;
  identify: (name: string) => Promise<T | null>;
  onProgress?: (state: { done: number; total: number; name?: string }) => void;
}

/**
 * The pre-flight name-identification orchestration used by App.
 *
 * Names are de-duplicated in first-seen order. Family tokens settle without an
 * AI call, identify failures become null results, and every unique name advances
 * progress exactly once through the shared bounded worker pool.
 */
export async function identifyUniqueNames<T>(
  names: readonly string[],
  options: IdentifyUniqueNamesOptions<T>,
): Promise<Map<string, T | null>> {
  const uniqueNames = [...new Set(names)];
  const resolved = new Map<string, T | null>(uniqueNames.map(name => [name, null]));
  let done = 0;
  options.onProgress?.({ done, total: uniqueNames.length });

  await mapSettledWithConcurrency(uniqueNames, options.concurrency, async name => {
    let value: T | null = null;
    try {
      if (!options.isFamilyToken(name)) value = await options.identify(name);
    } catch {
      value = null;
    } finally {
      resolved.set(name, value);
      done += 1;
      options.onProgress?.({ done, total: uniqueNames.length, name });
    }
  });
  return resolved;
}

/**
 * Does this SAMPLE row belong to `filter`?
 *
 * The sample counters count unique sourcetypes (one sample row each) while the
 * filters select batch rows, so the two count different things on purpose — but they
 * must agree on what "found" or "thin" MEANS, which is why the predicate lives here
 * and not in a filter expression at the call site.
 */
export function preflightSampleMatches(sample: PreflightFilterSample | undefined, filter: PreflightFilter): boolean {
  switch (filter) {
    // Found and thin are disjoint: a 2-event store hit is real, and counting it as
    // "found" is how "20 events" and "2 events" end up reading identically.
    case 'sample-found': return sample?.status === 'found' && !sample?.thin;
    case 'sample-generated': return sample?.status === 'generated';
    case 'sample-thin': return !!sample?.thin;
    // Skipped = nothing in the stores and over the pre-flight model cap (or the
    // user continued without waiting): it reaches the build with no sample, the
    // same as a failed generation. Not counting it hid ~80 rows of a 200-row batch.
    case 'sample-missing': return sample?.status === 'failed' || sample?.status === 'skipped';
    default: return false;
  }
}

/**
 * Does this row belong to `filter`?
 *
 * `sampleFor` resolves the row's sample row (samples are keyed by the RESOLVED
 * sourcetype, so several batch rows can share one — a sample filter can show more
 * rows than the sample counter counts, which is why the filter bar states the row
 * count it is actually showing).
 */
export function preflightRowMatches(
  row: PreflightFilterRow,
  filter: PreflightFilter,
  sampleFor: (row: PreflightFilterRow) => PreflightFilterSample | undefined = () => undefined,
): boolean {
  switch (filter) {
    // A row with a pre-filled guess is NOT settled — it counts as "to confirm",
    // never as "recognized", or the two counts overlap and add up past the batch.
    case 'recognized': return row.recognized === 'recognized' && !row.needsConfirm;
    case 'identified': return row.recStatus === 'catalogue_gap';
    case 'confirm': return !!row.needsConfirm;
    case 'checking': return !!row.aiChecking;
    // A row the AI is still looking at is not yet an unknown (build 440) — it must
    // stay out of the count that says the build is blocked.
    case 'unknown': return row.recognized === 'unknown' && !row.aiChecking;
    case 'sample-found':
    case 'sample-generated':
    case 'sample-thin':
    case 'sample-missing': return preflightSampleMatches(sampleFor(row), filter);
    default: return true;
  }
}

/** Count of the rows in `filter` — the number the clickable counter shows. */
export function preflightCount<T extends PreflightFilterRow>(
  rows: T[],
  filter: PreflightFilter,
  sampleFor?: (row: PreflightFilterRow) => PreflightFilterSample | undefined,
): number {
  return rows.filter(r => preflightRowMatches(r, filter, sampleFor)).length;
}

/**
 * The sample keys the pre-flight "Next" still has to resolve.
 *
 * A key is settled once it has a sample row that is no longer pending/loading —
 * found, generated, failed, or skipped by "Continue without waiting" (those
 * generate at build time). Next must not re-resolve a settled key: after a skip
 * it used to reset every sample to pending and start the whole sweep again.
 */
export function samplesStillToResolve(
  keys: readonly string[],
  samples: readonly { sourcetype: string; status?: string }[],
): string[] {
  const settled = new Set(samples.filter(s => s.status !== 'pending' && s.status !== 'loading').map(s => s.sourcetype));
  return [...new Set(keys)].filter(k => !settled.has(k));
}
