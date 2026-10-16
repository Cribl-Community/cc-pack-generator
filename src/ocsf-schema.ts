// Phase 1 of project_ocsf_library_plan: score OCSF output against the REAL OCSF
// schema (config/ocsf-classes.json, vendored by scripts/sync-ocsf-schema.mjs),
// not our four hand-written golden specs.
//
// The decisive design choice: we identify the OCSF class from the class_uid the
// pipeline ACTUALLY produced — never from the destFormat the app guessed. That
// removes the old unfair penalty where the Copilot schematizer built (say)
// Authentication (3002) and we graded it against ocsf#cloud_audit's spec.
import ocsfIndex from '../config/ocsf-classes.json';

interface OcsfClassDef {
  uid: number;
  caption: string;
  category: string | null;
  category_uid: number | null;
  required: string[];
  recommended: string[];
  enums: Record<string, string[]>;
  objectAttrs: { name: string; object_type: string | null }[];
  types?: Record<string, string>;  // attr -> OCSF type; keys = full valid-attribute set (Phase 3)
  arrays?: string[];               // attrs that must hold an array when present (Phase 3)
}
interface OcsfIndex { version: string; source: string; classes: Record<string, OcsfClassDef> }

const INDEX = ocsfIndex as unknown as OcsfIndex;
export const OCSF_SCHEMA_VERSION = INDEX.version;

// uid -> class name (for detecting the class from an event's class_uid).
const UID_TO_NAME: Record<number, string> = {};
for (const [name, def] of Object.entries(INDEX.classes)) UID_TO_NAME[def.uid] = name;

// Our concretized dest keys -> OCSF class name, used ONLY as a fallback hint
// when an event carries no class_uid of its own.
const KEY_TO_CLASS: Record<string, string> = {
  'ocsf#network': 'network_activity',
  'ocsf#web_proxy': 'http_activity',
  'ocsf#endpoint': 'process_activity',
  'ocsf#cloud_audit': 'api_activity',
  'ocsf#authentication': 'authentication',
  'ocsf#dns': 'dns_activity',
  'ocsf#email': 'email_activity',
  'ocsf#dhcp': 'dhcp_activity',
  'ocsf#authorize_session': 'authorize_session',
  'ocsf#base': 'base_event',
};

// A key with a hand-written golden uses the table above; any other `ocsf#<name>`
// naming a vendored class (`ocsf#peripheral_device_query`, picked by the user or
// by Additional guidance) targets that class directly.
function classForKey(destFormat: string): string | null {
  const k = String(destFormat || '');
  if (KEY_TO_CLASS[k]) return KEY_TO_CLASS[k];
  if (k.startsWith('ocsf#') && INDEX.classes[k.slice(5)]) return k.slice(5);
  return null;
}

export function ocsfClassNameForKey(destFormat: string): string | null {
  return classForKey(destFormat);
}

/** The dest key for a vendored class: its hand-written golden key when it has one, else `ocsf#<name>`. */
export function ocsfKeyForClass(name: string): string {
  const hit = Object.entries(KEY_TO_CLASS).find(([, cls]) => cls === name);
  return hit ? hit[0] : `ocsf#${name}`;
}

export interface OcsfClassChoice { key: string; className: string; classUid: number; caption: string }

function choiceFor(name: string | null | undefined): OcsfClassChoice | null {
  const cls = name ? INDEX.classes[name] : null;
  return cls && name ? { key: ocsfKeyForClass(name), className: name, classUid: cls.uid, caption: cls.caption } : null;
}

/**
 * Resolve an explicit class choice against the vendored schema: a dest key
 * (`ocsf#authentication`, `nextgen#dns`), a class name (`authorize_session`), a
 * caption (`Authorize Session`) or a class_uid (`3003`). Null when it names no class.
 */
export function resolveOcsfClassChoice(choice: string | number | null | undefined): OcsfClassChoice | null {
  const raw = String(choice ?? '').trim();
  if (!raw || raw === 'auto') return null;
  const bare = raw.replace(/^(?:ocsf|nextgen)#/i, '');
  if (KEY_TO_CLASS[`ocsf#${bare}`]) return choiceFor(KEY_TO_CLASS[`ocsf#${bare}`]);
  if (/^\d{1,4}$/.test(bare)) return choiceFor(UID_TO_NAME[Number(bare)]);
  const norm = bare.toLowerCase().replace(/[\s-]+/g, '_');
  if (INDEX.classes[norm]) return choiceFor(norm);
  const byCaption = Object.entries(INDEX.classes).find(([, c]) => c.caption.toLowerCase() === bare.toLowerCase());
  return byCaption ? choiceFor(byCaption[0]) : null;
}

export interface OcsfGuidance extends Partial<OcsfClassChoice> { activityId?: number }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Read an OCSF target out of free-text Additional guidance: `class_uid=3003`,
 * `class 3003`, `activity_id=1`, or a class caption in a targeting phrase
 * ("map to Authorize Session", "use the OCSF Authorize Session class",
 * "Authorize Session (3003)"). A caption mentioned in passing ("keep the
 * authentication fields") is NOT a target — it needs one of those phrasings.
 * Returns null when the text names no class and no activity.
 */
export function parseOcsfGuidance(text: string | null | undefined): OcsfGuidance | null {
  const t = String(text || '');
  if (!t.trim()) return null;
  const out: OcsfGuidance = {};
  const uid = t.match(/\bclass[_ ]?uid\s*(?:=|:|is|of)?\s*(\d{1,4})\b/i) || t.match(/\bclass\s+(\d{4})\b/i);
  let choice = uid ? choiceFor(UID_TO_NAME[Number(uid[1])]) : null;
  if (!choice) {
    // Longest caption first so "Authorize Session" beats a shorter overlapping one.
    const captions = Object.entries(INDEX.classes)
      .filter(([, c]) => c.caption.length >= 4)
      .sort((a, b) => b[1].caption.length - a[1].caption.length);
    for (const [name, c] of captions) {
      const cap = escapeRe(c.caption).replace(/\\? /g, '[\\s_-]+');
      // One-word captions ("Authentication") are everyday words, so they need
      // `class`/`ocsf` around them; a multi-word caption may follow a verb.
      const verbs = c.caption.includes(' ') ? 'class|ocsf|to|as|use|using|into|target|targeting|emit' : 'class|ocsf';
      const lead = `\\b(?:${verbs})\\s+(?:the\\s+|an?\\s+)?(?:ocsf\\s+)?(?:1\\.\\d+\\s+)?${cap}\\b`;
      const trail = `\\b${cap}(?:\\s+(?:class|event|events)\\b|\\s*\\(\\s*${c.uid}\\s*\\))`;
      const re = new RegExp(`${lead}|${trail}`, 'gi');
      for (const m of t.matchAll(re)) {
        // "instead of the Base Event class" names the class to LEAVE.
        if (/\b(?:instead\s+of|not|than|from|over)\s+(?:the\s+|an?\s+)?(?:ocsf\s+)?$/i.test(t.slice(Math.max(0, m.index - 24), m.index))) continue;
        choice = choiceFor(name);
        break;
      }
      if (choice) break;
    }
  }
  if (choice) Object.assign(out, choice);
  const act = t.match(/\bactivity[_ ]?id\s*(?:=|:|is|of)?\s*(\d{1,3})\b/i);
  if (act) out.activityId = Number(act[1]);
  return Object.keys(out).length ? out : null;
}

/** uid of the class a concretized key (`ocsf#dns`) targets, or null. */
export function ocsfClassUidForKey(destFormat: string): number | null {
  const name = classForKey(destFormat);
  return name && INDEX.classes[name] ? INDEX.classes[name].uid : null;
}

/** The vendored class definition by name (`dns_activity`), or null. */
export function ocsfClassDef(name: string): OcsfClassDef | null {
  return INDEX.classes[name] || null;
}

/**
 * Union of the valid top-level attributes (name -> OCSF type) of the given
 * classes. Used to decide which mapped fields are real OCSF attributes (kept at
 * the top level) and which are vendor carry-over (folded into `unmapped`).
 */
export function ocsfAttributeTypes(classNames: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of classNames) {
    const types = INDEX.classes[n]?.types || {};
    for (const [k, v] of Object.entries(types)) if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Every vendored OCSF class name. */
export function ocsfClassNames(): string[] {
  return Object.keys(INDEX.classes);
}

/** Attributes that hold arrays in any of the given classes. */
export function ocsfArrayAttributes(classNames: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of classNames) for (const a of INDEX.classes[n]?.arrays || []) out.add(a);
  return out;
}

/** OCSF base `status_id` captions. `status` must hold one of these. */
export const OCSF_STATUS_CAPTIONS: Record<number, string> = { 0: 'Unknown', 1: 'Success', 2: 'Failure', 99: 'Other' };
const OCSF_STATUS_CAPTION_LIST = `[${Object.values(OCSF_STATUS_CAPTIONS).map(c => `'${c}'`).join(', ')}]`;
// Findings (2xxx), remediation (700x) and drone flights redefine status_id
// (1 New, 2 In Progress, …): their caption is NOT Success/Failure. Derived from
// the vendored schema so a resync keeps it right.
const NON_BASE_STATUS_CLASS_UIDS: number[] = Object.values(INDEX.classes)
  .filter(c => Array.isArray(c.enums?.status_id) && c.enums.status_id.join(',') !== '0,1,2,99')
  .map(c => c.uid)
  .sort((a, b) => a - b);

/** Mapper rule: `status` is the caption, the vendor's own word goes to status_detail. */
export const OCSF_STATUS_MAPPING_RULE = 'status is the CAPTION of status_id, never the vendor word: status_id 1 → status "Success", 2 → "Failure", 99 → "Other", 0 → "Unknown". '
  + 'Map the vendor outcome to status_id (Finished/Approved/Completed/Success/Allowed → 1; Denied/Rejected/Failed/Blocked → 2; anything else → 99) and put the raw vendor value (e.g. "Finished") in status_detail.';

/**
 * Compact per-class mapping hint for the AI mapper, generated from the vendored
 * schema so it can never drift from what the oracle grades (the hand-written
 * hint said "OCSF v1.4" and taught `type_uid = 400101 + activity_id`).
 */
export function ocsfMappingHintForKey(destFormat: string): string | null {
  const name = classForKey(destFormat) || (destFormat === 'ocsf' ? 'network_activity' : null);
  const cls = name ? INDEX.classes[name] : null;
  if (!cls) return null;
  const catUid = cls.category_uid ?? (cls.uid < OCSF_CATEGORY_ARITHMETIC_CEILING ? Math.floor(cls.uid / 1000) : null);
  const activity = (cls.enums.activity_id || []).join('/');
  const objectAttrs = (cls.objectAttrs || []).map(o => o.name).slice(0, 30).join(', ');
  return [
    `OCSF ${INDEX.version} — ${cls.caption} (class_uid=${cls.uid}, category_uid=${catUid}). Emit exactly this class.`,
    `Required: ${cls.required.join(', ')}.`,
    `Recommended: ${cls.recommended.slice(0, 20).join(', ')}.`,
    `Object attributes (use dotted dest paths into them, e.g. src_endpoint.ip, metadata.product.name): ${objectAttrs}.`,
    activity ? `activity_id legal values: ${activity} (0=Unknown, 99=Other).` : '',
    `type_uid MUST equal class_uid*100 + activity_id (${cls.uid}*100 + activity_id). metadata.version='${INDEX.version}'.`,
    'time is epoch MILLISECONDS (number). *_id / port / bytes / count attributes are numbers, not strings.',
    'Only use attribute names from this class. Vendor-specific fields with no OCSF attribute go under unmapped.<field> — never as new top-level fields.',
    NON_BASE_STATUS_CLASS_UIDS.includes(cls.uid) ? '' : OCSF_STATUS_MAPPING_RULE,
    'Values must be valid Cribl eval expressions (no arrow functions, no ?? or ?.).',
  ].filter(Boolean).join('\n');
}

export function ocsfClassByUid(uid: number): string | null {
  return UID_TO_NAME[uid] || null;
}

/** Present = key exists with a meaningful value (non-empty object/array/string). */
function present(event: any, attr: string): boolean {
  const v = event?.[attr];
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// Cribl housekeeping / routing fields that ride alongside OCSF output but are NOT
// OCSF attributes — never flag these as unknown, or every live-preview event
// looks non-conformant. `unmapped`/`raw_data`/`observables` are real OCSF attrs
// (present in every class's type index), so they need no special-casing here.
const NON_OCSF_FIELDS = new Set([
  '_raw', '_time', '_metadata', '__criblEventType',
  'cribl_breaker', 'cribl_pipe', 'index', 'source', 'sourcetype', 'host',
]);

// OCSF types we can enforce a concrete JS shape for. string_t / json_t are left
// LENIENT (not counted) — a number coerced into a string_t field is harmless and
// flagging it would produce false positives; the interop bug we care about is the
// reverse (a numeric/boolean attr emitted as a string), which these types catch.
function typeIsEnforceable(ocsfType: string, isArray: boolean): boolean {
  if (isArray) return true;
  return ocsfType === 'integer_t' || ocsfType === 'long_t' || ocsfType === 'timestamp_t'
    || ocsfType === 'float_t' || ocsfType === 'boolean_t' || ocsfType === 'object_t';
}
function jsTypeMatches(value: any, ocsfType: string, isArray: boolean): boolean {
  if (isArray) return Array.isArray(value);
  switch (ocsfType) {
    case 'integer_t': case 'long_t': case 'timestamp_t': case 'float_t':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean_t':
      return typeof value === 'boolean';
    case 'object_t':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Phase 3 deep validation for ONE event against its class: JSON-type validity of
 * populated attributes (int/long/timestamp/float/boolean/object/array — the shapes
 * an OCSF consumer like Amazon Security Lake enforces) and detection of top-level
 * attributes that are not in the class schema at all. Nested-object *required*
 * checks are not done here — the object schemas (`/export/objects`) are not
 * vendored — but a wrong-shaped object (`metadata` as a string) IS caught as a
 * type violation.
 */
function deepCheckEvent(event: any, cls: OcsfClassDef): {
  typeChecked: number; typeValid: number; typeViolations: string[]; unknownAttrs: string[];
} {
  const types = cls.types || {};
  const arraySet = new Set(cls.arrays || []);
  let typeChecked = 0, typeValid = 0;
  const typeViolations: string[] = [];
  const unknownAttrs: string[] = [];

  // Type validity over populated, enforceable attributes.
  for (const [attr, ocsfType] of Object.entries(types)) {
    if (!present(event, attr)) continue;
    const isArray = arraySet.has(attr);
    if (!typeIsEnforceable(ocsfType, isArray)) continue;
    typeChecked++;
    if (jsTypeMatches(event[attr], ocsfType, isArray)) typeValid++;
    else typeViolations.push(`${attr} (${isArray ? 'array of ' : ''}${ocsfType})`);
  }

  // Unknown top-level attributes (only meaningful when we have the type index).
  if (Object.keys(types).length) {
    for (const key of Object.keys(event)) {
      if (NON_OCSF_FIELDS.has(key)) continue;
      if (!(key in types)) unknownAttrs.push(key);
    }
  }
  return { typeChecked, typeValid, typeViolations, unknownAttrs };
}

export interface OcsfSchemaScore {
  supported: boolean;
  score: number;
  detectedClass: string | null;
  classUid: number | null;
  fromClassUid: boolean;   // true = class read from output; false = hinted from destFormat
  reasons: string[];
  unknownAttrs: string[];   // top-level attributes not in the detected class schema (advisory)
  checks: {
    requiredPresent: number; requiredTotal: number;
    enumValid: number; enumChecked: number;
    recommendedPresent: number; recommendedTotal: number;
    typeUidConsistent: boolean | null;
    typeValid: number; typeChecked: number;   // Phase 3: JSON-type conformance
  };
}

function scoreOneEvent(event: any, cls: OcsfClassDef): {
  score: number; reqP: number; reqT: number; enumV: number; enumC: number; recP: number; recT: number; typeOk: boolean | null;
  typeV: number; typeC: number; typeViolations: string[]; unknownAttrs: string[];
} {
  const reqT = cls.required.length;
  const reqP = cls.required.filter(a => present(event, a)).length;
  const recT = cls.recommended.length;
  const recP = cls.recommended.filter(a => present(event, a)).length;

  // Enum validity: among coded attributes that ARE populated, how many hold a
  // value that is a legal enum key. Absent enum attrs are not penalized here
  // (missing-required is already counted above).
  let enumV = 0, enumC = 0;
  for (const [attr, keys] of Object.entries(cls.enums)) {
    if (!present(event, attr)) continue;
    enumC++;
    if (keys.includes(String(event[attr]))) enumV++;
  }

  // type_uid == class_uid * 100 + activity_id, when all three are present.
  let typeOk: boolean | null = null;
  if (present(event, 'type_uid') && present(event, 'activity_id')) {
    typeOk = Number(event.type_uid) === cls.uid * 100 + Number(event.activity_id);
  }

  // Phase 3: JSON-type validity + unknown-attribute detection.
  const deep = deepCheckEvent(event, cls);

  const reqScore = reqT ? reqP / reqT : 1;
  const recScore = recT ? recP / recT : 1;
  const enumScore = enumC ? enumV / enumC : 1;
  let raw = 0.6 * reqScore + 0.25 * enumScore + 0.15 * recScore;
  if (typeOk === false) raw *= 0.85;   // real class, wrong type_uid math
  // Type conformance is a multiplicative factor scaled to at most a 10% haircut:
  // an all-correctly-typed event (typeScore=1) is ×1.0, so existing scores are
  // unchanged; a numeric/object attr emitted as a string shaves points. Unknown
  // attributes do NOT affect the score (advisory only — OCSF allows extension via
  // `unmapped`, and penalizing vendor-specific carry-over would be unfair).
  const typeScore = deep.typeChecked ? deep.typeValid / deep.typeChecked : 1;
  raw *= (0.9 + 0.1 * typeScore);
  return {
    score: Math.round(100 * raw), reqP, reqT, enumV, enumC, recP, recT, typeOk,
    typeV: deep.typeValid, typeC: deep.typeChecked, typeViolations: deep.typeViolations, unknownAttrs: deep.unknownAttrs,
  };
}

/**
 * Score mapped OCSF events against the vendored OCSF schema.
 * `destFormatHint` (e.g. 'ocsf#cloud_audit') is used only to pick a class when
 * an event carries no class_uid. Returns { supported:false } when no OCSF class
 * can be identified at all, so the caller can fall back to its other lenses.
 */
export function scoreOcsfAgainstSchema(outputEvents: any[], destFormatHint?: string): OcsfSchemaScore {
  const na: OcsfSchemaScore = {
    supported: false, score: 0, detectedClass: null, classUid: null, fromClassUid: false,
    reasons: [], unknownAttrs: [],
    checks: { requiredPresent: 0, requiredTotal: 0, enumValid: 0, enumChecked: 0, recommendedPresent: 0, recommendedTotal: 0, typeUidConsistent: null, typeValid: 0, typeChecked: 0 },
  };
  const events = (outputEvents || []).filter(e => e && typeof e === 'object');
  if (!events.length) return na;

  const hintClass = destFormatHint ? classForKey(destFormatHint) : null;

  // Aggregate per-event, detecting each event's class from its own class_uid.
  let sum = 0, n = 0, fromUidCount = 0;
  const agg = { reqP: 0, reqT: 0, enumV: 0, enumC: 0, recP: 0, recT: 0, typeV: 0, typeC: 0 };
  let typeUidConsistent: boolean | null = null;
  let detectedClass: string | null = null;
  let classUid: number | null = null;
  const typeViolations = new Set<string>();
  const unknownAttrs = new Set<string>();

  for (const ev of events) {
    const uid = present(ev, 'class_uid') ? Number(ev.class_uid) : NaN;
    let clsName: string | null = Number.isFinite(uid) ? UID_TO_NAME[uid] || null : null;
    const fromUid = !!clsName;
    if (!clsName) clsName = hintClass;   // no valid class_uid → use the guess
    if (!clsName) continue;
    const cls = INDEX.classes[clsName];
    if (!cls) continue;
    if (fromUid) fromUidCount++;
    if (!detectedClass) { detectedClass = clsName; classUid = cls.uid; }

    const r = scoreOneEvent(ev, cls);
    sum += r.score; n++;
    agg.reqP += r.reqP; agg.reqT += r.reqT; agg.enumV += r.enumV; agg.enumC += r.enumC; agg.recP += r.recP; agg.recT += r.recT;
    agg.typeV += r.typeV; agg.typeC += r.typeC;
    for (const v of r.typeViolations) typeViolations.add(v);
    for (const u of r.unknownAttrs) unknownAttrs.add(u);
    if (r.typeOk !== null) typeUidConsistent = (typeUidConsistent === false) ? false : r.typeOk;
  }

  if (!n) return na;   // nothing identifiable as OCSF → let caller fall back
  const score = Math.round(sum / n);
  const fromClassUid = fromUidCount >= n / 2;   // majority carried their own class_uid
  const unknownList = [...unknownAttrs];

  const reasons: string[] = [];
  const label = detectedClass ? `${detectedClass} (${classUid})` : 'OCSF';
  if (!fromClassUid) {
    reasons.push(`Output carries no class_uid — scored against hinted class ${label}. Valid OCSF requires class_uid/type_uid.`);
  }
  const missingReq = agg.reqT - agg.reqP;
  if (missingReq > 0) {
    reasons.push(`Missing ${missingReq}/${agg.reqT} required ${label} attributes across events.`);
  }
  if (agg.enumC && agg.enumV < agg.enumC) {
    reasons.push(`${agg.enumC - agg.enumV}/${agg.enumC} coded values are not valid OCSF enum members.`);
  }
  if (typeUidConsistent === false) reasons.push('type_uid does not equal class_uid × 100 + activity_id.');
  if (agg.typeC && agg.typeV < agg.typeC) {
    const eg = [...typeViolations].slice(0, 4).join(', ');
    reasons.push(`${agg.typeC - agg.typeV}/${agg.typeC} populated attributes have the wrong JSON type${eg ? ` (${eg})` : ''} — OCSF consumers reject numeric/object fields sent as strings.`);
  }
  if (unknownList.length) {
    reasons.push(`${unknownList.length} attribute(s) not in the ${label} schema: ${unknownList.slice(0, 6).join(', ')}${unknownList.length > 6 ? '…' : ''} — carry vendor-specific data under \`unmapped\`.`);
  }
  if (!reasons.length) {
    reasons.push(`Valid ${label}: ${agg.reqP}/${agg.reqT} required + ${agg.recP}/${agg.recT} recommended attributes present, enums + ${agg.typeC} types valid.`);
  }
  // Advisory only (no score effect, after the verdict line): `status` must be the status_id caption.
  const rawStatus = events.filter(isNonCaptionOcsfStatus);
  if (rawStatus.length) {
    reasons.push(`${rawStatus.length}/${events.length} event(s) carry a raw vendor value in \`status\` (e.g. "${String(rawStatus[0].status).slice(0, 40)}") — OCSF \`status\` is the status_id caption (Success/Failure/Other/Unknown); put the vendor word in \`status_detail\`.`);
  }

  return {
    supported: true, score, detectedClass, classUid, fromClassUid, reasons, unknownAttrs: unknownList,
    checks: {
      requiredPresent: agg.reqP, requiredTotal: agg.reqT,
      enumValid: agg.enumV, enumChecked: agg.enumC,
      recommendedPresent: agg.recP, recommendedTotal: agg.recT,
      typeUidConsistent,
      typeValid: agg.typeV, typeChecked: agg.typeC,
    },
  };
}

// --- Phase 3: ground + repair ------------------------------------------------
// The oracle (above) MEASURES gaps; grounding CLOSES the ones that are honestly
// derivable from the schema, before the pipeline is deployed and scored. We only
// fix values the schema (or OCSF's own arithmetic) makes unambiguous — we never
// invent semantic content (a missing activity_id, user, or a coerced enum) that
// would mask a real extraction gap and game the score. All three repairs are
// self-guarding: absent class_uid → the assignment is a no-op, so appending this
// eval to a non-OCSF pipeline is harmless.

// OCSF invariant: type_uid = class_uid * 100 + activity_id (universal, all classes)
// and category_uid = floor(class_uid / 1000) — but the latter holds ONLY for the
// standard 4-digit class_uids; 7 Windows-extension classes (class_uid >= 200000)
// break it, so category_uid derivation is guarded to class_uid < 100000. Verified
// against config/ocsf-classes.json (v1.9.0): 0 violations below 100000.
const OCSF_CATEGORY_ARITHMETIC_CEILING = 100000;

export interface OcsfGroundingOptions {
  /** Fallback metadata.product.name when the mapping left it empty. */
  productName?: string;
  /** Fallback metadata.product.vendor_name when the mapping left it empty. */
  vendorName?: string;
}

// Epoch-ms normaliser for `time`. Cribl eval has NO global isNaN/isFinite/
// parseInt (they evaluate to undefined, verified live) — only Number.isFinite.
// Seconds (< 1e11) are scaled to ms; ISO strings go through Date; anything
// unparseable falls back to the event's own _time.
// A zero/negative value (`Number(_time || 0)`) is not a real event time either.
const OCSF_TIME_MS = "typeof time == 'number' && Number.isFinite(time) && time > 0 ? (time < 100000000000 ? Math.round(time * 1000) : Math.round(time))"
  + " : (time != null && time !== '' && Number.isFinite(Number(time)) && Number(time) > 0 ? (Number(time) < 100000000000 ? Math.round(Number(time) * 1000) : Math.round(Number(time)))"
  + " : (time != null && time !== '' && typeof time != 'number' && Number.isFinite(new Date(String(time)).getTime()) ? new Date(String(time)).getTime()"
  + " : (_time != null && Number(_time) > 0 ? Math.round(Number(_time) * 1000) : time)))";

/** True when `status` is a populated value that is not a base status caption. */
export function isNonCaptionOcsfStatus(event: any): boolean {
  const uid = Number(event?.class_uid);
  if (!Number.isFinite(uid) || NON_BASE_STATUS_CLASS_UIDS.includes(uid)) return false;
  const st = event?.status;
  if (st == null || st === '' || typeof st === 'object') return false;
  return !Object.values(OCSF_STATUS_CAPTIONS).includes(String(st));
}

function quoteLiteral(v: string): string {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Append a deterministic schema-grounding eval to an OCSF pipeline (Copilot /
 * schematizer or AI mapping output) so the schema-derivable required attributes
 * are correct before deploy/score. Returns the (possibly extended) function list
 * plus the names of the fields it grounds. It only ADDS an eval at the very end,
 * so a Copilot cleanup/keep step cannot strip the grounded values, and every
 * entry is gated on class_uid so a non-OCSF event passes through untouched.
 *
 * Cribl semantics this relies on (verified live): entries run in order; a dotted
 * name is DROPPED when its parent object is missing, so `metadata` is created
 * before `metadata.version`; assigning `undefined` removes the field.
 */
export function groundOcsfPipeline(functions: any[], opts: OcsfGroundingOptions = {}): { functions: any[]; added: string[] } {
  const fns = Array.isArray(functions) ? functions : [];
  const isOcsf = "class_uid != null && class_uid !== ''";
  const add: { name: string; value: string }[] = [
    // AI mappers often emit the ids as strings ('4001'); OCSF types them integer_t.
    {
      name: 'class_uid',
      value: `${isOcsf} && Number.isFinite(Number(class_uid)) ? Number(class_uid) : class_uid`,
    },
    {
      name: 'activity_id',
      value: `activity_id != null && activity_id !== '' && Number.isFinite(Number(activity_id)) ? Number(activity_id) : activity_id`,
    },
    // severity_id is required; 0 (Unknown) is the schema's own honest value
    // when the source carries no severity.
    {
      name: 'severity_id',
      value: `${isOcsf} ? (severity_id != null && severity_id !== '' && Number.isFinite(Number(severity_id)) ? Number(severity_id) : 0) : severity_id`,
    },
    // category_uid = floor(class_uid/1000) for standard classes; leave extension
    // classes (>= 100000) and class-less events untouched.
    {
      name: 'category_uid',
      value: `class_uid != null && Number(class_uid) < ${OCSF_CATEGORY_ARITHMETIC_CEILING} ? Math.floor(Number(class_uid) / 1000) : category_uid`,
    },
    // type_uid = class_uid*100 + activity_id whenever both are present (universal).
    {
      name: 'type_uid',
      value: 'class_uid != null && activity_id != null ? Number(class_uid) * 100 + Number(activity_id) : type_uid',
    },
    // metadata is a required object; create it so the dotted writes below land.
    {
      name: 'metadata',
      value: `${isOcsf} ? (metadata && typeof metadata == 'object' ? metadata : {}) : metadata`,
    },
    // The version we validate against ALWAYS wins: AI mappers copy '1.4.0' /
    // '1.1.0' from stale docs, which mislabels the payload for consumers.
    {
      name: 'metadata.version',
      value: `${isOcsf} ? '${OCSF_SCHEMA_VERSION}' : (metadata && metadata.version)`,
    },
  ];
  if (opts.productName || opts.vendorName) {
    add.push({
      name: 'metadata.product',
      value: `${isOcsf} ? (metadata.product && typeof metadata.product == 'object' ? metadata.product : {}) : (metadata && metadata.product)`,
    });
    if (opts.productName) {
      add.push({
        name: 'metadata.product.name',
        value: `metadata && metadata.product ? (metadata.product.name || ${quoteLiteral(opts.productName)}) : undefined`,
      });
    }
    if (opts.vendorName) {
      add.push({
        name: 'metadata.product.vendor_name',
        value: `metadata && metadata.product ? (metadata.product.vendor_name || ${quoteLiteral(opts.vendorName)}) : undefined`,
      });
    }
  }
  // time is a required timestamp_t (epoch ms).
  add.push({ name: 'time', value: `${isOcsf} ? (${OCSF_TIME_MS}) : time` });
  // `status` is the CAPTION of status_id, not the vendor's word. Mappers copy the
  // raw value ("Finished", "Denied") into it; that raw value belongs in
  // status_detail. Only when status_id is a base enum member (0/1/2/99) — the
  // caption is then unambiguous — and status_detail is still empty.
  const sid = 'status_id';
  const isBaseStatus = `[${NON_BASE_STATUS_CLASS_UIDS.join(', ')}].indexOf(Number(class_uid)) < 0`
    + ` && (${sid} === 0 || ${sid} === 1 || ${sid} === 2 || ${sid} === 99)`;
  add.push(
    {
      name: 'status_id',
      value: `${isOcsf} && ${sid} != null && ${sid} !== '' && Number.isFinite(Number(${sid})) ? Number(${sid}) : ${sid}`,
    },
    {
      name: 'status_detail',
      value: `${isOcsf} && ${isBaseStatus} && status != null && status !== '' && typeof status != 'object'`
        + ` && ${OCSF_STATUS_CAPTION_LIST}.indexOf(String(status)) < 0 && (status_detail == null || status_detail === '')`
        + ' ? String(status) : status_detail',
    },
    {
      name: 'status',
      value: `${isOcsf} && ${isBaseStatus} ? (${sid} === 1 ? 'Success' : ${sid} === 2 ? 'Failure' : ${sid} === 99 ? 'Other' : 'Unknown') : status`,
    },
    // raw_data is a string_t: a mapper that hands it the parsed object ships JSON.
    {
      name: 'raw_data',
      value: `${isOcsf} && raw_data != null && typeof raw_data != 'string' ? JSON.stringify(raw_data) : raw_data`,
    },
  );
  const grounded = {
    id: 'eval',
    description: `OCSF schema grounding (P3): derive ids, create metadata, stamp metadata.version=${OCSF_SCHEMA_VERSION}, normalise time`,
    conf: { add },
  };
  return { functions: [...fns, grounded], added: add.map(a => a.name) };
}
