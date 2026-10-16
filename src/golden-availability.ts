// The startup "which shared goldens are worth importing?" decision, as a pure
// function so it can be unit-tested and shared. bundled-data.ts (the iframe path)
// cannot be imported under `node --test` because it uses `import.meta.glob`, so
// the decision lives here where a test can reach it directly.
//
// The one rule that matters: the baseline is NOT just localStorage. On a fresh
// iframe the idle `seedGoldenDefaults` pass races the availability check, so the
// caller must fold the BUNDLED corpus score into `baselineScoreOf`. Without it
// every key reads as null → 'new' → the whole pool queues for a per-file download
// it already ships, and raw.githubusercontent throttles the burst (the 429 storm).

import { poolEntryImportStatus, type PoolIndexEntry, type StoredGolden } from './golden-trust';
import { nonSourceMappingKeyReason } from './golden-source-identity';

export interface GoldenIndexEntry extends Partial<PoolIndexEntry> {
  key: string;
  score?: number;
  author?: string;
  updated_at?: string;
  path?: string;
}

export type GoldenPart = 'extraction' | 'optimization' | 'mapping' | null;

export interface AvailableGoldenEntry {
  key: string;
  sourcetype: string;
  dest_format: string;
  score: number;
  localScore: number | null;
  author: string;
  updated_at: string;
  status: 'new' | 'upgrade';
  path: string;
  part: GoldenPart;
}

export function goldenPartOf(key: string): GoldenPart {
  return key.endsWith('::__extraction__') ? 'extraction'
    : key.endsWith('::__optimization__') ? 'optimization'
      : key.endsWith('::__mapping__') ? 'mapping' : null;
}

/**
 * Classify each shared-pool index entry against the best score already available
 * locally for its key. `baselineScoreOf` returns that score (localStorage first,
 * then the bundled corpus) or null when the key is genuinely absent.
 *
 *   - baseline null            → 'new'
 *   - shared score  > baseline → 'upgrade'
 *   - shared score <= baseline → skipped (already have it as good or better)
 */
export function classifyAvailableGoldens(
  indexGoldens: GoldenIndexEntry[],
  baselineScoreOf: (key: string) => number | null,
): AvailableGoldenEntry[] {
  const out: AvailableGoldenEntry[] = [];
  for (const meta of indexGoldens) {
    const key = meta?.key;
    if (!key) continue;
    const i = key.indexOf('::');
    const sourcetype = i < 0 ? key : key.slice(0, i);
    const dest_format = i < 0 ? '' : key.slice(i + 2);
    const localScore = baselineScoreOf(key);
    const status: 'new' | 'upgrade' | null =
      localScore == null ? 'new' : ((meta.score || 0) > (localScore || 0) ? 'upgrade' : null);
    if (!status) continue;
    out.push({
      key, sourcetype, dest_format,
      score: meta.score ?? 0, localScore,
      author: meta.author || '', updated_at: meta.updated_at || '',
      status, path: meta.path || '', part: goldenPartOf(key),
    });
  }
  return out;
}

/**
 * The home-screen line for goldens waiting in the shared pool, or null when in
 * sync. Before this the count only showed on Settings → Goldens, so a user could
 * build for weeks on an older golden without knowing a better one was shared.
 */
export function goldenUpdateNotice(available: readonly { status: 'new' | 'upgrade' }[]): string | null {
  if (available.length === 0) return null;
  const fresh = available.filter(g => g.status === 'new').length;
  const up = available.length - fresh;
  const parts = [
    fresh ? `${fresh} new golden${fresh === 1 ? '' : 's'}` : '',
    up ? `${up} upgrade${up === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `${parts.join(' and ')} ${available.length === 1 ? 'is' : 'are'} available in the shared pool.`;
}

/**
 * What the Home button does. Leaving a run in progress asks first — in the app,
 * not with window.confirm, which the sandboxed App Platform iframe can ignore
 * (it then returns false, so Home silently did nothing).
 */
export type LeaveDecision = 'go' | 'ask' | 'blocked';
export function leaveDecision(step: string, opts: { locked: boolean; safeSteps: readonly string[] }): LeaveDecision {
  if (opts.locked) return 'blocked';
  return step === 'mode' || opts.safeSteps.includes(step) ? 'go' : 'ask';
}

/**
 * What an import actually did, for the line under the Import button. Before
 * this the result was dropped: a failed import refreshed to the same list and
 * read as "the button does nothing".
 */
export function goldenImportSummary(
  r: { imported: readonly unknown[]; failed: readonly { key: string; reason: string }[] },
): { tone: 'ok' | 'warn' | 'error'; text: string } {
  const n = r.imported.length;
  const bad = r.failed.length;
  const done = `Imported ${n} golden${n === 1 ? '' : 's'}`;
  if (bad === 0) return { tone: 'ok', text: `${done}.` };
  const reasons = [...new Set(r.failed.map(f => f.reason))].slice(0, 2).join('; ');
  const first = r.failed.slice(0, 3).map(f => f.key).join(', ');
  const fail = `${bad} failed (${reasons}): ${first}${bad > 3 ? ` and ${bad - 3} more` : ''}`;
  return n === 0 ? { tone: 'error', text: `Nothing imported — ${fail}.` } : { tone: 'warn', text: `${done}; ${fail}.` };
}

/**
 * The trust-aware classifier (docs/specs/golden-trust.md R2/R4) — what both run
 * modes now offer. `localOf` returns what this install holds for a key: the full
 * record when it is at hand (browser storage, the bundled corpus), else a
 * score-only stand-in (an App KV index hit), which ranks as legacy — so only an
 * entry with real standing is ever offered over it. The import re-decides on the
 * full doc (`planGoldenImport`).
 */
export function classifyAvailableGoldensByTrust(
  indexGoldens: GoldenIndexEntry[],
  localOf: (key: string) => StoredGolden | null,
): AvailableGoldenEntry[] {
  const out: AvailableGoldenEntry[] = [];
  for (const meta of indexGoldens) {
    const key = meta?.key;
    if (!key) continue;
    // A mapping keyed by a format label (json::…) is refused at import, so
    // offering it only produces a guaranteed "Nothing imported" failure.
    if (nonSourceMappingKeyReason(key)) continue;
    const local = localOf(key);
    const status = poolEntryImportStatus(meta as PoolIndexEntry, local);
    if (!status) continue;
    const i = key.indexOf('::');
    out.push({
      key, sourcetype: i < 0 ? key : key.slice(0, i), dest_format: i < 0 ? '' : key.slice(i + 2),
      score: meta.score ?? 0, localScore: local?.score ?? null,
      author: meta.author || '', updated_at: meta.updated_at || '',
      status, path: meta.path || '', part: goldenPartOf(key),
    });
  }
  return out;
}
