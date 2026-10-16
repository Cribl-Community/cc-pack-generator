#!/usr/bin/env node
/**
 * Audit Cribl Search stock datatypes vs. what the app has imported/exposes.
 *
 *   node scripts/check-datatypes.mjs            # report only
 *   node scripts/check-datatypes.mjs --apply    # also import NEW parsers into
 *                                               # config/datatype-parsers.json
 *   node scripts/check-datatypes.mjs [group]    # override search group
 *
 * Reports:
 *   - NEW in Search, not yet imported (candidates to add)
 *   - Imported but NOT in the wizard picker (src/ai-samples.ts SOURCETYPES)
 *   - STALE (in our config but gone from Search)
 *
 * With --apply: re-extracts usable datatypes (regexp/kvp/delimited/json) and
 * merges NEW ones into datatype-parsers.json. Portable JSON v2 IDs are seeded
 * even when Search still exposes only the v1 list, and are never treated as stale.
 * Adding to the wizard picker is left to you (printed as a suggestion).
 */
import { getToken, CRIBL_ORG } from './cribl-auth.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDatatypeStore } from '../src/datatype-audit.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const PARSERS_PATH = join(CONFIG_DIR, 'datatype-parsers.json');
const ALIASES_PATH = join(CONFIG_DIR, 'datatype-field-aliases.json');
const SOURCETYPES_PATH = join(__dirname, '..', 'src', 'ai-samples.ts');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SEARCH_GROUP = args.find(a => !a.startsWith('--')) || 'default_search';
const BASE = CRIBL_ORG.replace(/\/$/, '') + '/api/v1';

// Core audit — returns the report, and (if apply) imports NEW parsers.
// Reusable by both the CLI and the HTTP handlers (scripts/reference-api.mjs).
// The comparison itself lives in src/datatype-audit.ts so the iframe runs the
// SAME engine over its own store; this function only supplies the org's live
// catalog and owns the filesystem side of it.
export async function auditDatatypes(group = 'default_search', { apply = false } = {}) {
  const token = await getToken();
  const resp = await fetch(`${BASE}/m/${group}/search/datatypes`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`datatypes fetch failed: ${resp.status}`);
  const items = (await resp.json()).items || [];

  const store = JSON.parse(readFileSync(PARSERS_PATH, 'utf-8'));
  const aliases = JSON.parse(readFileSync(ALIASES_PATH, 'utf-8')).aliases || {};
  const picker = readFileSync(SOURCETYPES_PATH, 'utf-8');
  const pickerValues = [...picker.matchAll(/value:\s*'([^']+)'/g)].map(m => m[1]);

  const { report, parsers, changed } = auditDatatypeStore({
    live: items, parsers: store.parsers || {}, aliases, pickerValues, group, apply,
  });

  if (apply && changed) {
    store.parsers = parsers;
    store.count = Object.keys(parsers).length;
    writeFileSync(PARSERS_PATH, JSON.stringify(store, null, 2));
  }
  return { ...report, storedIn: 'config' };
}

// --- CLI ---
async function main() {
  const r = await auditDatatypes(SEARCH_GROUP, { apply: APPLY });
  console.log(`\n=== Cribl Search datatype audit (${r.group}) ===`);
  console.log(`Live usable: ${r.liveUsable} | Imported: ${r.imported} | Wizard picker: ${r.pickerCount}\n`);
  console.log(`NEW in Search, not imported (${r.newInSearch.length}):`);
  r.newInSearch.forEach(id => console.log(`  + ${id}`));
  console.log(`\nCHANGED upstream (parser differs from stored) (${r.changed.length}):`);
  r.changed.forEach(id => console.log(`  ~ ${id}`));
  console.log(`\nImported but NOT in wizard picker (${r.notInPicker.length}) — fallback parsers, not selectable tiles:`);
  r.notInPicker.slice(0, 40).forEach(id => console.log(`  · ${id}`));
  if (r.notInPicker.length > 40) console.log(`  … +${r.notInPicker.length - 40} more`);
  console.log(`\nSTALE (in config, gone from Search) (${r.stale.length}):`);
  r.stale.forEach(id => console.log(`  - ${id}`));
  if (APPLY) console.log(`\n✓ Imported ${r.appliedIds.length} new, updated ${r.updatedIds.length} changed, removed ${r.removedIds.length} stale, seeded ${r.seededIds.length} portable JSON parser(s).`);
  else console.log(`\nRun with --apply to import ${r.newInSearch.length} new, update ${r.changed.length} changed, remove ${r.stale.length} stale, and seed missing portable JSON parsers.`);
}

// Run as CLI only when invoked directly (not when imported by the server).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
