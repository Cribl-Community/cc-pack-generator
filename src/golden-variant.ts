/**
 * Golden variants — the wire-format dimension of the golden store.
 *
 * A golden used to be keyed on the sourcetype alone (`<st>::<fmt>`, plus the
 * `::__extraction__` / `::<fmt>::__mapping__` stage parts). One source can ship
 * several wire formats — FortiGate as key=value or CEF, Zscaler NSS as
 * key=value, JSON or CEF, Windows as XML or classic text — and a golden learned
 * from one format extracts nothing from another. So the sourcetype segment of a
 * key now carries the format whenever it is not the source's own:
 *
 *   fortinet_fortigate::cim          key=value (native) — the existing corpus
 *   fortinet_fortigate@cef::cim      CEF (a second format FortiGate ships)
 *   acme_app@json::__extraction__    a custom source: always qualified
 *
 * Rules, in order:
 *   - No known wire format (empty or mixed sample) → the plain key, exactly the
 *     behaviour before variants existed. Unknown is never guessed.
 *   - A declared source (it has a GOLDEN_SOURCE_EXPECTATIONS entry) keeps its
 *     NATIVE formats on the plain key, because that is what every existing
 *     golden for it was built from. Any other format is looked up on its variant
 *     ONLY — a FortiGate CEF build must never replay the key=value golden.
 *   - An undeclared (custom) source has no native format to assume, so a save is
 *     always filed under its variant, and a lookup tries the variant first, then
 *     the plain legacy key, gated by `goldenRecordServesFormat` so a legacy golden
 *     only serves a format it does not visibly contradict.
 *
 * The suffix is only recognised when it names a wire format (`@cef`, `@json`, …),
 * so an `@` elsewhere in a custom sourcetype is left alone, and the pool's
 * `<key>.json` filenames stay plain (`fortinet_fortigate@cef__cim.json`).
 *
 * Pure and AI-free: imported by the client store (api.ts, bundled-goldens.ts)
 * and by the standalone file store (scripts/schema-validator.mjs), so all three
 * run modes resolve the same key for the same sample.
 */
import { nativeSourceWireFormats } from './source-recognition';
import { isSourceWireFormat, sampleWireFormat, type SourceWireFormat } from './sample-format';

export const GOLDEN_VARIANT_SEPARATOR = '@';

/** `fortinet_fortigate@cef` → { base: 'fortinet_fortigate', wire: 'cef' }. */
export function splitGoldenVariant(sourcetype: string): { base: string; wire: SourceWireFormat | null } {
  const s = String(sourcetype || '');
  const i = s.lastIndexOf(GOLDEN_VARIANT_SEPARATOR);
  if (i > 0) {
    const wire = s.slice(i + 1);
    if (isSourceWireFormat(wire)) return { base: s.slice(0, i), wire };
  }
  return { base: s, wire: null };
}

/** The sourcetype a (possibly variant) golden key belongs to. */
export function goldenBaseSourcetype(sourcetype: string): string {
  return splitGoldenVariant(sourcetype).base;
}

/** True/false for a declared source, null when the sourcetype declares no formats. */
function isNativeWire(base: string, wire: SourceWireFormat): boolean | null {
  const native = nativeSourceWireFormats(base);
  return native ? native.includes(wire) : null;
}

function asWire(wire: unknown): SourceWireFormat | null {
  return isSourceWireFormat(wire) ? wire : null;
}

/**
 * The key segment a golden built from `wire` data is SAVED under. Idempotent: a
 * variant sourcetype is split first, and its own suffix is used when no `wire`
 * is given.
 */
export function goldenVariantSourcetype(sourcetype: string, wire?: SourceWireFormat | string | null): string {
  const parsed = splitGoldenVariant(sourcetype);
  const w = asWire(wire) ?? parsed.wire;
  if (!w) return parsed.base;
  return isNativeWire(parsed.base, w) === true ? parsed.base : `${parsed.base}${GOLDEN_VARIANT_SEPARATOR}${w}`;
}

/**
 * The key segments to LOOK UP, most specific first. Only the plain legacy key of
 * an undeclared source needs the `goldenRecordServesFormat` gate; every other
 * entry is exact by construction.
 */
export function goldenLookupSourcetypes(sourcetype: string, wire?: SourceWireFormat | string | null): string[] {
  const parsed = splitGoldenVariant(sourcetype);
  if (parsed.wire) return [goldenVariantSourcetype(sourcetype)];
  const w = asWire(wire);
  if (!w) return [parsed.base];
  const native = isNativeWire(parsed.base, w);
  if (native === true) return [parsed.base];
  const variant = `${parsed.base}${GOLDEN_VARIANT_SEPARATOR}${w}`;
  return native === false ? [variant] : [variant, parsed.base];
}

interface GoldenRecordLike {
  wireFormat?: unknown;
  recipe?: { fingerprint?: { format?: unknown } | null } | null;
}

/**
 * May `record` (stored under a key for `sourcetype`) serve a sample in `wire`?
 *
 * A record that states its `wireFormat` serves exactly the formats that share its
 * key. A legacy record states nothing, so it serves any format — what it did
 * before variants — UNLESS its stored sample fingerprint contradicts the request.
 * Only the fingerprint's `cef` and `json` classes are trusted for that: they need
 * 60% of lines to carry a real CEF header / parse as JSON objects, while its
 * `kvp`/`unstructured` split is known to misfile (Check Point's pipe-separated
 * pairs fingerprint as `unstructured`).
 */
export function goldenRecordServesFormat(
  record: GoldenRecordLike | null | undefined,
  sourcetype: string,
  wire?: SourceWireFormat | string | null,
): boolean {
  if (!record) return false;
  const want = asWire(wire);
  if (!want) return true;
  const base = goldenBaseSourcetype(sourcetype);
  const have = asWire(record.wireFormat);
  if (have) return goldenVariantSourcetype(base, have) === goldenVariantSourcetype(base, want);
  const fpFormat = record.recipe?.fingerprint?.format;
  if (fpFormat === 'cef' || fpFormat === 'json') return fpFormat === want;
  return true;
}

/**
 * Resolve a golden through the variant rule. `read(segment)` returns the record
 * stored under `<segment>::<rest of key>`, or null. `wireFormat` undefined or
 * null is the exact-key legacy lookup.
 */
export function resolveGoldenVariant<T extends GoldenRecordLike>(
  sourcetype: string,
  wireFormat: SourceWireFormat | string | null | undefined,
  read: (segment: string) => T | null | undefined,
): T | null {
  for (const segment of goldenLookupSourcetypes(sourcetype, wireFormat)) {
    const rec = read(segment);
    if (rec && goldenRecordServesFormat(rec, segment, wireFormat)) return rec;
  }
  return null;
}

/** `resolveGoldenVariant` over an async reader (network-backed stores). */
export async function resolveGoldenVariantAsync<T extends GoldenRecordLike>(
  sourcetype: string,
  wireFormat: SourceWireFormat | string | null | undefined,
  read: (segment: string) => Promise<T | null | undefined>,
): Promise<T | null> {
  for (const segment of goldenLookupSourcetypes(sourcetype, wireFormat)) {
    const rec = await read(segment);
    if (rec && goldenRecordServesFormat(rec, segment, wireFormat)) return rec;
  }
  return null;
}

/** The wire format a build's sample is filed under (null = unknown / mixed). */
export function goldenWireFormatForSample(sampleEvents: unknown[] | string | null | undefined): SourceWireFormat | null {
  try { return sampleWireFormat(sampleEvents); } catch { return null; }
}
