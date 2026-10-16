/**
 * Sample provenance — which store a sample line came from, and whether a model
 * wrote it. The record golden evidence needs (`sampleTier`, `syntheticCount`,
 * docs/specs/golden-trust.md R1) and that nothing used to carry past the sample
 * resolver: by the time a build saved a golden, a 100 over two AI-extended lines
 * and a 100 over twenty vendor lines looked identical.
 *
 * Events are marked where they are MADE — a store read (`fetchReferenceSample`),
 * request-time extension (`extendThinSample`) and AI generation — and found again
 * by CONTENT (`provenanceKey`) where a golden is saved, however the build
 * re-formatted them. Every site that can create a synthetic line marks it,
 * so the count is authoritative for this JS context. What this module cannot see
 * (a line it was never shown) it reports as UNKNOWN, never as clean: the trust
 * rules refuse an unknown tier rather than guess one (R1).
 *
 * In-memory and per context by design: a sample's provenance only matters for the
 * build that resolved it, and nothing here is persisted.
 */
import type { SampleTier } from './golden-trust';

/**
 * Registrations are kept as BATCHES (one store read, one extension, one
 * generation), newest last, bounded. A batch holds each event's content key.
 */
const MAX_BATCHES = 400;
interface Batch { tier: SampleTier | null; events: { key: string; synthetic: boolean }[] }
const batches: Batch[] = [];

/**
 * Content identity of an event, immune to how a build re-formats it: the wizard
 * and batch flatten multi-line JSON to one line, strip a quoted line's outer
 * quotes (`flattenEventsToLines`) and re-break Windows XML on `<Event`
 * (`repairXmlEventBreaking`) — so a registry keyed on exact lines missed every
 * multi-line or quoted sample, and an AI line that flattened differently went
 * uncounted. Whitespace, quotes and backslashes carry no identity here.
 */
export function provenanceKey(text: unknown): string {
  return String(text ?? '').replace(/[\s"'\\]+/g, '');
}
/** Shorter keys could match inside an unrelated event by accident. */
const MIN_KEY = 12;

function remember(batch: Batch): void {
  if (!batch.events.length) return;
  batches.push(batch);
  if (batches.length > MAX_BATCHES) batches.shift();
}

function toEvents(sample: string | readonly unknown[] | null | undefined): string[] {
  if (sample == null) return [];
  const list = typeof sample === 'string' ? sample.split('\n') : sample.map(e => (typeof e === 'string' ? e : JSON.stringify(e)));
  return list.map(l => String(l)).filter(l => l.trim());
}

/**
 * Ladder tier of a reference-store response, by the `pack` label each store
 * stamps on what it returns (scripts/reference-api.mjs, src/bundled-data.ts,
 * src/samples-pool.ts). A catalog sample is labelled with the Cribl pack it ships
 * in — real vendor events — so any other label is `vendor`.
 */
export function tierOfStorePack(pack: string | null | undefined, synthetic?: boolean): SampleTier {
  if (synthetic) return 'ai';
  switch (pack) {
    case 'fallback': return 'curated';
    case 'source-samples': return 'vendor';
    case 'vendor-samples': return 'pool';
    case 'sanitised-samples': return 'sanitised';
    case 'ai-samples': return 'ai';
    default: return 'vendor';
  }
}

/**
 * A sample read from the stores. `syntheticTail` = lines request-time extension
 * appended (they always follow the real ones, `extendThinSample`).
 */
export function recordStoreSample(events: readonly unknown[] | string, pack: string | null | undefined, opts: { synthetic?: boolean; syntheticTail?: number } = {}): void {
  const list = toEvents(events);
  const tail = Math.max(0, Math.min(list.length, opts.syntheticTail || 0));
  remember({
    tier: tierOfStorePack(pack, opts.synthetic),
    events: list.map((e, i) => ({ key: provenanceKey(e), synthetic: !!opts.synthetic || i >= list.length - tail }))
      .filter(e => e.key.length >= MIN_KEY),
  });
}

/** Lines a model wrote — generated samples and extension lines. */
export function recordSyntheticLines(events: readonly unknown[] | string): void {
  remember({ tier: null, events: toEvents(events).map(e => ({ key: provenanceKey(e), synthetic: true })).filter(e => e.key.length >= MIN_KEY) });
}

/**
 * The tier a build's own context implies, for a sample this module was not shown
 * (the user's upload/paste/capture never passes a store). Batch vocabulary
 * (`PreflightSampleTier`) and the wizard's `SourceMode` both map; anything that
 * names a cache rather than a source (`preflight`, `reference`) maps to nothing.
 */
export function tierFromBuildContext(ctx: { sampleTier?: string | null; sourceMode?: string | null } = {}): SampleTier | null {
  switch (ctx.sampleTier) {
    case 'uploaded': case 'user': return 'user';
    case 'ai-generated': case 'ai': return 'ai';
    case 'bundled': case 'vendor': return 'vendor';
    case 'curated': case 'pool': case 'sanitised': return ctx.sampleTier;
    default: break;
  }
  switch (ctx.sourceMode) {
    case 'upload': case 'paste': case 'live-capture': case 'existing': return 'user';
    default: return null;
  }
}

export interface SampleProvenance {
  /** null = not determinable here; the trust rules refuse it (never guessed). */
  sampleTier: SampleTier | null;
  /** null = unknown; only reported as a number when the tier is known. */
  syntheticCount: number | null;
}

/**
 * Provenance of the sample a golden was measured on. The registry outranks the
 * context: a "reference" sample is told apart here as curated vs vendor vs pool,
 * and an uploaded sample that was extended carries its extension count.
 */
export function describeSampleProvenance(sample: string | readonly unknown[] | null | undefined, ctx: { sampleTier?: string | null; sourceMode?: string | null } = {}): SampleProvenance {
  const events = toEvents(sample);
  if (!events.length) return { sampleTier: null, syntheticCount: null };
  // Containment over the whole sample, not line equality: an event the build
  // re-formatted (or split across lines) is still found.
  const whole = provenanceKey(events.join(''));
  const synthetic = new Set<string>();
  const real = new Map<string, SampleTier>();
  for (const b of batches) {
    for (const e of b.events) {
      if (!whole.includes(e.key)) continue;
      if (e.synthetic) synthetic.add(e.key);
      else if (b.tier) real.set(e.key, b.tier);
    }
  }
  for (const k of synthetic) real.delete(k);
  const tally = new Map<SampleTier, number>();
  for (const t of real.values()) tally.set(t, (tally.get(t) || 0) + 1);
  const registered = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const tier = registered ?? tierFromBuildContext(ctx) ?? (synthetic.size && !real.size ? 'ai' : null);
  return { sampleTier: tier, syntheticCount: tier ? synthetic.size : null };
}

/** Test seam: forget everything. */
export function resetSampleProvenance(): void {
  batches.length = 0;
}
