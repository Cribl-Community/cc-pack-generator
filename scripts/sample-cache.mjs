// Short-TTL cache for pack sample lookups (ID resolution + content).
//
// WHY THIS EXISTS: the 3-stage builder previews N candidates for the same pack.
// Each candidate PATCHes only the pipeline conf, but the validator used to
// re-LIST the pack's samples (to turn a sample NAME into its pack-scoped random
// ID) and re-DOWNLOAD the sample CONTENT on every single candidate. The sample
// cannot change while one build's candidate loop runs, so that was two wasted
// Cribl round-trips per candidate, on the critical path.
//
// WHY ITS OWN MODULE: three different backend handlers write pack samples —
// schema-validator (AI-generated fallback sample), live-capture
// (handleUploadPackSample / handleDeletePackSample) and deploy-api (payload
// sampleData upload). All of them must be able to invalidate, and they run in
// the SAME Vite backend process, so a cache that lives inside schema-validator
// would go stale behind the other two. Importing schema-validator from them to
// reach the invalidator would drag in pack-builder.ts and risk an import cycle;
// this module deliberately has ZERO imports so anyone can depend on it.
//
// TTL'd rather than permanent: a user can replace a sample between builds and
// the quality-check skill runs long. 60s comfortably covers one build's
// candidate loop while staying far below "stale between user actions".
export const SAMPLE_CACHE_TTL_MS = 60_000;

const _sampleIdCache = new Map();
const _sampleContentCache = new Map();

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SAMPLE_CACHE_TTL_MS) { map.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
  return value;
}

const idKey = (workerGroup, packId, sampleName) => `${workerGroup}::${packId}::${sampleName || ''}`;
const contentKey = (workerGroup, packId, sampleId) => `${workerGroup}::${packId}::${sampleId}`;

export function getCachedSampleId(workerGroup, packId, sampleName) {
  return cacheGet(_sampleIdCache, idKey(workerGroup, packId, sampleName));
}

// Only a TRUTHY id is cached — a null resolution must stay retryable, since the
// very next step may AI-generate and upload the missing sample. Returns `id` so
// callers can `return rememberSampleId(...)` inline.
export function rememberSampleId(workerGroup, packId, sampleName, id) {
  if (!id) return id;
  return cacheSet(_sampleIdCache, idKey(workerGroup, packId, sampleName), id);
}

export function getCachedSampleContent(workerGroup, packId, sampleId) {
  return cacheGet(_sampleContentCache, contentKey(workerGroup, packId, sampleId));
}

export function rememberSampleContent(workerGroup, packId, sampleId, value) {
  return cacheSet(_sampleContentCache, contentKey(workerGroup, packId, sampleId), value);
}

// Drop every cached entry for one pack. Call after ANY write to that pack's
// samples (upload, replace, delete) so the next read sees the new state
// immediately instead of waiting out the TTL. Cheap: the maps hold a handful of
// keys per run, and other packs are untouched.
export function invalidateSampleCache(workerGroup, packId) {
  const prefix = `${workerGroup}::${packId}::`;
  for (const m of [_sampleIdCache, _sampleContentCache]) {
    for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
  }
}

// Test/diagnostic hook — not used by app code.
export function _cacheSizes() {
  return { ids: _sampleIdCache.size, content: _sampleContentCache.size };
}
