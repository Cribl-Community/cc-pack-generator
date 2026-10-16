import { loadBundledGoldenPipelines } from './golden-bundle-loader';
import { resolveGoldenVariantAsync } from './golden-variant';
import {
  safeGetItem, safeSetItem, safeSetItemDurable, safeRemoveItem, hasLocalStorage,
  memoryStoreKeys, memoryStoreDelete, evictLocalStorage, localStorageUsage,
} from './safe-storage';
import { goldenKvEnabled, loadGoldenKvIndex, readGoldenKv, writeGoldenKv } from './golden-kv';
import { pickLocalOverBundled, storedTrustState, type StoredGolden } from './golden-trust';
import { nonSourceMappingGoldenReason } from './golden-source-identity';

const GOLDEN_LS_SEEDED_KEY = 'golden::_seeded_build';
// Bump when the bundled golden set is PRUNED (keys removed), not just added.
const GOLDEN_PRUNE_BUILD = 296;
// Build 864: seeding stopped copying the bundle into localStorage. The bundle is
// ~8 MB against a ~5 MB quota, so the copy filled storage and every later write —
// a golden import, a build's new golden — silently landed in the memory fallback
// and vanished on reload (the import notice that came back after every refresh).
// Installs seeded before this build get one compaction pass that frees the space.
// Build 865: the pass also drops copies at the bundle's score whose body changed
// since they were seeded (an older bundle) — 864 kept those, and they were most
// of the space.
const GOLDEN_COMPACT_BUILD = 865;

function goldenSignature(pipelines: Record<string, any>): string {
  let hash = 5381;
  let count = 0;
  for (const key in pipelines) {
    count++;
    const stamp = `${key}:${pipelines[key]?.score ?? 0}`;
    for (let i = 0; i < stamp.length; i++) hash = ((hash * 33) ^ stamp.charCodeAt(i)) >>> 0;
  }
  return `${count}.${hash.toString(36)}`;
}

/** Stored golden keys, localStorage first, then the memory fallback. */
function storedGoldenKeys(): string[] {
  const keys: string[] = [];
  if (hasLocalStorage()) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('golden::') && k !== GOLDEN_LS_SEEDED_KEY) keys.push(k);
      }
    } catch { /* sandboxed */ }
  }
  for (const k of memoryStoreKeys()) {
    if (k.startsWith('golden::') && k !== GOLDEN_LS_SEEDED_KEY && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * Keep the golden store to what the bundle does NOT already serve. Every reader
 * falls back to the bundle (getBundledGoldenPipeline, the availability baseline),
 * so a stored copy of a bundled golden is dead weight; only a golden that beats
 * the bundle — an import or a local build — or one the bundle lacks is kept.
 */
export async function seedGoldenDefaults(currentBuild: number): Promise<void> {
  const data = await loadBundledGoldenPipelines();
  const pipelines = data.pipelines || {};
  const stamp = safeGetItem(GOLDEN_LS_SEEDED_KEY) || '';
  const [seededBuildRaw, seededSignature] = stamp.split(':');
  const seeded = Number(seededBuildRaw) || 0;
  const signature = goldenSignature(pipelines);
  const needsPrune = seeded < GOLDEN_PRUNE_BUILD;
  const needsCompact = seeded < GOLDEN_COMPACT_BUILD;
  if (!needsPrune && !needsCompact && seededSignature === signature) {
    if (seeded !== currentBuild) safeSetItem(GOLDEN_LS_SEEDED_KEY, `${currentBuild}:${signature}`);
    return;
  }
  dropRedundantGoldens(pipelines, needsPrune);
  safeSetItem(GOLDEN_LS_SEEDED_KEY, `${currentBuild}:${signature}`);
}

/**
 * Remove stored goldens the bundle serves at least as well: unparsable, or not
 * above the bundled score. `dropUnbundled` also removes keys the bundle lacks
 * (the build-296 prune); otherwise those are local work and stay.
 */
function dropRedundantGoldens(pipelines: Record<string, any>, dropUnbundled: boolean): void {
  for (const k of storedGoldenKeys()) {
    const key = k.slice(8);
    const bundled = pipelines[key];
    if (!bundled) {
      if (dropUnbundled) { safeRemoveItem(k); memoryStoreDelete(k); }
      continue;
    }
    let local: any = null;
    try { local = JSON.parse(safeGetItem(k) || 'null'); } catch { /* corrupt → drop, the bundle serves */ }
    // Redundant = the bundle would be picked over it anyway (golden-trust's
    // ranking, not the bare score: a measured 85 outranks a legacy 100, and a
    // copy of the bundled golden that carries this install's observations or a
    // quarantine is NOT redundant — dropping it would erase that evidence).
    if (!local || pickLocalOverBundled(local, bundled) !== local) {
      safeRemoveItem(k);
      memoryStoreDelete(k);
    }
  }
}

/** Caches that refill themselves on the next read — first to go when storage is full. */
const REBUILDABLE_PREFIXES = ['samples-pool:'];

/**
 * A golden write that must survive a reload (`key` is the full `golden::…` key).
 * localStorage first; when it is full, free what can be rebuilt — the sample
 * cache, stored copies the bundle already serves — and try once more. When there
 * is no localStorage at all (the sandboxed App Platform frame) or it stays full,
 * the golden goes to App KV (golden-kv.ts), with a memory copy for this session.
 */
export async function saveGoldenDurably(key: string, value: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (safeSetItemDurable(key, value)) return { ok: true };
  memoryStoreDelete(key);
  const hasLs = hasLocalStorage();
  if (hasLs) {
    evictLocalStorage(k => REBUILDABLE_PREFIXES.some(p => k.startsWith(p)));
    dropRedundantGoldens((await loadBundledGoldenPipelines()).pipelines || {}, false);
    if (safeSetItemDurable(key, value)) return { ok: true };
    memoryStoreDelete(key);
  }
  const kv = await writeGoldenKv(key.slice('golden::'.length), value);
  if (kv.ok) {
    safeSetItem(key, value);
    return { ok: true };
  }
  if (!hasLs) return { ok: false, reason: `Could not save to App KV: ${kv.reason}` };
  return { ok: false, reason: goldenKvEnabled() ? `${storageFullReason(value.length)}; App KV: ${kv.reason}` : storageFullReason(value.length) };
}

function storageFullReason(needed: number): string {
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  const { total, byPrefix } = localStorageUsage();
  const top = byPrefix.slice(0, 3).map(([p, n]) => `${p} ${mb(n)}`).join(', ');
  return `Browser storage is full (${mb(total)} used${top ? `: ${top}` : ''}; needs ${Math.max(1, Math.round(needed / 1e3))} KB more)`;
}

export async function countLocalGoldens(): Promise<number> {
  const data = await loadBundledGoldenPipelines();
  const bundledKeys = new Set(Object.keys(data.pipelines || {}));
  if (hasLocalStorage()) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('golden::') && k !== GOLDEN_LS_SEEDED_KEY) bundledKeys.add(k.slice(8));
      }
    } catch { /* sandboxed */ }
  }
  for (const k of memoryStoreKeys()) {
    if (k.startsWith('golden::') && k !== GOLDEN_LS_SEEDED_KEY) bundledKeys.add(k.slice(8));
  }
  for (const k of Object.keys(await loadGoldenKvIndex())) bundledKeys.add(k);
  return bundledKeys.size;
}

// `wireFormat` undefined = the exact key as given; otherwise resolved through the
// variant rule (golden-variant.ts), each key trying safe storage before the bundle.
/**
 * The record this install holds under an EXACT key (no `golden::` prefix),
 * quarantined or not — what a write compares against. A local copy (browser
 * storage, then App KV) is picked over the bundle by the trust ranking; a later
 * app version can still ship a better one.
 */
export async function readStoredGolden(key: string): Promise<StoredGolden | null> {
  let local: StoredGolden | null = null;
  const raw = safeGetItem(`golden::${key}`);
  if (raw) {
    try { local = JSON.parse(raw); } catch { /* fall through */ }
  }
  if (!local) local = (await readGoldenKv(key)) as StoredGolden | null;
  const bundled = ((await loadBundledGoldenPipelines()).pipelines?.[key] || null) as StoredGolden | null;
  return pickLocalOverBundled(local, bundled);
}

export async function getBundledGoldenPipeline(sourcetype: string, destFormat: string, wireFormat?: string | null): Promise<any | null> {
  // Checked before storage so a stale local copy of `json::…::__mapping__`
  // cannot be replayed after the bundle dropped it.
  if (nonSourceMappingGoldenReason(sourcetype, destFormat)) return null;
  const read = async (segment: string): Promise<any | null> => {
    const key = `${segment}::${destFormat}`;
    const rec = await readStoredGolden(key);
    // A quarantined record is a tombstone (golden-trust R5): kept, never served.
    // `storeKey` = where it was read from, so a reuse verdict goes back to it.
    return rec && storedTrustState(rec) !== 'quarantined' ? { ...rec, storeKey: key } : null;
  };
  if (wireFormat === undefined) return read(sourcetype);
  return resolveGoldenVariantAsync(sourcetype, wireFormat, read);
}

export { loadBundledGoldenPipelines };
