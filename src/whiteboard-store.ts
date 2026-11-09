/**
 * Where discovery whiteboards are kept (spec R2, R3; plan Task 2).
 *
 *   iframe      App KV — the app frame is sandboxed and localStorage throws there
 *                 whiteboards/index         { boards: WhiteboardIndexEntry[] }
 *                 whiteboards/library       the SE's whiteboard library (v5 LIB)
 *                 whiteboards/doc/<id>      one WhiteboardDoc each (< 95 KiB)
 *                 whiteboards/arch/<id>     the board's Architecture drawing (ArchDoc, < 95 KiB)
 *   standalone  browser localStorage, same layout under `pg:whiteboards:*`
 *   backend     not used — the Whiteboards page is UI-only
 *
 * A save that did not land says so ({ok:false, reason, message}); it is never reported
 * as saved. The index entry is derived from the document (`summarizeBoard`), never
 * built by a caller, so the list cannot disagree with the board.
 */
import { kvSafeSegment, parseKvJson } from './golden-kv';
import { getRunMode } from './run-mode';
import { safeGetItem, safeRemoveItem, safeSetItemDurable } from './safe-storage';
import { boardSketch, boardSummary, emptyMeet, intakeFingerprint } from './whiteboard/board-model';
import type { WhiteboardDoc, WhiteboardIndexEntry, WhiteboardLibV5, WhiteboardMeetV5 } from './whiteboard/types';
import type { ArchDoc } from './architecture/model';

export const WHITEBOARD_DOC_MAX_BYTES = 95 * 1024;
const LOGO_THUMB_MAX_CHARS = 4096;
const MAX_DEPLOYMENTS = 10;

export type SaveResult = { ok: true } | { ok: false; reason: 'too-large' | 'unavailable' | 'kv-error'; message: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
let baseOverride: string | null = null;
let modeOverride: 'kv' | 'local' | null = null;

/** Tests point the store at a fake KV (or force the local layout with `base: null`). */
export function setWhiteboardTransport(f: FetchLike | null, base: string | null): void {
  if (f) fetchImpl = f;
  baseOverride = base;
  modeOverride = base == null ? 'local' : 'kv';
}

const storeInKv = (): boolean => (modeOverride ? modeOverride === 'kv' : getRunMode() === 'iframe');

const apiBase = (): string => {
  if (baseOverride != null) return baseOverride;
  const fromWindow = typeof window !== 'undefined' ? window.CRIBL_API_URL : undefined;
  return fromWindow && fromWindow.length > 0 ? fromWindow.replace(/\/+$/, '') : '/api/v1';
};

const KV = {
  index: 'whiteboards/index',
  library: 'whiteboards/library',
  doc: (id: string) => `whiteboards/doc/${kvSafeSegment(id)}`,
  arch: (id: string) => `whiteboards/arch/${kvSafeSegment(id)}`,
};
const LOCAL = {
  index: 'pg:whiteboards:index',
  library: 'pg:whiteboards:library',
  doc: (id: string) => `pg:whiteboards:doc:${id}`,
  arch: (id: string) => `pg:whiteboards:arch:${id}`,
};

async function kvGet(key: string): Promise<any> {
  const resp = await fetchImpl(`${apiBase()}/kvstore/${key}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`App KV read failed (${resp.status})`);
  return parseKvJson(await resp.text());
}

async function kvPut(key: string, body: string): Promise<void> {
  // text/plain, not application/json — a JSON content-type PUT is stored as "[object Object]".
  const resp = await fetchImpl(`${apiBase()}/kvstore/${key}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
  if (!resp.ok) throw new Error(`App KV write failed (${resp.status})`);
}

async function kvDelete(key: string): Promise<void> {
  const resp = await fetchImpl(`${apiBase()}/kvstore/${key}`, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) throw new Error(`App KV delete failed (${resp.status})`);
}

function localGet(key: string): any {
  const raw = safeGetItem(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const read = (kvKey: string, localKey: string): Promise<any> => (storeInKv() ? kvGet(kvKey) : Promise.resolve(localGet(localKey)));

async function write(kvKey: string, localKey: string, body: string): Promise<SaveResult> {
  if (storeInKv()) {
    try { await kvPut(kvKey, body); return { ok: true }; }
    catch (err) { return { ok: false, reason: 'kv-error', message: err instanceof Error ? err.message : 'App KV write failed' }; }
  }
  return safeSetItemDurable(localKey, body)
    ? { ok: true }
    : { ok: false, reason: 'unavailable', message: 'Browser storage is unavailable or full' };
}

export function newBoardId(now = Date.now()): string {
  return `wb_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A new board; `meet` (e.g. `blankMeet`) replaces the board's usual opening meeting. */
export function newBoardDoc(now = new Date(), meet?: WhiteboardMeetV5): WhiteboardDoc {
  const iso = now.toISOString();
  return { v: 1, id: newBoardId(now.getTime()), createdAt: iso, updatedAt: iso, meet: meet ?? emptyMeet(now), deployments: [] };
}

/** The list row for a board — always derived from the document and the library. */
export function summarizeBoard(doc: WhiteboardDoc, lib: WhiteboardLibV5 | null): WhiteboardIndexEntry {
  const fingerprint = intakeFingerprint(lib, doc.meet);
  const last = doc.deployments[0];
  const logo = typeof doc.meet.logo === 'string' ? doc.meet.logo : '';
  return {
    id: doc.id,
    prospect: String(doc.meet.prospect || '').trim(),
    ...(logo && logo.length <= LOGO_THUMB_MAX_CHARS ? { logoThumb: logo } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    summary: boardSummary(lib, doc.meet),
    sketch: boardSketch(lib, doc.meet),
    validation: !doc.validation ? 'none' : doc.validation.intakeFingerprint === fingerprint ? 'complete' : 'stale',
    ...(doc.demoNs ? { demoNs: doc.demoNs } : {}),
    ...(last ? {
      demo: {
        group: last.group,
        deployedAt: last.removedAt || last.deployedAt,
        status: last.status === 'removed' ? 'removed' as const : last.intakeFingerprint !== fingerprint ? 'stale' as const : last.status,
        ...(last.ns ? { ns: last.ns } : {}),
      },
    } : {}),
  };
}

const byUpdatedDesc = (a: WhiteboardIndexEntry, b: WhiteboardIndexEntry) => b.updatedAt.localeCompare(a.updatedAt);

async function readIndex(): Promise<WhiteboardIndexEntry[]> {
  const v = await read(KV.index, LOCAL.index);
  return Array.isArray(v?.boards) ? (v.boards as WhiteboardIndexEntry[]).filter(e => e && typeof e.id === 'string') : [];
}

/** Every board, most recently edited first. */
export async function listBoards(): Promise<WhiteboardIndexEntry[]> {
  return (await readIndex()).sort(byUpdatedDesc);
}

export async function loadBoard(id: string): Promise<WhiteboardDoc | null> {
  const doc = await read(KV.doc(id), LOCAL.doc(id));
  return doc && doc.v === 1 && doc.id === id && doc.meet ? normalizeDoc(doc) : null;
}

function normalizeDoc(doc: WhiteboardDoc): WhiteboardDoc {
  return { ...doc, deployments: Array.isArray(doc.deployments) ? doc.deployments.slice(0, MAX_DEPLOYMENTS) : [] };
}

/** Write the board, then its row in the index (re-read just before, so two tabs lose at most a row). */
export async function saveBoard(doc: WhiteboardDoc, lib: WhiteboardLibV5 | null): Promise<SaveResult> {
  const body = JSON.stringify(normalizeDoc(doc));
  if (new TextEncoder().encode(body).length > WHITEBOARD_DOC_MAX_BYTES) {
    return { ok: false, reason: 'too-large', message: 'The logo is too large. Replace it with a smaller image.' };
  }
  const saved = await write(KV.doc(doc.id), LOCAL.doc(doc.id), body);
  if (!saved.ok) return saved;
  try {
    const all = await readIndex();
    const prev = all.find(e => e.id === doc.id);
    const rows = all.filter(e => e.id !== doc.id);
    // the drawing's summary is written by saveArchitecture; the board's own save keeps it
    rows.push({ ...summarizeBoard(doc, lib), ...(prev?.arch ? { arch: prev.arch } : {}) });
    return await write(KV.index, LOCAL.index, JSON.stringify({ boards: rows.sort(byUpdatedDesc) }));
  } catch (err) {
    return { ok: false, reason: 'kv-error', message: err instanceof Error ? err.message : 'Could not update the list of whiteboards' };
  }
}

export async function deleteBoard(id: string): Promise<SaveResult> {
  try {
    const rows = (await readIndex()).filter(e => e.id !== id);
    const listed = await write(KV.index, LOCAL.index, JSON.stringify({ boards: rows }));
    if (!listed.ok) return listed;
    if (storeInKv()) { await kvDelete(KV.doc(id)); await kvDelete(KV.arch(id)); }
    else { safeRemoveItem(LOCAL.doc(id)); safeRemoveItem(LOCAL.arch(id)); }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'kv-error', message: err instanceof Error ? err.message : 'App KV delete failed' };
  }
}

// --- the Architecture drawing ------------------------------------------------

/** What the list says about a board's drawing: the parts on it, its groups and fleets. */
export function archSummary(doc: ArchDoc, now = new Date()): NonNullable<WhiteboardIndexEntry['arch']> {
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  return {
    parts: nodes.filter(n => !n.parent && n.type !== 'zone').length,
    groups: nodes.filter(n => n.type === 'wg' || n.type === 'fleet').length,
    updatedAt: now.toISOString(),
  };
}

/** The board's drawing, or null when none was drawn. */
export async function loadArchitecture(id: string): Promise<ArchDoc | null> {
  const doc = await read(KV.arch(id), LOCAL.arch(id));
  return doc && doc.v === 1 && Array.isArray(doc.nodes) ? (doc as ArchDoc) : null;
}

/** Write the drawing, then its summary on the board's row (an empty drawing clears it). */
export async function saveArchitecture(id: string, doc: ArchDoc, now = new Date()): Promise<SaveResult> {
  const body = JSON.stringify(doc);
  if (new TextEncoder().encode(body).length > WHITEBOARD_DOC_MAX_BYTES) {
    return { ok: false, reason: 'too-large', message: 'The drawing is over the storage limit. Remove some parts or lines.' };
  }
  const saved = await write(KV.arch(id), LOCAL.arch(id), body);
  if (!saved.ok) return saved;
  try {
    const rows = await readIndex();
    const row = rows.find(e => e.id === id);
    if (!row) return { ok: true };
    const sum = archSummary(doc, now);
    if (sum.parts) row.arch = sum; else delete row.arch;
    return await write(KV.index, LOCAL.index, JSON.stringify({ boards: rows.sort(byUpdatedDesc) }));
  } catch (err) {
    return { ok: false, reason: 'kv-error', message: err instanceof Error ? err.message : 'Could not update the list of whiteboards' };
  }
}

/** The SE's library, or null when none was saved yet (the board then starts from its defaults). */
export async function loadLibrary(): Promise<WhiteboardLibV5 | null> {
  const v = await read(KV.library, LOCAL.library);
  return v && v.v === 5 && v.groups ? (v as WhiteboardLibV5) : null;
}

export async function saveLibrary(lib: WhiteboardLibV5): Promise<SaveResult> {
  const body = JSON.stringify(lib);
  if (new TextEncoder().encode(body).length > WHITEBOARD_DOC_MAX_BYTES) {
    return { ok: false, reason: 'too-large', message: 'Your whiteboard library is over the storage limit. Delete some of your own entries in Configure.' };
  }
  return write(KV.library, LOCAL.library, body);
}

/**
 * Give a board a new prospect name (the list's rename). Only the name changes; the logo,
 * the drawing and the demos stay. An empty name is refused — clearing it is not a rename.
 */
export async function renameBoard(id: string, name: string, now = new Date()): Promise<SaveResult> {
  const prospect = name.trim();
  if (!prospect) return { ok: false, reason: 'unavailable', message: 'A whiteboard needs a name' };
  let doc: WhiteboardDoc | null;
  let lib: WhiteboardLibV5 | null;
  try { [doc, lib] = await Promise.all([loadBoard(id), loadLibrary()]); }
  catch (err) { return { ok: false, reason: 'kv-error', message: err instanceof Error ? err.message : 'App KV read failed' }; }
  if (!doc) return { ok: false, reason: 'unavailable', message: 'That whiteboard could not be found' };
  if (String(doc.meet.prospect || '').trim() === prospect) return { ok: true };
  return saveBoard({ ...doc, updatedAt: now.toISOString(), meet: { ...doc.meet, prospect } }, lib);
}

/** Copy of a board under a new id, without its validation or deploy history. */
export function duplicateBoard(doc: WhiteboardDoc, now = new Date()): WhiteboardDoc {
  const iso = now.toISOString();
  const meet: WhiteboardMeetV5 = JSON.parse(JSON.stringify(doc.meet));
  meet.prospect = meet.prospect ? `${meet.prospect} (copy)` : '';
  return { v: 1, id: newBoardId(now.getTime()), createdAt: iso, updatedAt: iso, meet, deployments: [] };
}

// --- autosave ---------------------------------------------------------------

export type SaveStatus =
  | { state: 'saved'; at: string }
  | { state: 'saving' }
  | { state: 'unsaved'; reason: Extract<SaveResult, { ok: false }>['reason']; message: string };

export interface Autosaver<T> {
  /** Queue the latest value; written after `delayMs` without another push. */
  push(value: T): void;
  /** Write the latest value now (leaving the page, closing the board). */
  flush(): Promise<void>;
  status(): SaveStatus | null;
  /** True while a value has been pushed but not yet written successfully. */
  dirty(): boolean;
  dispose(): void;
}

/**
 * Debounced writes with at most one in flight; the latest value always wins. A failed
 * write keeps the value, reports `unsaved` with the reason, and retries every
 * `retryMs` until it lands — the SE can keep drawing in the meantime.
 */
export function createAutosaver<T>(save: (value: T) => Promise<SaveResult>, opts: {
  delayMs?: number; retryMs?: number; onStatus?: (s: SaveStatus) => void; now?: () => Date;
} = {}): Autosaver<T> {
  const delayMs = opts.delayMs ?? 800;
  const retryMs = opts.retryMs ?? 30_000;
  const now = opts.now ?? (() => new Date());
  let latest: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let status: SaveStatus | null = null;
  let disposed = false;

  const setStatus = (s: SaveStatus) => { status = s; opts.onStatus?.(s); };
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, ms);
  };

  async function run(): Promise<void> {
    if (disposed && !latest) return;
    if (inFlight) { await inFlight; if (latest) return run(); return; }
    if (!latest) return;
    const pending = latest;
    latest = null;
    setStatus({ state: 'saving' });
    inFlight = (async () => {
      let result: SaveResult;
      try { result = await save(pending.value); }
      catch (err) { result = { ok: false, reason: 'kv-error', message: err instanceof Error ? err.message : String(err) }; }
      if (result.ok) {
        if (!latest) setStatus({ state: 'saved', at: now().toISOString() });
      } else {
        latest ??= pending;   // keep it unless something newer is already queued
        setStatus({ state: 'unsaved', reason: result.reason, message: result.message });
        if (!disposed) schedule(retryMs);
      }
    })();
    try { await inFlight; } finally { inFlight = null; }
    if (latest && !timer && !disposed && status?.state !== 'unsaved') schedule(delayMs);
  }

  return {
    push(value) { latest = { value }; schedule(delayMs); },
    async flush() { if (timer) { clearTimeout(timer); timer = null; } await run(); },
    status: () => status,
    dirty: () => latest !== null || inFlight !== null,
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
