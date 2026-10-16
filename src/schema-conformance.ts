// Format-conformance checkers for the structured (non-OCSF, non-CEF) output
// formats — CIM, ASIM, ECS, Chronicle(UDM), JSON. This is the third checker
// family alongside src/ocsf-schema.ts (deep schema oracle) and src/cef-format.ts
// (wire-format syntax).
//
// HONEST SCOPE — driven by what reference data we actually vendor:
//  • CIM  — config/cim-data-models.json gives per-model field NAME+TYPE (no enums,
//           no required flag). So the check is TYPE CONFORMANCE: a field that IS a
//           CIM field but is emitted with the wrong JS type (a numeric field as a
//           string) — the same interop bug the OCSF Phase-3 layer catches.
//  • ASIM — config/sentinel-destinations.json gives ASim* table COLUMN name+type.
//           Same type-conformance check.
//  • ECS  — config/ecs-schema.json vendors the real Elastic Common Schema (field →
//           Elasticsearch type + allowed values). src/ecs-conformance.ts grades
//           mapping conflicts, malformed ip/number/date values, categorization
//           allowed values, and the envelope; the rest is advisory.
//  • Chronicle — no full schema is vendored here, so a STRUCTURAL ENVELOPE check:
//           UDM must carry a `metadata` object (the stricter SecOps wire contract is
//           auditUdmConformance below). A flat blob is not valid UDM.
//  • JSON — structural only (a non-empty object); there is no schema to grade.
//
// Like the CEF checker (and unlike the OCSF oracle, which REPLACES the score),
// these are CORRECTNESS CAPS: they never inflate a score, only cap a value-coverage
// score when the output is structurally/type-wise wrong. Type conformance and
// envelope shape are orthogonal to "did the source's values reach the output".
//
// Dependency-free except for the two knowledge loaders (which do NOT import
// pack-builder) and the UDM contract data, so importing this into pack-builder
// introduces no cycle.
import { cimModelFields } from './cim-knowledge';
import { resolveSentinelTable } from './sentinel-knowledge';
import udmContract from '../config/udm-contract.json';
import { auditEcsConformance, type EcsConformanceAudit } from './ecs-conformance';

export interface SchemaConformanceAudit {
  applicable: boolean;      // there was something to grade for this format
  format: string;           // 'cim' | 'asim' | 'ecs' | 'chronicle' | 'json'
  target: string | null;    // resolved model/table/envelope name
  score: number;            // 0–100 (fraction valid); does NOT inflate the score
  band: 'good' | 'warn' | 'fail';
  typeChecked: number;      // populated fields whose type we could enforce (CIM/ASIM)
  typeValid: number;
  typeViolations: string[]; // "field (expected number)"
  malformed: string[];      // structural problems (ECS/Chronicle/JSON envelope)
  reasons: string[];
  advisories?: string[];    // reported to repair, never capped (ECS)
  ecs?: EcsConformanceAudit; // the full ECS audit (ECS only)
}

const bandFor = (s: number): 'good' | 'warn' | 'fail' => (s >= 85 ? 'good' : s >= 60 ? 'warn' : 'fail');

// Cribl housekeeping / routing fields that ride alongside structured output.
const HOUSEKEEPING = new Set([
  '_raw', '_time', '_metadata', '__criblEventType', 'cribl_breaker', 'cribl_pipe',
  'index', 'source', 'sourcetype', 'host',
]);

// destFormat `cim#<class>` → CIM model name. Bare `cim` = Network Traffic.
const CIM_CLASS_MODEL: Record<string, string> = {
  network: 'Network_Traffic', network_traffic: 'Network_Traffic',
  network_sessions: 'Network_Sessions', authentication: 'Authentication',
  web_proxy: 'Web', web: 'Web', dns: 'Network_Resolution',
  network_resolution: 'Network_Resolution', endpoint: 'Endpoint', change: 'Change',
  intrusion_detection: 'Intrusion_Detection', malware: 'Malware', email: 'Email',
  data_access: 'Data_Access', dlp: 'DLP', vulnerabilities: 'Vulnerabilities', alerts: 'Alerts',
};

// destFormat `asim#<class>` → ASim* table name. Bare `asim` = Network Session.
const ASIM_CLASS_TABLE: Record<string, string> = {
  network: 'ASimNetworkSessionLogs', authentication: 'ASimAuthenticationEventLogs',
  dns: 'ASimDnsActivityLogs', web_proxy: 'ASimWebSessionLogs', web: 'ASimWebSessionLogs',
  endpoint: 'ASimProcessEventLogs', file: 'ASimFileEventLogs', registry: 'ASimRegistryEventLogs',
  audit: 'ASimAuditEventLogs', dhcp: 'ASimDhcpEventLogs', usermgmt: 'ASimUserManagementActivityLogs',
};

function classOf(destFormat: string): string {
  const hash = destFormat.indexOf('#');
  return hash >= 0 ? destFormat.slice(hash + 1).toLowerCase() : '';
}

// Read a field from the event, falling back to its JSON-serialized `_raw` (flat
// formats like CIM may collapse into `_raw`). Returns undefined when absent.
function readField(event: any, name: string): any {
  if (event && event[name] !== undefined) return event[name];
  if (event && typeof event._raw === 'string' && event._raw.charAt(0) === '{') {
    try { const p = JSON.parse(event._raw); if (p && typeof p === 'object') return p[name]; } catch { /* not JSON */ }
  }
  return undefined;
}

function populated(v: any): boolean {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return String(v).trim() !== '' && String(v) !== '-';
}

// Which declared types we can enforce a concrete JS shape for. Number-family and
// boolean only — string/timestamp/datetime/guid/dynamic are left LENIENT (a number
// coerced into a string is harmless; the interop bug we catch is the reverse).
function enforceableType(declared: string): 'number' | 'boolean' | null {
  const t = declared.toLowerCase();
  if (t === 'number' || t === 'long' || t === 'int' || t === 'integer' || t === 'real' || t === 'double') return 'number';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  return null;   // string, timestamp, datetime, guid, dynamic, object → lenient
}

// Shared type-conformance pass over a flat name→type schema (CIM model / ASIM table).
function auditFlatTypes(format: string, target: string, fieldTypes: Map<string, string>, outputEvents: any[]): SchemaConformanceAudit {
  const events = (outputEvents || []).filter(e => e && typeof e === 'object' && !Array.isArray(e));
  let typeChecked = 0, typeValid = 0;
  const violations = new Set<string>();
  for (const ev of events) {
    for (const [name, declared] of fieldTypes) {
      const kind = enforceableType(declared);
      if (!kind) continue;
      const v = readField(ev, name);
      if (!populated(v)) continue;
      typeChecked++;
      const ok = kind === 'number' ? (typeof v === 'number' && Number.isFinite(v)) : typeof v === 'boolean';
      if (ok) typeValid++;
      else violations.add(`${name} (expected ${kind})`);
    }
  }
  const score = typeChecked ? Math.round(100 * typeValid / typeChecked) : 100;
  const reasons: string[] = [];
  if (typeChecked && typeValid < typeChecked) {
    reasons.push(`${typeChecked - typeValid}/${typeChecked} typed ${format.toUpperCase()} field(s) have the wrong JSON type (${[...violations].slice(0, 4).join(', ')}) — ${target} expects numeric/boolean, not string.`);
  } else {
    reasons.push(`${format.toUpperCase()} ${target}: ${typeValid}/${typeChecked} typed fields conform.`);
  }
  return {
    applicable: events.length > 0, format, target, score, band: bandFor(score),
    typeChecked, typeValid, typeViolations: [...violations], malformed: [], reasons,
  };
}

// Structural envelope check for a nested format with no vendored schema. `nests`
// = the top-level object keys that make the output recognizably this format; the
// output is valid if at least one is a populated nested object.
function auditEnvelope(format: string, nests: string[], required: string, outputEvents: any[]): SchemaConformanceAudit {
  const events = (outputEvents || []).filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!events.length) return { applicable: false, format, target: null, score: 0, band: 'fail', typeChecked: 0, typeValid: 0, typeViolations: [], malformed: [], reasons: [] };
  let ok = 0;
  for (const ev of events) {
    const src = (ev && typeof ev._raw === 'string' && ev._raw.charAt(0) === '{') ? (() => { try { return JSON.parse(ev._raw); } catch { return ev; } })() : ev;
    const hasNest = nests.some(k => src && src[k] != null && typeof src[k] === 'object' && Object.keys(src[k]).length > 0);
    if (hasNest) ok++;
  }
  const score = Math.round(100 * ok / events.length);
  const reasons: string[] = [];
  if (ok < events.length) {
    reasons.push(`${events.length - ok}/${events.length} events are not a valid ${format.toUpperCase()} envelope — ${required}. A flat blob is not valid ${format.toUpperCase()}.`);
  } else {
    reasons.push(`Valid ${format.toUpperCase()} envelope: every event carries ${required}.`);
  }
  return { applicable: true, format, target: format, score, band: bandFor(score), typeChecked: 0, typeValid: 0, typeViolations: [], malformed: ok < events.length ? [`missing ${required}`] : [], reasons };
}

function auditJsonStructural(outputEvents: any[]): SchemaConformanceAudit {
  const events = (outputEvents || []).filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!events.length) return { applicable: false, format: 'json', target: null, score: 0, band: 'fail', typeChecked: 0, typeValid: 0, typeViolations: [], malformed: [], reasons: [] };
  // A JSON destination just needs each event to be a non-empty object once its
  // routing fields are set aside — there is no schema to grade further.
  let ok = 0;
  for (const ev of events) {
    const meaningful = Object.keys(ev).filter(k => !HOUSEKEEPING.has(k) && populated(ev[k]));
    if (meaningful.length > 0) ok++;
  }
  const score = Math.round(100 * ok / events.length);
  const reasons = ok < events.length
    ? [`${events.length - ok}/${events.length} JSON events carry no fields beyond routing metadata.`]
    : [`Valid JSON: every event is a non-empty object.`];
  return { applicable: true, format: 'json', target: 'json', score, band: bandFor(score), typeChecked: 0, typeValid: 0, typeViolations: [], malformed: [], reasons };
}

/**
 * Audit structured output against the best conformance check available for its
 * format. Returns { applicable:false } for a format we cannot grade (unknown, or
 * no reference data), so the caller leaves the score untouched.
 */
export function auditSchemaConformance(destFormat: string, outputEvents: any[]): SchemaConformanceAudit {
  const na: SchemaConformanceAudit = { applicable: false, format: destFormat, target: null, score: 0, band: 'fail', typeChecked: 0, typeValid: 0, typeViolations: [], malformed: [], reasons: [] };
  const fmt = destFormat || '';

  if (fmt === 'cim' || fmt.startsWith('cim#')) {
    const cls = classOf(fmt);
    const model = CIM_CLASS_MODEL[cls] || 'Network_Traffic';
    const fields = cimModelFields(model);
    if (!fields.length) return { ...na, format: 'cim' };
    const map = new Map(fields.map(f => [f.name, f.type]));
    return auditFlatTypes('cim', model, map, outputEvents);
  }

  if (fmt === 'asim' || fmt.startsWith('asim#')) {
    const cls = classOf(fmt);
    const tableName = ASIM_CLASS_TABLE[cls] || 'ASimNetworkSessionLogs';
    const resolved = resolveSentinelTable(tableName);
    if (!resolved) return { ...na, format: 'asim' };
    const map = new Map(resolved.table.columns.map(c => [c.name, c.type]));
    return auditFlatTypes('asim', resolved.name, map, outputEvents);
  }

  if (fmt === 'ecs' || fmt.startsWith('ecs#')) {
    const ecs = auditEcsConformance(outputEvents);
    if (!ecs.applicable) return { ...na, format: 'ecs' };
    return {
      applicable: true, format: 'ecs', target: `ECS ${ecs.version}`, score: ecs.score, band: ecs.band,
      typeChecked: ecs.valueChecks, typeValid: ecs.valueValid,
      // Field name first in each entry — the repair finding uses the first token.
      typeViolations: [...ecs.conflicts, ...ecs.invalidValues, ...ecs.malformedValues],
      malformed: [...ecs.conflicts, ...(ecs.envelopeEvents < ecs.totalEvents ? ['missing a nested ECS object'] : [])],
      reasons: ecs.reasons, advisories: ecs.advisories, ecs,
    };
  }

  if (fmt === 'chronicle#raw') return na; // the original line for Google's parser, not UDM
  if (fmt === 'chronicle' || fmt.startsWith('chronicle#')) {
    // Chronicle UDM requires a `metadata` object (event_type/timestamp live there).
    return auditEnvelope('chronicle', ['metadata', 'principal', 'target', 'network', 'security_result'], 'a UDM `metadata` object (event_type/timestamp)', outputEvents);
  }

  if (fmt === 'json') return auditJsonStructural(outputEvents);

  return na;
}

// --- Google SecOps UDM wire contract ----------------------------------------
// The envelope check above only asks "is this UDM-shaped". The Cribl Google SecOps
// destination is stricter, and two of its rules decide whether an event arrives at
// all (config/udm-contract.json, from the Google UDM field list + the Cribl ENG test
// plan):
//  • DROP — an event whose metadata.event_type is not a UDM EventType, or whose
//    metadata.event_timestamp is not {seconds:number, nanos:number}, is discarded
//    while the destination's Test tab still reports success.
//  • BATCH 400 — a datatype mismatch (a scalar for a repeated field, a value outside
//    an enum, a number for a string field) fails the WHOLE batch.
// Like capXsiam this is a CONSEQUENCE cap: every event dropped → UDM_DROP_CAP; some
// dropped, or any batch-400 violation → UDM_INVALID_CAP. Both sit under the golden
// bar. A conformant output is untouched. chronicle#raw is the original line for
// Google's own parser, so it is never graded here.
export const UDM_DROP_CAP = 25;
export const UDM_INVALID_CAP = 55;

export interface UdmConformanceAudit {
  applicable: boolean;
  totalEvents: number;
  droppedEvents: number;    // the destination silently discards these
  invalidEvents: number;    // kept, but a datatype violation fails the batch with 400
  cap: number | null;
  band: 'good' | 'warn' | 'fail';
  failures: string[];       // distinct violations, e.g. "DROP metadata.event_type FOO"
  reasons: string[];
}

const UDM_ENUMS: Record<string, string[]> = Object.fromEntries(
  Object.entries(udmContract.enums as Record<string, string[]>).map(([k, v]) => [k.split('.').pop() as string, v]),
);
const UDM_ENTITY_NOUNS = ['principal', 'target', 'src', 'observer', 'intermediary'];

const getPath = (o: any, p: string): any => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

// Mirrors udmErrors in tests/udm-contract-test.mjs (the build-time check of every
// chronicle spec); this is the same contract applied to the live output.
export function udmEventErrors(ev: any): { drop: string[]; invalid: string[] } {
  const drop: string[] = [];
  const invalid: string[] = [];
  const ts = ev?.metadata?.event_timestamp;
  if (!ts || typeof ts.seconds !== 'number' || typeof ts.nanos !== 'number')
    drop.push(`DROP metadata.event_timestamp ${JSON.stringify(ts ?? null)}`);
  if (!UDM_ENUMS.EventType.includes(ev?.metadata?.event_type)) drop.push(`DROP metadata.event_type ${ev?.metadata?.event_type}`);
  for (const n of UDM_ENTITY_NOUNS) if (Array.isArray(ev?.[n])) invalid.push(`${n} is an array`);
  for (const p of udmContract.repeated) { const v = getPath(ev, p); if (v != null && !Array.isArray(v)) invalid.push(`${p} must be repeated`); }
  for (const p of udmContract.stringTyped) { const v = getPath(ev, p); if (v != null && typeof v !== 'string') invalid.push(`${p} must be a string`); }
  const net = ev?.network || {};
  if (net.ip_protocol != null && !UDM_ENUMS.IpProtocol.includes(net.ip_protocol)) invalid.push(`network.ip_protocol ${net.ip_protocol}`);
  if (net.application_protocol != null && !UDM_ENUMS.ApplicationProtocol.includes(net.application_protocol)) invalid.push(`network.application_protocol ${net.application_protocol}`);
  if (net.direction != null && !UDM_ENUMS.Direction.includes(net.direction)) invalid.push(`network.direction ${net.direction}`);
  for (const sr of [].concat(ev?.security_result || []) as any[])
    for (const a of [].concat(sr?.action ?? []) as any[]) if (!UDM_ENUMS.Action.includes(a)) invalid.push(`security_result.action ${a}`);
  const au = ev?.extensions?.auth;
  if (au?.type != null && !UDM_ENUMS.AuthType.includes(au.type)) invalid.push(`extensions.auth.type ${au.type}`);
  for (const m of [].concat(au?.mechanism ?? []) as any[]) if (!UDM_ENUMS.Mechanism.includes(m)) invalid.push(`extensions.auth.mechanism ${m}`);
  return { drop, invalid };
}

export function isUdmConformanceFormat(destFormat: string): boolean {
  const f = destFormat || '';
  return f === 'chronicle' || (f.startsWith('chronicle#') && f !== 'chronicle#raw');
}

export function auditUdmConformance(destFormat: string, outputEvents: any[]): UdmConformanceAudit {
  const events = (outputEvents || []).filter(e => e && typeof e === 'object' && !Array.isArray(e));
  const empty: UdmConformanceAudit = { applicable: false, totalEvents: 0, droppedEvents: 0, invalidEvents: 0, cap: null, band: 'good', failures: [], reasons: [] };
  if (!isUdmConformanceFormat(destFormat) || !events.length) return empty;
  let dropped = 0, invalid = 0;
  const failures = new Set<string>();
  for (const raw of events) {
    // Same `_raw` JSON fallback as the envelope check: the UDM nouns may ride serialized.
    const ev = (raw.metadata == null && typeof raw._raw === 'string' && raw._raw.charAt(0) === '{')
      ? (() => { try { return JSON.parse(raw._raw); } catch { return raw; } })()
      : raw;
    const e = udmEventErrors(ev);
    if (e.drop.length) dropped++;
    else if (e.invalid.length) invalid++;
    for (const f of [...e.drop, ...e.invalid]) failures.add(f);
  }
  const total = events.length;
  const cap = dropped === total ? UDM_DROP_CAP : (dropped || invalid) ? UDM_INVALID_CAP : null;
  const reasons: string[] = [];
  if (dropped) reasons.push(`${dropped}/${total} events will be dropped by the Google SecOps destination — metadata.event_type must be a UDM EventType and metadata.event_timestamp must be {seconds:number, nanos:number}; the destination's Test tab still reports success.`);
  if (invalid) reasons.push(`${invalid}/${total} events break the UDM datatype contract, which fails the whole batch with HTTP 400.`);
  if (!reasons.length) reasons.push(`UDM wire contract: all ${total} events conform.`);
  return {
    applicable: true, totalEvents: total, droppedEvents: dropped, invalidEvents: invalid,
    cap, band: cap == null ? 'good' : bandFor(cap), failures: [...failures], reasons,
  };
}

// True for the formats auditSchemaConformance can actually grade — used by
// scoreAuthoritative to decide whether to run it.
export function isSchemaConformanceFormat(destFormat: string): boolean {
  const f = destFormat || '';
  return f === 'cim' || f.startsWith('cim#')
    || f === 'asim' || f.startsWith('asim#')
    || f === 'ecs' || f.startsWith('ecs#')
    || f === 'chronicle' || (f.startsWith('chronicle#') && f !== 'chronicle#raw')
    || f === 'json';
}
