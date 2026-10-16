// XSIAM parse-conformance — does XSIAM's OWN parser accept what we emit?
//
// Every other member of the conformance CAP family (Hard Rule 28) grades output
// against a schema WE map to. XSIAM is different in kind: it parses the vendor
// format itself, so a pack's whole job is to deliver a wire shape its rules accept
// and to tag it correctly. Tags are already checked. Nothing checked the SHAPE —
// which is the failure the XSIAM spec exists to prevent, because it is invisible
// from our side: the pack deploys, the events arrive, and the dataset either sits
// unparsed or is discarded, in the customer's tenant, silently.
//
// The contracts come from config/xsiam-rule-contracts.json — demisto/content's own
// `.xif` INGEST/MODEL rule bodies, which is the same text the tenant runs.
//
// HONEST SCOPE — three checks, and only two of them may CAP:
//
//  • RAW GATE (caps). 72 datasets gate on `_raw_log`, XSIAM's name for the line as
//    received, which for a Cribl feed IS our `_raw`. So the rule's own regex can be
//    run against our own output with no emulation and no inference. This is the
//    flagship check: Juniper SRX accepts a BSD stamp OR an RFC5424 `>`-priority ISO
//    stamp, so a pack that "helpfully" normalises the timestamp satisfies neither
//    and the dataset never parses.
//
//  • REQUIRED KEY (caps), CALIBRATED ON THE INPUT. A rule reading `FTNTFGTeventtime`
//    names a CEF extension key we must preserve. But a rule reading `Message` names a
//    field XSIAM's own syslog parser CREATES — demanding that in our payload would
//    false-fail a correct pack. So a key is demanded only if the INPUT sample already
//    carries it: then its absence downstream is OUR doing. Same discipline as Rule 7's
//    "no sample keys ⇒ not supported" and `holdToParser` in sample-extension —
//    calibrate on the source, never on an absolute list.
//
//  • TIMESTAMP FORMAT (advisory, NEVER caps). The 120 datasets with
//    `parse_timestamp()` formats mostly apply them to fields extracted INSIDE the
//    rule, so "no accepted format matches our raw" is weak evidence about a field we
//    may not be looking at. Reported for the repair prompt, not scored. The
//    normalised-timestamp failure it would be aimed at is already caught, harder, by
//    the raw gate.
//
// Severity follows `no_hit`, which is the whole reason phase 1 mirrored it: `drop`
// means the tenant DISCARDS a non-matching event (data loss), `keep` means it stores
// it unparsed (no XDM, no detections — a silent quality loss). Both cap into the fail
// band so neither can store a golden, and `drop` caps harder because it is worse.
//
// Pure and offline: two committed mirrors in, a verdict out, identical in both run
// modes (Hard Rule 18). Imports the resolver (already pure) and NEVER `pack-builder`
// — cycle plus the Rule 25 sanitizer graph.
import contractsData from '../config/xsiam-rule-contracts.json';
import { resolveXsiamDestination } from './xsiam-resolver';

interface RuleContract {
  dataset: string;
  contentPack: string;
  ingest?: { vendor: string; product: string; noHit: string | null; noHitConflict?: boolean; rule: string } | null;
  parse?: { filters: string[]; requiredFields: string[]; rawPatterns: { field: string; pattern: string }[]; timestampFormats: string[] } | null;
}

const CONTRACTS = (contractsData as unknown as { datasets: Record<string, RuleContract> }).datasets;

/** One enforced clause of the rule contract, with its measured outcome. */
export interface XsiamParseCheck {
  kind: 'raw-gate' | 'required-key' | 'timestamp';
  /** The contract text being enforced, verbatim, so a finding can quote the rule. */
  expression: string;
  /** False when the clause references something we cannot see; excluded from the score. */
  measurable: boolean;
  events: number;
  passed: number;
  /** Advisory checks are measured and reported but never affect the score. */
  advisory: boolean;
  detail: string;
}

export interface XsiamParseConformanceAudit {
  applicable: boolean;
  dataset: string | null;
  contentPack: string | null;
  vendor: string | null;
  product: string | null;
  noHit: 'drop' | 'keep' | null;
  /** What a mismatch COSTS in the tenant — the reason severity differs. */
  consequence: 'data-loss' | 'unparsed' | 'unknown';
  score: number;
  band: 'good' | 'warn' | 'fail';
  /** Cap the caller should apply, or null when there is nothing to cap. */
  cap: number | null;
  checks: XsiamParseCheck[];
  failures: string[];
  unmeasurable: string[];
  /**
   * Keys the parsing rule reads that the INPUT sample's wire format never carried, so
   * they cannot be graded (see the required-key calibration). Kept separate from
   * `unmeasurable` prose because it is the actionable half: FortiGate's rule reads the
   * CEF extension `FTNTFGTeventtime`, and a native key=value sample simply has no such
   * key — the honest report is "wrong wire format for this dataset", not silence.
   */
  keysAbsentFromInput: string[];
  reasons: string[];
}

/**
 * A `no_hit=drop` mismatch is data loss, so it lands deep in the fail band: it must
 * neither score good nor be stored as a golden, and it must pull the repair flow in
 * (Rule 13's threshold is 80).
 */
export const XSIAM_PARSE_DROP_CAP = 25;
/** `no_hit=keep` stores the event unparsed — useless but recoverable. Still fail band. */
export const XSIAM_PARSE_KEEP_CAP = 55;

const bandFor = (s: number): 'good' | 'warn' | 'fail' => (s >= 85 ? 'good' : s >= 60 ? 'warn' : 'fail');

const na = (dataset: string | null = null): XsiamParseConformanceAudit => ({
  applicable: false, dataset, contentPack: null, vendor: null, product: null, noHit: null,
  consequence: 'unknown', score: 0, band: 'fail', cap: null, checks: [], failures: [], unmeasurable: [],
  keysAbsentFromInput: [], reasons: [],
});

/** True for the destinations this checker grades. */
export function isXsiamParseConformanceFormat(destFormat: string): boolean {
  const f = destFormat || '';
  return f === 'xsiam' || f.startsWith('xsiam#');
}

/**
 * Look up a mirrored contract by dataset name. Exported for the SE skill (phase 5).
 *
 * Every one of the 307 mirrored keys carries XSIAM's `_raw` suffix
 * (`fortinet_fortigate_raw`) because that is the dataset the ingestion rule names,
 * but `resolveXsiamDestination()` reports the BARE `vendor_product` — so an exact
 * lookup matches nothing at all and the whole checker silently reports
 * `applicable: false` for every source. Normalise both spellings here, in the one
 * place that reads the artefact, rather than at each call site.
 */
export function xsiamRuleContract(dataset: string): RuleContract | null {
  if (!dataset) return null;
  const key = dataset.toLowerCase();
  const bare = key.replace(/_raw$/, '');
  return CONTRACTS[dataset] || CONTRACTS[key] || CONTRACTS[`${bare}_raw`] || CONTRACTS[bare] || null;
}

// ── reading our own output the way XSIAM would ───────────────────────────────

/** The line XSIAM receives. `_raw` is that line; a structured event has no gate to fail. */
function rawOf(event: any): string | null {
  if (event == null) return null;
  if (typeof event === 'string') return event;
  if (typeof event._raw === 'string') return event._raw;
  return null;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Read a wire key's value out of a raw line — CEF/LEEF extensions and key=value
 * payloads, plus a JSON line's top-level keys. Returns null when the key is absent.
 * A value runs to the next ` key=` so values containing spaces survive, which is
 * how CEF extensions actually look.
 *
 * Surrounding quotes are stripped, because XSIAM's rules compare the VALUE: FortiGate
 * writes `devname="rdagan01"`, and a gate like `to_string(x) ~= "\d{9}$"` cannot match
 * `"123456789"` with the closing quote still attached — that would report a
 * correctly-quoted line as a rule failure.
 */
export function readWireValue(raw: string, key: string): string | null {
  if (!raw || !key) return null;
  const trimmed = raw.trim();
  if (trimmed.charAt(0) === '{') {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && parsed[key] != null) return String(parsed[key]);
    } catch { /* not JSON after all — fall through to the key=value reader */ }
  }
  const match = new RegExp(`(?:^|[\\s|])${escapeRegex(key)}=(.*?)(?=\\s+[A-Za-z_][\\w.\\-]*=|$)`).exec(raw);
  if (!match) return null;
  return match[1].replace(/^"(.*)"$/s, '$1');
}

/** Compile an XQL `~=` pattern. RE2 constructs JS rejects make the clause unmeasurable. */
function compile(pattern: string): RegExp | null {
  try { return new RegExp(pattern); } catch { return null; }
}

// ── evaluating the subset of XQL a filter gate uses ──────────────────────────

type Truth = true | false | null;   // null = unknown, and it stays unknown

/**
 * Split a boolean expression on a top-level operator, ignoring occurrences inside
 * string literals — a regex in a gate frequently contains the word it splits on.
 */
function splitTopLevel(expr: string, op: 'or' | 'and'): string[] {
  const parts: string[] = [];
  const needle = new RegExp(`\\s${op}\\s`, 'i');
  let depth = 0, inString = false, start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) {
      const ahead = expr.slice(i, i + op.length + 2);
      if (needle.test(ahead) && ahead.length === op.length + 2) {
        parts.push(expr.slice(start, i));
        start = i + op.length + 2;
        i = start - 1;
      }
    }
  }
  parts.push(expr.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Evaluate one atom against a raw line. `resolve` returns the atom's field value, or
 * `undefined` when the field is something we cannot see — which yields `null`
 * (unknown) rather than a guess.
 */
function evalAtom(atom: string, resolve: (field: string) => string | null | undefined): Truth {
  const text = atom.replace(/^\(+|\)+$/g, '').trim();

  // <field> ~= "regex"   /   to_string(<field>) ~= "regex"
  const match = /^([\w.]+)\s*\(?\s*([\w.]*)\s*\)?\s*(~=|!~=|=|!=)\s*(?:"([\s\S]*)"|(null|[\w.]+))$/.exec(text);
  if (!match) return null;
  const [, head, inner, op, quoted, bare] = match;
  // `to_string(x)` / `lowercase(x)` — the wrapper is irrelevant to presence and to a
  // regex over the text form, so read through it rather than declaring it unmeasurable.
  const field = inner || head;
  const value = resolve(field);
  if (value === undefined) return null;

  if (bare === 'null') return op === '!=' ? value != null && value !== '' : value == null || value === '';
  if (quoted === undefined) return null;   // comparing two fields — not our subset
  if (value == null) return op === '!=' || op === '!~=';   // absent field fails a positive test

  if (op === '~=' || op === '!~=') {
    const re = compile(quoted);
    if (!re) return null;
    const hit = re.test(value);
    return op === '~=' ? hit : !hit;
  }
  return op === '=' ? value === quoted : value !== quoted;
}

/**
 * Three-valued (Kleene) evaluation of a filter gate. `or` can conclude PASS from one
 * known-true alternative even when its siblings are unreadable; `and` can conclude
 * FAIL from one known-false conjunct. Anything else stays unknown, because a
 * conjunction we can only half-see is not a verdict.
 */
export function evalFilterGate(expr: string, resolve: (field: string) => string | null | undefined): Truth {
  const ors = splitTopLevel(expr, 'or');
  if (ors.length > 1) {
    let sawUnknown = false;
    for (const part of ors) {
      const verdict = evalFilterGate(part, resolve);
      if (verdict === true) return true;
      if (verdict === null) sawUnknown = true;
    }
    return sawUnknown ? null : false;
  }
  const ands = splitTopLevel(expr, 'and');
  if (ands.length > 1) {
    let sawUnknown = false;
    for (const part of ands) {
      const verdict = evalFilterGate(part, resolve);
      if (verdict === false) return false;
      if (verdict === null) sawUnknown = true;
    }
    return sawUnknown ? null : true;
  }
  return evalAtom(expr, resolve);
}

// ── timestamp formats (advisory) ─────────────────────────────────────────────

// Palo Alto's formats are Abseil-flavoured strftime: the %F/%T/%X shorthands plus the
// %E* fractional-second and %Ez offset extensions, none of which plain strftime has.
// Ordered LONGEST-FIRST because these are matched by prefix — `%Ez` must be tried
// before `%E` would ever be considered, and `%E*S` before `%Ez`.
const TIME_DIRECTIVES: [string, string][] = [
  ['%E*S', '\\d{2}(?:\\.\\d+)?'], ['%E1S', '\\d{2}\\.\\d+'], ['%E2S', '\\d{2}\\.\\d+'],
  ['%E3S', '\\d{2}\\.\\d+'], ['%E4S', '\\d{2}\\.\\d+'], ['%E6S', '\\d{2}\\.\\d+'],
  ['%E9S', '\\d{2}\\.\\d+'], ['%Ez', '(?:[+-]\\d{2}:?\\d{2}|Z)'],
  ['%F', '\\d{4}-\\d{2}-\\d{2}'], ['%T', '\\d{2}:\\d{2}:\\d{2}'], ['%X', '\\d{2}:\\d{2}:\\d{2}'],
  ['%D', '\\d{2}/\\d{2}/\\d{2}'], ['%R', '\\d{2}:\\d{2}'],
  ['%Y', '\\d{4}'], ['%G', '\\d{4}'], ['%C', '\\d{2}'], ['%y', '\\d{2}'],
  ['%m', '\\d{2}'], ['%d', '\\d{2}'], ['%e', '\\s?\\d{1,2}'], ['%j', '\\d{3}'],
  ['%H', '\\d{2}'], ['%k', '\\s?\\d{1,2}'], ['%I', '\\d{2}'], ['%M', '\\d{2}'], ['%S', '\\d{2}'],
  ['%b', '[A-Za-z]{3}'], ['%h', '[A-Za-z]{3}'], ['%B', '[A-Za-z]+'],
  ['%a', '[A-Za-z]{3}'], ['%A', '[A-Za-z]+'],
  ['%p', '[APap][Mm]'], ['%z', '[+-]\\d{4}'], ['%Z', '[A-Za-z]{1,5}'], ['%s', '\\d{10}'],
  ['%n', '\\s+'], ['%t', '\\s+'], ['%%', '%'],
];

/**
 * Abseil/strftime format → regex source, in ONE left-to-right pass. Two passes (copy
 * the directives, then regex-replace them) cannot work: escaping the literals first
 * turns `%E*S` into `%E\*S`, and no token pattern matches it any more — measured, it
 * left every fractional-second format untranslated.
 */
/**
 * True when every `%`-directive in a format is one we know how to translate.
 *
 * An unknown directive survives translation as ESCAPED LITERAL TEXT, so the resulting
 * regex quietly demands the characters `%E3C` appear in the event — a format that can
 * never match, reported as an advisory failure. The corpus really contains one:
 * VMwareVCenter's legacy modeling rule says `parse_timestamp("%Y-%m-%d %H:%M:%E3C", …)`
 * next to a correct `%E3S` in the same file, i.e. an upstream typo. Guessing that
 * `%E3C` "means" `%E3S` would be inventing semantics for a mistake; skipping the format
 * is the same discipline as the rest of this module — unmeasurable is not a failure.
 */
export function isTranslatableTimeFormat(format: string): boolean {
  return !/%[A-Za-z*]/.test(timeFormatToRegex(format));
}

export function timeFormatToRegex(format: string): string {
  let out = '';
  let i = 0;
  outer: while (i < format.length) {
    if (format[i] === '%') {
      for (const [directive, replacement] of TIME_DIRECTIVES) {
        if (format.startsWith(directive, i)) { out += replacement; i += directive.length; continue outer; }
      }
    }
    out += escapeRegex(format[i]);
    i++;
  }
  return out;
}

// ── the audit ────────────────────────────────────────────────────────────────

/**
 * Grade a built XSIAM pipeline's output against the mirrored rule contract for the
 * dataset it routes to. `rawEvents` are the INPUT sample lines and are used only to
 * calibrate which required keys may honestly be demanded.
 */
export function auditXsiamParseConformance(opts: {
  sourcetype?: string | null;
  dataset?: string | null;
  outputEvents: any[];
  rawEvents?: string[];
  sampleFormat?: string | null;
}): XsiamParseConformanceAudit {
  const { sourcetype, outputEvents, rawEvents = [], sampleFormat } = opts;

  // The dataset may be given directly (the repair engine already resolved it) or
  // derived from the sourcetype through the same resolver the build used.
  let dataset = opts.dataset || null;
  let vendor: string | null = null;
  let product: string | null = null;
  if (!dataset && sourcetype) {
    const resolution = resolveXsiamDestination(sourcetype, { sampleFormat });
    dataset = resolution.dataset;
    vendor = resolution.vendor;
    product = resolution.product;
    if (!dataset && vendor && product) dataset = `${vendor}_${product}_raw`.toLowerCase();
  }
  if (!dataset) return na(null);

  const contract = xsiamRuleContract(dataset);
  if (!contract) return na(dataset);
  const parse = contract.parse;
  const noHitRaw = contract.ingest?.noHit || null;
  const noHit: 'drop' | 'keep' | null = noHitRaw === 'drop' ? 'drop' : noHitRaw === 'keep' ? 'keep' : null;
  const consequence: XsiamParseConformanceAudit['consequence'] =
    noHit === 'drop' ? 'data-loss' : noHit === 'keep' ? 'unparsed' : 'unknown';

  const base: XsiamParseConformanceAudit = {
    ...na(dataset),
    contentPack: contract.contentPack || null,
    vendor: contract.ingest?.vendor || vendor,
    product: contract.ingest?.product || product,
    noHit, consequence,
  };
  if (!parse) return base;

  // Only events carrying a raw line can be graded — XSIAM parses the line, so a
  // structured-only event has nothing for these rules to match.
  const raws = (outputEvents || []).map(rawOf).filter((r): r is string => typeof r === 'string' && r.trim() !== '');
  if (!raws.length) return base;

  const checks: XsiamParseCheck[] = [];
  const unmeasurable: string[] = [];

  // ── raw gates: ALTERNATIVE rules, never a conjunction ──────────────────────
  // `parse.filters` carries ONE entry per parsing rule — the extractor keeps
  // modeling-rule branches in `models[].filters` — and XSIAM tries every rule it has,
  // firing `no_hit` only when NONE matched. So an event is accepted if ANY gate accepts
  // it. Grading each gate separately and summing was a measured false positive: Jira
  // ships two parsing rules for one dataset, one for API/JSON ingestion
  // (`… and _raw_log = null`) and one for a raw feed (`_raw_log != null`), so a raw line
  // XSIAM would have parsed failed the first gate and capped a `no_hit=drop` dataset at
  // 25 — reported as data loss that would not have happened.
  const rawGates = (parse.filters || []).filter(f => /\b_raw_log\b|\b_raw\b/.test(f));
  for (const filter of parse.filters || []) {
    // A gate on a field the rule itself derives (tmp_raw_ts, cefName, …) is not ours to
    // satisfy; record it so the report says what was NOT checked.
    if (!rawGates.includes(filter)) unmeasurable.push(filter);
  }
  if (rawGates.length) {
    let passed = 0, unknown = 0;
    for (const raw of raws) {
      let verdict: Truth = false;
      for (const gate of rawGates) {
        const v = evalFilterGate(gate, (field) => (field === '_raw_log' || field === '_raw' ? raw : undefined));
        if (v === true) { verdict = true; break; }
        if (v === null && verdict === false) verdict = null;
      }
      if (verdict === true) passed++;
      else if (verdict === null) unknown++;
    }
    if (unknown === raws.length) unmeasurable.push(...rawGates);
    else checks.push({
      kind: 'raw-gate', expression: rawGates.join('  ── OR ──  '), measurable: true,
      events: raws.length, passed, advisory: false,
      detail: passed === raws.length
        ? `every event satisfies ${rawGates.length > 1 ? `one of the ${rawGates.length} parsing rules' raw-line gates` : `the rule's raw-line gate`}`
        : `${raws.length - passed}/${raws.length} events match ${rawGates.length > 1 ? 'none of the parsing rules XSIAM applies' : 'the gate XSIAM applies'} to the raw line`,
    });
  }

  // ── required keys, calibrated on the input ─────────────────────────────────
  const keysAbsentFromInput: string[] = [];
  for (const field of parse.requiredFields || []) {
    const presentInInput = rawEvents.some(line => readWireValue(String(line), field) != null);
    if (!presentInInput) {
      unmeasurable.push(`${field} (not a key of the input sample)`);
      keysAbsentFromInput.push(field);
      continue;
    }
    let passed = 0;
    for (const raw of raws) {
      const value = readWireValue(raw, field);
      if (value != null && value.trim() !== '') passed++;
    }
    checks.push({
      kind: 'required-key', expression: field, measurable: true, events: raws.length, passed, advisory: false,
      detail: passed === raws.length
        ? `required key ${field} survives to the output`
        : `${raws.length - passed}/${raws.length} events lost the key ${field}, which the parsing rule reads`,
    });
  }

  // ── timestamp formats (advisory) ───────────────────────────────────────────
  const allFormats = parse.timestampFormats || [];
  // A format holding a directive we cannot translate would compile into a regex demanding
  // the literal text `%E3C`, which matches nothing — an advisory failure invented by our
  // own gap rather than observed in the data. Drop it and say so.
  const formats = allFormats.filter(isTranslatableTimeFormat);
  for (const dropped of allFormats.filter(f => !formats.includes(f))) {
    unmeasurable.push(`parse_timestamp("${dropped}") — unrecognised directive, not translated`);
  }
  if (formats.length) {
    const regexes = formats.map(f => compile(timeFormatToRegex(f))).filter((r): r is RegExp => r != null);
    if (regexes.length) {
      let passed = 0;
      for (const raw of raws) if (regexes.some(re => re.test(raw))) passed++;
      checks.push({
        kind: 'timestamp', expression: formats.join(' | '), measurable: true, events: raws.length, passed, advisory: true,
        detail: passed === raws.length
          ? `every event carries a timestamp in a format the rule accepts`
          : `${raws.length - passed}/${raws.length} events carry no timestamp matching an accepted parse_timestamp format (advisory — the rule may apply these to a field it extracts itself)`,
      });
    }
  }

  // A key the rule reads that the input's wire format never carried is not gradeable,
  // but it is the most actionable thing we know: it usually means the sample is in a
  // format this dataset's rule does not read at all. Advisory — Rule 24's asserted-CEF
  // guard blocks that case earlier and harder, and inventing a cap here would punish a
  // pack for a key XSIAM itself derives.
  const absentReasons = keysAbsentFromInput.length
    ? [`${contract.contentPack || dataset}'s parsing rule reads ${keysAbsentFromInput.join(', ')}, which this sample's wire format does not carry — if XSIAM does not derive it, the dataset will not parse.`]
    : [];

  const scoring = checks.filter(c => c.measurable && !c.advisory);
  if (!scoring.length) {
    return {
      ...base, applicable: false, checks, unmeasurable, keysAbsentFromInput,
      reasons: [
        `XSIAM dataset ${dataset}: the parsing rule states no clause we can check against the output.`,
        ...absentReasons,
      ],
    };
  }

  const total = scoring.reduce((sum, c) => sum + c.events, 0);
  const good = scoring.reduce((sum, c) => sum + c.passed, 0);
  const score = total ? Math.round(100 * good / total) : 100;
  const failures = scoring.filter(c => c.passed < c.events).map(c => c.detail);

  // Two different failures need two different caps, and conflating them was measured to
  // punish a good pack: the shipped AWS audit-log fixture carries 19 CloudTrail records
  // plus one S3/SQS ENVELOPE record with no `eventTime`, which XSIAM really will not
  // parse — a true finding, but capping the whole pack to 55 for 1 event in 20 is the
  // kind of unfair harshness Rule 12 records ("AI unfairly tanked correct golden
  // pipelines"). So:
  //   • SYSTEMIC (every event rejected) → the CONSEQUENCE cap. The pack is wrong for
  //     this dataset, and the number must say what it costs the tenant (data loss vs
  //     stored-unparsed) rather than repeat the ratio, which is 0 and indistinguishable
  //     from a pipeline that emitted nothing at all.
  //   • PARTIAL → the conformance score itself: a pack cannot score above the share of
  //     its events XSIAM will actually parse. Proportionate, and still caps.
  const systemic = scoring.some(c => c.passed === 0) && good === 0;
  const cap = !failures.length
    ? null
    : systemic
      ? (noHit === 'drop' ? XSIAM_PARSE_DROP_CAP : XSIAM_PARSE_KEEP_CAP)
      : score;

  const reasons: string[] = [];
  if (failures.length) {
    const what = noHit === 'drop'
      ? `XSIAM will DISCARD non-matching events (no_hit=drop) — this is data loss in the tenant, not a low score`
      : noHit === 'keep'
        ? `XSIAM will store non-matching events UNPARSED (no_hit=keep) — no XDM fields, no detections`
        : `the parsing rule states no no_hit disposition, so the tenant's handling of a mismatch is unknown`;
    reasons.push(`${contract.contentPack || dataset}'s parsing rule rejects this output: ${failures.join('; ')}. ${what}.`);
    if (!systemic) reasons.push(`${score}% of events satisfy the rule, so the cap is ${score} rather than the ${noHit === 'drop' ? XSIAM_PARSE_DROP_CAP : XSIAM_PARSE_KEEP_CAP} a wholly unparseable pack would get.`);
  } else {
    reasons.push(`XSIAM ${dataset}: output satisfies ${scoring.length} checkable clause(s) of ${contract.contentPack || 'the'} parsing rule.`);
  }
  for (const check of checks.filter(c => c.advisory && c.passed < c.events)) reasons.push(check.detail);
  reasons.push(...absentReasons);

  return {
    ...base, applicable: true, score, band: bandFor(score), cap, checks, failures, unmeasurable,
    keysAbsentFromInput, reasons,
  };
}
