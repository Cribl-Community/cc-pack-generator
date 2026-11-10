/**
 * Per-invocation run time and peak memory of runBatchStep, for the certification rule
 * "p95 duration ≤ 80 % of the declared timeout, peak memory ≤ 80 % of the declared memory"
 * (docs.cribl.io/apps/certified-apps, Right-Size Compute Allocation).
 *
 * The platform records neither, so the function measures itself: wall time from the first line
 * of onRequest to its response, and the highest RSS / heap seen by a sampler while it ran. Each
 * invocation is logged to app-backend.log and appended to one App KV key (the last
 * METRICS_KEEP entries), which `npm run backend:metrics` reads and summarises.
 * Only timings, sizes, the action and the outcome status are kept: never row content.
 */

export const METRICS_KV_KEY = 'batch-run/metrics';
export const METRICS_KEEP = 500;
const SAMPLE_MS = 200;
const MB = 1024 * 1024;

export interface InvocationMetric {
  at: string;          // ISO start time
  action: string;      // 'kickoff' | 'tick'
  status: string;      // the runner status or HTTP outcome
  ms: number;          // wall time of the invocation
  rssPeakMb: number;   // highest resident set size seen
  heapPeakMb: number;  // highest V8 heap used seen
}

type Mem = { rss: number; heapUsed: number };
const readMem = (): Mem | null => {
  const p = (globalThis as { process?: { memoryUsage?: () => Mem } }).process;
  try { return p?.memoryUsage ? p.memoryUsage() : null; } catch { return null; }
};

/** Start measuring; `stop()` returns the wall time and the peaks since the start. */
export function startMeter(now: () => number = () => Date.now()): { stop: () => { ms: number; rssPeakMb: number; heapPeakMb: number } } {
  const t0 = now();
  let rss = 0, heap = 0;
  const sample = () => { const m = readMem(); if (m) { rss = Math.max(rss, m.rss); heap = Math.max(heap, m.heapUsed); } };
  sample();
  const timer = setInterval(sample, SAMPLE_MS) as unknown as { unref?: () => void };
  timer.unref?.();
  return {
    stop: () => {
      sample();
      clearInterval(timer as unknown as ReturnType<typeof setInterval>);
      return { ms: now() - t0, rssPeakMb: Math.round((rss / MB) * 10) / 10, heapPeakMb: Math.round((heap / MB) * 10) / 10 };
    },
  };
}

/** Append one entry to the KV ring. Never throws: a lost sample must not fail a tick. */
export async function recordMetric(
  entry: InvocationMetric,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (i, init) => globalThis.fetch(i, init),
  apiBase = '/api/v1',
): Promise<void> {
  const url = `${apiBase}/kvstore/${METRICS_KV_KEY}`;
  try {
    let list: InvocationMetric[] = [];
    const got = await fetchImpl(url);
    if (got.ok) {
      try { const v = JSON.parse(await got.text()); if (Array.isArray(v)) list = v; } catch { /* start over */ }
    }
    list.push(entry);
    await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(list.slice(-METRICS_KEEP)) });
  } catch { /* best effort */ }
}

/** The p-th percentile (nearest rank) of `values`; 0 for none. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export interface MetricSummary {
  count: number;
  p50Ms: number; p95Ms: number; maxMs: number;
  p95RssMb: number; maxRssMb: number; maxHeapMb: number;
  timeoutMs: number; memoryMb: number;
  p95OfTimeout: number; peakOfMemory: number;   // fractions of the declared limits
  meets80: boolean;
}

/** Summarise entries against the declared limits (config/backend.yml timeout seconds, memory MB). */
export function summarize(entries: InvocationMetric[], timeoutS: number, memoryMb: number): MetricSummary {
  const ms = entries.map(e => e.ms), rss = entries.map(e => e.rssPeakMb);
  const p95Ms = percentile(ms, 95), maxRssMb = Math.max(0, ...rss);
  const p95OfTimeout = p95Ms / (timeoutS * 1000), peakOfMemory = maxRssMb / memoryMb;
  return {
    count: entries.length,
    p50Ms: percentile(ms, 50), p95Ms, maxMs: Math.max(0, ...ms),
    p95RssMb: percentile(rss, 95), maxRssMb, maxHeapMb: Math.max(0, ...entries.map(e => e.heapPeakMb)),
    timeoutMs: timeoutS * 1000, memoryMb,
    p95OfTimeout, peakOfMemory,
    meets80: entries.length > 0 && p95OfTimeout <= 0.8 && peakOfMemory <= 0.8,
  };
}
