/**
 * Vendor-sample access for the standalone backend.
 *
 * The corpus holds REAL vendor log lines copied out of third-party corpora's own
 * test fixtures, each doc recording the upstream repo/commit/path/licence it came
 * from. Two corpora contribute — elastic/integrations for the shape a vendor API
 * returns, and splunk/splunk-connect-for-syslog for syslog wire format — with each
 * manifest row tagged by owner.
 *
 * The BODIES are not in this repository. They used to be ~600 files each named after
 * a vendor in `config/vendor-samples/`; they now live in a standalone pool
 * repository, read credential-free (src/samples-pool.ts explains why, and why the
 * MANIFEST deliberately stays local). This module is the standalone half of that
 * read: the manifest off disk for the gate, the body through the pool client — whose
 * transport here is disk-cached, so a warm dev server never re-fetches and works
 * offline (scripts/samples-pool-cache.mjs).
 *
 * Why this is a separate tier from config/ai-samples/:
 *   - it is real data, so it outranks anything a model produced;
 *   - it is redistributed under someone else's licence, so its provenance and NOTICE
 *     must stay attached (see config/samples-pool-NOTICE);
 *   - a bad sample is removed on its own, and resolution falls through to the next
 *     tier with nothing else disturbed.
 *
 * The iframe reads the same pool through the same client (Hard Rule 18); the key
 * convention and the quality gate live in src/sample-library.ts so there is one
 * implementation, not a mirror. Nothing here writes: the harvest CLIs write the
 * local mirror through scripts/vendor-store-writer.mjs, and
 * scripts/publish-samples-pool.mjs publishes it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sampleStoreKeys } from '../src/sample-library.ts';
import { resolvePoolSample, toPoolSampleResponse } from '../src/samples-pool.ts';
import { installSamplesPoolDiskCache } from './samples-pool-cache.mjs';

const INDEX_PATH = join(process.cwd(), 'config', 'samples-pool-index.json');

// The backend always reads the pool through the disk cache.
installSamplesPoolDiskCache();

let _index = null;
let _keys = null;
let _rows = null;

export function readVendorIndex() {
  if (_index) return _index;
  let idx = { version: 1, corpora: [], samples: [] };
  if (existsSync(INDEX_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
      if (Array.isArray(parsed.samples)) idx = parsed;
    } catch { /* an unreadable manifest means no pool tier, not a crash */ }
  }
  _index = idx;
  return idx;
}

/**
 * The manifest's key set. This is the GATE: a key that is not a row costs no
 * request at all, which is what keeps a miss free (Hard Rule 19 — never fan out
 * over the pool, and never pay for a lookup that cannot hit).
 */
function poolKeys() {
  if (!_keys) _keys = new Set((readVendorIndex().samples || []).map(s => s.key).filter(Boolean));
  return _keys;
}

/** Test seam: forget the parsed manifest. */
export function resetVendorIndexCache() {
  _index = null;
  _keys = null;
  _rows = null;
}

/**
 * The manifest ROW for a sourcetype, without fetching the body.
 *
 * For the questions the index can already answer — is there a harvested sample, how
 * many events, which corpus — reading the body would buy nothing and cost a request
 * per source. The sample-review screen asks exactly that about ~100 sources at once,
 * so it must stay a local read (Hard Rule 19: never fan out over the pool).
 */
export function vendorIndexRow(sourcetype, format) {
  const rows = readVendorIndex().samples || [];
  if (!_rows) _rows = new Map(rows.map(r => [r.key, r]));
  for (const key of sampleStoreKeys(sourcetype, format)) {
    const row = _rows.get(key);
    if (row) return row;
  }
  return null;
}

/**
 * Resolve a harvested sample for a sourcetype. Format-specific key first
 * (`zscaler_web::cef`), then the bare sourcetype, then the same two under a store
 * alias — the order is `sampleStoreKeys`, shared with the iframe mode.
 */
export async function getVendorLibrarySample(sourcetype, format) {
  const keys = poolKeys();
  return resolvePoolSample(sampleStoreKeys(sourcetype, format), k => keys.has(k));
}

/** The shape handleReferenceSample returns, so this slots into the tier chain. */
export const toReferenceResponse = toPoolSampleResponse;
