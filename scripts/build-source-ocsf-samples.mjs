#!/usr/bin/env node
/**
 * Per-SOURCE OCSF sample capture (plan Task 8).
 *
 * The OCSF sample library was nine hand-authored per-CLASS documents
 * (`config/ocsf-samples/ocsf_network.json`, …). That is enough to answer "is
 * this OCSF field ever populated for this class", and not enough to answer the
 * question the qualification gate (Task 4c) actually asks of a VENDOR-scoped
 * rule: `resolveSampleEventsForRule` narrows the library with
 * `eventMatchesSource(ev, rule.source)`, which reads
 * `metadata.product.vendor_name` — and no curated per-class document carries a
 * Fortinet vendor name, so `network::fortinet` could only ever come back
 * `unmeasurable` for want of a sample rather than on merit (plan Task 4d).
 *
 * So: for every catalog sourcetype that has a WORKING `destFormat: 'ocsf'`
 * golden path, run that path against the sourcetype's own real/vendor sample and
 * capture the resulting OCSF events to `config/ocsf-samples/by-source/`.
 *
 * A maintainer tool, like scripts/harvest-vendor-samples.mjs: run by hand,
 * never at request time.
 *
 * WHY AN OFFLINE EMULATOR, AND WHAT IT COSTS
 *
 * The app scores a pipeline by POSTing it to the LIVE Cribl preview API — that
 * is ground truth, and it is not available to a script that must run on a
 * checkout with no org, no worker group and no deployed pack. So this script
 * runs the REAL function list (`buildPack(...).pipelineConf.functions` — the
 * exported entry point, never a re-implementation of pipeline assembly) through
 * a local emulator of the eight Cribl function types those pipelines use.
 *
 * The emulation is therefore an APPROXIMATION of the live preview, and the
 * approximation is made VISIBLE rather than averaged away (Hard Rule 32 — a
 * measurement that failed must never look like one that succeeded):
 *
 *   - `unsupportedFeatures()` scans the real function list BEFORE running it. A
 *     pipeline that needs anything we do not emulate — a `code` function, a
 *     `C.Text.parseWinEvent` call — is NOT captured with the fields we managed
 *     to produce. It is recorded as `unmapped` with reason
 *     `emulation-unsupported` naming the feature, because a half-emulated
 *     Windows event would look like a real capture that simply had few fields.
 *   - `no-sample`, `no-golden-path`, `sample-format-mismatch` and
 *     `no-output` are DISTINCT reasons. "We could not measure this" and "we
 *     measured this and it produced nothing" are different facts.
 *
 * WHY NOT `emulateParse` IN src/sample-library.ts
 *
 * That function exists and overlaps: it also walks `regex_extract`/`serde`/alias
 * `eval` chains offline. It is deliberately NOT reused, and not extended to
 * cover this, for two reasons. Its POLICY is opposite: it computes a
 * conservative FLOOR for counting extracted fields ("whatever we measure is a
 * floor, so a zero here must never be reported as a failure") and marks itself
 * `partial` rather than evaluating an eval it does not understand — which is
 * right for admitting a sample and wrong for reproducing output. And it lives in
 * a SANITIZER-REACHABLE module (Hard Rules 25/29): adding a `with`-scoped
 * expression evaluator, a lookup table reader and a flatten/rename implementation
 * there would move the sanitizer fingerprint, force a dist republish, and ship
 * an expression evaluator into an app whose whole claim is that it cannot do
 * anything with the data it is given.
 *
 * Usage:
 *   npm run ocsf:samples                 # capture + rewrite by-source/ and its index
 *   npm run ocsf:samples -- --dry-run    # print the summary, write nothing
 *   npm run ocsf:samples -- --only cisco_asa,fortinet_fortigate
 *   npm run ocsf:samples -- --offline    # committed stores only (no samples-pool reads)
 *   npm run ocsf:samples -- --verbose    # per-sourcetype outcome for every row
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPack, getSupportedSourcetypeCatalog, canonicalizeSourcetype,
  hasGoldenFormatPath, goldenPathMatchesSample, concretizeOcsfFormat,
  getCefVendorInfo,
} from '../src/pack-builder.ts';
import { sampleMatchesSourceExpectation } from '../src/source-recognition.ts';
import { resolveReferenceSample, resolveFallbackSample } from './reference-api.mjs';
import { getLookupsForSourcetype } from './lookup-bundler.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function vendorSlugFor(sourcetype) {
  const st = canonicalizeSourcetype(sourcetype);
  const { vendor } = getCefVendorInfo(st);
  if (vendor === st.replace(/_/g, ' ')) return 'generic';
  return String(vendor || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'generic';
}

export const OUT_DIR = 'config/ocsf-samples/by-source';
/**
 * Authored raw-event mixes used only by this capture, so a vendor-scoped
 * qualification rule can see the cases it claims to filter (FortiGate PING
 * accept vs HTTPS/DNS). Synthetic on purpose — must NEVER enter the harvested
 * samples pool (Hard Rule 30). First-candidate when present, because the pool
 * line is production-shaped and often lacks those cases.
 */
export const SOURCE_FIXTURES_DIR = 'config/ocsf-samples/source-fixtures';
/**
 * A DISTINCT manifest from `config/ocsf-samples/index.json`. That file's readers
 * expect the curated per-class shape (`class_uid`/`label`/`file`); this one
 * carries a different shape and, crucially, an `unmapped` list — mixing them
 * would either corrupt the curated index or be silently ignored by its reader.
 * Same "new shape, new manifest" discipline as the optimization-rule index
 * (scripts/qualify-ocsf-optimization-rule.mjs).
 */
export const OUT_INDEX = `${OUT_DIR}/index.json`;

/** Events kept per captured document. Three is the plan's ceiling (Task 8). */
export const MAX_EVENTS_PER_SOURCE = 3;

/**
 * The seeded `_time` for every emulated event, so two runs of this script
 * produce byte-identical documents. A live preview would stamp ingest time; a
 * committed artifact that changed on every run would make `git diff` useless for
 * reviewing what a pipeline change did to the output. Sources that derive
 * `_time` from their own sample timestamp overwrite it anyway.
 * 2023-11-14T22:13:20Z.
 */
export const SEEDED_TIME_SEC = 1700000000;

/**
 * Cribl transport fields, stripped from a captured event so the document holds
 * the OCSF payload and nothing else — the shape the curated per-class documents
 * are in, and the shape `qualifyOptimizationRule` reads. Leaving `_time` in
 * would also put a seeded constant into the universal-cleanup candidate field
 * enumeration, where it would read as a real OCSF leaf.
 */
export const TRANSPORT_FIELDS = ['_time', '_raw', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe'];

export const UNMAPPED_REASONS = {
  NO_SAMPLE: 'no-sample',
  NO_GOLDEN_PATH: 'no-golden-path',
  SAMPLE_FORMAT_MISMATCH: 'sample-format-mismatch',
  EMULATION_UNSUPPORTED: 'emulation-unsupported',
  BUILD_FAILED: 'build-failed',
  NO_OUTPUT: 'no-output',
};

// ── The emulator ────────────────────────────────────────────────────────────

/** The Cribl function types an OCSF golden pipeline is built from. */
export const SUPPORTED_FUNCTION_IDS = new Set([
  'comment', 'eval', 'drop', 'lookup', 'regex_extract', 'serde', 'flatten', 'rename',
]);

/**
 * Cribl `C.*` runtime helpers we can reproduce. Empty ON PURPOSE: every one of
 * them is a Cribl-internal implementation (`C.Text.parseWinEvent` parses EVTX
 * XML into a shape only Cribl defines), and guessing its semantics would produce
 * OCSF events that look real and are not. A pipeline that needs one is reported
 * `emulation-unsupported`, not captured.
 */
export const SUPPORTED_C_HELPERS = new Set();

const C_HELPER_RE = /\bC\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;

/**
 * The FortiGate parser's `code` function only copies `FTNTFGT*` CEF vendor
 * keys to the unprefixed name. Native KVP has none of those keys, so this is
 * a no-op there; CEF-wrapped FortiGate needs it. Either way the body is a
 * closed, local transformation — unlike `C.Text.parseWinEvent`. Arbitrary
 * `code` functions stay `emulation-unsupported`.
 */
export function isFtntPrefixStripCode(fn) {
  const conf = fn?.conf || {};
  const body = Array.isArray(conf.code) ? conf.code.join('\n') : String(conf.code || '');
  return /startsWith\(\s*['"]FTNTFGT['"]\s*\)/.test(body) && /slice\(\s*7\s*\)/.test(body);
}

export function applyFtntPrefixStrip(ev) {
  for (const key of Object.keys(ev)) {
    if (!key.startsWith('FTNTFGT')) continue;
    const clean = key.slice(7);
    if (ev[clean] === undefined || ev[clean] === '') ev[clean] = ev[key];
    delete ev[key];
  }
}

/**
 * Everything in this function list the emulator cannot reproduce, as stable
 * sorted ids. A `disabled` function is skipped: it does not run in Cribl either,
 * so its features cost nothing (every golden reduction `drop` ships disabled).
 */
export function unsupportedFeatures(functions) {
  const out = new Set();
  for (const fn of functions || []) {
    if (!fn || fn.disabled === true) continue;
    if (fn.id === 'code' && isFtntPrefixStripCode(fn)) continue;
    if (!SUPPORTED_FUNCTION_IDS.has(fn.id)) { out.add(`function:${fn.id}`); continue; }
    const text = `${JSON.stringify(fn.conf || {})} ${String(fn.filter || '')}`;
    for (const m of text.matchAll(C_HELPER_RE)) {
      if (!SUPPORTED_C_HELPERS.has(m[0])) out.add(m[0]);
    }
    if (fn.id === 'serde' && fn.conf?.mode && fn.conf.mode !== 'extract') out.add(`serde:${fn.conf.mode}`);
  }
  return [...out].sort();
}

const EVAL_GLOBALS = {
  Object, Array, String, Number, Boolean, Math, JSON, Date, RegExp,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
};

/**
 * The scope a Cribl eval expression is evaluated in. `has: () => true` is the
 * load-bearing part: a Cribl eval over a SPARSE event reads an absent field as
 * `undefined` rather than throwing, and `src_ip || source__ip || client__ip`
 * (the golden alias chains) depends on exactly that. Without it every chain
 * would ReferenceError on its first absent alias and the whole add would be lost.
 */
function makeScope(ev) {
  return new Proxy(ev, {
    has: () => true,
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === '__e') return target;
      if (prop in target) return target[prop];
      if (prop in EVAL_GLOBALS) return EVAL_GLOBALS[prop];
      return undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

const exprCache = new Map();

/**
 * Evaluate one Cribl expression against an event. `undefined` on any throw —
 * the same "a broken expression adds nothing" outcome Cribl produces, and the
 * same convention as `safeEvalFilter` in pack-builder.ts.
 *
 * `with` is a SyntaxError in strict mode; a `new Function` body is sloppy even
 * though this module is an ESM (strict) module, which is the only reason the
 * bare-identifier scope works at all.
 */
export function evalExpr(expr, ev) {
  const src = String(expr);
  let fn = exprCache.get(src);
  if (!fn) {
    try { fn = new Function('__scope', `with (__scope) { return (${src}); }`); }
    catch { fn = () => undefined; }
    exprCache.set(src, fn);
  }
  try { return fn(makeScope(ev)); } catch { return undefined; }
}

function filterPasses(fn, ev) {
  const f = fn.filter;
  if (f === undefined || f === null) return true;
  const s = String(f).trim();
  if (s === '' || s === 'true') return true;
  return !!evalExpr(s, ev);
}

/**
 * Set a (possibly dotted) field, with Cribl's own semantics:
 *   - an `undefined` value is NOT added;
 *   - a dotted add whose PARENT object is absent is DROPPED, not auto-created.
 * The second rule is why the golden nested branch pre-creates every parent with
 * a conditional `(guard) ? {} : undefined` (see `buildGoldenFormatMapping`).
 * Auto-creating parents here would put objects in the output that the real
 * pipeline leaves out, and the captured sample would over-report coverage.
 */
export function setEventPath(ev, path, value) {
  if (value === undefined) return false;
  const parts = String(path).split('.');
  let cur = ev;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next === null || typeof next !== 'object') return false;
    cur = next;
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

const globRe = (pat) => new RegExp(`^${String(pat).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);

/**
 * Cribl's `remove`/`keep` on an eval function: remove by glob, `keep` wins. A
 * keep entry of `src_endpoint.*` also protects the parent `src_endpoint` — the
 * golden keep-list carries both spellings, and honouring only the exact one
 * would delete every nested OCSF object the moment the final `remove: ['*']`
 * cleanup ran.
 */
function applyRemoveKeep(ev, conf) {
  const removes = Array.isArray(conf.remove) ? conf.remove : [];
  if (!removes.length) return;
  const keeps = Array.isArray(conf.keep) ? conf.keep : [];
  const rm = removes.map(globRe);
  const kp = keeps.map(globRe);
  for (const key of Object.keys(ev)) {
    if (!rm.some(re => re.test(key))) continue;
    if (kp.some(re => re.test(key))) continue;
    if (keeps.some(k => String(k).startsWith(`${key}.`))) continue;
    delete ev[key];
  }
}

/** `/body/flags` (how a pipeline conf stores a regex) or a bare pattern. */
export function parseCriblRegex(spec) {
  if (spec instanceof RegExp) return spec;
  const s = String(spec ?? '');
  if (!s) return null;
  const m = s.match(/^\/([\s\S]*)\/([a-z]*)$/);
  try { return m ? new RegExp(m[1], m[2]) : new RegExp(s); } catch { return null; }
}

function applyRegexExtract(ev, conf) {
  const text = ev[String(conf.source || '_raw')];
  if (typeof text !== 'string') return;
  const names = Array.isArray(conf.fieldNames) ? conf.fieldNames : [];
  const specs = [conf.regex, ...(Array.isArray(conf.regexList) ? conf.regexList : [])].filter(Boolean);
  for (const spec of specs) {
    const re = parseCriblRegex(spec);
    if (!re) continue;
    const iterations = Math.max(1, Number(conf.iterations) || 1);
    const global = re.flags.includes('g');
    let remaining = iterations;
    let m;
    if (global) {
      re.lastIndex = 0;
      while (remaining-- > 0 && (m = re.exec(text)) !== null) {
        assignMatch(ev, m, names);
        if (m[0] === '') re.lastIndex++;
      }
    } else if ((m = text.match(re)) !== null) {
      assignMatch(ev, m, names);
    }
  }
}

function assignMatch(ev, m, fieldNames) {
  for (const [k, v] of Object.entries(m.groups || {})) {
    if (v !== undefined) ev[k] = v;
  }
  for (let i = 0; i < fieldNames.length; i++) {
    const v = m[i + 1];
    if (fieldNames[i] && v !== undefined) ev[fieldNames[i]] = v;
  }
}

/** Split on `delim`, honouring `quote` — the tokenizer both kvp and csv need. */
export function splitQuoted(text, delim, quote) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote && ch === quote) { inQuote = !inQuote; cur += ch; continue; }
    if (!inQuote && ch === delim) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const unquote = (s) => {
  const t = String(s).trim();
  return (t.length > 1 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))))
    ? t.slice(1, -1) : t;
};

export function parseKvpText(text, conf = {}) {
  const fieldDelim = conf.delimChar === undefined ? ' ' : String(conf.delimChar);
  const pairDelim = conf.pairDelim === undefined ? '=' : String(conf.pairDelim);
  const quote = conf.quoteChar === undefined ? '"' : String(conf.quoteChar);
  const out = {};
  for (const token of splitQuoted(text, fieldDelim, quote)) {
    const at = token.indexOf(pairDelim);
    if (at <= 0) continue;
    const key = token.slice(0, at).trim();
    if (!key) continue;
    out[key] = unquote(token.slice(at + pairDelim.length));
  }
  return out;
}

export function parseCsvRow(text, conf = {}) {
  const fields = Array.isArray(conf.fields) ? conf.fields : [];
  if (!fields.length) return null;
  const delim = conf.delimChar === undefined ? ',' : String(conf.delimChar);
  const quote = conf.quoteChar === undefined ? '"' : String(conf.quoteChar);
  const cells = splitQuoted(text, delim, quote);
  const out = {};
  for (let i = 0; i < fields.length && i < cells.length; i++) {
    if (fields[i]) out[fields[i]] = unquote(cells[i]);
  }
  return out;
}

/**
 * Cribl's "Clean Fields" on a kvp/csv serde: non-accessor characters become `_`.
 * Applied to kvp/csv only, never to a json serde — Hard Rule 2 is about exactly
 * those two (a hyphenated kvp key breaks Cribl's property-accessor build), and
 * cleaning JSON keys would silently rename real nested object keys.
 */
const cleanFieldName = (k) => String(k).replace(/[^A-Za-z0-9_]/g, '_');

function applySerde(ev, conf) {
  const text = ev[String(conf.srcField || '_raw')];
  if (typeof text !== 'string') return;
  const type = String(conf.type || 'json');
  let obj = null;
  if (type === 'json') {
    try { obj = JSON.parse(text); } catch { obj = null; }
  } else if (type === 'kvp') {
    obj = parseKvpText(text, conf);
  } else if (type === 'csv') {
    obj = parseCsvRow(text, conf);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const clean = type !== 'json' && conf.cleanFields !== false;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    ev[clean ? cleanFieldName(k) : k] = v;
  }
}

function* flattenEntries(value, prefix, delim, depth) {
  if (depth <= 0 || value === null || typeof value !== 'object') { yield [prefix, value]; return; }
  for (const [k, v] of Object.entries(value)) {
    yield* flattenEntries(v, `${prefix}${delim}${k}`, delim, depth - 1);
  }
}

function applyFlatten(ev, conf) {
  const delim = conf.delimiter === undefined ? '_' : String(conf.delimiter);
  const depth = Number(conf.depth) || 5;
  const prefix = conf.prefix === undefined ? '' : String(conf.prefix);
  const fields = (Array.isArray(conf.fields) && conf.fields.length) ? conf.fields : Object.keys(ev);
  for (const f of fields) {
    const v = ev[f];
    if (v === null || typeof v !== 'object') continue;
    delete ev[f];
    for (const [path, leaf] of flattenEntries(v, `${prefix}${f}`, delim, depth)) {
      if (leaf !== undefined) ev[path] = leaf;
    }
  }
}

function applyRename(ev, conf) {
  const explicit = Array.isArray(conf.rename) ? conf.rename : [];
  const base = Array.isArray(conf.baseFields) ? conf.baseFields : [];
  const expr = conf.renameExpr ? String(conf.renameExpr) : '';
  const keys = base.length ? base : Object.keys(ev);
  for (const key of keys) {
    if (!(key in ev)) continue;
    let next = key;
    const hit = explicit.find(r => r?.currentName === key);
    if (hit?.newName) next = String(hit.newName);
    else if (expr) {
      // The rename expression's context is `name`/`value`, NOT the event — a
      // Cribl rename expression cannot read other fields.
      const r = evalExpr(expr, { name: key, value: ev[key] });
      if (typeof r === 'string' && r) next = r;
    }
    if (next === key) continue;
    ev[next] = ev[key];
    delete ev[key];
  }
}

/** Parse a lookup CSV into row objects. Header row names the columns. */
export function parseLookupCsv(content) {
  const lines = String(content || '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const header = splitQuoted(lines[0], ',', '"').map(unquote);
  return lines.slice(1).map(line => {
    const cells = splitQuoted(line, ',', '"').map(unquote);
    const row = {};
    for (let i = 0; i < header.length; i++) if (header[i]) row[header[i]] = cells[i];
    return row;
  });
}

function applyLookup(ev, conf, tables) {
  const table = tables[String(conf.file || '')];
  if (!table) return;
  const inFields = Array.isArray(conf.inFields) ? conf.inFields : [];
  if (!inFields.length) return;
  const ci = conf.ignoreCase === true;
  const norm = (v) => (ci ? String(v).toLowerCase() : String(v));
  const row = table.find(r => inFields.every(f => {
    const a = ev[f.eventField];
    const b = r[f.lookupField || f.eventField];
    return a !== undefined && b !== undefined && norm(a) === norm(b);
  }));
  if (!row) return;
  const outs = Array.isArray(conf.outFields) ? conf.outFields : [];
  if (outs.length) {
    for (const o of outs) {
      const v = row[o.lookupField];
      if (v !== undefined && v !== '') setEventPath(ev, o.eventField || o.lookupField, v);
    }
    return;
  }
  const inNames = new Set(inFields.map(f => f.lookupField || f.eventField));
  for (const [k, v] of Object.entries(row)) {
    if (!inNames.has(k) && v !== undefined && v !== '') ev[k] = v;
  }
}

/**
 * Run a real Cribl function list over raw sample lines, offline.
 *
 * Returns `{ events, unsupported, droppedCount }`. `unsupported` is computed
 * STATICALLY from the function list (see `unsupportedFeatures`), so a caller can
 * refuse to capture BEFORE reading the output — the output of a pipeline we
 * could only half-run is the thing that must not be mistaken for a measurement.
 */
export function emulatePipeline(functions, rawEvents, opts = {}) {
  const fns = Array.isArray(functions) ? functions : [];
  const tables = opts.lookups || {};
  const unsupported = unsupportedFeatures(fns);
  const events = [];
  let droppedCount = 0;

  for (const raw of (rawEvents || [])) {
    const line = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const ev = { _raw: line, _time: SEEDED_TIME_SEC };
    let dropped = false;
    for (const fn of fns) {
      if (!fn || fn.disabled === true || fn.id === 'comment') continue;
      if (fn.id === 'code') {
        if (isFtntPrefixStripCode(fn) && filterPasses(fn, ev)) applyFtntPrefixStrip(ev);
        continue;
      }
      if (!SUPPORTED_FUNCTION_IDS.has(fn.id)) continue;
      if (!filterPasses(fn, ev)) continue;
      const conf = fn.conf || {};
      if (fn.id === 'drop') { dropped = true; break; }
      if (fn.id === 'eval') {
        for (const add of (Array.isArray(conf.add) ? conf.add : [])) {
          // An add with an EMPTY name is evaluated for its side effect only —
          // `Object.assign(__e, groups)` is how the golden ASA parser spreads a
          // regex's named groups onto the event.
          const value = evalExpr(add.value, ev);
          if (add.name) setEventPath(ev, add.name, value);
        }
        applyRemoveKeep(ev, conf);
      } else if (fn.id === 'regex_extract') applyRegexExtract(ev, conf);
      else if (fn.id === 'serde') applySerde(ev, conf);
      else if (fn.id === 'flatten') applyFlatten(ev, conf);
      else if (fn.id === 'rename') applyRename(ev, conf);
      else if (fn.id === 'lookup') applyLookup(ev, conf, tables);
      if (fn.final === true) break;
    }
    if (dropped) { droppedCount++; continue; }
    events.push(ev);
  }
  return { events, unsupported, droppedCount };
}

/** The OCSF payload of an emulated event: Cribl transport fields removed. */
export function toOcsfPayload(ev) {
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (TRANSPORT_FIELDS.includes(k)) continue;
    if (k.startsWith('__')) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** The dominant `class_uid` across captured events, or null when none carries one. */
export function dominantClassUid(events) {
  const tally = new Map();
  for (const ev of events) {
    const uid = Number(ev?.class_uid);
    if (!Number.isFinite(uid)) continue;
    tally.set(uid, (tally.get(uid) || 0) + 1);
  }
  if (!tally.size) return null;
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** The distinct `metadata.product.vendor_name` values the capture carries. */
export function vendorNamesIn(events) {
  const names = new Set();
  for (const ev of events) {
    const v = ev?.metadata?.product?.vendor_name;
    if (typeof v === 'string' && v.trim()) names.add(v.trim());
  }
  return [...names].sort();
}

// ── The capture pass ────────────────────────────────────────────────────────

const sampleText = (events) => (events || [])
  .map(e => (typeof e === 'string' ? e : JSON.stringify(e)))
  .join('\n');

/**
 * Capture one sourcetype, or say why not.
 *
 * `candidates` is an ORDERED list of `{ tier, payload }` — the app's own
 * resolution order. The first candidate whose wire format the golden parser
 * accepts is the one used, and a rejected higher-priority candidate is recorded
 * in `provenance.rejected`. That fallthrough is not coverage-greed: measured on
 * the real catalog, 6 of the 8 sourcetypes whose top-priority sample fails
 * `goldenPathMatchesSample` have a lower-tier sample that passes, and building
 * with the failing one does not produce an OCSF event at all — `buildPack` takes
 * the generic AI/compact-JSON branch instead, so the "capture" would be a
 * different schema entirely.
 */
export function captureSourcetype({ sourcetype, candidates, buildFunctions, lookupsFor, maxEvents = MAX_EVENTS_PER_SOURCE }) {
  const canonical = canonicalizeSourcetype(sourcetype);
  const rejected = [];
  let chosen = null;

  for (const cand of (candidates || [])) {
    const events = (cand?.payload?.available && Array.isArray(cand.payload.events)) ? cand.payload.events : [];
    if (!events.length) { rejected.push({ tier: cand?.tier || 'unknown', reason: UNMAPPED_REASONS.NO_SAMPLE }); continue; }
    const text = sampleText(events);
    if (!hasGoldenFormatPath(sourcetype, 'ocsf', text)) {
      rejected.push({ tier: cand.tier, reason: UNMAPPED_REASONS.NO_GOLDEN_PATH });
      continue;
    }
    if (!goldenPathMatchesSample(sourcetype, 'ocsf', text)) {
      rejected.push({
        tier: cand.tier,
        reason: UNMAPPED_REASONS.SAMPLE_FORMAT_MISMATCH,
        detail: `sampleMatchesSourceExpectation=${sampleMatchesSourceExpectation(sourcetype, text)}`,
      });
      continue;
    }
    chosen = { ...cand, events, text };
    break;
  }

  if (!chosen) {
    // Report the reason the BEST candidate failed on, not merely that nothing
    // worked: "no sample at all" and "a sample in the wrong wire format" are
    // different problems with different fixes.
    const reason = rejected.length ? rejected[0].reason : UNMAPPED_REASONS.NO_SAMPLE;
    return { ok: false, sourcetype, reason, rejected };
  }

  let functions;
  let destFormat;
  try {
    destFormat = concretizeOcsfFormat('ocsf', sourcetype, chosen.text);
    functions = buildFunctions(sourcetype, chosen.text);
  } catch (e) {
    return { ok: false, sourcetype, reason: UNMAPPED_REASONS.BUILD_FAILED, detail: e.message, rejected };
  }

  const unsupported = unsupportedFeatures(functions);
  if (unsupported.length) {
    return { ok: false, sourcetype, reason: UNMAPPED_REASONS.EMULATION_UNSUPPORTED, detail: unsupported.join(', '), rejected };
  }

  const tables = {};
  for (const l of (lookupsFor(sourcetype) || [])) tables[l.file] = parseLookupCsv(l.content);

  const run = emulatePipeline(functions, chosen.events, { lookups: tables });
  const payloads = run.events.map(toOcsfPayload).filter(p => Object.keys(p).length > 0);
  if (!payloads.length) {
    return {
      ok: false, sourcetype, reason: UNMAPPED_REASONS.NO_OUTPUT,
      detail: `${chosen.events.length} input event(s), ${run.droppedCount} dropped, 0 with OCSF fields`,
      rejected,
    };
  }

  const kept = payloads.slice(0, maxEvents);
  return {
    ok: true,
    sourcetype,
    doc: {
      key: canonical,
      sourcetype: canonical,
      classUid: dominantClassUid(kept),
      destFormat,
      source: vendorSlugFor(sourcetype),
      vendorNames: vendorNamesIn(kept),
      provenance: {
        samplePack: chosen.payload.pack || null,
        sampleName: chosen.payload.sampleName || null,
        tier: chosen.tier,
        sampleEvents: chosen.events.length,
        emulated: 'golden OCSF pipeline, offline emulation of scripts/build-source-ocsf-samples.mjs',
        rejected,
      },
      events: kept,
    },
  };
}

/**
 * The whole pass, over injected inputs. Pure: every I/O dependency
 * (`resolveCandidates`, `buildFunctions`, `lookupsFor`) arrives as a function,
 * so the test drives it with fixtures and never reaches disk or network.
 */
export async function collectCaptures({ catalog, resolveCandidates, buildFunctions, lookupsFor, maxEvents = MAX_EVENTS_PER_SOURCE, onRow }) {
  const captured = [];
  const unmapped = [];
  for (const entry of (catalog || [])) {
    const sourcetype = typeof entry === 'string' ? entry : entry?.name;
    if (!sourcetype) continue;
    const candidates = await resolveCandidates(sourcetype);
    const result = captureSourcetype({ sourcetype, candidates, buildFunctions, lookupsFor, maxEvents });
    if (result.ok) captured.push(result.doc);
    else unmapped.push({ sourcetype, reason: result.reason, detail: result.detail || null });
    if (onRow) onRow(result);
  }
  // Sorted so a re-run of the same inputs writes a byte-identical index.
  captured.sort((a, b) => a.key.localeCompare(b.key));
  unmapped.sort((a, b) => a.sourcetype.localeCompare(b.sourcetype));
  return { captured, unmapped };
}

export const docFileName = (key) => `${key.replace(/::/g, '__')}.json`;

export function buildBySourceIndex({ captured, unmapped, build, updatedAt }) {
  return {
    version: 1,
    build,
    updated_at: updatedAt,
    generated_by: 'scripts/build-source-ocsf-samples.mjs',
    samples: captured.map(d => ({
      key: d.key,
      sourcetype: d.sourcetype,
      class_uid: d.classUid,
      dest_format: d.destFormat,
      source: d.source,
      vendor_names: d.vendorNames,
      events: d.events.length,
      file: docFileName(d.key),
    })),
    unmapped,
  };
}

// ── Real inputs ─────────────────────────────────────────────────────────────

function readJson(relPath) {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8'));
}

/**
 * The app's own resolution order, as candidates. Tier 1 is exactly what a build
 * would use (`resolveReferenceSample` — the catalog lookup, the *nix/Windows
 * routers, the thin-sample swap); tier 2 is the fallback chain on its own, which
 * is where a source whose catalog sample is in the wrong wire format finds its
 * real one.
 */
export function loadSourceFixture(sourcetype) {
  const rel = `${SOURCE_FIXTURES_DIR}/${canonicalizeSourcetype(sourcetype)}.log`;
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) return null;
  const events = readFileSync(abs, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!events.length) return null;
  return {
    available: true,
    events,
    pack: 'source-fixture',
    sampleName: rel,
  };
}

export async function referenceCandidates(sourcetype) {
  const out = [];
  const fixture = loadSourceFixture(sourcetype);
  if (fixture) out.push({ tier: 'source-fixture', payload: fixture });
  const primary = await resolveReferenceSample(sourcetype, '');
  out.push({ tier: 'reference', payload: primary });
  const fallback = await resolveFallbackSample(String(sourcetype || '').toLowerCase().trim(), '');
  if (fallback?.available && fallback.sampleName !== primary?.sampleName) {
    out.push({ tier: 'fallback', payload: fallback });
  }
  return out;
}

/** The REAL function list for a sourcetype's OCSF pack — never re-assembled here. */
export function goldenOcsfFunctions(sourcetype, text) {
  const pack = buildPack({
    packName: `ocsf_sample_${sourcetype}`,
    displayName: sourcetype,
    sourceMode: 'reference',
    sampleEvents: text,
    destFormat: 'ocsf',
    destFormats: ['ocsf'],
    manualFormat: '',
    routeFilter: '',
    workerGroup: 'default',
  }, sourcetype, {}, true);
  return pack.pipelineConf?.functions || [];
}

export async function buildSourceOcsfSamplesRealInputs({ only, limit, onRow } = {}) {
  let catalog = getSupportedSourcetypeCatalog();
  if (only?.length) {
    const wanted = new Set(only.map(s => s.trim().toLowerCase()).filter(Boolean));
    catalog = catalog.filter(e => wanted.has(e.name.toLowerCase()));
  }
  if (limit) catalog = catalog.slice(0, limit);
  return await collectCaptures({
    catalog,
    resolveCandidates: referenceCandidates,
    buildFunctions: goldenOcsfFunctions,
    lookupsFor: getLookupsForSourcetype,
    onRow,
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    dryRun: flag('dry-run'),
    verbose: flag('verbose'),
    offline: flag('offline'),
    only: (value('only') || '').split(',').map(s => s.trim()).filter(Boolean),
    limit: Number(value('limit')) || 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // The samples pool is a network read (Hard Rule 30) — allowed for a
  // maintainer script, and the single biggest source of coverage here, since 153
  // sourcetypes with an OCSF golden path have no sample in a committed store.
  if (args.offline) process.env.SAMPLES_POOL_OFFLINE = '1';

  const { captured, unmapped } = await buildSourceOcsfSamplesRealInputs({
    only: args.only,
    limit: args.limit,
    onRow: args.verbose
      ? (r) => console.log(r.ok
        ? `[CAPTURED] ${r.sourcetype} — ${r.doc.events.length} event(s), class_uid=${r.doc.classUid}, vendor=${r.doc.vendorNames.join('/') || '-'}`
        : `[${r.reason}] ${r.sourcetype}${r.detail ? ` — ${r.detail}` : ''}`)
      : undefined,
  });

  const byReason = {};
  for (const u of unmapped) byReason[u.reason] = (byReason[u.reason] || 0) + 1;
  console.log(`\n${captured.length} captured, ${unmapped.length} unmapped`);
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${n}`);
  }
  const vendors = new Set(captured.flatMap(d => d.vendorNames));
  console.log(`  distinct vendor names: ${vendors.size}`);

  if (args.dryRun) {
    console.log('\n--dry-run — nothing written.');
    return;
  }
  if (args.only.length || args.limit) {
    // A filtered pass sees only part of the catalog, so writing the store would
    // delete every document the filter excluded. Same refusal as
    // `assertFullHarvest` in the samples-pool harvest (Hard Rule 30).
    console.log('\n--only/--limit is a REPORT-ONLY pass — the store is rewritten wholesale, so a '
      + 'partial run would delete every document outside the filter. Re-run without the filter to write.');
    return;
  }

  const build = Number(readJson('package.json').buildNumber || 0);
  const updatedAt = new Date().toISOString();
  const outDir = resolve(ROOT, OUT_DIR);
  // Rewritten WHOLESALE: a sourcetype that no longer captures must DISAPPEAR
  // from the store rather than linger as a stale document (Hard Rule 29).
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const doc of captured) {
    writeFileSync(resolve(outDir, docFileName(doc.key)), `${JSON.stringify(doc, null, 2)}\n`);
  }
  writeFileSync(resolve(ROOT, OUT_INDEX), `${JSON.stringify(buildBySourceIndex({ captured, unmapped, build, updatedAt }), null, 2)}\n`);
  console.log(`\nWrote ${captured.length} document(s) + index to ${OUT_DIR}/`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
