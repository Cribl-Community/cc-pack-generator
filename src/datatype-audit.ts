/**
 * Datatype coverage audit — ONE engine for both run modes.
 *
 * Compares the live Cribl Search datatype catalog against the parser store this
 * app builds pipelines from, and (on apply) returns the store it should become.
 * Pure: it never touches the network, the filesystem or the KV store, so the
 * standalone handler can write config/datatype-parsers.json with the result and
 * the iframe can persist the same result as a KV overlay.
 *
 * It exists because the two modes used to audit with SEPARATE implementations of
 * this logic, and they drifted: the iframe copy never learned about JSON
 * datatypes or the portable-JSON seeds, so it reported different new/changed and
 * — worse — called every seeded v2 parser "stale" against the same Search group.
 */
import {
  isUsableDatatype,
  translateDatatype,
  seedPortableJsonParsers,
  PORTABLE_JSON_DATATYPE_IDS,
  type SearchDatatype,
  type TranslatedDatatype,
} from './datatype-translate';

export interface DatatypeAuditReport {
  group: string;
  liveUsable: number;
  imported: number;
  pickerCount: number;
  newInSearch: string[];
  changed: string[];
  notInPicker: string[];
  stale: string[];
  appliedIds: string[];
  updatedIds: string[];
  removedIds: string[];
  seededIds: string[];
  /** Where an applied import was persisted, for the UI to state plainly. */
  storedIn?: 'config' | 'app-kv' | 'browser';
  error?: string;
}

export interface DatatypeAuditInput {
  live: SearchDatatype[];
  /** The parser store as the app currently resolves it (bundled + any overlay). */
  parsers: Record<string, TranslatedDatatype>;
  aliases?: Record<string, string>;
  /** Sourcetype values offered by the wizard picker, for the coverage report. */
  pickerValues?: Iterable<string>;
  group?: string;
  apply?: boolean;
}

export interface DatatypeAuditResult {
  report: DatatypeAuditReport;
  /** The store after apply. A copy — the input is never mutated. */
  parsers: Record<string, TranslatedDatatype>;
  changed: boolean;
}

// Compare only the parse-relevant shape so cosmetic metadata drift doesn't count
// as a change. The stored `description` is derived from the live one, so it counts.
function parseSignature(p: Partial<TranslatedDatatype> | undefined): string {
  return JSON.stringify({
    dataFormat: p?.dataFormat,
    functions: p?.functions,
    fields: p?.fields,
    timeField: p?.timeField,
    description: p?.description,
  });
}

export function auditDatatypeStore(input: DatatypeAuditInput): DatatypeAuditResult {
  const {
    live = [], parsers = {}, aliases = {},
    pickerValues = [], group = 'default_search', apply = false,
  } = input;

  const usable = (live || []).filter(isUsableDatatype);
  const liveIds = new Set(usable.map(d => d.id));
  const store: Record<string, TranslatedDatatype> = { ...parsers };
  const importedIds = new Set(Object.keys(store));
  const picker = new Set(pickerValues);

  const newInSearch = usable.filter(d => !importedIds.has(d.id)).map(d => d.id);
  // Portable JSON v2 seeds stay even when this org's Search catalog lists only
  // the v1 datatypes — their absence upstream is not evidence they are stale.
  const portableIds = new Set<string>(PORTABLE_JSON_DATATYPE_IDS);
  const stale = [...importedIds].filter(id => !liveIds.has(id) && !portableIds.has(id));
  const changedIds = usable.filter(d => {
    if (!importedIds.has(d.id)) return false;
    return parseSignature(translateDatatype(d, aliases)) !== parseSignature(store[d.id]);
  }).map(d => d.id);
  const notInPicker = [...importedIds].filter(id => {
    const norm = id.replace(/_syslog$|_log$|_csv$/, '');
    return ![...picker].some(v => v === id || id.includes(v) || v.includes(norm));
  });

  const appliedIds: string[] = [];
  const updatedIds: string[] = [];
  const removedIds: string[] = [];
  let seededIds: string[] = [];

  if (apply) {
    const changedSet = new Set(changedIds);
    for (const dt of usable) {
      if (!importedIds.has(dt.id)) { store[dt.id] = translateDatatype(dt, aliases); appliedIds.push(dt.id); }
      else if (changedSet.has(dt.id)) { store[dt.id] = translateDatatype(dt, aliases); updatedIds.push(dt.id); }
    }
    for (const id of stale) { delete store[id]; removedIds.push(id); }
    seededIds = seedPortableJsonParsers(store);
  }

  return {
    report: {
      group,
      liveUsable: usable.length,
      imported: importedIds.size + appliedIds.length - removedIds.length,
      pickerCount: picker.size,
      newInSearch,
      changed: changedIds,
      notInPicker,
      stale,
      appliedIds,
      updatedIds,
      removedIds,
      seededIds,
    },
    parsers: store,
    changed: appliedIds.length > 0 || updatedIds.length > 0 || removedIds.length > 0 || seededIds.length > 0,
  };
}
