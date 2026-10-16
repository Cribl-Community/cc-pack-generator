import type { BackgroundBatchCheckpoint } from './background-batch';
import {
  BackgroundBatchCorruptDocumentError,
  BackgroundBatchTransientReadError,
  isBackgroundBatchCorruptDocumentError,
} from './background-batch-errors';

// One definition, two doors: the taxonomy is import-free so the pure runtime
// and the UI can classify a failure without reaching this module's transport,
// and it is re-exported here so every existing importer — and `instanceof` —
// keeps working (build 752).
export {
  BackgroundBatchCorruptDocumentError,
  BackgroundBatchTransientReadError,
  backgroundRunIdOf,
  isBackgroundBatchCorruptDocumentError,
  isBackgroundBatchTransientReadError,
  tagBackgroundRunId,
} from './background-batch-errors';

/**
 * App KV routes a key verbatim, so a percent-escape in one matches no route and
 * the platform answers 400 — escaping an id is what makes it unaddressable, not
 * what makes it safe. Only these characters survive the round trip (measured).
 */
const KV_SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const kvSegment = (id: string, role: string): string => {
  if (!KV_SAFE_SEGMENT.test(id)) {
    throw new Error(
      `Background batch ${role} "${id}" is not addressable in App KV — a key segment may use only letters, digits, "_", "." and "-".`,
    );
  }
  return id;
};

/**
 * Derive an addressable segment from data (a sourcetype), which — unlike the
 * app's own generated ids — can contain anything. The hash keeps two sources
 * that differ only in a replaced character from sharing one artifact.
 */
export const kvSafeSegment = (id: string): string => {
  if (KV_SAFE_SEGMENT.test(id)) return id;
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0;
  }
  const slug = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  return `${slug}.${hash.toString(16).padStart(8, '0')}`;
};

export const activeRunKey = 'batch-run/background/active';
export const runManifestKey = (runId: string): string =>
  `batch-run/background/runs/${kvSegment(runId, 'run id')}`;
export const runArtifactPrefix = (runId: string): string =>
  `batch-run/background/artifacts/${kvSegment(runId, 'run id')}/`;
export const rowArtifactKey = (runId: string, rowId: string): string =>
  `${runArtifactPrefix(runId)}${kvSegment(rowId, 'row id')}`;

/**
 * The platform's App KV document limit, measured rather than assumed: the org
 * accepted 101,961 bytes and refused 102,839 with a 413. A local cap ABOVE the
 * platform's own never fires, so the 413 becomes the guard — and it arrives
 * after a stage has spent its whole invocation, with the row unrecoverable.
 */
export const BACKGROUND_ROW_ARTIFACT_MAX_BYTES = 102_400;

/**
 * The biggest named field inside the document, so an over-cap error can say
 * what to shrink. The document itself is never the answer — the caller already
 * knows its total and cannot act on it.
 */
const largestField = (value: unknown, path = ''): { path: string; bytes: number } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let worst: { path: string; bytes: number } | null = null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const bytes = serializedUtf8Bytes(child ?? null);
    if (!worst || bytes > worst.bytes) worst = { path: path ? `${path}.${key}` : key, bytes };
  }
  if (!worst) return null;
  // Keep descending while one field still accounts for most of what is above
  // it, so the message names the payload rather than the branch holding it.
  const inner = largestField((value as Record<string, unknown>)[worst.path.split('.').pop() as string], worst.path);
  return inner && inner.bytes * 2 > worst.bytes ? inner : worst;
};

export interface BackgroundBatchStore {
  loadActiveRunId(): Promise<string | null>;
  createRun(cp: BackgroundBatchCheckpoint): Promise<void>;
  loadRun(runId: string): Promise<BackgroundBatchCheckpoint | null>;
  saveRun(cp: BackgroundBatchCheckpoint): Promise<void>;
  loadArtifact<T>(key: string): Promise<T | null>;
  saveArtifact<T>(key: string, value: T): Promise<void>;
  deleteRun(runId: string): Promise<void>;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultApiBase = (): string => {
  const fromWindow = typeof window !== 'undefined' ? window.CRIBL_API_URL : undefined;
  return fromWindow && fromWindow.length > 0 ? fromWindow.replace(/\/+$/, '') : '/api/v1';
};

export function serializedUtf8Bytes(value: unknown, serializedBody?: string): number {
  const body = serializedBody ?? JSON.stringify(value);
  if (body === undefined) throw new Error('Background row artifact is not JSON serializable.');
  return new TextEncoder().encode(body).length;
}

/**
 * Make a manifest fit App KV's document limit by shedding per-row messages —
 * in row order. A large batch (198 rows) sits a
 * few hundred bytes under the limit, and the stop/kill writes that settle the
 * remaining rows used to add a message to each one: the write was refused, Stop
 * never landed, and Kill failed AFTER removing the schedule — a run that could
 * no longer move either way. Phases carry the outcome; messages are detail. Applied by `saveRun`, so EVERY manifest write
 * (runner stages, Stop, Kill) gets it.
 */
export function fitRunManifest(cp: BackgroundBatchCheckpoint, limit = BACKGROUND_ROW_ARTIFACT_MAX_BYTES): BackgroundBatchCheckpoint {
  if (serializedUtf8Bytes(cp) <= limit) return cp;
  const rows = [...cp.rows];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].message == null) continue;
    const { message: _m, ...rest } = rows[i];
    rows[i] = rest;
    if (i % 8 === 7 && serializedUtf8Bytes({ ...cp, rows }) <= limit) break;
  }
  return { ...cp, rows };
}


/**
 * A stored body that begins with this marker is gzip-then-base64, not JSON. The
 * marker is deliberately not a character JSON can start with, so a reader tells
 * the two apart by the first bytes alone — and an OLD plaintext document written
 * before this build is still read verbatim (backward compatible).
 */
const GZIP_PREFIX = 'gzip:b64:';

async function drainStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

// btoa/atob operate on binary strings, so bytes are shuttled through one in
// 0x8000-char slices — a single String.fromCharCode(...bytes) overflows the call
// stack on a 100 KiB artifact.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Gzip a JSON body to a base64 marker string, or return null when the runtime
 * has no Web-Streams CompressionStream. Both the browser and the Backend
 * Function run on a runtime that has it (each already relies on global `fetch`),
 * but the null path keeps a stranger runtime correct rather than crashing: the
 * caller then stores plaintext and the existing over-limit guard still fires.
 */
async function gzipToMarker(json: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    void writer.write(new TextEncoder().encode(json));
    void writer.close();
    return GZIP_PREFIX + bytesToBase64(await drainStream(cs.readable));
  } catch {
    return null;
  }
}

async function gunzipFromMarker(body: string): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'A background batch document is gzip-compressed but this runtime has no DecompressionStream to read it.',
    );
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  void writer.write(base64ToBytes(body.slice(GZIP_PREFIX.length)));
  void writer.close();
  return new TextDecoder().decode(await drainStream(ds.readable));
}

/**
 * Serialize a value to the body that actually goes on the wire, and report the
 * bytes THAT body occupies (what App KV measures against its document limit).
 *
 * A document is kept as plaintext JSON until it would breach the limit; only
 * then is it gzipped. Small documents stay human-readable and depend on no
 * compression primitive, and a large one — a good build whose resumable
 * checkpoint holds wide preview events — is stored compressed instead of being
 * thrown away at the 100 KiB wall (a wide JSON source compresses ~5-8x).
 */
async function encodeStorageBody(
  value: unknown,
): Promise<{ body: string; storedBytes: number; compressed: boolean }> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Background batch value is not JSON serializable.');
  const rawBytes = new TextEncoder().encode(json).length;
  if (rawBytes <= BACKGROUND_ROW_ARTIFACT_MAX_BYTES) {
    return { body: json, storedBytes: rawBytes, compressed: false };
  }
  const marker = await gzipToMarker(json);
  if (marker === null) return { body: json, storedBytes: rawBytes, compressed: false };
  const markerBytes = new TextEncoder().encode(marker).length;
  // A pre-compressed or tiny-entropy payload could in principle inflate; keep
  // whichever body is smaller so compression can never make a document larger.
  return markerBytes < rawBytes
    ? { body: marker, storedBytes: markerBytes, compressed: true }
    : { body: json, storedBytes: rawBytes, compressed: false };
}

const decodeStorageBody = async (raw: string): Promise<string> =>
  raw.startsWith(GZIP_PREFIX) ? gunzipFromMarker(raw) : raw;

function parseJson<T>(raw: string, key: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new BackgroundBatchCorruptDocumentError(
      `Background batch App KV document "${key}" is not valid JSON.`,
    );
  }
}

export function createBackgroundBatchStore(
  fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init),
  apiBase = defaultApiBase(),
): BackgroundBatchStore {
  // Constructors preserve the key hierarchy and encode only dynamic segments,
  // so browser and Backend Function transports send the same readable path.
  const url = (key: string): string => `${apiBase}/kvstore/${key}`;

  const get = async <T>(key: string): Promise<T | null> => {
    let response: Response;
    try {
      response = await fetchImpl(url(key));
    } catch (error) {
      throw new BackgroundBatchTransientReadError(
        `Background batch App KV read temporarily failed for "${key}": `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new BackgroundBatchTransientReadError(
          `Background batch App KV read temporarily failed for "${key}" (${response.status}).`,
        );
      }
      throw new Error(`Background batch App KV read failed for "${key}" (${response.status}).`);
    }
    return parseJson<T>(await decodeStorageBody(await response.text()), key);
  };

  const putBody = async (key: string, body: string): Promise<void> => {
    const response = await fetchImpl(url(key), {
      method: 'PUT',
      // Load-bearing: application/json can store the literal "[object Object]"
      // despite a successful response from App KV.
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    if (!response.ok) {
      throw new Error(`Background batch App KV write failed for "${key}" (${response.status}).`);
    }
  };

  const put = async (key: string, value: unknown): Promise<void> => {
    const body = JSON.stringify(value);
    if (body === undefined) {
      throw new Error(`Background batch App KV value for "${key}" is not JSON serializable.`);
    }
    // The run manifest lands here (createRun/saveRun). Every row is bounded
    // metadata, but the ROW ARRAY is not: a large enough batch pushes the doc
    // past the App KV limit and Start would otherwise die on the platform's
    // bare 413. The manifest is polled and rewritten on every stage, so it is
    // kept PLAINTEXT and its size is a hard signal — a batch that overflows it
    // must be split, not silently compressed into a hot-path doc that is
    // gunzipped on every poll. (Only saveArtifact, written once per stage,
    // compresses — see below.) Fail fast with the field-named diagnostic.
    const bytes = serializedUtf8Bytes(value, body);
    if (bytes > BACKGROUND_ROW_ARTIFACT_MAX_BYTES) {
      const worst = largestField(value);
      throw new Error(
        `Background batch run checkpoint "${key}" is ${bytes} UTF-8 bytes, over the `
        + `${BACKGROUND_ROW_ARTIFACT_MAX_BYTES}-byte App KV document limit — `
        + `${worst ? `${worst.path} alone is ${worst.bytes} bytes` : 'it holds no named field to shrink'}. `
        + 'Split the batch into fewer sourcetypes and start it again.',
      );
    }
    await putBody(key, body);
  };

  const remove = async (key: string): Promise<void> => {
    const response = await fetchImpl(url(key), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Background batch App KV delete failed for "${key}" (${response.status}).`);
    }
  };

  const loadActiveRunId = async (): Promise<string | null> => {
    const value = await get<unknown>(activeRunKey);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const assertActive = async (runId: string): Promise<void> => {
    const active = await loadActiveRunId();
    if (active !== runId) {
      throw new Error(
        `Stale background batch run "${runId}" is fenced; active run is "${active ?? 'none'}".`,
      );
    }
  };

  const listKeys = async (prefix: string): Promise<string[]> => {
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}/kvstore/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix }),
      });
    } catch (error) {
      throw new BackgroundBatchTransientReadError(
        `Background batch App KV key listing temporarily failed for "${prefix}": `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new BackgroundBatchTransientReadError(
          `Background batch App KV key listing temporarily failed for "${prefix}" (${response.status}).`,
        );
      }
      throw new Error(`Background batch App KV key listing failed for "${prefix}" (${response.status}).`);
    }
    const data: any = await response.json();
    const items = Array.isArray(data) ? data : (data?.items || data?.keys || []);
    return items
      .map((item: unknown) => typeof item === 'string' ? item : (item as any)?.key)
      .filter((key: unknown): key is string => typeof key === 'string' && key.startsWith(prefix));
  };

  return {
    loadActiveRunId,

    async createRun(cp) {
      const active = await loadActiveRunId();
      if (active) {
        throw new Error(
          `Background batch run "${active}" is still active; dismiss it before starting another run.`,
        );
      }
      const manifestKey = runManifestKey(cp.runId);
      await put(manifestKey, cp);
      try {
        await put(activeRunKey, cp.runId);
      } catch (error) {
        await remove(manifestKey).catch(() => {});
        throw error;
      }
      // App KV has no compare-and-swap operation. This read-back detects and
      // rolls back a claim overwritten before verification. It cannot prevent
      // a later writer replacing the pointer after this check; all subsequent
      // writes are independently fenced against the current pointer.
      const claimed = await loadActiveRunId();
      if (claimed !== cp.runId) {
        await remove(manifestKey).catch(() => {});
        throw new Error(
          `Background batch run "${cp.runId}" lost the active-run claim to "${claimed ?? 'none'}".`,
        );
      }
    },

    loadRun(runId) {
      return get<BackgroundBatchCheckpoint>(runManifestKey(runId));
    },

    async saveRun(cp) {
      await assertActive(cp.runId);
      await put(runManifestKey(cp.runId), fitRunManifest(cp));
    },

    loadArtifact<T>(key: string) {
      return get<T>(key);
    },

    async saveArtifact<T>(key: string, value: T) {
      // Gzip before the limit check so a good build whose resumable checkpoint
      // holds wide preview events is stored compressed rather than discarded at
      // the 100 KiB wall. Only a row that is over-limit even compressed still
      // throws — and then the diagnostic names the field on the RAW value, which
      // is what the operator can act on.
      const { body, storedBytes, compressed } = await encodeStorageBody(value);
      if (storedBytes > BACKGROUND_ROW_ARTIFACT_MAX_BYTES) {
        const worst = largestField(value);
        throw new Error(
          `Background row artifact "${key}" is ${storedBytes} UTF-8 bytes${compressed ? ' (gzip-compressed)' : ''}, over the `
          + `${BACKGROUND_ROW_ARTIFACT_MAX_BYTES}-byte App KV document limit — `
          + `${worst ? `${worst.path} alone is ${worst.bytes} bytes` : 'it holds no named field to shrink'}. `
          + 'Reduce the sample, preview events, functions, or healed lookup contents and retry this row.',
        );
      }
      const prefix = 'batch-run/background/artifacts/';
      const relative = key.startsWith(prefix) ? key.slice(prefix.length) : '';
      const separator = relative.indexOf('/');
      if (separator <= 0) {
        throw new Error(`Background row artifact key "${key}" is not run-scoped.`);
      }
      const runId = relative.slice(0, separator);
      await assertActive(runId);
      await putBody(key, body);
      try {
        await assertActive(runId);
      } catch (error) {
        // A dismissal/new-run race may complete while the PUT is in flight.
        // Remove what this stale writer just created before reporting failure.
        await remove(key).catch(() => {});
        throw error;
      }
    },

    async deleteRun(runId) {
      await assertActive(runId);
      // The manifest is read for the artifact keys it lists — and a manifest
      // that cannot be parsed is exactly the run most in need of deleting, so
      // corruption alone is stepped over (the prefix listing below still finds
      // the artifacts). Any OTHER failure says nothing about the document and
      // stops the delete where it stands: refusing a read is not permission to
      // destroy what could not be read.
      let cp: BackgroundBatchCheckpoint | null = null;
      try {
        cp = await get<BackgroundBatchCheckpoint>(runManifestKey(runId));
      } catch (error) {
        if (!isBackgroundBatchCorruptDocumentError(error)) throw error;
      }
      const prefix = runArtifactPrefix(runId);
      // Prefix enumeration removes orphans, but an unavailable listing API
      // must not strand a run that still has a usable manifest.
      const discovered = await listKeys(prefix).catch(() => []);
      const artifactKeys = new Set([
        ...discovered,
        ...(cp?.rows || []).map(row => row.artifactKey).filter(Boolean),
      ]);
      for (const key of artifactKeys) await remove(key);
      await assertActive(runId);
      await remove(runManifestKey(runId));
      // Pointer last: a partial failure remains visible and retryable.
      await assertActive(runId);
      await remove(activeRunKey);
    },
  };
}

export const backgroundBatchStore = createBackgroundBatchStore();
