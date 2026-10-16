/**
 * Durable golden store for the iframe: the app's own App KV.
 *
 * The App Platform frame is sandboxed, and there `localStorage` throws on every
 * access — so `safe-storage` serves goldens from its in-memory fallback, and a
 * golden import or a golden saved by a build was gone on the next reload. The
 * "newer goldens to import" notice came back after every refresh because the
 * import had never been written anywhere that lasts.
 *
 * Layout, both under the app-scoped KV:
 *   goldens/index         { "<golden key>": score }  — one GET answers "what is stored"
 *   goldens/doc/<key>     the golden body, one document each, key escaped by
 *                         kvSafeSegment (< 100 KiB; the
 *                         largest bundled golden is ~52 KB)
 *
 * Like the datatype overlay, this is a DELTA over the bundle: only goldens that
 * are imported or built — never a copy of what ships.
 */
import { getRunMode } from './run-mode';

export const GOLDEN_KV_INDEX_KEY = 'goldens/index';
export const GOLDEN_KV_DOC_MAX_BYTES = 102_400;
/**
 * App KV keys route only as [A-Za-z0-9._/-]: a percent-encoded `:` or `#` is a
 * 404 "Cannot GET" on a real org (checked 2026-10-04), so every other character
 * — `-` and `.` included, to stay reversible — is written as `-` + hex bytes:
 * `sap_audit::ocsf#authentication` → `sap_audit-3a-3aocsf-23authentication`.
 */
export const kvSafeSegment = (key: string): string =>
  key.replace(/[^A-Za-z0-9_]/g, c => [...new TextEncoder().encode(c)].map(b => `-${b.toString(16).padStart(2, '0')}`).join(''));
export const goldenKvDocKey = (key: string): string => `goldens/doc/${kvSafeSegment(key)}`;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
let baseOverride: string | null = null;
/** Tests point the store at a fake KV. */
export function setGoldenKvTransport(f: FetchLike, base: string): void {
  fetchImpl = f; baseOverride = base; indexPromise = null; docCache.clear();
}

const apiBase = (): string => {
  if (baseOverride != null) return baseOverride;
  const fromWindow = typeof window !== 'undefined' ? window.CRIBL_API_URL : undefined;
  return fromWindow && fromWindow.length > 0 ? fromWindow.replace(/\/+$/, '') : '/api/v1';
};
const url = (k: string): string => `${apiBase()}/kvstore/${k}`;

export const goldenKvEnabled = (): boolean => baseOverride != null || getRunMode() === 'iframe';

// A KV GET can come back as the raw document, as a JSON string of it, or wrapped
// in `items[0].value` (see datatype-overlay.ts) — unwrap all three.
export function parseKvJson(value: unknown): any {
  let v: any = value;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    if (!v.trim()) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (v && typeof v === 'object' && Array.isArray(v.items)) v = v.items[0]?.value ?? null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  return v && typeof v === 'object' ? v : null;
}

async function kvGet(k: string): Promise<any> {
  const resp = await fetchImpl(url(k));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`App KV read ${k} failed (${resp.status})`);
  return parseKvJson(await resp.text());
}

async function kvPut(k: string, body: string): Promise<void> {
  // text/plain, not application/json — a JSON content-type PUT is stored as
  // "[object Object]" (build 725 finding; see saveGeneratedSample).
  const resp = await fetchImpl(url(k), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
  if (!resp.ok) throw new Error(`App KV write failed (${resp.status})`);
}

let indexPromise: Promise<Record<string, number>> | null = null;
const docCache = new Map<string, any>();

/** key → score of every golden stored in KV; one GET per session. */
export function loadGoldenKvIndex(): Promise<Record<string, number>> {
  if (!goldenKvEnabled()) return Promise.resolve({});
  indexPromise ??= kvGet(GOLDEN_KV_INDEX_KEY)
    .then(v => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, number> : {}))
    .catch(() => { indexPromise = null; return {}; });
  return indexPromise;
}

/** The stored golden for `key` (the bare key, no `golden::`), or null. */
export async function readGoldenKv(key: string): Promise<any | null> {
  if (docCache.has(key)) return docCache.get(key);
  const index = await loadGoldenKvIndex();
  if (!(key in index)) return null;
  try {
    const doc = await kvGet(goldenKvDocKey(key));
    if (doc) docCache.set(key, doc);
    return doc;
  } catch { return null; }
}

/** Write a golden body (JSON text) and record it in the index. */
export async function writeGoldenKv(key: string, body: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!goldenKvEnabled()) return { ok: false, reason: 'App KV is not available here' };
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > GOLDEN_KV_DOC_MAX_BYTES) {
    return { ok: false, reason: `Golden is ${Math.round(bytes / 1024)} KB, over the ${GOLDEN_KV_DOC_MAX_BYTES / 1024} KB App KV document limit` };
  }
  let doc: any;
  try { doc = JSON.parse(body); } catch { return { ok: false, reason: 'Golden body is not JSON' }; }
  try {
    await kvPut(goldenKvDocKey(key), body);
    // Re-read the index right before writing it, so two tabs importing at once
    // lose at most an index entry for a doc that is still there to re-import.
    indexPromise = null;
    const index = { ...(await loadGoldenKvIndex()) };
    index[key] = typeof doc?.score === 'number' ? doc.score : 0;
    await kvPut(GOLDEN_KV_INDEX_KEY, JSON.stringify(index));
    indexPromise = Promise.resolve(index);
    docCache.set(key, doc);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'App KV write failed' };
  }
}
