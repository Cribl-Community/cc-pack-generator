import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupCategoryFor, selectReferenceLookups } from '../src/reference-lookup-select.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_LOOKUPS_PATH = join(__dirname, '..', 'config', 'golden-lookups');

// The category rule is SHARED (src/reference-lookup-select.ts) with the iframe's
// bundled store and a Backend Function's embedded one. Re-exported here because
// ai-advisor.mjs has always got it from this path.
export { lookupCategoryFor };

// Return the list of golden lookups that apply to a sourcetype, with their file
// content, so the deploy path can upload them into the pack's data/lookups/.
// Also includes the always-relevant generic protocol table for network sources.
//
// Each entry: { file, content, description, fields, rows }
export function getLookupsForSourcetype(sourcetype) {
  try {
    const index = JSON.parse(readFileSync(join(GOLDEN_LOOKUPS_PATH, 'index.json'), 'utf-8'));
    return selectReferenceLookups(sourcetype, index, file => readFileSync(join(GOLDEN_LOOKUPS_PATH, file), 'utf-8'));
  } catch {
    return []; // golden lookups optional
  }
}
