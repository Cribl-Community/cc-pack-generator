// Splunk CSV — a lossless FORMAT optimization for key=value sources sent to Splunk.
//
// A key=value line repeats every key on every event. Splunk bills the `_raw` it
// indexes, and a search-time extraction can name positional values just as well
// as `key=` prefixes can, so the same values sent as a CSV row (known keys as
// columns, everything else packed into one trailing `extended` key=value column)
// carry the same information in roughly half the bytes. Splunk reads them back
// with a small search-head app (props.conf + transforms.conf) that this module
// also generates — the pack README carries it.
//
// Two sources of a column contract, graded against each other per log type:
//   - CURATED  ('cribl-pack'): a published vendor pack's own CSV contract,
//     imported by scripts/import-splunk-csv-contract.mjs into
//     config/splunk-csv-contracts.json (FortiGate: the official Cribl Fortinet
//     pack, 5 log types, compatible with its ZZZ-fortigate-csv Splunk app).
//   - DERIVED  ('derived'): learned from the sample — a key becomes a column when
//     a column is cheaper than its `key=value` in the overflow.
//   - MIXED    ('mixed'): the curated columns plus the derived extras.
// Each candidate is graded on FIDELITY first (every sample value must round-trip
// through the CSV row back to the same key and value) and BYTES second. A
// learned column list is graded on events it was NOT learned from (2-fold), so a
// list that only fits its own sample cannot win on it.
//
// Events the plan does not cover (an unknown log type, a line with no key=value
// pairs) pass through UNCHANGED: nothing is ever lost to the format.
//
// A LEAF module: imports only its JSON contract. Read by the flow card
// (flow-builder), the README (pack-builder), the build (staged-build) and the
// authoritative scorer (pack-builder scoreAuthoritative), so the plan the card
// promises, the pipeline that ships, the README's Splunk app and the score are
// one computation over (sourcetype, sample).
import contractsDoc from '../config/splunk-csv-contracts.json';

export const SPLUNK_CSV_FORMAT = 'splunk_csv';
export const CSV_OVERFLOW_FIELD = 'extended';
export const CSV_HEADER_FIELD = 'syslog_header';
const BODY = '__csv_body';
const VARIANT = '__csv_variant';
const SINGLE_VARIANT = 'all';

// Never a column or an overflow pair: Splunk metadata and Cribl internals.
const META_FIELDS = new Set(['_raw', '_time', 'host', 'source', 'sourcetype', 'index']);
// Column names must be plain accessors (Cribl eval-init rejects hyphenated
// names even in field lists — CLAUDE.md, sanitizeCriblFunctions).
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRI = /^<\d{1,3}>/;
// One key=value pair: bare value, or double-quoted with backslash escapes.
const PAIR_RE = /(?:^|\s)([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g;
// Everything before the first pair (a syslog header), '' when the line starts with one.
const HEADER_RE = /^(.*?)(?:^|\s+)(?=[A-Za-z_][\w.-]*=)/;
// At least two pairs: the gate for "this line is key=value".
const KV_GATE = /(?:^|\s)[A-Za-z_][\w.-]*=[\s\S]*\s[A-Za-z_][\w.-]*=/;
// Field cleanup: drop pairs whose value is empty, N/A or null. A quoted value is
// matched (and kept) as a whole first, so `msg="reason=N/A"` is never touched.
// `\x22` = `"`: a literal quote inside a regex reads as a string to the
// Cribl-safety scanner.
const CLEANUP_RE = /(\s|^)[A-Za-z_][\w.-]*=(?:\x22\x22|\x22(?:N\/A|null)\x22|N\/A|null|)(?=\s|$)|(\x22(?:[^\x22\\]|\\.)*\x22)/gi;
const CLEANUP_SRC = String.raw`/(\s|^)[A-Za-z_][\w.-]*=(?:\x22\x22|\x22(?:N\/A|null)\x22|N\/A|null|)(?=\s|$)|(\x22(?:[^\x22\\]|\\.)*\x22)/gi`;
const HEADER_SRC = String.raw`/^(.*?)(?:^|\s+)(?=[A-Za-z_][\w.-]*=)/`;
const KV_GATE_SRC = String.raw`/(?:^|\s)[A-Za-z_][\w.-]*=[\s\S]*\s[A-Za-z_][\w.-]*=/`;

/** A sample needs this share of key=value lines before CSV is offered. */
export const KV_SHARE_MIN = 0.6;
/** Below this many events of a log type, a learned list is graded in-sample only. */
const CROSS_VALIDATE_MIN = 4;

// ---- The curated contracts --------------------------------------------------

export interface CuratedVariant { value: string; sourcetype: string; columns: string[] }
export interface CuratedContract {
  label: string;
  upstream: { pack: string; version: string; url: string; repo: string; splunkApp: string; license: string };
  variantField: string;
  overflowField: string;
  variants: CuratedVariant[];
}

const CONTRACTS = (contractsDoc as unknown as { contracts: Record<string, CuratedContract> }).contracts || {};

/** The curated contract for a canonical sourcetype, or null. */
export function curatedCsvContract(canonicalSourcetype: string): CuratedContract | null {
  return CONTRACTS[String(canonicalSourcetype || '')] || null;
}

export function curatedCsvContractKeys(): string[] {
  return Object.keys(CONTRACTS);
}

// ---- Reading and writing one event (mirrors the pipeline) -------------------

export interface KvRecord {
  /** The original line. */
  line: string;
  /** Pairs in parse order, after field cleanup. A repeated key keeps its last value. */
  pairs: Map<string, string>;
  /** Pairs field cleanup removed. */
  cleaned: number;
  /** Non-pair text before the first pair (syslog header), '' when none. */
  header: string;
}

function unquote(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"')
    ? v.slice(1, -1).replace(/\\(["\\])/g, '$1')
    : v;
}

function parsePairs(body: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const m of body.matchAll(PAIR_RE)) {
    pairs.delete(m[1]);
    pairs.set(m[1], unquote(m[2]));
  }
  return pairs;
}

/** Is this line key=value (the pipeline's own gate)? */
export function isKvLine(line: string): boolean {
  const body = String(line || '').replace(PRI, '');
  if (/^\s*[{[]/.test(body) || /CEF:\d\||LEEF:\d/.test(body) || /^\s*<[A-Za-z]/.test(body)) return false;
  return KV_GATE.test(body);
}

/** Read one line the way the pipeline does: strip PRI, header, cleanup, parse. */
export function readKvLine(line: string, cleanup = true): KvRecord {
  const body = String(line || '').replace(PRI, '');
  const header = (body.match(HEADER_RE) || [])[1] || '';
  const cleanedBody = cleanup ? body.replace(CLEANUP_RE, '$2') : body;
  const all = parsePairs(body);
  const pairs = parsePairs(cleanedBody);
  return { line: String(line), pairs, cleaned: Math.max(0, all.size - pairs.size), header };
}

/** Every key a key=value sample carries (what a filter over the parsed pairs can read). */
export function kvFieldNames(sampleText: string): Set<string> {
  const out = new Set<string>();
  for (const line of String(sampleText || '').split('\n')) {
    if (!isKvLine(line)) continue;
    for (const k of readKvLine(line, false).pairs.keys()) out.add(k);
  }
  return out;
}

/** Cribl serialize(kvp) value quoting — verified live (tests/lib/cribl-eval-sim.mjs). */
export function kvpValue(v: string): string {
  return v === '' || /[\s",=\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The event's fields as the serializers see them: the header field first, then the pairs. */
function eventFields(rec: KvRecord): [string, string][] {
  const out: [string, string][] = [];
  if (rec.header) out.push([CSV_HEADER_FIELD, rec.header]);
  for (const [k, v] of rec.pairs) if (!(rec.header && k === CSV_HEADER_FIELD)) out.push([k, v]);
  return out;
}

/** The CSV row the pipeline writes into `_raw` for this event. */
export function encodeCsvRow(rec: KvRecord, columns: string[], dropField?: string | null): string {
  const fields = eventFields(rec).filter(([k]) => k !== dropField && !META_FIELDS.has(k) && !k.startsWith('_') && !k.startsWith('cribl'));
  const byName = new Map(fields);
  const colSet = new Set(columns);
  const overflow = fields.filter(([k]) => !colSet.has(k)).map(([k, v]) => `${k}=${kvpValue(v)}`).join(' ');
  return [...columns.map(c => byName.get(c) ?? ''), overflow].map(csvCell).join(',');
}

/** RFC 4180 cells of one row (quoted or bare). */
export function parseCsvCells(row: string): string[] {
  const cells: string[] = [];
  let i = 0; const s = String(row ?? '');
  while (i <= s.length) {
    if (s[i] === '"') {
      let v = ''; i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') { v += '"'; i += 2; } else if (s[i] === '"') { i++; break; } else { v += s[i++]; }
      }
      cells.push(v);
      if (s[i] === ',') i++; else break;
    } else {
      const j = s.indexOf(',', i);
      if (j < 0) { cells.push(s.slice(i)); break; }
      cells.push(s.slice(i, j)); i = j + 1;
    }
  }
  return cells;
}

/** The key/value pairs a CSV row decodes back to (columns + overflow). */
export function decodeCsvRow(row: string, columns: string[]): Map<string, string> {
  const cells = parseCsvCells(row);
  const out = new Map<string, string>();
  columns.forEach((c, i) => { const v = cells[i]; if (v !== undefined && v !== '') out.set(c, v); });
  const overflow = cells[columns.length] ?? '';
  for (const [k, v] of parsePairs(overflow)) out.set(k, v);
  return out;
}

// ---- Grading -----------------------------------------------------------------

export interface CsvGrade {
  events: number;
  /** Sample values (pairs after cleanup, plus a header) checked. */
  values: number;
  /** Values that decode back to the same key and value. */
  carried: number;
  /** Keys whose value did not round-trip (or that Splunk DELIMS cannot read). */
  lost: string[];
  /** Pairs removed by field cleanup (empty / N/A / null) — not counted as loss. */
  cleaned: number;
  inBytes: number;
  outBytes: number;
  /** 0..1 share of the input bytes saved. */
  saving: number;
  /** True when the grade was measured on events the column list was not learned from. */
  heldOut: boolean;
}

const emptyGrade = (): CsvGrade => ({ events: 0, values: 0, carried: 0, lost: [], cleaned: 0, inBytes: 0, outBytes: 0, saving: 0, heldOut: true });

function addGrade(a: CsvGrade, b: CsvGrade): CsvGrade {
  const inBytes = a.inBytes + b.inBytes; const outBytes = a.outBytes + b.outBytes;
  return {
    events: a.events + b.events, values: a.values + b.values, carried: a.carried + b.carried,
    lost: [...new Set([...a.lost, ...b.lost])], cleaned: a.cleaned + b.cleaned,
    inBytes, outBytes, saving: inBytes ? 1 - outBytes / inBytes : 0, heldOut: a.heldOut && b.heldOut,
  };
}

export const gradeFidelity = (g: CsvGrade): number => (g.values ? g.carried / g.values : 1);

/** Grade one column list on records: round-trip every value, count bytes. */
export function gradeColumns(records: KvRecord[], columns: string[], dropField?: string | null): CsvGrade {
  const g = emptyGrade();
  const colSet = new Set(columns);
  for (const rec of records) {
    const row = encodeCsvRow(rec, columns, dropField);
    const back = decodeCsvRow(row, columns);
    g.events++; g.cleaned += rec.cleaned;
    g.inBytes += rec.line.length; g.outBytes += row.length;
    for (const [k, v] of eventFields(rec)) {
      if (k === dropField) { g.values++; g.carried++; continue; }   // carried by the sourcetype
      g.values++;
      // A quote inside a COLUMN value: Splunk's DELIMS extraction cannot read it.
      const unsafe = colSet.has(k) && /["\r\n]/.test(v);
      if (!unsafe && back.get(k) === v) g.carried++;
      else if (!g.lost.includes(k)) g.lost.push(k);
    }
  }
  g.saving = g.inBytes ? 1 - g.outBytes / g.inBytes : 0;
  return g;
}

/**
 * Option 3: learn a column list from records. A key is a column when a column
 * (one comma on every event, plus its value) is cheaper than `key=value` in the
 * overflow on the events that carry it; never a key whose values hold a quote
 * (DELIMS cannot read it) or that is not a plain accessor name.
 */
export function deriveColumns(records: KvRecord[], dropField?: string | null): string[] {
  const n = records.length;
  if (!n) return [];
  const stats = new Map<string, { present: number; colCost: number; extCost: number; first: number; unsafe: boolean }>();
  let order = 0;
  for (const rec of records) {
    for (const [k, v] of eventFields(rec)) {
      if (k === dropField || META_FIELDS.has(k) || k.startsWith('_') || k.startsWith('cribl')) continue;
      let s = stats.get(k);
      if (!s) { s = { present: 0, colCost: 0, extCost: 0, first: order++, unsafe: false }; stats.set(k, s); }
      s.present++;
      s.colCost += csvCell(v).length;
      // In the overflow: ` key=value`, and every quote doubles inside the CSV cell.
      const kv = `${k}=${kvpValue(v)}`;
      s.extCost += 1 + kv.length + (kv.match(/"/g) || []).length;
      if (/["\r\n]/.test(v)) s.unsafe = true;
    }
  }
  return [...stats.entries()]
    .filter(([k, s]) => SAFE_COLUMN.test(k) && !s.unsafe && s.colCost + n < s.extCost)
    .sort((a, b) => b[1].present - a[1].present || a[1].first - b[1].first)
    .map(([k]) => k);
}

/**
 * The mixed list: the curated columns these events actually use (curated order;
 * a curated column no event fills costs a comma on every row), minus any whose
 * value Splunk DELIMS cannot read, plus the learned extras.
 */
function mixColumns(curated: string[], learned: string[], records: KvRecord[]): string[] {
  const unsafe = new Set<string>(); const used = new Set<string>();
  for (const rec of records) {
    for (const [k, v] of eventFields(rec)) { used.add(k); if (/["\r\n]/.test(v)) unsafe.add(k); }
  }
  const base = curated.filter(c => used.has(c) && !unsafe.has(c));
  const have = new Set(base);
  return [...base, ...learned.filter(c => !have.has(c))];
}

export type CsvColumnOrigin = 'cribl-pack' | 'derived' | 'mixed';

export interface CsvCandidate { origin: CsvColumnOrigin; columns: string[]; grade: CsvGrade }

/**
 * Grade a learned list on events it did not see: learn on half, grade on the
 * other half, both ways. Tiny samples are graded in-sample and say so.
 */
function heldOutGrade(records: KvRecord[], learn: (train: KvRecord[]) => string[], dropField?: string | null): CsvGrade {
  if (records.length < CROSS_VALIDATE_MIN) return { ...gradeColumns(records, learn(records), dropField), heldOut: false };
  const a = records.filter((_, i) => i % 2 === 0);
  const b = records.filter((_, i) => i % 2 === 1);
  return addGrade(gradeColumns(b, learn(a), dropField), gradeColumns(a, learn(b), dropField));
}

const ORIGIN_RANK: Record<CsvColumnOrigin, number> = { 'cribl-pack': 0, mixed: 1, derived: 2 };

/**
 * The winner among graded candidates: highest fidelity, then the largest saving;
 * a tie (within half a point) keeps the curated contract, whose Splunk app
 * already exists. A learned list graded only in-sample never displaces a
 * curated one on bytes alone.
 */
export function pickCandidate(cands: CsvCandidate[]): CsvCandidate | null {
  if (!cands.length) return null;
  const hasCurated = cands.some(c => c.origin === 'cribl-pack');
  const fid = (c: CsvCandidate) => Math.round(gradeFidelity(c.grade) * 1000);
  const ranked = [...cands].sort((x, y) => fid(y) - fid(x)
    || (Math.abs(y.grade.saving - x.grade.saving) > 0.005 ? y.grade.saving - x.grade.saving : 0)
    || ORIGIN_RANK[x.origin] - ORIGIN_RANK[y.origin]);
  const top = ranked[0];
  if (hasCurated && top.origin !== 'cribl-pack' && !top.grade.heldOut) {
    const cur = cands.find(c => c.origin === 'cribl-pack')!;
    if (fid(cur) >= fid(top)) return cur;
  }
  return top;
}

// ---- The plan ------------------------------------------------------------------

export interface CsvVariantPlan {
  /** The variant-field value (`traffic`), or 'all' for a single-variant plan. */
  value: string;
  /** The Splunk sourcetype these rows carry (the props.conf stanza). */
  sourcetype: string;
  columns: string[];
  origin: CsvColumnOrigin;
  /** Sample events of this variant (0 = curated, not in the sample). */
  sampleEvents: number;
  grade: CsvGrade | null;
  /** Every candidate graded for this variant, winner included. */
  candidates: CsvCandidate[];
}

export interface SplunkCsvPlan {
  eligible: boolean;
  /** Why not, when ineligible; a one-line summary otherwise. */
  reason: string;
  sourcetype: string;
  curated: CuratedContract | null;
  variantField: string | null;
  variants: CsvVariantPlan[];
  /** The whole sample, passthrough lines included. */
  total: CsvGrade;
  /** Lines the plan passes through unchanged (no key=value, or an uncovered log type). */
  passthrough: number;
  /** A syslog header precedes the pairs on some line: carried in `syslog_header`. */
  header: boolean;
  /** The Splunk app the README ships. */
  splunkApp: string;
  /** Per sample line: does the plan re-encode it (false = passes through unchanged)? */
  coveredLines: boolean[];
  notes: string[];
}

function safeName(s: string): string {
  return String(s || 'source').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'source';
}

/**
 * Plan the Splunk CSV pipeline for a sample. Deterministic: the same
 * (sourcetype, sample) always yields the same plan, so the card, the pipeline,
 * the README and the score agree without passing the plan around.
 *
 * `splunkSourcetype` is the sourcetype the destination metadata stamps (used for
 * a single-variant plan); a curated plan uses each log type's own sourcetype.
 */
const planCache = new Map<string, SplunkCsvPlan>();
export function planSplunkCsv(canonicalSourcetype: string, sampleText: string, splunkSourcetype?: string): SplunkCsvPlan {
  const key = `${canonicalSourcetype}\u0000${splunkSourcetype || ''}\u0000${sampleText || ''}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const plan = computePlan(canonicalSourcetype, sampleText, splunkSourcetype);
  if (planCache.size >= 8) planCache.delete(planCache.keys().next().value as string);
  planCache.set(key, plan);
  return plan;
}

function computePlan(canonicalSourcetype: string, sampleText: string, splunkSourcetype?: string): SplunkCsvPlan {
  const lines = String(sampleText || '').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
  const curated = curatedCsvContract(canonicalSourcetype);
  const st = String(splunkSourcetype || canonicalSourcetype || 'kv_source');
  const kvLines = lines.filter(isKvLine);
  const base: SplunkCsvPlan = {
    eligible: false, reason: '', sourcetype: st, curated, variantField: curated?.variantField ?? null,
    variants: [], total: emptyGrade(), passthrough: lines.length, header: false, coveredLines: lines.map(() => false),
    splunkApp: curated?.upstream.splunkApp || `ZZZ-${safeName(st)}-csv`, notes: [],
  };
  if (!lines.length) return { ...base, reason: 'No sample: the CSV plan is graded on the sample.' };
  if (kvLines.length / lines.length < KV_SHARE_MIN) {
    return { ...base, reason: `The sample is not key=value (${kvLines.length}/${lines.length} lines): CSV re-encoding only pays when every line repeats its keys.` };
  }
  const lineRecs = lines.map(l => (isKvLine(l) ? readKvLine(l) : null));
  const records = lineRecs.filter((r): r is KvRecord => r != null);
  const header = records.some(r => r.header);
  const vf = curated?.variantField ?? null;
  const variants: CsvVariantPlan[] = [];
  const covered = new Set<KvRecord>();

  if (curated && vf) {
    for (const cv of curated.variants) {
      const recs = records.filter(r => r.pairs.get(vf) === cv.value);
      recs.forEach(r => covered.add(r));
      const cands: CsvCandidate[] = [];
      if (recs.length) {
        cands.push({ origin: 'cribl-pack', columns: cv.columns, grade: gradeColumns(recs, cv.columns, vf) });
        cands.push({ origin: 'mixed', columns: mixColumns(cv.columns, deriveColumns(recs, vf), recs), grade: heldOutGrade(recs, t => mixColumns(cv.columns, deriveColumns(t, vf), t), vf) });
        cands.push({ origin: 'derived', columns: deriveColumns(recs, vf), grade: heldOutGrade(recs, t => deriveColumns(t, vf), vf) });
      }
      const win = pickCandidate(cands);
      variants.push({
        value: cv.value, sourcetype: cv.sourcetype, columns: win ? win.columns : cv.columns,
        origin: win ? win.origin : 'cribl-pack', sampleEvents: recs.length,
        grade: win ? gradeColumns(recs, win.columns, vf) : null, candidates: cands,
      });
    }
    const uncovered = [...new Set(records.filter(r => !covered.has(r)).map(r => r.pairs.get(vf) || '(none)'))];
    if (uncovered.length) base.notes.push(`Log types the ${curated.upstream.pack} contract does not cover pass through unchanged: ${uncovered.join(', ')}.`);
  } else {
    records.forEach(r => covered.add(r));
    const cols = deriveColumns(records);
    const cands: CsvCandidate[] = [{ origin: 'derived', columns: cols, grade: heldOutGrade(records, t => deriveColumns(t)) }];
    variants.push({
      value: SINGLE_VARIANT, sourcetype: st, columns: cols, origin: 'derived', sampleEvents: records.length,
      grade: gradeColumns(records, cols), candidates: cands,
    });
  }

  // Whole-sample grade: covered lines as planned, everything else passes through.
  let total = emptyGrade();
  for (const v of variants) if (v.grade) total = addGrade(total, v.grade);
  const passLines = lines.filter((_, i) => !lineRecs[i] || !covered.has(lineRecs[i]!));
  const passBytes = passLines.reduce((n, l) => n + l.length, 0);
  total = addGrade(total, { ...emptyGrade(), events: passLines.length, inBytes: passBytes, outBytes: passBytes });
  const coveredLines = lineRecs.map(r => !!r && covered.has(r));
  if (!covered.size) {
    return { ...base, header, variants, total, passthrough: passLines.length, coveredLines, reason: `No sample line is a log type the ${curated?.upstream.pack || 'CSV'} contract covers: every line would pass through unchanged.` };
  }
  const fid = gradeFidelity(total);
  // The vendor app's name only when every layout IS the vendor's: same name with
  // different FIELDS for the same sourcetype is a silent column clash in Splunk.
  const differs = curated ? variants.filter(v => v.origin !== 'cribl-pack').map(v => v.value) : [];
  if (curated && differs.length) {
    base.splunkApp = `${curated.upstream.splunkApp}-pg`;
    base.notes.push(`The layout differs from the official ${curated.upstream.splunkApp} app for ${differs.join(', ')} (better on this sample), so the Splunk app is ${base.splunkApp}. Do not install both: remove ${curated.upstream.splunkApp} first — they define the same sourcetypes.`);
  }
  if (header) base.notes.push(`A syslog header precedes the pairs: it is carried in \`${CSV_HEADER_FIELD}\`.`);
  return {
    ...base, eligible: true, header, variants, total, passthrough: passLines.length, coveredLines,
    reason: `${Math.round(total.saving * 100)}% smaller on this sample, ${Math.round(fid * 1000) / 10}% of values round-trip.`,
  };
}

// ---- The pipeline ------------------------------------------------------------

export interface CsvGroup { groupId: string; groupName: string; groupDescription: string }
export const CSV_GROUPS = {
  read: { groupId: 'csvRead', groupName: 'Read the line', groupDescription: 'Work on a copy of _raw (without the syslog PRI); _raw itself is untouched until the CSV format group.' },
  cleanup: { groupId: 'csvCleanup', groupName: 'Field cleanup (no data lost)', groupDescription: 'Remove pairs whose value is empty, N/A or null. On by default; turn the function off to keep them.' },
  parse: { groupId: 'csvParse', groupName: 'Parse key=value', groupDescription: 'Parse the pairs into fields (vendor names, unchanged) and pick each line\'s CSV layout. A line no layout covers passes through unchanged.' },
  filters: { groupId: 'csvFilters', groupName: 'Filter examples (drops events, OFF)', groupDescription: 'Noise drops from the Cribl packs, shipped switched off. Enabling one removes events: that is a data decision, not a format one.' },
  format: { groupId: 'csvFormat', groupName: 'CSV format (Splunk licence reduction)', groupDescription: 'Rewrite _raw as a CSV row the README\'s Splunk app reads back. Lossless: values that are not a column go into the trailing `extended` key=value column.' },
} satisfies Record<string, CsvGroup>;

const q = (s: string) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The variant expression: which plan a line is written with, undefined = pass through. */
function variantExpr(plan: SplunkCsvPlan): string {
  const gate = `${KV_GATE_SRC}.test(${BODY})`;
  if (!plan.variantField) return `${gate} ? '${SINGLE_VARIANT}' : undefined`;
  const vf = plan.variantField;
  return `${gate} && [${plan.variants.map(v => q(v.value)).join(', ')}].includes(String(${vf})) ? String(${vf}) : undefined`;
}

/**
 * The pipeline functions, in two halves: `read` (parse the pairs — the filter
 * examples go between the halves, so they can read the fields) and `format`
 * (write each line as its variant's CSV row, then strip every parsed field).
 * Groups are carried on each function (`groupId`), comments head each group.
 */
export function splunkCsvFunctions(plan: SplunkCsvPlan): { read: any[]; format: any[] } {
  const g = CSV_GROUPS;
  const cur = plan.curated;
  const origins = [...new Set(plan.variants.map(v => v.origin))];
  const describe = `Splunk CSV — ${plan.reason} Column contract: ${origins.map(o => o === 'cribl-pack' ? `${cur?.upstream.pack} ${cur?.upstream.version}` : o === 'mixed' ? 'Cribl pack + learned columns' : 'learned from the sample').join(' / ')}. Splunk needs the ${plan.splunkApp} app from the pack README on the search head. Lines no plan covers pass through unchanged.`;
  const read: any[] = [
    { id: 'comment', filter: 'true', ...g.read, conf: { comment: describe } },
    {
      id: 'eval', filter: 'true', ...g.read, description: 'Copy _raw without its syslog PRI (Splunk strips it too); keep any header text',
      conf: {
        add: [
          { name: BODY, value: `String(_raw || '').replace(/^<\\d{1,3}>/, '')` },
          ...(plan.header ? [{ name: CSV_HEADER_FIELD, value: `(${BODY}.match(${HEADER_SRC}) || [])[1] || undefined` }] : []),
        ],
      },
    },
    { id: 'comment', filter: 'true', ...g.cleanup, conf: { comment: `${g.cleanup.groupName}: ${g.cleanup.groupDescription}` } },
    {
      id: 'eval', filter: 'true', ...g.cleanup, description: 'Remove empty / N/A / null pairs (quoted values are never searched inside)',
      conf: { add: [{ name: BODY, value: `${BODY}.replace(${CLEANUP_SRC}, '$2')` }] },
    },
    { id: 'comment', filter: 'true', ...g.parse, conf: { comment: `${g.parse.groupName}: ${g.parse.groupDescription}` } },
    {
      id: 'serde', filter: 'true', ...g.parse, description: 'Parse the key=value pairs (vendor field names, unchanged)',
      conf: { mode: 'extract', type: 'kvp', srcField: BODY, cleanFields: false, allowedKeyChars: [], allowedValueChars: [], remove: [] },
    },
    {
      id: 'eval', filter: 'true', ...g.parse,
      description: plan.variantField ? `Pick the CSV layout from ${plan.variantField} (unknown values pass through unchanged)` : 'Mark key=value lines for CSV (others pass through unchanged)',
      conf: { add: [{ name: VARIANT, value: variantExpr(plan) }] },
    },
  ];
  const format: any[] = [{ id: 'comment', filter: 'true', ...g.format, conf: { comment: `${g.format.groupName}: ${g.format.groupDescription} Column order is the Splunk FIELDS contract: change one only together with transforms.conf.` } }];
  const exclude = ['!_*', '!cribl*', '!index', '!host', '!source', '!sourcetype'];
  for (const v of plan.variants) {
    const sel = `${VARIANT} == ${q(v.value)}`;
    if (plan.variantField) {
      format.push({
        id: 'eval', filter: sel, ...g.format, description: `${v.value}: Splunk sourcetype ${v.sourcetype} (it carries ${plan.variantField}=${v.value})`,
        conf: { add: [{ name: 'sourcetype', value: q(v.sourcetype) }] },
      });
    }
    const drop = plan.variantField ? [`!${plan.variantField}`] : [];
    format.push({
      id: 'serialize', filter: sel, ...g.format, description: `${v.value}: every pair that is not a column → ${CSV_OVERFLOW_FIELD} (key=value)`,
      conf: { type: 'kvp', dstField: CSV_OVERFLOW_FIELD, fields: [...exclude, ...drop, ...v.columns.map(c => `!${c}`), '*'] },
    });
    format.push({
      id: 'serialize', filter: sel, ...g.format,
      description: `${v.value}: ${v.columns.length} columns + ${CSV_OVERFLOW_FIELD} → _raw (${v.origin === 'cribl-pack' ? `${cur?.upstream.pack} ${cur?.upstream.version}` : v.origin === 'mixed' ? 'Cribl pack + learned columns' : 'learned from the sample'})`,
      conf: { type: 'csv', dstField: '_raw', fields: [...v.columns, CSV_OVERFLOW_FIELD] },
    });
  }
  format.push({
    id: 'eval', filter: 'true', ...g.format, description: 'Remove every parsed field: only _raw and the Splunk metadata are sent',
    conf: { remove: ['cribl*', '*'], keep: ['_*', 'index', 'host', 'source', 'sourcetype'] },
  });
  return { read, format };
}

// ---- Grading the delivered output ---------------------------------------------

export interface CsvDeliveryAudit {
  applicable: boolean;
  score: number | null;
  grade: CsvGrade;
  /** Output events that are still the original line. */
  passthrough: number;
  reasons: string[];
}

/**
 * Did a value come back out of a row? Strict = by its column position (needs the
 * exact column list the pipeline wrote); otherwise by value: the pair is in the
 * overflow, or the value is one of the row's cells (each cell counts once).
 */
function rowCarries(raw: string, columns: string[] | null, strict: boolean): (k: string, v: string) => boolean {
  const cells = parseCsvCells(raw);
  if (strict && columns && cells.length === columns.length + 1) {
    const back = decodeCsvRow(raw, columns);
    return (k, v) => back.get(k) === v;
  }
  const overflow = parsePairs(cells[cells.length - 1] ?? '');
  const pool = new Map<string, number>();
  for (const c of cells.slice(0, -1)) if (c !== '') pool.set(c, (pool.get(c) || 0) + 1);
  return (k, v) => {
    if (overflow.get(k) === v) return true;
    const n = pool.get(v) || 0;
    if (!n) return false;
    pool.set(v, n - 1);
    return true;
  };
}

/**
 * Grade what the pipeline DELIVERED (live preview output) against the sample:
 * every sample value must come back out of the CSV row. The score is the share
 * of values that do; bytes saved are reported beside it.
 *
 * `strict` (the build, which holds the full sample and so the exact plan): a
 * value counts only under its own column. Otherwise (a re-score, whose sample
 * may be a truncated slice that would learn a different column list) only a
 * curated, sample-independent contract is checked by position; learned columns
 * are checked by value — a correct pipeline must never read as lossy.
 */
export function auditSplunkCsvDelivery(canonicalSourcetype: string, rawEvents: string[], outputEvents: any[], opts: { strict?: boolean } = {}): CsvDeliveryAudit {
  const lines = (rawEvents || []).map(String).filter(l => l.trim());
  const plan = planSplunkCsv(canonicalSourcetype, lines.join('\n'));
  const out = (outputEvents || []).filter(e => e && typeof e === 'object');
  if (!out.length || !lines.length) {
    return { applicable: false, score: null, grade: emptyGrade(), passthrough: 0, reasons: ['Splunk CSV not scorable: the pipeline returned no preview events.'] };
  }
  const bySt = new Map(plan.variants.map(v => [v.sourcetype, v]));
  const single = !plan.variantField ? plan.variants[0] : null;
  let g = emptyGrade();
  let passthrough = 0;
  let expected = 0; let notApplied = 0;
  const n = Math.min(lines.length, out.length);
  for (let i = 0; i < n; i++) {
    const line = lines[i]; const ev = out[i];
    const raw = typeof ev._raw === 'string' ? ev._raw : '';
    const covers = plan.coveredLines[i] === true;
    if (covers) expected++;
    g.events++; g.inBytes += line.length; g.outBytes += raw.length;
    if (raw === line) {
      passthrough++;
      if (covers) notApplied++;
      continue;
    }
    const rec = readKvLine(line);
    const v = covers ? (single || bySt.get(String(ev.sourcetype || ''))) : undefined;
    const carries = v ? rowCarries(raw, v.columns, opts.strict === true || v.origin === 'cribl-pack') : () => false;
    g.cleaned += rec.cleaned;
    for (const [k, val] of eventFields(rec)) {
      g.values++;
      if (plan.variantField && k === plan.variantField && v) { g.carried++; continue; }
      const unsafe = !!v && v.columns.includes(k) && /["\r\n]/.test(val);
      if (!unsafe && carries(k, val)) g.carried++;
      else if (!g.lost.includes(k)) g.lost.push(k);
    }
  }
  g.saving = g.inBytes ? 1 - g.outBytes / g.inBytes : 0;
  const reasons: string[] = [];
  if (out.length !== lines.length) reasons.push(`Preview returned ${out.length} event(s) for ${lines.length} sample line(s): graded the first ${n} in order.`);
  if (!g.values) {
    return {
      applicable: true, score: expected ? 0 : null, grade: g, passthrough,
      reasons: [...reasons, expected
        ? `The CSV format was not applied: all ${n} event(s) came out unchanged, ${expected} of them should be CSV rows.`
        : `Every event passed through unchanged (${passthrough}/${n}): no line is a log type the plan covers.`],
    };
  }
  // Fidelity of what was re-encoded, capped by the share of covered lines that
  // actually were: an unapplied format loses nothing but saves nothing either.
  const fidelity = Math.round(gradeFidelity(g) * 100);
  const applied = expected ? Math.round(100 * (expected - notApplied) / expected) : 100;
  const score = Math.min(fidelity, applied);
  reasons.unshift(`Splunk CSV: ${g.carried}/${g.values} sample values round-trip through the CSV row; ${Math.round(g.saving * 100)}% fewer bytes than the original lines${passthrough ? ` (${passthrough} line(s) passed through unchanged)` : ''}.`);
  if (notApplied) reasons.push(`The CSV format was not applied to ${notApplied} of the ${expected} line(s) it covers.`);
  if (g.lost.length) reasons.push(`Not carried: ${g.lost.slice(0, 8).join(', ')}${g.lost.length > 8 ? '…' : ''}.`);
  if (g.cleaned) reasons.push(`Field cleanup removed ${g.cleaned} empty / N/A / null pair(s) — not counted as loss.`);
  if (g.saving <= 0) reasons.push('The CSV rows are not smaller than the original lines: Splunk raw is the better choice for this source.');
  return { applicable: true, score, grade: g, passthrough, reasons };
}

// ---- The Splunk app (README) ---------------------------------------------------

function transformName(v: CsvVariantPlan): string {
  return `${safeName(v.sourcetype)}_csv`;
}

/** app.conf, props.conf and transforms.conf for the plan. */
export function splunkCsvApp(plan: SplunkCsvPlan): { app: string; appConf: string; propsConf: string; transformsConf: string } {
  const app = plan.splunkApp;
  // A curated plan keeps the vendor app's own stanza names (fortigate_extended_kvp).
  const stem = safeName(plan.curated ? (plan.variants[0]?.sourcetype || '').replace(/_[^_]*$/, '') : plan.sourcetype);
  const kvp = `${stem}_extended_kvp`;
  const props = [
    `# ${app} — default/props.conf (generated by Pack Generator from the pack's CSV pipeline)`,
    '# Search-time only: deploy on the SEARCH HEAD. Supplements the vendor TA; does not replace it.',
    '# KV_MODE = none doubles as the health check: if key=value pairs still extract but no',
    '# CSV columns do, this stanza is not applied (app on indexers only, or a TA rename).',
    '',
    ...plan.variants.flatMap(v => [
      `[${v.sourcetype}]`,
      'KV_MODE = none',
      `REPORT-${stem}_csv = ${transformName(v)}`,
      `REPORT-${stem}_extended_kvp = ${kvp}`,
      ...(plan.variantField ? [`# ${plan.variantField} is carried by the sourcetype; restore it as a field at no licence cost`, `EVAL-${plan.variantField} = "${v.value}"`] : []),
      '',
    ]),
  ].join('\n');
  const transforms = [
    `# ${app} — default/transforms.conf (generated by Pack Generator from the pack's CSV pipeline)`,
    '# FIELDS = the CSV serialize column order in the pipeline, byte for byte. Never reorder by hand.',
    '# KEEP_EMPTY_VALS = true is required: rows are sparse, and without it later columns shift.',
    '',
    ...plan.variants.flatMap(v => [
      `[${transformName(v)}]`,
      `# ${v.columns.length + 1} columns, last is the key=value overflow (${v.origin === 'cribl-pack' ? `${plan.curated?.upstream.pack} ${plan.curated?.upstream.version}` : v.origin === 'mixed' ? 'Cribl pack + learned columns' : 'learned from the sample'})`,
      'DELIMS = ","',
      `FIELDS = ${[...v.columns, CSV_OVERFLOW_FIELD].map(c => `"${c}"`).join(', ')}`,
      'KEEP_EMPTY_VALS = true',
      '',
    ]),
    `[${kvp}]`,
    '# The overflow column, read from _raw: bare values, quoted values and CSV doubled quotes.',
    'SOURCE_KEY = _raw',
    'REGEX = ([^\\s,="]+)=((?:""[^"]*(?:""[^"]*)*""|"[^"]*"|[^\\s,"]+))',
    'FORMAT = $1::$2',
    'REPEAT_MATCH = true',
    'MV_ADD = true',
    '',
  ].join('\n');
  const appConf = [
    '[install]', 'is_configured = true', '', '[ui]', 'is_visible = false', `label = ${app}`, '',
    '[launcher]', 'author = Pack Generator', `description = Search-time extraction for ${plan.variants.map(v => v.sourcetype).join(', ')} sent as CSV by Cribl Stream`, 'version = 1.0.0', '',
  ].join('\n');
  return { app, appConf, propsConf: props, transformsConf: transforms };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const originLabel = (plan: SplunkCsvPlan, o: CsvColumnOrigin) => o === 'cribl-pack'
  ? `${plan.curated?.upstream.pack} ${plan.curated?.upstream.version}` : o === 'mixed' ? 'Cribl pack + learned' : 'learned from sample';

/** The README section for a Splunk CSV pipeline. */
export function splunkCsvReadmeSection(plan: SplunkCsvPlan, pipelineId: string): string {
  if (!plan.eligible) {
    return `## Splunk CSV — \`${pipelineId}\`\n\nNot built as CSV: ${plan.reason} Every event is sent unchanged; use the Splunk raw pipeline instead.\n`;
  }
  const { app, appConf, propsConf, transformsConf } = splunkCsvApp(plan);
  const rows = plan.variants.map(v => {
    const gr = v.grade;
    const alts = v.candidates.filter(c => c.origin !== v.origin).map(c => `${originLabel(plan, c.origin)} ${pct(gradeFidelity(c.grade))} / ${pct(c.grade.saving)}${c.grade.heldOut ? '' : ' (in-sample)'}`).join('; ');
    return `| ${v.value} | \`${v.sourcetype}\` | ${v.columns.length} + extended | ${originLabel(plan, v.origin)} | ${v.sampleEvents} | ${gr ? pct(gradeFidelity(gr)) : '—'} | ${gr ? pct(gr.saving) : '—'} | ${alts || '—'} |`;
  });
  const cur = plan.curated;
  const checkSt = (plan.variants.find(v => v.sampleEvents) || plan.variants[0])?.sourcetype;
  return `## Splunk CSV — licence reduction (\`${pipelineId}\`)

**A format optimization, not a filter.** Each event's values are sent as one CSV row instead of repeating every \`key=\` on every line. Known keys are columns; every other pair goes into the last column, \`extended\`, as key=value, so **no value is dropped**. On this pack's sample: **${pct(plan.total.saving)} fewer bytes**, **${Math.round(gradeFidelity(plan.total) * 1000) / 10}% of values round-trip** back to the same field and value.

**Choose one Splunk option for this source.** The pack can hold both a Splunk raw pipeline and this one; each route sends its own copy. Keep the raw one if you cannot install a Splunk app, use this one to cut licence. Do not index both.

### How the columns were chosen

Every log type was graded with up to three column lists: the curated contract from ${cur ? `[${cur.upstream.pack} ${cur.upstream.version}](${cur.upstream.url}) (its ${cur.upstream.splunkApp} Splunk app)` : 'a Cribl pack (none exists for this source)'}, a list **learned from the sample** (a key is a column when that is cheaper than its \`key=value\`), and the two **mixed**. Fidelity decides first, then bytes; a learned list is graded on sample events it was not learned from. A tie keeps the curated contract.

| Log type | Sourcetype | Columns | Contract | Sample events | Values round-trip | Smaller by | Also graded (round-trip / smaller) |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}

${plan.passthrough ? `${plan.passthrough} sample line(s) are not covered and pass through unchanged.\n\n` : ''}${plan.notes.map(n => `- ${n}`).join('\n')}${plan.notes.length ? '\n\n' : ''}### The pipeline, by group

1. **Read the line** — works on a copy of \`_raw\`; the syslog PRI (\`<189>\`) is removed, as Splunk's own syslog input does, and any syslog header text is kept in \`${CSV_HEADER_FIELD}\`.
2. **Field cleanup (no data lost)** — removes pairs whose value is empty, \`N/A\` or \`null\`. On; switch the function off to keep them.
3. **Parse key=value** — the pairs become fields under their vendor names, and each line gets its log type's layout. A line no layout covers is sent unchanged.
4. **Filter examples (OFF)** — the Cribl pack noise drops for this source, switched off. Enabling one removes events.
5. **CSV format** — writes each covered event as its log type's CSV row and keeps only \`_raw\` + Splunk metadata.

In Cribl, enable or disable the **functions**, not only the group header: a group's switch does not reach the functions inside it.

### Splunk setup (search head)

1. Create \`$SPLUNK_HOME/etc/apps/${app}/default/\` and \`metadata/\` with the three files below.${cur && plan.variants.every(v => v.origin === 'cribl-pack') ? ` These match the [${cur.upstream.splunkApp}](${cur.upstream.repo}) app (plus \`KEEP_EMPTY_VALS\` and an \`EVAL-${plan.variantField}\` that restores the log type field).` : ''}
2. Keep the vendor TA installed: its FIELDALIAS / EVAL / LOOKUP still apply, the CSV columns carry the same raw field names.
3. Deploy on the **search head** (search-time extraction). Restart, or run \`| extract reload=T\`.
4. Check: \`sourcetype=${checkSt} | head 1\` shows the column fields. If only key=value pairs extract, the stanza is not applied — \`splunk btool props list ${checkSt} --debug\`.

\`default/app.conf\`

\`\`\`ini
${appConf}\`\`\`

\`default/props.conf\`

\`\`\`ini
${propsConf}\`\`\`

\`default/transforms.conf\`

\`\`\`ini
${transformsConf}\`\`\`

\`metadata/default.meta\`

\`\`\`ini
[]
export = system
\`\`\`

The FIELDS lists are the pipeline's CSV column order: if you change a column in the pipeline, change the same line here. To revert, disable this pipeline's route and remove the app.
`;
}

// ---- The flow card ---------------------------------------------------------------

export interface SplunkCsvAdvice {
  status: 'ready' | 'mismatch' | 'none';
  /** Recommend the CSV card over Splunk raw (lossless and worth it). */
  recommended: boolean;
  lines: string[];
  plan: SplunkCsvPlan | null;
}

/** Below this saving the CSV card is offered but not recommended. */
export const CSV_RECOMMEND_SAVING = 0.2;

/** What the Splunk CSV card says for this source and sample. */
export function splunkCsvAdvice(canonicalSourcetype: string, sampleText?: string | null): SplunkCsvAdvice {
  if (!sampleText || !String(sampleText).trim()) {
    const cur = curatedCsvContract(canonicalSourcetype);
    return {
      status: 'none', recommended: false, plan: null,
      lines: [cur
        ? `A curated contract exists (${cur.upstream.pack} ${cur.upstream.version}); add a sample to grade it.`
        : 'Add a key=value sample: the columns are learned and graded on it.'],
    };
  }
  const plan = planSplunkCsv(canonicalSourcetype, sampleText);
  if (!plan.eligible) return { status: 'mismatch', recommended: false, plan, lines: [plan.reason, 'Use Splunk raw for this source.'] };
  const fid = gradeFidelity(plan.total);
  const lossless = fid >= 0.999;
  const lines = [
    `Graded on your sample: ${pct(plan.total.saving)} fewer bytes, ${Math.round(fid * 1000) / 10}% of values round-trip.`,
    plan.curated
      ? `Columns: ${plan.variants.filter(v => v.sampleEvents).map(v => `${v.value} = ${originLabel(plan, v.origin)}`).join(', ') || plan.curated.upstream.pack}.`
      : 'Columns learned from your sample (no Cribl pack contract for this source).',
    `Splunk needs the ${plan.splunkApp} app (props + transforms in the pack README) on the search head.`,
  ];
  return { status: 'ready', recommended: lossless && plan.total.saving >= CSV_RECOMMEND_SAVING, plan, lines };
}
