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

/**
 * Splunk adds these when it indexes a log. They are not vendor fields, and
 * confirming one lets a chain drop the vendor name beside it.
 */
export const SPLUNK_META_FIELDS = new Set([
  'punct', 'linecount', 'splunk_server', 'splunk_server_group',
  'timestartpos', 'timeendpos', 'eventtype', 'tag', '_indextime',
  'date_hour', 'date_mday', 'date_minute', 'date_month', 'date_second',
  'date_wday', 'date_year', 'date_zone',
]);

/** Field names from a source-samples `fields` list, without Splunk's own columns. */
export function namesFromDeclaredFields(fields: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(fields)) return [];
  return fields.filter(name => typeof name === 'string' && name.length > 0
    && !SPLUNK_META_FIELDS.has(name) && !name.startsWith('date_') && !name.startsWith('tag::'));
}

/** Column names from a Zeek/Corelight `#fields` header. Tabs may already be parsed or still escaped. */
export function namesFromZeekHeader(line: string): string[] {
  const match = String(line || '').match(/#fields[ \t]+([^\n]+)/);
  if (!match) return [];
  return match[1].split(/\t|\\t/).map(name => name.trim()).filter(Boolean);
}

/**
 * Keys of a key=value line. A line needs several pairs, so a sentence with one
 * equals sign contributes nothing. JSON and Zeek headers are not key=value.
 */
export function namesFromKvpLine(line: string): string[] {
  const text = String(line || '');
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('#fields')) return [];
  const keys = [...text.matchAll(/(?:^|[\s|,])([A-Za-z_][\w.-]{0,64})=(?:"[^"]*"|'[^']*'|[^\s,|]+)/g)].map(match => match[1]);
  return keys.length >= 4 ? keys : [];
}

/**
 * Names carried by one event in config/sample-library. A Zeek file's names are
 * the `#fields` header. A JSON log contributes its keys. Anything else contributes
 * the keys already parsed onto the event, plus key=value pairs when the line is one.
 */
export function namesFromLibraryEvent(event: Record<string, unknown> | null | undefined): string[] {
  if (!event || typeof event !== 'object') return [];
  const raw = typeof event._raw === 'string' ? event._raw : '';
  const zeek = namesFromZeekHeader(raw);
  if (zeek.length) return zeek;
  const names = namesFromEvent(event);
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) names.push(...namesFromEvent(parsed));
    } catch { /* a truncated line still contributes the keys parsed onto the event */ }
  } else if (namesFromKvpLine(raw).length >= 4) {
    names.push(...namesFromKvpLine(raw));
  }
  const envelope = new Set(['_raw', '_time', 'host', 'source', 'sourcetype', 'index', 'cribl_breaker', 'cribl_pipe']);
  return names.filter(name => !envelope.has(name) && !name.startsWith('cribl_') && !name.startsWith('__'));
}

/**
 * Vendor keys written in an Exabeam parser pattern. `srcip=({src_ip}…)` contributes
 * `srcip`. The name in braces is the field Exabeam stores, so it is not a source key.
 * A pattern with no key contributes nothing.
 */
export function vendorKeysFromExabeamPattern(pattern: string): string[] {
  const keys = new Set<string>();
  // `\s` and `\|` are escapes in the parser file, not part of the vendor key.
  const text = String(pattern || '').replace(/\\s/g, ' ').replace(/\\"/g, '"').replace(/\\\|/g, '|');
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_])([A-Za-z_][\w.-]*(?:\|[A-Za-z_][\w.-]*)*)\)?\s*=\s*"?\(\{/g)) {
    for (const key of match[1].split('|')) {
      if (key.length >= 2 && FIELD_NAME_RE.test(key) && !READ_SKIP.has(key)) keys.add(key);
    }
  }
  for (const match of String(pattern || '').matchAll(/\$\.([A-Za-z_][\w]*)/g)) {
    if (FIELD_NAME_RE.test(match[1]) && !READ_SKIP.has(match[1])) keys.add(match[1]);
  }
  return [...keys];
}

function exabeamLabel(value: string): string {
  return String(value || '').trim().replace(/^"+|"+$/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Our sourcetypes for one Exabeam parser. Unknown products match nothing, so a
 * customer sourcetype never receives another product's keys.
 */
export function sourcetypesForExabeam(vendor: string, product: string, parserName = ''): string[] {
  const v = exabeamLabel(vendor);
  const p = exabeamLabel(product);
  const n = exabeamLabel(parserName);
  if (v === 'fortinet' && p.includes('fortigate')) return ['fortinet_fortigate', 'fortinet_fortigate_syslog', 'fortinet_fortigate_syslog_wrapped'];
  if (v === 'check point') return ['checkpoint_firewall'];
  if (v === 'palo alto networks' && p.includes('globalprotect')) return ['pan_globalprotect_syslog'];
  if (v === 'palo alto networks' && (p.includes('ngfw') || p.includes('pan os') || p === 'pan')) {
    if (n.includes('threat')) return ['palo_alto_threat', 'pan_threat_syslog', 'pan_threat_syslog_nopri'];
    if (n.includes('system')) return ['palo_alto_system', 'pan_system_syslog', 'pan_system_syslog_nopri'];
    return ['palo_alto_traffic', 'pan_traffic_syslog', 'pan_traffic_syslog_nopri'];
  }
  if (v === 'cisco' && (p.includes('adaptive security') || p.includes('asa'))) return ['cisco_asa', 'cisco_asa_syslog'];
  if (v === 'cisco' && p.includes('firepower')) return ['cisco_asa', 'cisco_firepower', 'cisco_ftd'];
  if (v === 'cisco' && p.includes('umbrella')) return ['cisco_umbrella'];
  if (v === 'cisco' && p.includes('duo')) return ['cisco_duo_activity', 'duo_security'];
  if (v === 'microsoft' && p.includes('event viewer') && p.includes('security')) return ['windows_security'];
  if (v === 'microsoft' && p.includes('event viewer') && p.includes('system')) return ['windows_system'];
  if (v === 'microsoft' && p.includes('event viewer') && p.includes('application')) return ['windows_application'];
  if (v === 'microsoft' && p.includes('sysmon')) return ['windows_sysmon'];
  if (v === 'microsoft' && p.includes('powershell')) return ['windows_powershell'];
  if (v === 'microsoft' && p.includes('defender for endpoint')) return ['windows_defender', 'ms_defender_atp_alerts'];
  if (v === 'microsoft' && p.includes('iis')) return ['microsoft_iis_accesslog'];
  if (v === 'amazon' && p.includes('cloudtrail')) return ['aws_cloudtrail'];
  if (v === 'amazon' && p.includes('guardduty')) return ['aws_guardduty'];
  if (v === 'crowdstrike' && p.includes('falcon')) return ['crowdstrike_falcon'];
  if (v === 'vmware' && p.includes('esxi')) return ['vmw_syslog'];
  if (v === 'unix' && p.includes('audit')) return ['linux_audit', 'auditd'];
  if (v === 'unix' && p === 'unix') return ['linux_syslog', 'linux_secure'];
  if (v === 'infoblox') return ['infoblox_dns'];
  if (v === 'okta') return ['okta_system'];
  if (v === 'netskope') return ['netskope_event_json', 'netskope_alert_json'];
  if (v.startsWith('juniper') && p.includes('srx')) return ['juniper_srx'];
  if (v === 'zscaler') return ['zscaler_web'];
  if (v === 'google' && p.includes('cloud')) return ['gcp_audit'];
  if (v === 'sentinelone') return ['sentinelone_cloudfunnel_v2'];
  if (v === 'apache') return ['apache_access'];
  return [];
}

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
