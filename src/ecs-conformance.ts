// ECS conformance — grade ECS output against the REAL Elastic Common Schema
// (config/ecs-schema.json, vendored by scripts/sync-ecs-schema.mjs from
// elastic/ecs `generated/ecs/ecs_flat.yml`). Replaces the envelope-only ECS check
// in src/schema-conformance.ts, which is still where it is wired (same cap family,
// same SchemaConformanceAudit result) so every flow picks it up with no new wiring.
//
// What CAPS — only what Elasticsearch or Elastic Security actually does with it:
//  • MAPPING CONFLICT (doc rejected) — a scalar where ECS defines an object (a
//    top-level `source: "fw01"` string against ECS `source.*`), or an object where
//    ECS defines a leaf. Elasticsearch rejects the WHOLE document for this even
//    with ignore_malformed. Every event conflicting → ECS_REJECT_CAP; some → the
//    share accepted (never below the cap).
//  • MALFORMED TYPED VALUE — a non-IP in an `ip` field, a non-numeric string in a
//    `long`, a date Elasticsearch's default `strict_date_optional_time||epoch_millis`
//    cannot parse (incl. epoch SECONDS, which reads as milliseconds → 1970). The
//    value is dropped into `_ignored` (logs-*-* sets ignore_malformed) or the doc
//    is rejected. Proportional: share of graded typed values that index correctly.
//  • INVALID CATEGORIZATION — a value outside `allowed_values` for event.kind /
//    event.category / event.type / event.outcome (and the other enum'd fields).
//    It indexes, but Security rules, the SIEM views and ECS categorization never
//    see it. Every event → ECS_CATEGORIZATION_CAP; some → the valid share.
//  • ENVELOPE — no nested ECS object at all (a flat blob) — the old check, kept.
//
// What is ADVISORY only (reported, never capped — Elasticsearch accepts it):
// numeric strings (coerced), a single string for an array-normalized field
// (event.category 'network'), an event.type not in its category's
// expected_event_types, empty strings/NaN in typed fields, unknown leaves under an
// ECS namespace (likely typos — a sibling is suggested), custom top-level fields,
// and missing ecs.version / event.category / timestamp.
//
// `@timestamp` cannot be written by a Cribl Eval; the Cribl Elasticsearch
// destination converts `_time` → `@timestamp`, so `_time` satisfies it here.
// A top-level `host` STRING is likewise converted to `host.name` by the
// destination, so it is not a conflict.
//
// Dependency-free except the vendored schema — safe to import from
// schema-conformance.ts (no pack-builder import, no cycle).
import ecsIndex from '../config/ecs-schema.json';

interface EcsIndex {
  version: string;
  source: string;
  fieldCount: number;
  required: string[];
  allowed: Record<string, string[]>;
  expectedEventTypes: Record<string, string[]>;
  types: string[];                  // ES type, `[]` suffix = ECS array-normalized
  fieldTree: EcsFieldTree;          // dotted-name trie, leaf = index into `types`
}
export interface EcsFieldTree { [segment: string]: number | EcsFieldTree }

/**
 * Expand the committed field trie (scripts/sync-ecs-schema.mjs
 * encodeEcsFieldTree) back to dotted name → type. A "" key is the type of a name
 * that is also a prefix of other fields.
 */
export function decodeEcsFieldTree(types: string[], tree: EcsFieldTree): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: EcsFieldTree, prefix: string) => {
    for (const [seg, v] of Object.entries(node)) {
      const name = seg === '' ? prefix : (prefix ? `${prefix}.${seg}` : seg);
      if (typeof v === 'number') out[name] = types[v];
      else walk(v, name);
    }
  };
  walk(tree, '');
  return out;
}

const INDEX = ecsIndex as unknown as EcsIndex;
const FIELDS = decodeEcsFieldTree(INDEX.types, INDEX.fieldTree);
export const ECS_SCHEMA_VERSION = INDEX.version;

// Every event a mapping conflict (Elasticsearch rejects the document) → this.
export const ECS_REJECT_CAP = 25;
// Every event miscategorized (indexed, invisible to categorization) → this. Under
// the 80 repair threshold and the golden bar, like OCSF's class-mismatch cap.
export const ECS_CATEGORIZATION_CAP = 55;

const TYPE = new Map<string, string>();
const ARRAY_NORMALIZED = new Set<string>();
for (const [name, t] of Object.entries(FIELDS)) {
  const arr = t.endsWith('[]');
  TYPE.set(name, arr ? t.slice(0, -2) : t);
  if (arr) ARRAY_NORMALIZED.add(name);
}
// Every strict dotted prefix of an ECS field is an object namespace (source,
// source.geo, …); parent → child segment for typo suggestions.
const PARENTS = new Set<string>();
const CHILDREN = new Map<string, Set<string>>();
for (const name of TYPE.keys()) {
  const seg = name.split('.');
  for (let i = 1; i <= seg.length; i++) {
    const parent = seg.slice(0, i - 1).join('.');
    if (i < seg.length) PARENTS.add(seg.slice(0, i).join('.'));
    if (!CHILDREN.has(parent)) CHILDREN.set(parent, new Set());
    CHILDREN.get(parent)!.add(seg[i - 1]);
  }
}
const ALLOWED = new Map(Object.entries(INDEX.allowed).map(([k, v]) => [k, new Set(v)]));
const OBJECT_TYPES = new Set(['object', 'flattened', 'nested']);
const NUMERIC_TYPES = new Set(['long', 'integer', 'short', 'byte', 'unsigned_long', 'float', 'double', 'half_float', 'scaled_float']);

// Cribl housekeeping / routing fields that are not part of the ECS document.
function isHousekeeping(key: string): boolean {
  return key === '_raw' || key === '_time' || key === '_metadata' || key === 'index' || key === 'sourcetype'
    || key.startsWith('__') || key.startsWith('cribl_');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

function isIpv4(s: string): boolean {
  const p = s.split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}
function isIpv6(s: string): boolean {
  if (!s.includes(':')) return false;
  let t = s;
  const last = t.lastIndexOf(':');
  const tail = t.slice(last + 1);
  if (tail.includes('.')) {
    if (!isIpv4(tail)) return false;
    t = t.slice(0, last + 1) + '0:0';
  }
  const halves = t.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap(h => (h === '' ? [] : h.split(':')));
  if (!groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}
export const isEcsIp = (s: string): boolean => isIpv4(s) || isIpv6(s);

// Elasticsearch's default date format: strict_date_optional_time||epoch_millis.
// strict_date_optional_time needs the `T` separator — "2024-01-13 10:00:00" fails.
const ISO_DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2}([.,]\d{1,9})?)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?)?)?$/;
const NUMERIC_STRING = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

type Verdict = 'ok' | 'coerced' | 'empty' | 'bad' | 'ungraded';

// Grade one scalar against its ECS type. `detail` explains a 'bad'.
function gradeScalar(type: string, v: unknown): { verdict: Verdict; detail?: string } {
  // NaN/Infinity leave Cribl as JSON `null`, which Elasticsearch treats as absent —
  // a lost value, not a malformed one.
  if (typeof v === 'number' && !Number.isFinite(v)) return { verdict: 'empty' };
  if (NUMERIC_TYPES.has(type)) {
    if (typeof v === 'number') return { verdict: 'ok' };
    if (typeof v === 'string') {
      if (v.trim() === '') return { verdict: 'empty' };
      return NUMERIC_STRING.test(v) ? { verdict: 'coerced' } : { verdict: 'bad', detail: `'${v}'` };
    }
    return { verdict: 'bad', detail: JSON.stringify(v) };
  }
  if (type === 'ip') {
    if (typeof v !== 'string') return { verdict: 'bad', detail: JSON.stringify(v) };
    if (v.trim() === '') return { verdict: 'empty' };
    return isEcsIp(v) ? { verdict: 'ok' } : { verdict: 'bad', detail: `'${v}'` };
  }
  if (type === 'date') {
    const epoch = (n: number) => (Math.abs(n) < 1e11
      ? { verdict: 'bad' as const, detail: `${n} (epoch seconds — Elasticsearch reads a number as epoch_millis, so this lands in 1970)` }
      : { verdict: 'ok' as const });
    if (typeof v === 'number') return epoch(v);
    if (typeof v === 'string') {
      if (v.trim() === '') return { verdict: 'empty' };
      if (/^-?\d+$/.test(v)) return epoch(Number(v));
      return ISO_DATE.test(v) ? { verdict: 'ok' } : { verdict: 'bad', detail: `'${v}'` };
    }
    return { verdict: 'bad', detail: JSON.stringify(v) };
  }
  if (type === 'boolean') {
    if (typeof v === 'boolean') return { verdict: 'ok' };
    if (v === 'true' || v === 'false') return { verdict: 'coerced' };
    if (v === '') return { verdict: 'empty' };
    return { verdict: 'bad', detail: JSON.stringify(v) };
  }
  return { verdict: 'ungraded' };   // keyword / wildcard / text / constant_keyword / geo_point
}

// Optimal-string-alignment distance: a swapped pair (`prot`/`port`) costs 1.
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// The closest ECS sibling of an unknown path (`destination.prot` → `destination.port`).
export function suggestEcsField(path: string): string | null {
  const i = path.lastIndexOf('.');
  const parent = i < 0 ? '' : path.slice(0, i);
  const leaf = path.slice(i + 1);
  let best: string | null = null, bestD = Infinity;
  for (const c of CHILDREN.get(parent) || []) {
    const dist = editDistance(leaf.toLowerCase(), c.toLowerCase());
    if (dist < bestD) { bestD = dist; best = c; }
  }
  return best != null && bestD <= Math.max(1, Math.min(2, Math.floor(leaf.length / 3))) ? (parent ? `${parent}.${best}` : best) : null;
}

interface EventFindings {
  conflicts: string[];
  leaves: Map<string, unknown>;
  unknownEcs: string[];
  customTop: string[];
}

// Walk one event against the schema. Literal dotted keys ("source.ip") resolve
// like nested ones — Elasticsearch expands dots in field names.
function walkEvent(ev: Record<string, unknown>): EventFindings {
  const out: EventFindings = { conflicts: [], leaves: new Map(), unknownEcs: [], customTop: [] };
  const visit = (path: string, v: unknown, top: boolean) => {
    if (v === undefined) return;
    const type = TYPE.get(path);
    if (type && OBJECT_TYPES.has(type)) {
      const els = Array.isArray(v) ? v : [v];
      if (els.some(e => e != null && !isPlainObject(e))) { out.conflicts.push(`${path} (ECS ${type}, got ${typeof els.find(e => !isPlainObject(e))})`); return; }
      // An object field with ECS-defined children (log.syslog, dns.answers) — grade
      // the known children; anything else under an object field is free-form.
      if (PARENTS.has(path)) for (const e of els) for (const [k, c] of Object.entries(e as object)) {
        if (TYPE.has(`${path}.${k}`) || PARENTS.has(`${path}.${k}`)) visit(`${path}.${k}`, c, false);
      }
      return;
    }
    if (type) {
      const els = Array.isArray(v) ? v : [v];
      if (type !== 'geo_point' && els.some(isPlainObject)) { out.conflicts.push(`${path} (ECS ${type}, got object)`); return; }
      out.leaves.set(path, v);
      return;
    }
    if (PARENTS.has(path)) {
      const els = Array.isArray(v) ? v : [v];
      if (els.some(e => e != null && !isPlainObject(e))) {
        // The destination itself turns a top-level `host` string into host.name.
        if (!(top && path === 'host' && typeof v === 'string')) {
          out.conflicts.push(`${path} (ECS object, got ${Array.isArray(v) ? 'array' : typeof v})`);
        }
        return;
      }
      for (const e of els) for (const [k, c] of Object.entries(e as object)) visit(`${path}.${k}`, c, false);
      return;
    }
    if (top && !path.includes('.')) { out.customTop.push(path); return; }
    const root = path.split('.')[0];
    if (PARENTS.has(root)) out.unknownEcs.push(path);
    else out.customTop.push(root);
  };
  for (const [k, v] of Object.entries(ev)) {
    if (isHousekeeping(k)) continue;
    visit(k, v, true);
  }
  return out;
}

export interface EcsConformanceAudit {
  applicable: boolean;
  version: string;
  totalEvents: number;
  score: number;                 // min of the four dimensions; 100 = conformant
  band: 'good' | 'warn' | 'fail';
  rejectedEvents: number;        // ≥1 mapping conflict — Elasticsearch rejects the doc
  miscategorizedEvents: number;  // ≥1 value outside allowed_values
  envelopeEvents: number;        // events carrying a nested ECS object
  valueChecks: number;           // typed (ip / numeric / date / boolean) values graded
  valueValid: number;
  conflicts: string[];           // "source (ECS object, got string)"
  invalidValues: string[];       // "event.category 'firewall'"
  malformedValues: string[];     // "source.ip 'abc' (expected ip)"
  unknownFields: string[];       // leaves under an ECS namespace that ECS does not define
  customFields: string[];        // top-level non-ECS fields
  advisories: string[];
  reasons: string[];             // reasons[0] = the most severe finding (repair prompt reads it)
}

const bandFor = (s: number): 'good' | 'warn' | 'fail' => (s >= 85 ? 'good' : s >= 60 ? 'warn' : 'fail');
const sample = (xs: Iterable<string>, n = 4) => [...xs].slice(0, n).join(', ');

// A cap for an event-level defect: none → 100, all → `cap`, some → the clean share
// (never below `cap`, so a partial failure never scores under a total one).
function shareCap(bad: number, total: number, cap: number): number {
  if (!bad) return 100;
  if (bad >= total) return cap;
  return Math.max(cap, Math.round(100 * (total - bad) / total));
}

function ecsSource(ev: Record<string, unknown>): Record<string, unknown> {
  // Nouns may ride serialized in a JSON `_raw` when nothing ECS is at the top
  // level (same fallback as the other structured checks).
  const hasEcs = Object.keys(ev).some(k => !isHousekeeping(k) && (TYPE.has(k) || PARENTS.has(k.split('.')[0])));
  if (!hasEcs && typeof ev._raw === 'string' && ev._raw.charAt(0) === '{') {
    try { const p = JSON.parse(ev._raw); if (isPlainObject(p)) return p; } catch { /* not JSON */ }
  }
  return ev;
}

export function auditEcsConformance(outputEvents: any[]): EcsConformanceAudit {
  const events = (outputEvents || []).filter(isPlainObject) as Record<string, unknown>[];
  const base: EcsConformanceAudit = {
    applicable: false, version: INDEX.version, totalEvents: events.length, score: 100, band: 'good',
    rejectedEvents: 0, miscategorizedEvents: 0, envelopeEvents: 0, valueChecks: 0, valueValid: 0,
    conflicts: [], invalidValues: [], malformedValues: [], unknownFields: [], customFields: [], advisories: [], reasons: [],
  };
  if (!events.length) return base;

  const conflicts = new Set<string>(), invalid = new Set<string>(), malformed = new Set<string>();
  const unknown = new Set<string>(), custom = new Set<string>();
  const coerced = new Set<string>(), empty = new Set<string>(), scalarArrays = new Set<string>(), pairing = new Set<string>();
  let rejected = 0, miscategorized = 0, envelope = 0, checks = 0, valid = 0;
  let noVersion = 0, noCategory = 0, noTime = 0;

  for (const raw of events) {
    const ev = ecsSource(raw);
    if (Object.entries(ev).some(([k, v]) => !isHousekeeping(k) && PARENTS.has(k) && isPlainObject(v) && Object.keys(v).length > 0)) envelope++;
    const f = walkEvent(ev);
    if (f.conflicts.length) rejected++;
    f.conflicts.forEach(c => conflicts.add(c));
    f.unknownEcs.forEach(u => unknown.add(u));
    f.customTop.forEach(c => custom.add(c));

    let badCat = false;
    for (const [path, v] of f.leaves) {
      const type = TYPE.get(path)!;
      const els = Array.isArray(v) ? v : [v];
      const allowed = ALLOWED.get(path);
      if (allowed) {
        for (const e of els) {
          if (e == null || e === '') continue;
          if (typeof e !== 'string' || !allowed.has(e)) { invalid.add(`${path} ${JSON.stringify(e)}`); badCat = true; }
        }
        if (!Array.isArray(v) && ARRAY_NORMALIZED.has(path) && v != null && v !== '') scalarArrays.add(path);
        continue;
      }
      for (const e of els) {
        if (e == null) continue;
        const g = gradeScalar(type, e);
        if (g.verdict === 'ungraded') continue;
        if (g.verdict === 'empty') { empty.add(`${path} (${type})`); continue; }
        checks++;
        if (g.verdict === 'bad') malformed.add(`${path} ${g.detail} (expected ${type})`);
        else valid++;
        if (g.verdict === 'coerced') coerced.add(`${path} (${type})`);
      }
    }
    if (badCat) miscategorized++;

    // Pairing: every event.type should be expected by at least one of its categories.
    const validOf = (path: string) => asList(f.leaves.get(path)).filter((x): x is string => typeof x === 'string' && ALLOWED.get(path)!.has(x));
    const cats = validOf('event.category');
    const types = validOf('event.type');
    if (cats.length) {
      const expected = new Set(cats.flatMap(c => INDEX.expectedEventTypes[c] || []));
      for (const t of types) if (!expected.has(t)) pairing.add(`event.type '${t}' with event.category ${cats.map(c => `'${c}'`).join('/')}`);
    } else noCategory++;
    if (!f.leaves.has('ecs.version')) noVersion++;
    if (raw._time == null && !f.leaves.has('@timestamp')) noTime++;
  }

  const total = events.length;
  const rejectScore = shareCap(rejected, total, ECS_REJECT_CAP);
  const catScore = shareCap(miscategorized, total, ECS_CATEGORIZATION_CAP);
  const valueScore = checks ? Math.round(100 * valid / checks) : 100;
  const envelopeScore = Math.round(100 * envelope / total);
  const score = Math.min(rejectScore, catScore, valueScore, envelopeScore);

  const reasons: string[] = [];
  if (rejected) {
    reasons.push(`${rejected}/${total} events have an ECS mapping conflict that makes Elasticsearch reject the whole document (${sample(conflicts)}) — never write a scalar where ECS defines an object (drop or rename a top-level vendor \`source\`/\`user\`/\`process\` string) or an object where ECS defines a leaf.`);
  }
  if (miscategorized) {
    const allowedHint = [...invalid].map(i => i.split(' ')[0]).filter((p, i, a) => a.indexOf(p) === i)
      .map(p => `${p} ∈ {${[...(ALLOWED.get(p) || [])].join(', ')}}`).slice(0, 3).join('; ');
    reasons.push(`${miscategorized}/${total} events use ECS categorization values outside the allowed set (${sample(invalid)}) — the event indexes but Elastic Security's rules and categorization views never match it. Allowed: ${allowedHint}.`);
  }
  if (checks && valid < checks) {
    reasons.push(`${checks - valid}/${checks} typed ECS values will not index (${sample(malformed, 3)}) — Elasticsearch drops a malformed ip/number/date into _ignored or rejects the document. Emit a valid IP, a Number(), and an ISO-8601 (with 'T') or epoch-milliseconds date.`);
  }
  if (envelope < total) {
    reasons.push(`${total - envelope}/${total} events are not a valid ECS envelope — no nested ECS object (event / source / destination / host / …). A flat blob is not valid ECS.`);
  }
  if (!reasons.length) {
    reasons.push(`ECS ${INDEX.version}: all ${total} events conform — ${checks} typed value(s) index cleanly, categorization uses allowed values, no mapping conflicts.`);
  }

  const advisories: string[] = [];
  if (unknown.size) {
    const hints = [...unknown].slice(0, 6).map(u => { const s = suggestEcsField(u); return s ? `${u} (did you mean ${s}?)` : u; });
    advisories.push(`${unknown.size} field(s) sit under an ECS namespace but are not ECS fields: ${hints.join(', ')} — use the ECS name, or move vendor-specific values to a custom namespace.`);
  }
  if (coerced.size) advisories.push(`Typed ECS field(s) sent as strings: ${sample(coerced, 6)} — Elasticsearch coerces them, but emit Number()/booleans so _source and the mapping agree.`);
  if (empty.size) advisories.push(`Empty value in typed ECS field(s): ${sample(empty, 6)} — '' or NaN is not a valid ip/number/date (NaN ships as null); omit the field when the source has no value.`);
  if (scalarArrays.size) advisories.push(`${sample(scalarArrays)} written as a single value — ECS normalizes it to an array (e.g. ['network']); Elastic accepts both.`);
  if (pairing.size) advisories.push(`event.type not expected for its category: ${sample(pairing, 3)} — see ECS expected_event_types.`);
  if (noVersion) advisories.push(`${noVersion}/${total} events have no ecs.version — ECS marks it required; set ecs.version = '${INDEX.version}'.`);
  if (noCategory) advisories.push(`${noCategory}/${total} events have no valid event.category — Elastic Security's category-based rules and views cannot classify them.`);
  if (noTime) advisories.push(`${noTime}/${total} events carry neither _time nor @timestamp — the destination derives @timestamp from _time.`);
  if (custom.size) advisories.push(`${custom.size} top-level field(s) are not ECS: ${sample(custom, 6)} — kept as custom fields; ECS recommends a vendor namespace for these.`);

  return {
    applicable: true, version: INDEX.version, totalEvents: total, score, band: bandFor(score),
    rejectedEvents: rejected, miscategorizedEvents: miscategorized, envelopeEvents: envelope,
    valueChecks: checks, valueValid: valid,
    conflicts: [...conflicts], invalidValues: [...invalid], malformedValues: [...malformed],
    unknownFields: [...unknown], customFields: [...custom], advisories, reasons,
  };
}
