/**
 * Which golden lookup CSVs a sourcetype needs — ONE definition, three stores.
 *
 * The lookup corpus (`config/golden-lookups/`) is read from a different place in
 * every run mode: Vite's `import.meta.glob` in the iframe (bundled-data.ts), the
 * filesystem in standalone (scripts/lookup-bundler.mjs), and a build-time define
 * in a Backend Function (backend-reference-lookups.ts). Only the STORE differs —
 * the selection must not, or a pack built in the background ships a different
 * `data/lookups/` than the same pack built in the wizard, and the lookup-driven
 * ASA/FTD parser silently resolves nothing. (Same reasoning as Hard Rule 20's
 * one-audit-engine: two hand-mirrored copies had already drifted, on the network
 * predicate and on whether `fields` came back at all.)
 *
 * Pure and import-free on purpose: this is reachable from a Backend Function,
 * where every import is bundle weight against a 5 MB cap.
 */

/** One entry as `config/golden-lookups/index.json` spells it. */
export interface ReferenceLookupEntry {
  file: string;
  description?: string;
  fields?: string[];
  usage?: string;
  source_pack?: string;
  /** Upstream origin for a list that is not extracted from a Cribl pack. */
  source?: string;
  /** License of that origin. Required alongside `source` — Hard Rule 30's discipline. */
  license?: string;
}

export interface ReferenceLookupIndex {
  lookups?: Record<string, Record<string, ReferenceLookupEntry>>;
}

/** One resolved lookup, ready to upload into a pack's `data/lookups/`. */
export interface SelectedReferenceLookup {
  file: string;
  content: string;
  description: string;
  fields: string[];
  rows: number;
}

/**
 * The lookup category a sourcetype parses against, or null for the sources that
 * have no code table. FTD is structurally an ASA but keys on its own column, so
 * the two never share a file.
 */
export function lookupCategoryFor(sourcetype: string | null | undefined): string | null {
  const st = (sourcetype || '').toLowerCase();
  if (st.includes('cisco_asa') || st.includes('asa')) return 'cisco_asa';
  if (st.includes('cisco_ftd') || st.includes('ftd') || st.includes('firepower')) return 'cisco_ftd';
  if (st.includes('fortinet') || st.includes('fortigate')) return 'fortinet_fortigate';
  return null;
}

/** Network sources also get the IANA protocol table, whatever their category. */
export function isNetworkLookupSource(sourcetype: string | null | undefined): boolean {
  return /asa|ftd|firepower|fortigate|fortinet|palo|checkpoint|firewall|vpc|flow|traffic|meraki|sonicwall/
    .test((sourcetype || '').toLowerCase());
}

/** Data rows in a CSV — the header line does not count. */
export function countLookupRows(content: string): number {
  return content.split('\n').filter(line => line.trim()).length - 1;
}

/** Every file the index names, deduplicated, in index order. */
export function indexedLookupFiles(index: ReferenceLookupIndex | null | undefined): string[] {
  const files: string[] = [];
  for (const category of Object.values(index?.lookups ?? {})) {
    for (const entry of Object.values(category ?? {})) {
      if (entry?.file && !files.includes(entry.file)) files.push(entry.file);
    }
  }
  return files;
}

/**
 * Resolve the lookups a sourcetype needs against whatever store `readContent`
 * reads. A file the store cannot produce is skipped, not faked — an empty CSV
 * would deploy a lookup that resolves every code to nothing.
 */
export function selectReferenceLookups(
  sourcetype: string | null | undefined,
  index: ReferenceLookupIndex | null | undefined,
  readContent: (file: string) => string | null | undefined,
): SelectedReferenceLookup[] {
  const lookups = index?.lookups ?? {};
  const result: SelectedReferenceLookup[] = [];

  const add = (entry: ReferenceLookupEntry | null | undefined): void => {
    if (!entry?.file) return;
    if (result.some(r => r.file === entry.file)) return;
    let content: string | null | undefined;
    try {
      content = readContent(entry.file);
    } catch {
      content = null;
    }
    if (typeof content !== 'string' || content.length === 0) return;
    result.push({
      file: entry.file,
      content,
      description: entry.description || '',
      fields: entry.fields || [],
      rows: countLookupRows(content),
    });
  };

  const category = lookupCategoryFor(sourcetype);
  if (category && lookups[category]) {
    for (const entry of Object.values(lookups[category])) add(entry);
  }
  if (isNetworkLookupSource(sourcetype)) add(lookups.generic?.ip_protocols);
  return result;
}
