// OCSF output structure for the AI field-map path and the final output shape for
// every OCSF mapping (packtester audit 2026-10-02).
//
// Two independent jobs, both pure functions over Cribl function lists:
//
// 1. structureOcsfMappingFields — the AI mapper emits flat `{name,value}` adds
//    with dotted OCSF names (`src_endpoint.ip`, `metadata.product.name`). Cribl
//    DROPS a dotted add whose parent object does not exist, so 43 AI-mapped packs
//    shipped without metadata / endpoints. We create every parent first (snapshot
//    any source field of the same name so expressions still read the source),
//    pin the class to the one the build targeted, and prune parents that stayed
//    empty.
//
// 2. buildOcsfOutputShaping — an OCSF event is only the class's attributes. Every
//    mapping left the parser's flat vendor fields alongside them (no pack used
//    `unmapped`). The shaping folds whatever is not an OCSF attribute (and was not
//    already consumed by the mapping) into `unmapped`, coerces numeric attributes,
//    and strips everything else with a keep-list.
//
// Cribl eval semantics relied on (verified live, see CLAUDE.md gotchas): adds run
// in order; assigning `undefined` removes a field but leaves `x.y = undefined`
// as a key, so emptiness is tested with JSON.stringify(x) == '{}'; `??` and the
// globals isNaN/isFinite/parseInt are unavailable — use Number.isFinite.
import { ocsfArrayAttributes, ocsfAttributeTypes, ocsfClassByUid, ocsfClassNameForKey, ocsfClassUidForKey } from './ocsf-schema';
import { buildOcsfLeftoverRescue, isOcsfRescueFn } from './ocsf-rescue';
import { WINDOWS_OCSF_DISPATCH_CLASSES, WINDOWS_OCSF_DISPATCH_FIELDS } from './source-recognition';

export interface EvalAdd { name: string; value: string }
interface Fn { id: string; description?: string; filter?: string; disabled?: boolean; conf?: any }

// String literals AND regex literals are opaque: an identifier rewrite must not
// turn `/relay|via/` into `/gfsrc_tmp_relay|via/`. A `/` starts a regex only
// where an operand is expected (after an operator, `(`, `,` or the start).
const QUOTE_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|(?<=(?:^|[(,=:[!&|?{};+\-*%<>~^])\s*)\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[dgimsuy]*/g;

export function stripQuoted(s: string): string {
  return s.replace(QUOTE_RE, '');
}

/** Same length as `s`, with every string/regex literal blanked — positions stay valid. */
export function maskQuoted(s: string): string {
  return s.replace(QUOTE_RE, m => '_'.repeat(m.length));
}

/** Whole-word, quote-aware identifier rewrite (never touches string literals). */
export function replaceIdent(expr: string, from: string, to: string): string {
  const quoteRe = new RegExp(QUOTE_RE.source, 'g');
  const wordRe = new RegExp(`(?<![.\\w$])${from.replace(/[$]/g, '\\$')}\\b`, 'g');
  let out = '', last = 0, mm: RegExpExecArray | null;
  while ((mm = quoteRe.exec(expr)) !== null) {
    out += expr.slice(last, mm.index).replace(wordRe, to);
    out += mm[0];
    last = quoteRe.lastIndex;
  }
  return out + expr.slice(last).replace(wordRe, to);
}

function readsIdent(expr: string, name: string): boolean {
  return new RegExp(`(?<![.\\w$])${name}\\b`).test(stripQuoted(expr));
}

// An expression that clearly yields an object (so a mapped "parent" scalar is
// really an object assignment and must not be replaced by `{}`).
function isObjectExpr(expr: string): boolean {
  const e = expr.trim();
  return /^\{/.test(e) || /^\(\s*\{/.test(e) || /^JSON\.parse\(/.test(e) || /^Object\.assign\(/.test(e);
}

const TEMP_PREFIX = 'gfsrc_tmp_';

function emptyGuard(path: string): string {
  // a.b.c → a && a.b && a.b.c && typeof a.b.c == 'object' && JSON.stringify(a.b.c) == '{}'
  const parts = path.split('.');
  const chain = parts.map((_, i) => parts.slice(0, i + 1).join('.'));
  return `${chain.join(' && ')} && typeof ${path} == 'object' && !Array.isArray(${path}) && JSON.stringify(${path}) == '{}'`;
}

/** Class uids an expression can produce (literal integers that are real classes). */
export function classUidsInExpr(expr: string): number[] {
  const out = new Set<number>();
  for (const m of stripQuoted(String(expr)).match(/\b\d{1,6}\b/g) || []) {
    const n = Number(m);
    if (ocsfClassByUid(n)) out.add(n);
  }
  return [...out];
}

export interface StructuredOcsfMapping {
  /** Runs BEFORE the mapping adds: source snapshots + parent-object creation. */
  pre: Fn[];
  /** The mapping adds, rewritten (snapshot reads, `|| ''` → `|| undefined`, class pin). */
  fields: EvalAdd[];
  /** Runs AFTER the mapping adds: prune parents that stayed empty. */
  post: Fn[];
  notes: string[];
}

/**
 * Make an AI OCSF mapping structurally valid in Cribl (see header). `destFormat`
 * is the concretized key the build targeted (`ocsf#dns`); its class wins over an
 * AI-chosen literal class_uid, except for the Base Event fallback where the AI's
 * (valid) class is the better signal.
 */
export function structureOcsfMappingFields(input: EvalAdd[], destFormat: string): StructuredOcsfMapping {
  const notes: string[] = [];
  let fields = input.map(f => ({ ...f }));

  // --- class pin -----------------------------------------------------------
  // The AI often emits class_uid twice (classInfo AND a mapping row) and the last
  // add wins in Cribl — collapse to ONE, pinned to the targeted class.
  const hintUid = ocsfClassUidForKey(destFormat);
  const hintIsBase = hintUid === 0 || destFormat === 'ocsf';
  const classFields = fields.filter(f => f.name === 'class_uid');
  const literalOf = (v: string) => (/^\s*'?\d+'?\s*$/.test(v) ? Number(v.replace(/'/g, '')) : null);
  let classField = classFields[classFields.length - 1];
  if (classFields.length > 1) {
    fields = fields.filter(f => f.name !== 'class_uid' || f === classField);
    notes.push(`${classFields.length} class_uid adds collapsed to one`);
  }
  const literalUid = classField ? literalOf(classField.value) : null;
  if (hintUid != null && !hintIsBase) {
    if (!classField) {
      classField = { name: 'class_uid', value: String(hintUid) };
      fields.unshift(classField);
      notes.push(`class_uid missing → ${hintUid}`);
    } else if (literalUid !== hintUid && (literalUid != null || classUidsInExpr(classField.value).every(u => u !== hintUid))) {
      notes.push(`class_uid ${classField.value} → ${hintUid} (build targets ${destFormat})`);
      classField.value = String(hintUid);
      // category_uid / type_uid follow class_uid (re-derived by grounding); drop stale literals.
      fields = fields.filter(f => f.name !== 'category_uid' && !(f.name === 'type_uid' && literalOf(f.value) != null));
    }
  } else if (classField && literalUid != null && !ocsfClassByUid(literalUid)) {
    // Not a real class: fall back to Base Event rather than emit an unknown uid.
    classField.value = '0';
    fields = fields.filter(f => f.name !== 'category_uid' && !(f.name === 'type_uid' && literalOf(f.value) != null));
    notes.push(`class_uid ${literalUid} is not an OCSF class → 0 (Base Event)`);
  }
  // Class-describing strings must agree with the pinned class; grounding does not
  // re-derive them, so drop literal captions from a different class.
  if (notes.some(n => /→ \d+/.test(n))) {
    fields = fields.filter(f => !/^(class_name|category_name|type_name)$/.test(f.name) || !/^\s*'/.test(f.value));
  }
  // String-quoted numeric ids from classInfo ('4001') → numbers.
  // Cribl routing metadata is not event data: the AI sometimes copies it into
  // `unmapped` (`unmapped.sourcetype`), next to the top-level field the shaping keeps.
  const meta = fields.filter(f => /^unmapped\.(sourcetype|source|index)$/.test(f.name));
  if (meta.length) {
    fields = fields.filter(f => !meta.includes(f));
    notes.push(`dropped ${meta.map(f => f.name).join(', ')} (routing metadata, kept top-level)`);
  }
  for (const f of fields) {
    if (/^(class_uid|category_uid|activity_id|type_uid|severity_id|status_id)$/.test(f.name) && /^'\d+'$/.test(f.value.trim())) {
      f.value = f.value.trim().slice(1, -1);
    }
  }

  // --- empty-string fallbacks ---------------------------------------------
  // `x || ''` would emit an empty attribute; `|| undefined` leaves it absent.
  for (const f of fields) f.value = f.value.replace(/\|\|\s*(''|"")\s*$/, '|| undefined');

  // --- parents -------------------------------------------------------------
  const parentSet = new Set<string>();
  for (const f of fields) {
    const parts = f.name.split('.');
    for (let i = 1; i < parts.length; i++) parentSet.add(parts.slice(0, i).join('.'));
  }
  // A parent that is ALSO mapped as a leaf: keep it when the expression yields an
  // object (it becomes the parent, ordered first); otherwise the scalar would make
  // every child add drop — move it to unmapped.<name>.
  const objectParents = new Set<string>();
  for (const f of fields) {
    if (!parentSet.has(f.name)) continue;
    if (isObjectExpr(f.value)) {
      objectParents.add(f.name);
    } else {
      notes.push(`scalar ${f.name} moved to unmapped.${f.name.replace(/\./g, '_')} (it is a parent object)`);
      f.name = `unmapped.${f.name.replace(/\./g, '_')}`;
      parentSet.add('unmapped');
    }
  }
  const parents = [...parentSet].sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));

  // Snapshot top-level parents that expressions READ (a source field of the same
  // name, e.g. a JSON source's `user` or `metadata`), then rewrite those reads.
  const pre: Fn[] = [];
  const topParents = parents.filter(p => !p.includes('.') && !objectParents.has(p));
  const snap: EvalAdd[] = [];
  for (const p of topParents) {
    if (!fields.some(f => readsIdent(f.value, p))) continue;
    const tmp = `${TEMP_PREFIX}${p}`;
    snap.push({ name: tmp, value: p });
    for (const f of fields) f.value = replaceIdent(f.value, p, tmp);
  }
  if (snap.length) pre.push({ id: 'eval', description: 'Snapshot source fields that share an OCSF parent name', conf: { add: snap } });

  // Object-valued parent leaves go first (in their own order), then `{}` inits for
  // the rest, shallow-first, so every dotted add below finds its parent.
  const objectLeafAdds = fields.filter(f => objectParents.has(f.name));
  fields = fields.filter(f => !objectParents.has(f.name));
  const inits: EvalAdd[] = [];
  for (const p of parents) {
    if (objectParents.has(p)) continue;
    // A nested parent under an object-valued leaf may already exist — keep it.
    inits.push({ name: p, value: `${p.includes('.') ? `${p.split('.').slice(0, -1).join('.')} && ` : ''}${p} && typeof ${p} == 'object' && !Array.isArray(${p}) ? ${p} : {}` });
  }
  if (objectLeafAdds.length || inits.length) {
    pre.push({ id: 'eval', description: 'Create OCSF parent objects (dotted names need an existing parent)', conf: { add: [...objectLeafAdds, ...inits] } });
  }

  // --- prune empty parents (deepest first) ----------------------------------
  // Leaves whose expression can yield '' (`user != '-' ? user : ''`) → absent.
  const emptyLeaves = fields
    .filter(f => /''|""/.test(f.value) && !f.name.startsWith('unmapped.'))
    .map(f => {
      const parts = f.name.split('.');
      const guard = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.') + ' && ').join('');
      return { name: f.name, value: `${guard}${f.name} === '' ? undefined : ${parts.length > 1 ? `(${guard}${f.name})` : f.name}` };
    });
  const prune = [...emptyLeaves, ...[...parents].reverse().map(p => ({ name: p, value: `${emptyGuard(p)} ? undefined : ${p}` }))];
  const post: Fn[] = prune.length
    ? [{ id: 'eval', description: 'Drop OCSF objects that stayed empty', conf: { add: prune } }]
    : [];
  return { pre, fields, post, notes };
}

// --- output shaping ----------------------------------------------------------

// Always kept on an OCSF event besides the class attributes (Cribl routing /
// destination metadata). `_raw` is not here: the OCSF event IS the payload.
const ROUTING_KEEP = ['_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe'];
// Never folded into `unmapped`: housekeeping, scratch and the original-raw copy.
const NEVER_UNMAPPED = ['_raw', '_time', 'index', 'source', 'sourcetype', 'host', 'log_time',
  'cribl*', '__*', `${TEMP_PREFIX}*`, 'future_use*', 'pg_original_raw_copy', 'unmapped', 'raw_data'];
// OCSF attributes every class requires/derives — kept even when the mapping
// itself did not name them (grounding adds them).
const ALWAYS_OCSF = ['class_uid', 'category_uid', 'type_uid', 'activity_id', 'severity_id', 'metadata', 'time'];

const NUMERIC_TYPES = new Set(['integer_t', 'long_t', 'float_t', 'timestamp_t', 'port_t']);
// Nested OCSF leaves that are numeric in the object schemas (not vendored — the
// class index only types top-level attributes). Matched on the LAST path segment.
const NESTED_NUMERIC_LEAF = /^(port|pid|ppid|bytes|bytes_in|bytes_out|packets|packets_in|packets_out|code|count|size|lease_dur|[a-z_]+_id)$/;

export interface OcsfShapingInput {
  /** The mapping-stage functions (their eval add names/values are inspected). */
  mappingFns: Fn[];
  /** Concretized dest key (`ocsf#network`) — its class joins the class set. */
  destFormat: string;
  /** Keep the copied original raw for the raw_data attribute (ocsf_keep_raw). */
  keepOriginalRaw?: boolean;
}

export interface OcsfShaping {
  functions: Fn[];
  kept: string[];
  classNames: string[];
}

function evalAdds(fns: Fn[]): EvalAdd[] {
  const out: EvalAdd[] = [];
  for (const f of fns || []) {
    if (!f || f.disabled || f.id !== 'eval') continue;
    for (const a of f.conf?.add || []) if (a && typeof a.name === 'string') out.push({ name: a.name, value: String(a.value ?? '') });
  }
  return out;
}

/**
 * Final OCSF shape: fold non-OCSF leftovers into `unmapped`, coerce numeric
 * attributes, strip everything else. Classified as optimization-stage functions
 * (a json serialize + a keep/remove eval) by splitPipelineFunctions.
 */
export function buildOcsfOutputShaping(input: OcsfShapingInput): OcsfShaping {
  const adds = evalAdds(input.mappingFns);
  const classNames = new Set<string>();
  const hint = ocsfClassNameForKey(input.destFormat) || (input.destFormat === 'ocsf' ? 'network_activity' : null);
  if (hint) classNames.add(hint);
  for (const a of adds) {
    if (a.name !== 'class_uid') continue;
    for (const uid of classUidsInExpr(a.value)) { const n = ocsfClassByUid(uid); if (n) classNames.add(n); }
  }
  // The Windows dispatcher picks the class PER EVENT (__ocsf_class_uid): a Security
  // channel build targets ocsf#authentication, but its 4688/4663/7045 events are
  // Process / File / Service activity. Keeping only one class's attributes folded
  // those events' typed objects into unmapped (audit 2026-10-12).
  const winDispatch = adds.some(a => /(?<![\w$])__ocsf_class_uid\b/.test(a.value));
  if (winDispatch) for (const uid of WINDOWS_OCSF_DISPATCH_CLASSES) { const n = ocsfClassByUid(uid); if (n) classNames.add(n); }
  if (!classNames.size) classNames.add('base_event');
  const types = ocsfAttributeTypes([...classNames]);
  const arrays = ocsfArrayAttributes([...classNames]);

  const isScratch = (n: string) => n.startsWith('__') || n.startsWith(TEMP_PREFIX) || n === '_time' || n === '_raw'
    || ROUTING_KEEP.includes(n) || n === 'log_time' || n === 'pg_original_raw_copy';
  // name → does it have dotted children / an object-valued expression?
  const top = new Map<string, { dotted: boolean; objectExpr: boolean }>();
  for (const a of adds) {
    if (isScratch(a.name)) continue;
    const t = a.name.split('.')[0];
    const cur = top.get(t) || { dotted: false, objectExpr: false };
    if (a.name.includes('.')) cur.dotted = true;
    else if (isObjectExpr(a.value) || /^\[/.test(a.value.trim())) cur.objectExpr = true;
    top.set(t, cur);
  }
  const kept = new Set<string>(ALWAYS_OCSF);
  for (const [name, info] of top) {
    if (name === 'unmapped') continue;
    const t = types[name];
    if (!t) continue;                                              // not an OCSF attribute → unmapped
    if (t === 'object_t' && !arrays.has(name) && !info.dotted && !info.objectExpr) continue;   // scalar into an object attr
    kept.add(name);
  }
  // Source fields the mapping already consumed are represented by the attributes
  // they fed — do not duplicate them into unmapped. Only fields read WHOLE: a
  // nested source object read through one sub-path (`requestParameters.bucket`)
  // still carries the rest of its data, so it stays eligible for unmapped.
  const bare = new Set<string>(), dotted = new Set<string>();
  for (const a of adds) {
    for (const ref of stripQuoted(a.value).match(/(?<![.\w$])[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g) || []) {
      const base = ref.split('.')[0];
      (ref.includes('.') ? dotted : bare).add(base);
    }
  }
  // `__e['id.orig_h']` reads are consumption too (stripQuoted blanks the key).
  // Not reads that only copy into `unmapped.*`: the rescue may still type those.
  // A flat dotted key cannot be excluded by a serialize pattern (`id.orig_h` is a
  // path there), so it is dropped from unmapped after the fold instead.
  const quotedFlat: string[] = [];
  for (const a of adds) {
    if (/^unmapped(\.|$)/.test(a.name)) continue;
    for (const m of String(a.value).matchAll(/__e\[\s*(['"])([^'"\\]+)\1\s*\]/g)) {
      if (m[2].includes('.')) quotedFlat.push(m[2]); else bare.add(m[2]);
    }
  }
  const consumed = new Set([...bare].filter(b => !dotted.has(b)));
  for (const k of kept) consumed.delete(k);
  const dropFlat = [...new Set(quotedFlat)].filter(k => !kept.has(k.split('.')[0]));
  const exclude = [...new Set([...kept, ...NEVER_UNMAPPED])].flatMap(k => (k.endsWith('*') ? [`!${k}`] : [`!${k}`, `!${k}.*`]));
  const consumedEx = [...consumed].filter(c => !kept.has(c) && !/^(String|Number|Math|Date|Boolean|JSON|RegExp|Object|Array|undefined|null|true|false|typeof|new|C)$/.test(c)).map(c => `!${c}`);

  const coerce: EvalAdd[] = [];
  for (const k of kept) {
    const t = types[k];
    if (!t || !NUMERIC_TYPES.has(t) || arrays.has(k)) continue;
    coerce.push({ name: k, value: `${k} != null && ${k} !== '' && typeof ${k} != 'number' && Number.isFinite(Number(${k})) ? Number(${k}) : ${k}` });
  }
  const nested = new Set<string>();
  for (const a of adds) {
    if (!a.name.includes('.') || isScratch(a.name)) continue;
    const parts = a.name.split('.');
    if (!kept.has(parts[0]) || !NESTED_NUMERIC_LEAF.test(parts[parts.length - 1]) || parts[parts.length - 1] === 'uid') continue;
    nested.add(a.name);
  }
  for (const p of nested) {
    const parts = p.split('.');
    const guard = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.')).join(' && ');
    coerce.push({ name: p, value: `${guard} && ${p} != null && ${p} !== '' && typeof ${p} != 'number' && Number.isFinite(Number(${p})) ? Number(${p}) : (${guard} ? ${p} : undefined)` });
  }

  const keep = [
    ...ROUTING_KEEP,
    ...[...kept, 'unmapped', 'raw_data'].flatMap(k => [k, `${k}.*`]),
  ];
  if (input.keepOriginalRaw) keep.push('pg_original_raw_copy');
  const functions: Fn[] = [
    {
      id: 'serialize',
      filter: 'true',
      description: 'OCSF: capture non-OCSF fields for unmapped',
      conf: { type: 'json', dstField: '__ocsf_left', fields: [...exclude, ...consumedEx, '*'] },
    },
    {
      id: 'eval',
      description: 'OCSF: fold leftovers into unmapped, type numeric attributes, keep only OCSF attributes',
      conf: {
        add: [
          { name: 'unmapped', value: `__ocsf_left && __ocsf_left != '{}' ? Object.assign((unmapped && typeof unmapped == 'object' && !Array.isArray(unmapped)) ? unmapped : {}, JSON.parse(__ocsf_left)${dropFlat.length ? `, {${dropFlat.map(k => `'${k.replace(/'/g, "\\'")}': undefined`).join(', ')}}` : ''}) : unmapped` },
          ...coerce,
        ],
        // Exact names: wildcard removal skips `__*`, and the dispatcher's staging
        // fields are not part of any OCSF event.
        remove: ['__ocsf_left', '*', ...(winDispatch ? WINDOWS_OCSF_DISPATCH_FIELDS : [])],
        keep,
      },
    },
    // Well-known leftovers (pid, user, Zeek id.orig_h…) into their typed attribute.
    ...buildOcsfLeftoverRescue([...classNames]),
  ];
  return { functions, kept: [...kept], classNames: [...classNames] };
}

/** Is this one of the shaping functions (so callers can avoid re-adding it)? */
export function isOcsfShapingFn(fn: Fn): boolean {
  return !!fn && ((fn.id === 'serialize' && fn.conf?.dstField === '__ocsf_left')
    || (fn.id === 'eval' && Array.isArray(fn.conf?.remove) && fn.conf.remove.includes('__ocsf_left'))
    || isOcsfRescueFn(fn));
}

// --- dead-field prune (OCSF only) --------------------------------------------
// An OCSF event is the class attributes plus `unmapped`. Two kinds of eval adds
// never reach the attributes and only pad `unmapped` (cisco_esa, 2026-10-03: 20
// functions, 13 keys in unmapped, most of them copies):
//  - the generic schematizer alias eval: `src_ip = src_ip || source__ip || …` is
//    a no-op when the parser produces none of the synonyms;
//  - a parser's aliases for ANOTHER model (CIM `src_user = sender`, `app = 'Cisco
//    ESA'`): a copy of a field that ships anyway, a constant, or a value derived
//    only from fields the mapping already carries into OCSF.
// Pruned from the DEPLOYED list only, never from the stage lists: the extraction
// golden is shared with CIM builds, which need those aliases.

const SCHEMATIZER_ALIAS_DESC = /Alias Copilot\/schematizer/i;
const JS_GLOBALS = new Set(['String', 'Number', 'Math', 'Date', 'Boolean', 'JSON', 'RegExp', 'Object', 'Array',
  'undefined', 'null', 'true', 'false', 'typeof', 'new', 'in', 'instanceof', 'void', 'C', 'NaN', 'Infinity']);
const IDENT_RE = /(?<![.\w$])[A-Za-z_$][A-Za-z0-9_$]*/g;
// `a || b || undefined` — a pure copy of whichever field is set.
const COPY_CHAIN_RE = /^\(?\s*[A-Za-z_$][\w$]*(?:\s*(?:\|\||\?\?)\s*(?:[A-Za-z_$][\w$]*|''|""))*\s*\)?$/;
// Function ids that set only the fields their conf names. Anything else (code,
// lookup, rename, a serde without a field list…) can produce arbitrary names.
const NON_PRODUCING = new Set(['drop', 'comment', 'regex_filter', 'sampling', 'dynamic_sampling', 'suppress', 'mask', 'auto_timestamp']);

function identsIn(text: string): string[] {
  return [...new Set((text.match(IDENT_RE) || []).filter(i => !JS_GLOBALS.has(i)))];
}

/** Field names the functions provably produce, or null when one could produce any name. */
export function staticallyProducedFields(fns: Fn[]): Set<string> | null {
  const out = new Set<string>();
  for (const f of fns || []) {
    if (!f || f.disabled) continue;
    const conf = f.conf || {};
    if (f.id === 'eval') { for (const a of conf.add || []) if (a?.name) out.add(String(a.name)); continue; }
    if (f.id === 'regex_extract') {
      const rxs = [conf.regex, ...(conf.regexList || []).map((r: any) => r?.regex)].filter(r => typeof r === 'string');
      for (const rx of rxs) {
        for (const m of rx.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)) {
          if (/^_?_?(NAME|VALUE)_\d+$/.test(m[1])) return null;   // dynamic key/value pairs
          out.add(m[1]);
        }
      }
      continue;
    }
    if (f.id === 'serde' || f.id === 'serialize') {
      if (conf.dstField) out.add(String(conf.dstField));
      if (f.id === 'serde' && !(Array.isArray(conf.fields) && conf.fields.length && conf.fields.every((x: string) => !/[*!]/.test(x)))) return null;
      for (const x of conf.fields || []) out.add(String(x));
      continue;
    }
    if (!NON_PRODUCING.has(f.id)) return null;
  }
  return out;
}

export interface OcsfPruneInput { extractionFns: Fn[]; mappingFns: Fn[]; destFormat: string }
export interface OcsfPruneResult { extractionFns: Fn[]; mappingFns: Fn[]; removed: string[] }

const isLiteralTruthy = (v: string) => /^\s*(?:'[^']+'|"[^"]+")\s*$/.test(v);
const isUnfiltered = (f: Fn) => f.filter == null || f.filter === '' || f.filter === 'true';

/**
 * Drop the eval adds an OCSF build cannot ship (see above), then any eval left
 * with nothing to do. Pure: returns new lists; the inputs are not mutated.
 */
export function pruneOcsfDeadFields(input: OcsfPruneInput): OcsfPruneResult {
  const cloneFn = (f: Fn): Fn => (f?.id === 'eval' && Array.isArray(f.conf?.add) ? { ...f, conf: { ...f.conf, add: [...f.conf.add] } } : f);
  const ext = (input.extractionFns || []).map(cloneFn);
  const map = (input.mappingFns || []).map(cloneFn);
  const all = [...ext, ...map];
  const removed: string[] = [];
  // The attributes the shaping keeps top-level, from the UNPRUNED mapping (as
  // the deployed shaping is): pruning changes what lands in `unmapped`, never
  // which OCSF attributes ship.
  const shaping = buildOcsfOutputShaping({ mappingFns: input.mappingFns || [], destFormat: input.destFormat });

  // 1. Schematizer aliases: keep an assignment only when a synonym is produced.
  const ai = all.findIndex(f => f?.id === 'eval' && SCHEMATIZER_ALIAS_DESC.test(String(f.description || '')));
  const produced = ai >= 0 ? staticallyProducedFields(all.slice(0, ai)) : null;
  if (ai >= 0 && produced) {
    const fn = all[ai];
    fn.conf.add = fn.conf.add.filter((a: EvalAdd) => {
      const live = String(a.value).split('||').map(t => t.trim()).some(t => t !== a.name && produced.has(t));
      if (!live) removed.push(a.name);
      return live;
    });
  }

  // 2. Dead copies/constants/derivations, to a fixpoint (removing one add can
  //    leave the add it read unread).
  const keptTop = new Set([...shaping.kept, ...ROUTING_KEEP, ...NEVER_UNMAPPED.filter(n => !n.endsWith('*'))]);
  const isProtected = (n: string) => n.includes('.') || keptTop.has(n) || n.startsWith('__') || n.startsWith(TEMP_PREFIX) || n.startsWith('cribl');
  // A chain `product || vendor_product` never reads past a field already set
  // unconditionally to a non-empty literal (the mapping's vendor eval).
  const readText = (value: string, upTo: number) => {
    let t = stripQuoted(String(value ?? ''));
    for (let k = 0; k < upTo; k++) {
      const f = all[k];
      if (f?.id !== 'eval' || f.disabled || !isUnfiltered(f)) continue;
      for (const a of f.conf.add || []) {
        if (!a?.name || !isLiteralTruthy(String(a.value))) continue;
        t = t.replace(new RegExp(`(?<![.\\w$])(${a.name.replace(/[$]/g, '\\$')})(?:\\s*\\|\\|\\s*[A-Za-z_$][\\w$]*)+(?![\\w$.(])`, 'g'), '$1');
      }
    }
    return t;
  };
  const fnText = (k: number, fromAdd = 0): string[] => {
    const f = all[k];
    if (!f || f.disabled) return [];
    if (f.id !== 'eval') return [stripQuoted(String(f.filter ?? '')), JSON.stringify(f.conf ?? {})];
    return (f.conf?.add || []).slice(fromAdd).map((a: EvalAdd) => readText(a.value, k));
  };
  for (let changed = true; changed;) {
    changed = false;
    const consumed = new Set<string>();
    for (let k = ext.length; k < all.length; k++) for (const t of fnText(k)) for (const i of identsIn(t)) consumed.add(i);
    for (let k = 0; k < all.length; k++) {
      const f = all[k];
      if (f?.id !== 'eval' || f.disabled || !Array.isArray(f.conf?.add)) continue;
      for (let j = f.conf.add.length - 1; j >= 0; j--) {
        const a = f.conf.add[j];
        const name = String(a?.name || '');
        if (!name || isProtected(name)) continue;
        const value = stripQuoted(String(a.value ?? '')).trim();
        const ids = identsIn(value);
        const isCopy = COPY_CHAIN_RE.test(value);
        const identity = isCopy && ids.length > 0 && ids.every(i => i === name);
        if (!identity) {
          const later = [...fnText(k, j + 1), ...all.slice(k + 1).flatMap((_, d) => [stripQuoted(String(all[k + 1 + d]?.filter ?? '')), ...fnText(k + 1 + d)])];
          if (later.some(t => new RegExp(`(?<![.\\w$])${name.replace(/[$]/g, '\\$')}\\b`).test(t))) continue;
          const preserved = (i: string) => i !== '_raw' && !i.startsWith('__') && !i.startsWith(TEMP_PREFIX);
          const dead = ids.length === 0
            || (isCopy && ids.every(preserved))
            || (!isCopy && ids.every(i => preserved(i) && consumed.has(i)));
          if (!dead) continue;
        }
        f.conf.add.splice(j, 1);
        removed.push(name);
        changed = true;
      }
    }
  }

  const live = (f: Fn) => !(f?.id === 'eval' && Array.isArray(f.conf?.add) && f.conf.add.length === 0
    && !(f.conf.remove?.length) && !(f.conf.keep?.length));
  return { extractionFns: all.slice(0, ext.length).filter(live), mappingFns: all.slice(ext.length).filter(live), removed };
}
