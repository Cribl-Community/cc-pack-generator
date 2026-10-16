import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRIBL_ORG, getToken, AI_MODEL as MODEL_ID, invokeModel } from './cribl-auth.mjs';
import { cleanSampleText } from './ai-samples.mjs';
import {
  getCachedSampleId, rememberSampleId, getCachedSampleContent,
  rememberSampleContent, invalidateSampleCache,
} from './sample-cache.mjs';
import { buildXsiamTagging } from '../src/pack-builder.ts';
import { goldenVariantSourcetype, resolveGoldenVariant, splitGoldenVariant } from '../src/golden-variant.ts';
import { isSourceWireFormat } from '../src/sample-format.ts';
import { planGoldenImport, planGoldenObservation, planGoldenWrite, storedTrustState } from '../src/golden-trust.ts';
import { nonSourceMappingGoldenReason, nonSourceMappingKeyReason } from '../src/golden-source-identity.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable only so a test can exercise the lesson gate (and the golden store
// boundary) without rewriting the committed store.
const LEARNINGS_PATH = process.env.PACK_GENERATOR_LEARNINGS_PATH || join(__dirname, '..', 'config', 'validation-learnings.json');
const GOLDEN_PATH = process.env.PACK_GENERATOR_GOLDEN_PATH || join(__dirname, '..', 'config', 'golden-pipelines.json');
const XSIAM_SOURCES_PATH = join(__dirname, '..', 'config', 'xsiam-sources.json');
const XSIAM_SOURCES = JSON.parse(readFileSync(XSIAM_SOURCES_PATH, 'utf8')).sources || {};

function resolveXsiamContract(sourcetype) {
  const key = String(sourcetype || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (XSIAM_SOURCES[key]) return XSIAM_SOURCES[key];
  return Object.values(XSIAM_SOURCES).find(spec =>
    (spec.aliases || []).some(alias => String(alias).toLowerCase().replace(/[^a-z0-9]+/g, '_') === key),
  );
}

// XSIAM repairs are deterministic. Never ask the repair model to parse the
// JSON and rebuild _raw with JSON.stringify: XSIAM content packs require the
// source-native payload byte-for-byte, plus only their routing metadata.
export function buildXsiamRepairFunctions(sourcetype) {
  return [
    {
      id: 'comment', filter: 'true', disabled: false,
      description: 'Cortex XSIAM source-native passthrough contract',
      conf: { comment: `${sourcetype} -> Cortex XSIAM. Preserve _raw unchanged; add only catalog routing metadata.` },
    },
    ...buildXsiamTagging(sourcetype),
  ];
}

// --- helpers ---

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// Best-effort repair of common LLM JSON defects: markdown fences, trailing
// commas, and truncated output (unterminated strings / unclosed brackets).
function repairJsonText(raw) {
  let t = raw.trim();
  // Strip ```json … ``` fences.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // Narrow to the outermost object.
  const s = t.indexOf('{');
  if (s > 0) t = t.slice(s);
  // Remove trailing commas before } or ].
  t = t.replace(/,(\s*[}\]])/g, '$1');
  // If the output was cut off mid-string, close the string.
  const quotes = (t.match(/(?<!\\)"/g) || []).length;
  if (quotes % 2 === 1) t += '"';
  // Balance brackets: append any missing closers in the right order.
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  return t;
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); }
  catch { /* try repairs */ }
  try {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1].trim());
  } catch { /* fall through */ }
  try {
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s !== -1 && e > s) return JSON.parse(text.substring(s, e + 1));
  } catch { /* fall through */ }
  // Last resort: repair trailing commas / truncation and retry.
  try { return JSON.parse(repairJsonText(text)); }
  catch { throw new Error('AI did not return valid JSON'); }
}

async function invokeAi(system, user, maxTokens = 2048, model) {
  return invokeModel(model || MODEL_ID, system, user, maxTokens);
}

function loadLearnings() {
  try { return JSON.parse(readFileSync(LEARNINGS_PATH, 'utf-8')); }
  catch { return { version: 1, byFormat: {}, bySource: {} }; }
}

// Lessons injected per key. The store had no cap and no eviction (1,225 lessons
// over 85 keys by build 906), so a prompt carried every piece of advice any repair
// ever produced. Newest win: a lesson is appended only after its repair improved
// a real score (recordRepairLessons), so the tail is the advice most recently
// shown to work.
export const MAX_LESSONS_PER_KEY = 12;

// Return the learning bullets relevant to a source+format as a prompt string.
// `current` = this repair's own lessons (from the validation that triggered it):
// they steer this repair without being persisted until it is shown to help.
function learningsFor(sourcetype, destFormat, current = []) {
  const l = loadLearnings();
  const bullets = [...new Set([
    ...((l.byFormat && l.byFormat[destFormat]) || []).slice(-MAX_LESSONS_PER_KEY),
    ...((l.bySource && l.bySource[`${sourcetype}::${destFormat}`]) || []).slice(-MAX_LESSONS_PER_KEY),
    ...(Array.isArray(current) ? current.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []),
  ])];
  return bullets.length ? `\n\nKnown pitfalls to avoid (learned from prior validations):\n- ${bullets.join('\n- ')}` : '';
}

/**
 * Keep the lessons of a repair that WORKED. Called by the repair engine
 * (scripts/repair-core.mjs) only once the repaired pipeline re-scored higher on a
 * real measurement — never from the repair request itself, which used to persist
 * them before anyone knew whether the advice helped. Deduped; a re-learned lesson
 * moves to the newest position; the key keeps MAX_LESSONS_PER_KEY.
 */
function recordRepairLessons(sourcetype, destFormat, lessons, outcome = {}) {
  if (!Array.isArray(lessons) || lessons.length === 0) return { recorded: 0 };
  const { before, after } = outcome;
  if (!(typeof before === 'number' && typeof after === 'number' && after > before)) return { recorded: 0 };
  const l = loadLearnings();
  l.byFormat = l.byFormat || {};
  l.bySource = l.bySource || {};
  const key = `${sourcetype}::${destFormat}`;
  const kept = (l.bySource[key] || []).filter(x => typeof x === 'string');
  let recorded = 0;
  for (const lesson of lessons) {
    if (typeof lesson !== 'string' || !lesson.trim()) continue;
    const t = lesson.trim();
    const at = kept.indexOf(t);
    if (at >= 0) kept.splice(at, 1);
    kept.push(t);
    recorded++;
  }
  l.bySource[key] = kept.slice(-MAX_LESSONS_PER_KEY);
  try { writeFileSync(LEARNINGS_PATH, JSON.stringify(l, null, 2)); } catch { /* best effort */ }
  return { recorded };
}

// --- Golden pipeline store ---

// The store is a single 4 MB JSON file and `getGoldenPipeline` is called once per
// entry of the shared index — 794 times on a startup availability check, which was
// 794 full reads and parses of that file (~8s before this cache). Keyed on mtime +
// size so a write from this process (saveGoldenPipeline) or an edit from outside
// it is still picked up; the parse only repeats when the file actually changed.
let goldenStoreCache = null;
function loadGoldenPipelines() {
  try {
    const { mtimeMs, size } = statSync(GOLDEN_PATH);
    if (goldenStoreCache && goldenStoreCache.mtimeMs === mtimeMs && goldenStoreCache.size === size) {
      return goldenStoreCache.store;
    }
    const store = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));
    goldenStoreCache = { mtimeMs, size, store };
    return store;
  } catch {
    goldenStoreCache = null;
    return { version: 1, pipelines: {} };
  }
}

// `wireFormat` is the sample's wire format (src/golden-variant.ts): a FortiGate
// CEF build resolves `fortinet_fortigate@cef::<fmt>`, never the key=value golden.
// Omitted (undefined) = the exact key as given, which is what the shared-pool
// availability check and import need: they address a golden by its full key.
function getGoldenPipeline(sourcetype, destFormat, wireFormat) {
  // Format-label mapping goldens are not served, including a copy still on disk.
  if (nonSourceMappingGoldenReason(sourcetype, destFormat)) return null;
  const store = loadGoldenPipelines();
  // A quarantined record is a tombstone (golden-trust R5): kept so the same
  // golden cannot come straight back, never served.
  // `storeKey` = the key this record was actually read from (a variant lookup can
  // fall back to the plain key), so a reuse verdict is written back to IT.
  const servable = key => {
    const rec = store.pipelines[key];
    return rec && storedTrustState(rec) !== 'quarantined' ? { ...rec, storeKey: key } : null;
  };
  if (wireFormat === undefined) return servable(`${sourcetype}::${destFormat}`) || null;
  return resolveGoldenVariant(sourcetype, wireFormat, seg => servable(`${seg}::${destFormat}`));
}

// The record under an exact key, quarantined or not — what a WRITE compares
// against. Reading through getGoldenPipeline here would hide a tombstone and let
// the quarantined function list be re-created as if nothing were stored.
function getStoredGoldenRecord(key) {
  return loadGoldenPipelines().pipelines[key] || null;
}

// Enumerate every locally-stored golden as {key, ...entry}. Used by the
// local→shared push to diff against the remote index (the reverse of import).
function listLocalGoldens() {
  const store = loadGoldenPipelines();
  return Object.entries(store.pipelines || {}).map(([key, entry]) => ({ key, ...entry }));
}

function goldenKeyFor(sourcetype, destFormat, wireFormat) {
  // A known wire format files the golden under its variant; a key that already
  // carries a variant (a shared-pool import) keeps it and records its format.
  const wire = isSourceWireFormat(wireFormat) ? wireFormat : null;
  return { key: `${wire ? goldenVariantSourcetype(sourcetype, wire) : sourcetype}::${destFormat}`, wire };
}

function writeGoldenRecord(key, record) {
  const store = loadGoldenPipelines();
  store.pipelines[key] = record;
  try {
    writeFileSync(GOLDEN_PATH, JSON.stringify(store, null, 2));
    // Two writes inside one millisecond would otherwise leave the cache holding
    // the first, so drop it and let the next read re-stat.
    goldenStoreCache = null;
  } catch { /* best effort */ }
}

/**
 * Store a measured golden. The decision is `planGoldenWrite` (src/golden-trust.ts,
 * docs/specs/golden-trust.md R1/R3/R4) — the same rule the iframe's store runs —
 * so this function only reads, asks, and writes what comes back:
 *
 *   - no `evidence`, or evidence that fails R1 → REFUSED (returns the reasons).
 *     `score` alone admits nothing: it is source-relative and was the one number
 *     the store used to rank by, which is how 714 entries came to read exactly 100.
 *   - the same function list re-measured → an observation on the existing record.
 *   - a different one → replaces only if it outranks the stored record.
 *
 * `score` stays a positional argument for the call sites' sake; the stored score
 * is the evidence's.
 */
function saveGoldenPipeline(sourcetype, destFormat, functions, score, recipe, report, wireFormat, evidence) {
  const { key, wire } = goldenKeyFor(sourcetype, destFormat, wireFormat);
  const blocked = nonSourceMappingKeyReason(key);
  if (blocked) return { key, action: 'refuse', reasons: [blocked] };
  const existing = getStoredGoldenRecord(key);
  const plan = planGoldenWrite(existing, {
    functions, evidence,
    // `recipe` = the DETERMINISTIC inputs (AI parse functions + mapping input)
    // that produced this verified pipeline. Persisting it lets a later run
    // REPLAY the proven recipe via buildPack — no AI — auto-promoting a custom
    // source to built-in quality.
    recipe: recipe || null, report: report || null,
    // Never inherited from the record being replaced: an unknown-format
    // golden must not wear the label of the one it beat.
    wireFormat: wire || splitGoldenVariant(sourcetype).wire || null,
  });
  if (plan.record) writeGoldenRecord(key, plan.record);
  return { key, ...plan };
}

/** Write one re-measurement back to the golden it judged (R3). Never creates a record. */
function observeGoldenPipeline(key, evidence, expectedHash) {
  const plan = planGoldenObservation(getStoredGoldenRecord(key), evidence, expectedHash);
  if (plan.record) writeGoldenRecord(key, plan.record);
  return { key, ...plan };
}

/**
 * Several observations of one golden (a holdout run), decided one after another
 * in memory and written ONCE — the store is a 4 MB tracked file.
 */
function observeGoldenPipelineMany(key, evidences, expectedHash) {
  let rec = getStoredGoldenRecord(key);
  let changed = false;
  for (const ev of evidences || []) {
    const plan = planGoldenObservation(rec, ev, expectedHash);
    if (plan.record) { rec = plan.record; changed = true; }
  }
  if (changed) writeGoldenRecord(key, rec);
  return { key, changed, record: rec };
}

/** A shared-pool doc arriving locally (planGoldenImport). `key` is the pool key, variant included. */
function importGoldenPipeline(key, doc) {
  const blocked = nonSourceMappingKeyReason(key);
  if (blocked) return { key, action: 'refuse', reasons: [blocked] };
  const plan = planGoldenImport(getStoredGoldenRecord(key), doc);
  if (plan.record) writeGoldenRecord(key, plan.record);
  return { key, ...plan };
}

export {
  getGoldenPipeline, getStoredGoldenRecord, saveGoldenPipeline, observeGoldenPipeline, observeGoldenPipelineMany, importGoldenPipeline, recordRepairLessons,
  listLocalGoldens, handlePreDeployValidate, handleGetGolden, handleSaveGolden, handleObserveGolden,
};

const cribl = {
  async get(token, path) {
    const r = await fetch(`${CRIBL_ORG}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const t = await r.text();
    let json; try { json = JSON.parse(t); } catch { json = null; }
    return { ok: r.ok, status: r.status, json, text: t };
  },
  async send(token, path, method, body) {
    const r = await fetch(`${CRIBL_ORG}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let json; try { json = JSON.parse(t); } catch { json = null; }
    return { ok: r.ok, status: r.status, json, text: t };
  },
};

// Fetch a sample's content, cached per (group, pack, sampleId) — see
// scripts/sample-cache.mjs for why the cache lives in its own module.
// A single 3-stage build PATCHes + previews up to ~8-14 candidates (extraction
// and mapping each try golden/static/search/AI, plus second-model retries and the
// repair rounds). Every one of those previews re-listed the pack's samples and
// re-downloaded the sample CONTENT — data that cannot change while the build is
// running, since only the pipeline conf is being swapped.
async function getSampleContent(token, workerGroup, packId, sampleId) {
  const cached = getCachedSampleContent(workerGroup, packId, sampleId);
  if (cached !== undefined) return cached;
  const resp = await cribl.get(token, `/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(sampleId)}/content`);
  // Only cache a SUCCESSFUL read. Caching a 404/500 envelope would pin the
  // failure for the whole TTL, including across the AI-generate-and-upload
  // fallback that is supposed to fix exactly that case.
  if (!resp?.ok) return resp;
  return rememberSampleContent(workerGroup, packId, sampleId, resp);
}

// Resolve a pack sample ID from its name (frontend knows the name, not the
// random pack-scoped id). Falls back to the given value if already an id.
async function resolveSampleId(token, workerGroup, packId, sampleId, sampleName) {
  if (sampleId) return sampleId;
  const cached = getCachedSampleId(workerGroup, packId, sampleName);
  if (cached !== undefined) return cached;
  const list = await cribl.get(token, `/m/${workerGroup}/p/${packId}/system/samples`);
  const items = list.json?.items || [];
  // Only a successful resolution is cached — a null must stay retryable, since
  // the very next step may AI-generate and upload the missing sample.
  const remember = (id) => rememberSampleId(workerGroup, packId, sampleName, id);
  // Match by sampleName property, partial match (only when a name was asked —
  // an empty needle matches everything), or by ID.
  const hit = items.find(s => s.sampleName === sampleName)
    || (sampleName ? items.find(s => (s.sampleName || '').includes(sampleName)) : null)
    || items.find(s => s.id === sampleName);
  if (hit) return remember(hit.id);
  // A named sample that isn't present must return null (retryable → AI-generate),
  // NOT an arbitrary leftover sample. Falling back to "the first non-system sample"
  // silently scores the new pipeline against an old/removed sample — the exact bug
  // this path caused (build 586). Only fall back when NO name was requested.
  if (sampleName) return remember(null);
  // No name asked for: pick the first non-system (custom) sample in the pack.
  const SYSTEM_SAMPLES = new Set(['weblog','syslog','apache_common','apache_error','snmp-v1','snmp-v2c','snmp-v3',
    'palo_alto_traffic','business_event','big_json','sample_metrics','appscope_metrics',
    'parquet_primitives','parquet_compression','parquet_logical','parquet_nested','parquet_repeated',
    'sentinel_syslog','sentinel_securityevents','sentinel_windowsevents','sentinel_commonsecuritylog',
    'model_driven_telemetry','google_secops_udm_zeek_logs']);
  const custom = items.find(s => !SYSTEM_SAMPLES.has(s.id));
  return remember(custom?.id || null);
}

// Generate a sample via AI and upload it to a pack that has none.
async function generateAndUploadSample(token, workerGroup, packId, sourcetype) {
  const sampleName = `${sourcetype}_sample.log`;
  const prompt = `Generate exactly 10 diverse ${sourcetype} log events. Return raw events only, one per line. No numbering, no code fences, no explanation. For JSON use compact single-line format.`;
  let text;
  try { text = await invokeModel(MODEL_ID, 'You are a log generator. Return ONLY raw log events, one per line. No markdown, no explanation.', prompt, 8000); }
  catch { return null; }
  const lines = cleanSampleText(text);
  if (!lines || lines.length < 3) return null;
  const events = lines.slice(0, 10).map(l => ({ _raw: l, _time: Date.now() / 1000 }));
  const uploadResp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/samples`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sampleName, context: { events } }),
  });
  if (!uploadResp.ok) return null;
  const uploaded = await uploadResp.json();
  // The pack's sample set just changed — drop any TTL'd entries so the next
  // resolve sees this upload instead of a cached "not found".
  invalidateSampleCache(workerGroup, packId);
  return uploaded?.items?.[0]?.id || uploaded?.id || sampleName;
}

// Run a sample through a pipeline via the Cribl preview API (mode=pipe).
async function runPreview(token, workerGroup, packId, pipelineId, sampleId) {
  // NOTE: the transform is applied only when the param is `pipelineId` (an id
  // reference). Passing `pipeline` leaves events untransformed (raw passthrough).
  const r = await cribl.send(token, `/m/${workerGroup}/p/${packId}/preview`, 'POST', {
    mode: 'pipe', sampleId, pipelineId,
  });
  if (!r.ok) throw new Error(`Preview failed (${r.status}): ${r.text.slice(0, 300)}`);
  // Strip Cribl control fields so scoring sees only real output fields.
  return (r.json?.items || []).map(e => {
    const { __criblEventType, __ctrlFields, __final, __cloneCount, __id, __packId, cribl_pipe: _cribl_pipe, cribl_breaker: _cribl_breaker, ...rest } = e || {};
    return rest;
  });
}

// Run a sample through a pipeline with CPU profiling enabled and return the
// per-function Cribl Pipeline Profile — the exact data behind the "Pipeline
// Profile" tab of Cribl's preview diagnostics:
//   { cpu:{user,system}, duration (ms, the Summary Total),
//     functions:[{ func, bytesIn, bytesOut, eventsIn, eventsOut, duration }] }
// `cpuProfile:true` + `level:3` is what the Cribl UI itself sends (captured from
// the live UI); without them the preview response omits the `stats` object.
async function runProfile(token, workerGroup, packId, pipelineId, sampleId) {
  const r = await cribl.send(token, `/m/${workerGroup}/p/${packId}/preview`, 'POST', {
    mode: 'pipe', sampleId, pipelineId,
    cpuProfile: true, level: 3, dropped: true,
    enhanceMetricsOutput: false, timeout: 10000, memory: 2048,
  });
  if (!r.ok) throw new Error(`Profile preview failed (${r.status}): ${r.text.slice(0, 300)}`);
  return r.json?.stats || null;
}

// Backend endpoint: return the real Cribl Pipeline Profile for a deployed
// pipeline. Standalone path for the Event Journey "Pipeline statistics" section
// (the iframe path calls the Cribl preview API directly — see api.ts).
export async function handlePipelineProfile(req, res) {
  try {
    const { workerGroup, packId, pipelineId, sampleName } = await readBody(req);
    if (!workerGroup || !packId || !pipelineId) {
      return sendJson(res, 400, { error: 'workerGroup, packId, pipelineId are required' });
    }
    const token = await getToken();
    const sampleId = await resolveSampleId(token, workerGroup, packId, undefined, sampleName);
    if (!sampleId) return sendJson(res, 400, { error: `No sample found in pack ${packId}` });
    const stats = await runProfile(token, workerGroup, packId, pipelineId, sampleId);
    return sendJson(res, 200, { stats });
  } catch (e) {
    return sendJson(res, 500, { error: e?.message || String(e) });
  }
}

function scoreBand(score) {
  if (score >= 85) return 'good';
  if (score >= 60) return 'warn';
  return 'fail';
}

// Enumerate the distinct field keys present in raw sample lines (kvp k=v and
// JSON objects). Lightweight mirror of pack-builder's extractSampleKeys — used
// so the client's deterministic validator knows which source fields existed.
function collectSampleKeys(rawLines) {
  const keys = new Set();
  for (const line of (rawLines || []).slice(0, 40)) {
    const t = String(line).trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try { for (const k of Object.keys(JSON.parse(t))) keys.add(k); continue; } catch { /* not json */ }
    }
    const kv = /(?:^|\s)([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|\S*)/g;
    let m;
    while ((m = kv.exec(t)) !== null) keys.add(m[1]);
  }
  return [...keys];
}

// --- Cribl-safety sanitizers (ported from src/pack-builder.ts) ---
// The AI repair call regenerates eval `conf.add` entries. Cribl rejects the
// PATCH outright if any field name isn't a valid property-accessor path
// (e.g. ECS `@timestamp`), any value isn't a single eval expression
// (arrow fns / `;` / `?.` / `??` / unbalanced parens), or a value isn't a
// string. Without these guards a whole repair is lost to a 500 at PATCH time.

const JS_RESERVED_FIELDNAMES = new Set([
  'in','do','if','for','new','try','var','let','case','else','enum','void',
  'with','break','catch','class','const','super','throw','while','yield',
  'delete','export','import','public','return','static','switch','typeof',
  'default','extends','finally','package','private','continue','debugger',
  'function','interface','protected','implements','instanceof',
]);
const JS_GLOBALS = new Set([
  'Number','String','Boolean','Object','Array','JSON','Math','Date',
  'parseInt','parseFloat','isNaN','isFinite','undefined','null','NaN',
  'Infinity','true','false','encodeURIComponent','decodeURIComponent',
  'RegExp','Error','Map','Set',
]);
const JS_OPERATOR_KEYWORDS = new Set(['new','typeof','void','delete','instanceof']);

function escapeReservedWords(expr) {
  const STRING_OR_IDENT = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_]\w*/g;
  return expr.replace(STRING_OR_IDENT, (match, offset) => {
    const first = match[0];
    if (first === "'" || first === '"' || first === '`') return match;
    if (JS_GLOBALS.has(match)) return match;
    if (JS_OPERATOR_KEYWORDS.has(match)) return match;
    if (!JS_RESERVED_FIELDNAMES.has(match)) return match;
    if (offset > 0 && expr[offset - 1] === '.') return match;
    return `__e['${match}']`;
  });
}

// True only when `expr` is a safe single Cribl eval expression.
function isSafeEvalExpression(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  const stripped = expr
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/\bfunction\b/.test(stripped)) return false;
  if (/\breturn\b/.test(stripped)) return false;
  if (/=>/.test(stripped)) return false;             // arrow function
  if (/;/.test(stripped)) return false;              // statement separator
  if (/\?\./.test(stripped)) return false;           // optional chaining
  if (/\?\?/.test(stripped)) return false;           // nullish coalescing
  if (/\b(var|let|const|if|else|for|while|switch|do|try|catch|throw)\b/.test(stripped)) return false;
  // Balanced (){}[] — the AI sometimes emits truncated ternaries with a
  // dangling '(' which Cribl rejects with "Unexpected token ')'".
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const ch of stripped) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch]) { if (stack.pop() !== pairs[ch]) return false; }
  }
  if (stack.length) return false;
  // A bare '@' (outside a string literal, already stripped above) is an illegal
  // Cribl eval token — a '@'-prefixed field ref must never reach the PATCH.
  if (/@/.test(stripped)) return false;
  // Cribl rejects any assignment operator and fails the WHOLE PATCH with
  // "Unallowed assignment operator found in expression". Mirrors
  // hasAssignmentOperator() in pack-builder.ts — the dynamic-field-name idiom
  // Cribl does accept is `Object.assign(__e, {[name]: value})`.
  const blanked = expr
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, ' ')
    .replace(/=>/g, '  ');
  if (/(?<![=!<>])=(?!=)/.test(blanked)) return false;
  return true;
}

// Each dotted segment must be a valid JS identifier (no `@timestamp`, no
// hyphens/spaces, not starting with a digit).
function isSafeFieldName(name) {
  if (!name || typeof name !== 'string') return false;
  return name.split('.').every(seg => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg));
}

// ECS canonically uses '@timestamp' (and Cribl can't create '@'-prefixed
// fields — "Unexpected token ILLEGAL"). The AI keeps emitting it, both as an
// eval add name and inside a rename renameExpr string literal. Strip a leading
// '@' from any single-quoted identifier literal so '@timestamp' -> 'timestamp'
// (matching what the generation path does).
function stripAtPrefixLiterals(expr) {
  return expr.replace(/'@([A-Za-z_][\w.]*)'/g, "'$1'");
}

// The BARE counterpart: strip a leading '@' from an UNQUOTED field reference
// (`@timestamp || created_at` -> `timestamp || created_at`) so an illegal token
// can't fail the PATCH. '@' inside a string literal is preserved.
function stripAtPrefixIdentifiers(expr) {
  const TOKEN = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|@([A-Za-z_][\w.]*)/g;
  return expr.replace(TOKEN, (m, ident) => (ident !== undefined ? ident : m));
}

function isIdentityEvalAssignment(name, value) {
  const expr = value.trim();
  if (expr === name) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:__e|this)(?:\\.${escaped}|\\[['"]${escaped}['"]\\])$`).test(expr);
}

// Sanitize a repaired functions array: drop unsafe eval add-entries and clean
// rename expressions so a single bad mapping can't sink the entire PATCH.
// Returns {functions, dropped}.
function sanitizeFunctions(functions) {
  const dropped = [];
  const clean = [];
  for (const fn of functions) {
    if (fn?.id === 'eval' && Array.isArray(fn?.conf?.add)) {
      const keptAdds = [];
      for (const a of fn.conf.add) {
        // Cribl requires the value to be a string expression.
        let value = typeof a?.value === 'string' ? a.value : (a?.value == null ? '' : String(a.value));
        value = stripAtPrefixIdentifiers(stripAtPrefixLiterals(value));
        const name = typeof a?.name === 'string' ? a.name.replace(/^@/, '') : a?.name;
        if (!isSafeFieldName(name)) { dropped.push(`name "${a?.name}"`); continue; }
        if (!isSafeEvalExpression(value)) { dropped.push(`${name}=${String(value).slice(0, 60)}`); continue; }
        if (isIdentityEvalAssignment(name, value)) { dropped.push(`identity ${name}=${value}`); continue; }
        keptAdds.push({ ...a, name, value: escapeReservedWords(value) });
      }
      const hasCleanup = ['remove', 'keep'].some(key => Array.isArray(fn.conf[key]) && fn.conf[key].length > 0);
      if (keptAdds.length === 0 && fn.conf.add.length > 0 && !hasCleanup) { dropped.push(`(whole eval "${fn.description || ''}")`); continue; }
      clean.push({ ...fn, conf: { ...fn.conf, add: keptAdds } });
    } else if (fn?.id === 'rename' && typeof fn?.conf?.renameExpr === 'string') {
      // A renameExpr that produces '@timestamp' etc. fails the PATCH. Strip the
      // leading '@' from any produced field-name literal; drop the whole rename
      // if the expression still isn't a safe single Cribl expression.
      const renameExpr = stripAtPrefixIdentifiers(stripAtPrefixLiterals(fn.conf.renameExpr));
      if (!isSafeEvalExpression(renameExpr)) { dropped.push(`(rename "${fn.description || ''}")`); continue; }
      clean.push({ ...fn, conf: { ...fn.conf, renameExpr } });
    } else if (fn?.id === 'rename' && Array.isArray(fn?.conf?.rename)) {
      // Array-form rename: [{currentName, newName}]. A newName like '@timestamp'
      // fails the PATCH ("currentName" schema error). Strip a leading '@' and
      // drop any pair whose resulting name still isn't a valid accessor path.
      const keptPairs = [];
      for (const p of fn.conf.rename) {
        const currentName = typeof p?.currentName === 'string' ? p.currentName.replace(/^@/, '') : p?.currentName;
        const newName = typeof p?.newName === 'string' ? p.newName.replace(/^@/, '') : p?.newName;
        if (!isSafeFieldName(currentName) || !isSafeFieldName(newName)) { dropped.push(`rename ${p?.currentName}->${p?.newName}`); continue; }
        keptPairs.push({ ...p, currentName, newName });
      }
      if (keptPairs.length === 0 && fn.conf.rename.length > 0) { dropped.push(`(whole rename "${fn.description || ''}")`); continue; }
      clean.push({ ...fn, conf: { ...fn.conf, rename: keptPairs } });
    } else {
      clean.push(fn);
    }
  }
  return { functions: clean, dropped };
}

// --- validate ---

export function buildFastValidationReport({ pipelineId, destFormat, sourcetype, sampleRaw, outputSample, outputCount }) {
  return {
    pipelineId, destFormat, score: 0, band: 'fail', aiSkipped: true,
    sampleFormatOk: sampleRaw.length > 0, sampleFormatNote: '', outputFormatOk: outputCount > 0,
    findings: [], missingFields: [], emptyFields: [], summary: 'Deterministic live preview completed.', lessons: [],
    inputCount: sampleRaw.length, outputCount,
    outputSample, sampleKeys: collectSampleKeys(sampleRaw), sampleRaw, sourcetype,
  };
}

export async function handleValidatePipeline(req, res) {
  try {
    const { workerGroup, packId, pipelineId, sourcetype, destFormat, sampleName, includeAi = true } = await readBody(req);
    if (!workerGroup || !packId || !pipelineId) {
      return sendJson(res, 400, { error: 'workerGroup, packId, pipelineId are required' });
    }
    const token = await getToken();
    let sampleId = await resolveSampleId(token, workerGroup, packId, undefined, sampleName);
    if (!sampleId && sourcetype) {
      // No sample in pack — generate one via AI and upload
      sampleId = await generateAndUploadSample(token, workerGroup, packId, sourcetype);
    }
    if (!sampleId) return sendJson(res, 400, { error: `No sample found in pack ${packId} and AI generation failed` });

    // 1. Sample content (input format check)
    const sampleResp = await getSampleContent(token, workerGroup, packId, sampleId);
    const sampleEvents = Array.isArray(sampleResp.json) ? sampleResp.json : (sampleResp.json?.events || []);
    const sampleRaw = sampleEvents.slice(0, 8).map(e => e._raw ?? (typeof e === 'string' ? e : JSON.stringify(e))).filter(Boolean);

    // 2. Pipeline output (via preview)
    const outputEvents = await runPreview(token, workerGroup, packId, pipelineId, sampleId);
    const outputSample = outputEvents.slice(0, 8).map(e => {
      const { _raw, ...rest } = e || {};
      return _raw !== undefined ? { _raw, ...rest } : rest;
    });

    // The authoritative scorer only needs the live sample + preview output.
    // Return those immediately for post-deploy quality gates; AI findings are
    // advisory and can be requested later from the scorecard or repair flow.
    const sampleKeys = collectSampleKeys(sampleRaw);
    if (includeAi === false) {
      return sendJson(res, 200, buildFastValidationReport({
        pipelineId, destFormat, sourcetype, sampleRaw, outputSample, outputCount: outputEvents.length,
      }));
    }

    // 3. AI scoring
    const xsiamContract = destFormat === 'xsiam' ? resolveXsiamContract(sourcetype) : null;
    const xsiamExpected = xsiamContract ? `
For this source the catalog contract is exact:
- __sourceIdentifier=${xsiamContract.sourceIdentifier || '(documented source UUID)'}
- __vendor=${xsiamContract.vendor || '(not required by this dedicated UUID)'}
- __product=${xsiamContract.product || '(not required by this dedicated UUID)'}
- target dataset=${xsiamContract.dataset || '(assigned by the dedicated integration)'}
- payload format=${xsiamContract.payloadFormat || 'source-native'}
- required JSON paths=${(xsiamContract.expectedJsonPaths || []).join(', ') || '(source-specific)'}
Reject case changes or friendly display names when vendor/product are specified; XSIAM INGEST matching is exact.` : '';
    const xsiamRules = destFormat === 'xsiam' ? `

TARGET IS CORTEX XSIAM PASSTHROUGH — score ONLY these checks:
1. _raw is preserved (unchanged vendor log line or JSON blob)
2. __sourceIdentifier is present and matches the catalog value on every output event
3. __vendor and __product exactly match the content-pack INGEST rule when the pipeline uses generic-collector tagging OR cef_extract (vendor/product from CEF header fields 1–2)
${xsiamExpected}
Cribl supplies __inputId automatically for the Integration-Identifier header. It must remain unmodified, but if it is absent from Pipeline Preview, report only a low-severity advisory with zero score impact and keep outputFormatOk=true.
Do NOT penalize unmapped CEF extension fields (src, dst, spt, dpt, act, suser, msg, etc.) — XSIAM parses vendor format natively in the collector.
Do NOT list schema fields as missingFields. A score of 100 means the three routing tags + _raw are correct.` : '';

    const system = `You are a strict Cribl Stream pipeline QA validator. You are given: (a) sample INPUT events, (b) the target schema/format, and (c) the pipeline OUTPUT events after transformation. Assess whether the output correctly and completely conforms to the target format.
${xsiamRules}

Return ONLY valid JSON, no markdown:
{"score":0-100,"sampleFormatOk":true/false,"sampleFormatNote":"one line on whether input looks like real ${destFormat!=null?'':''}logs of this source",
"outputFormatOk":true/false,
"findings":[{"severity":"high|medium|low","field":"<field or _raw>","issue":"what is wrong","example":"short evidence from output"}],
"missingFields":["schema fields whose SOURCE VALUE EXISTS in the sample but was NOT mapped (a real gap) — do NOT list fields the source simply doesn't contain"],
"emptyFields":["fields present but empty/unpopulated across events"],
"summary":"2-3 sentence assessment",
"lessons":["generalizable rules to avoid these issues next time this source+format is generated"]}

SCORE SOURCE-RELATIVE, NOT AGAINST AN IDEAL SCHEMA. The score measures: "of the information ACTUALLY PRESENT in the sample input, how much did the pipeline correctly extract and map to the target format?" You are grading the transformation, not the richness of the source.
- A field that is ABSENT FROM THE SOURCE cannot be mapped and MUST NOT lower the score or appear in missingFields/findings. (e.g. a firewall traffic log has no username — not having suser is correct, not a defect.)
- The MAXIMUM achievable output for this sample = every field the raw input actually carries, correctly parsed and mapped with correct target field names, valid structure, correct timestamp. If the pipeline achieves that, score 100 — even if the target schema defines many more fields the source never provides.
- Only penalize: (a) a value present in the raw input but dropped/unmapped/mis-mapped, (b) wrong target field names, (c) malformed structure (missing CEF:0 header, non-numeric OCSF class ids), (d) wrong/empty timestamp, (e) values placed under the wrong key.

Scoring:
- 100: everything the sample contains is extracted and correctly mapped; structure + timestamp valid. Sparse source that's fully captured still = 100.
- 85-99: fully mapped, minor cosmetic issues (naming nit, optional enrichment).
- 60-84: a value that IS in the source was dropped or mis-mapped, or a structural/timestamp issue.
- <60: broken shape, empty output, source values largely unmapped, or wrong field names.
Do NOT deduct for schema fields the source cannot supply. Judge only what the input made possible.`;

    const user = `SOURCE: ${sourcetype || 'unknown'}
TARGET FORMAT: ${destFormat}

SAMPLE INPUT EVENTS (first ${sampleRaw.length}):
${sampleRaw.join('\n')}

PIPELINE OUTPUT EVENTS (first ${outputSample.length}, JSON):
${JSON.stringify(outputSample, null, 2).slice(0, 6000)}

Validate the output against the ${destFormat} schema and score it.`;

    let report;
    try {
      report = parseJsonLoose(await invokeAi(system, user, 6144));
    } catch (e) {
      return sendJson(res, 200, {
        pipelineId, destFormat, score: 0, band: 'fail',
        sampleFormatOk: sampleRaw.length > 0, outputFormatOk: false,
        findings: [{ severity: 'high', field: '_ai', issue: `Validation AI call failed: ${e.message}`, example: '' }],
        missingFields: [], emptyFields: [], summary: 'Could not run AI validation.', lessons: [],
        inputCount: sampleRaw.length, outputCount: outputEvents.length,
      });
    }

    const score = Math.max(0, Math.min(100, Number(report.score) || 0));
    // Enumerate the raw sample's field keys (kvp/json) so the client can run the
    // deterministic schema-validated check (validateOutputAgainstSpec) and prefer
    // its stable score over this AI estimate when a golden spec exists.
    sendJson(res, 200, {
      pipelineId,
      destFormat,
      score,
      band: scoreBand(score),
      sampleFormatOk: report.sampleFormatOk !== false,
      sampleFormatNote: report.sampleFormatNote || '',
      outputFormatOk: report.outputFormatOk === true,
      findings: Array.isArray(report.findings) ? report.findings : [],
      missingFields: Array.isArray(report.missingFields) ? report.missingFields : [],
      emptyFields: Array.isArray(report.emptyFields) ? report.emptyFields : [],
      summary: report.summary || '',
      lessons: Array.isArray(report.lessons) ? report.lessons : [],
      inputCount: sampleRaw.length,
      outputCount: outputEvents.length,
      // Raw material for the client-side deterministic + value-coverage scorers.
      outputSample,
      sampleKeys,
      sampleRaw,
      sourcetype,
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Validation failed' });
  }
}

// --- repair ---

export async function handleRepairPipeline(req, res) {
  try {
    const { workerGroup, packId, pipelineId, sourcetype, destFormat, sampleName, findings, lessons, missingFields, emptyFields, deferDeploy, model } = await readBody(req);
    if (!workerGroup || !packId || !pipelineId) {
      return sendJson(res, 400, { error: 'workerGroup, packId, pipelineId are required' });
    }
    const token = await getToken();
    let sampleId = await resolveSampleId(token, workerGroup, packId, undefined, sampleName);
    if (!sampleId && sourcetype) {
      sampleId = await generateAndUploadSample(token, workerGroup, packId, sourcetype);
    }
    if (!sampleId) return sendJson(res, 400, { error: `No sample in pack ${packId} and AI generation failed` });

    // `lessons` steer THIS repair only. They are persisted by the engine once the
    // repair is measured to have helped (recordRepairLessons) — not here, before
    // anyone knows.

    // Current pipeline conf
    const plResp = await cribl.get(token, `/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`);
    const conf = plResp.json?.items?.[0]?.conf || plResp.json?.conf;
    if (!conf) throw new Error('Could not load current pipeline conf');

    // Sample + current output for context
    const sampleResp = await getSampleContent(token, workerGroup, packId, sampleId);
    const sampleEvents = Array.isArray(sampleResp.json) ? sampleResp.json : (sampleResp.json?.events || []);
    const sampleRaw = sampleEvents.slice(0, 6).map(e => e._raw ?? (typeof e === 'string' ? e : JSON.stringify(e))).filter(Boolean);
    let currentOutput = [];
    try { currentOutput = (await runPreview(token, workerGroup, packId, pipelineId, sampleId)).slice(0, 4); } catch { /* ignore */ }

    const findingsText = (findings || []).map(f => `- [${f.severity}] ${f.field}: ${f.issue}`).join('\n') || '(none provided)';
    const missingText = (missingFields || []).length ? (missingFields).map(m => `- ${m}`).join('\n') : '(none)';
    const emptyText = (emptyFields || []).length ? (emptyFields).map(m => `- ${m}`).join('\n') : '(none)';

    const system = `You repair a Cribl Stream pipeline so its output conforms to the target schema. You are given the current pipeline function array (JSON), the sample input, the current (flawed) output, and the validation findings. FIX EVERY listed finding and map EVERY listed missing field. Return ONLY the corrected FULL pipeline conf as JSON:
{"functions":[ ...corrected Cribl function objects... ]}

Rules:
- Keep the parse/reduction stages that work; fix the mapping/output stages that cause the findings.
- Every eval expression must be a SINGLE valid Cribl expression: NO arrow functions, NO 'function', NO 'return', NO ';', NO IIFE, NO optional chaining ?., NO nullish coalescing ??. Use ternaries and || chains only. Keep each expression short and fully balanced — never emit a truncated or dangling ternary.
- Field NAMES (eval add "name", every dotted segment) must be valid Cribl accessor paths: letters/digits/_/$ only, not starting with a digit. NEVER use '@' prefixes — for ECS write 'timestamp' or 'event_time', never '@timestamp'; no hyphens or spaces in names.
- Every eval add "value" must be a STRING containing the expression (e.g. "Number(dpt)", not the bare number).
- Reserved word 'in' → __e['in'].
- Preserve the function shape Cribl expects: {id, filter, disabled, description, conf}.
- Do not invent source fields — map only from fields visible in the sample/output.
- Return the COMPLETE functions array in one response; do not truncate mid-array.
- CRITICAL: In multi-stage pipelines, the mapping stage must reference field names as they exist AFTER the parse/normalize stages — not the original raw field names. Check what the preceding stages produce before writing mapping expressions.
- The cleanup/remove stage must NOT remove fields that the mapping stage produces as output. Only remove raw/intermediate source fields.${learningsFor(sourcetype, destFormat, lessons)}`;

    const user = `SOURCE: ${sourcetype}
TARGET FORMAT: ${destFormat}

VALIDATION FINDINGS (fix each one):
${findingsText}

MISSING FIELDS — these values ARE present in the source/output but not mapped to the target; ADD a mapping for each:
${missingText}

EMPTY FIELDS — present but blank; either populate from the correct source field or omit:
${emptyText}

SAMPLE INPUT (first ${sampleRaw.length}):
${sampleRaw.join('\n')}

CURRENT OUTPUT (flawed, first ${currentOutput.length}):
${JSON.stringify(currentOutput, null, 2).slice(0, 3000)}

CURRENT PIPELINE FUNCTIONS (COMPLETE list, one object per line; do not infer truncation from formatting):
${conf.functions.map(f => JSON.stringify(f)).join('\n').slice(0, 20000)}

Return the corrected pipeline conf that resolves ALL findings and maps ALL missing fields.`;

    const repaired = destFormat === 'xsiam'
      ? { functions: buildXsiamRepairFunctions(sourcetype) }
      : parseJsonLoose(await invokeAi(system, user, 8192, model));
    if (!Array.isArray(repaired.functions) || repaired.functions.length === 0) {
      throw new Error('AI repair did not return a valid functions array');
    }

    // Strip eval add-entries that Cribl would reject (bad field names,
    // non-single-expression values, non-string values) so one bad mapping
    // can't sink the whole PATCH with a 500.
    const { functions: safeFunctions, dropped } = sanitizeFunctions(repaired.functions);
    if (dropped.length) console.warn(`[repair ${pipelineId}] dropped ${dropped.length} unsafe entries: ${dropped.join('; ')}`);
    const newConf = { ...conf, functions: safeFunctions };

    // PATCH the pipeline
    const patch = await cribl.send(token, `/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, 'PATCH', { id: pipelineId, conf: newConf });
    if (!patch.ok) throw new Error(`Pipeline PATCH failed (${patch.status}): ${patch.text.slice(0, 300)}`);

    // deferDeploy: the caller (e.g. parallel quality-check) will commit + deploy
    // ONCE at the end. Previewing/validating reads the PATCHed conf on the leader
    // without a deploy, so parallel repairs can PATCH safely and share one commit.
    if (deferDeploy) {
      return sendJson(res, 200, { pipelineId, repaired: true, deferred: true, commit: null, functionCount: safeFunctions.length, droppedUnsafe: dropped.length });
    }

    // Commit + deploy
    const commit = await cribl.send(token, `/version/commit`, 'POST', { message: `Repair pipeline ${pipelineId} in ${packId}`, group: workerGroup });
    const commitId = commit.json?.items?.[0]?.commit || 'unknown';
    await cribl.send(token, `/master/groups/${workerGroup}/deploy`, 'PATCH', { version: commitId });

    sendJson(res, 200, { pipelineId, repaired: true, commit: commitId, functionCount: safeFunctions.length, droppedUnsafe: dropped.length });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Repair failed', pipelineId: undefined });
  }
}

// --- Pre-deploy quality gate ---

async function handlePreDeployValidate(req, res) {
  try {
    const { sourcetype, destFormat, functions, sampleEvents } = await readBody(req);
    if (!sourcetype || !destFormat || !functions || !sampleEvents) {
      return sendJson(res, 400, { error: 'Missing required fields: sourcetype, destFormat, functions, sampleEvents' });
    }

    const sampleLines = sampleEvents.split('\n').filter(Boolean).slice(0, 5);
    const learnings = learningsFor(sourcetype, destFormat);

    const system = `You are a strict Cribl Stream pipeline QA validator. You are given pipeline functions (JSON config) and sample INPUT events. Mentally simulate what this pipeline would produce from these inputs, then score the expected output vs the target schema.

Return ONLY valid JSON:
{"score":0-100,"findings":[{"severity":"high|medium|low","field":"<field>","issue":"what is wrong"}],"missingFields":["source values present in the sample but NOT mapped"],"emptyFields":["fields mapped but blank across events"],"summary":"2-3 sentence assessment","suggestions":["specific fixes to improve the pipeline"]}

CONSERVATIVE ABOUT EXECUTION, GENEROUS ABOUT SOURCE LIMITS — this is a STATIC pre-deploy estimate. Be conservative about WHETHER a mapping will actually populate at runtime: if uncertain a field will extract/populate, assume it will not (don't over-estimate a real run). But this conservatism is ONLY about execution risk — it is NOT a reason to dock points for fields the source doesn't contain. Those two are separate: absent-from-source = not a defect (see source-relative rule below); uncertain-it-populates = assume it won't.

EVALUATE IN PHASES — a pipeline is only as good as its weakest earlier phase:

PHASE 1 — SOURCE EXTRACTION (evaluate FIRST): Trace the parse stage against the raw sample. Which fields does it actually populate? A pipeline that does not extract real values from _raw is BROKEN regardless of how good the mapping looks — cap its score at 30.

PHASE 2 — DESTINATION MAPPING (evaluate SECOND, and only meaningfully if Phase 1 produced fields): For each mapping, check that its EXPRESSION reads a field that PHASE 1 actually produced. The classic failure: a CEF/CIM mapping whose expression reads a target-schema name (src, dst, spt, dpt, suser) instead of the real extracted source field (src_ip, dest_ip, src_port). Such expressions evaluate to null → the output has a valid header but EMPTY extension/body. This is a CRITICAL defect — if most extension/body fields would be empty because expressions reference non-existent source fields, cap the score at 40 and list each offending field in findings.

PHASE 3 — OPTIMIZATION (evaluate LAST): drops/sampling/cleanup are only correct once phases 1-2 work. A cleanup/keep stage that removes fields the mapping produced is a defect.

SCORE SOURCE-RELATIVE. The score measures how completely the pipeline extracts and maps the information ACTUALLY PRESENT in the sample — not how many fields the target schema theoretically defines. A field the source does NOT contain cannot be mapped and must NOT lower the score or be listed in missingFields. The ceiling for this sample = every value the raw input carries, correctly parsed + mapped with correct target names + valid structure + correct timestamp. A sparse source fully captured still scores 100.

Scoring:
- 100: every value present in the sample is extracted and correctly mapped; structure + timestamp valid. (Sparse-but-complete = 100.)
- 85-99: fully mapped, only minor cosmetic issues.
- 60-84: a value that IS in the source is dropped/mis-mapped, or a structural/timestamp issue.
- <60: extraction produces nothing, mapping reads fields never extracted (empty output), or parse/map field-name mismatch.
Score down HARD for: mapping expressions that reference target-schema field names as if they were source fields (produces empty output — the #1 defect to catch); eval expressions using arrow functions or semicolons (Cribl rejects these); field names with @ or hyphens; parse functions that don't match the input format. Do NOT deduct for schema fields the source cannot supply.

KNOWN-GOOD PATTERNS (do NOT penalize these — they are verified working in Cribl):
- Lookup-driven parsing: a lookup fetches a per-code regex string into a scratch field, then an eval does groups = _raw.match(__regex).groups and a second add with an EMPTY name value Object.assign(__e, groups) to spread the captured groups onto the event. This is the standard Cribl idiom used by professional packs (cribl-cisco-asa-cleanup) and is confirmed to populate fields correctly. Treat it as correct, not fragile.
- An empty-string add name ({name:'', value:'Object.assign(__e, x)'}) is a valid Cribl side-effect eval, not a defect.
- The pipeline you are given is COMPLETE. Do NOT report "truncated" / "cut off mid-expression" / "incomplete" findings based on how the JSON is formatted or displayed — that is a prompt display limit, never a real defect. Assume every function is fully present.${learnings}`;

    // Serialize the WHOLE pipeline compactly (one function per line). Never
    // truncate mid-expression — a cut-off would make the model wrongly conclude
    // the pipeline is "truncated/broken" and tank the score (the #1 cause of
    // pre-deploy under-scoring vs the real post-deploy run).
    const fnJson = functions.map(f => JSON.stringify(f)).join('\n');
    const fnBlock = fnJson.length > 24000
      ? fnJson.slice(0, 24000) + '\n…(list continues; treat any cut-off as a display limit, NOT a pipeline defect — the pipeline is complete)'
      : fnJson;

    const user = `SOURCE: ${sourcetype}
TARGET FORMAT: ${destFormat}

PIPELINE FUNCTIONS (${functions.length} total, one JSON object per line — this is the COMPLETE pipeline; do not infer truncation/breakage from formatting):
${fnBlock}

SAMPLE INPUT (first ${sampleLines.length} events):
${sampleLines.join('\n').slice(0, 4000)}

Mentally execute this pipeline against the sample events and score the expected output against the ${destFormat} schema.`;

    const text = await invokeAi(system, user, 6144);
    const result = parseJsonLoose(text);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Pre-deploy validation failed' });
  }
}

// --- Golden pipeline endpoints ---

async function handleGetGolden(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const sourcetype = url.searchParams.get('sourcetype');
    const destFormat = url.searchParams.get('destFormat');
    if (!sourcetype || !destFormat) return sendJson(res, 400, { error: 'Missing sourcetype or destFormat' });
    // Absent = the exact key (legacy clients); present-but-empty = unknown format.
    const wireFormat = url.searchParams.has('wireFormat') ? url.searchParams.get('wireFormat') : undefined;
    const golden = getGoldenPipeline(sourcetype, destFormat, wireFormat);
    sendJson(res, 200, { golden });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// POST /api/pack-generator/golden-pipeline. No evidence → 422 with the reasons:
// this door used to accept any function list with an invented default score — a
// number on a record nothing could judge (golden-trust R1).
async function handleSaveGolden(req, res) {
  try {
    const { sourcetype, destFormat, functions, score, recipe, report, wireFormat, evidence } = await readBody(req);
    if (!sourcetype || !destFormat || !functions) return sendJson(res, 400, { error: 'Missing required fields' });
    const plan = saveGoldenPipeline(sourcetype, destFormat, functions, score, recipe, report, wireFormat, evidence);
    if (plan.action === 'refuse') return sendJson(res, 422, { saved: false, action: plan.action, key: plan.key, reasons: plan.reasons });
    sendJson(res, 200, { saved: !!plan.record, action: plan.action, key: plan.key, reasons: plan.reasons });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// POST /api/pack-generator/golden-observe  { key, evidence, expectedHash }
// A reused golden's verdict (golden-trust R3/R5). Never creates a record.
async function handleObserveGolden(req, res) {
  try {
    const { key, evidence, expectedHash } = await readBody(req);
    if (!key || !evidence) return sendJson(res, 400, { error: 'key and evidence are required' });
    const plan = observeGoldenPipeline(key, evidence, expectedHash);
    sendJson(res, plan.action === 'refuse' ? 422 : 200, { observed: plan.action === 'observe', action: plan.action, key, reasons: plan.reasons });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}
