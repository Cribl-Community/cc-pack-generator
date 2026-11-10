/**
 * Vendor field library: per source type, which fields its events carry.
 *
 * Used by performance mode to remove `||` fallbacks. Every listed field counts as CONFIRMED for the
 * source type, also in an open entry, and so does every field a sample on this install showed for it
 * (learned): a chain that reads a confirmed field keeps all its confirmed fields and drops the
 * unconfirmed alternatives around them (see perf-native.ts). Removing a fallback where no confirmed field anchors
 * the chain needs the list to be COMPLETE: a person checked it against the vendor's documentation
 * and set `status: 'closed'`.
 *
 *  - `fields`   documented fields, as named on the event after the pack's parser (dotted paths;
 *               a path also covers everything below it, so an object of free shape is listed once).
 *               Generated from the parser and the bundled sample by `npm run library:fields`.
 *  - `seen`     field names the app saw on built samples, per install (app KV store, browser copy as
 *               fallback). Names only, never values. Never bundled: customer field names stay out of
 *               the repo, which is published.
 *  - reopened   a seen field that a closed entry does not cover proves the list incomplete: the entry
 *               counts as open again until someone reviews it (adds the field, closes it again).
 *
 * Common fields (Cribl metadata, internal `__` fields) are covered for every source type.
 */
import bundled from '../config/vendor-field-library.json';
import { getRunMode } from './run-mode';
import { safeGetItem, safeSetItem } from './safe-storage';

export type VendorFieldStatus = 'open' | 'closed';

export interface VendorFieldEntry {
  vendor: string;
  product: string;
  /** Vendor version the list was checked against, e.g. "PAN-OS 11.1". */
  version?: string;
  status: VendorFieldStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  docs: string[];
  aliases?: string[];
  fields: string[];
  notes?: string;
}

export interface VendorFieldLibrary {
  version: number;
  commonFields: string[];
  entries: Record<string, VendorFieldEntry>;
}

export const BUNDLED_LIBRARY = bundled as unknown as VendorFieldLibrary;

/** Canonical form of a source type for lookups: `pan:traffic`, `PAN-Traffic` → `pan_traffic`. */
export const normalizeSourcetype = (st: string): string => st.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function findEntry(lib: VendorFieldLibrary, sourcetype: string | undefined): { key: string; entry: VendorFieldEntry } | null {
  if (!sourcetype) return null;
  const st = normalizeSourcetype(sourcetype);
  for (const [key, entry] of Object.entries(lib.entries)) {
    if (key === st || (entry.aliases || []).some(a => normalizeSourcetype(a) === st)) return { key, entry };
  }
  return null;
}

/** True when `path` is listed, lies below a listed path, or is a parent of one. Trailing `*` matches a prefix. */
export function pathCovered(list: Iterable<string>, path: string): boolean {
  for (const l of list) {
    if (l.endsWith('*') ? path.startsWith(l.slice(0, -1)) : (l === path || l.startsWith(path + '.') || path.startsWith(l + '.'))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Seen fields (per install)

export interface SeenFields {
  /** source type key → field name → number of builds it was seen in. */
  sourcetypes: Record<string, Record<string, number>>;
  updatedAt: string;
}

export const SEEN_KV_KEY = 'vendor-fields/seen';
export const SEEN_LS_KEY = 'vendor-fields-seen';
const MAX_FIELDS_PER_SOURCETYPE = 2000;
const NAME_RE = /^[\w.@$-]{1,200}$/;

const apiBase = (): string => {
  const fromWindow = typeof window !== 'undefined' ? window.CRIBL_API_URL : undefined;
  return fromWindow && fromWindow.length > 0 ? fromWindow.replace(/\/+$/, '') : '/api/v1';
};

export function parseSeen(value: unknown): SeenFields {
  let c: any = value;
  for (let i = 0; i < 3 && typeof c === 'string'; i++) {
    try { c = JSON.parse(c); } catch { c = null; }
  }
  c = c?.items?.[0]?.value ?? c;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
  const sourcetypes = c && typeof c.sourcetypes === 'object' && c.sourcetypes ? c.sourcetypes : {};
  return { sourcetypes, updatedAt: typeof c?.updatedAt === 'string' ? c.updatedAt : '' };
}

export async function loadSeenFields(): Promise<SeenFields> {
  if (getRunMode() === 'iframe') {
    try {
      const resp = await fetch(`${apiBase()}/kvstore/${SEEN_KV_KEY}`);
      if (resp.ok) return parseSeen(await resp.text());
    } catch { /* fall back to the browser copy */ }
  }
  return parseSeen(safeGetItem(SEEN_LS_KEY));
}

// --- Reviewed entries imported from the shared pool -------------------------------------------
//
// The shared vendor-field pool (src/vendor-field-pool.ts, next to the shared goldens) carries only
// REVIEWED entries: `closed`, with reviewedBy and reviewedAt. An import stores them per install,
// and every reader sees the bundled library with them on top. `seen` is never part of it.

export const POOL_KV_KEY = 'vendor-fields/pool';
export const POOL_LS_KEY = 'vendor-fields-pool';

const isText = (v: unknown, max = 500): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Only a reviewed entry passes: closed, reviewer and date set, field names well formed. */
export function sanitizeReviewedEntry(raw: unknown): VendorFieldEntry | null {
  const e = raw as Partial<VendorFieldEntry> | null;
  if (!e || e.status !== 'closed' || !isText(e.reviewedBy, 200) || !isText(e.reviewedAt, 40)) return null;
  if (!Array.isArray(e.fields) || !e.fields.length) return null;
  const fields = e.fields.filter((f): f is string => typeof f === 'string' && NAME_RE.test(f));
  if (fields.length !== e.fields.length) return null;   // one malformed name rejects the entry, not just the name
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => isText(x, 500)) : []);
  return {
    vendor: isText(e.vendor, 200) ? e.vendor : '', product: isText(e.product, 200) ? e.product : '',
    ...(isText(e.version, 200) ? { version: e.version } : {}),
    status: 'closed', reviewedBy: e.reviewedBy, reviewedAt: e.reviewedAt,
    docs: strs(e.docs).filter(d => /^https:\/\//.test(d)), ...(Array.isArray(e.aliases) ? { aliases: strs(e.aliases) } : {}),
    fields, ...(isText(e.notes, 2000) ? { notes: e.notes } : {}),
  };
}

/** The reviewed entries in a stored or published document, keyed by normalized source type. */
export function parseReviewedEntries(value: unknown): Record<string, VendorFieldEntry> {
  let c: any = value;
  for (let i = 0; i < 3 && typeof c === 'string'; i++) { try { c = JSON.parse(c); } catch { c = null; } }
  c = c?.items?.[0]?.value ?? c;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
  const out: Record<string, VendorFieldEntry> = {};
  for (const [k, v] of Object.entries(c && typeof c.entries === 'object' && c.entries ? c.entries : {})) {
    const key = normalizeSourcetype(k), entry = sanitizeReviewedEntry(v);
    if (key && entry) out[key] = entry;
  }
  return out;
}

/** The bundled library with imported reviewed entries on top (an imported entry replaces the bundled one). */
export function mergeLibrary(base: VendorFieldLibrary, imported: Record<string, VendorFieldEntry>): VendorFieldLibrary {
  if (!Object.keys(imported).length) return base;
  return { ...base, entries: { ...base.entries, ...imported } };
}

export async function loadImportedEntries(): Promise<Record<string, VendorFieldEntry>> {
  if (getRunMode() !== 'standalone') {
    try {
      const resp = await fetch(`${apiBase()}/kvstore/${POOL_KV_KEY}`);
      if (resp.ok) return parseReviewedEntries(await resp.text());
    } catch { /* fall back to the browser copy */ }
  }
  return parseReviewedEntries(safeGetItem(POOL_LS_KEY));
}

export async function saveImportedEntries(entries: Record<string, VendorFieldEntry>, now = new Date().toISOString()): Promise<void> {
  const body = JSON.stringify({ importedAt: now, entries });
  safeSetItem(POOL_LS_KEY, body);
  if (getRunMode() !== 'standalone') {
    const resp = await fetch(`${apiBase()}/kvstore/${POOL_KV_KEY}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
    if (!resp.ok) throw new Error(`Saving the vendor field lists failed (${resp.status}).`);
  }
}

/** The library every reader uses: bundled + imported reviewed entries. */
export async function loadLibrary(): Promise<VendorFieldLibrary> {
  try { return mergeLibrary(BUNDLED_LIBRARY, await loadImportedEntries()); } catch { return BUNDLED_LIBRARY; }
}

/** Pure: `seen` with one build's field names added for `key`. */
export function addSeen(seen: SeenFields, key: string, names: string[], now = new Date().toISOString()): SeenFields {
  const cur = { ...(seen.sourcetypes[key] || {}) };
  for (const n of new Set(names)) {
    if (!NAME_RE.test(n)) continue;
    if (!(n in cur) && Object.keys(cur).length >= MAX_FIELDS_PER_SOURCETYPE) continue;
    cur[n] = (cur[n] || 0) + 1;
  }
  return { sourcetypes: { ...seen.sourcetypes, [key]: cur }, updatedAt: now };
}

/** Records the field names one build extracted. Names only; values never leave the build. */
export async function recordSeenFields(sourcetype: string, names: string[]): Promise<void> {
  if (!sourcetype || !names.length) return;
  const key = findEntry(BUNDLED_LIBRARY, sourcetype)?.key ?? normalizeSourcetype(sourcetype);
  const next = addSeen(await loadSeenFields(), key, names);
  const body = JSON.stringify(next);
  safeSetItem(SEEN_LS_KEY, body);
  if (getRunMode() === 'iframe') {
    try {
      // text/plain: App KV stores a JSON content-type body as "[object Object]".
      await fetch(`${apiBase()}/kvstore/${SEEN_KV_KEY}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
    } catch { /* the browser copy above is kept */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Effective state

export interface LibraryState {
  key: string;
  entry: VendorFieldEntry;
  /** `closed` only when the entry is closed AND nothing seen falls outside it. */
  status: 'open' | 'closed' | 'reopened';
  /** Seen fields a closed entry does not cover (why it was reopened). */
  unexpected: string[];
  /** Everything known to exist: documented + seen + common. */
  known: string[];
  /** The list removal may rely on (closed only): documented + common. */
  complete: string[] | null;
  /** Fields confirmed for the source (listed in the entry, or learned from a sample): a chain reading
   *  one of them drops its unconfirmed alternatives. */
  confirmed: string[];
  /** The confirmed fields learned from samples on this install (not in the bundled entry). */
  learned: string[];
}

/**
 * The library view a batch build uses to drop `||` fallbacks. Null when this source type has no
 * entry: the generated chains stay as they are. Seen names from this build count as confirmed,
 * the same way a performance-mode apply does.
 */
export async function libraryCleanOptions(sourcetype: string, seenNow: string[] = []): Promise<{
  key: string;
  status: LibraryState['status'];
  complete: string[] | null;
  confirmed: string[];
  known: string[];
} | null> {
  const lib = await loadLibrary();
  const hit = findEntry(lib, sourcetype);
  const seen = await loadSeenFields();
  const state = libraryState(lib, addSeen(seen, hit?.key ?? '', seenNow), sourcetype);
  if (!state) return null;
  return { key: state.key, status: state.status, complete: state.complete, confirmed: state.confirmed, known: state.known };
}

export function libraryState(lib: VendorFieldLibrary, seen: SeenFields, sourcetype: string | undefined): LibraryState | null {
  const hit = findEntry(lib, sourcetype);
  if (!hit) return null;
  const { key, entry } = hit;
  const documented = [...entry.fields, ...lib.commonFields];
  const seenNames = Object.keys(seen.sourcetypes[key] || {});
  const unexpected = entry.status === 'closed' ? seenNames.filter(n => !pathCovered(documented, n)) : [];
  const status = entry.status !== 'closed' ? 'open' : unexpected.length ? 'reopened' : 'closed';
  // A field a sample showed for this source type is as real as a documented one: it confirms too,
  // so every variant that ever occurred stays in its `||` chain. Common fields never anchor a chain.
  const learned = seenNames.filter(n => !pathCovered(entry.fields, n) && !pathCovered(lib.commonFields, n));
  return { key, entry, status, unexpected, known: [...documented, ...seenNames], complete: status === 'closed' ? documented : null,
    confirmed: [...entry.fields, ...learned], learned };
}
