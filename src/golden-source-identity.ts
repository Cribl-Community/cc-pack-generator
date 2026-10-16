/**
 * A mapping golden translates one source's fields into a destination schema.
 * The names below are wire formats, not sources, so a mapping filed under one
 * of them is replayed onto every sample of that shape. That is how a ZPA
 * App Connector mapping stored as `json::cim#network::__mapping__` was served
 * to a neighbouring JSON source.
 *
 * CEF and LEEF stay allowed: their headers and dictionaries are the source
 * contract. A real source that merely arrived as JSON (`fortinet_fortigate@json`)
 * stays allowed — only the base segment is judged. Extraction goldens are not
 * covered; a json serde is reusable across vendors.
 *
 * The `@` split mirrors `splitGoldenVariant` (`src/golden-variant.ts`) for the
 * wire suffixes in `SOURCE_WIRE_FORMATS`. This module imports neither, so the
 * golden store can use it without pulling the parser graph along.
 */

const WIRE_SUFFIXES = new Set(['cef', 'leef', 'json', 'xml', 'kvp', 'csv', 'tsv', 'psv', 'text']);

/** Format labels that must never be the sourcetype of a mapping golden. */
export const NON_SOURCE_GOLDEN_LABELS = ['json', 'xml', 'csv', 'tsv', 'psv', 'kvp', 'text', 'syslog'] as const;

/** `fortinet_fortigate@json` → `fortinet_fortigate`. A non-wire `@` is left alone. */
export function goldenLabelBase(sourcetype: string): string {
  const s = String(sourcetype || '');
  const i = s.lastIndexOf('@');
  if (i > 0 && WIRE_SUFFIXES.has(s.slice(i + 1))) return s.slice(0, i);
  return s;
}

export function isNonSourceGoldenLabel(sourcetype: string): boolean {
  return (NON_SOURCE_GOLDEN_LABELS as readonly string[]).includes(goldenLabelBase(sourcetype).toLowerCase());
}

export function isMappingGoldenDest(destFormat: string): boolean {
  return String(destFormat || '').includes('__mapping__');
}

/**
 * Why this (sourcetype, destFormat) pair must not be stored or replayed, or
 * null when it is a real source, an extraction golden, or CEF/LEEF.
 */
export function nonSourceMappingGoldenReason(sourcetype: string, destFormat: string): string | null {
  if (!isMappingGoldenDest(destFormat) || !isNonSourceGoldenLabel(sourcetype)) return null;
  const base = goldenLabelBase(sourcetype).toLowerCase();
  return `a mapping golden needs the vendor sourcetype it was built for; "${base}" is a format label, so this mapping is not stored or replayed`;
}

/** Store key `${sourcetype}::${destFormat}` — destFormat keeps every later `::`. */
export function splitGoldenStoreKey(key: string): { sourcetype: string; destFormat: string } | null {
  const i = String(key || '').indexOf('::');
  if (i <= 0) return null;
  return { sourcetype: key.slice(0, i), destFormat: key.slice(i + 2) };
}

export function nonSourceMappingKeyReason(key: string): string | null {
  const parts = splitGoldenStoreKey(key);
  if (!parts) return null;
  return nonSourceMappingGoldenReason(parts.sourcetype, parts.destFormat);
}
