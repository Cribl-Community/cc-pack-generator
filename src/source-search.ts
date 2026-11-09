// The Source step's one search box. It covers everything the app can start a
// pack from by name, in one list: the curated tiles, the supported catalog
// (parsers, descriptions, data classes) and every sourcetype with real reference
// or pool events (`referenceAvailability`, ~1,000 names). Before this the box
// only filtered the 24 tiles, and the catalog was reachable only through
// "Custom / Other", so most real sources (darktrace_*) were never found.
//
// Pure: the caller builds the corpus from data it already holds; nothing here
// fetches or imports a data table.
import { normalizeSourcetypeName } from './source-recognition';

export interface SourceEntry {
  /** Canonical sourcetype name — what the pack is built for. */
  name: string;
  /** Human label or description; '' when none is known. */
  label: string;
  /** Deterministic golden parser + schema exists. */
  golden: boolean;
  /** Real reference / pool events available (0 = none, generate with AI). */
  realEvents: number;
  /** One of the curated tiles (selected through the tile path, not the custom one). */
  tile: boolean;
}

export type SourceEntryInput = Partial<SourceEntry> & { name: string };

/** Merge entries by name; a later part only fills what an earlier one left empty. */
export function buildSourceCorpus(...parts: SourceEntryInput[][]): SourceEntry[] {
  const byName = new Map<string, SourceEntry>();
  for (const part of parts) {
    for (const e of part) {
      const name = (e.name || '').trim();
      if (!name) continue;
      const cur = byName.get(name);
      if (!cur) {
        byName.set(name, { name, label: e.label || '', golden: !!e.golden, realEvents: e.realEvents || 0, tile: !!e.tile });
        continue;
      }
      if (!cur.label && e.label) cur.label = e.label;
      cur.golden = cur.golden || !!e.golden;
      cur.realEvents = Math.max(cur.realEvents, e.realEvents || 0);
      cur.tile = cur.tile || !!e.tile;
    }
  }
  return [...byName.values()];
}

/**
 * Rank: the exact name (-0.5), name starts with the query (0), contains it (1), a name from
 * `familyHits` that matches neither (1.5 — "sap" names its product family),
 * label contains it (2). Ties: golden first, then more real events, then name.
 */
export function searchSources(query: string, corpus: SourceEntry[], opts: { limit?: number; familyHits?: string[] } = {}): SourceEntry[] {
  const raw = (query || '').trim().toLowerCase();
  if (!raw) return [];
  const q = normalizeSourcetypeName(raw);
  const qKey = q.replace(/_/g, '');
  const family = new Set(opts.familyHits || []);
  const scored: { e: SourceEntry; rank: number }[] = [];
  for (const e of corpus) {
    const n = e.name.toLowerCase();
    const nKey = n.replace(/_/g, '');
    let rank = -1;
    if (n === q) rank = -0.5;
    else if (n.startsWith(q) || nKey.startsWith(qKey)) rank = 0;
    else if (n.includes(q) || nKey.includes(qKey)) rank = 1;
    else if (family.has(e.name)) rank = 1.5;
    else if (e.label && e.label.toLowerCase().includes(raw)) rank = 2;
    if (rank !== -1) scored.push({ e, rank });
  }
  scored.sort((a, b) => a.rank - b.rank
    || Number(b.e.golden) - Number(a.e.golden)
    || b.e.realEvents - a.e.realEvents
    || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, opts.limit ?? 60).map(s => s.e);
}

/**
 * The name the "Generate an AI sample" row builds for, or null when the query
 * cannot be a sourcetype (empty, or characters a `sourcetype=='…'` route filter
 * cannot carry). Shown whenever the query is not itself a known name, so a
 * source that is not in the catalog always has a way forward.
 */
export function aiFallbackName(query: string, corpus: SourceEntry[]): string | null {
  const name = normalizeSourcetypeName(query || '');
  if (!name || name.length > 128 || !/^[a-z0-9][a-z0-9_]*$/.test(name)) return null;
  if (corpus.some(e => e.name.toLowerCase() === name)) return null;
  return name;
}

/**
 * How close the sample on hand is to the user's own feed (build 996). The pack is
 * scored by value coverage of the SAMPLE, so a vendor or AI sample yields a score
 * for that sample, not for the user's data — the Source step says so and ranks
 * the user's own events first.
 *
 *   own    — upload / paste / worker-group sample / live capture, events loaded
 *   vendor — real vendor events from the catalog (reference, built-in, public dataset)
 *   ai     — AI-written lines (ai-generate, hybrid = public + AI)
 *   none   — nothing loaded or picked yet
 */
export type SampleFit = 'own' | 'vendor' | 'ai' | 'none';

export const OWN_EVENT_MODES = ['upload', 'paste', 'existing', 'live-capture'] as const;

export function sampleFit(sourceMode: string, sampleSourceId: string, hasEvents: boolean): SampleFit {
  if ((OWN_EVENT_MODES as readonly string[]).includes(sourceMode)) return hasEvents ? 'own' : 'none';
  if (sourceMode !== 'ai-generate' || !sampleSourceId) return 'none';
  return sampleSourceId === 'ai-generate' || sampleSourceId === 'hybrid' ? 'ai' : 'vendor';
}

/** Meter level (0-3) and the action-bar wording for each fit. */
export const SAMPLE_FIT_INFO: Record<SampleFit, { level: number; label: string }> = {
  own: { level: 3, label: 'Sample fit: your feed' },
  vendor: { level: 2, label: 'Sample fit: vendor sample' },
  ai: { level: 1, label: 'Sample fit: AI-written' },
  none: { level: 0, label: 'No sample yet' },
};
