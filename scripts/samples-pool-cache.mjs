/**
 * Standalone-mode transport for the samples pool: the same credential-free public
 * read, with a disk cache in front of it.
 *
 * The iframe gets a browser cache for free (localStorage, in src/samples-pool.ts).
 * The backend needs its own, for two reasons that are not about speed alone:
 *
 *   * a dev server restarts constantly, and re-fetching the same vendor sample on
 *     every restart is both slow and rude to the CDN;
 *   * once a sample has been read, the standalone mode keeps working OFFLINE —
 *     which matters because standalone is the mode that builds packs in bulk
 *     (Hard Rule 18: neither mode may become the fragile one).
 *
 * The cache is `.cache/` (gitignored), so no vendor-named file ever re-enters the
 * repository — the whole point of moving the corpus out. It is pure derived data:
 * deleting it costs one re-fetch and nothing else.
 *
 * Nothing here writes the pool. Publishing is scripts/publish-samples-pool.mjs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SAMPLES_POOL_BRANCH, SAMPLES_POOL_FOLDER, SAMPLES_POOL_REPO,
  setSamplesPoolFetcher,
} from '../src/samples-pool.ts';

const CACHE_DIR = join(process.cwd(), '.cache', 'samples-pool');

/** Reject anything that is not a plain filename — this reaches the filesystem. */
const SAFE_FILE = /^[A-Za-z0-9._#-]+\.json$/;

function readCached(file) {
  const path = join(CACHE_DIR, file);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc?.events?.length ? doc : null;
  } catch {
    return null;
  }
}

function writeCached(file, doc) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, file), `${JSON.stringify(doc, null, 1)}\n`);
  } catch { /* an unwritable cache is still a working read */ }
}

/**
 * `raw.githubusercontent.com` direct — no credential, no API quota. Deliberately
 * a plain fetch rather than the browser lane's wrapper: this runs in Node, where
 * there is no proxy hop and no localStorage, and it must not be able to attach a
 * token even by accident.
 */
async function fetchFromPool(file) {
  const url = `https://raw.githubusercontent.com/${SAMPLES_POOL_REPO}/${SAMPLES_POOL_BRANCH}/${SAMPLES_POOL_FOLDER}/${file}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'pack-generator' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`samples pool ${r.status} on ${file}`);
  const doc = JSON.parse(await r.text());
  return doc?.events?.length ? doc : null;
}

/**
 * Cache-only mode: a miss is "not in the pool" instead of a fetch.
 *
 * It is ON automatically under `node --test` (which sets NODE_TEST_CONTEXT in every
 * test child) because "no test reaches the network" must be a property of the CODE,
 * not of whoever wrote the test — several suites resolve samples through the tier
 * chain and would otherwise silently start fetching. Resolution already treats an
 * absent pool sample as "fall through to the next tier", so an offline run exercises
 * the real path; with a local harvest mirror it exercises it with real bodies.
 * `SAMPLES_POOL_OFFLINE=1` forces the same thing anywhere else.
 */
const offline = () => process.env.SAMPLES_POOL_OFFLINE === '1' || !!process.env.NODE_TEST_CONTEXT;

/** Disk cache, then network. Returns null for "not in the pool". */
export async function readPoolSampleFile(file) {
  if (!SAFE_FILE.test(file || '')) return null;
  const cached = readCached(file);
  if (cached) return cached;
  if (offline()) return null;
  const doc = await fetchFromPool(file);
  if (doc) writeCached(file, doc);
  return doc;
}

let installed = false;

/**
 * Point src/samples-pool.ts at the disk-cached transport. Idempotent — the backend
 * middleware and the CLIs all call it, and re-registering would be harmless but
 * pointless.
 */
export function installSamplesPoolDiskCache() {
  if (installed) return;
  installed = true;
  setSamplesPoolFetcher(readPoolSampleFile);
}

export { CACHE_DIR };
