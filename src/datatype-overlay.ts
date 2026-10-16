/**
 * Per-install overlay of Cribl Search datatype parsers.
 *
 * Standalone syncs the Search catalog straight into config/datatype-parsers.json,
 * which is the repo's own file — an option the iframe does not have, because it
 * has no filesystem. So the iframe keeps its imports in the app's scoped KV store
 * and layers them over the bundled store at resolution time.
 *
 * The overlay is a DELTA against the bundled store, not a copy of it: `parsers`
 * holds entries that are new or differ, `removed` holds bundled ids the live
 * catalog no longer has. That keeps it small (an install typically imports a
 * handful of datatypes), and it survives an app upgrade sensibly — a bundled
 * parser that catches up with Search simply stops being overridden, and the next
 * sync drops the entry.
 */
import { getRunMode } from './run-mode';
import { safeGetItem, safeSetItem } from './safe-storage';
import type { TranslatedDatatype } from './datatype-translate';

export interface DatatypeOverlay {
  parsers: Record<string, TranslatedDatatype>;
  removed: string[];
  updatedAt: string;
  /** Search group the import came from, so the UI can say where it came from. */
  group?: string;
}

export const DATATYPE_OVERLAY_KV_KEY = 'datatype-parsers/overlay';
export const DATATYPE_OVERLAY_LS_KEY = 'datatype-parser-overlay';

// The KV store is meant for app state, not for shipping a second copy of the
// parser library through it. A delta that large means something built the
// overlay against the wrong baseline, and we would rather say so than write it.
export const DATATYPE_OVERLAY_MAX_BYTES = 1_000_000;

export const emptyDatatypeOverlay = (): DatatypeOverlay =>
  ({ parsers: {}, removed: [], updatedAt: '' });

const apiBase = (): string => {
  const fromWindow = typeof window !== 'undefined' ? window.CRIBL_API_URL : undefined;
  return fromWindow && fromWindow.length > 0 ? fromWindow.replace(/\/+$/, '') : '/api/v1';
};

const overlayUrl = (): string => `${apiBase()}/kvstore/${DATATYPE_OVERLAY_KV_KEY}`;

// A KV GET can come back as the raw document, as a JSON string of it, or wrapped
// in the API's `items[0].value` envelope — the generated-sample cache hit all
// three in practice, so unwrap defensively rather than trusting one shape.
export function parseDatatypeOverlay(value: unknown): DatatypeOverlay | null {
  let candidate: any = value;
  for (let i = 0; i < 3 && typeof candidate === 'string'; i++) {
    if (!candidate.trim()) return null;
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  candidate = candidate?.items?.[0]?.value ?? candidate?.value ?? candidate;
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const parsers = candidate.parsers && typeof candidate.parsers === 'object' ? candidate.parsers : null;
  const removed = Array.isArray(candidate.removed) ? candidate.removed.filter((id: unknown) => typeof id === 'string') : [];
  if (!parsers && removed.length === 0) return null;
  return {
    parsers: parsers || {},
    removed,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    group: typeof candidate.group === 'string' ? candidate.group : undefined,
  };
}

export function overlayIsEmpty(overlay: DatatypeOverlay | null | undefined): boolean {
  return !overlay || (Object.keys(overlay.parsers || {}).length === 0 && (overlay.removed || []).length === 0);
}

/**
 * The delta between the bundled store and the store an apply produced. Computing
 * it against the BUNDLED baseline (rather than against whatever is loaded) is
 * what makes a repeated sync idempotent instead of cumulative.
 */
export function diffDatatypeOverlay(
  bundled: Record<string, TranslatedDatatype>,
  next: Record<string, TranslatedDatatype>,
  meta: { group?: string; now?: string } = {},
): DatatypeOverlay {
  const parsers: Record<string, TranslatedDatatype> = {};
  for (const [id, parser] of Object.entries(next)) {
    const before = bundled[id];
    if (!before || JSON.stringify(before) !== JSON.stringify(parser)) parsers[id] = parser;
  }
  const removed = Object.keys(bundled).filter(id => !(id in next));
  return { parsers, removed, updatedAt: meta.now || new Date().toISOString(), group: meta.group };
}

/** Bundled store + overlay, as the app should resolve parsers. */
export function mergeDatatypeOverlay(
  bundled: Record<string, TranslatedDatatype>,
  overlay: DatatypeOverlay | null | undefined,
): Record<string, TranslatedDatatype> {
  const merged: Record<string, TranslatedDatatype> = { ...bundled };
  for (const id of overlay?.removed || []) delete merged[id];
  for (const [id, parser] of Object.entries(overlay?.parsers || {})) merged[id] = parser;
  return merged;
}

export async function loadDatatypeOverlay(): Promise<DatatypeOverlay | null> {
  if (getRunMode() === 'iframe') {
    try {
      const resp = await fetch(overlayUrl());
      if (resp.ok) {
        const parsed = parseDatatypeOverlay(await resp.text());
        if (parsed) return parsed;
      }
    } catch { /* fall through to the browser copy */ }
  }
  return parseDatatypeOverlay(safeGetItem(DATATYPE_OVERLAY_LS_KEY));
}

export interface OverlaySaveResult { storedIn: 'app-kv' | 'browser' }

export async function saveDatatypeOverlay(overlay: DatatypeOverlay): Promise<OverlaySaveResult> {
  const body = JSON.stringify(overlay);
  if (body.length > DATATYPE_OVERLAY_MAX_BYTES) {
    throw new Error(
      `Datatype import is ${Math.round(body.length / 1024)} KB, over the ${Math.round(DATATYPE_OVERLAY_MAX_BYTES / 1024)} KB this app stores per install. Sync from standalone mode instead, which writes the parser library itself.`,
    );
  }
  // The browser copy is written first and unconditionally: it is what makes the
  // import survive a reload when the KV write is the thing that failed.
  safeSetItem(DATATYPE_OVERLAY_LS_KEY, body);
  if (getRunMode() === 'iframe') {
    try {
      const resp = await fetch(overlayUrl(), {
        method: 'PUT',
        // text/plain, not application/json: App KV stores a JSON content-type body as
        // "[object Object]", so the write "succeeds" and the next read finds nothing.
        headers: { 'Content-Type': 'text/plain' },
        body,
      });
      if (resp.ok) return { storedIn: 'app-kv' };
    } catch { /* fall back to the browser copy below */ }
  }
  return { storedIn: 'browser' };
}
