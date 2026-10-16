/**
 * The shared samples pool — real vendor log lines, held OUTSIDE this repository.
 *
 * Why the corpus is not in `config/` any more: it was ~600 files each named after
 * a vendor (`palo_alto_traffic.json`, `cisco_asa.json`, …) sitting in the app's own
 * source tree. That is a data set, not source code, and it does not belong in the
 * app repo. It now lives in a standalone pool repository, exactly like the shared
 * goldens (Hard Rule 16) and for the same reasons:
 *
 *   * READ NEEDS NO CREDENTIAL, in either run mode. Every install may read the
 *     pool, and requiring a token would mean configuring one per install. Reads go
 *     to raw.githubusercontent.com unauthenticated through `ghReadPublicFile`,
 *     which is CORS-open, ETag-conditional and — the point — spends NONE of the
 *     5,000/hour GitHub API budget (Hard Rule 19).
 *   * The pool holds NOTHING BUT SAMPLES, so "everyone may read the samples" is
 *     expressible without handing out read of anything else.
 *
 * THE INDEX STAYS LOCAL, and that is deliberate. `config/samples-pool-index.json`
 * is a single manifest (no vendor-named files) that ships with the app, so:
 *
 *   * `storeBackedAvailability` can badge ~600 sourcetypes as "real sample
 *     available" at startup with ZERO network calls — the wizard's availability map
 *     is built from the index, and making it a network read would mean the catalog
 *     silently lost 600 badges whenever GitHub was slow or unreachable;
 *   * the index gate still distinguishes "not in the pool" from "not fetched yet",
 *     so a miss costs no request at all — the same property the old bundled glob
 *     had, kept;
 *   * the licence attribution (which corpus, which commit, which terms) travels
 *     with the app rather than only with the data.
 *
 * Only the per-sample BODIES are fetched, one at a time, at the moment a build
 * actually needs one. NEVER prefetch the pool: fanning out over the whole index is
 * the exact mistake Hard Rule 19 documents.
 *
 * Every failure degrades to "no pool sample" — resolution simply falls through to
 * the next tier (Hard Rule 18: the other mode, and the offline case, must still
 * work). A missing pool can never fail a build.
 *
 * No Node imports: both run modes use this module directly.
 */

import { ghReadPublicJson } from './github-rest';
import { safeGetItem, safeRemoveItem, safeSetItem } from './safe-storage';
import { aiSampleKeyToFile, type VendorSampleDoc } from './sample-library';

/** Env override is the ONE thing that changes when the pool repo is transferred. */
function envVar(name: string): string {
  try {
    return String((import.meta.env as Record<string, string> | undefined)?.[name] || '');
  } catch {
    return '';
  }
}

export const SAMPLES_POOL_REPO = envVar('VITE_SAMPLES_POOL_REPO') || 'wvdlinde-cribl/cribl-pack-samples';
export const SAMPLES_POOL_BRANCH = envVar('VITE_SAMPLES_POOL_BRANCH') || 'main';
/** Folder inside the pool repo. Mirrors `shared-goldens/` in the goldens pool. */
export const SAMPLES_POOL_FOLDER = 'samples';

/** Local manifest path, for the two callers that read it off disk. */
export const SAMPLES_POOL_INDEX_PATH = 'config/samples-pool-index.json';

export interface SamplesPoolIndexRow {
  key: string;
  file: string;
  sourcetype: string;
  events: number;
  confidence?: 'verified' | 'structure' | 'provenance';
  method?: string;
  upstream?: string;
  fixtures?: number;
  corpus?: string;
}

export interface SamplesPoolCorpus {
  id: string;
  repo: string;
  commit: string;
  license: string;
}

export interface SamplesPoolIndex {
  version: number;
  corpora?: SamplesPoolCorpus[];
  samples?: SamplesPoolIndexRow[];
}

/**
 * In-process memo. `null` is cached too: a key that is genuinely absent from the
 * pool must not be re-requested on every candidate the builder tries.
 */
const memo = new Map<string, VendorSampleDoc | null>();

const CACHE_PREFIX = 'samples-pool:';
/**
 * Biggest body worth mirroring into localStorage. The store caps a doc at
 * VENDOR_SAMPLE_MAX_BYTES (24 KB) of events, so this only rejects something
 * pathological — a quota-exceeded write is swallowed by safeSetItem anyway.
 */
const CACHE_MAX_BYTES = 64_000;

function readCache(key: string): VendorSampleDoc | null {
  const raw = safeGetItem(`${CACHE_PREFIX}${key}`);
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as VendorSampleDoc;
    return doc?.events?.length ? doc : null;
  } catch {
    return null;
  }
}

/** Keys this process has mirrored, so a reset can actually undo it. */
const mirrored = new Set<string>();

function writeCache(key: string, doc: VendorSampleDoc): void {
  try {
    const text = JSON.stringify(doc);
    if (text.length <= CACHE_MAX_BYTES) {
      safeSetItem(`${CACHE_PREFIX}${key}`, text);
      mirrored.add(key);
    }
  } catch { /* a cache that cannot be written is still a working read */ }
}

/**
 * Injectable transport. Standalone overrides this with a disk-cached reader
 * (scripts/samples-pool-cache.mjs) so a dev server does not re-fetch the same
 * sample after a restart, and so the suite can run a pool read hermetically.
 * The default is the credential-free public GitHub lane.
 */
export type PoolFetcher = (file: string) => Promise<VendorSampleDoc | null>;

async function publicFetch(file: string): Promise<VendorSampleDoc | null> {
  const r = await ghReadPublicJson<VendorSampleDoc>(
    SAMPLES_POOL_REPO,
    SAMPLES_POOL_BRANCH,
    `${SAMPLES_POOL_FOLDER}/${file}`,
  );
  return r.found && r.data?.events?.length ? r.data : null;
}

let fetcher: PoolFetcher = publicFetch;

/** Replace the transport. Pass nothing to restore the public GitHub lane. */
export function setSamplesPoolFetcher(fn?: PoolFetcher | null): void {
  fetcher = fn || publicFetch;
}

/**
 * Drop every memoized body — the in-process memo AND this process's writes to the
 * persistent mirror. Tests only; the app has no reason to forget.
 *
 * Clearing both is the point: the mirror outlives the memo by design, so a reset that
 * only cleared the memo would leave the next read answered from storage. A test
 * injecting a transport would then be measuring the cache rather than its fetcher.
 */
export function resetSamplesPoolCache(): void {
  memo.clear();
  for (const key of mirrored) safeRemoveItem(`${CACHE_PREFIX}${key}`);
  mirrored.clear();
}

/**
 * One sample body from the pool, or null.
 *
 * The caller is responsible for the index gate (`key` must be a row in the local
 * manifest) — that is what keeps a miss free, and it is where both run modes
 * already do their key resolution via `sampleStoreKeys`.
 */
export async function fetchPoolSample(key: string): Promise<VendorSampleDoc | null> {
  if (!key) return null;
  if (memo.has(key)) return memo.get(key) ?? null;

  const cached = readCache(key);
  if (cached) {
    memo.set(key, cached);
    return cached;
  }

  let doc: VendorSampleDoc | null = null;
  try {
    doc = await fetcher(aiSampleKeyToFile(key));
  } catch {
    // Unreachable pool, rate limit, malformed JSON — all the same answer to the
    // caller: no sample from this tier. Deliberately NOT memoized as a definitive
    // null, so a transient outage does not poison the rest of the session.
    return null;
  }
  memo.set(key, doc);
  if (doc) writeCache(key, doc);
  return doc;
}

/**
 * Resolve a pool sample for a sourcetype, honouring the index gate and the shared
 * key order. `keys` comes from `sampleStoreKeys(sourcetype, format)`; `has` is the
 * local manifest's key set. Both are passed in so this module needs neither the
 * manifest nor the recognition tables (each run mode already has them loaded).
 */
export async function resolvePoolSample(
  keys: readonly string[],
  has: (key: string) => boolean,
): Promise<VendorSampleDoc | null> {
  for (const key of keys) {
    if (!has(key)) continue;
    const doc = await fetchPoolSample(key);
    if (doc?.events?.length) return doc;
  }
  return null;
}

/** The response shape both run modes' sample resolvers return. */
export interface PoolSampleResponse {
  available: true;
  events: string[];
  sourcetype: string;
  pack: 'vendor-samples';
  fields: string[];
  sampleName: string;
  synthetic: false;
  // Kept as the doc's own union, not widened to `string`: the resolvers' ResolvedSample
  // carries the same three tiers and the UI renders them by name.
  confidence: VendorSampleDoc['confidence'] | null;
  verification: VendorSampleDoc['verification'] | null;
  upstream: VendorSampleDoc['upstream'] | null;
}

/**
 * Adapt a pool doc to the resolver response. `pack` stays `vendor-samples`: it is
 * a PROVENANCE label the UI and the scoring path read ("real harvested vendor
 * log"), not a path, and renaming it would silently change trust attribution
 * everywhere it is displayed.
 */
export function toPoolSampleResponse(doc: VendorSampleDoc | null): PoolSampleResponse | null {
  if (!doc?.events?.length) return null;
  return {
    available: true,
    events: doc.events,
    sourcetype: doc.sourcetype,
    pack: 'vendor-samples',
    fields: doc.verification?.fields || [],
    sampleName: `${doc.sourcetype}_vendor_sample`,
    // Real logs, so NOT synthetic. `upstream` travels with the events because the
    // corpus licence requires the notice to stay attached.
    synthetic: false,
    confidence: doc.confidence || null,
    verification: doc.verification || null,
    upstream: doc.upstream || null,
  };
}
