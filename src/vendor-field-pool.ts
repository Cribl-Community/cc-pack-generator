/**
 * The shared vendor-field pool: REVIEWED field lists, published next to the shared goldens.
 *
 * Same distribution as the goldens: one public file in the golden repository and branch
 * (`vendor-fields/library.json`), read with no credential through the paths the app's proxy already
 * allows; Home offers what is new or newer, and an import keeps it per install (App KV
 * `vendor-fields/pool`, see vendor-field-library.ts). Two differences, on purpose:
 *  - only reviewed entries are offered or imported: `closed`, with reviewedBy and reviewedAt. An open
 *    entry is a generated guess, and performance mode removes fallbacks on a closed list;
 *  - field names seen on this install's builds are never part of it. They come from customer logs.
 * Publishing is a maintainer step (`npm run library:pool`), never the app.
 */
import { ghReadPublicJson } from './github-rest';
import {
  BUNDLED_LIBRARY, findEntry, loadImportedEntries, mergeLibrary, parseReviewedEntries, saveImportedEntries,
  type VendorFieldEntry, type VendorFieldLibrary,
} from './vendor-field-library';

export const VENDOR_POOL_PATH = 'vendor-fields/library.json';
export const DEFAULT_POOL_REPO = 'wvdlinde-cribl/cribl-pack-goldens';
export const DEFAULT_POOL_BRANCH = 'shared-goldens';

export interface VendorFieldOffer {
  key: string;
  /** new: no entry here; reviewed: the entry here is still open; update: reviewed more recently than ours. */
  status: 'new' | 'reviewed' | 'update';
  entry: VendorFieldEntry;
  localReviewedAt?: string;
}

/** Pure: which pool entries this install should be offered, given its current library. */
export function classifyPoolOffers(local: VendorFieldLibrary, pool: Record<string, VendorFieldEntry>): VendorFieldOffer[] {
  const out: VendorFieldOffer[] = [];
  for (const [key, entry] of Object.entries(pool)) {
    const hit = findEntry(local, key);
    if (!hit) { out.push({ key, status: 'new', entry }); continue; }
    if (hit.entry.status !== 'closed') { out.push({ key, status: 'reviewed', entry }); continue; }
    const mine = Date.parse(hit.entry.reviewedAt || ''), theirs = Date.parse(entry.reviewedAt || '');
    if (Number.isFinite(theirs) && (!Number.isFinite(mine) || theirs > mine)) {
      out.push({ key, status: 'update', entry, localReviewedAt: hit.entry.reviewedAt });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** One line for the Home notice, or null when there is nothing to offer. */
export function vendorPoolNotice(offers: readonly VendorFieldOffer[]): string | null {
  if (!offers.length) return null;
  const n = (s: VendorFieldOffer['status']) => offers.filter(o => o.status === s).length;
  const parts = [
    n('new') && `${n('new')} new`,
    n('reviewed') && `${n('reviewed')} now reviewed`,
    n('update') && `${n('update')} updated`,
  ].filter(Boolean);
  return `${parts.join(', ')} reviewed vendor field ${offers.length === 1 ? 'list' : 'lists'} in the shared pool.`;
}

/** Read the pool and decide what to offer. Unreachable or absent → nothing offered, with the reason. */
export async function fetchVendorFieldOffers(repo = DEFAULT_POOL_REPO, branch = DEFAULT_POOL_BRANCH): Promise<{ offers: VendorFieldOffer[]; error?: string }> {
  try {
    const r = await ghReadPublicJson(repo || DEFAULT_POOL_REPO, branch || DEFAULT_POOL_BRANCH, VENDOR_POOL_PATH);
    if (!r.found) return { offers: [] };
    const local = mergeLibrary(BUNDLED_LIBRARY, await loadImportedEntries());
    return { offers: classifyPoolOffers(local, parseReviewedEntries(r.data)) };
  } catch (e) {
    return { offers: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Keep the offered entries on this install. Returns how many were imported. */
export async function importVendorFieldOffers(offers: readonly VendorFieldOffer[]): Promise<number> {
  if (!offers.length) return 0;
  const current = await loadImportedEntries();
  const next = { ...current };
  for (const o of offers) next[o.key] = o.entry;
  await saveImportedEntries(next);
  return offers.length;
}

/** Pure: the pool document for the reviewed entries of a library (what `npm run library:pool` writes). */
export function poolDocument(lib: VendorFieldLibrary, now = new Date().toISOString()): { version: number; publishedAt: string; entries: Record<string, VendorFieldEntry> } {
  const entries = parseReviewedEntries({ entries: lib.entries });
  return { version: lib.version, publishedAt: now, entries };
}
