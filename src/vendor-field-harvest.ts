/**
 * Field names for the vendor field library, taken from a parser and from a parsed
 * sample. Names only. A person still decides when a list is complete (`status: 'closed'`).
 */
import { pathCovered, type VendorFieldEntry, type VendorFieldLibrary } from './vendor-field-library';

/** Same shape the library accepts when it records a seen name. */
export const FIELD_NAME_RE = /^[\w.@$-]{1,200}$/;

/** Identifiers an eval expression uses that are not field names. */
const READ_SKIP = new Set([
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
  'String', 'Number', 'Math', 'Date', 'JSON', 'Object', 'Array', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'test', 'match', 'split', 'replace', 'pop', 'push', 'join', 'slice', 'indexOf',
  'charAt', 'length', 'map', 'filter', 'reduce', 'concat', 'keys', 'values', 'entries',
  'assign', 'from', 'now', 'parse', 'UTC', 'getTime', 'getFullYear', 'toString',
  'valueOf', 'trim', 'toLowerCase', 'toUpperCase', 'includes', 'startsWith', 'endsWith',
  'typeof', 'instanceof', 'new', 'return', 'function', 'var', 'let', 'const', 'if', 'else',
  'this', '__e',
]);

export const GENERATED_FIELD_NOTE = 'Generated from the parser and the bundled sample (npm run library:fields). Open: a chain that reads one of these fields drops the other names. Close only after checking the vendor documentation.';

/** Top-level names present on one parsed event. An object is listed once; its children are not. */
export function namesFromEvent(event: Record<string, unknown> | null | undefined): string[] {
  if (!event || typeof event !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out.push(key);
  }
  return out;
}

type ParserFn = { id?: string; conf?: { add?: { name?: string; value?: string }[] } };

type RichFn = ParserFn & { id?: string; conf?: { add?: { name?: string; value?: string }[]; regex?: string; regexList?: { regex?: string }[]; fields?: (string | { name?: string })[] } };

/** Names a parser captures or reads. Eval destinations are aliases the parser writes, so they do not confirm a source field. */
export function sourceFieldNamesFromParser(fns: RichFn[] | null | undefined): string[] {
  const out: string[] = [];
  for (const fn of fns || []) {
    const conf = fn?.conf;
    if (fn?.id === 'regex_extract') {
      const regexes = [conf?.regex, ...(Array.isArray(conf?.regexList) ? conf.regexList.map(item => item?.regex ?? item) : [])];
      for (const regex of regexes) {
        if (!regex) continue;
        for (const match of String(regex).matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)) out.push(match[1]);
      }
    } else if (fn?.id === 'serde' && Array.isArray(conf?.fields)) {
      for (const column of conf.fields) out.push(typeof column === 'string' ? column : column?.name || '');
    }
  }
  out.push(...namesReadByParser(fns));
  return out;
}

/** Names an eval writes. A parsed event carries these because the parser copied them, not because the source did. */
export function namesWrittenByParser(fns: RichFn[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const fn of fns || []) {
    if (fn?.id !== 'eval') continue;
    for (const add of fn.conf?.add || []) if (add?.name) out.add(add.name);
  }
  return out;
}

/** Field names an eval reads. The names it writes are collected separately. */
export function namesReadByParser(fns: ParserFn[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const fn of fns || []) {
    if (fn?.id !== 'eval') continue;
    for (const add of fn.conf?.add || []) {
      const cleaned = String(add?.value || '')
        .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
        .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
        .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
        .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, ' ')
        .replace(/\.[A-Za-z_$][\w$]*/g, ' ');
      for (const id of cleaned.match(/[A-Za-z_$][\w$]*/g) || []) {
        if (!READ_SKIP.has(id)) out.add(id);
      }
    }
  }
  return [...out];
}

/** Union of name lists, without Cribl's common fields, sorted. */
export function unionFieldNames(groups: Iterable<string>[], common: readonly string[]): string[] {
  const out = new Set<string>();
  for (const group of groups) {
    for (const name of group) {
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (!FIELD_NAME_RE.test(trimmed) || READ_SKIP.has(trimmed) || pathCovered(common, trimmed)) continue;
      out.add(trimmed);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export interface HarvestUpdate {
  key: string;
  fields: string[];
  aliases?: string[];
}

/**
 * Fold harvested names into the library. Hand-written docs, vendor, product and a
 * closed status stay. Fields are a union, so a name a sample did not show is kept.
 * An update with no fields does not create an entry.
 */
export function mergeLibraryEntries(lib: VendorFieldLibrary, updates: HarvestUpdate[]): VendorFieldLibrary {
  const entries: Record<string, VendorFieldEntry> = { ...lib.entries };
  for (const update of updates) {
    const prev = entries[update.key];
    // A generated list is replaced on each run. A hand-written list is only added to.
    const hand = prev?.notes ? !prev.notes.startsWith('Generated from the parser') : !!prev;
    const fields = unionFieldNames([hand ? (prev?.fields || []) : [], update.fields], lib.commonFields);
    if (fields.length === 0) {
      if (prev && !hand) delete entries[update.key];
      continue;
    }
    const aliases = [...new Set([...(prev?.aliases || []), ...(update.aliases || [])])]
      .map(alias => alias.trim())
      .filter(alias => alias && alias !== update.key)
      .sort((a, b) => a.localeCompare(b));
    const seededNote = prev?.notes && /Not seeded/.test(prev.notes);
    const notes = prev?.notes && !seededNote ? prev.notes : (prev ? GENERATED_FIELD_NOTE : GENERATED_FIELD_NOTE);
    const next: VendorFieldEntry = {
      vendor: prev?.vendor ?? '',
      product: prev?.product ?? '',
      ...(prev && 'version' in prev ? { version: prev.version } : {}),
      status: prev?.status === 'closed' ? 'closed' : 'open',
      ...(prev?.reviewedBy ? { reviewedBy: prev.reviewedBy } : {}),
      ...(prev?.reviewedAt ? { reviewedAt: prev.reviewedAt } : {}),
      docs: prev?.docs ? [...prev.docs] : [],
      ...(aliases.length ? { aliases } : {}),
      fields,
      ...((prev?.notes || !prev) ? { notes } : {}),
    };
    entries[update.key] = next;
  }
  const sorted: Record<string, VendorFieldEntry> = {};
  for (const key of Object.keys(entries).sort((a, b) => a.localeCompare(b))) sorted[key] = entries[key];
  return { ...lib, entries: sorted };
}
