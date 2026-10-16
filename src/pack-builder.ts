import type { WizardState, DestFormat } from './types';
import goldenFormatsData from '../config/golden-formats.json';
import { resolveSentinelTable, type SentinelTableKnowledge } from './sentinel-knowledge';
import { csvToDelimSerde } from './extraction-delimiter';
import xsiamSourcesData from '../config/xsiam-sources.json';
import sourceSamplesData from '../config/source-samples.json';
import {
  XSIAM_T1C_SCORE_CEILING,
  buildXsiamBreakerYml,
  buildXsiamConstructedTags,
  buildXsiamRoutingFunctions,
  lintXsiamBuild,
  replayXsiamFunctions,
  resolveXsiamForBuild,
  xsiamProvenanceComment,
} from './xsiam-builder';
import { resolveXsiamDestination } from './xsiam-resolver';
import { buildRawFidelityTagFunctions } from './raw-fidelity';
import { auditCefFormat, type CefFormatAudit } from './cef-format';
import { buildCanonicalAliasAdd, repairCanonicalAliases, producedParseFields } from './mapping-aliases';
import { auditSchemaConformance, auditUdmConformance, isSchemaConformanceFormat, isUdmConformanceFormat, type SchemaConformanceAudit, type UdmConformanceAudit } from './schema-conformance';
import { ECS_SCHEMA_VERSION } from './ecs-conformance';
import { auditXsiamParseConformance, isXsiamParseConformanceFormat, type XsiamParseConformanceAudit } from './xsiam-parse-conformance';
import { scoreOcsfAgainstSchema, groundOcsfPipeline, ocsfAttributeTypes, ocsfClassByUid, ocsfClassDef, ocsfClassNameForKey, ocsfClassUidForKey, ocsfKeyForClass, resolveOcsfClassChoice, type OcsfSchemaScore } from './ocsf-schema';
import { maskQuoted, replaceIdent, stripQuoted, structureOcsfMappingFields } from './ocsf-finalize';
import { guardZeroDefaultFor } from './zero-defaults';

export { XsiamBuildError } from './xsiam-builder';

// --- Source recognition + parser layer (moved to the lean, AI-free module) ---
// Imported here for internal use AND re-exported so every existing importer of
// pack-builder keeps working byte-for-byte (Hard Rule 25 second-build-target split).
import {
  SELF_HEALED_FIELDS,
  SOURCETYPE_DATACLASS,
  stripOuterQuotes,
  extractSampleKeys,
  normalizeSourcetypeName,
  canonicalizeSourcetype,
  describeSourcetype,
  getParserFieldNames,
  getParserForSourcetype,
  getSupportedSourcetypeCatalog,
  parserProducedFields,
  sampleFingerprint,
  sampleMatchesSourceExpectation,
  sourceMayEmitNativeFalsy,
  setGoldenPathPredicate,
  WINDOWS_OCSF_DISPATCH_CLASSES,
  WINDOWS_OCSF_DISPATCH_FIELDS,
  type ContractLintFinding,
  type DataClass,
  type ExtractionCoverage,
  type PipelineFunction,
  type SampleFingerprint,
} from './source-recognition';
export {
  sampleFingerprint,
  sampleMatchesSourceExpectation,
  canonicalizeSourcetype,
  isKnownSourcetype,
  hasSourceSample,
  getSupportedSourcetypeCatalog,
  recognizeSourcetype,
  describeSourcetype,
  getBundledDatatypeParsers,
  getDatatypeParserStore,
  installDatatypeParserOverlay,
  getDatatypeParserFunctions,
  matchDatatypeParserBySample,
  matchGoldenSourceBySample,
  matchJsonSignature,
  sampleStartsWithCef,
  recognizeCefSource,
  nativeSourceWireFormats,
  parserWireFormats,
  getParserForSourcetype,
  parserProducedFields,
  getParserFieldNames,
  isWindowsCodeFamily,
  withWindowsOcsfDispatch,
} from './source-recognition';
export type {
  ContractLintFinding,
  ExtractionCoverage,
  SampleFingerprint,
  PipelineFunction,
  RecognitionStatus,
  SourcetypeRecognition,
  RecognitionEvidence,
  DatatypeSampleMatch,
  DataClass,
  CefSourceRecognition,
} from './source-recognition';
// Give the lean module the golden-path predicate it can't compute itself.
setGoldenPathPredicate(hasGoldenFormatPath);

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

// Reserved words that are EXPRESSION OPERATORS, not field references. When one
// of these appears bare in a valid single expression it is always an operator
// (e.g. `new Date(...)`, `typeof x`, `delete o.k`), never a field name — so it
// must NOT be rewritten to __e['...']. (Statement keywords like function/return/
// if/var never reach here: isSafeEvalExpression rejects them first.)
const JS_OPERATOR_KEYWORDS = new Set([
  'new','typeof','void','delete','instanceof',
]);

function escapeReservedWords(expr: string): string {
  // Match a whole string literal (single/double/backtick, with escapes) OR a
  // bare identifier. String literals are returned verbatim so reserved words
  // *inside* quotes (e.g. 'user in group') are never rewritten — only bare
  // identifier field references outside strings get escaped to __e['...'].
  const STRING_OR_IDENT = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_]\w*/g;
  return expr.replace(STRING_OR_IDENT, (match, offset: number) => {
    // A string literal starts with a quote char — leave it untouched.
    const first = match[0];
    if (first === "'" || first === '"' || first === '`') return match;
    if (JS_GLOBALS.has(match)) return match;
    // Operator keywords (new/typeof/delete/…) are never field refs — leave them.
    if (JS_OPERATOR_KEYWORDS.has(match)) return match;
    if (!JS_RESERVED_FIELDNAMES.has(match)) return match;
    // Don't escape if preceded by dot (property access like obj.in)
    if (offset > 0 && expr[offset - 1] === '.') return match;
    return `__e['${match}']`;
  });
}

// Cribl's jsExpression accepts a single expression only — not statements,
// function bodies, or IIFEs. The AI advisor occasionally returns a
// multi-statement function despite the prompt forbidding it; such an
// expression must be rejected before it reaches the pipeline config or Cribl
// fails validation with "Unexpected token '{'". Returns true only when `expr`
// is a safe single expression.
// Exported for src/postprocess-optimization.ts, which must reject an unsafe
// optimization predicate at LOAD time rather than at Cribl PATCH time.
export function isSafeEvalExpression(expr: string): boolean {
  // Strip string literals so their contents don't trip the keyword scan.
  const stripped = expr
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  // Statement-level constructs that can only appear in a function body / IIFE.
  if (/\bfunction\b/.test(stripped)) return false;
  if (/\breturn\b/.test(stripped)) return false;
  if (/=>/.test(stripped)) return false;             // arrow function
  if (/;/.test(stripped)) return false;              // statement separator
  if (/\?\./.test(stripped)) return false;           // optional chaining (?.[  ?.() ?.x) — unsupported by Cribl eval
  if (/\?\?/.test(stripped)) return false;           // nullish coalescing (??) — unsupported by Cribl eval
  if (/\b(var|let|const|if|else|for|while|switch|do|try|catch|throw)\b/.test(stripped)) return false;
  // Array/object literal constructions ([{key:val}]) aren't valid Cribl eval
  if (/\[\s*\{/.test(stripped)) return false;
  // Object literals as the expression root aren't valid either
  if (/^\s*\{/.test(stripped) && !/^\s*\{[^}]*\}\s*\.\s*/.test(stripped)) return false;
  // Validate regex literals — AI sometimes emits /:pattern// (double slash) or unterminated classes
  const regexLiterals = stripped.match(/\/(?:[^/\\]|\\.)+\//g) || [];
  for (const lit of regexLiterals) {
    try { new RegExp(lit.slice(1, -1)); } catch { return false; }
  }
  // A bare '@' (outside a string literal, already stripped above) is an illegal
  // Cribl eval token — a '@'-prefixed field ref that stripAtPrefixIdentifiers
  // didn't rewrite must never reach the pipeline PATCH.
  if (/@/.test(stripped)) return false;
  if (hasAssignmentOperator(expr)) return false;
  return true;
}

// Cribl's jsExpression validator rejects ANY assignment operator and fails the
// WHOLE pipeline PATCH ("Unallowed assignment operator found in expression"),
// so one `__e[name] = value` sinks every other function in the pipeline. To
// write a field whose NAME is only known at runtime, use the side-effect form
// `Object.assign(__e, {[name]: value})` — verified accepted, and it produces
// the field at runtime.
// The scan ignores comparisons (== === != !== <= >=) and arrow heads, and runs
// after string/template/regex literals are blanked so a `key=value` pattern or
// a `cs1=` CEF fragment can't read as an assignment.
export function hasAssignmentOperator(expr: string): boolean {
  const blanked = expr
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, ' ')
    .replace(/=>/g, '  ');
  return /(?<![=!<>])=(?!=)/.test(blanked);
}

// Cribl's eval `add.name` is a property-accessor path. Each dotted segment must
// be a valid JS identifier (letters/digits/_/$, not starting with a digit).
// Names like `@timestamp`, `ecs.version-x`, or `1st` break Cribl with
// "Failed to build property accessor … Unexpected token ILLEGAL". The AI
// sometimes emits ECS's `@timestamp` etc., so we validate and drop these.
// Exported alongside isSafeEvalExpression for the optimization rule loader.
export function isSafeFieldName(name: string): boolean {
  if (!name) return false;
  return name.split('.').every(seg => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg));
}

// ECS canonically uses '@timestamp', but Cribl can't create '@'-prefixed
// fields ("Unexpected token ILLEGAL"). Strip a leading '@' from any
// single-quoted identifier literal so '@timestamp' -> 'timestamp'.
function stripAtPrefixLiterals(expr: string): string {
  return expr.replace(/'@([A-Za-z_][\w.]*)'/g, "'$1'");
}

// The BARE counterpart: strip a leading '@' from an UNQUOTED field reference so
// `Number(@timestamp || created_at)` -> `Number(timestamp || created_at)`. The AI
// reads ECS/github's raw `@timestamp` JSON key verbatim in a mapping expression;
// a bare `@` is an illegal token and fails pipeline-write with "Invalid or
// unexpected token" (github_audit crashed the whole PATCH this way). '@' inside a
// string literal (emails, `user@host`) is preserved — only unquoted refs change.
function stripAtPrefixIdentifiers(expr: string): string {
  const TOKEN = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|@([A-Za-z_][\w.]*)/g;
  return expr.replace(TOKEN, (m, ident) => (ident !== undefined ? ident : m));
}

// Cribl's kvp/csv serde `cleanFields:true` replaces every char that isn't a
// valid identifier char with '_'. We mirror that rule so eval expressions that
// READ a serde-produced field (e.g. this['SY-MANDT'] from an SAP audit body)
// reference the same cleaned name the serde will actually create (SY_MANDT).
function cleanCriblFieldName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, '_');
}

// Cribl regex_extract requires a /pattern/flags literal. Normalize a possibly
// BARE pattern to that form (generators sometimes emit `^(\w{3}...)` with no
// slashes → Cribl rejects it at pipeline-write). If it's already /…/ we keep it;
// otherwise wrap it, escaping any unescaped forward slashes in the body.
function ensureRegexLiteral(rx: string): string {
  const s = String(rx || '');
  if (!s) return s;
  // Already a literal: starts with / and has a closing / (optionally + flags).
  if (/^\/.*\/[a-z]*$/is.test(s)) {
    // Validate flags and pattern
    const lastSlash = s.lastIndexOf('/');
    const pattern = s.slice(1, lastSlash);
    const flags = s.slice(lastSlash + 1);
    if (/[^gimsuy]/.test(flags)) return `/${pattern}/`;  // strip invalid flags
    try { new RegExp(pattern, flags); } catch { return ''; }
    return s;
  }
  const body = s.replace(/\//g, '\\/');   // escape bare slashes so the wrap is valid
  try { new RegExp(body); } catch { return ''; }
  return `/${body}/`;
}

// Rewrite bracket-notation reads of a field whose name isn't a valid accessor
// (this['SY-MANDT'] or e['SY-MANDT']) to the cleaned bare identifier a
// cleanFields serde produces (SY_MANDT). Cribl builds an accessor for the
// bracketed literal at eval-init time and throws "Failed to build property
// accessor path=…" on the hyphen — even inside a string key. Only rewrites
// keys that are otherwise-valid identifiers once cleaned; leaves normal
// dynamic indexing (obj[i], arr[0]) untouched.
function rewriteInvalidBracketReads(expr: string): string {
  return expr.replace(/\[(['"])([^'"]+)\1\]/g, (match, _q, key: string) => {
    if (isSafeFieldName(key)) return match;                 // valid literal key — leave
    const cleaned = cleanCriblFieldName(key);
    if (!isSafeFieldName(cleaned)) return match;            // still invalid — leave for the expression guard to drop
    return `['${cleaned}']`;
  });
}

// An Eval assignment that writes a field back to itself has no effect and is
// frequently produced by schema/AI mappings (for example eventId=eventId).
// Accept the equivalent explicit event-access forms too so every generation
// path gets the same cleanup at the sanitizer boundary.
function isIdentityEvalAssignment(name: string, value: string): boolean {
  const expr = value.trim();
  if (expr === name) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:__e|this)(?:\\.${escaped}|\\[['"]${escaped}['"]\\])$`).test(expr);
}

// Sanitize an AI-generated/repaired functions array so a single bad entry
// can't sink the whole pipeline PATCH with a Cribl 500. Drops eval add-entries
// and rename pairs with invalid field names or non-single-expression values,
// escapes reserved words, and strips '@'-prefixed field names. Shared by the
// repair path (client-side, iframe mode) and mirrored in schema-validator.mjs
// for the dev-server backend.
/** Build options the sanitizer applies on top of its Cribl-safety fixes. */
export interface SanitizeOptions {
  /** Quality setting `dropEmptyJsonFields`: drop null/blank top-level JSON fields at parse time. */
  dropEmptyJsonFields?: boolean;
}

// The Parser's "Fields filter expression": keep a parsed field unless it is
// null/undefined or the empty string. `!==''` (not falsy) so 0 and false stay.
export const JSON_EMPTY_FIELD_FILTER_EXPR = "value!=null && value!==''";

/**
 * With `dropEmptyJsonFields` on, give a JSON Parser (serde, type json) the
 * empty-field filter — unless it already carries its own `fieldFilterExpr`,
 * which is kept as written. Every other function is returned untouched.
 */
export function withJsonEmptyFieldFilter(fn: any, options: SanitizeOptions = {}): any {
  if (!options.dropEmptyJsonFields) return fn;
  if (fn?.id !== 'serde' || fn?.conf?.type !== 'json') return fn;
  const existing = fn.conf.fieldFilterExpr;
  if (typeof existing === 'string' && existing.trim()) return fn;
  return { ...fn, conf: { ...fn.conf, fieldFilterExpr: JSON_EMPTY_FIELD_FILTER_EXPR } };
}

export function sanitizeCriblFunctions(functions: any[], options: SanitizeOptions = {}): { functions: any[]; dropped: string[] } {
  const dropped: string[] = [];
  const clean: any[] = [];
  for (const raw of csvToDelimSerde(functions)) {
    const fn = withJsonEmptyFieldFilter(raw, options);
    if (fn?.id === 'serde' && (fn?.conf?.type === 'kvp' || fn?.conf?.type === 'csv')) {
      // KVP/CSV serde derives field names from the DATA. Sources like SAP audit
      // logs carry keys with hyphens (SY-MANDT, SY-UNAME) that Cribl can't turn
      // into accessor paths. Force cleanFields:true so the serde sanitizes those
      // keys to '_' (SY_MANDT); rewriteInvalidBracketReads below realigns the
      // eval reads to the same cleaned names.
      clean.push({ ...fn, conf: { ...fn.conf, cleanFields: true } });
    } else if (fn?.id === 'eval' && Array.isArray(fn?.conf?.add)) {
      const keptAdds: any[] = [];
      for (const a of fn.conf.add) {
        let value = typeof a?.value === 'string' ? a.value : (a?.value == null ? '' : String(a.value));
        value = rewriteInvalidBracketReads(stripAtPrefixIdentifiers(stripAtPrefixLiterals(value)));
        const name = typeof a?.name === 'string' ? a.name.replace(/^@/, '') : a?.name;
        if (!isSafeFieldName(name)) { dropped.push(`name "${a?.name}"`); continue; }
        if (!isSafeEvalExpression(value)) { dropped.push(`${name}=${String(value).slice(0, 60)}`); continue; }
        if (isIdentityEvalAssignment(name, value)) { dropped.push(`identity ${name}=${value}`); continue; }
        keptAdds.push({ ...a, name, value: escapeReservedWords(value) });
      }
      const hasCleanup = ['remove', 'keep'].some(key => Array.isArray(fn.conf[key]) && fn.conf[key].length > 0);
      if (keptAdds.length === 0 && fn.conf.add.length > 0 && !hasCleanup) { dropped.push(`(whole eval "${fn.description || ''}")`); continue; }
      // remove/keep are accessor-path arrays too — a hyphenated entry (the AI
      // often lists the raw serde keys it's cleaning up) fails accessor build
      // exactly like an add.name. Realign to the cleaned name Cribl produces.
      const cleanConf: any = { ...fn.conf, add: keptAdds };
      for (const key of ['remove', 'keep'] as const) {
        if (Array.isArray(fn.conf[key])) {
          cleanConf[key] = fn.conf[key].map((x: any) =>
            (typeof x === 'string' && !isSafeFieldName(x.replace(/\*/g, 'x')))
              ? cleanCriblFieldName(x) : x);
        }
      }
      clean.push({ ...fn, conf: cleanConf });
    } else if (fn?.id === 'rename' && typeof fn?.conf?.renameExpr === 'string') {
      const renameExpr = stripAtPrefixIdentifiers(stripAtPrefixLiterals(fn.conf.renameExpr));
      if (!isSafeEvalExpression(renameExpr)) { dropped.push(`(rename "${fn.description || ''}")`); continue; }
      clean.push({ ...fn, conf: { ...fn.conf, renameExpr } });
    } else if (fn?.id === 'rename' && Array.isArray(fn?.conf?.rename)) {
      const keptPairs: any[] = [];
      for (const p of fn.conf.rename) {
        const currentName = typeof p?.currentName === 'string' ? p.currentName.replace(/^@/, '') : p?.currentName;
        const newName = typeof p?.newName === 'string' ? p.newName.replace(/^@/, '') : p?.newName;
        if (!isSafeFieldName(currentName) || !isSafeFieldName(newName)) { dropped.push(`rename ${p?.currentName}->${p?.newName}`); continue; }
        keptPairs.push({ ...p, currentName, newName });
      }
      if (keptPairs.length === 0 && fn.conf.rename.length > 0) { dropped.push(`(whole rename "${fn.description || ''}")`); continue; }
      clean.push({ ...fn, conf: { ...fn.conf, rename: keptPairs } });
    } else if (fn?.id === 'regex_extract') {
      // Cribl requires regex literals in /pattern/flags form. Generators (incl.
      // the Copilot schematizer for some sources) sometimes emit a BARE pattern
      // (^(\w{3}...)) which Cribl rejects at pipeline-write ("Unexpected
      // character '^'"). Slash-wrap `regex` and every `regexList[].regex`.
      const conf: any = { ...fn.conf };
      if (typeof conf.regex === 'string') {
        conf.regex = ensureRegexLiteral(conf.regex);
        if (!conf.regex) { dropped.push(`(invalid regex in "${fn.description || 'regex_extract'}")`); continue; }
      }
      if (Array.isArray(conf.regexList)) {
        // Cribl requires regexList entries to be OBJECTS ({regex, ...}). A
        // reasoning model (opus-5) sometimes emits a bare array of pattern
        // STRINGS (regexList:["^(\\w+)…", …]) which Cribl rejects at
        // pipeline-write (500: "/regexList/0 should be object"). Coerce a string
        // element into {regex:<literal>} before slash-wrapping.
        conf.regexList = conf.regexList
          .map((r: any) => (typeof r === 'string' ? { regex: r } : r))
          .map((r: any) =>
            (r && typeof r.regex === 'string') ? { ...r, regex: ensureRegexLiteral(r.regex) } : r)
          .filter((r: any) => r?.regex);  // drop entries with invalid regex
      }
      if (!conf.regex && (!conf.regexList || conf.regexList.length === 0)) {
        dropped.push(`(empty regex_extract "${fn.description || ''}")`); continue;
      }
      // Cribl validates the "Max Extractions" field (conf.iterations) as an
      // integer in [1, 10000]; a generator that emits 0, a float, or an
      // out-of-range value makes the pipeline push fail 500 ("The maximum
      // number of iterations must be set between 1 and 10,000!"). Clamp when
      // present; leave absent so Cribl applies its own default (100).
      if (conf.iterations != null) {
        const n = Math.floor(Number(conf.iterations));
        if (!Number.isFinite(n)) delete conf.iterations;
        else conf.iterations = Math.min(10000, Math.max(1, n));
      }
      clean.push({ ...fn, conf });
    } else if (fn?.id === 'auto_timestamp') {
      // auto_timestamp.timestamps[] carries {regex, strptime}; the schematizer
      // sometimes emits the regex BARE (no /…/), which Cribl rejects at
      // pipeline-write exactly like regex_extract. Slash-wrap each.
      const conf: any = { ...fn.conf };
      if (Array.isArray(conf.timestamps)) {
        conf.timestamps = conf.timestamps.map((t: any) =>
          (t && typeof t.regex === 'string') ? { ...t, regex: ensureRegexLiteral(t.regex) } : t);
      }
      clean.push({ ...fn, conf });
    } else if (fn?.id === 'code' && fn?.conf?.maxNumOfIterations != null) {
      // Cribl caps the Code function's "Maximum number of iterations"
      // (conf.maxNumOfIterations) at 10,000; a higher (or non-integer) value
      // makes the pipeline push fail 500 ("The maximum number of iterations
      // must be set between 1 and 10,000!"). Clamp it into range.
      const conf: any = { ...fn.conf };
      const n = Math.floor(Number(conf.maxNumOfIterations));
      if (!Number.isFinite(n)) delete conf.maxNumOfIterations;
      else conf.maxNumOfIterations = Math.min(10000, Math.max(1, n));
      clean.push({ ...fn, conf });
    } else {
      clean.push(fn);
    }
  }
  return { functions: withCefLabelAliases(clean), dropped };
}

const CEF_LABEL_ALIAS_DESC = 'Name CEF custom fields (cs1-6/cn1-3) by their vendor-supplied Label';

/**
 * An AI regex that captures CEF `csN`/`csNLabel` pairs leaves both, meaningless
 * on their own, in `unmapped` (packtester audit 2026-10-12: McAfee ePO, Delinea).
 * After the last such regex, name each value by its label, as the golden CEF
 * parser does, and drop the pair. Side-effect adds with an empty name: never
 * `__e[name] = v` (assignments are rejected), and the key is an expression, not a
 * bare field (a bare computed key fails live).
 */
export function withCefLabelAliases(functions: any[]): any[] {
  const groups = (fn: any) => fn?.id === 'regex_extract'
    ? [fn.conf?.regex, ...(fn.conf?.regexList || []).map((r: any) => r?.regex)]
      .flatMap(rx => String(rx || '').match(/\(\?<([A-Za-z_$][\w$]*)>/g) || []).map(g => g.slice(3, -1))
    : [];
  const produced = new Set(functions.flatMap(groups));
  const pairs = ['cs1', 'cs2', 'cs3', 'cs4', 'cs5', 'cs6', 'cn1', 'cn2', 'cn3']
    .filter(n => produced.has(n) && produced.has(n + 'Label'));
  if (!pairs.length || functions.some(f => f?.description === CEF_LABEL_ALIAS_DESC)) return functions;
  let at = -1;
  functions.forEach((fn, i) => { if (groups(fn).some(g => pairs.includes(g.replace(/Label$/, '')))) at = i; });
  const add = pairs.flatMap(n => {
    const v = n.startsWith('cn') ? `Number(${n})` : n;
    const named = `${n}Label && typeof ${n} !== 'undefined' && ${n} !== ''`;
    return [
      { name: '', value: `${named} ? Object.assign(__e, {[String(${n}Label).replace(/[^A-Za-z0-9_]/g,'_')]: ${v}}) : undefined` },
      { name: n, value: `${named} ? undefined : ${n}` },
    ];
  });
  const fn = { id: 'eval', description: CEF_LABEL_ALIAS_DESC, conf: { add, remove: pairs.map(n => n + 'Label') } };
  return [...functions.slice(0, at + 1), fn, ...functions.slice(at + 1)];
}

// --- Pipeline contract lint --------------------------------------------------
// Static dataflow check run at BUILD time (before deploy). It walks the
// assembled functions in order, tracking which fields each stage PRODUCES, and
// flags any eval/rename that READS a field no earlier stage produced. This
// catches the exact bug class we keep hitting by hand:
//   • parse emits `dst_zone` but the mapping reads `dest_zone` (contract drift)
//   • normalize reads `sap_class`/`msg` that no KVP key ever set (typo/guess)
// so a "proper pipeline at once" no longer depends on post-deploy debugging.

/** Contract findings with severity 'error' block deploy (extraction gaps, golden drift). */
export function getBlockingContractErrors(findings: ContractLintFinding[] | undefined): ContractLintFinding[] {
  return (findings || []).filter(f => f.severity === 'error');
}

// Fields Cribl always provides on an event, plus our internal working fields.
const CONTRACT_BUILTINS = new Set([
  '_raw', '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_pipe',
  'cribl_breaker', '__e', 'C', '__final',
]);

// Pull the bare field identifiers an expression READS. Mirrors escapeReservedWords'
// tokenizer: skip string literals, JS globals/operators, and property access
// after a dot (obj.foo → only obj counts as a read).
function readFieldRefs(expr: string): string[] {
  // Blank out string AND regex literals first so their contents (e.g. the
  // alternation in /deny|drop|block/i) are never read as field identifiers.
  // Regex literal: a '/' not preceded by an identifier/')'/']' (which would make
  // it division), through to the next unescaped '/'. Good enough for our exprs.
  const masked = expr
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/(^|[=(,&|!?:{[\s])\/(?:\\.|[^/\\\n])+\/[a-z]*/g, '$1//');
  const IDENT = /[A-Za-z_$][\w$]*/g;
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(masked)) !== null) {
    const tok = m[0];
    if (JS_GLOBALS.has(tok) || JS_OPERATOR_KEYWORDS.has(tok)) continue;
    const offset = m.index;
    if (offset > 0 && masked[offset - 1] === '.') continue;        // property access
    const after = masked.slice(offset + tok.length).match(/^\s*\(/);
    if (after) continue;                                           // method/fn call
    refs.push(tok);
  }
  return refs;
}

// Known canonical-name synonym swaps. The bug class is a TOKEN substitution
// (dst_zone vs dest_zone), not arbitrary character edits — edit-distance is too
// noisy (src_host ~ src_port would falsely match). We generate the set of
// alternate spellings of an emitted field and flag it only if one of THOSE is an
// exact name the spec reads. Zero false positives on distinct fields.
const CANON_SWAPS: [RegExp, string][] = [
  [/(^|_)dst(_|$)/, '$1dest$2'], [/(^|_)dest(_|$)/, '$1dst$2'],
  [/(^|_)src(_|$)/, '$1source$2'], [/(^|_)source(_|$)/, '$1src$2'],
  [/^dstip$/, 'dest_ip'], [/^srcip$/, 'src_ip'],
  [/^dstport$/, 'dest_port'], [/^srcport$/, 'src_port'],
  [/^dstmac$/, 'dest_mac'], [/^srcmac$/, 'src_mac'],
  [/_ip$/, '_address'], [/_address$/, '_ip'],
  [/^proto$/, 'transport'], [/^protocol$/, 'transport'],
];
function nameVariants(field: string): string[] {
  const out = new Set<string>();
  for (const [re, rep] of CANON_SWAPS) {
    if (re.test(field)) out.add(field.replace(re, rep));
  }
  return [...out];
}

// Names produced by a serde/json/kvp extract are DYNAMIC (source-driven) and
// can't be enumerated statically, so such a stage flips `dynamic` on and
// downstream reads aren't falsely flagged — the deterministic golden-contract
// check (lintGoldenContract) still catches drift on the known-parser path.
export function lintPipelineContract(functions: PipelineFunction[]): ContractLintFinding[] {
  const findings: ContractLintFinding[] = [];
  const produced = new Set<string>(CONTRACT_BUILTINS);
  let dynamic = false; // a serde/kvp/json/code stage has introduced unknown keys

  const stageName = (f: PipelineFunction) => f.description || f.id;

  for (const fn of functions) {
    const conf = fn.conf || {};

    // Eval adds execute sequentially in Cribl — earlier adds can produce
    // fields read by later adds in the SAME stage. Process them in order:
    // check value, then record name, so intra-stage deps don't false-positive.
    if (fn.id === 'eval' && Array.isArray((conf as any).add)) {
      // Check the filter first (runs before any add)
      if (!dynamic && typeof fn.filter === 'string' && fn.filter && fn.filter !== 'true') {
        for (const ref of readFieldRefs(fn.filter)) {
          if (!produced.has(ref)) {
            findings.push({ severity: 'warning', stage: stageName(fn), field: ref, expr: fn.filter.slice(0, 80),
              hint: `"${ref}" is read here but no earlier stage produced it — check for a name mismatch with the parse stage.` });
          }
        }
      }
      for (const a of (conf as any).add) {
        if (!dynamic && typeof a?.value === 'string') {
          for (const ref of readFieldRefs(a.value)) {
            if (!produced.has(ref)) {
              findings.push({ severity: 'warning', stage: stageName(fn), field: ref, expr: a.value.slice(0, 80),
                hint: `"${ref}" is read here but no earlier stage produced it — check for a name mismatch with the parse stage.` });
            }
          }
        }
        if (a?.name) produced.add(String(a.name).split('.')[0]);
        if (typeof a?.value === 'string' && /Object\.assign\(__e/.test(a.value)) dynamic = true;
      }
      continue;
    }

    // Non-eval stages: check all reads BEFORE recording outputs.
    const exprs: string[] = [];
    if (typeof fn.filter === 'string' && fn.filter && fn.filter !== 'true') exprs.push(fn.filter);
    if (fn.id === 'rename' && typeof (conf as any).renameExpr === 'string') exprs.push((conf as any).renameExpr);

    if (!dynamic) {
      for (const expr of exprs) {
        for (const ref of readFieldRefs(expr)) {
          if (!produced.has(ref)) {
            findings.push({ severity: 'warning', stage: stageName(fn), field: ref, expr: expr.slice(0, 80),
              hint: `"${ref}" is read here but no earlier stage produced it — check for a name mismatch with the parse stage.` });
          }
        }
      }
    }

    // Record what this stage PRODUCES for later stages.
    switch (fn.id) {
      case 'serde': {
        dynamic = true;
        break;
      }
      case 'code':
        dynamic = true;
        break;
      case 'regex_extract': {
        const rx = String((conf as any).regex || '');
        const groups = rx.match(/\(\?<([A-Za-z_$][\w$]*)>/g) || [];
        for (const g of groups) produced.add(g.replace(/\(\?<|>/g, ''));
        break;
      }
      case 'lookup': {
        for (const o of ((conf as any).outFields || [])) {
          if (o?.eventField) produced.add(o.eventField);
        }
        if ((conf as any).addToEvent !== false) dynamic = true;
        break;
      }
      case 'rename': {
        for (const p of ((conf as any).rename || [])) {
          if (p?.newName) produced.add(String(p.newName).split('.')[0]);
        }
        break;
      }
    }
  }

  // De-dupe on field+stage so a field read in 3 chunks reports once per stage.
  const seen = new Set<string>();
  return findings.filter(f => {
    const k = `${f.stage}::${f.field}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Deterministic contract check for the GOLDEN path. A golden spec is SHARED
// across sourcetypes, so it legitimately reads canonical names a given source
// lacks (those are presence-guarded and simply omitted — not a bug). The real
// bug we keep hitting is a NEAR-MISS: the parser emits a field like `dst_zone`
// while the spec reads the canonical `dest_zone`, so the value silently never
// maps. We flag a parser output when (a) the spec never reads it AND (b) it is
// within edit-distance 2 of a canonical name the spec DOES read — the exact
// signature of the dst_/dest_ class of bugs. No sample required.
/**
 * Every canonical field name a golden spec READS (header + extension + canonicalMap
 * + timeField, with `valueRules` inlined first). Exported because two checks need
 * exactly the same set and a second copy would drift: `lintGoldenContract` asks
 * "is each parser output consumed?" and `lintMappingVacuity` asks the inverse,
 * "does this spec consume enough of the parser to produce anything at all?".
 */
export function goldenSpecReadFields(destFormat: string, sourcetypeRaw?: string): Set<string> {
  const spec = resolveGoldenFormat(destFormat, sourcetypeRaw ? canonicalizeSourcetype(sourcetypeRaw) : undefined);
  const reads = new Set<string>();
  if (!spec) return reads;
  const rules: Record<string, string> = (spec as any).valueRules || {};
  const collect = (expr: string) => { for (const r of readFieldRefs(resolveExpr(expr, rules))) reads.add(r); };
  const header = (spec as any).header;
  if (header) for (const k of ['signatureId', 'name', 'severity']) if (header[k]) collect(header[k]);
  for (const e of ((spec as any).extension || [])) { if (e.expr) collect(e.expr); if (e.guard) collect(e.guard); }
  for (const m of ((spec as any).canonicalMap || [])) { if (!m.literalNumber && m.expr) collect(m.expr); }
  if ((spec as any).timeField) collect((spec as any).timeField);
  return reads;
}

export function lintGoldenContract(sourcetypeRaw: string, destFormat: string): ContractLintFinding[] {
  if (destFormat === 'xsiam') return [];
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  if (!hasGoldenFormatPath(sourcetype, destFormat)) return [];
  const specReads = goldenSpecReadFields(destFormat, sourcetype);
  if (!specReads.size) return [];

  const emitted = getParserFieldNames(sourcetype);
  const findings: ContractLintFinding[] = [];
  for (const field of emitted) {
    if (specReads.has(field)) continue;           // the parser output is consumed — fine
    if (CONTRACT_BUILTINS.has(field)) continue;
    // Is a known canonical spelling-variant of this field what the spec reads?
    // (dst_zone → dest_zone). Only a deterministic token swap counts.
    let best: string | null = null;
    for (const variant of nameVariants(field)) {
      if (specReads.has(variant)) { best = variant; break; }
    }
    if (best) {
      findings.push({
        severity: 'error',
        stage: `golden:${destFormat}`,
        field,
        expr: `parser emits "${field}"`,
        hint: `Parser emits "${field}" but the golden ${destFormat} spec reads "${best}" — likely a canonical-name mismatch, so "${field}" never maps. Rename the parser output to "${best}".`,
      });
    }
  }
  const seen = new Set<string>();
  return findings.filter(f => { const k = `${f.stage}::${f.field}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// `declared`/`functions` are overridable so the SAME check can run twice: over
// the static library pair (the library-wide sweep in test:contract) and, from
// lintPack, over the pair a real build actually used.
export function lintParserContract(
  sourcetypeRaw: string,
  opts?: { declared?: string[]; functions?: PipelineFunction[] | null },
): ContractLintFinding[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const declared = opts?.declared ?? getParserFieldNames(sourcetype);
  if (!declared.length) return [];
  let fns: PipelineFunction[] | null = opts?.functions ?? null;
  if (!opts?.functions) { try { fns = getParserForSourcetype(sourcetype, true); } catch { return []; } }
  if (!fns || !fns.length) return [];
  const { fields, dynamic } = parserProducedFields(fns);
  if (dynamic) return [];        // can't enumerate: flatten/code/lookup/wildcard serde
  const produced = new Set(fields);
  const findings: ContractLintFinding[] = [];
  for (const field of declared) {
    if (produced.has(field) || SELF_HEALED_FIELDS.has(field) || CONTRACT_BUILTINS.has(field)) continue;
    findings.push({
      severity: 'error',
      stage: 'parser:declaration',
      field,
      expr: `getParserFieldNames("${sourcetype}") declares "${field}"`,
      hint: `getParserFieldNames declares "${field}" but no stage of getParserForSourcetype("${sourcetype}") produces it. The mapping AI is told this field is available and will map a value that is always empty. Either produce it in the parser or drop it from the declaration.`,
    });
  }
  return findings;
}

// --- Mapping vacuity check ---------------------------------------------------
// A golden spec is SHARED across sourcetypes, so consuming only a fraction of a
// parser's output is normal and consuming a field a source lacks is not a bug
// (Rule 12: an absent value cannot cost points). But if a spec consumes almost
// NOTHING the parser emits, the mapping stage cannot produce a populated event no
// matter how healthy extraction looks — the batch-446 signature of "extraction
// fine, mapping 0". Deliberately an ABSOLUTE floor, not a percentage: a wide
// parser legitimately orphans most of its output (cisco_asa emits 41 fields and
// OCSF reads 13 of them), whereas feeding a spec 0-2 fields is vacuous whatever
// the ratio. Reported per sourcetype+format, so a source that maps well to CIM and
// poorly to OCSF is flagged only for OCSF.
const MIN_CONSUMED_FIELDS = 3;

export function lintMappingVacuity(
  sourcetypeRaw: string, destFormat: string,
  opts?: { emitted?: string[]; sampleEvents?: string },
): ContractLintFinding[] {
  if (destFormat === 'xsiam' || destFormat === 'passthrough' || destFormat === 'json' || destFormat === 'raw_fields' || destFormat === 'manual' || destFormat === 'raw') return [];
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  if (!hasGoldenFormatPath(sourcetype, destFormat, opts?.sampleEvents)) return [];
  const reads = goldenSpecReadFields(destFormat, sourcetype);
  if (!reads.size) return [];
  const emitted = (opts?.emitted ?? getParserFieldNames(sourcetype)).filter(f => !CONTRACT_BUILTINS.has(f));
  if (!emitted.length) return [];
  const consumed = emitted.filter(f => reads.has(f));
  if (consumed.length >= MIN_CONSUMED_FIELDS) return [];
  // A parser that emits fewer than MIN_CONSUMED_FIELDS enumerable fields can
  // NEVER clear the floor — `consumed >= 3` requires `emitted >= 3` — so the
  // absolute check is undefined here and would report a permanent error for a
  // source that may be mapping everything it has (aws_alb_accesslog declares one
  // field, and the spec reads it: 1/1). The thinness is an EXTRACTION-contract
  // question (a stock datatype parser that only splits the syslog envelope), which
  // `checkExtractionCoverage` and `lintParserContract` own. Report it truthfully
  // as its own warning instead of a vacuity error, so it stays visible without
  // failing a build on an unmeasurable metric.
  if (emitted.length < MIN_CONSUMED_FIELDS) {
    return [{
      severity: 'warning',
      stage: `golden:${destFormat}`,
      field: consumed.length ? consumed.join(',') : '(nothing)',
      expr: `parser emits only ${emitted.length} enumerable field(s) (${emitted.join(',')})`,
      hint: `${sourcetype} declares just ${emitted.length} field(s), so mapping vacuity cannot be measured against a ${MIN_CONSUMED_FIELDS}-field floor (${consumed.length}/${emitted.length} are read by the ${destFormat} spec). This is an extraction-contract gap, not a mapping one — the parser is almost certainly envelope-only. Widen the parser first; the vacuity check becomes meaningful once it emits ${MIN_CONSUMED_FIELDS}+ fields.`,
    }];
  }
  // Severity turns on WHY the spec reads nothing this parser emits:
  //   • Recognized data class → the spec was chosen FOR this kind of source, so a
  //     near-empty intersection is a genuine parser/spec defect (apache_access fed
  //     the web spec 3 fields; nginx_access and aws_vpc_flow fed it zero).
  //   • `generic` data class → `resolveGoldenFormat` has no class-specific spec and
  //     falls back to the default (network) one, while `recommendDestFormats` tells
  //     the user to pick `json`. Reaching here means the recommendation was
  //     overridden (a batch CSV naming `cim` for a config-audit log), so the mapping
  //     really will be sparse but the parser is not at fault — warn, don't fail.
  // A THIRD case is deliberately NOT given its own severity: a real data class the
  // format has no `<fmt>#<class>` spec for (an `audit` source against ECS's or
  // Chronicle's network-only map, which has no 5-tuple to fill). Downgrading that to
  // a warning was tried and reverted — the DEFAULT spec of every format IS the
  // network one, so "no `ecs#network` key exists" cannot be read as "no spec for this
  // class", and the rule masked five legitimate backlog entries (microsoft_dhcp_syslog,
  // pan_correlation_syslog{,_nopri}, imperva_dam, infoblox_*_rfc5424). The error is
  // truthful either way — the pair really does map ~nothing — so it stays an error and
  // the known pairs stay visible in VACUITY_PARSER_BACKLOG until a class spec exists.
  const dataClass = recommendDestFormats(sourcetype).dataClass;
  const generic = dataClass === 'generic';
  return [{
    severity: generic ? 'warning' : 'error',
    stage: `golden:${destFormat}`,
    field: consumed.length ? consumed.join(',') : '(nothing)',
    expr: `${consumed.length}/${emitted.length} parser fields are read by the ${destFormat} spec`,
    hint: generic
      ? `${sourcetype} has data class "generic", so there is no ${destFormat} spec written for this kind of source and the default one is used — it reads only ${consumed.length} of the ${emitted.length} fields the parser emits. recommendDestFormats suggests "json" for this source; picking ${destFormat} anyway will map a nearly empty event. Give the source a real data class (SOURCETYPE_DATACLASS) to get a spec that fits it.`
      : `The golden ${destFormat} spec reads only ${consumed.length} of the ${emitted.length} fields the ${sourcetype} parser emits, so the mapping stage has almost nothing to assemble and will score ~0 however good extraction looks. Emit the canonical names this spec reads (${[...reads].slice(0, 12).join(', ')}…) from the parser — or, if this source's data class has no ${destFormat} spec at all, add one (see "${destFormat}#<class>" in golden-formats.json) — see Rule 10.`,
  }];
}

// --- Time-field contract check -----------------------------------------------
// Every golden spec's `_time` comes from ONE hardcoded canonical field name:
// `log_time` (see buildGoldenFormatMapping / validateOutputAgainstSpec time
// assembly). This check catches the exact bug that made every event in a pack
// share one static `_time`: an AI-generated parse stage captures a real
// timestamp under some other name (`timestamp`, `epoch`, `ids_timestamp`, the
// regex group the AI happened to choose) but never aliases it to `log_time`,
// so the time-assembly eval's `(log_time) && ... : _time` fallback silently
// keeps pipeline-processing time for every event. lintPipelineContract can't
// catch this — a kvp/json serde flips `dynamic` and suppresses further
// unproduced-field warnings, and log_time is never READ by the parse stage
// anyway (it's read by the LATER mapping/assembly stage, out of scope for a
// per-stage produced/read check). This runs directly on the parse slice and
// is blind to `dynamic`, because the field we care about (log_time) is never
// serde-derived — it's always an explicit alias the pipeline author must add.
// Matches field names that look like a POINT-IN-TIME (timestamp/epoch/date),
// while excluding names that contain "time"/"date" but denote a DURATION or
// interval (time_window_sec, session_duration, elapsed_time, retry_interval) —
// those are real fields we must not clobber into a bogus log_time candidate.
const TIMESTAMP_LOOKALIKE = /^(?!.*(?:duration|window|elapsed|interval|expir|timeout|_sec$|_secs$|_ms$|_min$|_mins$))(?:.*time.*|.*date.*|.*stamp.*|.*_ts$|^ts$|.*epoch.*)$/i;

// Shared by the lint (reports) and the auto-fix (repairs): scan a parse slice
// for every field name it produces, and flag which of those LOOK like a
// timestamp by name. Deliberately name-based, not value-based — we're
// checking whether the PIPELINE AUTHOR aliased their capture to `log_time`,
// not whether the data is parseable (Date.parse handles format detection at
// runtime, in the existing time-assembly eval).
function findTimestampLookalikes(parseFns: PipelineFunction[]): { produced: Set<string>; lookalikes: string[] } {
  const produced = new Set<string>();
  const lookalikes: string[] = [];
  for (const fn of parseFns) {
    const conf = (fn.conf || {}) as any;
    if (fn.id === 'regex_extract') {
      const rx = String(conf.regex || '');
      for (const g of (rx.match(/\(\?<([A-Za-z_$][\w$]*)>/g) || [])) {
        const name = g.replace(/\(\?<|>/g, '');
        produced.add(name);
        if (TIMESTAMP_LOOKALIKE.test(name)) lookalikes.push(name);
      }
    } else if (fn.id === 'eval') {
      for (const a of (conf.add || [])) {
        if (!a?.name) continue;
        const name = String(a.name).split('.')[0];
        produced.add(name);
        if (TIMESTAMP_LOOKALIKE.test(name)) lookalikes.push(name);
      }
    } else if (fn.id === 'serde' && Array.isArray(conf.fields)) {
      // CSV serde with explicit column names (PAN traffic/threat emit
      // receive_time/generated_time/start_time). Those are the ONLY source of a
      // timestamp for CSV sources, so scan them too — otherwise a serde-parsed
      // source can never get its log_time alias and _time stays static.
      for (const name of conf.fields) {
        if (typeof name !== 'string') continue;
        produced.add(name);
        if (TIMESTAMP_LOOKALIKE.test(name)) lookalikes.push(name);
      }
    }
  }
  // Prefer the most specific event-time field when several timestamp-shaped
  // columns exist. PAN has receive_time (when the collector received it) AND
  // generated_time (when the event actually happened) — generated_time is the
  // truer event time, so order it first in the || chain the alias builds.
  // CEF's `rt` (Device Receipt Time) is the event time, but matches no timestamp
  // shape and is request time in nginx logs: only next to a CEF header or label.
  if (lookalikes.length === 0 || !lookalikes.some(n => /time|stamp/i.test(n))) {
    const cef = ['cef_version', 'signature_id', 'cs1Label', 'cn1Label', 'cef_extension'].some(n => produced.has(n));
    for (const n of ['rt', 'deviceReceiptTime', 'art']) if (cef && produced.has(n)) lookalikes.push(n);
  }
  const priority = (n: string) => /generated|event|start/i.test(n) ? 0 : /receive|log/i.test(n) ? 1 : 2;
  const ordered = [...new Set(lookalikes)].filter(n => n !== 'log_time').sort((a, b) => priority(a) - priority(b));
  return { produced, lookalikes: ordered };
}

export function lintTimeContract(destFormat: string, parseFns: PipelineFunction[]): ContractLintFinding[] {
  const spec = resolveGoldenFormat(destFormat);
  if (!spec || spec.timeField !== 'log_time') return [];
  const { produced, lookalikes } = findTimestampLookalikes(parseFns);
  if (produced.has('log_time')) return []; // already aliased — fine.
  if (lookalikes.length === 0) return []; // nothing timestamp-shaped to alias — not this bug.
  return [{
    severity: 'error',
    stage: 'time-contract',
    field: 'log_time',
    expr: `captured: ${lookalikes.join(', ')}`,
    hint: `The parse stage captured a timestamp-shaped field (${lookalikes.join(', ')}) but never aliased it to "log_time" — the ONLY field name the golden ${destFormat} time-assembly reads. Every output event will share the pipeline's processing time instead of the source timestamp. Add an eval: { name: 'log_time', value: 'Date.parse(<timestamp field>) / 1000' }.`,
  }];
}

// Auto-repair for the same gap: when a timestamp-shaped field was captured but
// never aliased to log_time, append an eval that does it deterministically —
// `log_time = candidate1 || candidate2 || ... || undefined`. Safe because the
// downstream time-assembly already guards on `(log_time) && ... : _time`, so
// a candidate absent for a given event type just falls through (same
// behavior as today), while any populated candidate now drives the real
// output timestamp instead of silently defaulting to processing time.
export function buildLogTimeAliasFn(destFormat: string, parseFns: PipelineFunction[]): PipelineFunction | null {
  const spec = resolveGoldenFormat(destFormat);
  if (!spec || spec.timeField !== 'log_time') return null;
  const { produced, lookalikes } = findTimestampLookalikes(parseFns);
  if (produced.has('log_time') || lookalikes.length === 0) return null;
  return {
    id: 'eval',
    description: `Alias captured timestamp field(s) to log_time (${lookalikes.join(', ')}) so _time reflects the source event, not pipeline processing time`,
    conf: { add: [{ name: 'log_time', value: lookalikes.join(' || ') + ' || undefined' }] },
  };
}

/**
 * Cribl Copilot / schematizer often flattens OCSF-style nests with `__`
 * (`source__ip`, `event__outcome`, …). Golden and static CIM/ECS maps read the
 * canonical model (`src_ip`, `action`, …). This single eval is the choke point:
 * every create/optimize/batch path must run it BEFORE destination mapping so dest
 * exprs never depend on Copilot naming.
 *
 * Safe when Copilot fields are absent: each assignment is `canonical || alias…`
 * so a golden parser that already emitted `src_ip` is unchanged.
 */
export function buildSchematizerCanonicalAliases(): PipelineFunction {
  // Vocabulary lives in mapping-aliases.ts (CANONICAL_FIELD_ALIASES) so the static
  // eval and the produced-field backstop (repairCanonicalAliases) share one source
  // of truth. Extend synonyms there, not here.
  return {
    id: 'eval',
    description: 'Alias Copilot/schematizer OCSF-style fields to canonical names',
    conf: {
      add: buildCanonicalAliasAdd(),
    },
  };
}

/** Prepend the schematizer→canonical alias eval when it is not already present. */
export function withSchematizerCanonicalAliases(mappingFns: PipelineFunction[]): PipelineFunction[] {
  const fns = withoutOutputCompactionLike(mappingFns);
  if (fns.some(f => /Alias Copilot\/schematizer/i.test(String(f?.description || '')))) {
    return fns;
  }
  return [buildSchematizerCanonicalAliases(), ...fns];
}

// Local strip of serialize/keep so pack-builder does not import pipeline-stages
// (avoids a circular dependency). Mirrors withoutOutputCompaction.
function withoutOutputCompactionLike(fns: PipelineFunction[]): PipelineFunction[] {
  return (fns || []).filter(f => {
    const conf = (f?.conf || {}) as Record<string, unknown>;
    if (Array.isArray(conf.keep) || Array.isArray(conf.remove)) return false;
    if (f?.id === 'serialize' && (conf.dstField === '_raw' || conf.type === 'json')) return false;
    return true;
  });
}

// --- Extraction-completeness check ------------------------------------------
// The static contract lint above can't see INSIDE a serde/kvp/json wildcard.
// This check does: it enumerates the field KEYS actually present in the raw
// sample, models what the parse stage genuinely captures, and reports keys the
// pipeline leaves on the floor. Deterministic, local, no Cribl round-trip.
// Catches: a regex parser that misses fields; a serde whose type/quoteChar
// doesn't fit the data (e.g. TEXT="a b" shredded without a quoteChar).

// Model the field keys the parse-stage functions will populate from the source.
function capturedFieldKeys(parseFns: PipelineFunction[]): { keys: Set<string>; wildcardKvp: boolean; wildcardJson: boolean } {
  const keys = new Set<string>();
  let wildcardKvp = false, wildcardJson = false;
  for (const fn of parseFns) {
    const conf = (fn.conf || {}) as any;
    if (fn.id === 'serde') {
      const type = String(conf.type || '');
      if (type === 'kvp') wildcardKvp = true;      // captures every k=v key
      else if (type === 'json') wildcardJson = true;
      else if (type === 'csv') wildcardKvp = true; // header-named columns
    } else if (fn.id === 'regex_extract') {
      const rx = String(conf.regex || '');
      for (const g of (rx.match(/\(\?<([A-Za-z_$][\w$]*)>/g) || [])) keys.add(g.replace(/\(\?<|>/g, ''));
    } else if (fn.id === 'code') {
      wildcardKvp = true; // arbitrary assignment — assume broad capture
    } else if (fn.id === 'eval') {
      for (const a of (conf.add || [])) if (a?.name) keys.add(String(a.name).split('.')[0]);
    }
  }
  return { keys, wildcardKvp, wildcardJson };
}

// Only the functions BEFORE the first mapping/reduction stage are "parse". We
// approximate: take functions up to (but not including) the first drop, or the
// eval whose description mentions mapping/compact/cleanup. Good enough — the
// caller can also pass an explicit parse slice.
export function checkExtractionCoverage(parseFns: PipelineFunction[], sampleEvents: string): ExtractionCoverage {
  const rawLines = (sampleEvents || '').split('\n').map(l => l.trim()).filter(Boolean);
  const { format, keys: sampleKeySet } = extractSampleKeys(rawLines);
  const { keys: captured, wildcardKvp, wildcardJson } = capturedFieldKeys(parseFns);

  const sampleKeys = [...sampleKeySet];
  const findings: ContractLintFinding[] = [];

  // A matching wildcard extractor captures every key of that envelope.
  const fullyCovered =
    (format === 'kvp' && wildcardKvp) ||
    (format === 'cef' && wildcardKvp) ||
    (format === 'json' && wildcardJson) ||
    (format === 'csv' && wildcardKvp);

  let missedKeys: string[] = [];
  if (format === 'unstructured' || sampleKeys.length === 0) {
    // Nothing enumerable — coverage is not assessable; report nothing.
    return { format, sampleKeys, capturedKeys: [...captured], missedKeys: [], findings: [], coverage: 1 };
  }
  if (fullyCovered) {
    missedKeys = [];
  } else {
    // Regex/eval-only parse: a key is captured only if a named group / eval
    // produced it (case-insensitive — regex groups are often lowercased).
    const capturedLc = new Set([...captured].map(k => k.toLowerCase()));
    missedKeys = sampleKeys.filter(k => !capturedLc.has(k.toLowerCase()));
  }

  if (missedKeys.length > 0) {
    const shown = missedKeys.slice(0, 15);
    findings.push({
      severity: fullyCovered ? 'warning' : 'error',
      stage: `extraction:${format}`,
      field: shown.join(', '),
      expr: `${missedKeys.length} of ${sampleKeys.length} source keys not captured`,
      // (unstructured returns early above, so `format` here is a structured one.)
      hint: `The parse stage leaves these ${format.toUpperCase()} keys unextracted: ${shown.join(', ')}${missedKeys.length > shown.length ? '…' : ''}. Add a matching extractor (serde ${format === 'json' ? 'json' : 'kvp'}) or named regex groups so downstream mapping can read them.`,
    });
  }

  const coverage = sampleKeys.length === 0 ? 1
    : (fullyCovered ? 1 : (sampleKeys.length - missedKeys.length) / sampleKeys.length);
  return { format, sampleKeys, capturedKeys: [...captured], missedKeys, findings, coverage };
}

// --- Sample fingerprint (auto-promote replay guard) -------------------------
// A stable structural signature of a sample: its envelope format + sorted key
// set. Saved alongside a verified recipe so a later run only REPLAYS the recipe
// when the new sample is structurally the same source — otherwise it falls back
// to AI. Guards against replaying a FortiGate recipe onto, say, an Okta sample
// that a user happened to label with the same custom sourcetype.

// Two fingerprints match when they share the same envelope AND the new sample's
// keys are (nearly) a subset of the verified one — i.e. the new events carry the
// same structure the recipe was proven against. We require ≥85% of the new
// sample's keys to be covered by the verified set (a few extra optional keys are
// fine; a wholly different key-set is not). Unstructured samples never match
// (no reliable signature), so those always regenerate.
export function fingerprintsMatch(verified: SampleFingerprint | null | undefined, current: SampleFingerprint): boolean {
  if (!verified || verified.format !== current.format) return false;
  if (current.format === 'unstructured') return false;
  if (current.keys.length === 0) return false;
  const vset = new Set(verified.keys);
  const covered = current.keys.filter(k => vset.has(k)).length;
  return covered / current.keys.length >= 0.85;
}

// --- Golden path sample-structure guard -----------------------------------
// Validates that the user's actual sample structurally matches what the golden
// parser for `sourcetype` expects. Prevents the deterministic golden path from
// producing garbage when the sample is mislabeled (e.g. Fortinet events tagged
// as cisco_asa). Light heuristic — blocks obvious mismatches, not a full parser.

/**
 * Validates that a sample structurally matches what the golden parser for this
 * sourcetype expects. Returns true if the golden path is safe to use, false if
 * the sample clearly doesn't match (likely mislabeled).
 */
export function goldenPathMatchesSample(sourcetype: string, destFormat: string, sampleEvents: string): boolean {
  // XSIAM is passthrough — no parse-stage format contract to verify.
  if (destFormat === 'xsiam') return true;
  // No sample → allow golden path as before (don't break existing functionality)
  if (!sampleEvents || !sampleEvents.trim()) return true;

  // Must have a golden path to begin with (sample-aware — same class as build)
  if (!hasGoldenFormatPath(sourcetype, destFormat, sampleEvents)) return false;

  // No expectation defined for this sourcetype → can't check, allow golden path.
  return sampleMatchesSourceExpectation(sourcetype, sampleEvents) !== 'mismatch';
}

function toKebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildPackageJson(state: WizardState, sourcetype: string, _destFormat: string) {
  const formatLabel = getFormatLabel(state);
  const sourcetypeLabel = sourcetype.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    version: '1.0.0',
    author: 'Cribl Pack Generator App',
    tags: { streamtags: [] },
    exports: [],
    displayName: state.displayName || state.packName,
    name: toKebab(state.packName),
    description: `Parses ${sourcetypeLabel} events and maps them to ${formatLabel} format. Includes noise reduction, suspicious activity flagging, and schema mapping.`,
  };
}

function getFormatLabel(state: WizardState): string {
  if (isAsimFormat(state.destFormat)) return asimSchemaLabel(state.destFormat);
  if (isCimFormat(state.destFormat)) return cimSchemaLabel(state.destFormat);
  switch (state.destFormat) {
    case 'nextgen': return 'CrowdStrike NG SIEM';
    case 'ocsf': return 'OCSF 1.9';
    case 'cef': return 'CEF (Common Event Format)';
    case 'commonsecuritylog': return 'Sentinel CommonSecurityLog';
    case 'ecs': return 'Elastic Common Schema';
    case 'asim': return 'Microsoft Sentinel ASIM';
    case 'chronicle': return 'Chronicle UDM';
    case 'json': return 'Clean JSON';
    case 'xsiam': return 'Cortex XSIAM';
    case 'passthrough': return 'Passthrough (raw copy)';
    case 'raw_fields': return 'Raw + extracted fields';
    case 'splunk_raw': return 'Splunk raw';
    case 'splunk_json': return 'Splunk JSON';
    case 'elastic_raw': return 'Elastic integration';
    case 'elastic_json': return 'Elastic JSON';
    case 'chronicle_raw': return 'Google SecOps raw (log type)';
    case 'sentinel': return state.sentinelTable || 'Microsoft Sentinel';
    case 'manual': return state.manualFormat || 'Custom';
    default: return String(state.destFormat);
  }
}

// Human ASIM schema label from a build format: 'asim#authentication' →
// 'Microsoft Sentinel ASIM — Authentication'. Reads the golden spec's label.
export function asimSchemaLabel(destFormat: string): string {
  const spec = GOLDEN_FORMATS[destFormat];
  if (spec?.label) return spec.label;
  return 'Microsoft Sentinel ASIM';
}

function formatLabelShort(destFormat: string, manualFormat: string): string {
  if (isAsimFormat(destFormat)) {
    const cls = destFormat.includes('#') ? destFormat.split('#')[1] : 'network';
    return `ASIM ${cls}`;
  }
  if (isCimFormat(destFormat)) {
    const cls = destFormat.includes('#') ? destFormat.split('#')[1] : 'network';
    return `CIM ${cls.replace(/_/g, ' ')}`;
  }
  switch (destFormat) {
    case 'nextgen': return 'CrowdStrike NG SIEM';
    case 'ocsf': return 'OCSF';
    case 'cef': return 'CEF';
    case 'commonsecuritylog': return 'CommonSecurityLog';
    case 'ecs': return 'ECS';
    case 'asim': return 'ASIM';
    case 'chronicle': return 'UDM';
    case 'json': return 'JSON';
    case 'xsiam': return 'XSIAM';
    case 'passthrough': return 'Passthrough';
    case 'raw_fields': return 'Raw + fields';
    case 'splunk_raw': return 'Splunk raw';
    case 'splunk_json': return 'Splunk JSON';
    case 'elastic_raw': return 'Elastic integration';
    case 'elastic_json': return 'Elastic JSON';
    case 'chronicle_raw': return 'SecOps raw';
    case 'manual': return manualFormat || 'Custom';
    default: return destFormat.toUpperCase();
  }
}

function getPipelineId(sourcetype: string, destFormat: string): string {
  // `#` in `asim#<dataClass>` isn't a valid pipeline-ID char — collapse to `_`.
  const destSuffix = destFormat === 'manual' ? 'transform' : destFormat.replace(/#/g, '_');
  return `${sourcetype}_to_${destSuffix}`;
}

// Sample file name — ONE per sourcetype, destination-INDEPENDENT. Extraction is
// source-only, so every pipeline for a sourcetype (whatever its destination)
// parses the SAME sample. The pack therefore holds a single
// `<sourcetype>_sample.log` instead of a byte-identical copy per destination.
// Pack samples are pack-scoped and shared across pipelines; the deploy handler
// upserts by name, so re-uploading the same name is idempotent (no duplicate).
function getSampleName(sourcetype: string): string {
  return `${sourcetype}_sample.log`;
}

function buildRouteYml(state: WizardState, sourcetype: string): string {
  const filter = state.routeFilter || `sourcetype=='${sourcetype}'`;
  const pipelineId = getPipelineId(sourcetype, state.destFormat);
  return `id: default
groups: {}
comments: []
routes:
  - id: default
    name: "${state.displayName || state.packName} Route"
    final: true
    disabled: false
    pipeline: ${pipelineId}
    description: "Route for ${state.displayName || state.packName}"
    enableOutputExpression: false
    filter: "${filter}"
    clones: []
    output: default
`;
}

export function safeEvalFilter(filter: string, event: Record<string, any>): boolean {
  try {
    const keys = Object.keys(event);
    const values = Object.values(event);
    const fn = new Function(...keys, `try { return !!(${filter}); } catch { return false; }`);
    return fn(...values);
  } catch {
    return false;
  }
}

// Pipeline conf is written as JSON (valid YAML superset, avoids serialization bugs)

// --- Pipeline builder ---

// Vendor product-family variants for the interactive picker. The golden catalog
// only holds names with a deterministic parser+schema (SAP has ONLY sap_audit,
// F5 has NONE) — but a user typing "sap" or "f5" expects the whole product
// family to choose from. These are REAL sources the app builds via the
// catalogue_gap / AI path on their own name (no golden yet), surfaced in search
// so the vendor term returns 5-6 pickable options instead of one. `terms` are
// the search tokens that trigger the family; `variants` are the offered names.
// Keep names snake_case and canonical (vendor_product[_subtype]).
const PRODUCT_FAMILY_VARIANTS: { terms: string[]; variants: { name: string; description: string }[] }[] = [
  { terms: ['sap', 'hana'], variants: [
    { name: 'sap_syslog', description: 'SAP application server syslog' },
    { name: 'sap_hana', description: 'SAP HANA database audit/trace logs' },
    { name: 'sap_erp', description: 'SAP ERP / ECC application logs' },
    { name: 'sap_netweaver', description: 'SAP NetWeaver AS ABAP/Java logs' },
    { name: 'sap_gateway', description: 'SAP Gateway (reggw) security logs' },
    { name: 'sap_business_objects', description: 'SAP BusinessObjects audit logs' },
  ] },
  { terms: ['f5', 'bigip', 'big_ip'], variants: [
    { name: 'f5_bigip', description: 'F5 BIG-IP general logs' },
    { name: 'f5_bigip_ltm', description: 'F5 BIG-IP LTM (Local Traffic Manager)' },
    { name: 'f5_bigip_asm', description: 'F5 BIG-IP ASM (WAF) security logs' },
    { name: 'f5_bigip_apm', description: 'F5 BIG-IP APM (Access Policy Manager)' },
    { name: 'f5_bigip_afm', description: 'F5 BIG-IP AFM (Advanced Firewall) logs' },
    { name: 'f5_bigip_gtm', description: 'F5 BIG-IP GTM/DNS logs' },
  ] },
  { terms: ['oracle', 'ora'], variants: [
    { name: 'oracle_audit', description: 'Oracle Database unified/standard audit' },
    { name: 'oracle_listener', description: 'Oracle Net listener logs' },
    { name: 'oracle_alert', description: 'Oracle Database alert log' },
    { name: 'oracle_apex', description: 'Oracle APEX access logs' },
  ] },
  { terms: ['citrix'], variants: [
    { name: 'citrix_netscaler', description: 'Citrix NetScaler/ADC logs' },
    { name: 'citrix_adc', description: 'Citrix ADC (formerly NetScaler)' },
    { name: 'citrix_gateway', description: 'Citrix Gateway access logs' },
    { name: 'citrix_vda', description: 'Citrix Virtual Apps & Desktops (VDA)' },
  ] },
  { terms: ['symantec'], variants: [
    { name: 'symantec_endpoint', description: 'Symantec Endpoint Protection (SEP)' },
    { name: 'symantec_dlp', description: 'Symantec Data Loss Prevention' },
    { name: 'symantec_email_cloud', description: 'Symantec Email Security.cloud' },
    { name: 'symantec_proxy', description: 'Symantec/Blue Coat ProxySG' },
  ] },
  { terms: ['ibm'], variants: [
    { name: 'ibm_websphere', description: 'IBM WebSphere application server logs' },
    { name: 'ibm_mq', description: 'IBM MQ queue manager logs' },
    { name: 'ibm_isva', description: 'IBM Security Verify Access' },
    { name: 'ibm_qradar', description: 'IBM QRadar SIEM event logs' },
  ] },
  { terms: ['juniper'], variants: [
    { name: 'juniper_junos', description: 'Juniper Junos device logs' },
    { name: 'juniper_srx', description: 'Juniper SRX firewall logs' },
    { name: 'juniper_netscreen', description: 'Juniper NetScreen firewall logs' },
  ] },
  // GitHub Enterprise/org: all JSON, all shipped as parser-verified vendor samples
  // (the `github_*` keys in the samples pool). Without this, typing "github" returned only
  // github_cloud_audit and the audit/GHAS family was invisible in the picker.
  { terms: ['github', 'ghas'], variants: [
    { name: 'github_audit', description: 'GitHub Enterprise/org audit log (JSON)' },
    { name: 'github_cloud_audit', description: 'GitHub org audit via Splunk Add-on (github:cloud:audit)' },
    { name: 'github_code_scanning', description: 'GitHub Advanced Security — code scanning alerts' },
    { name: 'github_secret_scanning', description: 'GitHub Advanced Security — secret scanning alerts' },
    { name: 'github_dependabot', description: 'GitHub Advanced Security — Dependabot alerts' },
    { name: 'github_security_advisories', description: 'GitHub security advisories' },
    { name: 'github_issues', description: 'GitHub issues activity' },
  ] },
];

// Free-text search over the supported catalog for the interactive picker: the
// user types a partial term ("sap", "cisco", "dns") and gets every matching
// supported sourcetype to choose from (or they type their own). Matches the
// canonical name, its description, and its vendor/product hint. Ranked: name
// prefix > name substring > description/hint substring; golden sources first
// within a rank; then alphabetical. Vendor product-family variants
// (PRODUCT_FAMILY_VARIANTS) are merged in so a vendor term like "sap"/"f5"
// returns the whole family, not just the one golden name. Returns [] for empty.
export function searchSupportedSourcetypes(query: string, limit = 24): { name: string; golden: boolean; description: string }[] {
  const q = normalizeSourcetypeName(query).replace(/_/g, '');
  const raw = (query || '').trim().toLowerCase();
  if (!raw) return [];
  const scored: { name: string; golden: boolean; description: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const { name, golden } of getSupportedSourcetypeCatalog()) {
    const nameKey = name.toLowerCase().replace(/_/g, '');
    const desc = describeSourcetype(name) || '';
    const descL = desc.toLowerCase();
    let rank = -1;
    if (nameKey.startsWith(q) || name.toLowerCase().startsWith(raw)) rank = 0;
    else if (nameKey.includes(q) || name.toLowerCase().includes(raw)) rank = 1;
    else if (descL.includes(raw) && desc !== 'Unknown source type') rank = 2;
    if (rank === -1) continue;
    seen.add(name);
    scored.push({ name, golden, description: desc === 'Unknown source type' ? '' : desc, rank });
  }
  // Merge vendor product-family variants when the query hits a family term.
  for (const fam of PRODUCT_FAMILY_VARIANTS) {
    const hit = fam.terms.some(t => t.startsWith(q) || q.startsWith(t) || t.includes(raw) || raw.includes(t));
    if (!hit) continue;
    for (const v of fam.variants) {
      if (seen.has(v.name)) continue;
      seen.add(v.name);
      // Rank a family variant just behind an exact name-prefix catalog hit so
      // the golden name (if any) still leads, but the family fills the list.
      const nameKey = v.name.toLowerCase().replace(/_/g, '');
      const rank = (nameKey.startsWith(q) || v.name.toLowerCase().startsWith(raw)) ? 0.5 : 1.5;
      scored.push({ name: v.name, golden: false, description: v.description, rank });
    }
  }
  scored.sort((a, b) => a.rank - b.rank || (b.golden ? 1 : 0) - (a.golden ? 1 : 0) || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(({ name, golden, description }) => ({ name, golden, description }));
}

// A bare vendor/family label ("cisco", "sap", "windows") is NOT a log source —
// it names a whole product line. Returns the concrete supported variants the
// user must choose between, or [] when the label is already specific.
//
// This deliberately does NOT trust the recognizer's tier. Parser lookup matches
// by prefix, so a family token picks up a partial parser and reports
// exact/hasGolden=true ("cisco" → 9 parser fields, "windows" → 2) — which made
// every caller treat it as a buildable source and silently build a generic pack
// while hiding 24 cisco_* / 5 windows_* variants.
//
// The rule is deliberately narrow, because the risk runs the other way too:
//   - SINGLE token only. A multi-token label is already a product-level name, and
//     gating it would break curated aliases — searchSupportedSourcetypes(
//     'pan_traffic') returns unrelated pan_traffic_* names even though the alias
//     correctly resolves it to palo_alto_traffic.
//   - Never fires when the label IS a supported catalog name.
//   - Needs 2+ variants: with exactly one there is nothing to choose.
//   - The token must be a WHOLE word of the variant's name or description, or a
//     family term (zscaler → zia_alerts). The catalog search matches
//     substrings, so "ps" came back as cisco_ips_alert, proofpoint_pps_* and
//     every description containing "https", and the batch pre-filled
//     cisco_ips_alert for it.
export function getFamilyTokenVariants(label: string, limit = 12): string[] {
  const norm = normalizeSourcetypeName(label);
  if (!norm || norm.includes('_')) return [];
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/);
  const familyNames = new Set(PRODUCT_FAMILY_VARIANTS
    .filter(fam => fam.terms.some(t => t.toLowerCase() === norm))
    .flatMap(fam => fam.variants.map(v => v.name)));
  const variants = searchSupportedSourcetypes(norm).map(m => m.name).filter(name =>
    familyNames.has(name) || words(name).includes(norm) || words(describeSourcetype(name) || '').includes(norm));
  if (variants.includes(norm)) return [];
  return variants.length >= 2 ? variants.slice(0, limit) : [];
}

// --- Multi-format sources + sample-generation grounding -------------------
//
// A handful of well-known sources emit their events in MORE THAN ONE wire
// format depending on how the customer configured the feed (Zscaler NSS: JSON /
// key=value / CEF; Corelight: syslog-wrapped JSON / TSV). When we DON'T already
// have a real reference sample, the AI sample generator has to be told which
// format to emit — left to guess it defaults to JSON and produces garbage for a
// KV/CEF source (the zscaler_web-scored-0 bug). Curated table first (fires
// offline + instantly, like RECOGNITION_HINTS); the AI validator's possibleFormats
// is a fallback for sources not listed here.
//   - Interactive wizard: show a picker so the user confirms the real format.
//   - Batch: pick formats[0] (the most common) and flag the assumption.
export interface MultiFormatOption { id: string; label: string; hint: string; }
export interface MultiFormatSpec { note: string; formats: MultiFormatOption[]; }

const MULTI_FORMAT_SOURCES: { terms: string[]; spec: MultiFormatSpec }[] = [
  { terms: ['zscaler', 'zia', 'nss', 'lss'], spec: {
    note: 'Zscaler NSS/LSS streams web logs as key=value, JSON, or CEF depending on the feed template.',
    formats: [
      { id: 'kv', label: 'Key=value (NSS feed)', hint: 'Format: space-separated key="value" pairs, one event per line, e.g. datetime="2026-06-25 14:23:01" user="jdoe@corp" action="Allowed" reason="Allowed" url="https://example.com/path" urlcategory="Business" appname="General Browsing" reqsize=812 respsize=41233 serverip=203.0.113.10. Use Zscaler NSS web field names.' },
      { id: 'json', label: 'JSON', hint: 'Format: one compact JSON object per line with Zscaler web fields (action, reason, url, urlcategory, appname, user, department, reqsize, respsize, serverip, riskscore).' },
      { id: 'cef', label: 'CEF', hint: 'Format: ArcSight CEF, one per line: CEF:0|Zscaler|NSSWeblog|<ver>|<sig>|<name>|<sev>|act=Allowed reason=Allowed requestClientApplication=... dst=... cs2=<urlcategory> — Zscaler web values in the CEF extension.' },
    ],
  }},
  { terms: ['corelight', 'zeek', 'bro'], spec: {
    note: 'Corelight/Zeek logs are exported either as JSON (one object per line) or TSV (tab-separated Zeek columns).',
    formats: [
      // Every Zeek log has its OWN field set. Naming conn.log's fields here made
      // them appear in ldap, ldap_search and ocsp samples, which no real sensor
      // emits — so the shared part is spelled out and the rest is deferred to
      // the specific log.
      { id: 'json', label: 'JSON (one object/line)', hint: 'Format: one compact JSON object per line. Every event carries _path (the Zeek log name, matching the sourcetype), ts as a fractional epoch, uid, and the id.orig_h/id.orig_p/id.resp_h/id.resp_p tuple. Every OTHER key must be one Zeek defines for that specific log — do not carry conn.log fields (conn_state, orig_bytes, resp_bytes, duration, history, service) into a log that is not conn.' },
      { id: 'tsv', label: 'TSV (Zeek columns)', hint: 'Format: tab-separated Zeek columns for the log named by the sourcetype, in that log\'s own #fields order, ONE event per line, NO header. Use literal TAB characters, "-" for empty fields, a fractional-epoch ts and a Zeek uid. Use only the columns Zeek defines for that log — conn.log columns (conn_state, orig_bytes, resp_bytes, duration, history, service) belong to conn.log alone.' },
    ],
  }},
  { terms: ['fortinet', 'fortigate', 'fgt'], spec: {
    note: 'FortiGate can send logs as native key=value (Fortinet syslog) or as CEF.',
    formats: [
      { id: 'kv', label: 'Key=value (native syslog)', hint: 'Format: FortiOS key=value, one per line, e.g. date=2026-06-25 time=14:23:01 devname="FGT-01" devid="FG100E..." logid="0000000013" type="traffic" subtype="forward" level="notice" srcip=10.1.2.50 dstip=203.0.113.100 dstport=443 action="accept".' },
      { id: 'cef', label: 'CEF', hint: 'Format: CEF, one per line: CEF:0|Fortinet|FortiGate|<ver>|<sig>|<name>|<sev>|src=... dst=... spt=... dpt=... act=accept — FortiGate values in the CEF extension.' },
    ],
  }},
  { terms: ['checkpoint', 'check_point', 'ckp'], spec: {
    note: 'Check Point can export via the Log Exporter as key=value syslog, CEF, or LEEF.',
    formats: [
      { id: 'kv', label: 'Key=value (syslog)', hint: 'Format: syslog with key="value" pairs, one per line, e.g. product="VPN-1 & FireWall-1" action="Accept" src=10.1.1.50 dst=203.0.113.22 proto="tcp" service="443" rule="12".' },
      { id: 'cef', label: 'CEF', hint: 'Format: CEF, one per line: CEF:0|Check Point|VPN-1 & FireWall-1|<ver>|<sig>|<name>|<sev>|act=Accept src=... dst=... dpt=... proto=tcp.' },
      { id: 'leef', label: 'LEEF', hint: 'Format: LEEF 2.0, one per line: LEEF:2.0|Check Point|VPN-1 & FireWall-1|<ver>|<sig>|action=Accept\tsrc=...\tdst=...\tdstPort=... — tab-delimited LEEF attributes.' },
    ],
  }},
  { terms: ['bluecoat', 'proxysg', 'symantec_proxy'], spec: {
    note: 'Blue Coat / Symantec ProxySG access logs use either the W3C ELF (space-separated columns) or the SQUID format.',
    formats: [
      { id: 'elf', label: 'W3C ELF (space-separated)', hint: 'Format: Blue Coat W3C Extended Log Format, space-separated columns, one per line: date time time-taken c-ip cs-username cs-auth-group s-action sc-status s-ip cs-method rs(Content-Type) cs-uri-scheme cs-host cs-uri-port cs-uri-path cs-uri-query cs(User-Agent) sc-bytes cs-bytes x-virus-id.' },
      { id: 'squid', label: 'SQUID', hint: 'Format: SQUID access log, one per line: <epoch>.<ms> <elapsed> <client_ip> <result_code>/<status> <bytes> <method> <url> <user> <hierarchy>/<peer> <content_type>.' },
    ],
  }},
];

/**
 * Returns the multi-format spec for a source that commonly emits more than one
 * wire format, or null. Matches the canonical name AND the input's tokens
 * against the curated terms (so a catalogue_gap variant like "zscaler_nss" or
 * "fgt_traffic" still fires). Deterministic, offline.
 */
export function getMultiFormatSpec(sourcetypeRaw: string): MultiFormatSpec | null {
  const raw = (sourcetypeRaw || '').trim().toLowerCase();
  if (!raw) return null;
  const canonical = canonicalizeSourcetype(sourcetypeRaw);
  const tokens = new Set([
    ...normalizeSourcetypeName(sourcetypeRaw).split('_').filter(Boolean),
    ...normalizeSourcetypeName(canonical).split('_').filter(Boolean),
  ]);
  for (const { terms, spec } of MULTI_FORMAT_SOURCES) {
    if (terms.some(t => tokens.has(t) || canonical.includes(t) || raw.includes(t))) return spec;
  }
  return null;
}

// Grounding context assembled from sourcetype recognition (vendor/product/log
// family/typical fields) plus an optional user-confirmed wire format. Passed to
// BOTH AI sample paths (backend scripts/ai-samples.mjs + iframe aiGenerateSamples)
// so the model generates events that match the REAL product — the recognition
// step's metadata is no longer thrown away. Ordered BEHIND real reference samples
// and the static getFormatHints spec (those still win when present).
export interface SampleGrounding {
  sourcetype: string;
  vendor?: string;
  product?: string;
  logFamily?: string;
  logFormat?: string;          // free-text format hint from recognition/AI
  typicalFields?: string[];
  confirmedFormat?: string;    // id of the format the user/batch picked (multi-format sources)
  formatHint?: string;         // the chosen MultiFormatOption.hint, when a format was picked
}

export function buildSampleGroundingContext(
  meta: { vendor?: string; product?: string; logFamily?: string; logFormat?: string; typicalFields?: string[] } | undefined,
  sourcetype: string,
  confirmedFormat?: string,
): SampleGrounding | undefined {
  const spec = getMultiFormatSpec(sourcetype);
  const chosen = confirmedFormat && spec ? spec.formats.find(f => f.id === confirmedFormat) : undefined;
  const g: SampleGrounding = {
    sourcetype,
    vendor: meta?.vendor?.trim() || undefined,
    product: meta?.product?.trim() || undefined,
    logFamily: meta?.logFamily?.trim() || undefined,
    logFormat: meta?.logFormat?.trim() || undefined,
    typicalFields: Array.isArray(meta?.typicalFields) && meta!.typicalFields!.length ? meta!.typicalFields!.slice(0, 16) : undefined,
    confirmedFormat: chosen?.id,
    formatHint: chosen?.hint,
  };
  // Nothing worth grounding on → return undefined so callers skip the block.
  if (!g.vendor && !g.product && !g.logFamily && !g.logFormat && !g.typicalFields && !g.formatHint) return undefined;
  return g;
}

// Render a SampleGrounding into a prompt block. SHARED assembly point so the
// backend and iframe inject an identical string (Hard Rule 18). Returns '' when
// there's nothing to add.
export function renderSampleGroundingPrompt(g: SampleGrounding | undefined | null): string {
  if (!g) return '';
  const lines: string[] = [];
  if (g.vendor || g.product) lines.push(`- Product: ${[g.vendor, g.product].filter(Boolean).join(' ')}`);
  if (g.logFamily) lines.push(`- Log family: ${g.logFamily}`);
  if (g.formatHint) lines.push(`- REQUIRED wire format (the user confirmed this — emit ONLY this format): ${g.formatHint}`);
  else if (g.logFormat) lines.push(`- Typical wire format: ${g.logFormat}`);
  if (g.typicalFields && g.typicalFields.length) lines.push(`- Fields this source commonly emits (use the REAL names): ${g.typicalFields.join(', ')}`);
  if (!lines.length) return '';
  return `\nKNOWN FACTS ABOUT THIS SOURCE (from sourcetype recognition — match these exactly):\n${lines.join('\n')}\n`;
}

// --- Suspicious activity flagging ---

function getSuspiciousFlagFunctions(sourcetypeRaw: string, toggles: Record<string, boolean>): PipelineFunction[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const enabled = toggles['flag_suspicious'] ?? true;

  switch (sourcetype) {
    case 'windows_powershell':
      return [{
        id: 'eval',
        filter: "EventID === '4104' && ScriptBlockText != null",
        disabled: !enabled,
        description: 'Flag suspicious script blocks based on keyword patterns',
        conf: {
          add: [
            { name: 'suspicious', value: "/DownloadString|DownloadFile|DownloadData|EncodedCommand|FromBase64String|Invoke-Expression|IEX|Invoke-WebRequest|Net\\.WebClient|Start-BitsTransfer|Invoke-Mimikatz|Invoke-ReflectivePEInjection|bypass/i.test(String(ScriptBlockText)) || Level === '3'" },
            { name: 'suspicious_indicators', value: "suspicious === true ? 'keyword match or warning level' : undefined" },
          ],
        },
      }];

    case 'windows_security':
      return [{
        id: 'eval',
        filter: 'true',
        disabled: !enabled,
        description: 'Flag failed logons and privilege escalation',
        conf: {
          add: [
            { name: 'suspicious', value: "EventID === '4625' || EventID === '4672' || EventID === '4720' || EventID === '4726'" },
            { name: 'suspicious_indicators', value: "EventID === '4625' ? 'failed logon' : EventID === '4672' ? 'special privileges' : EventID === '4720' ? 'user created' : EventID === '4726' ? 'user deleted' : undefined" },
          ],
        },
      }];

    case 'windows_sysmon':
      return [{
        id: 'eval',
        filter: 'true',
        disabled: !enabled,
        description: 'Flag events matching MITRE ATT&CK patterns',
        conf: {
          add: [
            { name: 'suspicious', value: "RuleName && /technique_id=T1/.test(RuleName)" },
            { name: 'mitre_technique', value: "RuleName ? RuleName.replace('technique_id=', '') : undefined" },
          ],
        },
      }];

    default:
      return [];
  }
}

// --- Schema mapping ---

export function getMappingFunctions(sourcetypeRaw: string, destFormat: string): PipelineFunction[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  // asim#<dataClass> variants share the legacy static ASIM fallback (the golden
  // path via resolveGoldenFormat is the primary route for these).
  if (isAsimFormat(destFormat)) return getAsimMapping(sourcetype);
  // Raw-fidelity (plan Task 5): no per-field mapping — a minimal envelope +
  // the shared vendor/product tag, same as the early return in
  // buildPipelineFunctionsWithMappings. Checked here too (not just the switch's
  // literal 'nextgen' case) because a concretized 'nextgen#<class>' must be
  // caught as well, and because optimize-pipeline.ts/staged-build.ts call
  // getMappingFunctions directly for repair/re-score flows, bypassing that
  // early return.
  if (isNextGenRawFidelityFormat(destFormat)) {
    const dataClass = destFormat.includes('#') ? destFormat.split('#')[1] : staticDataClassFor(sourcetype);
    return [...buildOcsfEnvelopeHeader(sourcetype, dataClass), ...buildRawFidelityTagFunctions()];
  }
  switch (destFormat) {
    case 'ocsf': return getOcsfMapping(sourcetype);
    case 'cef': return getPureCefMapping(sourcetype);
    case 'commonsecuritylog': return getCommonSecurityLogMapping(sourcetype);
    case 'cim': return getCimMapping(sourcetype);
    case 'ecs': return getEcsMapping(sourcetype);
    case 'asim': return getAsimMapping(sourcetype);
    case 'chronicle': return getChronicleMapping(sourcetype);
    case 'json': return getJsonMapping(sourcetype);
    default: return [];
  }
}


// OCSF class definitions for the deterministic envelope. Each carries the class
// UID/category and the nested-object leaves that class populates from CANONICAL
// field names (produced by the parser + schematizer aliases that run before any
// mapping — see buildSchematizerCanonicalAliases). This is the single source of
// truth the legacy/static OCSF path uses; the golden-format path (golden-formats
// .json) is a parallel, richer spec for the same classes.
interface OcsfEnvelopeLeaf { dest: string; expr: string; number?: boolean }
interface OcsfClassDef {
  classUid: number;
  categoryUid: number;
  className: string;
  categoryName: string;
  typeExpr?: string;   // type_uid; defaults to classUid*100
  leaves: OcsfEnvelopeLeaf[];
}
// Common canonical-field reads shared across classes. Light source-native
// fallbacks (srcaddr/srcip/…) keep the static path honest even when the
// schematizer alias step did not run ahead of it.
const OCSF_SRC_IP = "src_ip || srcaddr || srcip || src";
const OCSF_DST_IP = "dest_ip || dst_ip || dstaddr || dstip || dst";
const OCSF_USER = "user || src_user || suser || username";
const OCSF_HOST = "host || hostname || devname || dvchost";
const OCSF_CLASSES: Record<string, OcsfClassDef> = {
  network: {
    classUid: 4001, categoryUid: 4, className: 'Network Activity', categoryName: 'Network Activity',
    leaves: [
      { dest: 'src_endpoint.ip', expr: OCSF_SRC_IP },
      { dest: 'src_endpoint.port', expr: 'src_port || srcport || spt', number: true },
      { dest: 'dst_endpoint.ip', expr: OCSF_DST_IP },
      { dest: 'dst_endpoint.port', expr: 'dest_port || dst_port || dstport || dpt', number: true },
      { dest: 'connection_info.protocol_name', expr: "(transport || protocol || proto || '').toString().toLowerCase() || undefined" },
      { dest: 'traffic.bytes_in', expr: 'bytes_in || rcvdbyte || in_bytes', number: true },
      { dest: 'traffic.bytes_out', expr: 'bytes_out || sentbyte || out_bytes', number: true },
      { dest: 'actor.user.name', expr: OCSF_USER },
      { dest: 'device.hostname', expr: OCSF_HOST },
    ],
  },
  authentication: {
    classUid: 3002, categoryUid: 3, className: 'Authentication', categoryName: 'Identity & Access Management',
    leaves: [
      { dest: 'actor.user.name', expr: "user || src_user || TargetUserName || SubjectUserName || UserName" },
      { dest: 'user.name', expr: "dest_user || TargetUserName || user || UserName" },
      { dest: 'src_endpoint.ip', expr: "src_ip || IpAddress || ipAddress || client_ip" },
      { dest: 'src_endpoint.hostname', expr: "src_host || WorkstationName" },
      { dest: 'dst_endpoint.hostname', expr: "dest_host || Computer" },
      { dest: 'device.hostname', expr: OCSF_HOST },
    ],
  },
  web_proxy: {
    classUid: 4002, categoryUid: 4, className: 'HTTP Activity', categoryName: 'Network Activity',
    leaves: [
      { dest: 'src_endpoint.ip', expr: OCSF_SRC_IP },
      { dest: 'dst_endpoint.ip', expr: OCSF_DST_IP },
      { dest: 'dst_endpoint.port', expr: 'dest_port || dst_port || dstport', number: true },
      { dest: 'http_request.url.text', expr: "url || uri || request || http_url" },
      { dest: 'http_request.http_method', expr: "http_method || method || requestMethod" },
      { dest: 'http_request.user_agent', expr: "http_user_agent || user_agent || useragent" },
      { dest: 'http_response.code', expr: "status || status_code || http_status || response_code", number: true },
      { dest: 'actor.user.name', expr: OCSF_USER },
      { dest: 'device.hostname', expr: OCSF_HOST },
    ],
  },
  endpoint: {
    classUid: 1007, categoryUid: 1, className: 'Process Activity', categoryName: 'System Activity',
    leaves: [
      { dest: 'process.name', expr: "process_name || Image || ProcessName || process" },
      { dest: 'process.cmd_line', expr: "command_line || CommandLine || cmdline" },
      { dest: 'process.pid', expr: "pid || ProcessId || process_id", number: true },
      { dest: 'actor.user.name', expr: "user || src_user || User || SubjectUserName" },
      { dest: 'device.hostname', expr: OCSF_HOST },
    ],
  },
  email: {
    classUid: 4009, categoryUid: 4, className: 'Email Activity', categoryName: 'Network Activity',
    leaves: [
      { dest: 'email.from', expr: "sender || src_user || mail_from || from" },
      { dest: 'email.subject', expr: "subject || mail_subject" },
      { dest: 'src_endpoint.ip', expr: OCSF_SRC_IP },
      { dest: 'device.hostname', expr: OCSF_HOST },
    ],
  },
  dns: {
    classUid: 4003, categoryUid: 4, className: 'DNS Activity', categoryName: 'Network Activity',
    leaves: [
      { dest: 'query.hostname', expr: "query || dns_query || domain || question" },
      { dest: 'src_endpoint.ip', expr: OCSF_SRC_IP },
      { dest: 'dst_endpoint.ip', expr: OCSF_DST_IP },
      { dest: 'device.hostname', expr: OCSF_HOST },
    ],
  },
  cloud_audit: {
    classUid: 6003, categoryUid: 6, className: 'API Activity', categoryName: 'Application Activity',
    leaves: [
      { dest: 'actor.user.name', expr: "user || src_user || principal || userIdentity" },
      { dest: 'src_endpoint.ip', expr: "src_ip || source_ip || sourceIPAddress" },
      { dest: 'api.operation', expr: "operation || event_name || eventName || action" },
      { dest: 'api.service.name', expr: "service || event_source || eventSource" },
      { dest: 'device.hostname', expr: OCSF_HOST },
    ],
  },
  // Base Event (1001): a well-formed OCSF envelope for a source with no specific
  // class. It still opportunistically populates endpoints/user/device when the
  // canonical fields are present, so a generic source carries real event signal
  // instead of the old bare shell.
  base: {
    classUid: 1001, categoryUid: 1, className: 'Base Event', categoryName: 'System Activity',
    leaves: [
      { dest: 'src_endpoint.ip', expr: OCSF_SRC_IP },
      { dest: 'dst_endpoint.ip', expr: OCSF_DST_IP },
      { dest: 'actor.user.name', expr: OCSF_USER },
      { dest: 'device.hostname', expr: OCSF_HOST },
      { dest: 'message', expr: "message || msg || _raw" },
    ],
  },
};

// Map a data class → the OCSF envelope class definition key. `audit` events are
// authentication-shaped (3002, per DATACLASS_RECOMMENDATION); everything without
// a specific class falls to the Base Event envelope.
function ocsfClassKeyForDataClass(dataClass: string): string {
  if (dataClass === 'audit') return 'authentication';
  return OCSF_CLASSES[dataClass] ? dataClass : 'base';
}

/**
 * Presence guard for a mapped leaf: the source is set and not a junk literal
 * ('', '-', 'undefined', 'null'). `!= null` keeps a real 0. One regex instead of
 * four String() comparisons, so the source expression appears twice rather than
 * five times — the same result, a fraction of the length.
 */
export function presentExpr(src: string): string {
  return `(${src}) != null && !/^(?:|-|undefined|null)$/.test(String(${src}))`;
}

// Build a deterministic, WELL-FORMED OCSF envelope (class UIDs, severity, time,
// metadata.product, and nested objects created parent-first) from canonical
// fields. Emits eval `add` functions only (no cleanup) — the caller's mapping
// stage appends the usual compact/keep steps. Parent objects are created BEFORE
// their dotted leaves (Cribl drops a dotted `add` whose parent object is absent)
// and only when a descendant leaf carries a real value, so an absent object does
// not leak an empty `{}`. metadata.product is always populated from
// getCefVendorInfo — this is what a downstream OCSF→CEF header reads for
// vendor/product (an unpopulated metadata.product is the "Unknown|OCSF" tell).
export function buildOcsfEnvelope(sourcetypeRaw: string, dataClass: string): PipelineFunction[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const def = OCSF_CLASSES[ocsfClassKeyForDataClass(dataClass)];
  const VE = cefVendorExpressions(sourcetype);
  const typeExpr = def.typeExpr || String(def.classUid * 100);

  // Leaf value + presence expr (mirrors buildGoldenFormatMapping): emit undefined
  // when the source is absent/junk so Cribl omits the field. `!= null` keeps 0.
  const leafInfo = def.leaves.map(l => {
    const src = l.expr;
    const present = presentExpr(src);
    const emit = l.number ? `Number(${src})` : `(${src})`;
    return { name: l.dest, value: `${present} ? ${emit} : undefined`, present };
  });

  // Parent objects, shallow-first, created only when a descendant leaf is present.
  const parents: string[] = [];
  const seen = new Set<string>();
  for (const l of def.leaves) {
    const segs = l.dest.split('.');
    for (let d = 1; d < segs.length; d++) {
      const prefix = segs.slice(0, d).join('.');
      if (!seen.has(prefix)) { seen.add(prefix); parents.push(prefix); }
    }
  }
  const parentInits = parents.map(p => {
    const prefix = p + '.';
    const guards = leafInfo.filter(l => l.name.startsWith(prefix)).map(l => `(${l.present})`);
    return { name: p, value: `(${guards.join(' || ') || 'false'}) ? {} : undefined` };
  });

  // metadata.product is a nested object too — create it parent-first.
  const metaInits = [
    { name: 'metadata', value: '{}' },
    { name: 'metadata.product', value: '{}' },
  ];
  const metaLeaves = [
    { name: 'metadata.version', value: "'1.9.0'" },
    { name: 'metadata.product.name', value: VE.product },
    { name: 'metadata.product.vendor_name', value: VE.vendor },
    { name: 'metadata.product.version', value: VE.version },
  ];

  const header = [
    { name: 'class_uid', value: String(def.classUid) },
    { name: 'class_name', value: `'${def.className}'` },
    { name: 'category_uid', value: String(def.categoryUid) },
    { name: 'category_name', value: `'${def.categoryName}'` },
    { name: 'type_uid', value: typeExpr, },
    { name: 'severity_id', value: '1' },
    { name: 'severity', value: "'Informational'" },
    { name: 'time', value: 'Math.round((_time || Date.now()/1000) * 1000)' },
  ];

  // Order: header literals → parent inits (event objects, then metadata) → leaves.
  const adds = [...header, ...parentInits, ...metaInits, ...leafInfo.map(({ name, value }) => ({ name, value })), ...metaLeaves];
  const fns: PipelineFunction[] = [];
  for (let i = 0; i < adds.length; i += 15) {
    fns.push({
      id: 'eval',
      description: i === 0 ? `OCSF ${def.className} (${def.classUid}) envelope` : `OCSF envelope (cont. ${i + 1})`,
      conf: { add: adds.slice(i, i + 15) },
    });
  }
  return fns;
}

/**
 * The HEADER-ONLY subset of `buildOcsfEnvelope` — class/category identity plus
 * `metadata.product` — with NO per-leaf field mapping. Used by the `nextgen`
 * (CrowdStrike NG-SIEM) raw-fidelity destination (plan Task 5): unlike `ocsf`,
 * `nextgen` no longer maps individual fields, but the optimization stage's
 * runtime `class_uid`/vendor guards and `buildRawFidelityTagFunctions()`
 * (src/raw-fidelity.ts) both need SOMETHING to read, so this gives every
 * `nextgen` event a minimal, real OCSF identity without touching `_raw` or any
 * already-extracted canonical field.
 */
export function buildOcsfEnvelopeHeader(sourcetypeRaw: string, dataClass: string): PipelineFunction[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const def = OCSF_CLASSES[ocsfClassKeyForDataClass(dataClass)];
  const VE = cefVendorExpressions(sourcetype);
  const typeExpr = def.typeExpr || String(def.classUid * 100);
  const header = [
    { name: 'class_uid', value: String(def.classUid) },
    { name: 'class_name', value: `'${def.className}'` },
    { name: 'category_uid', value: String(def.categoryUid) },
    { name: 'category_name', value: `'${def.categoryName}'` },
    { name: 'type_uid', value: typeExpr },
    { name: 'severity_id', value: '1' },
    { name: 'severity', value: "'Informational'" },
    { name: 'time', value: 'Math.round((_time || Date.now()/1000) * 1000)' },
  ];
  const metaInits = [
    { name: 'metadata', value: '{}' },
    { name: 'metadata.product', value: '{}' },
  ];
  const metaLeaves = [
    { name: 'metadata.version', value: "'1.9.0'" },
    { name: 'metadata.product.name', value: VE.product },
    { name: 'metadata.product.vendor_name', value: VE.vendor },
    { name: 'metadata.product.version', value: VE.version },
  ];
  return [{
    id: 'eval',
    description: `OCSF ${def.className} (${def.classUid}) minimal envelope — class/category/vendor only, raw-fidelity`,
    conf: { add: [...header, ...metaInits, ...metaLeaves] },
  }];
}

function getOcsfMapping(sourcetype: string): PipelineFunction[] {
  // Static/legacy OCSF path: build a well-formed envelope for the source's data
  // class from canonical fields. (The primary route for known sources is the
  // deterministic golden-format path via buildGoldenFormatMapping; this is the
  // fallback when there is no golden path and no AI mapping.)
  const dataClass = staticDataClassFor(canonicalizeSourcetype(sourcetype));
  return buildOcsfEnvelope(sourcetype, ocsfClassKeyForDataClass(dataClass));
}

function getPureCefMapping(sourcetype: string): PipelineFunction[] {
  const isNetwork = ['cisco_asa', 'cisco_firepower', 'palo_alto_traffic', 'fortinet_fortigate', 'checkpoint_firewall', 'aws_vpc_v5'].includes(sourcetype);
  const isAuth = ['windows_security', 'azure_signin', 'okta_system'].includes(sourcetype);
  const isEndpoint = ['windows_powershell', 'windows_sysmon', 'windows_system', 'windows_defender', 'crowdstrike_falcon'].includes(sourcetype);
  const isWebmail = sourcetype === 'roundcube_mail';
  const isMail = sourcetype === 'cisco_esa';

  const VENDOR_MAP: Record<string, { vendor: string; product: string; version: string; prefix: string }> = {
    cisco_asa: { vendor: 'Cisco', product: 'ASA', version: '9.x', prefix: 'CSCASA' },
    cisco_firepower: { vendor: 'Cisco', product: 'Firepower', version: '7.x', prefix: 'CSCFP' },
    cisco_esa: { vendor: 'Cisco', product: 'Email Security Appliance', version: '15.0', prefix: 'CSCESA' },
    palo_alto_traffic: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x', prefix: 'PAN' },
    palo_alto_threat: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x', prefix: 'PAN' },
    fortinet_fortigate: { vendor: 'Fortinet', product: 'Fortigate', version: 'v7.x', prefix: 'FTNTFGT' },
    checkpoint_firewall: { vendor: 'Check Point', product: 'SmartDefense', version: 'R81', prefix: 'CP' },
    aws_vpc_v5: { vendor: 'AWS', product: 'VPC Flow Logs', version: '5', prefix: 'AWS' },
    windows_security: { vendor: 'Microsoft', product: 'Windows', version: '10', prefix: 'MSWIN' },
    windows_powershell: { vendor: 'Microsoft', product: 'PowerShell', version: '5.1', prefix: 'MSPS' },
    windows_sysmon: { vendor: 'Microsoft', product: 'Sysmon', version: '15.x', prefix: 'MSSYSMON' },
    windows_system: { vendor: 'Microsoft', product: 'Windows', version: '10', prefix: 'MSWIN' },
    windows_application: { vendor: 'Microsoft', product: 'Windows', version: '10', prefix: 'MSWIN' },
    windows_defender: { vendor: 'Microsoft', product: 'Defender Antivirus', version: '4.18', prefix: 'MSDEF' },
    windows_dns_client: { vendor: 'Microsoft', product: 'DNS Client', version: '10', prefix: 'MSDNSC' },
    azure_signin: { vendor: 'Microsoft', product: 'Azure AD', version: '1.0', prefix: 'MSAAD' },
    okta_system: { vendor: 'Okta', product: 'Identity Cloud', version: '2023.x', prefix: 'OKTA' },
    roundcube_mail: { vendor: 'Roundcube', product: 'Webmail', version: '1.6', prefix: 'RC' },
  };

  const info = VENDOR_MAP[sourcetype] || { vendor: sourcetype, product: 'Security', version: '1.0', prefix: 'DEV' };
  const infoExpr = VENDOR_MAP[sourcetype]
    ? { vendor: `'${info.vendor}'`, product: `'${info.product}'`, version: `'${info.version}'` }
    : cefVendorExpressions(sourcetype);
  const functions: PipelineFunction[] = [];
  const P = info.prefix;

  // CEF format: host CEF:cefVersion|vendor|product|version|signatureId|name|severity|ext
  // Cribl serde does NOT support type:'cef', so we build the CEF string manually.
  // We use chunked evals (max 6-8 fields each) to avoid silent failures in Cribl eval.
  // The `in` keyword is reserved in JS — always access via __e['in'].

  // Step 1a: Build CEF header fields
  functions.push({
    id: 'eval', description: 'CEF header fields',
    conf: {
      add: [
        { name: '__cef_host', value: "String(devid || serial || hostname || host || 'host')" },
        // A CEF source already carries its Device Vendor/Product/Version in the
        // header the parser read; only a non-CEF source falls back to a constant.
        { name: '__cef_vendor', value: infoExpr.vendor },
        { name: '__cef_product', value: infoExpr.product },
        { name: '__cef_version', value: infoExpr.version },
        ...(isNetwork ? [
          { name: '__cef_id', value: "String(logid || msg_id || subtype || 'traffic')" },
          { name: '__cef_name', value: "String((type || 'traffic') + ':' + (subtype || 'forward') + ' ' + (action || act || 'event'))" },
          { name: '__cef_severity', value: "level == 'emergency' || level == 'alert' || level == 'critical' ? '10' : level == 'error' ? '8' : level == 'warning' ? '6' : level == 'notice' ? '3' : level == 'info' ? '1' : String(severity || pri || '3')" },
        ] : isAuth ? [
          { name: '__cef_id', value: "String(EventID || eventType || 'auth')" },
          { name: '__cef_name', value: "EventID == '4624' ? 'Logon Success' : EventID == '4625' ? 'Logon Failed' : EventID == '4634' ? 'Logoff' : String(displayMessage || 'Authentication')" },
          { name: '__cef_severity', value: "EventID == '4625' || (outcome && outcome.result == 'FAILURE') ? '7' : '3'" },
        ] : isEndpoint ? [
          { name: '__cef_id', value: "String(EventID || '')" },
          { name: '__cef_name', value: "String(message || Task || 'Process Activity')" },
          { name: '__cef_severity', value: "Level == '1' || Level == 'Critical' ? '10' : Level == '2' || Level == 'Error' ? '8' : Level == '3' || Level == 'Warning' ? '6' : '3'" },
        ] : isWebmail ? [
          { name: '__cef_id', value: "String(event_class || 'other')" },
          { name: '__cef_name', value: "event_class == 'auth:success' ? 'User Login Success' : event_class == 'auth:failure' ? 'User Login Failed' : event_class == 'imap:error' ? 'IMAP Connection Error' : event_class == 'email:sent' ? 'Email Sent' : event_class == 'smtp:error' ? 'SMTP Error' : event_class == 'session:expired' ? 'Session Expired' : event_class == 'file:download' ? 'Attachment Download' : event_class == 'account:change' ? 'Password Changed' : 'Roundcube Event'" },
          { name: '__cef_severity', value: "rc_level == 'ERROR' ? '7' : rc_level == 'WARNING' ? '5' : '3'" },
        ] : isMail ? [
          { name: '__cef_id', value: "String(action || 'mail')" },
          { name: '__cef_name', value: "action == 'delivered' ? 'Message Delivered' : action == 'dropped' ? 'Message Dropped' : action == 'quarantined' ? 'Message Quarantined' : action == 'bounced' ? 'Message Bounced' : av_verdict == 'positive' ? 'Virus Detected' : spam_verdict == 'positive' ? 'Spam Detected' : 'Message Received'" },
          { name: '__cef_severity', value: "av_verdict == 'positive' ? '9' : spam_verdict == 'positive' ? '7' : action == 'dropped' || action == 'bounced' ? '6' : level == 'Critical' ? '9' : level == 'Warning' ? '5' : '3'" },
        ] : [
          { name: '__cef_id', value: "String(eventType || EventID || category || 'event')" },
          { name: '__cef_name', value: "String(message || displayMessage || msg || 'Event')" },
          { name: '__cef_severity', value: "String(severity || level || '5')" },
        ]),
      ],
    },
  });

  // Step 1b: Build CEF header string
  functions.push({
    id: 'eval', description: 'Assemble CEF header',
    conf: {
      add: [
        { name: '__cef_hdr', value: "__cef_host + ' CEF:0|' + __cef_vendor + '|' + __cef_product + '|' + __cef_version + '|' + __cef_id + '|' + __cef_name + '|' + __cef_severity + '|'" },
      ],
    },
  });

  // Step 2: Build extension key=value pairs in small chunks, appending to __cef_ext
  if (isNetwork) {
    // Chunk 1: identity and category fields (6 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — identity fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "'deviceExternalId=' + String(devid || serial || hostname || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' ' + '" + P + "logid=' + String(logid || msg_id || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' cat=' + String((type || 'traffic') + ':' + (subtype || ''))" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "subtype=' + String(subtype || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "level=' + String(level || '')" },
        ],
      },
    });
    // Chunk 2: source fields (4 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — source fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' src=' + String(src_ip || srcaddr || srcip || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' spt=' + String(src_port || srcport || sport || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' deviceInboundInterface=' + String(srcintf || inbound_if || in_interface || '')" },
        ],
      },
    });
    // Chunk 3: destination fields (4 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — destination fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' dst=' + String(dst_ip || dstaddr || dstip || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' dpt=' + String(dst_port || dstport || dport || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' deviceOutboundInterface=' + String(dstintf || outbound_if || out_interface || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' externalId=' + String(session_id || sessionid || log_id || '')" },
        ],
      },
    });
    // Chunk 4: protocol, action, policy, app (4 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — protocol and action',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' proto=' + String(protocol || proto || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' act=' + String(action || act || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "policyid=' + String(policyid || policy_id || rule_id || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' app=' + String(app || service || app_proto || '')" },
        ],
      },
    });
    // Chunk 5: NAT and bytes (6 fields) — uses __e['in'] to avoid reserved word
    functions.push({
      id: 'eval', description: 'CEF extension — NAT and byte counts',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' sourceTranslatedAddress=' + String(transip || nat_src_ip || xlatesrc || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' sourceTranslatedPort=' + String(transport || nat_src_port || xlatesport || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' out=' + String(sentbyte || bytes_out || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' in=' + String(rcvdbyte || bytes_in || __e['in'] || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "sentpkt=' + String(sentpkt || packets_out || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "rcvdpkt=' + String(rcvdpkt || packets_in || '')" },
        ],
      },
    });
    // Chunk 6: duration
    functions.push({
      id: 'eval', description: 'CEF extension — duration',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "duration=' + String(duration || '')" },
        ],
      },
    });
  } else if (isAuth) {
    // Chunk 1: identity and source (5 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — auth identity fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "'deviceExternalId=' + String(Computer || hostname || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "logid=' + String(EventID || eventType || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' cat=authentication'" },
          { name: '__cef_ext', value: "__cef_ext + ' src=' + String(IpAddress || ipAddress || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' suser=' + String(SubjectUserName || UserName || '')" },
        ],
      },
    });
    // Chunk 2: target and action (5 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — auth action fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' duser=' + String(TargetUserName || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' act=' + (EventID == '4624' || (outcome && outcome.result == 'SUCCESS') ? 'success' : 'failure')" },
          { name: '__cef_ext', value: "__cef_ext + ' dhost=' + String(Computer || WorkstationName || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' cs1Label=Reason cs1=' + String(FailureReason || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' cs2Label=TargetApp cs2=' + String(appDisplayName || '')" },
        ],
      },
    });
  } else if (isEndpoint) {
    // Chunk 1: identity and category (5 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — endpoint identity fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "'deviceExternalId=' + String(Computer || hostname || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "logid=' + String(EventID || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' cat=endpoint'" },
          { name: '__cef_ext', value: "__cef_ext + ' src=' + String(SourceIp || IpAddress || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' dst=' + String(DestinationIp || '')" },
        ],
      },
    });
    // Chunk 2: process and file fields (6 fields)
    functions.push({
      id: 'eval', description: 'CEF extension — endpoint process fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' dpt=' + String(DestinationPort || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' suser=' + String(UserID || SubjectUserName || User || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' shost=' + String(Computer || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' act=Observed'" },
          { name: '__cef_ext', value: "__cef_ext + ' fname=' + String(Image || TargetFilename || Path || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' cs1Label=CommandLine cs1=' + String(CommandLine || '').substring(0, 1024)" },
        ],
      },
    });
    // Chunk 3: process ID
    functions.push({
      id: 'eval', description: 'CEF extension — endpoint process ID',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' cs2Label=ProcessId cs2=' + String(ProcessId || ProcessID || '')" },
        ],
      },
    });
  } else if (isWebmail) {
    functions.push({
      id: 'eval', description: 'CEF extension — webmail fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "'act=' + String(action || 'Observed')" },
          { name: '__cef_ext', value: "__cef_ext + ' suser=' + String(rc_user || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' src=' + String(rc_src_ip || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' dhost=' + String(rc_dst_host || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' dpt=' + String(rc_dst_port || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' app=' + String(rc_protocol || 'HTTP')" },
        ],
      },
    });
    functions.push({
      id: 'eval', description: 'CEF extension — webmail optional fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "rc_user_agent ? __cef_ext + ' requestClientApplication=' + rc_user_agent : __cef_ext" },
          { name: '__cef_ext', value: "rc_recipient ? __cef_ext + ' duser=' + rc_recipient : __cef_ext" },
          { name: '__cef_ext', value: "__cef_ext + ' rt=' + String(rc_timestamp || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' msg=' + String(rc_message || '').substring(0, 200)" },
        ],
      },
    });
  } else if (isMail) {
    functions.push({
      id: 'eval', description: 'CEF extension — mail fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "'act=' + String(action || 'received')" },
          { name: '__cef_ext', value: "__cef_ext + ' suser=' + String(sender || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' duser=' + String(recipient || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' src=' + String(src_ip || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' dvchost=' + String(reverse_dns || host || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "mid=' + String(mid || '')" },
        ],
      },
    });
    functions.push({
      id: 'eval', description: 'CEF extension — mail verdicts and subject',
      conf: {
        add: [
          { name: '__cef_ext', value: "__cef_ext + ' " + P + "icid=' + String(icid || '')" },
          { name: '__cef_ext', value: "spam_verdict ? __cef_ext + ' " + P + "spamVerdict=' + spam_verdict : __cef_ext" },
          { name: '__cef_ext', value: "av_verdict ? __cef_ext + ' " + P + "avVerdict=' + av_verdict : __cef_ext" },
          { name: '__cef_ext', value: "av_name ? __cef_ext + ' " + P + "threatName=' + av_name : __cef_ext" },
          { name: '__cef_ext', value: "__cef_ext + ' msg=' + String(subject || msg_body || '').substring(0, 200)" },
        ],
      },
    });
  } else {
    // Generic: single chunk (all fields fit safely)
    functions.push({
      id: 'eval', description: 'CEF extension — generic fields',
      conf: {
        add: [
          { name: '__cef_ext', value: "'deviceExternalId=' + String(hostname || host || Computer || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' cat=' + String(category || type || 'event')" },
          { name: '__cef_ext', value: "__cef_ext + ' src=' + String(src_ip || srcaddr || IpAddress || ipAddress || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' dst=' + String(dst_ip || dstaddr || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' suser=' + String(user || UserName || SubjectUserName || '')" },
          { name: '__cef_ext', value: "__cef_ext + ' act=' + String(action || outcome || result || 'Observed')" },
          { name: '__cef_ext', value: "__cef_ext + ' shost=' + String(host || Computer || hostname || '')" },
        ],
      },
    });
  }

  // Step 3: Assemble final _raw = header + extension
  functions.push({
    id: 'eval', description: 'Assemble CEF _raw from header + extension',
    conf: {
      add: [
        { name: '_raw', value: "__cef_hdr + __cef_ext" },
      ],
    },
  });

  // Step 4: Strip all intermediate/parsed fields — only keep _raw
  functions.push({
    id: 'eval', description: 'Remove all fields — keep only CEF _raw',
    conf: {
      remove: ['*'],
      keep: ['_raw', '_time', 'cribl_breaker', 'cribl_pipe', 'index', 'source', 'sourcetype', 'host'],
    },
  });

  return functions;
}

function getCommonSecurityLogMapping(sourcetype: string): PipelineFunction[] {
  const isNetwork = ['cisco_asa', 'cisco_firepower', 'palo_alto_traffic', 'fortinet_fortigate', 'checkpoint_firewall', 'aws_vpc_v5'].includes(sourcetype);
  const isAuth = ['windows_security', 'azure_signin', 'okta_system'].includes(sourcetype);
  const isEndpoint = ['windows_powershell', 'windows_sysmon', 'windows_system', 'windows_defender', 'crowdstrike_falcon'].includes(sourcetype);

  const VENDOR_MAP: Record<string, { vendor: string; product: string; version: string }> = {
    cisco_asa: { vendor: 'Cisco', product: 'ASA', version: '9.x' },
    cisco_firepower: { vendor: 'Cisco', product: 'Firepower', version: '7.x' },
    palo_alto_traffic: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x' },
    palo_alto_threat: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x' },
    fortinet_fortigate: { vendor: 'Fortinet', product: 'FortiGate', version: '7.x' },
    checkpoint_firewall: { vendor: 'Check Point', product: 'SmartDefense', version: 'R81' },
    aws_vpc_v5: { vendor: 'AWS', product: 'VPC Flow Logs', version: '5' },
    windows_security: { vendor: 'Microsoft', product: 'Windows', version: '10' },
    windows_powershell: { vendor: 'Microsoft', product: 'PowerShell', version: '5.1' },
    windows_sysmon: { vendor: 'Microsoft', product: 'Sysmon', version: '15.x' },
    windows_system: { vendor: 'Microsoft', product: 'Windows', version: '10' },
    windows_application: { vendor: 'Microsoft', product: 'Windows', version: '10' },
    windows_defender: { vendor: 'Microsoft', product: 'Defender Antivirus', version: '4.18' },
    windows_dns_client: { vendor: 'Microsoft', product: 'DNS Client', version: '10' },
    azure_signin: { vendor: 'Microsoft', product: 'Azure AD', version: '1.0' },
    okta_system: { vendor: 'Okta', product: 'Identity Cloud', version: '2023.x' },
  };

  const info = { ...(VENDOR_MAP[sourcetype] || { vendor: sourcetype, product: 'Security', version: '1.0' }), ...SENTINEL_CSL_IDENTITY[sourcetype] };

  // Code function to collect unmapped fields into Message as JSON
  const collectUnmappedCode: PipelineFunction = {
    id: 'code',
    description: 'Collect unmapped fields into Message as JSON',
    conf: {
      maxNumOfIterations: 5000,
      code: [
        'const CSL_FIELDS = new Set([',
        '  "TimeGenerated","DeviceVendor","DeviceProduct","DeviceVersion",',
        '  "DeviceEventClassID","Activity","LogSeverity","DeviceAction",',
        '  "Protocol","SourceIP","SourcePort","DestinationIP","DestinationPort",',
        '  "SentBytes","ReceivedBytes","DeviceInboundInterface","DeviceOutboundInterface",',
        '  "ApplicationProtocol","SourceTranslatedAddress","SourceTranslatedPort",',
        '  "DestinationTranslatedAddress","DestinationTranslatedPort",',
        '  "DeviceName","DeviceExternalID","DeviceAddress","DeviceTimeZone",',
        '  "SourceHostName","SourceUserName","SourceUserID","SourceMACAddress",',
        '  "SourceProcessName","SourceProcessId","SourceNTDomain","SourceDnsDomain",',
        '  "DestinationHostName","DestinationUserName","DestinationUserID",',
        '  "DestinationProcessName","DestinationProcessId","DestinationMACAddress",',
        '  "CommunicationDirection","Message","EventCount","EventOutcome","EventType",',
        '  "RequestURL","RequestMethod","RequestClientApplication","RequestContext",',
        '  "FileName","FilePath","FileSize","FileType","FileHash",',
        '  "DeviceCustomString1","DeviceCustomString1Label",',
        '  "DeviceCustomString2","DeviceCustomString2Label",',
        '  "DeviceCustomString3","DeviceCustomString3Label",',
        '  "DeviceCustomString4","DeviceCustomString4Label",',
        '  "DeviceCustomString5","DeviceCustomString5Label",',
        '  "DeviceCustomString6","DeviceCustomString6Label",',
        '  "FieldDeviceCustomNumber1","DeviceCustomNumber1Label",',
        '  "FieldDeviceCustomNumber2","DeviceCustomNumber2Label",',
        '  "FieldDeviceCustomNumber3","DeviceCustomNumber3Label",',
        '  "DeviceCustomDate1","DeviceCustomDate1Label",',
        '  "DeviceCustomDate2","DeviceCustomDate2Label",',
        '  "FlexString1","FlexString1Label","FlexString2","FlexString2Label",',
        '  "StartTime","EndTime","Reason","AdditionalExtensions",',
        '  "ExtID","ProcessID","ProcessName","SimplifiedDeviceAction",',
        '  "OriginalLogSeverity","DeviceEventCategory","Computer",',
        '  "_time","_raw","index","source","sourcetype","host","cribl_breaker","cribl_pipe"',
        ']);',
        'const extra = {};',
        'for (const key of Object.keys(__e)) {',
        '  if (key.startsWith("__") || key.startsWith("cribl_")) continue;',
        '  if (CSL_FIELDS.has(key)) continue;',
        '  const val = __e[key];',
        '  if (val !== undefined && val !== null && val !== "") extra[key] = val;',
        '}',
        'if (Object.keys(extra).length > 0) {',
        '  __e.Message = JSON.stringify(extra);',
        '}',
      ].join('\n'),
    },
  };

  if (isNetwork) {
    return [
      {
        id: 'eval', description: 'Map to CommonSecurityLog — header + timing',
        conf: {
          add: [
            { name: 'TimeGenerated', value: "new Date((_time || Date.now()/1000) * 1000).toISOString()" },
            { name: 'DeviceVendor', value: `'${info.vendor}'` },
            { name: 'DeviceProduct', value: `'${info.product}'` },
            { name: 'DeviceVersion', value: `'${info.version}'` },
            { name: 'DeviceEventClassID', value: "logid || msg_id || subtype || 'traffic'" },
            { name: 'Activity', value: "subtype ? type + ':' + subtype : type || action || 'Network Traffic'" },
            { name: 'LogSeverity', value: "level == 'emergency' ? '10' : level == 'alert' || level == 'critical' ? '9' : level == 'error' ? '7' : level == 'warning' ? '6' : level == 'notice' ? '4' : severity || '5'" },
            { name: 'DeviceAction', value: "action || act || 'allow'" },
            { name: 'DeviceName', value: "devname || hostname || host || ''" },
            { name: 'DeviceExternalID', value: "devid || serial || ''" },
          ],
        },
      },
      {
        id: 'eval', description: 'Map to CommonSecurityLog — network fields',
        conf: {
          add: [
            { name: 'Protocol', value: "proto == '6' ? 'TCP' : proto == '17' ? 'UDP' : proto == '1' ? 'ICMP' : (protocol || proto || '').toUpperCase()" },
            { name: 'SourceIP', value: "src_ip || srcaddr || srcip || src || ''" },
            { name: 'SourcePort', value: 'Number(src_port || srcport || sport || 0)' },
            { name: 'DestinationIP', value: "dst_ip || dstaddr || dstip || dst || ''" },
            { name: 'DestinationPort', value: 'Number(dst_port || dstport || dport || 0)' },
            { name: 'SentBytes', value: 'Number(sentbyte || bytes_out || out_bytes || 0)' },
            { name: 'ReceivedBytes', value: 'Number(rcvdbyte || bytes_in || in_bytes || 0)' },
            { name: 'DeviceInboundInterface', value: "srcintf || inbound_if || in_interface || ''" },
            { name: 'DeviceOutboundInterface', value: "dstintf || outbound_if || out_interface || ''" },
            { name: 'ApplicationProtocol', value: "service || app || app_proto || ''" },
          ],
        },
      },
      {
        id: 'eval', description: 'Map to CommonSecurityLog — NAT + metadata',
        conf: {
          add: [
            { name: 'SourceTranslatedAddress', value: "transip || xlatesrc || nat_src_ip || ''" },
            { name: 'SourceTranslatedPort', value: 'Number(transport || xlatesport || nat_src_port || 0) || undefined' },
            { name: 'DestinationTranslatedAddress', value: "transdst || xlatedst || nat_dst_ip || ''" },
            { name: 'DestinationTranslatedPort', value: 'Number(transdport || xlatedport || nat_dst_port || 0) || undefined' },
            { name: 'DeviceCustomString1Label', value: "'Policy'" },
            { name: 'DeviceCustomString1', value: "policyname || rule || rule_name || ''" },
            { name: 'DeviceCustomNumber1Label', value: "'SessionID'" },
            { name: 'FieldDeviceCustomNumber1', value: 'Number(sessionid || session_id || 0) || undefined' },
            { name: 'DeviceCustomString2Label', value: "'SourceCountry'" },
            { name: 'DeviceCustomString2', value: "srccountry || src_country || ''" },
            { name: 'DeviceCustomString3Label', value: "'DestCountry'" },
            { name: 'DeviceCustomString3', value: "dstcountry || dst_country || ''" },
          ],
        },
      },
      collectUnmappedCode,
    ];
  } else if (isAuth) {
    return [
      {
        id: 'eval', description: 'Map to CommonSecurityLog — auth header + timing',
        conf: {
          add: [
            { name: 'TimeGenerated', value: "new Date((_time || Date.now()/1000) * 1000).toISOString()" },
            { name: 'DeviceVendor', value: `'${info.vendor}'` },
            { name: 'DeviceProduct', value: `'${info.product}'` },
            { name: 'DeviceVersion', value: `'${info.version}'` },
            { name: 'DeviceEventClassID', value: "String(EventID || eventType || debugContext && debugContext.debugData && debugContext.debugData.requestId || 'auth')" },
            { name: 'Activity', value: "EventID == '4624' ? 'Logon' : EventID == '4625' ? 'Logon Failed' : EventID == '4634' ? 'Logoff' : displayMessage || properties && properties.status && properties.status.additionalDetails || 'Authentication'" },
            { name: 'LogSeverity', value: "EventID == '4625' || (outcome && outcome.result == 'FAILURE') || (properties && properties.status && properties.status.errorCode != 0) ? '7' : '3'" },
          ],
        },
      },
      {
        id: 'eval', description: 'Map to CommonSecurityLog — auth fields',
        conf: {
          add: [
            { name: 'SourceUserName', value: "SubjectUserName || UserName || properties && properties.userDisplayName || actor && actor.displayName || ''" },
            { name: 'DestinationUserName', value: "TargetUserName || properties && properties.userPrincipalName || target && target[0] && target[0].displayName || ''" },
            { name: 'SourceIP', value: "IpAddress || ipAddress || client && client.ipAddress || properties && properties.ipAddress || ''" },
            { name: 'DeviceAction', value: "EventID == '4624' || (status && status.errorCode == 0) || (outcome && outcome.result == 'SUCCESS') || (properties && properties.status && properties.status.errorCode == 0) ? 'Success' : 'Failure'" },
            { name: 'DestinationHostName', value: "Computer || WorkstationName || properties && properties.resourceDisplayName || ''" },
            { name: 'DeviceCustomString1Label', value: "'Reason'" },
            { name: 'DeviceCustomString1', value: "FailureReason || outcome && outcome.reason || properties && properties.status && properties.status.failureReason || ''" },
            { name: 'DeviceCustomString2Label', value: "'TargetApp'" },
            { name: 'DeviceCustomString2', value: "appDisplayName || properties && properties.appDisplayName || target && target[0] && target[0].alternateId || 'Windows'" },
          ],
        },
      },
      collectUnmappedCode,
    ];
  } else if (isEndpoint) {
    return [
      {
        id: 'eval', description: 'Map to CommonSecurityLog — endpoint header + timing',
        conf: {
          add: [
            { name: 'TimeGenerated', value: "new Date((_time || Date.now()/1000) * 1000).toISOString()" },
            { name: 'DeviceVendor', value: `'${info.vendor}'` },
            { name: 'DeviceProduct', value: `'${info.product}'` },
            { name: 'DeviceVersion', value: `'${info.version}'` },
            { name: 'DeviceEventClassID', value: "String(EventID || '')" },
            { name: 'Activity', value: "message || Task || 'Process Activity'" },
            { name: 'LogSeverity', value: "Level == '1' || Level == 'Critical' ? '10' : Level == '2' || Level == 'Error' ? '8' : Level == '3' || Level == 'Warning' ? '6' : '3'" },
          ],
        },
      },
      {
        id: 'eval', description: 'Map to CommonSecurityLog — endpoint fields',
        conf: {
          add: [
            { name: 'SourceUserName', value: "UserID || SubjectUserName || User || ''" },
            { name: 'SourceHostName', value: "Computer || ''" },
            { name: 'SourceProcessName', value: "Image || ParentImage || ScriptName || Path || ''" },
            { name: 'DestinationProcessName', value: "Image || CommandLine || ScriptBlockText && ScriptBlockText.substring(0, 200) || ''" },
            { name: 'DeviceAction', value: "'Observed'" },
            { name: 'DeviceCustomString1Label', value: "'CommandLine'" },
            { name: 'DeviceCustomString1', value: "CommandLine || ScriptBlockText && ScriptBlockText.substring(0, 1024) || ''" },
            { name: 'DeviceCustomString2Label', value: "'ProcessId'" },
            { name: 'DeviceCustomString2', value: "String(ProcessId || ProcessID || '')" },
            { name: 'FileName', value: "Image || TargetFilename || Path || ''" },
            { name: 'SourceIP', value: "SourceIp || IpAddress || ''" },
            { name: 'DestinationIP', value: "DestinationIp || ''" },
            { name: 'DestinationPort', value: "Number(DestinationPort || 0) || undefined" },
          ],
        },
      },
      collectUnmappedCode,
    ];
  } else {
    return [
      {
        id: 'eval', description: 'Map to CommonSecurityLog — generic fields',
        conf: {
          add: [
            { name: 'TimeGenerated', value: "new Date((_time || Date.now()/1000) * 1000).toISOString()" },
            { name: 'DeviceVendor', value: `'${info.vendor}'` },
            { name: 'DeviceProduct', value: `'${info.product}'` },
            { name: 'DeviceVersion', value: `'${info.version}'` },
            { name: 'DeviceEventClassID', value: "eventType || EventID || category || 'event'" },
            { name: 'Activity', value: "message || displayMessage || msg || 'Event'" },
            { name: 'LogSeverity', value: "severity || level || '5'" },
            { name: 'SourceIP', value: "src_ip || srcaddr || IpAddress || ipAddress || ''" },
            { name: 'DestinationIP', value: "dst_ip || dstaddr || ''" },
            { name: 'SourceUserName', value: "user || UserName || SubjectUserName || ''" },
            { name: 'DeviceAction', value: "action || outcome || result || 'Observed'" },
            { name: 'SourceHostName', value: "host || Computer || hostname || ''" },
          ],
        },
      },
      collectUnmappedCode,
    ];
  }
}

function getCimMapping(sourcetype: string): PipelineFunction[] {
  const isNetwork = ['cisco_asa', 'cisco_firepower', 'palo_alto_traffic', 'fortinet_fortigate', 'checkpoint_firewall', 'aws_vpc_v5'].includes(sourcetype);
  const isAuth = ['windows_security', 'azure_signin', 'okta_system'].includes(sourcetype);
  const isMail = sourcetype === 'cisco_esa';

  if (isMail) {
    // Splunk CIM Email data model
    return [{
      id: 'eval', description: 'Map to CIM Email',
      conf: {
        add: [
          { name: 'src_user', value: "sender || ''" },
          { name: 'recipient', value: "recipient || undefined" },
          { name: 'src', value: "src_ip || reverse_dns || undefined" },
          { name: 'subject', value: "subject || undefined" },
          { name: 'action', value: "action == 'delivered' ? 'delivered' : action == 'dropped' ? 'blocked' : action == 'quarantined' ? 'quarantined' : action == 'bounced' ? 'bounced' : 'delivered'" },
          { name: 'internal_message_id', value: "mid || undefined" },
          { name: 'message_id', value: "mid || undefined" },
          { name: 'vendor_action', value: "action || undefined" },
          { name: 'signature', value: "av_verdict == 'positive' ? av_name : spam_verdict == 'positive' ? 'spam' : undefined" },
          { name: 'filter_action', value: "av_verdict == 'positive' ? 'blocked' : spam_verdict == 'positive' ? 'quarantined' : undefined" },
        ],
      },
    }];
  }
  if (isNetwork) {
    return [{
      id: 'eval', description: 'Map to CIM Network Traffic',
      conf: {
        add: [
          // Canonical + common vendor aliases + Cribl Copilot OCSF-style names
          // (source__ip / destination__ip) so schematizer extracts still map.
          { name: 'src', value: 'src_ip || src || srcaddr || srcip || source__ip || client__ip' },
          { name: 'src_port', value: 'Number(src_port || spt || srcport || sport || source__port || 0)' },
          { name: 'dest', value: 'dest_ip || dst_ip || dest || dst || dstaddr || dstip || destination__ip || server__ip' },
          { name: 'dest_port', value: 'Number(dest_port || dst_port || dpt || dstport || dport || destination__port || 0)' },
          { name: 'transport', value: "(protocol || proto || network__transport || '').toLowerCase()" },
          { name: 'action', value: "action == 'allow' || action == 'Built' || action == 'accept' || action == 'Accept' || event__outcome == 'allow' ? 'allowed' : (event__outcome == 'deny' || action == 'deny' || action == 'drop' ? 'blocked' : (action || event__outcome || 'unknown'))" },
          { name: 'vendor_action', value: 'action || act || event__outcome' },
          { name: 'app', value: "application || app || service || network__application || 'unknown'" },
          { name: 'bytes_in', value: "Number(rcvd_bytes || rcvdbyte || bytes_in || destination__bytes || __e['in'] || 0)" },
          { name: 'bytes_out', value: 'Number(sent_bytes || sentbyte || bytes_out || source__bytes || out || 0)' },
          { name: 'packets_in', value: 'Number(rcvd_pkts || rcvdpkt || packets_in || 0) || undefined' },
          { name: 'packets_out', value: 'Number(sent_pkts || sentpkt || packets_out || 0) || undefined' },
          { name: 'duration', value: 'Number(duration || event__duration || 0) || undefined' },
          { name: 'rule', value: 'policy_name || rule_name || policyname || rule__name || undefined' },
          { name: 'src_zone', value: 'src_zone || observer__ingress__zone || undefined' },
          { name: 'dest_zone', value: 'dst_zone || dest_zone || observer__egress_zone || observer__egress__zone || undefined' },
        ],
      },
    }];
  }
  if (isAuth) {
    return [{
      id: 'eval', description: 'Map to CIM Authentication',
      conf: {
        add: [
          { name: 'user', value: "SubjectUserName || UserName || properties && properties.userDisplayName || actor && actor.displayName" },
          { name: 'src', value: "IpAddress || ipAddress || client && client.ipAddress" },
          { name: 'dest', value: "Computer || WorkstationName || 'unknown'" },
          { name: 'action', value: "EventID == '4624' || (status && status.errorCode == 0) || (outcome && outcome.result == 'SUCCESS') ? 'success' : 'failure'" },
          { name: 'app', value: "appDisplayName || 'Windows'" },
        ],
      },
    }];
  }
  return [{
    id: 'eval', description: 'Map to CIM base fields',
    conf: {
      add: [
        { name: 'host', value: "host || Computer || hostname || 'unknown'" },
        { name: 'source', value: `'${sourcetype}'` },
      ],
    },
  }];
}

// Cribl drops a dotted add whose parent object is absent, so every ECS parent is
// created first. `'{}'` also replaces a source scalar of the same name — Cribl's
// `source`/`host` metadata, a `rule` string — which Elasticsearch rejects where
// ECS maps an object; the scalars a leaf still reads are snapshotted first.
function ecsStaticMapping(description: string, parents: string[], leaves: { name: string; value: string }[]): PipelineFunction[] {
  return [
    {
      id: 'eval', description: 'Snapshot source fields named like ECS objects',
      conf: { add: ['host', 'rule', 'user'].map(f => ({ name: `__ecs_${f}`, value: `typeof ${f} == 'string' ? ${f} : undefined` })) },
    },
    {
      id: 'eval', description,
      conf: {
        add: [
          ...['ecs', 'event', ...parents].map(p => ({ name: p, value: '{}' })),
          { name: 'ecs.version', value: `'${ECS_SCHEMA_VERSION}'` },
          ...leaves,
        ],
      },
    },
  ];
}

function getEcsMapping(sourcetype: string): PipelineFunction[] {
  const isNetwork = ['cisco_asa', 'cisco_firepower', 'palo_alto_traffic', 'fortinet_fortigate', 'checkpoint_firewall', 'aws_vpc_v5'].includes(sourcetype);
  const isAuth = ['windows_security', 'azure_signin', 'okta_system'].includes(sourcetype);

  // Absent values stay `undefined` (Cribl omits the field): an empty string in an
  // ECS `ip` field is malformed, and a placeholder port 0 reads as a real port.
  if (isNetwork) {
    return ecsStaticMapping('Map to ECS Network fields', ['source', 'destination', 'network', 'observer', 'rule'], [
      { name: 'event.kind', value: "'event'" },
      { name: 'event.category', value: "['network']" },
      { name: 'event.type', value: "action == 'allow' || action == 'Built' || action == 'accept' ? ['allowed','connection'] : ['denied','connection']" },
      { name: 'event.outcome', value: "action == 'allow' || action == 'Built' || action == 'accept' ? 'success' : 'failure'" },
      { name: 'source.ip', value: 'src_ip || srcaddr || srcip || undefined' },
      { name: 'source.port', value: '(src_port || srcport) ? Number(src_port || srcport) : undefined' },
      { name: 'destination.ip', value: 'dest_ip || dst_ip || dstaddr || dstip || undefined' },
      { name: 'destination.port', value: '(dest_port || dst_port || dstport) ? Number(dest_port || dst_port || dstport) : undefined' },
      { name: 'network.transport', value: '(transport || protocol || proto) ? String(transport || protocol || proto).toLowerCase() : undefined' },
      { name: 'network.bytes', value: '(bytes || sentbyte || rcvdbyte || bytes_in) ? Number(bytes || sentbyte || 0) + Number(rcvdbyte || bytes_in || 0) : undefined' },
      { name: 'event.action', value: 'action || act || undefined' },
      { name: 'observer.vendor', value: `'${sourcetype.split('_')[0]}'` },
      { name: 'rule.name', value: '__ecs_rule || rule_name || policy_name || undefined' },
    ]);
  }
  if (isAuth) {
    return ecsStaticMapping('Map to ECS Authentication fields', ['source', 'user', 'host'], [
      { name: 'event.kind', value: "'event'" },
      { name: 'event.category', value: "['authentication']" },
      { name: 'event.type', value: "['start']" },
      { name: 'event.outcome', value: "EventID == '4624' || (outcome && outcome.result == 'SUCCESS') || (status && status.errorCode == 0) ? 'success' : 'failure'" },
      { name: 'user.name', value: 'SubjectUserName || UserName || properties && properties.userDisplayName || actor && actor.displayName || __ecs_user || undefined' },
      { name: 'source.ip', value: 'IpAddress || ipAddress || client && client.ipAddress || undefined' },
      { name: 'host.name', value: 'Computer || WorkstationName || __ecs_host || undefined' },
      { name: 'event.action', value: "EventID == '4624' ? 'logon-success' : EventID == '4625' ? 'logon-failed' : displayMessage || 'authentication'" },
    ]);
  }
  return ecsStaticMapping('Map to ECS base fields', ['host', 'observer'], [
    { name: 'event.kind', value: "'event'" },
    { name: 'event.category', value: "['host']" },
    { name: 'host.name', value: '__ecs_host || Computer || hostname || undefined' },
    { name: 'event.action', value: 'action || message || undefined' },
    { name: 'observer.vendor', value: `'${sourcetype.split('_')[0]}'` },
  ]);
}

function getAsimMapping(sourcetype: string): PipelineFunction[] {
  const isNetwork = ['cisco_asa', 'cisco_firepower', 'palo_alto_traffic', 'fortinet_fortigate', 'checkpoint_firewall', 'aws_vpc_v5'].includes(sourcetype);
  const isAuth = ['windows_security', 'azure_signin', 'okta_system'].includes(sourcetype);

  if (isNetwork) {
    return [{
      id: 'eval', description: 'Map to ASIM NetworkSession schema',
      conf: {
        add: [
          { name: 'EventType', value: "'NetworkSession'" },
          { name: 'EventSchema', value: "'NetworkSession'" },
          { name: 'EventSchemaVersion', value: "'0.2.6'" },
          { name: 'EventResult', value: "action == 'allow' || action == 'Built' || action == 'accept' ? 'Success' : 'Failure'" },
          { name: 'EventSeverity', value: "'Informational'" },
          { name: 'DvcAction', value: "action == 'allow' || action == 'Built' || action == 'accept' ? 'Allow' : 'Deny'" },
          { name: 'SrcIpAddr', value: "src_ip || srcaddr || srcip || ''" },
          { name: 'SrcPortNumber', value: 'Number(src_port || srcport || 0)' },
          { name: 'DstIpAddr', value: "dst_ip || dstaddr || dstip || ''" },
          { name: 'DstPortNumber', value: 'Number(dst_port || dstport || 0)' },
          { name: 'NetworkProtocol', value: "(protocol || proto || '').toUpperCase()" },
          { name: 'SrcBytes', value: 'Number(sentbyte || bytes_out || 0)' },
          { name: 'DstBytes', value: 'Number(rcvdbyte || bytes_in || 0)' },
          { name: 'NetworkDirection', value: "inbound_if || in_interface ? 'Inbound' : 'Outbound'" },
          { name: 'EventProduct', value: `'${sourcetype}'` },
          { name: 'EventVendor', value: `'${sourcetype.split('_')[0]}'` },
        ],
      },
    }];
  }
  if (isAuth) {
    return [{
      id: 'eval', description: 'Map to ASIM Authentication schema',
      conf: {
        add: [
          { name: 'EventType', value: "'Logon'" },
          { name: 'EventSchema', value: "'Authentication'" },
          { name: 'EventSchemaVersion', value: "'0.1.3'" },
          { name: 'EventResult', value: "EventID == '4624' || (outcome && outcome.result == 'SUCCESS') || (status && status.errorCode == 0) ? 'Success' : 'Failure'" },
          { name: 'EventSeverity', value: "EventID == '4625' || (outcome && outcome.result == 'FAILURE') ? 'Low' : 'Informational'" },
          { name: 'TargetUsername', value: "TargetUserName || properties && properties.userPrincipalName || ''" },
          { name: 'SrcIpAddr', value: "IpAddress || ipAddress || client && client.ipAddress || ''" },
          { name: 'TargetHostname', value: "Computer || WorkstationName || ''" },
          { name: 'LogonMethod', value: "LogonType || authenticationMethod || ''" },
          { name: 'EventProduct', value: `'${sourcetype}'` },
          { name: 'EventVendor', value: `'${sourcetype.split('_')[0]}'` },
        ],
      },
    }];
  }
  return [{
    id: 'eval', description: 'Map to ASIM base fields',
    conf: {
      add: [
        { name: 'EventType', value: "'ActivityEvent'" },
        { name: 'EventResult', value: "'Success'" },
        { name: 'EventSeverity', value: "'Informational'" },
        { name: 'EventProduct', value: `'${sourcetype}'` },
        { name: 'EventVendor', value: `'${sourcetype.split('_')[0]}'` },
        { name: 'DvcHostname', value: "host || Computer || hostname || ''" },
      ],
    },
  }];
}

// Static UDM fallback (no golden spec matched). Same wire contract as the
// golden chronicle* specs: parent objects created before their dotted leaves
// (Cribl drops a dotted add whose parent is absent), strings for string
// fields, repeated fields as arrays, enum values only, and
// metadata.event_timestamp{seconds,nanos} (the destination drops events
// without it).
function getChronicleMapping(sourcetype: string): PipelineFunction[] {
  const isNetwork = ['cisco_asa', 'cisco_firepower', 'palo_alto_traffic', 'fortinet_fortigate', 'checkpoint_firewall', 'aws_vpc_v5'].includes(sourcetype);
  const isAuth = ['windows_security', 'azure_signin', 'okta_system'].includes(sourcetype);
  const V = getCefVendorInfo(sourcetype);
  const str = (expr: string) => `(${expr}) ? String(${expr}) : undefined`;
  const arr = (expr: string) => `(${expr}) ? [String(${expr})] : undefined`;
  const meta = (eventType: string) => [
    { name: 'metadata', value: '{}' },
    { name: 'metadata.event_type', value: `'${eventType}'` },
    { name: 'metadata.vendor_name', value: `'${V.vendor}'` },
    { name: 'metadata.product_name', value: `'${V.product}'` },
  ];
  const finish = (wrapSecurityResult: boolean): PipelineFunction[] => [
    ...udmEventTimestampFunctions(),
    ...(wrapSecurityResult ? [{ id: 'eval', description: 'Wrap repeated UDM messages as arrays', conf: { add: [{ name: 'security_result', value: 'security_result && !Array.isArray(security_result) ? [security_result] : undefined' }] } }] : []),
  ];

  if (isNetwork) {
    const action = "String(action || '')";
    const proto = "String(protocol || proto || '').toUpperCase()";
    return [{
      id: 'eval', description: 'Map to Chronicle UDM — NETWORK_CONNECTION',
      conf: {
        add: [
          ...meta('NETWORK_CONNECTION'),
          { name: 'principal', value: '{}' },
          { name: 'target', value: '{}' },
          { name: 'network', value: '{}' },
          { name: 'security_result', value: '{}' },
          { name: 'principal.ip', value: arr('src_ip || srcaddr || srcip') },
          { name: 'principal.port', value: 'Number(src_port || srcport) || undefined' },
          { name: 'target.ip', value: arr('dst_ip || dstaddr || dstip') },
          { name: 'target.port', value: 'Number(dst_port || dstport) || undefined' },
          { name: 'network.ip_protocol', value: `/^(TCP|UDP|ICMP|ICMP6|GRE|ESP|SCTP)$/.test(${proto}) ? ${proto} : ${proto} == '6' ? 'TCP' : ${proto} == '17' ? 'UDP' : ${proto} == '1' ? 'ICMP' : undefined` },
          { name: 'network.sent_bytes', value: 'Number(sentbyte || bytes_out) || undefined' },
          { name: 'network.received_bytes', value: 'Number(rcvdbyte || bytes_in) || undefined' },
          { name: 'security_result.action', value: `${action} == '' ? undefined : /deny|denied|drop|block|reject|refuse/i.test(${action}) ? ['BLOCK'] : /allow|accept|permit|built|teardown|pass|close|timeout|-rst/i.test(${action}) ? ['ALLOW'] : ['UNKNOWN_ACTION']` },
          { name: 'security_result.rule_name', value: str('rule || rule_name || policy_name') },
        ],
      },
    }, ...finish(true)];
  }
  if (isAuth) {
    const logon = "String(LogonType || '')";
    return [{
      id: 'eval', description: 'Map to Chronicle UDM — USER_LOGIN',
      conf: {
        add: [
          ...meta('USER_LOGIN'),
          { name: 'principal', value: '{}' },
          { name: 'target', value: '{}' },
          { name: 'target.user', value: '{}' },
          { name: 'security_result', value: '{}' },
          { name: 'extensions', value: '{}' },
          { name: 'extensions.auth', value: '{}' },
          { name: 'principal.ip', value: arr('IpAddress || ipAddress || client && client.ipAddress') },
          { name: 'target.user.userid', value: str('TargetUserName || SubjectUserName || UserName || properties && properties.userDisplayName || actor && actor.displayName') },
          { name: 'target.hostname', value: str('Computer || WorkstationName') },
          { name: 'security_result.action', value: "EventID == '4624' || (outcome && outcome.result == 'SUCCESS') || (status && status.errorCode == 0) ? ['ALLOW'] : EventID == '4625' || (outcome && outcome.result == 'FAILURE') || (status && status.errorCode) ? ['BLOCK'] : ['UNKNOWN_ACTION']" },
          { name: 'extensions.auth.type', value: `'${sourcetype === 'windows_security' ? 'MACHINE' : 'SSO'}'` },
          { name: 'extensions.auth.mechanism', value: `${logon} == '2' ? ['INTERACTIVE'] : ${logon} == '3' ? ['NETWORK'] : ${logon} == '4' ? ['BATCH'] : ${logon} == '5' ? ['SERVICE'] : ${logon} == '7' ? ['UNLOCK'] : ${logon} == '8' ? ['NETWORK_CLEAR_TEXT'] : ${logon} == '9' ? ['NEW_CREDENTIALS'] : ${logon} == '10' ? ['REMOTE_INTERACTIVE'] : ${logon} == '11' ? ['CACHED_INTERACTIVE'] : ['MECHANISM_OTHER']` },
        ],
      },
    }, ...finish(true)];
  }
  return [{
    id: 'eval', description: 'Map to Chronicle UDM — GENERIC_EVENT',
    conf: {
      add: [
        ...meta('GENERIC_EVENT'),
        { name: 'principal', value: '(host || Computer || hostname || user || UserName) ? {} : undefined' },
        { name: 'principal.hostname', value: str('host || Computer || hostname') },
        { name: 'principal.user', value: '(user || UserName) ? {} : undefined' },
        { name: 'principal.user.userid', value: str('user || UserName') },
      ],
    },
  }, ...finish(false)];
}

function getJsonMapping(sourcetype: string): PipelineFunction[] {
  const isNetwork = ['cisco_asa', 'cisco_firepower', 'palo_alto_traffic', 'fortinet_fortigate', 'checkpoint_firewall', 'aws_vpc_v5'].includes(sourcetype);
  const isAuth = ['windows_security', 'azure_signin', 'okta_system'].includes(sourcetype);

  if (isNetwork) {
    return [{
      id: 'eval', description: 'Normalize to clean JSON — network fields',
      conf: {
        add: [
          { name: 'event_type', value: "'network'" },
          { name: 'src_ip', value: "src_ip || srcaddr || srcip || ''" },
          { name: 'src_port', value: 'Number(src_port || srcport || 0)' },
          { name: 'dst_ip', value: "dst_ip || dstaddr || dstip || ''" },
          { name: 'dst_port', value: 'Number(dst_port || dstport || 0)' },
          { name: 'protocol', value: "(protocol || proto || '').toLowerCase()" },
          { name: 'action', value: "action == 'allow' || action == 'Built' || action == 'accept' ? 'allow' : 'deny'" },
          { name: 'bytes_in', value: 'Number(rcvdbyte || bytes_in || 0)' },
          { name: 'bytes_out', value: 'Number(sentbyte || bytes_out || 0)' },
          { name: 'rule', value: "rule || rule_name || policy_name || ''" },
          { name: 'sourcetype', value: `'${sourcetype}'` },
        ],
      },
    }];
  }
  if (isAuth) {
    return [{
      id: 'eval', description: 'Normalize to clean JSON — auth fields',
      conf: {
        add: [
          { name: 'event_type', value: "'authentication'" },
          { name: 'user', value: "SubjectUserName || UserName || properties && properties.userDisplayName || actor && actor.displayName || ''" },
          { name: 'src_ip', value: "IpAddress || ipAddress || client && client.ipAddress || ''" },
          { name: 'target_host', value: "Computer || WorkstationName || ''" },
          { name: 'outcome', value: "EventID == '4624' || (outcome && outcome.result == 'SUCCESS') || (status && status.errorCode == 0) ? 'success' : 'failure'" },
          { name: 'sourcetype', value: `'${sourcetype}'` },
        ],
      },
    }];
  }
  return [{
    id: 'eval', description: 'Normalize to clean JSON — base fields',
    conf: {
      add: [
        { name: 'event_type', value: "'event'" },
        { name: 'host', value: "host || Computer || hostname || ''" },
        { name: 'sourcetype', value: `'${sourcetype}'` },
      ],
    },
  }];
}

// --- Compact output ---
// Each destination format has different output expectations:
// - CEF: _raw = CEF string, strip all fields (handled in mapping step)
// - CIM: rebuild _raw as compact JSON of CIM fields, keep CIM fields as top-level (Splunk HEC indexes them)
// - OCSF/NextGen: DROP _raw, keep nested fields (destination serializes)
// - ECS: move original _raw → message, keep nested fields
// - ASIM: DROP _raw, keep flat ASIM fields (Sentinel Logs Ingestion API)
// - Chronicle UDM: DROP _raw, keep nested fields
// - CommonSecurityLog: keep PascalCase fields, serialize to JSON _raw (Sentinel API)
// - JSON: serialize to JSON _raw, strip parsed fields

// Internal parse artifacts safe to drop from any schema output (used by the
// AI-mapping protect-list path). We deliberately do NOT enumerate raw source
// field names (src/dst/proto/...) — they vary per source and leaving a few
// extra flat fields alongside the schema output is harmless for ingestion,
// whereas a whitelist risks stripping the (unknown) AI-mapped fields.
const SOURCE_PARSE_ARTIFACT_FIELDS = ['msg_body', 'msg_format', 'event_category', 'event_action', '__kvp_src'];

// `extraKeep` carries the destField names produced by AI mappings so the
// keep-list stages (nextgen/ocsf/CSL, which use remove:['*']) don't strip
// AI-mapped fields that aren't in the static schema keep-list. Dotted fields
// (e.g. src_endpoint.ip) are reduced to their top-level object with a glob
// (src_endpoint*) so Cribl's keep matches the nested structure.
// The canonical CIM top-level shape: only _raw + Splunk metadata survive; the
// CIM fields live INSIDE _raw as JSON (search-time extracted). Anything else at
// the top level duplicates every value (indexed field + _raw JSON).
const CIM_METADATA_KEEP = ['_raw', '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe'];

// The "keep unmapped source fields in _raw" passthrough (CIM only). `extracted`
// is the parser's produced field names; `consumed` is what the mapping already
// read or produced (its dest fields + the canonical inputs it referenced).
// Whatever the parser produced that ISN'T consumed — and isn't a Cribl internal
// or Splunk metadata field — is genuinely unmapped source data. Returning those
// names lets the caller add them to its pre-serialize keep-list so they survive
// into the rebuilt _raw JSON instead of being dropped by remove:['*'].
export function unmappedSourceFields(extracted: string[], consumed: Iterable<string>): string[] {
  const skip = new Set<string>(consumed);
  for (const m of CIM_METADATA_KEEP) skip.add(m);
  return [...new Set(extracted)].filter(f =>
    f && !skip.has(f) && !f.startsWith('__') && !f.startsWith('cribl') && !f.startsWith('gfsrc_tmp_'));
}

// Guarantee the correct CIM output shape on a set of mapping functions. If the
// functions serialize the mapped fields into `_raw` (json serialize → _raw) but
// DON'T then drop those fields from the top level, append the metadata-only
// cleanup. This self-heals stale golden mapping sub-parts captured before that
// cleanup step existed (build 294-era), which otherwise deploy with the CIM
// fields duplicated both in _raw and flat at the top level. No-op for non-CIM
// and for functions that already end in the correct keep-cleanup.
export function ensureCimRawShape(destFormat: string, fns: PipelineFunction[]): PipelineFunction[] {
  if (!isCimFormat(destFormat) || !Array.isArray(fns) || fns.length === 0) return fns;
  const serIdx = fns.findIndex(f => f.id === 'serialize' && (f.conf as any)?.type === 'json' && (f.conf as any)?.dstField === '_raw');
  if (serIdx === -1) return fns; // nothing serialized into _raw → not the CIM-raw pattern
  // Already cleaned? A later step that removes '*' and keeps _raw is the marker.
  const cleaned = fns.slice(serIdx + 1).some(f => {
    const c = f.conf as any;
    return Array.isArray(c?.remove) && c.remove.includes('*') && Array.isArray(c?.keep) && c.keep.includes('_raw');
  });
  if (cleaned) return fns;
  return [
    ...fns,
    {
      id: 'eval', filter: 'true',
      description: 'Keep only _raw + Splunk metadata (CIM fields live in _raw)',
      conf: { remove: ['*'], keep: [...CIM_METADATA_KEEP] },
    },
  ];
}

// --- Vendor-native values vs the canonical vocabulary -------------------------
// A parser normalizes vendor tokens into the canonical vocabulary IN PLACE —
// aws_vpc_v5 does `action = action === 'ACCEPT' ? 'allowed' : …` — so the source's
// own token is destroyed and only `_raw` still holds it. That is correct for CIM
// (whose vocabulary IS allowed/blocked) and wrong for a vendor-NATIVE destination:
// AWSVPCFlow's columns are AWS's own field names (SrcAddr/DstAddr/Action), so its
// Action column expects AWS's own ACCEPT/REJECT. Pack `aaaaa` lost exactly one
// sample value that way — the only value its mapping failed to carry (build 457).
//
// Splunk CIM already names the field for this: `vendor_action` is the documented
// home for the vendor's original action string (`vendor_severity` likewise), and
// two parsers here emit it by hand already — so preserving it is canonical rather
// than an invention, and it is worth having for every destination.
const VENDOR_NATIVE_VOCABULARY: Record<string, string> = {
  action: 'vendor_action',
  severity: 'vendor_severity',
};

const referencesOwnField = (expr: string, name: string) =>
  new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(expr);

// Keep the vendor's original token alongside the normalized one, for any parse
// stage — static, golden, Search-datatype or AI-generated. The alias is inserted
// as an earlier `add` entry of the SAME eval that overwrites the field: Cribl
// applies `add` entries in order (aws_vpc_v5 depends on it — `protocol` reads the
// `transport` set two entries above), so it captures the pre-normalization value.
// Appending it after the parse stage, the way the log_time alias is appended,
// would capture the already-normalized value and be worse than useless.
export function preserveNativeVocabularyValues(fns: PipelineFunction[]): PipelineFunction[] {
  if (!Array.isArray(fns) || fns.length === 0) return fns;
  // A parser that already emits vendor_action itself (cisco_asa, fortinet) must
  // not get a second, conflicting assignment.
  const produced = new Set<string>();
  for (const f of fns) for (const a of ((f.conf as Record<string, any>)?.add || [])) if (a?.name) produced.add(String(a.name));
  let anyChange = false;
  const out = fns.map(f => {
    const add = (f.conf as Record<string, any>)?.add;
    if (f.id !== 'eval' || !Array.isArray(add)) return f;
    let changed = false;
    const next: Record<string, any>[] = [];
    for (const entry of add) {
      const native = VENDOR_NATIVE_VOCABULARY[String(entry?.name || '')];
      // ONLY a self-overwrite destroys the source value (`action = f(action)`).
      // A first assignment from another field (`action = act`) leaves the
      // vendor's own value readable where it already is.
      if (native && !produced.has(native) && referencesOwnField(String(entry?.value ?? ''), String(entry.name))) {
        next.push({ name: native, value: `${entry.name} || undefined` });
        produced.add(native);
        changed = true;
      }
      next.push(entry);
    }
    if (!changed) return f;
    anyChange = true;
    return { ...f, conf: { ...(f.conf as Record<string, any>), add: next } };
  });
  return anyChange ? out : fns;
}

// A Sentinel table is either the VENDOR's own log shape or a NORMALIZED schema.
// ASim* tables carry Microsoft's own normalized vocabulary (EventResult
// Success/Failure, DvcAction Allow/Deny); CommonSecurityLog and Syslog are
// generic containers, and CSL additionally has a hand-verified golden mapping
// which reliabilityRules rank as the highest authority. Everything else is named
// after the vendor's own log (AWSVPCFlow, AWSCloudTrail, GCPAuditLogs,
// SecurityEvent…) and its columns are the vendor's own field names.
export function vendorNativeSentinelTable(destFormat: string): string | null {
  const resolved = resolveSentinelTable(destFormat);
  if (!resolved) return null;
  const name = resolved.name;
  if (/^asim/i.test(name) || ['commonsecuritylog', 'syslog'].includes(name.toLowerCase())) return null;
  return name;
}

// A pure field read: `action`, `action || act`, `action || ''`. Anything with an
// operator, call or member access is a transform the mapper built deliberately
// (`action === 'allowed' ? 'ACCEPT' : 'REJECT'` already lands on the native
// value) — prefixing `vendor_action ||` there would change the precedence and
// silently invert the result.
const PURE_FIELD_READ = /^[A-Za-z_$][\w$]*(?:\s*\|\|\s*(?:[A-Za-z_$][\w$]*|'[^']*'|"[^"]*"))*$/;

// For a vendor-native Sentinel table, read the preserved vendor token in
// preference to the normalized one. `availableFields` is the parse stage's real
// output: no rewrite unless the native field is genuinely there, so this can
// never point a column at a field that does not exist.
export function preferNativeVocabularyValues(destFormat: string, fns: PipelineFunction[], availableFields: string[]): PipelineFunction[] {
  if (!vendorNativeSentinelTable(destFormat) || !Array.isArray(fns) || fns.length === 0) return fns;
  const available = new Set(availableFields || []);
  let anyChange = false;
  const out = fns.map(f => {
    const add = (f.conf as Record<string, any>)?.add;
    if (f.id !== 'eval' || !Array.isArray(add)) return f;
    let changed = false;
    const next = add.map((entry: Record<string, any>) => {
      const expr = String(entry?.value ?? '').trim();
      if (!PURE_FIELD_READ.test(expr)) return entry;
      const lead = expr.match(/^[A-Za-z_$][\w$]*/)?.[0] || '';
      const native = VENDOR_NATIVE_VOCABULARY[lead];
      if (!native || !available.has(native) || referencesOwnField(expr, native)) return entry;
      changed = true;
      return { ...entry, value: `${native} || ${expr}` };
    });
    if (!changed) return f;
    anyChange = true;
    return { ...f, conf: { ...(f.conf as Record<string, any>), add: next } };
  });
  return anyChange ? out : fns;
}

export function getCompactOutputFunctions(sourcetypeRaw: string, destFormat: string, enabled: boolean, extraKeep: string[] = [], keepUnmapped = false, cimFlat = false): PipelineFunction[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  // Turn AI destField names into keep-list entries: top-level of dotted paths
  // gets a trailing glob so nested objects survive.
  const aiKeep = [...new Set(extraKeep.map(f => {
    const top = f.split('.')[0].split('[')[0];
    return f.includes('.') || f.includes('[') ? `${top}*` : top;
  }))];
  // CEF: _raw already built + fields stripped in the mapping step
  if (destFormat === 'cef') {
    return [];
  }

  // NextGen SIEM: raw-fidelity (plan Task 5) — there is no schema to strip to,
  // and stripping would destroy the untouched _raw/canonical fields the whole
  // point of raw fidelity is to preserve.
  if (isNextGenRawFidelityFormat(destFormat)) {
    return [];
  }

  // Splunk CIM. Two output shapes, chosen by the `cimFlat` toggle:
  //  • cimFlat OFF (default) → Splunk-HEC model: rebuild `_raw` as compact JSON of
  //    the CIM fields and keep ONLY the metadata top-level (_time/index/source/
  //    sourcetype/host). The CIM fields live in `_raw` and are search-time
  //    extracted for tstats / data-model acceleration / ES detections.
  //  • cimFlat ON → emit the mapped CIM fields as TOP-LEVEL (indexed) fields —
  //    the Splunk HEC "fields" object shape. The verbose original `_raw` is still
  //    dropped, but there is no `_raw` rebuild: what the mapping produced is what
  //    ships, visible as real fields rather than a serialized blob.
  if (isCimFormat(destFormat)) {
    // The pre-serialize step decides what survives into the rebuilt `_raw`. Two
    // shapes, chosen by the "keep unmapped source fields in _raw" toggle:
    //
    //  • keepUnmapped ON (default) → DENYLIST: strip `_raw` + Cribl internals and
    //    keep EVERYTHING else — the mapped CIM fields AND all extracted vendor
    //    fields. This is the only shape that can preserve fields produced by a
    //    DYNAMIC serde (kvp/json/csv with `fields:[]`) or a regex_extract, whose
    //    names are UNKNOWABLE at build time and therefore can never appear on an
    //    allowlist. An allowlist here silently dropped every vendor field for
    //    dynamically-parsed sources (zscaler_web/fortigate scored ~0 despite a
    //    clean extraction).
    //  • keepUnmapped OFF → ALLOWLIST (when the mapped CIM names are known):
    //    remove:['*'] keep:[CIM fields + routing], so `_raw` compacts to just the
    //    clean CIM model and the verbose vendor-raw is discarded (~20 keys, not
    //    60+). Falls back to the denylist when we don't know the mapped names.
    //
    // Either way the pre-serialize step must DROP the original `_raw` (serialize's
    // `fields:['*']` doesn't exclude it, so a kept `_raw` gets nested inside the
    // rebuilt `_raw`). `_raw` is restored only in the final metadata step.
    const preKeepMeta = CIM_METADATA_KEEP.filter(f => f !== '_raw');
    const denylist: PipelineFunction = {
      id: 'eval', filter: 'true', disabled: !enabled,
      description: keepUnmapped
        ? 'Keep mapped CIM fields + all extracted source fields before serialization'
        : 'Remove original _raw and internal fields before CIM serialization',
      conf: { remove: ['_raw', 'msg_body', 'msg_format', 'event_category', 'event_action', '__*'] },
    };
    const preSerialize: PipelineFunction = (!keepUnmapped && aiKeep.length > 0)
      ? {
          id: 'eval', filter: 'true', disabled: !enabled,
          description: 'Keep only mapped CIM fields before serialization (drop vendor-raw)',
          conf: { remove: ['*'], keep: [...new Set([...aiKeep, ...preKeepMeta])] },
        }
      : denylist;
    if (cimFlat) {
      // Flat CIM: same keep/remove decision as the pre-serialize step, but ship
      // the result as top-level fields — no `_raw` rebuild, no metadata-only strip.
      return [(!keepUnmapped && aiKeep.length > 0)
        ? {
            id: 'eval', filter: 'true', disabled: !enabled,
            description: 'Flat CIM: keep mapped CIM fields as top-level fields (drop vendor-raw)',
            conf: { remove: ['*'], keep: [...new Set([...aiKeep, ...preKeepMeta])] },
          }
        : {
            id: 'eval', filter: 'true', disabled: !enabled,
            description: 'Flat CIM: keep mapped CIM fields + extracted source fields as top-level fields',
            conf: { remove: ['_raw', 'msg_body', 'msg_format', 'event_category', 'event_action', '__*'] },
          }];
    }
    return [
      preSerialize,
      {
        id: 'serialize', filter: 'true', disabled: !enabled,
        description: 'Rebuild _raw as compact JSON of CIM fields',
        // Exclude routing fields + Cribl internals from _raw so metadata isn't
        // duplicated inside the JSON (they stay top-level for Splunk HEC).
        conf: {
          type: 'json', dstField: '_raw',
          // Exclude routing metadata AND any previous _raw — without !\_raw a
          // second serialize nests {"_raw":"{...}"} inside the new _raw.
          fields: ['!_raw', '!_time', '!index', '!source', '!sourcetype', '!host', '!cribl_breaker', '!cribl_pipe', '!__*', '!cribl*', '*'],
        },
      },
      {
        // Splunk keeps only _time/index/source/sourcetype/host as top-level
        // (indexed) fields; the CIM fields now live in _raw and are search-time
        // extracted. Drop them from the top level so values aren't duplicated
        // (indexed field + _raw) — the correct CIM shape.
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Keep only _raw + Splunk metadata (CIM fields live in _raw)',
        conf: { remove: ['*'], keep: ['_raw', '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe'] },
      },
    ];
  }

  // OCSF / NextGen SIEM: strip source fields, keep only schema fields + _raw dropped.
  // With AI mappings the produced field names are unknown ahead of time, so a
  // whitelist (remove:['*']+keep) would strip them — especially nested objects,
  // whose keys the keep-glob doesn't reliably match. Instead use a protect-list:
  // remove _raw + the known raw-source parse artifacts + internals, and keep
  // everything else (i.e. the mapped schema output). Static path keeps the
  // precise whitelist for clean, schema-only output.
  if (destFormat === 'ocsf' || destFormat === 'nextgen') {
    if (aiKeep.length > 0) {
      return [{
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Drop raw source fields — keep AI-mapped schema fields',
        conf: {
          remove: [...SOURCE_PARSE_ARTIFACT_FIELDS, '_raw', '__*'],
        },
      }];
    }
    return [{
      id: 'eval', filter: 'true', disabled: !enabled,
      description: 'Strip all source fields — keep only OCSF schema fields',
      conf: {
        remove: ['*'],
        keep: [
          'class_uid', 'class_name', 'category_uid', 'category_name',
          'activity_id', 'activity_name', 'type_uid', 'type_name',
          'action_id', 'action', 'disposition_id', 'disposition',
          'severity_id', 'severity', 'status_id', 'status', 'status_code',
          'time', 'time_dt', 'start_time', 'end_time', 'duration',
          'metadata*', 'device*', 'src_endpoint*', 'dst_endpoint*',
          'connection_info*', 'traffic*', 'firewall_rule*', 'policy*',
          'user*', 'actor*', 'auth_protocol_id', 'auth_protocol',
          'logon_type_id', 'logon_type', 'is_mfa', 'is_cleartext',
          'observables', 'unmapped', 'enrichments',
        ],
      },
    }];
  }

  // ECS: move original _raw to `message` (ECS base field), keep nested ECS fields
  // Elasticsearch indexes the JSON document fields, `message` preserves the original log
  if (destFormat === 'ecs') {
    return [
      {
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Preserve original log in message, remove _raw and internal fields',
        conf: {
          add: [
            { name: 'message', value: '_raw' },
          ],
          remove: ['_raw', 'msg_body', 'msg_format', 'event_category', 'event_action', '__*'],
        },
      },
      {
        // A `source` still holding Cribl's metadata string collides with the ECS
        // `source` object — Elasticsearch rejects the document.
        id: 'eval', filter: "typeof source == 'string'", disabled: !enabled,
        description: 'Drop the Cribl source string (conflicts with the ECS source object)',
        conf: { remove: ['source'] },
      },
    ];
  }

  // ASIM: keep only the target ASim table's DCR columns (like the Sentinel
  // native tables). Each `asim#<dataClass>` variant maps to one ASim*EventLogs /
  // ASim*ActivityLogs table; resolve it and allowlist its columns so the Logs
  // Ingestion API doesn't reject unknown fields. Bare `asim` = NetworkSession.
  if (isAsimFormat(destFormat)) {
    const asimTable = resolveSentinelTable(asimTableForFormat(destFormat));
    if (asimTable) {
      return [{
        id: 'eval', filter: 'true', disabled: !enabled,
        description: `Keep only ${asimTable.name} DCR columns (ASIM normalized fields)`,
        conf: {
          remove: ['*', '__*', '_*', 'cribl_*'],
          keep: [
            ...asimTable.table.columns.map((column) => column.name),
            '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe',
          ],
        },
      }, ...sentinelColumnCoercionFunctions(asimTable.table, extraKeep)];
    }
    return [{
      id: 'eval', filter: 'true', disabled: !enabled,
      description: 'Remove _raw and parsed fields — Sentinel ingests structured ASIM fields',
      conf: {
        remove: ['_raw', 'msg_body', 'msg_format', 'event_category', 'event_action', '__*'],
      },
    }];
  }

  // Chronicle UDM: drop _raw, keep nested UDM fields. The timestamp backstop
  // covers an AI/schematizer mapping that left event_timestamp out or wrote it
  // as a string — the destination drops such an event. Not gated on `enabled`:
  // it is a delivery requirement, not an output-size optimisation.
  if (destFormat === 'chronicle' || destFormat.startsWith('chronicle#')) {
    return [{
      id: 'eval', filter: 'true', disabled: !enabled,
      description: 'Remove _raw and parsed fields — Chronicle ingests structured UDM fields',
      conf: {
        remove: ['_raw', 'msg_body', 'msg_format', 'event_category', 'event_action', '__*'],
      },
    }, ...udmEventTimestampFunctions()];
  }

  // CommonSecurityLog: strip ALL source fields, keep ONLY valid CSL table columns
  // Logs Ingestion API rejects unknown fields — only send what the table schema accepts
  if (destFormat === 'commonsecuritylog') {
    const csl = resolveSentinelTable('CommonSecurityLog')?.table;
    const commonSecurityLogColumns = csl?.columns.map((column) => column.name) || [];
    return [{
      id: 'eval', filter: 'true', disabled: !enabled,
      description: 'Strip all source fields — keep only CommonSecurityLog table columns',
      conf: {
        remove: ['*', '__*', '_*', 'cribl_*'],
        keep: [
          ...commonSecurityLogColumns,
          '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe',
        ],
      },
    }, ...sentinelColumnCoercionFunctions(csl, extraKeep)];
  }

  // Any specific Sentinel native table selected through Custom / Other uses
  // the same flat DCR contract as CommonSecurityLog. The Sentinel destination
  // sends individual top-level fields; serializing them into _raw makes the
  // DCR see one unknown column and can drop the event.
  const sentinelTarget = resolveSentinelTable(destFormat);
  if (sentinelTarget) {
    return [{
      id: 'eval', filter: 'true', disabled: !enabled,
      description: `Keep only ${sentinelTarget.name} DCR columns (top-level Sentinel fields)`,
      conf: {
        remove: ['*', '__*', '_*', 'cribl_*'],
        // `_*` removes `_time` too, so it has to be kept back explicitly — without
        // it the event loses its Cribl event time (and the routing metadata the
        // destination and the preview scorer read). The CommonSecurityLog branch
        // above always did this; this one didn't.
        keep: [
          ...sentinelTarget.table.columns.map((column) => column.name),
          '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe',
        ],
      },
    }, ...sentinelColumnCoercionFunctions(sentinelTarget.table, extraKeep)];
  }

  // JSON ("Clean JSON") = EVERY extracted field rebuilt as one JSON object in
  // `_raw`, with NO fields left top-level except routing metadata. The event
  // body IS the JSON — a downstream reader parses `_raw` and finds every field,
  // and nothing is duplicated as both a top-level field and a _raw key.
  //
  //   1. drop the original text `_raw` + parse scratch (so the old raw log isn't
  //      nested inside the new JSON, and scratch keys don't leak into it),
  //   2. serialize the remaining fields into `_raw` as compact JSON (excluding
  //      routing metadata + Cribl internals, which stay top-level),
  //   3. keep ONLY `_raw` + metadata top-level — remove everything else so the
  //      event is a clean JSON payload, not a mix of flat fields and text _raw.
  if (destFormat === 'json') {
    return [
      {
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Drop original _raw + parse scratch before JSON serialization',
        conf: { remove: ['_raw', 'msg_body', 'msg_format', 'event_category', 'event_action', '__*'] },
      },
      {
        id: 'serialize', filter: 'true', disabled: !enabled,
        description: 'Rebuild _raw as compact JSON of all extracted fields',
        conf: {
          type: 'json', dstField: '_raw',
          fields: ['!_raw', '!_time', '!index', '!source', '!sourcetype', '!host', '!cribl_breaker', '!cribl_pipe', '!__*', '!cribl*', '*'],
        },
      },
      {
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Keep only _raw (JSON) + routing metadata',
        conf: { remove: ['*'], keep: ['_raw', '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe'] },
      },
    ];
  }

  // Raw + extracted fields (Build pack flow, Lake): the original `_raw` stays
  // exactly as received and every extracted field ships top-level next to it —
  // searchable as-is, and each field a Parquet column in the Lake. Nothing to
  // compact; only the parse scratch the Clean JSON branch also drops goes.
  if (destFormat === 'raw_fields') {
    return [{
      id: 'eval', filter: 'true', disabled: !enabled,
      description: 'Keep original _raw + extracted fields; drop parse scratch',
      conf: { remove: ['msg_body', 'msg_format', '__*'] },
    }];
  }

  // Fallback for manual/passthrough: sourcetype-specific compact
  switch (sourcetype) {
    case 'windows_powershell':
      return [{
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Build compact JSON _raw',
        conf: {
          add: [
            { name: '_raw', value: "JSON.stringify({event_id: Number(EventID), severity: Level === '1' ? 'Critical' : Level === '2' ? 'Error' : Level === '3' ? 'Warning' : Level === '4' ? 'Informational' : 'Verbose', computer: Computer, user_sid: UserID, channel: Channel, process_id: Number(ProcessID) || undefined, activity_id: ActivityID || undefined, script_block_id: ScriptBlockId || undefined, script_path: Path || undefined, script_text: ScriptBlockText || undefined, suspicious: suspicious || undefined})" },
          ],
        },
      }];

    case 'windows_security':
      return [{
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Build compact JSON _raw',
        conf: {
          add: [
            { name: '_raw', value: "JSON.stringify({event_id: Number(EventID), computer: Computer, user: SubjectUserName || TargetUserName || UserID, logon_type: LogonType || undefined, ip: IpAddress || undefined, process: ProcessName || NewProcessName || undefined, suspicious: suspicious || undefined})" },
          ],
        },
      }];

    case 'windows_sysmon':
      return [{
        id: 'eval', filter: 'true', disabled: !enabled,
        description: 'Build compact JSON _raw',
        conf: {
          add: [
            { name: '_raw', value: "JSON.stringify({event_id: Number(EventID), computer: Computer, user: User || undefined, action: action || undefined, process: Image || undefined, cmd: CommandLine || undefined, parent: ParentImage || undefined, src_ip: src_ip || undefined, dest_ip: dest_ip || undefined, dest_port: dest_port || undefined, file: TargetFilename || undefined, registry: TargetObject || undefined, suspicious: suspicious || undefined})" },
          ],
        },
      }];

    default:
      return [{
        id: 'serialize', filter: 'true', disabled: !enabled,
        description: 'Serialize to compact JSON',
        conf: { type: 'json', dstField: '_raw' },
      }];
  }
}

// --- Sample and README ---

function wrapSampleEvents(raw: string): object[] {
  const lines = raw.trim().split('\n').filter(Boolean);
  return lines.map((line) => {
    try {
      const parsed = JSON.parse(line);
      return { _raw: line, ...parsed, __criblEventType: 'event', __ctrlFields: [], __final: false, __cloneCount: 0 };
    } catch {
      return { _raw: line, __criblEventType: 'event', __ctrlFields: [], __final: false, __cloneCount: 0 };
    }
  });
}

function generateSampleId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function buildSamplesYml(sampleName: string, eventCount: number, dataSize: number, sampleId?: string): string {
  const id = sampleId || generateSampleId();
  const now = Date.now();
  return `${id}:
  sampleName: ${sampleName}
  isTemplate: true
  created: ${now}
  size: ${dataSize}
  numEvents: ${eventCount}
`;
}

// `BUILD_NUMBER` is a Vite build-time define, so a bare read is a ReferenceError
// anywhere Vite did not do the substituting — the Node test runner, and the
// esbuild-bundled Backend Function that Background Batch builds packs from. A
// crashed deploy is a far worse outcome than an unlabelled README footer. Same
// guard the other readers already use (scoring-doc.ts, sample-library-panel.tsx).
function buildLabel(): string {
  return typeof BUILD_NUMBER === 'number' ? String(BUILD_NUMBER) : 'unknown';
}

function buildReadme(state: WizardState, sourcetype: string, enabledOptions: string[], disabledOptions: string[], pipelineId: string, allowCodeFunctions: boolean): string {
  const formatLabel = getFormatLabel(state);
  const sourcetypeLabel = sourcetype.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const filter = state.routeFilter || `sourcetype=='${sourcetype}'`;
  const multiFormat = state.destFormats.length > 1;
  const parseDetail = ['windows_security', 'windows_sysmon'].includes(sourcetype)
    ? ' Uses `C.Text.parseWinEvent()`, Flatten, and Rename following Cribl\'s Windows XML reduction pattern.'
    : allowCodeFunctions
      ? ' Code functions are permitted when complex parsing requires them.'
      : ' Uses built-in parsing functions only (Code functions disabled).';

  let destSection: string;
  if (multiFormat) {
    const lines = state.destFormats.map(f => {
      const fState = { ...state, destFormat: f };
      const label = getFormatLabel(fState);
      const pid = getPipelineId(sourcetype, f);
      return `### ${label} — \`${pid}\`\n\n${getDestFormatExplanation(f)}`;
    });
    destSection = `## Destinations (${state.destFormats.length} pipelines)\n\nThis pack contains a separate pipeline for each destination format. All pipelines share the same source parsing and noise reduction stages, but apply format-specific schema mapping and output shaping.\n\n${lines.join('\n\n')}`;
  } else {
    destSection = `## Destination: ${formatLabel}\n\n${getDestFormatExplanation(state.destFormat)}`;
  }

  const pipelineHeader = multiFormat
    ? `## Pipelines\n\nEach pipeline (\`${state.destFormats.map(f => getPipelineId(sourcetype, f)).join('`, `')}\`) processes events through the following stages in order:`
    : `## Pipeline: \`${pipelineId}\`\n\nThe pipeline processes events through the following stages in order:`;

  return `# ${state.displayName || state.packName}

## Overview

This Cribl Stream pack ingests **${sourcetypeLabel}** events and transforms them into ${multiFormat ? `**${state.destFormats.length} destination formats**` : `**${formatLabel}** format`}. It handles the full pipeline from raw event parsing through field normalization, noise reduction, and schema mapping — producing clean, structured output ready for your downstream destination${multiFormat ? 's' : ''}.

## Source: ${sourcetypeLabel}

**What this source is:** ${getSourceExplanation(sourcetype)}

**Expected input format:** Events matching the filter \`${filter}\` will be routed through this pack's pipeline${multiFormat ? 's' : ''}.

${destSection}

${pipelineHeader}

### Stage 1 — Parse

Extracts structured fields from raw ${sourcetypeLabel} events.${parseDetail}

### Stage 2 — Noise Reduction

Drops known low-value events to reduce volume before mapping. Each drop rule can be individually enabled or disabled in the Cribl UI without editing the pipeline structure.

### Stage 3 — Suspicious Activity Flagging

Flags events that match known suspicious patterns (failed authentication, privilege escalation, known attack indicators). Adds a \`suspicious\` boolean field for downstream alerting or prioritization.

### Stage 4 — Schema Mapping

Maps extracted source fields to the **${formatLabel}** output schema. ${getSchemaDetail(state.destFormat)}

### Stage 5 — Compact Output

Rebuilds \`_raw\` as compact structured JSON, discarding the original verbose event format. This typically achieves 30-50% volume reduction.

### Stage 6 — Field Cleanup

Removes temporary extraction fields and internal pipeline variables, keeping only the final mapped output fields and Cribl routing metadata.

## Reduction Options

All reduction options are **included in the pipeline** as togglable functions. Enabled options process events immediately; disabled options are present but inactive (\`disabled: true\`) — you can toggle them on/off in the Cribl UI at any time without editing pipeline code.

### Currently Enabled

${enabledOptions.length > 0 ? enabledOptions.map(o => `- ${o}`).join('\n') : '_No reduction options enabled — all optional reductions are turned off._'}

### Available (currently disabled)

${disabledOptions.length > 0 ? disabledOptions.map(o => `- ${o}`).join('\n') : '_All available options are already enabled._'}

## Configuration

| Setting | Value |
|---------|-------|
| Pack ID | \`${toKebab(state.packName)}\` |
| Pipeline${multiFormat ? 's' : ''} | ${multiFormat ? state.destFormats.map(f => '`' + getPipelineId(sourcetype, f) + '`').join(', ') : '`' + pipelineId + '`'} |
| Worker Group | \`${state.workerGroup}\` |
| Route Filter | \`${filter}\` |
| Code Functions | ${allowCodeFunctions ? 'Allowed' : 'Disabled (regex/eval only)'} |

## Customization

After deployment, you can modify in the Cribl UI:

- **Enable/disable reduction steps** — click the toggle on any pipeline function to turn it on or off
- **Edit drop filters** — adjust the filter expression on any drop function to fine-tune which events are removed
- **Add enrichment** — insert eval, lookup, or code functions between existing steps for additional field enrichment
- **Modify schema mapping** — edit the mapping eval to add/remove/rename output fields
- **Replace sample data** — upload production events via the Samples tab for realistic testing
- **Adjust route filter** — change which events flow through this pack

**Cannot be changed without re-deploy:** Pack ID, pipeline directory structure.

## **Risks and Gotchas**

${getRisksAndGotchas(sourcetype, state.destFormat, allowCodeFunctions)}

## How Reduction Toggles Work

Each reduction option in the pipeline is a standard Cribl function with a \`disabled\` flag:

- \`disabled: false\` → function runs and processes events
- \`disabled: true\` → function is skipped (events pass through unchanged)

This means you can experiment with different combinations of noise reduction without risk — simply toggle functions on/off and observe the effect on event volume and content in the Preview pane.

---

_Auto-generated by Cribl Pack Generator — **build ${buildLabel()}** on ${new Date().toISOString().slice(0, 10)}_
`;
}

/**
 * Build the pack README from primitive inputs (no full WizardState needed).
 *
 * The interactive `buildPack()` calls `buildReadme()` directly, but the 3-stage
 * staged builder (`buildStagedPipeline` in App.tsx) — which now creates every
 * pack — assembles the deploy payload by hand and had no WizardState to pass,
 * so it silently shipped packs with NO README.md (regression). This wrapper
 * synthesizes the minimal state `buildReadme` reads (name/labels/formats/route)
 * so the staged path can regenerate the same README, including the build-number
 * footer. Pass ALL formats in `allFormats` so a multi-pipeline pack documents
 * every destination, not just the first.
 */
export function buildPackReadme(args: {
  sourcetype: string;
  destFormat: string;
  allFormats?: string[];
  packName: string;
  displayName?: string;
  routeFilter?: string;
  workerGroup: string;
  reductionToggles: Record<string, boolean>;
  allowCodeFunctions: boolean;
  pipelineId: string;
  sentinelTable?: string;
  manualFormat?: string;
  cimModel?: string;
}): string {
  const enabledOptions: string[] = [];
  const disabledOptions: string[] = [];
  const formats = (args.allFormats && args.allFormats.length) ? args.allFormats : [args.destFormat];
  // buildReadme reads only name/displayName/destFormat/destFormats/routeFilter/
  // workerGroup (+ sentinelTable/manualFormat/cimModel via getFormatLabel); a
  // partial cast is safe because no other field is touched.
  const state = {
    packName: args.packName,
    displayName: args.displayName,
    destFormat: args.destFormat,
    destFormats: formats,
    routeFilter: args.routeFilter,
    workerGroup: args.workerGroup,
    sentinelTable: args.sentinelTable,
    manualFormat: args.manualFormat,
    cimModel: args.cimModel,
  } as unknown as WizardState;
  return buildReadme(state, args.sourcetype, enabledOptions, disabledOptions, args.pipelineId, args.allowCodeFunctions);
}

function getSourceExplanation(sourcetypeRaw: string): string {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const explanations: Record<string, string> = {
    cisco_asa: 'Cisco ASA (Adaptive Security Appliance) generates syslog events for firewall connections, ACL matches, NAT translations, VPN sessions, and threat detection. Events use ASA message IDs (e.g., 302013 for TCP connection built, 106023 for deny).',
    cisco_firepower: 'Cisco Firepower Threat Defense produces intrusion detection, malware analysis, connection, and file events via the Firepower Management Center (FMC). Events include access control rule actions, IPS signatures, and application identification.',
    cisco_esa: 'Cisco Email Security Appliance (ESA/IronPort) AsyncOS mail_logs are plain-text, one physical line per event, with a single message spanning multiple lines correlated by MID (Message ID) and ICID (Injection Connection ID). Lines carry envelope sender/recipient, subject, sender IP + reverse DNS (on the New SMTP ICID line), anti-spam/anti-virus verdicts, and delivery/quarantine/bounce dispositions.',
    palo_alto_traffic: 'Palo Alto Networks PAN-OS traffic logs capture session start/end, allow/deny decisions, NAT, application identification, and byte counts in comma-separated format with 60+ fields per event.',
    palo_alto_threat: 'Palo Alto Networks threat logs record IPS/IDS detections, malware verdicts (WildFire), URL filtering blocks, and spyware/C2 detections with severity ratings and MITRE ATT&CK technique mappings.',
    fortinet_fortigate: 'Fortinet FortiGate generates key=value structured logs covering traffic sessions, UTM events (AV, IPS, web filter, app control), VPN, and system events with policy/rule references.',
    checkpoint_firewall: 'Check Point SmartDefense/VPN-1 & FireWall-1 produces syslog events with key="value" pairs covering accept/drop/reject decisions, blade detections, NAT translations, and VPN tunnel state.',
    windows_powershell: 'Windows PowerShell Operational log (EventIDs 4103-4106, 600, 800) captures module loading, script block execution, and pipeline activity in XML Event Log format. Critical for detecting malicious script execution.',
    windows_security: 'Windows Security Event Log captures authentication (4624/4625), privilege use (4672), process creation (4688), account management (4720/4726), and Windows Filtering Platform events in XML format.',
    windows_sysmon: 'Microsoft Sysmon (System Monitor) provides detailed process creation, network connections, file modifications, registry changes, and DLL loads with MITRE ATT&CK technique tagging in RuleName.',
    linux_syslog: 'Linux syslog (RFC 3164/5424) aggregates messages from sshd, sudo, cron, systemd, kernel, and application daemons. Covers authentication, service lifecycle, and system events.',
    linux_audit: 'Linux Audit Framework (auditd) records system calls, file access, authentication, and security-relevant operations as type=VALUE key=value pairs with audit trail correlation IDs.',
    crowdstrike_falcon: 'CrowdStrike Falcon EDR produces JSON detection events including process trees, file hashes, network connections, MITRE technique mappings, and severity classifications.',
    aws_cloudtrail: 'AWS CloudTrail records API calls across all AWS services as JSON events including caller identity (IAM user/role/service), source IP, request parameters, and response elements.',
    alibaba_action_trail: 'Alibaba Cloud ActionTrail records API, console, service, password-reset, and sign-in activity. For XSIAM, preserve the source-native Simple Log Service JSON record so the Alibaba content pack can create event_* fields and map them into XDM.',
    aws_vpc_v5: 'AWS VPC Flow Logs capture accepted/rejected network flows as space-separated records with source/dest IPs, ports, protocol, packet count, byte count, and action.',
    azure_signin: 'Azure AD (Entra ID) sign-in logs capture authentication attempts as JSON including user principal, application, conditional access evaluation, MFA status, risk level, and device compliance.',
    gcp_audit: 'Google Cloud Audit Logs record administrative actions across GCP services as JSON with method name, caller identity, resource, and authorization details.',
    okta_system: 'Okta System Log captures identity events as JSON including authentication, MFA, session management, application access, and administrative changes with actor/target/outcome structure.',
    zscaler_web: 'Zscaler Internet Access web transaction logs capture URL requests as JSON with action (allow/block/isolate), category, risk score, DLP policy triggers, and user/department context.',
    apache_access: 'Apache HTTPD access log in Combined Log Format records HTTP requests with client IP, timestamp, method, URI, status code, bytes, referrer, and user agent.',
    nginx_access: 'Nginx access log captures HTTP/2 requests with response timing, upstream backend performance metrics (connect/header/response times), and load balancer routing information.',
  };
  return explanations[sourcetype] || `${sourcetype.replace(/_/g, ' ')} events in their standard log format.`;
}

function getDestFormatExplanation(destFormat: string): string {
  switch (destFormat) {
    case 'ocsf': return `**OCSF (Open Cybersecurity Schema Framework) v1.4** is a vendor-neutral schema for security telemetry. Events are mapped to OCSF classes (e.g., Network Activity 4001, Authentication 3002) with standardized fields like \`src_endpoint\`, \`dst_endpoint\`, \`activity_id\`, and \`severity_id\`. This enables cross-vendor correlation in security data lakes (AWS Security Lake, Cribl Lake, etc.).`;
    case 'cef': return `**CEF (Common Event Format)** outputs events as a single \`_raw\` string in standard CEF format: \`CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extensions\`. Extension keys use the CEF standard (\`src\`, \`dst\`, \`spt\`, \`dpt\`, \`proto\`, \`act\`, \`in\`, \`out\`, \`suser\`, \`cs1Label\`, \`cs1\`, etc.). This is the transport format accepted by CEF-compatible SIEMs and collectors.`;
    case 'commonsecuritylog': return `**Sentinel CommonSecurityLog** maps events to Microsoft Sentinel's CommonSecurityLog table columns. Output uses PascalCase field names: \`DeviceVendor\`, \`DeviceProduct\`, \`SourceIP\`, \`DestinationIP\`, \`SourcePort\`, \`DestinationPort\`, \`Protocol\`, \`DeviceAction\`, \`LogSeverity\`, \`SentBytes\`, \`ReceivedBytes\`, etc. This is for direct ingestion into Sentinel via DCR (Data Collection Rules) where the table schema is flat.`;
    case 'cim': return `**Splunk Common Information Model (CIM)** normalizes events into data model fields for Splunk Enterprise Security. Depending on the source type, events are mapped to CIM data models like Network Traffic (\`src\`, \`dest\`, \`src_port\`, \`dest_port\`, \`transport\`, \`action\`, \`bytes_in\`, \`bytes_out\`) or Authentication (\`user\`, \`src\`, \`dest\`, \`action\`, \`app\`).`;
    default: return `Events are mapped to a custom output format as specified.`;
  }
}

function getSchemaDetail(destFormat: string): string {
  switch (destFormat) {
    case 'ocsf': return 'Each event receives OCSF class/category UIDs, severity mappings, and endpoint objects with IP/port/hostname fields.';
    case 'cef': return 'Fields are mapped to CEF extension keys (src, dst, spt, dpt, act, suser, in, out) and assembled into a CEF:0 header string in _raw.';
    case 'commonsecuritylog': return 'Fields are mapped to Sentinel CommonSecurityLog PascalCase columns (DeviceVendor, SourceIP, DestinationIP, DeviceAction, LogSeverity) for direct table ingestion.';
    case 'cim': return 'Fields are normalized to the appropriate CIM data model (Network Traffic, Authentication, Endpoint, or Change) depending on the source event type.';
    default: return 'Fields are mapped to the specified output schema.';
  }
}

function getRisksAndGotchas(sourcetypeRaw: string, destFormatRaw: string, _allowCodeFunctions: boolean): string {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  // Collapse asim#<dataClass> to 'asim' for the schema-risk switch below.
  const destFormat = isAsimFormat(destFormatRaw) ? 'asim' : destFormatRaw;
  const risks: string[] = [];

  // Parsing risks per sourcetype
  switch (sourcetype) {
    case 'cisco_asa':
      risks.push('**Lookup-driven parsing covers all documented codes** — The pipeline extracts the ASA/FTD message code and applies its specific regex from the bundled `cisco_asa_parsing.csv` (184 codes) / `cisco_ftd_parsing.csv` (168 codes), auto-uploaded to the pack\'s `data/lookups/` at deploy. Codes NOT in the lookup pass through with just severity + code extracted — review output for events missing body fields.');
      risks.push('**FTD reuses the ASA mappings** — Cisco FTD syslog shares the ASA `%XXX-sev-id:` structure, so `cisco_ftd` reuses ASA field mappings but keys its own `cisco_ftd_parsing.csv` lookup. Both %ASA- and %FTD- header prefixes are matched.');
      break;
    case 'cisco_esa':
      risks.push('**ESA logs are multi-line and stateful** — A single message spans many physical lines correlated by MID/ICID. This flat pipeline extracts fields PER LINE only; sender IP (on the `New SMTP ICID` line) is NOT joined to the envelope/verdict lines of the same MID. Full correlation needs a stateful aggregation step keyed on MID/ICID.');
      risks.push('**Many events have empty fields by design** — Because each line carries only some identifiers, most events will have blank sender/recipient/subject unless that line type carried them. Enable "Remove null fields" to keep output clean.');
      risks.push('**DLP verdict tokens are not parsed** — The AsyncOS mail_logs chapter does not document a stable DLP verdict line format, so no DLP fields are extracted. Add a regex_extract against a real DLP sample if you need them.');
      break;
    case 'palo_alto_traffic':
    case 'palo_alto_threat':
      risks.push('**CSV column count varies by PAN-OS version** — PAN-OS 10.x added columns that 9.x doesn\'t have. If field count doesn\'t match, trailing fields shift. Test with real samples from your firewall version.');
      break;
    case 'cisco_firepower':
      risks.push('**FTD syslog format** — Firepower/FTD uses the same %ASA-style syslog format as ASA. The lookup-driven parser covers documented message codes; events with codes not in the lookup pass through with only severity + code extracted.');
      break;
    case 'fortinet_fortigate':
    case 'checkpoint_firewall':
      risks.push('**Embedded quotes in KVP values** — Fields containing `"` inside values (e.g., URL paths) can break KVP parsing. Cribl handles escaped quotes (`\\"`) but not unescaped ones.');
      break;
    case 'windows_security':
    case 'windows_sysmon':
      risks.push('**Windows XML uses `C.Text.parseWinEvent()`** — The parser follows Cribl\'s Windows XML reduction pattern, removes null-like `0`, `0x0`, and `-` values, then flattens and renames the parsed fields before mapping.');
      break;
    case 'windows_powershell':
      risks.push('**PowerShell arrives as classic text or Windows Event XML** — The built-in parser reads both: each event is marked by its form and runs only that branch (the classic regexes, or the shared `C.Text.parseWinEvent` front-end). The XML front-end strips braces and folds line breaks to commas, so multi-line ScriptBlockText reads as one comma-joined line.');
      break;
  }

  // Schema mapping risks
  switch (destFormat) {
    case 'cim':
      risks.push('**CIM field mappings use heuristic `||` chains** — Expressions like `src_ip || srcaddr || srcip` pick from common field names. If your data uses non-standard names, mapping produces empty values. Always review output in Live Capture.');
      risks.push('**Network vs. Auth detection is sourcetype-based** — A `cisco_asa` VPN authentication event gets network mappings, not auth. For mixed-type sources, consider splitting into two pipelines.');
      break;
    case 'ecs':
      risks.push('**ECS nested field names** — ECS uses dot-notation (`source.ip`, `event.category`). Cribl eval creates nested objects. If your downstream expects flat JSON keys, add a `flatten` function after mapping.');
      break;
    case 'asim':
      risks.push('**ASIM schema versions may lag** — Hardcoded versions (NetworkSession 0.2.6, Authentication 0.1.3) may be behind Microsoft\'s latest. Check the [ASIM schema reference](https://learn.microsoft.com/en-us/azure/sentinel/normalization) after generation.');
      break;
    case 'chronicle':
      risks.push('**Chronicle UDM enum values** — UDM expects specific enum strings (NETWORK_CONNECTION, USER_LOGIN, ALLOW, BLOCK, UNKNOWN_ACTION). The golden mapping gates protocol, action and auth values to the enum and emits UNKNOWN_ACTION when the vendor action is unrecognized, so check how many events land there. The destination silently DROPS events with an invalid event_type or no numeric event_timestamp — watch its Status tab Dropped counter, not the Test tab. Validate against [UDM field list](https://cloud.google.com/chronicle/docs/reference/udm-field-list).');
      break;
    case 'ocsf':
      risks.push('**OCSF class_uid assignment** — The pipeline assigns a single class UID based on sourcetype. Mixed event types (e.g., ASA VPN + firewall) all get the same class. Split into separate pipelines if you need distinct OCSF classes.');
      break;
    case 'cef':
      risks.push('**CEF header fields are static** — Vendor, Product, and Version in the CEF:0 header are set from the sourcetype, not extracted per-event. If your source mixes vendors, the header will be incorrect for some events.');
      break;
    case 'commonsecuritylog':
      risks.push('**CommonSecurityLog column names are fixed** — DeviceVendor, DeviceProduct, and DeviceVersion are set from the sourcetype. If your source mixes vendors, split into separate pipelines.');
      break;
  }

  // General risks
  risks.push('**No arrow functions in Cribl eval** — The expression engine does not support `=>`. The generated pipeline uses only simple expressions, but manual edits with arrow functions will fail silently at runtime.');
  risks.push('**Route filter defaults to `true`** — If you need this pack to only process specific events, edit the route filter (e.g., `sourcetype==\'${sourcetype}\'` or `__inputId==\'your_input:id\'`).');
  risks.push('**Commit + Deploy is immediate** — The deploy step commits AND deploys in one action. There is no staging/approval step. Always test against a lab/dev worker group first.');

  return risks.map(r => `- ${r}`).join('\n');
}

function destFormatDescription(format: string): string {
  if (isAsimFormat(format)) return asimSchemaLabel(format);
  switch (format) {
    case 'nextgen': return 'CrowdStrike NG SIEM (original _raw for the vendor parser)';
    case 'ocsf': return 'OCSF 1.9';
    case 'cef': return 'CEF (Common Event Format)';
    case 'commonsecuritylog': return 'Sentinel CommonSecurityLog';
    case 'cim': return 'Splunk CIM';
    case 'ecs': return 'Elastic Common Schema';
    case 'asim': return 'Microsoft Sentinel ASIM';
    case 'chronicle': return 'Chronicle UDM';
    case 'json': return 'Clean JSON';
    case 'xsiam': return 'Cortex XSIAM';
    case 'passthrough': return 'Passthrough (raw copy)';
    case 'raw_fields': return 'Raw + extracted fields';
    case 'splunk_raw': return 'Splunk raw (passthrough)';
    case 'splunk_json': return 'Splunk JSON (clean JSON)';
    case 'elastic_raw': return 'Elastic integration (original line)';
    case 'elastic_json': return 'Elastic JSON (clean JSON)';
    case 'chronicle_raw': return 'Google SecOps raw (original line + log type)';
    default: return 'Custom';
  }
}

export interface AiFieldMapping {
  sourceField: string;
  destField: string;
  expression: string;
}

export interface AiMappingInput {
  mappings: AiFieldMapping[];
  classInfo?: Record<string, string>;
}

// Shared vendor/product/version by canonical sourcetype (used by golden format
// assembly and CEF mapping). Falls back to a humanized sourcetype name.
// Exported for scripts/mine-ocsf-optimization-rules.mjs: an optimization rule's
// vendor guard tests `metadata.product.vendor_name`, which is exactly what this
// table feeds, so the miner must derive its vendor slug from here rather than
// re-deriving one from the sourcetype name and silently never matching.
export function getCefVendorInfo(sourcetype: string): { vendor: string; product: string; version: string } {
  const MAP = CEF_VENDOR_INFO;
  return MAP[sourcetype] || guessVendorInfo(sourcetype);
}

// Uncurated sources (packtester audit 2026-10-02: every base-class pack and
// infoblox_dhcp reported vendor "infoblox dhcp", product "Security"). The first
// sourcetype token is the vendor in nearly every catalog name, the rest the
// product; acronyms stay upper-case.
const VENDOR_ACRONYMS = new Set(['aws', 'gcp', 'sap', 'ibm', 'f5', 'hp', 'dhcp', 'dns', 'waf', 'vpn', 'ids', 'ips', 'api', 'cdn',
  'sso', 'iam', 'ad', 'ztna', 'siem', 'edr', 'xdr', 'ndr', 'nac', 'ntp', 'smtp', 'http', 'ldap', 'esx', 'ise', 'asa', 'ftd',
  'utm', 'ssl', 'tls', 'db', 'os', 'vm', 'iis', 'cef', 'leef']);
export function guessVendorInfo(sourcetype: string): { vendor: string; product: string; version: string } {
  const words = String(sourcetype || '').split(/[_:\-\s]+/).filter(Boolean)
    .map(w => (VENDOR_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
  if (!words.length) return { vendor: 'Unknown', product: 'Unknown', version: '1.0' };
  return { vendor: words[0], product: words.length > 1 ? words.slice(1).join(' ') : words[0], version: '1.0' };
}

const CEF_VENDOR_INFO: Record<string, { vendor: string; product: string; version: string }> = {
  cisco_asa: { vendor: 'Cisco', product: 'ASA', version: '9.x' },
  cisco_ftd: { vendor: 'Cisco', product: 'Firepower Threat Defense', version: '7.x' },
  cisco_firepower: { vendor: 'Cisco', product: 'Firepower', version: '7.x' },
  cisco_esa: { vendor: 'Cisco', product: 'Email Security Appliance', version: '15.0' },
  palo_alto_traffic: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x' },
  palo_alto_threat: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x' },
  fortinet_fortigate: { vendor: 'Fortinet', product: 'FortiGate', version: '7.x' },
  checkpoint_firewall: { vendor: 'Check Point', product: 'SmartDefense', version: 'R81' },
  aws_vpc_v5: { vendor: 'AWS', product: 'VPC Flow Logs', version: '5' },
  windows_security: { vendor: 'Microsoft', product: 'Windows', version: '10' },
  windows_powershell: { vendor: 'Microsoft', product: 'PowerShell', version: '5.1' },
  windows_sysmon: { vendor: 'Microsoft', product: 'Sysmon', version: '15.x' },
  windows_system: { vendor: 'Microsoft', product: 'Windows', version: '10' },
  windows_application: { vendor: 'Microsoft', product: 'Windows', version: '10' },
  windows_defender: { vendor: 'Microsoft', product: 'Defender Antivirus', version: '4.18' },
  windows_dns_client: { vendor: 'Microsoft', product: 'DNS Client', version: '10' },
  azure_signin: { vendor: 'Microsoft', product: 'Azure AD', version: '1.0' },
  okta_system: { vendor: 'Okta', product: 'Identity Cloud', version: '2023.x' },
  linux_syslog: { vendor: 'Linux', product: 'Syslog', version: '1.0' },
  linux_audit: { vendor: 'Linux', product: 'Auditd', version: '1.0' },
  linux_secure: { vendor: 'Linux', product: 'Secure Log', version: '1.0' },
  juniper_srx: { vendor: 'Juniper', product: 'SRX', version: '1.0' },
  sophos_xg: { vendor: 'Sophos', product: 'XG Firewall', version: '1.0' },
  sonicwall_firewall: { vendor: 'SonicWall', product: 'Firewall', version: '1.0' },
  pfsense: { vendor: 'Netgate', product: 'pfSense', version: '1.0' },
  barracuda_cloudgen_firewall: { vendor: 'Barracuda', product: 'CloudGen Firewall', version: '1.0' },
  cisco_umbrella: { vendor: 'Cisco', product: 'Umbrella', version: '1.0' },
  cisco_sfw_estreamer: { vendor: 'Cisco', product: 'Secure Firewall', version: '1.0' },
  crowdstrike_falcon: { vendor: 'CrowdStrike', product: 'Falcon', version: '6.x' },
  zscaler_web: { vendor: 'Zscaler', product: 'Internet Access', version: '1.0' },
  sap_audit: { vendor: 'SAP', product: 'Security Audit Log', version: '1.0' },
  salesforce_setupaudittrail: { vendor: 'Salesforce', product: 'Setup Audit Trail', version: '1.0' },
  // --- every source that reaches ocsf#endpoint or ocsf#cloud_audit ------------
  // Those two specs used to inline their vendor ('Microsoft'/'Sysmon' and
  // 'AWS'/'CloudTrail'), so a CrowdStrike or auditd event claimed to be Microsoft
  // and every cloud audit claimed to be AWS. They now read the injected
  // `vendor`/`product` like the other five OCSF classes do — which is only an
  // improvement if the table actually answers for these sources. Uncurated, the
  // fallback humanizes the sourcetype and calls the product 'Security', so
  // `ocsf#cloud_audit` would have reported vendor "aws cloudtrail".
  // None of these parsers emit `device_vendor`, so adding them here cannot flip
  // `cefHeaderCarriesVendor` and steal a CEF header's own identity.
  aws_cloudtrail: { vendor: 'AWS', product: 'CloudTrail', version: '1.08' },
  aws_securityhub_finding: { vendor: 'AWS', product: 'Security Hub', version: '2018-10-08' },
  azure_monitor_activity: { vendor: 'Microsoft', product: 'Azure Monitor Activity Log', version: '1.0' },
  mscs_azure_audit: { vendor: 'Microsoft', product: 'Azure Activity Log', version: '1.0' },
  o365_management_activity: { vendor: 'Microsoft', product: 'Office 365 Management Activity', version: '1.0' },
  o365_graph_api: { vendor: 'Microsoft', product: 'Microsoft Graph API', version: '1.0' },
  github_cloud_audit: { vendor: 'GitHub', product: 'Audit Log', version: '1.0' },
  circleci: { vendor: 'CircleCI', product: 'Audit Log', version: '1.0' },
  gsuite_drive_json: { vendor: 'Google', product: 'Workspace Drive Audit', version: '1.0' },
  gws_reports_admin: { vendor: 'Google', product: 'Workspace Admin Reports', version: '1.0' },
  auditd: { vendor: 'Linux', product: 'Auditd', version: '1.0' },
  linux_messages_syslog: { vendor: 'Linux', product: 'Syslog', version: '1.0' },
  sysmon_linux: { vendor: 'Microsoft', product: 'Sysmon for Linux', version: '1.x' },
  ms_defender_atp_alerts: { vendor: 'Microsoft', product: 'Defender for Endpoint', version: '1.0' },
  ms365_defender_incident_alerts: { vendor: 'Microsoft', product: 'Defender XDR', version: '1.0' },
  mscs_azure_eventhub_defender_advancedhunting: { vendor: 'Microsoft', product: 'Defender Advanced Hunting', version: '1.0' },
  crowdstrike_events_sensor: { vendor: 'CrowdStrike', product: 'Falcon Sensor', version: '6.x' },
  crowdstrike_event_streams_json: { vendor: 'CrowdStrike', product: 'Falcon Event Streams', version: '2.0' },
  cisco_isovalent_processexec: { vendor: 'Cisco', product: 'Isovalent Tetragon', version: '1.0' },
  cisco_isovalent_processconnect: { vendor: 'Cisco', product: 'Isovalent Tetragon', version: '1.0' },
  cisco_nvm_osquery_v2: { vendor: 'Cisco', product: 'Network Visibility Module', version: '2' },
  osquery_results: { vendor: 'osquery', product: 'osquery', version: '5.x' },
  kube_container_falco: { vendor: 'Falco', product: 'Falco Runtime Security', version: '0.x' },
  pwsh_installediismodules: { vendor: 'Microsoft', product: 'PowerShell', version: '7.x' },
  pwsh_subjectinterfacepackage: { vendor: 'Microsoft', product: 'PowerShell', version: '7.x' },
};

// Sentinel CommonSecurityLog identity. Solution analytics rules, workbooks and
// parsers filter CSL on DeviceVendor/DeviceProduct with the value the vendor's
// own CEF feed writes, which is not always the marketing name CEF_VENDOR_INFO
// carries (OCSF metadata.product and the optimization miner read that table, so
// it stays as is). Values from the vendors' CEF headers and the Sentinel
// connector queries, as curated in the SOC Optimization Toolkit
// (criblio/Cribl-Microsoft vendor-identity.ts). Only sources whose content
// filter differs are listed; everything else keeps getCefVendorInfo.
const SENTINEL_CSL_IDENTITY: Record<string, { vendor: string; product: string }> = {
  zscaler_web: { vendor: 'Zscaler', product: 'NSSWeblog' },
  crowdstrike_falcon: { vendor: 'CrowdStrike', product: 'FalconHost' },
  crowdstrike_event_streams_json: { vendor: 'CrowdStrike', product: 'FalconHost' },
  checkpoint_firewall: { vendor: 'Check Point', product: 'VPN-1 & FireWall-1' },
  fortinet_fortigate: { vendor: 'Fortinet', product: 'Fortigate' },
};

/** DeviceVendor/DeviceProduct/DeviceVersion for a CommonSecurityLog row. */
export function sentinelCslIdentity(sourcetypeRaw: string): { vendor: string; product: string; version: string } {
  const st = canonicalizeSourcetype(sourcetypeRaw);
  const V = getCefVendorInfo(st);
  return { ...V, ...SENTINEL_CSL_IDENTITY[st] };
}

/**
 * True when the source's own parser lifts the device identity out of the CEF
 * header — `CEF:Version|Device Vendor|Device Product|Device Version|Event Class ID|…`
 * — and the table above has no curated entry for it.
 *
 * Without a curated entry `getCefVendorInfo` GUESSES vendor/product from the
 * sourcetype name, which for the generic `cef` source produced `vendor: "cef"`
 * and a header of `CEF:0|cef|Security|1.0|`: a wire format written where the
 * device vendor belongs. The header is the authority whenever the data carries
 * it, so the guess may only serve as the fallback for a line that had no header.
 */
export function cefHeaderCarriesVendor(sourcetypeRaw: string): boolean {
  const st = canonicalizeSourcetype(sourcetypeRaw);
  if (CEF_VENDOR_INFO[st]) return false;
  return getParserFieldNames(st).includes('device_vendor');
}

/**
 * Vendor/product/version as Cribl eval EXPRESSIONS rather than fixed strings.
 * A curated source yields the same quoted literal it always did (byte-identical
 * output); a header-derived source reads the parsed header first.
 */
export function cefVendorExpressions(sourcetypeRaw: string): { vendor: string; product: string; version: string } {
  const st = canonicalizeSourcetype(sourcetypeRaw);
  const V = getCefVendorInfo(st);
  const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (!cefHeaderCarriesVendor(st)) {
    return { vendor: lit(V.vendor), product: lit(V.product), version: lit(V.version) };
  }
  // A line with no CEF header extracts no device_vendor; "Unknown" is the CEF
  // convention and is honest, where the sourcetype name would not be.
  return {
    vendor: "device_vendor || 'Unknown'",
    product: "device_product || 'Unknown'",
    version: `device_version || ${lit(V.version)}`,
  };
}

// --- Cortex XSIAM passthrough destination ------------------------------------
// Routing tags from resolveXsiamDestination(); payload-shape hints still live
// in the legacy catalog for Alibaba-style JSON contracts.

const XSIAM_SOURCE_MAP: Record<string, XsiamSourceSpec> = (xsiamSourcesData as { sources: Record<string, XsiamSourceSpec> }).sources;

export interface XsiamSourceSpec {
  pattern: 'tag_only' | 'tag_vendor_product' | 'cef_extract' | 'zscaler_wrap';
  pipeline?: string;
  sourceIdField?: string;
  sourceIdentifier?: string;
  vendor?: string;
  product?: string;
  cefRegex?: string;
  eventExpr?: string;
  serialize?: Record<string, unknown>;
  dataset?: string;
  payloadFormat?: 'json' | 'raw';
  payloadRoot?: string;
  timestampField?: string;
  expectedJsonPaths?: string[];
  modelInputPaths?: string[];
  aliases?: string[];
  contentPack?: string;
  parsingRule?: string;
  modelingRules?: string[];
  modelFields?: string[];
  contentSource?: string;
  guessed?: boolean;
  guessReason?: string;
  unresolved?: boolean;
  tier?: string;
}

function legacyXsiamExtras(sourcetype: string): XsiamSourceSpec | undefined {
  if (XSIAM_SOURCE_MAP[sourcetype]) return XSIAM_SOURCE_MAP[sourcetype];
  return Object.values(XSIAM_SOURCE_MAP).find(spec =>
    (spec.aliases || []).some(alias => canonicalizeSourcetype(alias) === sourcetype),
  );
}

export function resolveXsiamSource(sourcetypeRaw: string): XsiamSourceSpec {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const resolution = resolveXsiamDestination(sourcetype);
  const extras = legacyXsiamExtras(sourcetype);
  if (!resolution.resolved) {
    return {
      pattern: 'tag_vendor_product',
      sourceIdField: '__sourceIdentifier',
      guessed: false,
      unresolved: true,
      tier: 'T4',
      guessReason: resolution.failure?.reason,
      contentPack: extras?.contentPack,
      payloadFormat: extras?.payloadFormat,
      expectedJsonPaths: extras?.expectedJsonPaths,
      dataset: extras?.dataset,
    };
  }
  const needsVendor = Boolean(resolution.vendor || resolution.product);
  return {
    pattern: extras?.pattern
      || (resolution.packPipeline && extras?.pattern)
      || (needsVendor ? 'tag_vendor_product' : 'tag_only'),
    pipeline: resolution.packPipeline || extras?.pipeline,
    sourceIdField: resolution.sourceIdField || '__sourceIdentifier',
    sourceIdentifier: resolution.sourceIdentifier || undefined,
    vendor: resolution.vendor || extras?.vendor,
    product: resolution.product || extras?.product,
    dataset: resolution.dataset || extras?.dataset,
    payloadFormat: extras?.payloadFormat,
    payloadRoot: extras?.payloadRoot,
    timestampField: extras?.timestampField,
    expectedJsonPaths: extras?.expectedJsonPaths,
    modelInputPaths: extras?.modelInputPaths,
    contentPack: extras?.contentPack,
    parsingRule: extras?.parsingRule,
    modelingRules: extras?.modelingRules,
    modelFields: extras?.modelFields,
    contentSource: extras?.contentSource,
    cefRegex: extras?.cefRegex,
    guessed: false,
    unresolved: false,
    tier: resolution.tier,
  };
}

export interface XsiamStageScore {
  score: number;
  band: 'good' | 'warn' | 'fail';
  reasons: string[];
}

function xsiamPathValue(value: any, path: string): any {
  return path.split('.').reduce((current, part) => {
    if (typeof current === 'string') {
      try { current = JSON.parse(current); } catch { return undefined; }
    }
    return current && typeof current === 'object' ? current[part] : undefined;
  }, value);
}

// XSIAM stage 1 validates the native payload; it must not reward parsing the
// event into a second schema. Demisto XIF payload hints are authoritative when
// available, while raw integrations only require a non-empty native payload.
export function scoreXsiamPayloadStage(rawEvents: string[], sourcetype: string): XsiamStageScore {
  const contract = resolveXsiamSource(sourcetype);
  if (contract.unresolved) {
    return { score: 0, band: 'fail', reasons: [contract.guessReason || `No XSIAM knowledge source covers "${sourcetype}".`] };
  }
  const nonEmpty = rawEvents.filter(raw => typeof raw === 'string' && raw.length > 0);
  if (nonEmpty.length === 0) return { score: 0, band: 'fail', reasons: ['No native _raw payload was available for XSIAM passthrough.'] };
  if (contract.payloadFormat !== 'json') {
    return { score: 100, band: 'good', reasons: [`${nonEmpty.length}/${rawEvents.length} native payloads are non-empty and will pass through unchanged.`] };
  }
  const payloads = nonEmpty.map(raw => { try { return JSON.parse(raw); } catch { return null; } });
  if (payloads.some(payload => payload == null)) {
    return { score: 0, band: 'fail', reasons: [`The ${contract.contentPack || 'XSIAM'} contract expects source-native JSON, but at least one sample is invalid JSON.`] };
  }
  const paths = contract.expectedJsonPaths || [];
  const missing = paths.filter(path => payloads.some(payload => xsiamPathValue(payload, path) == null));
  if (missing.length > 0) {
    return { score: 0, band: 'fail', reasons: [`Native JSON does not match the ${contract.contentPack || 'XSIAM'} parser contract; missing paths: ${missing.join(', ')}.`] };
  }
  return { score: 100, band: 'good', reasons: [`Native JSON matches the ${contract.contentPack || 'XSIAM'} payload contract and requires no extraction transform.`] };
}

// XSIAM stage 3 may remove whole events when the user enables reduction, but
// every surviving event must retain a byte-identical _raw payload and the exact
// routing contract. A guessed contract remains score 0 by design.
export function scoreXsiamOptimizationStage(beforeEvents: any[], afterEvents: any[], sourcetype: string): XsiamStageScore {
  if (afterEvents.length === 0) return { score: 0, band: 'fail', reasons: ['Optimization removed every sample event; XSIAM passthrough cannot be verified.'] };
  const resolution = resolveXsiamDestination(canonicalizeSourcetype(sourcetype));
  if (!resolution.resolved) {
    return { score: 0, band: 'fail', reasons: [resolution.failure?.reason || `No XSIAM knowledge source covers "${sourcetype}".`] };
  }
  const counts = new Map<string, number>();
  for (const event of beforeEvents) {
    if (typeof event?._raw === 'string') counts.set(event._raw, (counts.get(event._raw) || 0) + 1);
  }
  let rawPreserved = true;
  if (!resolution.reshapesRaw) {
    for (const event of afterEvents) {
      const raw = event?._raw;
      const remaining = typeof raw === 'string' ? (counts.get(raw) || 0) : 0;
      if (remaining <= 0) { rawPreserved = false; break; }
      counts.set(raw, remaining - 1);
    }
  }
  const contract = validateOutputAgainstSpec('xsiam', afterEvents, [], sourcetype);
  const removed = Math.max(0, beforeEvents.length - afterEvents.length);
  const reasons = [
    resolution.reshapesRaw
      ? 'This pipeline rewrites _raw by design, so byte-identity is not required.'
      : rawPreserved
        ? `All ${afterEvents.length} surviving event payloads remain byte-identical${removed ? `; ${removed} event(s) were removed by enabled reduction` : ''}.`
        : 'Optimization changed or replaced at least one surviving _raw payload.',
    ...(contract.findings || []).map(finding => finding.issue),
  ];
  const score = (resolution.reshapesRaw || rawPreserved) && contract.outputFormatOk ? contract.score : 0;
  return { score, band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail', reasons };
}

export function buildXsiamTagging(sourcetype: string, sampleEvents?: string): PipelineFunction[] {
  return buildXsiamRoutingFunctions(canonicalizeSourcetype(sourcetype), sampleEvents) as PipelineFunction[];
}

// --- Golden format specs (deterministic destination assembly) ---

interface GoldenFormatSpec {
  label?: string;
  outputShape?: 'raw' | 'flat' | 'nested' | 'passthrough';
  aliasOf?: string;
  /** On a `<family>@<st>` override: it computes the class per event, so it also
   *  serves every concretized `<family>#<class>` key for that source. */
  servesFamily?: boolean;
  header?: Record<string, string>;
  extension?: { key: string; expr: string; labelKey?: string; label?: string; transform?: string; maxLen?: number; guard?: string }[];
  timeField?: string;
  canonicalMap?: { dest: string; expr: string; number?: boolean; literalNumber?: boolean }[];
  valueRules?: Record<string, string>;
  // clearObjectCollisions (ECS): clear source fields named like an output object
  // before mapping, as UDM does — INCLUDING Cribl's `source` metadata, which ECS
  // defines as the network source object (a string there rejects the document).
  cleanup?: { keepRaw?: boolean; dropRaw?: boolean; rawToMessage?: boolean; serializeRaw?: boolean; clearObjectCollisions?: boolean };
  // Google SecOps UDM wire contract (the chronicle* specs). Present → every
  // non-number leaf is String()-cast (UDM types them string or enum-string),
  // `repeated` leaves and `repeatedMessages` objects are emitted as arrays,
  // source fields named like a UDM noun are cleared before mapping, and
  // metadata.event_timestamp{seconds,nanos} is set from _time — the Cribl
  // destination DROPS an event without it (see udmEventTimestampFunctions).
  udm?: { repeated?: string[]; repeatedMessages?: string[] };
}

const GOLDEN_FORMAT_FILE: Record<string, GoldenFormatSpec> = (goldenFormatsData as { formats: Record<string, GoldenFormatSpec> }).formats;

/**
 * Minimal spec for a vendored OCSF class with no hand-written golden (a class
 * the user picked by name or class_uid). It is ocsf#base with the class's own
 * constants: class_uid/category_uid, activity_id 99 (Other) or 0 when the class
 * has no 99, type_uid = class_uid*100 + activity_id, severity, time, message,
 * device, metadata. The base status rules stay only for classes whose status_id
 * enum is the base 0/1/2/99. Class-specific objects (user, session, …) are left
 * to the AI mapper, which gets this class's schema hint (ocsfMappingHintForKey).
 */
function synthesizeOcsfClassSpec(name: string): GoldenFormatSpec | null {
  const cls = ocsfClassDef(name);
  const base = GOLDEN_FORMAT_FILE['ocsf#base'];
  if (!cls || !base || name === 'base_event') return null;
  const acts = cls.enums.activity_id || [];
  const activity = acts.includes('99') ? 99 : 0;
  const baseStatus = (cls.enums.status_id || []).join(',') === '0,1,2,99';
  const consts: Record<string, number> = {
    class_uid: cls.uid,
    category_uid: cls.category_uid ?? Math.floor(cls.uid / 1000),
    activity_id: activity,
    type_uid: cls.uid * 100 + activity,
  };
  const canonicalMap = (base.canonicalMap || [])
    .filter(m => baseStatus || !/^status(_id)?$/.test(m.dest))
    .map(m => (m.dest in consts ? { dest: m.dest, expr: String(consts[m.dest]), literalNumber: true }
      : m.dest === 'time' ? { ...m, expr: 'synthTime' } : m));
  const ocsfTime = base.valueRules?.ocsfTime || 'undefined';
  // Drop the base spec's prose description: it describes Base Event, not this class.
  const { description: _baseDescription, ...baseSpec } = base as GoldenFormatSpec & { description?: string };
  return {
    ...baseSpec,
    // No parser feeds log_time for an arbitrary class's source: fall back to _time.
    valueRules: { ...(base.valueRules || {}), synthTime: `(${ocsfTime}) || (_time != null ? Math.round(Number(_time) * 1000) : undefined)` },
    label: `OCSF 1.9 ${cls.caption}`,
    canonicalMap,
  };
}

// Any `ocsf#<vendored class name>` resolves: the hand-written golden when there
// is one, else a spec generated on first use (synthesizeOcsfClassSpec).
const GOLDEN_FORMATS: Record<string, GoldenFormatSpec> = new Proxy(GOLDEN_FORMAT_FILE, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && prop.startsWith('ocsf#') && !Object.prototype.hasOwnProperty.call(target, prop)) {
      const spec = synthesizeOcsfClassSpec(prop.slice('ocsf#'.length));
      if (spec) target[prop] = spec;
    }
    return Reflect.get(target, prop, receiver);
  },
});

// ASIM build formats are `asim` (bare = NetworkSession) or `asim#<dataClass>`
// (e.g. asim#authentication, asim#dns, asim#endpoint). Every asim* format is a
// first-class golden path; a single family check keeps the ~6 asim branches
// (labels, cleanup, mapping) working for the variants.
export function isAsimFormat(destFormat: string): boolean {
  return destFormat === 'asim' || destFormat.startsWith('asim#');
}

// CIM build formats are `cim` (bare = Network Traffic) or `cim#<dataClass|model>`
// (cim#authentication, cim#Network_Traffic, …). Family check so cleanup /
// serialize-raw / labels work for every variant.
export function isCimFormat(destFormat: string): boolean {
  return destFormat === 'cim' || destFormat.startsWith('cim#');
}

// CEF-family destinations emit a CEF wire-format `_raw` string. `arcsight` is CEF
// plus ArcSight categorization (see postprocess-builder) — same wire format, so
// the CEF checker grades both.
export function isCefFormat(destFormat: string): boolean {
  return destFormat === 'cef' || destFormat === 'arcsight';
}

// Sentinel-family destinations all land in a Log Analytics table (Sentinel
// native, CommonSecurityLog, or any ASim* table) where `TimeGenerated` is the
// REQUIRED ingest-time column. Users reported it missing from many AI-path
// Sentinel packs (the golden path already forces it via the spec rule).
//
// A native table picked by name (`SecurityEvent`, `Syslog`, `WindowsEvent`…) is
// the same Log Analytics contract. Exact name only: a loose resolve would also
// claim unrelated lowercase format ids (`syslog`, `event` alias Syslog / Event).
export function isSentinelFamilyFormat(destFormat: string): boolean {
  return destFormat === 'sentinel' || destFormat === 'commonsecuritylog' || isAsimFormat(destFormat)
    || resolveSentinelTable(destFormat)?.name === destFormat;
}

// The Sentinel table a build format lands in: an ASIM variant's ASim* table, else
// the table named by the format (CommonSecurityLog, SecurityEvent…), else none.
export function sentinelTableForFormat(destFormat: string): SentinelTableKnowledge | null {
  if (isAsimFormat(destFormat)) return resolveSentinelTable(asimTableForFormat(destFormat))?.table || null;
  return resolveSentinelTable(destFormat)?.table || null;
}

// The DCR stream contract is column names AND types. Azure stores a value whose
// JSON type does not match the declared column type as an empty column, with no
// error: a FortiGate "31964" into the int SourcePort, a number into the string
// LogSeverity. Mappings carry source-typed values (every kvp/csv value is a
// string), so cast each written column to its declared stream type at the
// keep-list cleanup (after it in getCompactOutputFunctions, so that stage's first
// function stays the keep-list; before it on the golden path, same effect). Only
// columns the pipeline writes are cast (a table
// declares hundreds; casting all would cost every event). TimeGenerated is owned
// by its own forced step. `dynamic` is left alone: JSON.parse of a non-JSON
// string throws. An unparseable value becomes null, never a fabricated 0
// (the toolkit's `Number(x)||0` invents zeros; `Boolean('false')` is true).
const SENTINEL_COERCE_CHUNK = 8;
export function sentinelColumnCoercionFunctions(table: SentinelTableKnowledge | null | undefined, writtenFields: Iterable<string>): PipelineFunction[] {
  if (!table) return [];
  const written = new Set(writtenFields);
  const adds: { name: string; value: string }[] = [];
  for (const { name, type } of table.columns) {
    if (!written.has(name) || name === 'TimeGenerated' || !isSafeFieldName(name)) continue;
    const value = sentinelCoercionExpr(name, type);
    if (value) adds.push({ name, value });
  }
  const out: PipelineFunction[] = [];
  for (let i = 0; i < adds.length; i += SENTINEL_COERCE_CHUNK) {
    out.push({
      id: 'eval', filter: 'true',
      description: i === 0 ? 'Cast Sentinel columns to their DCR stream types' : `Cast Sentinel columns (cont. ${i + 1})`,
      conf: { add: adds.slice(i, i + SENTINEL_COERCE_CHUNK) },
    });
  }
  return out;
}

// `X == null ? X` first: an absent column stays absent (an eval add of undefined
// creates nothing).
export function sentinelCoercionExpr(field: string, type: string): string | null {
  const X = field;
  const blank = `String(${X}).trim() === ''`;
  switch (type) {
    case 'int':
    case 'long':
      return `${X} == null ? ${X} : (${blank} || !Number.isFinite(Number(${X}))) ? null : Math.trunc(Number(${X}))`;
    case 'real':
      return `${X} == null ? ${X} : (${blank} || !Number.isFinite(Number(${X}))) ? null : Number(${X})`;
    case 'boolean':
      return `${X} == null ? ${X} : typeof ${X} == 'boolean' ? ${X} : /^(true|1|yes)$/i.test(String(${X})) ? true : /^(false|0|no)$/i.test(String(${X})) ? false : null`;
    case 'string':
      return `${X} == null || typeof ${X} == 'string' ? ${X} : typeof ${X} == 'object' ? JSON.stringify(${X}) : String(${X})`;
    case 'datetime': {
      const ms = epochMsExpr(X);
      return `${X} == null ? ${X} : ${blank} || !Number.isFinite(${ms}) ? null : new Date(${ms}).toISOString()`;
    }
    default:
      return null;
  }
}

// The SAME robust expression golden-formats.json uses for `sentinelTimeGenerated`,
// kept in sync here so the AI mapping path can force a deterministic
// TimeGenerated. Handles ms-epoch (13-digit), s-epoch (10-digit), and ISO/date
// strings in `log_time`; falls back to `_time` (or now) when no timestamp parsed.
export const SENTINEL_TIME_GENERATED_EXPR = `(typeof log_time != 'undefined' && log_time) ? (/^\\d{13}(\\.\\d+)?$/.test(String(log_time)) ? new Date(Number(log_time)).toISOString() : /^\\d{10}(\\.\\d+)?$/.test(String(log_time)) ? new Date(Number(log_time)*1000).toISOString() : new Date(log_time).toISOString()) : new Date(_time ? _time*1000 : Date.now()).toISOString()`;

// Human CIM schema label from a build format: 'cim#authentication' →
// 'Splunk CIM — Authentication'. Reads the golden spec's label.
export function cimSchemaLabel(destFormat: string): string {
  const spec = GOLDEN_FORMATS[destFormat] || (destFormat.includes('#') ? GOLDEN_FORMATS[destFormat] : null);
  const resolved = spec?.aliasOf ? GOLDEN_FORMATS[spec.aliasOf] : spec;
  if (resolved?.label) return resolved.label;
  if (spec?.label) return spec.label;
  return 'Splunk CIM';
}

// Map an ASIM build format to its concrete Microsoft Sentinel ASim* table name
// (the DCR contract in config/sentinel-destinations.json), so cleanup can prune
// output to that table's columns. Bare asim / asim#network = NetworkSession.
const ASIM_DATACLASS_TABLE: Record<string, string> = {
  network: 'ASimNetworkSessionLogs',
  authentication: 'ASimAuthenticationEventLogs',
  web_proxy: 'ASimWebSessionLogs',
  endpoint: 'ASimProcessEventLogs',
  file: 'ASimFileEventLogs',
  registry: 'ASimRegistryEventLogs',
  audit: 'ASimAuditEventLogs',
  dhcp: 'ASimDhcpEventLogs',
  usermgmt: 'ASimUserManagementActivityLogs',
  dns: 'ASimDnsActivityLogs',
};
export function asimTableForFormat(destFormat: string): string {
  const cls = destFormat.includes('#') ? destFormat.split('#')[1] : 'network';
  return ASIM_DATACLASS_TABLE[cls] || 'ASimNetworkSessionLogs';
}

// Data class → the ASIM golden-format key for that class. Classes without a
// dedicated ASIM schema (email/generic) fall back to NetworkSession (bare asim).
const ASIM_DATACLASS_KEY: Record<string, string> = {
  network: 'asim#network', authentication: 'asim#authentication',
  endpoint: 'asim#endpoint', web_proxy: 'asim#web_proxy', dns: 'asim#dns',
  audit: 'asim#audit', cloud_audit: 'asim#audit',
};

// Data class → Splunk CIM golden-format key (fields from Splunk CIM 5.3 models).
const CIM_DATACLASS_KEY: Record<string, string> = {
  network: 'cim#network',
  authentication: 'cim#authentication',
  email: 'cim#email',
  web_proxy: 'cim#web_proxy',
  dns: 'cim#dns',
  endpoint: 'cim#endpoint',
  cloud_audit: 'cim#change',
  audit: 'cim#change',
};

// Selected WizardState.cimModel (Network_Traffic, Authentication, …) → golden key.
const CIM_MODEL_FORMAT: Record<string, string> = {
  Network_Traffic: 'cim#network',
  Authentication: 'cim#authentication',
  Email: 'cim#email',
  Web: 'cim#web_proxy',
  Network_Resolution: 'cim#dns',
  Endpoint: 'cim#endpoint',
  Change: 'cim#change',
  Intrusion_Detection: 'cim#intrusion_detection',
  Malware: 'cim#malware',
  Network_Sessions: 'cim#network_sessions',
  Data_Access: 'cim#data_access',
  DLP: 'cim#dlp',
  Vulnerabilities: 'cim#vulnerabilities',
  Alerts: 'cim#alerts',
};

/** Resolve a CIM data-model name to its golden-format key (`cim#network`, …). */
export function cimFormatKeyForModel(cimModel: string): string | null {
  const n = String(cimModel || '').trim();
  if (!n) return null;
  if (CIM_MODEL_FORMAT[n]) return CIM_MODEL_FORMAT[n];
  // Accept display names / loose spellings via the same normalize as cim-knowledge.
  const soft = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [name, key] of Object.entries(CIM_MODEL_FORMAT)) {
    if (name.toLowerCase().replace(/[^a-z0-9]/g, '') === soft) return key;
  }
  // Already a golden key?
  if (n.startsWith('cim#') && GOLDEN_FORMATS[n]) return n;
  const aliased = `cim#${n}`;
  if (GOLDEN_FORMATS[aliased]) return aliased;
  return null;
}

/** Reverse of cimFormatKeyForModel: `cim#network` / bare `cim` → `Network_Traffic`. */
export function cimModelForFormatKey(destFormat: string): string | null {
  let key = String(destFormat || '').trim();
  if (!key) return null;
  if (key === 'cim') key = 'cim#network';
  if (!key.startsWith('cim#')) return null;
  // Follow aliasOf (cim#cloud_audit → cim#change, cim#Network_Traffic → cim#network).
  const seen = new Set<string>();
  while (GOLDEN_FORMATS[key]?.aliasOf && !seen.has(key)) {
    seen.add(key);
    key = GOLDEN_FORMATS[key]!.aliasOf!;
  }
  for (const [model, fmt] of Object.entries(CIM_MODEL_FORMAT)) {
    if (fmt === key) return model;
  }
  const rest = key.slice('cim#'.length);
  if (CIM_MODEL_FORMAT[rest]) return rest;
  return null;
}

// The selectable Splunk CIM data models for a destination UI sub-selector: every
// curated CIM data model that has a golden-format mapping (`cim#<class>`), with a
// human label. Deduped by golden key, ordered as declared in CIM_MODEL_FORMAT.
// Mirrors asimSchemaOptions — used by the post-processing UI (and available to the
// main flow) so a concrete CIM model can be chosen rather than defaulting to the
// bare `cim` (Network Traffic) base.
export function cimSchemaOptions(): { key: string; label: string; model: string }[] {
  const seen = new Set<string>();
  const out: { key: string; label: string; model: string }[] = [];
  for (const [model, key] of Object.entries(CIM_MODEL_FORMAT)) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: model.replace(/_/g, ' '), model });
  }
  return out;
}

// The selectable ASIM schemas for the destination UI sub-selector: every
// `asim#<dataClass>` golden that maps to a real ASim* table, with a short label.
// Ordered so the most common schemas surface first.
export function asimSchemaOptions(): { key: string; label: string; table: string }[] {
  const order = ['asim#network', 'asim#authentication', 'asim#dns', 'asim#web_proxy',
    'asim#endpoint', 'asim#file', 'asim#registry', 'asim#audit', 'asim#dhcp', 'asim#usermgmt'];
  return order.map((key) => {
    const cls = key.split('#')[1];
    const table = ASIM_DATACLASS_TABLE[cls] || 'ASimNetworkSessionLogs';
    return { key, label: table.replace(/^ASim/, '').replace(/Logs$/, ''), table };
  });
}

// Concretize a bare `asim` build format into the specific `asim#<dataClass>`
// schema for THIS source+sample, so mapping, cleanup (column-keep), pipeline ID
// and scoring all agree on one ASIM schema. An explicit `asim#x` is respected
// as-is. Sample-aware: uses inferDataClass when a sample is present (the
// "sourcetype-sample advice"), else the static sourcetype data class.
export function concretizeAsimFormat(destFormat: string, sourcetypeRaw: string, sampleEvents?: string): string {
  if (destFormat !== 'asim') return destFormat; // already concrete or not asim
  const named = staticDataClassFor(canonicalizeSourcetype(sourcetypeRaw));
  const cls = (sampleEvents && sampleEvents.trim())
    ? inferDataClass(sourcetypeRaw, sampleEvents).dataClass
    // ASIM has no 'generic' table and NetworkSession is its catch-all — this
    // preserves the pre-pattern-table behaviour for an unclassified name.
    : (named === 'generic' ? 'network' : named);
  return ASIM_DATACLASS_KEY[cls] || 'asim';
}

// Concretize bare `cim` into `cim#<dataClass|model>` so mapping, serialize-raw
// keep-lists, pipeline ID and scoring all agree on ONE Splunk CIM data model.
// Explicit `cim#x` is respected. An explicit WizardState.cimModel wins over the
// sourcetype/sample data class (user picked Intrusion Detection on a firewall).
export function concretizeCimFormat(
  destFormat: string,
  sourcetypeRaw: string,
  sampleEvents?: string,
  cimModel?: string,
): string {
  if (destFormat !== 'cim') return destFormat; // already concrete or not cim
  if (cimModel) {
    const byModel = cimFormatKeyForModel(cimModel);
    if (byModel) return byModel;
  }
  const named = staticDataClassFor(canonicalizeSourcetype(sourcetypeRaw));
  const cls = (sampleEvents && sampleEvents.trim())
    ? inferDataClass(sourcetypeRaw, sampleEvents).dataClass
    : (named === 'generic' ? 'network' : named);
  return CIM_DATACLASS_KEY[cls] || 'cim#network';
}

// Data class → OCSF golden-format key. Classes without a dedicated class map use
// Network Activity (bare ocsf / ocsf#network).
const OCSF_DATACLASS_KEY: Record<string, string> = {
  network: 'ocsf#network',
  endpoint: 'ocsf#endpoint',
  cloud_audit: 'ocsf#cloud_audit',
  authentication: 'ocsf#authentication',   // Authentication (3002), category IAM
  web_proxy: 'ocsf#web_proxy',
  dns: 'ocsf#dns',                          // DNS Activity (4003), category Network
  email: 'ocsf#email',                      // Email Activity (4009), category Network
  dhcp: 'ocsf#dhcp',                        // DHCP Activity (4004), category Network
  privilege: 'ocsf#authorize_session',      // Authorize Session (3003), category IAM
  // Generic config/change audit trails (e.g. Salesforce Setup Audit Trail) stay
  // on API Activity; logon-centric audit sources (SAP) carry the `authentication`
  // data class instead — see SOURCETYPE_DATACLASS.
  audit: 'ocsf#cloud_audit',
};

export function isOcsfFormat(destFormat: string): boolean {
  return destFormat === 'ocsf' || destFormat.startsWith('ocsf#')
    || destFormat === 'nextgen' || destFormat.startsWith('nextgen#');
}

/**
 * `nextgen`/`nextgen#<class>` (plan Task 5) — raw-fidelity now, NOT an OCSF
 * mapping alias despite `isOcsfFormat()` still treating it as one for
 * label/schema-picker purposes (golden-formats.json's `nextgen`/`nextgen#endpoint`
 * entries are `aliasOf: 'ocsf'`/`'ocsf#endpoint'`, left in place so
 * `concretizeOcsfFormat`'s schema-variant picking still works, but they no
 * longer drive field mapping — every one of THIS predicate's call sites short-
 * circuits before the golden/AI/static mapping engines ever see it). Matches
 * whatever concrete key `concretizeOcsfFormat` produced, not just the bare
 * `'nextgen'` a caller started with.
 */
export function isNextGenRawFidelityFormat(destFormat: string): boolean {
  return destFormat === 'nextgen' || destFormat.startsWith('nextgen#');
}

/** OCSF output that is graded as OCSF. NG-SIEM ships the vendor's raw line, never OCSF. */
export function isOcsfScoredFormat(destFormat: string): boolean {
  return isOcsfFormat(destFormat) && !isNextGenRawFidelityFormat(destFormat);
}

// The NG-SIEM vendor parser reads the line exactly as the device sent it, but some
// of our parsers rewrite `_raw` for their own extraction (Windows parseWinEvent
// replaces it with an object; Zscaler strips quotes and swaps in the bare CEF
// extension). A nextgen pipeline therefore copies `_raw` aside before extraction
// and puts it back as its LAST step. The field is staged-build's ORIGINAL_RAW_COPY,
// which collectOutputValues already never scores.
const NEXTGEN_RAW_COPY = 'pg_original_raw_copy';
export function nextGenRawSnapshotFunction(): PipelineFunction {
  return { id: 'eval', filter: 'true', description: 'NG-SIEM: copy the original _raw aside before parsing', conf: { add: [{ name: NEXTGEN_RAW_COPY, value: '_raw' }] } };
}
// NG-SIEM bills the whole HEC payload and its vendor parser reads only the
// `event` (_raw), so the restore is also the output contract: every parsed,
// alias and envelope field is dropped here, after the optimization stage has
// used them. `*` does not match internal `__` fields; `_time` travels as the HEC
// `time`, not as a billed field.
export const NEXTGEN_OUTPUT_KEEP = ['_raw', '_time'];
export function nextGenRawRestoreFunction(): PipelineFunction {
  return {
    id: 'eval', filter: 'true', description: 'NG-SIEM: restore the original _raw and send only it (vendor parser + billing)',
    conf: {
      add: [{ name: '_raw', value: `typeof ${NEXTGEN_RAW_COPY} == 'string' ? ${NEXTGEN_RAW_COPY} : _raw` }],
      remove: ['*'],
      keep: [...NEXTGEN_OUTPUT_KEEP],
    },
  };
}
/** Wrap a nextgen pipeline: snapshot first, restore last, the copy kept through every keep-list. */
export function withNextGenRawRestore(fns: PipelineFunction[]): PipelineFunction[] {
  const kept = fns.map(f => Array.isArray(f?.conf?.keep) && !f.conf.keep.includes(NEXTGEN_RAW_COPY)
    ? { ...f, conf: { ...f.conf, keep: [...f.conf.keep, NEXTGEN_RAW_COPY] } }
    : f);
  return [nextGenRawSnapshotFunction(), ...kept, nextGenRawRestoreFunction()];
}

/** Selectable OCSF classes for the destination UI (same pills for NextGen SIEM). */
export function ocsfSchemaOptions(): { key: string; label: string; classUid: number }[] {
  return [
    { key: 'ocsf#network', label: 'Network Activity', classUid: 4001 },
    { key: 'ocsf#web_proxy', label: 'HTTP Activity', classUid: 4002 },
    { key: 'ocsf#endpoint', label: 'Process Activity', classUid: 1007 },
    { key: 'ocsf#cloud_audit', label: 'API Activity', classUid: 6003 },
    { key: 'ocsf#authentication', label: 'Authentication', classUid: 3002 },
    { key: 'ocsf#dns', label: 'DNS Activity', classUid: 4003 },
    { key: 'ocsf#email', label: 'Email Activity', classUid: 4009 },
    { key: 'ocsf#dhcp', label: 'DHCP Activity', classUid: 4004 },
    { key: 'ocsf#authorize_session', label: 'Authorize Session', classUid: 3003 },
    { key: 'ocsf#base', label: 'Base Event', classUid: 0 },
  ];
}

export function ocsfSchemaLabel(destFormat: string): string {
  const key = destFormat.startsWith('nextgen#')
    ? `ocsf#${destFormat.slice('nextgen#'.length)}`
    : destFormat === 'nextgen' ? 'ocsf#network'
    : destFormat === 'ocsf' ? 'ocsf#network'
    : destFormat;
  const opt = ocsfSchemaOptions().find(o => o.key === key);
  if (opt) return `OCSF 1.9 — ${opt.label} (${opt.classUid})`;
  const spec = GOLDEN_FORMATS[destFormat];
  const resolved = spec?.aliasOf ? GOLDEN_FORMATS[spec.aliasOf] : spec;
  return resolved?.label || spec?.label || 'OCSF 1.9';
}

// OCSF has classes the shared data-class model does not (DHCP, Base Event), and
// a `generic` source used to land on Network Activity regardless of what it is —
// the packtester audit (2026-10-02) found 33 of 74 OCSF packs there: WAFs and
// proxies, Cloudflare DNS/ZTNA, SharePoint audit, and plain application/service
// logs with no network 5-tuple at all. Refine by name, then by sample shape.
const DHCP_VERB_RE = /\bDHCP(?:DISCOVER|OFFER|REQUEST|DECLINE|ACK|NAK|RELEASE|INFORM|EXPIRE)\b/;
const FIVE_TUPLE_RE = /\b(?:src|dst|dest|source|destination|client|server|remote|local)[_.-]?(?:ip|addr(?:ess)?|port)\b|\bproto(?:col)?\s*[=:]/i;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// CEF/KV endpoint keys (`src=`, `dpt=`) and the `ip/port->ip/port` flow notation
// (Juniper RT_FLOW) carry endpoints too (packtester 2026-10-12: class-0 packs).
const ENDPOINT_KV_RE = /(?:^|[\s|,;])(?:src|dst|spt|dpt|sport|dport|srcip|dstip|SRC|DST)=\S|\d{1,3}(?:\.\d{1,3}){3}[/:]\d{1,5}\s*->\s*\d{1,3}(?:\.\d{1,3}){3}/;
// A login outcome in the text: sshd, VPN gateways, SSO and app audit logs.
const AUTH_TEXT_RE = /\b(?:authenticat(?:ed|ion)\b|log(?:ged)?[ -]?(?:in|on|off|out)\b|logon\b|sign(?:ed)?[ -]?in\b|Accepted (?:password|publickey|keyboard-interactive)|Failed password|Invalid user|session opened for user|VPN_LOGIN|LOGIN_(?:SUCCESS|FAIL))/i;

// Protocol / inventory / finding sources whose OCSF class is specific and that
// the shared data-class model can only call `network` or `generic` (packtester
// 2026-10-10: Corelight smb/ssh/ntp/tunnel/files landed in 4001 Network Activity
// although SMB 4006, SSH 4007, NTP 4013, Tunnel 4014 and Network File 4010 exist;
// tenable_sc_vuln in Base Event). Separators are `_` or `:` (`corelight:ssh`).
const SOURCETYPE_OCSF_CLASS: [RegExp, string][] = [
  [/(?:^|[_:])smb(?:[_:]|$)/, 'smb_activity'],
  [/(?:^|[_:])ssh(?:[_:]|$)/, 'ssh_activity'],
  [/(?:^|[_:])ntp(?:[_:]|$)/, 'ntp_activity'],
  [/(?:^|[_:])tunnel(?:[_:]|$)/, 'tunnel_activity'],
  [/(?:^|[_:])rdp(?:[_:]|$)/, 'rdp_activity'],
  [/(?:^|[_:])ftp(?:[_:]|$)/, 'ftp_activity'],
  [/(?:corelight|zeek|bro)[_:]files$/, 'network_file_activity'],
  [/(?:^|[_:])known[_:](?:hosts|devices)$/, 'inventory_info'],
  [/(?:^|[_:])vuln(?:erabilit(?:y|ies))?(?:[_:]|$)/, 'vulnerability_finding'],
];

/** The specific OCSF key a sourcetype NAME implies (`ocsf#smb_activity`), or null. */
export function sourcetypeOcsfClassKey(sourcetypeRaw: string): string | null {
  const st = String(sourcetypeRaw || '').toLowerCase();
  const hit = SOURCETYPE_OCSF_CLASS.find(([re]) => re.test(st));
  return hit ? ocsfKeyForClass(hit[1]) : null;
}

export function refineOcsfKey(dataClass: string, sourcetypeRaw: string, sampleEvents?: string): string {
  const st = String(sourcetypeRaw || '').toLowerCase();
  const lines = String(sampleEvents || '').split(/\r?\n/).filter(l => l.trim()).slice(0, 200);
  // DHCP wins over any data class: lease logs are classed `dns` (Infoblox) or
  // `network` by the shared model, and DHCP Activity is the specific OCSF class.
  if (/dhcp/.test(st) || (lines.length && lines.filter(l => DHCP_VERB_RE.test(l)).length / lines.length >= 0.3)) return 'ocsf#dhcp';
  const specific = sourcetypeOcsfClassKey(st);
  if (specific) return specific;
  const mapped = OCSF_DATACLASS_KEY[dataClass];
  if (mapped) return mapped;
  if (/proxy|waf|appfw|interscan|bluecoat|ironport_wsa|(?:^|_)https?(?:_|$)|access/.test(st)) return 'ocsf#web_proxy';
  if (/(?:^|_)dns(?:_|$)/.test(st)) return 'ocsf#dns';
  if (/ztna|login|logon|(?:^|_)auth(?:_|$)|sso/.test(st)) return 'ocsf#authentication';
  if (/eventhub|sharepoint|(?:^|_)audit(?:_|$)/.test(st)) return 'ocsf#cloud_audit';
  if (/firewall|(?:^|_)fw(?:_|$)|netflow|vpc_?flow|gateway_network/.test(st)) return 'ocsf#network';
  // No name signal: Network Activity only when the events carry endpoints.
  if (!lines.length) return 'ocsf#network';
  const networky = lines.filter(l => FIVE_TUPLE_RE.test(l) || ENDPOINT_KV_RE.test(l) || new Set(l.match(IPV4_RE) || []).size >= 2).length;
  if (networky / lines.length >= 0.5) return 'ocsf#network';
  // Base Event types almost nothing: a log that is mostly login outcomes (sshd,
  // VPN gateways, SSO) is Authentication. Half the lines, so an app error log
  // that mentions a login page now and then stays Base Event.
  const authy = lines.filter(l => AUTH_TEXT_RE.test(l)).length;
  return authy / lines.length >= 0.5 ? 'ocsf#authentication' : 'ocsf#base';
}

// Concretize bare `ocsf` into `ocsf#<class>`; `nextgen` stays `nextgen`.
// Explicit WizardState.ocsfSchema wins over data class.
export function concretizeOcsfFormat(
  destFormat: string,
  sourcetypeRaw: string,
  sampleEvents?: string,
  ocsfSchema?: string,
): string {
  if (destFormat !== 'ocsf' && destFormat !== 'nextgen') return destFormat;
  // NG-SIEM ships the original _raw only, so an OCSF class changes nothing it
  // sends; a legacy `nextgen#<class>` still builds the same raw-fidelity pipeline.
  if (destFormat === 'nextgen') return 'nextgen';
  if (ocsfSchema && ocsfSchema !== 'auto') {
    const cls = ocsfSchema.includes('#') ? ocsfSchema.split('#')[1] : ocsfSchema;
    const ocsfKey = `ocsf#${cls}`;
    if (GOLDEN_FORMATS[ocsfKey]) return ocsfKey;
    // Not a golden key: a class name, caption or class_uid from the vendored
    // schema ("Authorize Session", "3003"). Its spec is generated on demand.
    const choice = resolveOcsfClassChoice(ocsfSchema);
    if (choice && GOLDEN_FORMATS[choice.key]) return choice.key;
  }
  const named = staticDataClassFor(canonicalizeSourcetype(sourcetypeRaw));
  const cls = (sampleEvents && sampleEvents.trim())
    ? inferDataClass(sourcetypeRaw, sampleEvents).dataClass
    : (named === 'generic' ? 'network' : named);
  return refineOcsfKey(cls, sourcetypeRaw, sampleEvents);
}

// The data class to resolve schemas / score against for THIS build. When a real
// sample is present we sniff the events (`inferDataClass`) instead of trusting
// the sourcetype NAME alone — `inferDataClass` only overrides the static label
// when the sample overwhelmingly disagrees (a higher confidence bar + ≥3 hits
// for a curated label, the lower ≥0.6/≥2 bar only for an unclassified 'generic'
// one), so a correctly-labelled known source is untouched.
// This is what lets a source whose NAME the table doesn't classify (falls to
// 'generic') — or one carrying a stale/wrong label — still land on the schema
// that fits its actual content on the FIRST pass (e.g. Linux auditd sniffs as
// 'endpoint' → Process Activity, not the 'generic' json/cim its name implies).
// SOURCETYPE_DATACLASS / inferDataClass are declared later in the file (hoisted
// function + const-after-use is fine — this is only called at build/score time).
function effectiveDataClass(sourcetypeRaw: string, sampleEvents?: string): DataClass {
  if (sampleEvents && sampleEvents.trim()) return inferDataClass(sourcetypeRaw, sampleEvents).dataClass;
  return staticDataClassFor(canonicalizeSourcetype(sourcetypeRaw));
}

// The `<family>@<st>` override a concretized `<family>#<class>` key falls back
// to — only when that entry is flagged `servesFamily` (see resolveGoldenFormat).
function servingFamilyOverride(destFormat: string, st: string): GoldenFormatSpec | undefined {
  const hash = destFormat.indexOf('#');
  if (hash <= 0) return undefined;
  const entry = GOLDEN_FORMATS[`${destFormat.slice(0, hash)}@${st}`];
  return entry?.servesFamily ? entry : undefined;
}

// Whether this build's OCSF class is computed PER EVENT (the Windows dispatcher)
// rather than fixed by the key — the class audit grades those differently.
export function dispatchesOcsfClassPerEvent(destFormat: string, sourcetypeRaw: string): boolean {
  const st = canonicalizeSourcetype(sourcetypeRaw);
  const family = destFormat.includes('#') ? destFormat.slice(0, destFormat.indexOf('#')) : destFormat;
  return family === 'ocsf' && (!!servingFamilyOverride(destFormat, st) || !!GOLDEN_FORMATS[`ocsf@${st}`]?.servesFamily);
}

// Resolve a format spec, following aliasOf (e.g. nextgen → ocsf). Sample-aware:
// when `sampleEvents` is supplied, the `<fmt>#<dataClass>` variant is chosen from
// the SAMPLE-inferred class (see effectiveDataClass), not the name-only table —
// so build AND score must both pass the same sample to agree on one schema.
function resolveGoldenFormat(destFormat: string, sourcetypeRaw?: string, sampleEvents?: string): GoldenFormatSpec | null {
  const deref = (s: GoldenFormatSpec | undefined) => s ? (s.aliasOf ? GOLDEN_FORMATS[s.aliasOf] : s) : undefined;
  if (sourcetypeRaw) {
    const st = canonicalizeSourcetype(sourcetypeRaw);
    // 1. Exact source-specific override wins (rare, for one-off tuning). A
    //    concretized key (`ocsf#authentication`) also takes its family's override
    //    (`ocsf@windows_security`) when that override is flagged `servesFamily`:
    //    builds never ask for the bare family, so the Windows per-event class
    //    dispatch was otherwise unreachable and every event got the key's one
    //    constant class. The flag is per entry (read BEFORE aliasOf), because
    //    DNS Client / Defender alias the same spec but the dispatcher has no
    //    class for them — `ocsf#dns` serves them better.
    const exact = deref(GOLDEN_FORMATS[`${destFormat}@${st}`] || servingFamilyOverride(destFormat, st));
    if (exact) return exact;
    // 2. Pick the schema that best fits the source's DATA CLASS, keyed
    //    `<fmt>#<dataClass>`. For OCSF this chooses the class: network→Network
    //    Activity (4001), cloud_audit→API Activity (6003), authentication→
    //    Authentication (3002), etc. — a firewall gets 4001, CloudTrail gets
    //    6003, a login source gets 3002. The class comes from the SAMPLE when one
    //    is present (effectiveDataClass), else the name-only SOURCETYPE_DATACLASS
    //    table. CIM/other formats can register audit-specific datamodels the same
    //    way (`cim#cloud_audit`).
    const dataClass = effectiveDataClass(st, sampleEvents);
    const byClass = deref(GOLDEN_FORMATS[`${destFormat}#${dataClass}`]);
    if (byClass) return byClass;
  }
  return deref(GOLDEN_FORMATS[destFormat]) || null;
}

// Whether we can assemble this (sourcetype, destFormat) deterministically:
// the source must yield canonical fields (a known built-in parser) AND a golden
// spec must exist. This is the gold-source + gold-dest = perfect path.
export function hasGoldenFormatPath(sourcetypeRaw: string, destFormat: string, sampleEvents?: string): boolean {
  if (destFormat === 'xsiam') return true;
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const knownParser = getParserFieldNames(sourcetype).length > 0;
  return knownParser && resolveGoldenFormat(destFormat, sourcetype, sampleEvents) !== null;
}

// --- Destination-format recommender -----------------------------------------
// Mirrors Cribl Copilot's get_recommended_schemas: from a sourcetype's DATA
// CLASS (what the events describe), recommend the destination formats that model
// it best, plus the OCSF class the events map to. Removes the "which schema?"
// guesswork — the wizard can pre-select and badge the recommended formats.

// Sourcetype NAME-FAMILY patterns → data class, consulted only when the exact
// table above misses. Of 202 catalog sourcetypes the exact table classified 29
// and left 173 on `generic`, which means `resolveGoldenFormat` handed every one
// of them the DEFAULT (network) spec while `recommendDestFormats` advised `json` —
// an email log and a database audit trail both mapped through a firewall spec.
// That is the destination-selection half of the batch-446 "mapping ~0" signature.
//
// Why patterns and not 173 more literals: the catalog is SYNCED (`sync:datatypes`),
// and the names that arrive are vendor-systematic — 42 of the 173 are `pan_*`
// subtype × wire-format variants (`pan_traffic_csv` / `_syslog` / `_syslog_nopri`).
// A family rule classifies the next variant Cribl adds; a literal list silently
// goes stale and the new name falls back to a firewall spec again.
//
// Why NOT derived from the parser's field contract (measured, do not re-derive):
// running the DATACLASS_SIGNALS key patterns over `getParserFieldNames` output
// disagrees with 13 of the 29 hand-classified sources — `palo_alto_threat`→email,
// `aws_cloudtrail`→web_proxy, `infoblox_dns`→network, `crowdstrike_falcon`→network —
// and 92 of the 173 have no enumerable contract at all (dynamic serde parsers), so
// there is nothing to vote on. Field names are good SAMPLE evidence (that is what
// `inferDataClass` uses, gated on confidence) and bad NAME evidence.
//
// ORDER MATTERS: first match wins, so specific rules precede family rules
// (`^corelight_` → network would otherwise swallow the exact `corelight_dns`, and
// `^(bro|zeek)_http` must beat the `^(bro|zeek)_` catch-all). Recognition
// deliberately does NOT consult this table — `isKnownSourcetype` and
// `describeSourcetype` stay on the exact map, because a lenient `/^pan_/` would
// declare a name we have no parser for "known" (the leniency trap in the
// ambiguous-vendor-token fix). This table only chooses a DESTINATION SPEC.
const SOURCETYPE_DATACLASS_PATTERNS: { re: RegExp; cls: DataClass }[] = [
  // --- dns: resolver / DDI telemetry ---------------------------------------
  { re: /^infoblox_/, cls: 'dns' },                     // every Infoblox feed is DDI (syslog/CEF/LEEF framings of one source)
  { re: /^isc_bind/, cls: 'dns' },
  { re: /^microsoft_dns_server/, cls: 'dns' },
  { re: /^aws_route53/, cls: 'dns' },
  { re: /^(bro|zeek)_dns/, cls: 'dns' },
  { re: /^cisco_cloud_security_dns$/, cls: 'dns' },     // Umbrella DNS-layer
  { re: /^cisco_umbrella(_dns)?$/, cls: 'dns' },        // Umbrella's primary log is the DNS layer; proxy is split below
  { re: /^cloudflare_gateway_dns$/, cls: 'dns' },
  // eStreamer's DNS feed, ahead of the `^cisco_…estreamer` network family (packtester 2026-10-09).
  { re: /^cisco_(sfw_)?estreamer(_data)?_dns$/, cls: 'dns' },
  // --- email ---------------------------------------------------------------
  { re: /^proofpoint_/, cls: 'email' },
  { re: /gmail/, cls: 'email' },
  { re: /messagetrace$/, cls: 'email' },                // o365_reporting_messagetrace
  // MTA / mail-gateway logs. They fell to `^corelight_` → network or to `generic`
  // and were built as Network Activity / Base Event (packtester 2026-10-09).
  { re: /^(corelight|bro|zeek)_smtp$/, cls: 'email' },
  { re: /^clearswift/, cls: 'email' },
  { re: /^postfix/, cls: 'email' },
  { re: /^symantec_email/, cls: 'email' },
  // --- web_proxy: HTTP request logs ----------------------------------------
  { re: /^aws_nlb_accesslog$/, cls: 'network' },        // NLB is L4 — deliberately NOT grouped with the HTTP LBs below
  { re: /^aws_(alb|elb)_accesslog$/, cls: 'web_proxy' },
  { re: /^aws_cloudfront/, cls: 'web_proxy' },
  { re: /^aws_s3_access$/, cls: 'web_proxy' },
  { re: /^microsoft_iis_accesslog$/, cls: 'web_proxy' },
  { re: /^nginx_/, cls: 'web_proxy' },
  { re: /^squid_/, cls: 'web_proxy' },
  { re: /^zia_/, cls: 'web_proxy' },                    // Zscaler Internet Access (csv/tsv/alerts)
  { re: /^cisco_cloud_security_proxy$/, cls: 'web_proxy' },
  { re: /^cisco_umbrella_proxy$/, cls: 'web_proxy' },
  { re: /^imperva_incapsula/, cls: 'web_proxy' },
  { re: /^(bro|zeek)_http/, cls: 'web_proxy' },
  { re: /^stream_http$/, cls: 'web_proxy' },
  { re: /^splunkd_ui_access$/, cls: 'web_proxy' },
  { re: /^aws_waf_log_json$/, cls: 'web_proxy' },
  { re: /^cloudflare_http_request$/, cls: 'web_proxy' },
  // --- authentication ------------------------------------------------------
  { re: /^pan_(authentication|globalprotect)/, cls: 'authentication' },
  { re: /^duo_security$/, cls: 'authentication' },
  { re: /^cisco_duo_activity$/, cls: 'authentication' },
  { re: /^oktaim2/, cls: 'authentication' },
  { re: /^azure_monitor_aad$/, cls: 'authentication' },
  { re: /^linux_secure$/, cls: 'authentication' },
  { re: /^ibm_racf/, cls: 'authentication' },           // mainframe security manager
  { re: /^activedirectory$/, cls: 'authentication' },
  { re: /^gws_reports_login$/, cls: 'authentication' },
  { re: /^azure_graph_signins$/, cls: 'authentication' },
  // Cisco ISE is RADIUS/TACACS+ AAA; an LDAP access log is binds. The bare
  // `access` in its name otherwise picked HTTP Activity (refineOcsfKey).
  { re: /^cisco_ise/, cls: 'authentication' },
  { re: /^(openldap|ldap)_access/, cls: 'authentication' },
  // --- privilege: elevation / PAM / EPM sessions → Authorize Session (3003) --
  // Admin By Request, MakeMeAdmin, CyberArk/BeyondTrust EPM, sudo session logs.
  // Exact-mapped auth logs (linux_secure) win before these families run.
  { re: /admin_?session|adminbyrequest|makemeadmin|elevat|privilege/, cls: 'privilege' },
  { re: /(^|_)(pam|epm|sudo)(_|$)/, cls: 'privilege' },
  // --- endpoint: process / host telemetry ----------------------------------
  { re: /^carbonblack/, cls: 'endpoint' },
  { re: /^crowdstrike_/, cls: 'endpoint' },
  { re: /osquery/, cls: 'endpoint' },
  { re: /^sysmon_/, cls: 'endpoint' },
  { re: /^(auditd|linux_auditd_log|linux_messages_syslog)$/, cls: 'endpoint' },
  { re: /^kube_container_falco$/, cls: 'endpoint' },
  { re: /^ms(365)?_defender/, cls: 'endpoint' },
  { re: /defender_advancedhunting$/, cls: 'endpoint' },
  { re: /^microsoft_windows_eventlog_classic$/, cls: 'endpoint' },
  { re: /^pwsh_/, cls: 'endpoint' },                    // PowerShell operational (cf. windows_powershell)
  { re: /^cisco_isovalent_process/, cls: 'endpoint' },  // Cilium process exec/connect
  { re: /^pan_hipmatch/, cls: 'endpoint' },             // host information profile
  // --- cloud_audit: control-plane API records ------------------------------
  { re: /^o365_(management_activity|graph_api)$/, cls: 'cloud_audit' },
  { re: /^gws_reports_admin$/, cls: 'cloud_audit' },
  { re: /^gsuite_drive/, cls: 'cloud_audit' },
  { re: /^github(_cloud)?_audit$/, cls: 'cloud_audit' },
  { re: /^azure_monitor_activity$/, cls: 'cloud_audit' },
  { re: /^mscs_azure_audit$/, cls: 'cloud_audit' },
  { re: /^salesforce_eventlogfile_/, cls: 'cloud_audit' },
  { re: /^circleci$/, cls: 'cloud_audit' },
  { re: /^aws_securityhub_finding$/, cls: 'cloud_audit' },
  { re: /^aws_eks_audit$/, cls: 'cloud_audit' },
  { re: /^azure_graph_directory_audits$/, cls: 'cloud_audit' },
  { re: /^cloudflare_audit$/, cls: 'cloud_audit' },
  { re: /^gcp_audit_logs$/, cls: 'cloud_audit' },
  { re: /^gitlab_audit_(log|streaming)$/, cls: 'cloud_audit' },
  // --- audit: configuration / database change trails ----------------------
  { re: /^aws_rds_audit/, cls: 'audit' },
  { re: /^mysql_server_audit$/, cls: 'audit' },
  { re: /^ibm_(db2_audit|aix_audit)/, cls: 'audit' },
  { re: /^pan_config/, cls: 'audit' },
  { re: /^imperva_dam$/, cls: 'audit' },                // database activity monitoring
  { re: /^ivanti_vtm_audit$/, cls: 'audit' },
  { re: /^iis_configuration_operational$/, cls: 'audit' },
  { re: /^cisco_duo_administrator$/, cls: 'audit' },
  { re: /^aws_config$/, cls: 'audit' },
  // --- network: firewall / flow / IDS (broadest — last) --------------------
  { re: /^pan_(traffic|threat|tunnel|correlation|iptag)/, cls: 'network' },
  { re: /^(bro|zeek)_/, cls: 'network' },
  { re: /^corelight_/, cls: 'network' },                // corelight_dns is exact-mapped to dns above
  { re: /^checkpoint_firewall/, cls: 'network' },
  { re: /^cisco_(asa|fwsm|ios|ips|meraki|netflow|sdwan|estreamer|sfw_estreamer)/, cls: 'network' },
  { re: /^cisco_nvm_flowdata/, cls: 'network' },
  { re: /^cisco_cloud_security_firewall$/, cls: 'network' },
  { re: /^fortinet_/, cls: 'network' },
  { re: /^microsoft_dhcp/, cls: 'network' },
  { re: /^(snort|suricata)/, cls: 'network' },
  { re: /^stream_(ip|tcp)$/, cls: 'network' },
  { re: /^vmware_nsx_/, cls: 'network' },
  { re: /^aws_vpc_/, cls: 'network' },
  { re: /^aws_network_firewall$/, cls: 'network' },
  { re: /^cloudflare_firewall_event$/, cls: 'network' },
  { re: /^gcp_(firewall|vpc_flow)$/, cls: 'network' },
  { re: /^unifi_/, cls: 'network' },
  // Firewalls with no exact entry. Unnamed, they fell to `generic`, where the
  // sample is the only vote — and a firewall's URL-filtering/web-auth lines carry
  // `url`/`status`, so juniper_srx, sophos_xg, pfsense and barracuda were built
  // as OCSF HTTP Activity.
  { re: /^juniper_(srx|junos|netscreen)/, cls: 'network' },
  { re: /^sophos_(xg|xgs|utm)$/, cls: 'network' },
  { re: /^(pfsense|opnsense)/, cls: 'network' },
  { re: /^barracuda_cloudgen_firewall$/, cls: 'network' },
  { re: /^sonicwall/, cls: 'network' },
  { re: /^watchguard_firebox/, cls: 'network' },
  { re: /^cisco_umbrella_(cloud_)?firewall$/, cls: 'network' },
  // LEEF, like CEF (exact-mapped to network), is a security-device framing whose
  // predefined keys are a 5-tuple (src/dst/srcPort/dstPort/proto).
  { re: /^leef$/, cls: 'network' },
];

// The ONE name-only data-class resolver: exact table, then name family, else
// `generic`. Every destination-selection path goes through this so the spec a
// build maps to and the spec the scorer measures against can never diverge.
// Takes an ALREADY-CANONICAL sourcetype.
export function staticDataClassFor(canonical: string): DataClass {
  const exact = SOURCETYPE_DATACLASS[canonical];
  if (exact) return exact;
  for (const { re, cls } of SOURCETYPE_DATACLASS_PATTERNS) if (re.test(canonical)) return cls;
  return 'generic';
}

// Per data class: recommended destination formats (best first) + the OCSF
// class name/uid the events map to (for a schema hint / future OCSF versioning).
const DATACLASS_RECOMMENDATION: Record<DataClass, { formats: string[]; ocsfClass: string; ocsfClassUid: number }> = {
  network:        { formats: ['ocsf', 'cim', 'cef', 'asim', 'xsiam'],     ocsfClass: 'Network Activity', ocsfClassUid: 4001 },
  authentication: { formats: ['ocsf', 'cim', 'asim', 'xsiam'],           ocsfClass: 'Authentication',   ocsfClassUid: 3002 },
  endpoint:       { formats: ['ocsf', 'cim', 'ecs', 'asim'],   ocsfClass: 'Process Activity',  ocsfClassUid: 1007 },
  web_proxy:      { formats: ['ocsf', 'cim', 'ecs', 'asim'],   ocsfClass: 'HTTP Activity',     ocsfClassUid: 4002 },
  email:          { formats: ['ocsf', 'cim'],                   ocsfClass: 'Email Activity',    ocsfClassUid: 4009 },
  cloud_audit:    { formats: ['ocsf', 'ecs', 'xsiam'],          ocsfClass: 'API Activity',      ocsfClassUid: 6003 },
  audit:          { formats: ['cim', 'cef', 'ocsf', 'asim'],   ocsfClass: 'Authentication',   ocsfClassUid: 3002 },
  dns:            { formats: ['ocsf', 'cim', 'asim'],          ocsfClass: 'DNS Activity',      ocsfClassUid: 4003 },
  privilege:      { formats: ['ocsf', 'json'],                  ocsfClass: 'Authorize Session', ocsfClassUid: 3003 },
  generic:        { formats: ['json', 'cim'],                   ocsfClass: 'Base Event',        ocsfClassUid: 0 },
};

export interface FormatRecommendation {
  dataClass: DataClass;
  formats: string[];        // recommended destFormat values, best first
  ocsfClass: string;
  ocsfClassUid: number;
  primary: string;          // the single best-fit format
}

export function recommendDestFormats(sourcetypeRaw: string): FormatRecommendation {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const dataClass = staticDataClassFor(sourcetype);
  const rec = DATACLASS_RECOMMENDATION[dataClass];
  return { dataClass, formats: rec.formats, ocsfClass: rec.ocsfClass, ocsfClassUid: rec.ocsfClassUid, primary: rec.formats[0] };
}

// --- Sample-aware data-class inference --------------------------------------
// The static SOURCETYPE_DATACLASS table keys off the sourcetype STRING alone.
// When a REAL, independent sample exists (interactive wizard, demo-gen, or a
// batch row's generated sample), we can sniff the events themselves to detect
// what they actually describe — and flag when that disagrees with the label.
// This is a light heuristic over field names + content signals, NOT a parser:
// it scores each data class from evidence and returns the winner with a
// confidence, so callers can decide whether to advise a switch.
//
// NOTE on batch: a batch sample that was AI-GENERATED from the sourcetype
// carries no signal the sourcetype didn't already imply — inference there will
// simply agree. It earns its keep on (a) interactive user-pasted samples and
// (b) batch rows backed by a real bundled REFERENCE sample. Callers gate on
// `disagrees` + `confidence` before prompting, so an agreeing check is a no-op.

export interface DataClassInference {
  dataClass: DataClass;       // best-fit class from the sample evidence
  confidence: number;         // 0..1 — share of total evidence the winner holds
  staticDataClass: DataClass; // what the sourcetype table says
  disagrees: boolean;         // winner != static AND confidence is meaningful
  signals: string[];          // human-readable evidence, best first
}

// Field-name / content signals per data class. Matched case-insensitively
// against the sample's distinct key set and (for a few) the raw text. Weightier,
// more-specific signals first — a `registry`/`sysmon` hit is stronger evidence
// of endpoint than a bare `process`.
const DATACLASS_SIGNALS: { cls: DataClass; keys?: RegExp[]; raw?: RegExp[]; weight: number; label: string }[] = [
  // endpoint — process/registry/image/parent telemetry (Sysmon, EDR)
  { cls: 'endpoint', keys: [/^(image|parentimage|commandline|parentcommandline|targetfilename|targetobject|processguid|parentprocessguid)$/i], weight: 3, label: 'process/registry telemetry (Image/CommandLine/TargetObject)' },
  { cls: 'endpoint', raw: [/microsoft-windows-sysmon|\bsysmon\b|technique_id=/i], weight: 3, label: 'Sysmon provider / MITRE technique tag' },
  // cloud_audit — API-call audit records (CloudTrail, GCP audit)
  { cls: 'cloud_audit', keys: [/^(eventsource|eventname|useridentity|awsregion|recipientaccountid|sourceipaddress|requestparameters|responseelements)$/i], weight: 3, label: 'cloud audit envelope (eventSource/eventName/userIdentity)' },
  { cls: 'cloud_audit', raw: [/"eventsource"\s*:\s*"[a-z0-9.-]+\.amazonaws\.com"|protoPayload|methodName/i], weight: 3, label: 'CloudTrail/GCP audit payload' },
  // authentication — logon/credential events
  { cls: 'authentication', keys: [/^(logontype|targetusername|subjectusername|authenticationpackagename|targetlogonid|logonid)$/i], weight: 3, label: 'logon fields (LogonType/TargetUserName/AuthenticationPackage)' },
  { cls: 'authentication', raw: [/\b(4624|4625|4634|4648|4672|4776)\b|an account (was|failed) to log/i], weight: 2, label: 'Windows Security logon EventIDs (4624/4625…)' },
  // dns — resolver query/response telemetry
  { cls: 'dns', keys: [/^(dns_query|dnsquery|queryname|query_name|dns_response|response_code|rcode|rcode_name|query_type|querytype|qtype_name|answer|answers|resolved_ip)$/i], weight: 3, label: 'DNS resolver fields (dns_query/QueryName/response_code)' },
  // web_proxy — HTTP request logs. The STRONG signal is the request target/verb/
  // result (url/uri/method/status): those together mean the log describes an HTTP
  // request. A lone `user_agent`/`referrer` is a WEAK signal — admin/API audit
  // logs (GitHub, GCP, o365) routinely record the calling client's user-agent
  // without being web-proxy traffic, so at weight 3 a single `user_agent` key
  // flipped github_audit (cloud_audit) → web_proxy@0.6 and built a CIM Web-model
  // pipeline the source can't fill. Kept as its own weight-1 signal so it nudges,
  // never decides.
  { cls: 'web_proxy', keys: [/^(http_method|httpmethod|url|uri|url_category|urlcategory|http_status|status_code|responsecode)$/i], weight: 3, label: 'HTTP request fields (url/method/status)' },
  { cls: 'web_proxy', keys: [/^(useragent|user_agent|referer|referrer)$/i], weight: 1, label: 'HTTP client hints (user-agent/referrer)' },
  { cls: 'web_proxy', raw: [/"(GET|POST|PUT|DELETE|HEAD) [^"]+ HTTP\/\d/i], weight: 2, label: 'HTTP request line in raw' },
  // email — message/recipient metadata. STRONG evidence is the addressing/routing
  // fields that do not appear outside mail (sender/recipient/mail_from/rcpt_to/
  // message_id/attachment).
  { cls: 'email', keys: [/^(sender|recipient|mail_from|mailfrom|rcpt_to|rcptto|message_id|msg_id|attachment)$/i], weight: 3, label: 'email fields (sender/recipient/mail_from/message_id)' },
  // WEAK: a bare `subject` collides with a TLS certificate subject (corelight_ssl)
  // and an LDAP search subject. At weight 3 a lone cert `subject` flipped SSL logs
  // network→email at exactly the 0.75 override bar and built an Email Activity
  // pipeline that scored well against the sample but was semantically wrong. Keep
  // `subject` as a nudge only — it can no longer, alone, flip a curated label.
  { cls: 'email', keys: [/^subject$/i], weight: 1, label: 'message subject (weak — collides with cert/LDAP subject)' },
  // network — L3/L4 flow/firewall (generic — many sources carry ips/ports, so
  // this only wins when NOTHING more specific fires)
  { cls: 'network', keys: [/^(src_ip|source_ip|srcip|dest_ip|destination_ip|dstip|src_port|dest_port|dstport|protocol|transport|bytes_in|bytes_out|action|rule)$/i], weight: 1, label: 'network 5-tuple (src/dest ip+port, protocol, action)' },
  // privilege — privilege elevation / PAM / EPM sessions (Admin By Request,
  // MakeMeAdmin, sudo). OCSF Authorize Session (3003): an approver/denier and the
  // elevated session, not a logon. Customer feedback 2026-10-09: ABR "Admin
  // Session" events fell to `generic` → Base Event.
  { cls: 'privilege', keys: [/^(approvedby|approvedbyemail|deniedby|deniedbyemail|deniedreason|elevatedapplications|isadmin|ssovalidated)$/i], weight: 3, label: 'privilege elevation fields (approvedBy/deniedBy/elevatedApplications)' },
  { cls: 'privilege', raw: [/"type"\s*:\s*"Admin Session"|\bAdmin Session\b/], weight: 2, label: 'Admin Session events' },
  // audit — generic change/audit trails
  { cls: 'audit', keys: [/^(audit|change|old_value|new_value|actor|operation)$/i], weight: 1, label: 'audit trail fields (operation/old_value/new_value)' },
];

export function inferDataClass(sourcetypeRaw: string, sampleEvents: string): DataClassInference {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  const staticDataClass = staticDataClassFor(sourcetype);

  const fp = sampleFingerprint(sampleEvents);
  const keySet = new Set(fp.keys); // already lowercased + sorted
  const rawText = (sampleEvents || '').slice(0, 20000); // cap for regex cost

  const scores = new Map<DataClass, number>();
  const hits = new Map<DataClass, number>();
  const signals: { label: string; weight: number }[] = [];
  const add = (cls: DataClass, w: number, label: string) => {
    scores.set(cls, (scores.get(cls) || 0) + w);
    hits.set(cls, (hits.get(cls) || 0) + 1);
    signals.push({ label, weight: w });
  };

  for (const sig of DATACLASS_SIGNALS) {
    let hit = false;
    if (sig.keys && [...keySet].some(k => sig.keys!.some(re => re.test(k)))) hit = true;
    if (!hit && sig.raw && sig.raw.some(re => re.test(rawText))) hit = true;
    if (hit) add(sig.cls, sig.weight, sig.label);
  }

  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  let dataClass: DataClass = staticDataClass;
  let confidence = 0;
  if (total > 0) {
    const [winner, top] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    dataClass = winner;
    confidence = top / total;
  }

  // Disagreement is only actionable when the sample gave real, mostly-unanimous
  // evidence for a DIFFERENT class than the label. A weak/split signal (e.g. a
  // bare 5-tuple that every source carries) must not override a known
  // sourcetype — require a clear majority.
  //
  // A CURATED label (the sourcetype is in SOURCETYPE_DATACLASS / matches a
  // pattern → not 'generic') is authoritative and only yielded when the sample
  // OVERWHELMINGLY disagrees: a higher confidence bar AND at least two DISTINCT
  // signals for the winner, so one strong-but-incidental signal can't flip it.
  // The count is of signals, not weight: a lone weight-3 signal clears any
  // weight floor on its own, and did — eStreamer's connection events carry `url`
  // (network → HTTP Activity), o365 mailbox audit carries `LogonType`
  // (cloud_audit → Authentication). A 'generic' label carries no such trust — the
  // sample is the only vote there, so it keeps the lower bar (this is what lets
  // an unclassified name still land on the schema its content implies, e.g.
  // auditd → endpoint).
  const staticIsCurated = staticDataClass !== 'generic';
  const overrideBar = staticIsCurated ? 0.75 : 0.6;
  const minTotal = staticIsCurated ? 3 : 2;
  const minWinnerHits = staticIsCurated ? 2 : 1;
  const disagrees = dataClass !== staticDataClass && confidence >= overrideBar && total >= minTotal
    && (hits.get(dataClass) || 0) >= minWinnerHits;

  return {
    dataClass: disagrees ? dataClass : staticDataClass,
    confidence,
    staticDataClass,
    disagrees,
    signals: signals.sort((a, b) => b.weight - a.weight).map(s => s.label),
  };
}

// Format recommendation refined by the actual sample. Falls back to the static
// sourcetype recommendation when the sample agrees (or gives no clear signal);
// when the sample clearly disagrees, recommends for the INFERRED class instead.
export function recommendDestFormatsForSample(sourcetypeRaw: string, sampleEvents: string): FormatRecommendation & { inference: DataClassInference } {
  const inference = inferDataClass(sourcetypeRaw, sampleEvents);
  const rec = DATACLASS_RECOMMENDATION[inference.dataClass];
  return {
    dataClass: inference.dataClass,
    formats: rec.formats,
    ocsfClass: rec.ocsfClass,
    ocsfClassUid: rec.ocsfClassUid,
    primary: rec.formats[0],
    inference,
  };
}

// Inline a value rule reference: if expr is a key in valueRules, return the rule
// body; otherwise return expr unchanged. Rules reference canonical fields.
function resolveExpr(expr: string, rules: Record<string, string> | undefined): string {
  if (rules && rules[expr]) return rules[expr];
  return expr;
}

// Build a Cribl eval expression that converts `srcExpr` (a field reference or
// sub-expression) to epoch MILLISECONDS, handling every shape a parsed
// timestamp can arrive in: 13-digit epoch ms, 10-digit epoch s, either WITH a
// fractional-seconds suffix (Meraki emits `1737021600.123456`), or a parseable
// date string. The two purely-integer branches (ms/s) MUST be checked before
// the fractional ones, else a 13-digit ms value with no fraction would fall
// through; order here matches that requirement.
// Apache/NCSA CLF `30/Sep/2026:01:14:22 +0000` is not Date-parseable; reorder it
// to `Sep 30 2026 01:14:22 +0000` (which V8 parses). Non-CLF strings are untouched.
const CLF_TIME_RE = '/^(\\d{1,2})\\/([A-Za-z]{3})\\/(\\d{4}):(\\d{2}:\\d{2}:\\d{2})\\s*([+-]\\d{4})?$/';
// RFC 3164 syslog has no year (`Sep 30 03:14:27`): V8 reads that as 2001, which
// put a third of the packtester timestamps 25 years back (audit 2026-10-12). Use
// the current year, or the previous one when that lands more than a day ahead
// (a December event read in January).
const SYSLOG_NOYEAR_RE = '/^([A-Za-z]{3})\\s+(\\d{1,2})\\s+(\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)$/';
export function epochMsExpr(srcExpr: string): string {
  const s = `String(${srcExpr})`;
  const inYear = (y: string) => `new Date(${s}.replace(${SYSLOG_NOYEAR_RE}, '$1 $2 ' + (${y}) + ' $3')).getTime()`;
  const thisYear = 'new Date().getFullYear()';
  const noYear = `(${inYear(thisYear)} > new Date().getTime() + 86400000 ? ${inYear(`${thisYear} - 1`)} : ${inYear(thisYear)})`;
  return `(/^\\d{13}$/.test(${s}) ? Number(${srcExpr}) : /^\\d{10}$/.test(${s}) ? Number(${srcExpr}) * 1000 : /^\\d{13}\\.\\d+$/.test(${s}) ? Number(${srcExpr}) : /^\\d{10}\\.\\d+$/.test(${s}) ? Number(${srcExpr}) * 1000 : ${SYSLOG_NOYEAR_RE}.test(${s}) ? ${noYear} : new Date(${s}.replace(${CLF_TIME_RE}, '$2 $1 $3 $4 $5')).getTime())`;
}

// --- Deterministic schema-validated verification -----------------------------
// Copilot's run_and_validate_pipeline diffs real output vs a FORMAL schema
// (deterministic), where our old scorer was an AI judge (noisy 72↔82). This does
// the same for golden-format destinations: score = how completely the real
// preview output populates the fields the golden spec defines AND the source
// actually supplied. Structural (CEF header/shape) + population + numeric typing
// are all checked in code — no AI, so the number is stable and reproducible.

export interface SchemaValidationFinding {
  severity: 'high' | 'medium' | 'low';
  field: string;
  issue: string;
  // Points this finding actually cost against the 0-100 score, so a "high"
  // AI-judgment finding that happens to have ZERO score effect (e.g. it flags
  // something the deterministic scorer doesn't check, or a type-mismatch that
  // still counts as "populated") isn't confused with the field-empty findings
  // that directly drove the number down. 0 = advisory only, didn't move the score.
  pointImpact?: number;
}
export interface SchemaValidationResult {
  supported: boolean;   // false when no golden spec (fall back to AI scorer)
  score: number;        // 0..100, source-relative
  band: 'good' | 'warn' | 'fail';
  outputFormatOk: boolean;
  findings: SchemaValidationFinding[];
  missingFields: string[];  // spec fields whose SOURCE value existed but output is empty
  emptyFields: string[];
  checkedFields: number;
  populatedFields: number;
}

// Read a possibly-dotted path from an object (src_endpoint.ip → o.src_endpoint.ip).
// A repeated message mid-path (UDM `security_result` is an array) reads its
// first element, so `security_result.action` still resolves.
function readPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : Array.isArray(o) ? o[0]?.[k] : o[k]), obj);
}
function isPopulated(v: any): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v !== '' && v !== 'undefined' && v !== 'null' && v !== '-';
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true; // numbers/booleans (incl. 0/false) count as populated
}

// --- Value-coverage scoring --------------------------------------------------
// Source-relative score of extraction + mapping quality, spec-free, no AI:
//   score = distinct meaningful SAMPLE values that survive into the OUTPUT
//           ÷ distinct meaningful sample values
// - A value in _raw that is never extracted → not in output → LOST (penalized).
// - A value extracted but dropped/emptied in mapping → not in output → LOST.
// - A value NOT in the sample can't be in the denominator → 100% still reachable.
// - Added/enrichment/transformed fields (_time, severity, class_uid, protocol
//   decode, …) are OUTPUT-only, never sample values, so they neither help nor
//   hurt — they remain in the output untouched.
// This matches "did we correctly extract and map everything the sample carried?"

export interface ValueCoverageResult {
  supported: boolean;
  score: number;                 // 0..100
  band: 'good' | 'warn' | 'fail';
  totalValues: number;           // distinct meaningful sample values (denominator)
  coveredValues: number;         // how many reached the output
  lostValues: string[];          // sample values that did NOT reach output (extract/map gaps)
  // Tier D: the denominator is so small (< MIN_COVERAGE_VALUES) that a single
  // borderline miss swings the score 20-33 points. The number stays HONEST (a
  // sparse miss is a real dropped value), but this flag lets the UI/report label
  // the measurement low-confidence instead of reading a granular 67 as a hard
  // verdict. Never used to inflate a score — full coverage of a sparse source is
  // already 100.
  sparse?: boolean;
}

/** Field-attributed view of why value coverage is mid-range — for score-card UI. */
export interface CoverageGapDetail {
  /** Extracted fields whose values never reach the destination (mapping/keep dropped them). */
  notMapped: { field: string; value: string }[];
  /** Sample values that never landed in a named extraction field. */
  notExtracted: { value: string }[];
  /** Field names present after extraction but absent/empty after mapping. */
  droppedFields: string[];
}

// --- ONE shared raw-line classifier ----------------------------------------
// Every value-harvesting decision in the scorer routes through this. The logic
// used to be an inline sniff inside `collectSampleValues`, and it mis-read any
// syslog line carrying a priority prefix (`<134>Jan 15 08:23:41 host …`) as XML:
// the XML branch then found no element text and no attribute values and returned
// ZERO values. `scoreValueCoverage` saw an empty denominator, returned
// `supported:false, score:0`, and the extraction call site rendered that as a
// hard "0 — failed". It hit 59 of the 632 bundled samples — every PRI-prefixed
// source (Cisco ASA, all PAN variants, FortiGate, F5, Meraki, Zscaler, CEF/LEEF
// over syslog, ESXi/NSX, …) — and on MIXED samples it silently shrank the
// denominator to the non-PRI lines instead (cisco_asa_all: 10 values instead of
// 46), which distorts scores UPWARD and looks legitimate.
//
// Two rules make it right for any future source, not just those 59:
//  1. Strip the syslog priority envelope FIRST. `<134>` is transport metadata,
//     never data, and it must not get to decide the payload's format — a
//     syslog-wrapped JSON/CEF/kvp payload has to reach its own branch.
//  2. An XML element name can never begin with a digit (W3C Name production), so
//     `<134>` is not markup whereas `<Event xmlns='…'>` is.
// The kvp threshold is deliberately the SAME "≥2 pairs per line" rule
// `extractSampleKeys` uses, so structural detection has exactly one definition
// in this file. A line with a single stray `k=v` falls to the unstructured atom
// harvester, which still picks the value up.
export interface RawLineShape {
  /** CEF folds into 'kvp' — its extension IS key=value and is harvested the same way. */
  format: 'json' | 'xml' | 'kvp' | 'unstructured';
  /** Payload with outer quotes and any syslog priority prefix removed. */
  body: string;
}

// ONE key=value pattern, shared by the classifier and the value harvester so
// "is this kvp?" and "which values does it hold?" can never disagree. `|` is a
// key boundary because a CEF extension's first pair follows the header pipe.
const KV_PAIR_RE = /(?:^|[\s,|])([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|[^\s,]+)/g;

export function classifyRawLine(line: string): RawLineShape {
  // Outer quotes (Zscaler NSS KV, some forwarders) then the RFC3164/RFC5424
  // priority prefix. `<134>` / `<13>1 2024-…` — both are envelope, not payload.
  let body = stripOuterQuotes(String(line ?? '').trim()).replace(/^<\d{1,3}>/, '').trim();
  // RFC5424 version digit that follows the PRI (`<13>1 <timestamp> …`).
  body = body.replace(/^1\s+(?=\d{4}-\d{2}-\d{2}T)/, '');
  if (!body) return { format: 'unstructured', body };
  if ((body.startsWith('{') && body.endsWith('}')) || (body.startsWith('[') && body.endsWith(']'))) {
    try { JSON.parse(body); return { format: 'json', body }; } catch { /* not JSON after all */ }
  }
  // Real markup only: element names start with a letter or underscore.
  if (body.startsWith('<') && /^<\/?[A-Za-z_][\w.:-]*[\s>/]/.test(body)) return { format: 'xml', body };
  // CEF: the extension after the 7th `|` IS key=value. Its first pair follows a
  // `|` rather than whitespace, which is why `|` is part of the key boundary in
  // KV_PAIR_RE below — without it a one-pair extension fell to the atom harvester.
  if (/CEF:\d+\|/.test(body)) return { format: 'kvp', body };
  let pairs = 0;
  KV_PAIR_RE.lastIndex = 0;
  while (KV_PAIR_RE.exec(body) !== null) pairs++;
  if (pairs >= 2) return { format: 'kvp', body };
  return { format: 'unstructured', body };
}

// Pull distinct "meaningful" scalar values out of raw sample events. We take
// values from key=value pairs, JSON leaves, and quoted/space-delimited tokens.
// Noise (tiny tokens, pure punctuation, common stopwords) is dropped so the
// denominator is real signal (IPs, ports, users, hosts, ids, actions, …).
// SAP Security Audit Log (SAL) files are length-prefixed TLV with no
// whitespace, so the token harvester below sees one giant blob per record
// (trailer hash glued to the next header) that no field can ever hold — a
// correct decoder scored ~3. Decode the records the same way the sap_audit_tlv
// parser does and return the field values a parser is expected to extract.
// Header metadata and the integrity hash are not data, so they never count.
// Null when the text is not SAL.
const SAL_RECORD_MARK = /\d{4}[A-Z]{2}[A-Z0-9](?:19|20)\d{12}/g;
export function decodeSapSalValues(text: string): string[] | null {
  const starts: number[] = [];
  SAL_RECORD_MARK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SAL_RECORD_MARK.exec(text)) !== null) starts.push(m.index);
  if (!starts.length) return null;
  starts.push(text.length);
  const values: string[] = [];
  let decoded = 0;
  for (let i = 0; i < starts.length - 1; i++) {
    const rec = text.slice(starts[i], starts[i + 1]);
    const headerLen = parseInt(rec.slice(0, 4), 10);
    if (!(headerLen > 0)) continue;
    const fields: string[] = [];
    let p = 4 + headerLen;
    while (p + 4 <= rec.length && fields.length < 7) {
      const ls = rec.slice(p, p + 4);
      if (!/^\d{4}$/.test(ls)) break;
      const len = parseInt(ls, 10);
      if (p + 4 + len > rec.length) break;
      fields.push(rec.slice(p + 4, p + 4 + len));
      p += 4 + len;
    }
    if (fields.length < 3) continue;
    decoded++;
    values.push(rec.slice(4, 7), ...fields.filter(Boolean));
  }
  return decoded ? values : null;
}

const ISO_DATETIME_RE = /\b\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?/g;
const CLOCK_TIME_RE = /(?<![\w:])\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?(?!\d)/g;

function collectSampleValues(rawEvents: string[]): Set<string> {
  const values = new Set<string>();
  const NOISE = new Set(['true', 'false', 'null', 'undefined', 'the', 'and', 'for', 'was', 'this', 'that', 'with']);
  const add = (v: any) => {
    if (v == null) return;
    if (typeof v === 'object') { for (const x of Array.isArray(v) ? v : Object.values(v)) add(x); return; }
    let s = String(v).trim();
    if (!s) return;
    // Strip surrounding quotes.
    s = s.replace(/^["']+|["']+$/g, '');
    // Skip noise: too short, pure number < 2 digits, punctuation-only, stopwords.
    if (s.length < 3) return;
    if (NOISE.has(s.toLowerCase())) return;
    if (/^[^A-Za-z0-9]+$/.test(s)) return;
    // A bare small integer (0,1,2 — flags/enums) is low-signal; skip 1-2 char nums.
    if (/^\d{1,2}$/.test(s)) return;
    values.add(s.toLowerCase());
  };
  // Pull the meaningful ATOMS out of a token — a parser extracts the IP, port,
  // user, code etc. from a compound syslog fragment like
  // "outside:10.1.1.1/53723(LOCAL\user)", not the fragment verbatim. So we
  // decompose on structural punctuation and add each atom, plus recognized
  // patterns (IPv4[:port], IPv6, email, GUID, MAC, host.domain) as whole units.
  const addAtoms = (tokRaw: string) => {
    let tok = String(tokRaw).replace(/^["'[(]+|["'\])]+$/g, '');
    if (!tok) return;
    // A datetime is ONE value, transformed to an epoch by every parser. Split on
    // `:` it became `2026-10-09t00` + `22.481z` — fragments isTransformedValue
    // cannot recognise, so a correct time transform read as lost values (33 of 183
    // packtester packs, 2026-10-09). Add the whole ISO value (the denominator
    // filter drops it) and blank clock times before any atom/fqdn pattern runs —
    // the fqdn pattern would otherwise claim `22.481z`.
    for (const mm of tok.match(ISO_DATETIME_RE) || []) add(mm);
    tok = tok.replace(ISO_DATETIME_RE, ' ').replace(CLOCK_TIME_RE, ' ').trim();
    if (!tok) return;
    // Whole-unit patterns worth crediting exactly.
    for (const rx of [
      /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,                         // IPv4
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // GUID
      /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi,                 // MAC
      /\b[\w.+-]+@[\w.-]+\.\w+\b/g,                           // email
      /\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/gi,                 // host.domain / fqdn
    ]) { for (const mm of tok.match(rx) || []) add(mm); }
    // Then split on structural punctuation and add remaining atoms — but ONLY
    // ones that LOOK like values, not English prose. Unstructured syslog is full
    // of words ("Teardown", "connection", "Outside", "Apr") that are not data to
    // map — counting them tanks the denominator. A value-shaped atom has a digit,
    // mixed case/underscore, or is long+identifier-like; a plain lowercase/Titlecase
    // dictionary word is dropped.
    const looksLikeValue = (a: string) =>
      /\d/.test(a) ||                     // has a digit (ids, ports, codes, hashes)
      /[_\-.]/.test(a) ||                 // structured identifier
      /[A-Z].*[A-Z]/.test(a) ||           // multiple caps (ACRONYM, CamelCase id)
      /[\\/@]/.test(a) ||                 // path/user/email-ish
      a.length >= 12;                     // long token ~ id, unlikely a word
    for (const atom of tok.split(/[\s:/()\\[\],=|"']+/)) {
      if (atom && /[A-Za-z0-9]/.test(atom) && !/^0x[0-9a-f]+$/i.test(atom) && looksLikeValue(atom)) add(atom);
    }
  };
  for (const raw of rawEvents.slice(0, 8)) {
    // Some sample files store an already-parsed `_raw` OBJECT (Windows XML
    // pre-parsed by an Edge pack). Stringifying that yields "[object Object]" and
    // the line contributes nothing — walk it as a structure instead.
    if (raw && typeof raw === 'object') { add(raw); continue; }
    // Format decided in ONE place (classifyRawLine) — envelope already stripped.
    const { format, body: t } = classifyRawLine(raw);
    if (!t) continue;
    // INVARIANT: no branch may leave a non-empty line contributing ZERO values.
    // A branch that claims a line and then harvests nothing is how the denominator
    // silently collapses — the original bug (XML branch on a syslog PRI), and also
    // e.g. `<134>… phy_nlp_enable_set: u=0 p=1 enable:1` which has exactly two
    // trivial kv pairs, so the kvp branch claimed it and both values were dropped
    // as small-integer noise. Every branch now falls through to the atom harvester
    // when it comes up empty, so a mis-classification can degrade coverage but can
    // never zero it.
    const before = values.size;
    const sal = decodeSapSalValues(t);
    if (sal) { sal.forEach(add); if (values.size > before) continue; }
    if (format === 'json') {
      // JSON object → walk leaves (values pass through verbatim).
      try { const o = JSON.parse(t); for (const v of (Array.isArray(o) ? o : Object.values(o))) add(v); } catch { /* fall through to atoms */ }
    } else if (format === 'xml') {
      // XML (Windows events, etc.): the DATA is in element text (>value<) and
      // attribute values (Name='value'), NOT the tag/namespace names. Extracting
      // markup tokens would flood the denominator with schema noise, so pull only
      // text content + attribute values.
      for (const mm of t.match(/>([^<>]+)</g) || []) add(mm.slice(1, -1));                    // element text
      // `<Data Name='SubjectUserSid'>` names the FIELD (a key), its text is the
      // value — counting the name penalised every Windows XML pack for keys.
      const attrs = t.replace(/(<Data\s+Name\s*=\s*)(['"])[^'"]*\2/gi, '$1$2$2');
      for (const mm of attrs.match(/=\s*'([^']*)'|=\s*"([^"]*)"/g) || []) add(mm.replace(/^=\s*['"]|['"]$/g, '')); // attr values
    } else if (format === 'kvp') {
      // key=value pairs (kvp / CEF extension / structured syslog).
      let m: RegExpExecArray | null;
      KV_PAIR_RE.lastIndex = 0;
      while ((m = KV_PAIR_RE.exec(t)) !== null) add(m[2]);
    }
    if (format === 'unstructured' || values.size === before) {
      // Unstructured/syslog, or a structured branch that harvested nothing:
      // decompose every token into meaningful atoms.
      for (const tok of t.split(/\s+/)) addAtoms(tok);
    }
  }
  return values;
}

// Flatten an output event's populated scalar values into a lowercase string set
// for membership testing (so we can ask "did sample value X reach the output?").
function collectOutputValues(events: any[], ignoreRaw = false, limit = 8): Set<string> {
  const out = new Set<string>();
  const walk = (v: any) => {
    if (v == null) return;
    if (typeof v === 'object') { for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x); return; }
    const s = String(v).trim().toLowerCase();
    if (s) out.add(s);
  };
  for (const e of events.slice(0, limit)) {
    // raw_data (OCSF "keep original _raw") and its in-flight copy carry the
    // untransformed source event — indexing them would count every sample value
    // as "reached the output" and inflate the score, so they never count.
    const { _raw, raw_data: _rawData, pg_original_raw_copy: _rawCopy, ...rest } = e || {};
    walk(rest);
    // Also index _raw for CEF/JSON-rebuilt outputs where the mapped values live
    // in the serialized string. But for EXTRACTION scoring (ignoreRaw), _raw is
    // the UNTRANSFORMED input — indexing it makes a pipeline that extracts
    // NOTHING still score high (every value is trivially "found" in _raw). So
    // when scoring extraction, only values that landed in real fields count.
    if (!ignoreRaw && typeof _raw === 'string') {
      for (const tok of _raw.toLowerCase().split(/[^A-Za-z0-9._:@/-]+/)) if (tok.length >= 3) out.add(tok);
      // CEF extension values can contain SPACES (msg=…, cs1=Connected Apps),
      // which the token split above shreds — so a whole-phrase sample value
      // ("connected apps") would never match despite being present in the
      // output. Parse the CEF extension as key=value where each value runs to
      // the next ` key=` boundary, and index the FULL value. Additive only: it
      // can raise coverage for a value that truly reached _raw, never inflate a
      // value that didn't.
      if (/CEF:\d+\|/.test(_raw)) {
        const ext = _raw.split('|').slice(7).join('|');
        for (const m of ext.matchAll(/([A-Za-z][\w]*)=(.*?)(?=(?:\s+[A-Za-z][\w]*=)|$)/g)) {
          const v = String(m[2]).trim().toLowerCase();
          if (v) out.add(v);
        }
      }
    }
  }
  return out;
}

// A sample value "reached" the output if it appears verbatim, or as a numeric
// equivalent (port "443" → 443), or as a substring of a compound output value
// (a URL/path fragment). Timestamps handled by the caller (excluded) so a valid
// epoch transform isn't flagged as a lost raw datetime string.
function valueReached(val: string, outputValues: Set<string>): boolean {
  if (outputValues.has(val)) return true;
  // numeric normalization: "443" vs 443, "0.0" trimming
  const n = Number(val);
  if (Number.isFinite(n) && outputValues.has(String(n))) return true;
  // substring: the value is embedded in a larger output token (e.g. an IP inside
  // a CEF _raw, or a path segment). Only for reasonably specific values.
  if (val.length >= 5) { for (const o of outputValues) { if (o.includes(val)) return true; } }
  // Reverse substring: the SAMPLE value is a compound whose meaningful core was
  // extracted into a field, so the output holds the shorter core. Cisco
  // "%FTD-6-302016" → ftd_code 302016; "outside:10.1.1.1/53723" → src_ip. Credit
  // when a specific-enough output value (≥5 chars, not just a stray digit) is a
  // substring of the sample value. Without this the vendor framing (%FTD-6-)
  // that the parser correctly strips reads as a lost value.
  for (const o of outputValues) { if (o.length >= 5 && val.includes(o)) return true; }
  return false;
}

// Values that are typically TRANSFORMED (not passed verbatim) — a datetime
// becomes an epoch, so its raw string legitimately won't appear in output. We
// drop such values from the denominator rather than count them as lost.
function isTransformedValue(val: string): boolean {
  // ISO-ish datetime, or a syslog date like "Nov 26 00:50:35".
  if (/\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}/.test(val)) return true;
  if (/^[a-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/.test(val)) return true;
  // long fractional/epoch timestamps (already numeric, may be reformatted)
  if (/^\d{10}(\.\d+)?$/.test(val) || /^\d{13}$/.test(val)) return true;
  // A bare 4-digit year (1990–2099) is a datetime fragment — the surrounding
  // date was parsed to an epoch (_time/log_time), so the lone year legitimately
  // won't survive verbatim. Counting it as a lost value penalizes a correct
  // timestamp transform (Cisco "Apr 17 2020 14:08:08" → epoch).
  if (/^(?:19|20)\d{2}$/.test(val)) return true;
  // A bare ISO date is the same kind of fragment (`2026-10-09 14:08:08` splits
  // on whitespace before the clock time is blanked).
  if (/^(?:19|20)\d{2}-\d{2}-\d{2}$/.test(val)) return true;
  return false;
}

/**
 * Mapping score for a Sentinel NATIVE TABLE destination (AWSVPCFlow, SigninLogs,
 * CommonSecurityLog, …).
 *
 * These tables have no golden spec and no canonical-model spec, so both mapping
 * lenses returned `supported: false` — the stage came back unmeasurable, which the
 * 3-stage builder then reported as a hard 0 and which meant a Sentinel pack could
 * never store a mapping golden however good it was.
 *
 * The table itself is the spec: we know its exact columns. So PROJECT the output
 * onto the table's columns and measure value coverage through that projection. A
 * source value only counts if it landed in a column the DCR will actually accept —
 * values sitting in leftover vendor intermediates earn nothing.
 *
 * The denominator stays the sample's own meaningful values (never the fields we
 * chose to populate), so this cannot self-select its way to 100.
 */
export function scoreSentinelTableCoverage(
  destFormat: string,
  outputEvents: any[],
  rawEvents: string[],
): (ValueCoverageResult & { table: string; columnsPopulated: number }) | null {
  const target = resolveSentinelTable(destFormat);
  if (!target) return null;
  const columns = new Set(target.table.columns.map(c => c.name));
  const populated = new Set<string>();
  // Keep event count identical — an event that filled no column projects to {},
  // which correctly scores as "carried nothing", not as "not measurable".
  const projected = (outputEvents || []).map(e => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e || {})) {
      if (!columns.has(k)) continue;
      if (v === '' || v === null || v === undefined) continue;
      out[k] = v;
      populated.add(k);
    }
    return out;
  });
  const r = scoreValueCoverage(rawEvents, projected, true);
  return { ...r, table: target.name, columnsPopulated: populated.size };
}

// Tier D: below this many distinct meaningful sample values, value coverage is a
// LOW-CONFIDENCE measurement — one miss on a 3-value sample is a 33-point swing.
// Mirrors MIN_SPEC_CHECKS (the spec lens's own denominator floor). The score is
// still reported honestly; this only sets the `sparse` flag for the report/UI.
export const MIN_COVERAGE_VALUES = 4;

/**
 * The value-coverage DENOMINATOR of a sample on its own — the distinct
 * meaningful values its first 8 events carry, exactly as `scoreValueCoverage`
 * counts them. Golden evidence (src/golden-evidence.ts) records it whatever lens
 * scored the pipeline, because it answers a lens-independent question: how much
 * did this sample give the score to be wrong about?
 */
export function sampleValueDenominator(rawEvents: string[]): number {
  const all = new Set<string>();
  for (const ev of (rawEvents || []).slice(0, 8)) {
    for (const v of collectSampleValues([ev])) if (!isTransformedValue(v)) all.add(v);
  }
  return all.size;
}

export function scoreValueCoverage(rawEvents: string[], outputEvents: any[], ignoreRaw = false): ValueCoverageResult {
  const fail = { supported: false, score: 0, band: 'fail' as const, totalValues: 0, coveredValues: 0, lostValues: [], sparse: false };
  if (!rawEvents?.length || !outputEvents?.length) return fail;

  // Cap denominator to "covered-elsewhere": a value only counts as LOST if it
  // reaches NO output event in the sample. Different event types in one sample
  // map to different fields, so a value that IS carried for its own event type
  // (matched via the pooled output set) is never penalized. We also score each
  // raw event against the POOLED output values (union of all output events) so a
  // teardown event's connection-id isn't marked lost just because the ACL event
  // next to it has no such field.
  // ignoreRaw: exclude _raw from the output value set — used for EXTRACTION
  // scoring so a pipeline that extracted nothing (raw passthrough) doesn't score
  // high just because the values still sit in the untransformed _raw.
  // The denominator reads the first 8 sample events. A source that unrolls one
  // event into many (a SAL file → one event per record) spreads those 8 over
  // more output events, so index as many as the fan-out needs to cover them.
  const fanout = Math.max(1, outputEvents.length / rawEvents.length);
  const pooledOutput = collectOutputValues(outputEvents, ignoreRaw, Math.min(2000, Math.ceil(8 * fanout)));

  // Per-event denominator to avoid one huge event dominating; union the values.
  const allValues = new Set<string>();
  const perEventValues = rawEvents.slice(0, 8).map(ev => {
    const vs = [...collectSampleValues([ev])].filter(v => !isTransformedValue(v));
    vs.forEach(v => allValues.add(v));
    return vs;
  });
  const sampleValues = [...allValues];
  if (sampleValues.length === 0) return fail;   // nothing measurable → caller falls back

  const lost: string[] = [];
  let covered = 0;
  for (const v of sampleValues) {
    if (valueReached(v, pooledOutput)) covered++;   // covered-elsewhere: any output event
    else lost.push(v);
  }
  void perEventValues;   // reserved for future per-event weighting
  const score = Math.round((covered / sampleValues.length) * 100);
  return {
    supported: true,
    score,
    band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail',
    totalValues: sampleValues.length,
    coveredValues: covered,
    lostValues: lost.slice(0, 30),
    // Honest score, low-confidence flag on a tiny denominator (Tier D).
    sparse: sampleValues.length < MIN_COVERAGE_VALUES,
  };
}

// OCSF value carry (packtester audit 2026-10-02). The schema oracle grades the
// SHAPE of an OCSF event; it cannot see that half the source's values never
// reached it. Carry measures that: of the sample values EXTRACTION delivered
// (mapping cannot invent the rest), how many landed in a typed OCSF attribute of
// the event's class (credit 1) vs only in `unmapped` (credit 0.25 — preserved but
// not normalized) vs nowhere (0). raw_data / routing fields never count.
export const OCSF_UNMAPPED_CREDIT = 0.25;
const OCSF_CARRY_NON_ATTR = new Set(['_raw', '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe',
  'unmapped', 'raw_data', 'pg_original_raw_copy']);

export interface OcsfCarryResult {
  supported: boolean;
  score: number;
  totalValues: number;      // sample values extraction delivered
  typedValues: number;      // reached a typed OCSF attribute
  unmappedValues: number;   // only in `unmapped`
  lostValues: string[];     // extracted but in neither
}

/** `extractedEvents` null = no extraction-stage preview (whole-pipeline score): every sample value counts. */
export function scoreOcsfMappingCarry(rawEvents: string[], extractedEvents: any[] | null, outputEvents: any[], destFormat: string): OcsfCarryResult {
  const na: OcsfCarryResult = { supported: false, score: 0, totalValues: 0, typedValues: 0, unmappedValues: 0, lostValues: [] };
  if (!rawEvents?.length || !outputEvents?.length || (extractedEvents && !extractedEvents.length)) return na;
  const fanout = Math.max(1, outputEvents.length / rawEvents.length);
  const limit = Math.min(2000, Math.ceil(8 * fanout));
  const extracted = extractedEvents
    ? collectOutputValues(extractedEvents, true, Math.min(2000, Math.ceil(8 * Math.max(1, extractedEvents.length / rawEvents.length))))
    : null;
  const hint = ocsfClassNameForKey(destFormat);
  const typedEvents: any[] = [], unmappedEvents: any[] = [];
  for (const e of outputEvents.slice(0, limit)) {
    if (!e || typeof e !== 'object') continue;
    const cls = (e.class_uid != null && ocsfClassByUid(Number(e.class_uid))) || hint;
    const types = cls ? ocsfAttributeTypes([cls]) : {};
    const typed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (OCSF_CARRY_NON_ATTR.has(k) || k.startsWith('__') || !(k in types)) continue;
      typed[k] = v;
    }
    typedEvents.push(typed);
    if (e.unmapped != null) unmappedEvents.push({ unmapped: e.unmapped });
  }
  const typedPool = collectOutputValues(typedEvents, true, limit);
  const unmappedPool = collectOutputValues(unmappedEvents, true, limit);
  const all = new Set<string>();
  for (const ev of rawEvents.slice(0, 8)) for (const v of collectSampleValues([ev])) if (!isTransformedValue(v)) all.add(v);
  const denom = extracted ? [...all].filter(v => valueReached(v, extracted)) : [...all];
  if (!denom.length) return na;
  let typedN = 0, unmappedN = 0;
  const lost: string[] = [];
  for (const v of denom) {
    if (valueReached(v, typedPool)) typedN++;
    else if (valueReached(v, unmappedPool)) unmappedN++;
    else lost.push(v);
  }
  const score = Math.round(100 * (typedN + OCSF_UNMAPPED_CREDIT * unmappedN) / denom.length);
  return { supported: true, score, totalValues: denom.length, typedValues: typedN, unmappedValues: unmappedN, lostValues: lost.slice(0, 30) };
}

function collectNamedFieldValues(events: any[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of (events || []).slice(0, 8)) {
    for (const [k, v] of Object.entries(e || {})) {
      if (k === '_raw' || k === '_time' || k.startsWith('__') || k.startsWith('cribl_')) continue;
      if (v == null || v === '') continue;
      if (typeof v === 'object') continue;
      const s = String(v).trim().toLowerCase();
      if (s.length < 2) continue;
      const arr = map.get(k) || [];
      if (!arr.includes(s)) arr.push(s);
      map.set(k, arr);
    }
  }
  return map;
}

/**
 * Attribute lost sample values to fields so the UI can say
 * "serial_number=0128… was extracted but CIM dropped it" instead of a raw token dump.
 * `extractedEvents` = preview after the extraction stage only; `finalEvents` = full pipeline out.
 */
export function explainValueCoverageGaps(
  rawEvents: string[],
  extractedEvents: any[] | null | undefined,
  finalEvents: any[],
): CoverageGapDetail {
  const empty: CoverageGapDetail = { notMapped: [], notExtracted: [], droppedFields: [] };
  if (!rawEvents?.length || !finalEvents?.length) return empty;

  const finalValues = collectOutputValues(finalEvents, false);
  const extracted = collectNamedFieldValues(extractedEvents || []);
  const extractedValueSet = new Set<string>();
  for (const vals of extracted.values()) for (const v of vals) extractedValueSet.add(v);

  const notMapped: { field: string; value: string }[] = [];
  const droppedFields: string[] = [];
  for (const [field, vals] of extracted) {
    const anyValueInFinal = vals.some(v => valueReached(v, finalValues));
    const fieldPresentOnFinal = (finalEvents || []).some(e => {
      const fv = (e || {})[field];
      return fv != null && fv !== '';
    });
    if (!anyValueInFinal && !fieldPresentOnFinal) {
      droppedFields.push(field);
      // One example value per dropped field (the clearest UI signal).
      if (vals[0]) notMapped.push({ field, value: vals[0] });
    } else {
      for (const v of vals) {
        if (!valueReached(v, finalValues)) notMapped.push({ field, value: v });
      }
    }
  }

  const sampleValues = [...collectSampleValues(rawEvents)];
  const notExtracted: { value: string }[] = [];
  for (const v of sampleValues) {
    if (valueReached(v, finalValues)) continue;
    let inExtracted = false;
    for (const ev of extractedValueSet) {
      if (valueReached(v, new Set([ev]))) { inExtracted = true; break; }
      if (v.length >= 5 && ev.includes(v)) { inExtracted = true; break; }
      if (ev.length >= 5 && v.includes(ev)) { inExtracted = true; break; }
    }
    if (!inExtracted) notExtracted.push({ value: v });
  }

  return {
    notMapped: notMapped.slice(0, 40),
    notExtracted: notExtracted.slice(0, 20),
    droppedFields: droppedFields.slice(0, 40),
  };
}

/**
 * Display-only projection of a mapped event: hydrate CIM/JSON `_raw`, then keep
 * destination-schema fields (+ Splunk metadata). Drop leftover vendor extract
 * fields so the "After mapping" panel shows the destination model, not a dump.
 */
export function shapeMappedEventForDisplay(
  destFormat: string,
  event: any,
  sourcetype?: string,
  sampleEvents?: string,
): any {
  if (!event || typeof event !== 'object') return event;
  let e: any = event;
  if (typeof e._raw === 'string' && e._raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(e._raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Parsed schema fields win over a nested _raw string still sitting on e.
        const { _raw: _ignored, ...top } = e;
        e = { ...parsed, ...top };
        delete e._raw;
      }
    } catch { /* keep as-is */ }
  }

  const META = ['_time', 'index', 'source', 'sourcetype', 'host'];
  const spec = resolveGoldenFormat(destFormat, sourcetype, sampleEvents);
  if (!spec?.canonicalMap?.length) {
    // No schema — still strip raw/payload noise like extraction display.
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(e)) {
      if (k === '_raw' || k.startsWith('__') || k.startsWith('cribl')) continue;
      if (/csv_payload$/i.test(k) || /__payload$/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  const out: Record<string, any> = {};
  for (const m of META) {
    if (e[m] != null && e[m] !== '') out[m] = e[m];
  }
  let filled = 0;
  for (const m of spec.canonicalMap) {
    if (!m?.dest || m.literalNumber || isQuotedLiteralExpr(String(m.expr ?? ''))) continue;
    const v = readPath(e, m.dest);
    if (!isPopulated(v)) continue;
    filled++;
    if (m.dest.includes('.')) {
      const parts = m.dest.split('.');
      let cur = out;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = v;
    } else {
      out[m.dest] = v;
    }
  }
  // If mapping produced nothing in the schema, fall back to a cleaned full event
  // so the panel isn't blank — the score reason already explains the failure.
  if (filled === 0) {
    const fallback: Record<string, any> = { ...out };
    for (const [k, v] of Object.entries(e)) {
      if (k === '_raw' || k.startsWith('__') || k.startsWith('cribl')) continue;
      if (/csv_payload$/i.test(k) || /__payload$/i.test(k)) continue;
      if (k.includes('__') && !META.includes(k)) continue; // drop Copilot leftovers when schema empty
      if (fallback[k] === undefined) fallback[k] = v;
    }
    return fallback;
  }
  return out;
}

/**
 * Mapping score for flat schemas (CIM/ECS/…): of the VALUES extraction produced,
 * how many reached the DESTINATION SCHEMA fields?
 *
 * Why not full-event value coverage? Mapping candidates often still carry every
 * extracted vendor field at the top level (the CIM keep/serialize lives in the
 * optimization stage). Scoring the whole event would give mapping ~100 whenever
 * extraction worked, even when `src`/`dest`/ports are empty. Project onto the
 * golden format's dest fields only, so empty CIM slots actually cost points.
 */
export interface SchemaMappingScore extends ValueCoverageResult {
  schemaFields: string[];
  populatedFields: string[];
  emptyFields: string[];
}

export function scoreSchemaMappingFromExtraction(
  destFormat: string,
  extractedEvents: any[],
  mappedEvents: any[],
  sourcetype?: string,
  sampleEvents?: string,
): SchemaMappingScore {
  const fail: SchemaMappingScore = {
    supported: false, score: 0, band: 'fail',
    totalValues: 0, coveredValues: 0, lostValues: [],
    schemaFields: [], populatedFields: [], emptyFields: [],
  };
  const spec = resolveGoldenFormat(destFormat, sourcetype, sampleEvents);
  if (!spec?.canonicalMap?.length || !mappedEvents?.length) return fail;

  const destFields: string[] = [];
  for (const m of spec.canonicalMap) {
    if (!m?.dest || m.literalNumber || isQuotedLiteralExpr(String(m.expr ?? ''))) continue;
    if (!destFields.includes(m.dest)) destFields.push(m.dest);
  }
  if (destFields.length < MIN_SPEC_CHECKS) return fail;

  const populatedFields = destFields.filter(d => mappedEvents.some(e => isPopulated(readPath(e, d))));
  const emptyFields = destFields.filter(d => !populatedFields.includes(d));

  // Project onto schema dests only (flatten dotted paths so VC can walk leaves).
  const projected = mappedEvents.map(e => {
    const o: Record<string, any> = {};
    for (const d of destFields) {
      const v = readPath(e, d);
      if (isPopulated(v)) o[d.replace(/\./g, '__')] = v;
    }
    return o;
  });

  // Extraction can legitimately preserve source hierarchy (JSON protoPayload,
  // resource.labels, arrays). Flat destination mappings read scalar leaves from
  // those objects, so skipping every object here makes a working map look empty
  // (GCP Audit → CIM Change scored 3 while filling 20 fields). Walk leaves only:
  // container names/JSON strings add no credit and cannot inflate the score.
  const addScalars = (value: unknown, parts: string[]): void => {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      for (const item of value) addScalars(item, parts);
      return;
    }
    if (typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) addScalars(child, parts);
      return;
    }
    parts.push(String(value));
  };
  const extractedLines = (extractedEvents || []).map(e => {
    const parts: string[] = [];
    for (const [k, val] of Object.entries(e || {})) {
      if (k === '_raw' || k === '_time' || k.startsWith('__') || k.startsWith('cribl_')) continue;
      addScalars(val, parts);
    }
    return parts.join(' ');
  }).filter(Boolean);
  if (!extractedLines.length) return { ...fail, schemaFields: destFields, populatedFields, emptyFields };

  const r = scoreValueCoverage(extractedLines, projected, true);
  return { ...r, schemaFields: destFields, populatedFields, emptyFields };
}

// Golden-destination score = "of what this format CAN hold, how much did we
// populate?" We count the spec's canonicalMap OUTPUT fields (e.g. OCSF
// src_endpoint.ip, dst_endpoint.port, connection_info.protocol_name — the fields
// the class defines) that are actually populated in the live output. This is the
// fair measure for narrow schemas like OCSF: a field-rich source (PAN CSV, 70
// raw values) shouldn't score low just because OCSF Network Activity has no slot
// for interface/vsys/app — it should score on the OCSF fields it DID fill.
// Denominator excludes pure-literal enrichment (class_uid=4001 etc., always set)
// and fields NO event populated AND whose source clearly isn't present — but to
// stay simple and source-relative we count a dest as "expected" only if at least
// one sampled event populated it OR another event of the same shape did. Concretely:
// expected = dests populated in ≥1 event; score = populated-in-any ÷ expected is
// trivially 100, so instead we score populated ÷ (non-literal canonicalMap dests
// that ANY event carries a plausible source for) — approximated as: a dest counts
// toward the denominator if it's populated in ≥1 event (real) OR it's a "core"
// field the format always expects when the data class matches. We keep it robust
// and un-gameable by scoring: populated distinct dests ÷ total non-literal dests,
// then not penalizing dests the source can't supply via the value-coverage cross-check.
export interface GoldenCoverageResult {
  supported: boolean;
  score: number;
  band: 'good' | 'warn' | 'fail';
  populated: number;
  expected: number;
  missing: string[];
}
export function scoreGoldenSpecCoverage(destFormat: string, outputEvents: any[], sourcetype?: string, sampleEvents?: string, sourceFieldNames?: string[]): GoldenCoverageResult {
  const none = { supported: false, score: 0, band: 'fail' as const, populated: 0, expected: 0, missing: [] };
  const spec = resolveGoldenFormat(destFormat, sourcetype, sampleEvents);
  if (!spec || !Array.isArray((spec as any).canonicalMap) || (spec as any).canonicalMap.length === 0) return none;
  if (!outputEvents?.length) return none;
  const evs = outputEvents.slice(0, 8);
  // Non-literal output dest fields the format defines (skip pure enrichment
  // literals like class_uid/category_uid/type_uid that are always set and would
  // inflate the score).
  const LITERAL = new Set(['class_uid', 'category_uid', 'type_uid', 'activity_id', 'severity_id', 'status_id', 'time', 'metadata.version']);
  const scorable: { dest: string; expr: string }[] = (spec as any).canonicalMap
    .filter((m: any) => !m.literalNumber && m.dest && !LITERAL.has(m.dest))
    .map((m: any) => ({ dest: m.dest, expr: String(m.expr ?? '') }));
  const dests: string[] = scorable.map(m => m.dest);
  const uniqueDests = [...new Set(dests)];
  if (uniqueDests.length === 0) return none;
  // Only applies to NESTED (OCSF-style) specs. For flat specs (CIM/ECS) the
  // canonicalMap lists dozens of fields most sources don't carry, and flat
  // fields have no "parent object present" signal to gate scope — value coverage
  // is the fair measure there. Require a meaningful share of dotted dests.
  const nestedShare = uniqueDests.filter(d => d.includes('.')).length / uniqueDests.length;
  if (nestedShare < 0.5) return none;

  // A dest is EXPECTED if any sampled event populates it (the source supplied it),
  // else it's treated as source-absent and excluded (source-relative — a field
  // OCSF defines but this source never carries must not lower the score).
  const populated: string[] = [];
  for (const dest of uniqueDests) {
    const anyPop = evs.some(e => isPopulated(readPath(e, dest)));
    if (anyPop) populated.push(dest);
  }
  // Denominator. The ONLY honest question is "of the schema fields THIS SOURCE
  // can actually fill, how many did the mapping fill?" — so the denominator comes
  // from the SOURCE's real field names (`sourceFieldNames`, what the parse stage
  // actually produced) and NEVER from the output. Fill 3 of 3 available → 100;
  // fill 3 of 20 available → 15. Un-gameable: emitting fewer fields lowers it.
  //
  // MEASURED BUG (build 463) — the denominator used to be
  // `populated ∪ inScope`, and that union alone re-opened the hole the
  // `sourceFieldNames` argument was added to close: every dest the mapping filled
  // counted as a dest it was EXPECTED to fill, so `expected === populated` and the
  // ratio was 100 by construction whenever nothing was source-fillable. Verified
  // against the real OCSF spec with an f5_bigip-shaped output (only constant /
  // enrichment dests populated): 100 with no field list, 100 with an EMPTY list,
  // and 100 with a list that can fill nothing. Live consequence: five build-435
  // f5_bigip pipelines reported mapping 90-100 and deployment 90-100 while
  // extraction measured 0 — a pack that parses nothing, presented as deployable.
  //
  // So the denominator is now source-fillable dests ONLY, the numerator is
  // intersected with it (a constant-filled dest can no longer inflate either side),
  // and both degenerate cases report NOT MEASURABLE instead of a verdict:
  //   * no usable source field list → we cannot form a source-derived denominator.
  //     The old parent-object heuristic that stood in for it was self-referential,
  //     so there is nothing honest to fall back to. (`collectSampleKeys` returns an
  //     empty set for unstructured syslog — Rule 7 — which is exactly how f5_bigip
  //     and Cisco ASA reached this branch.)
  //   * fewer than MIN_SPEC_CHECKS fillable dests → the ratio can only land on a
  //     handful of values (1 of 1 = 100), which is a coin toss, not a measurement.
  // `supported: false` is not a 0: the caller falls through to value coverage,
  // which is the authoritative lens per Rule 12 anyway.
  const sourceSet = sourceFieldNames?.length ? buildSpecSourceSet(sourceFieldNames, sourcetype) : null;
  if (!sourceSet) return none;
  const sourceCanFill = (dest: string) =>
    scorable.some(m => m.dest === dest && !isQuotedLiteralExpr(m.expr) && specFieldHasSource(m.expr, sourceSet));
  const expectedDests = uniqueDests.filter(sourceCanFill);
  if (expectedDests.length < MIN_SPEC_CHECKS) return none;
  const filled = expectedDests.filter(d => populated.includes(d));
  const missing = expectedDests.filter(d => !populated.includes(d));
  const expected = expectedDests.length;
  const score = Math.round((filled.length / expected) * 100);
  return {
    supported: true,
    score,
    band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail',
    populated: filled.length,
    expected,
    missing: missing.slice(0, 20),
  };
}

/**
 * Did the extraction stage actually carry SOURCE DATA into named fields?
 *
 * The presence of named fields in the output is NOT evidence of this, and that
 * confusion is what let five f5_bigip pipelines ship at deployment 90-100 while
 * extracting nothing: a static parser emits a dozen constant/enrichment fields
 * (vendor, product, class_name, a `_time`) whether or not a single regex matched,
 * so a "did the output have fields?" test passes on a pipeline that read nothing
 * out of `_raw`. Value coverage is the measurement — field COUNT is not field
 * VALUES.
 *
 * `null` (not measurable) counts as "did not carry". We are not entitled to trust a
 * downstream 100 we cannot corroborate, and the whole-build golden gate already
 * treats an unmeasured extraction as a failure.
 */
export function extractionCarriedSourceData(extractionScore: number | null | undefined): boolean {
  return typeof extractionScore === 'number' && extractionScore > 0;
}

/**
 * A mapping score can never clear the golden bar on top of a dead extraction.
 *
 * With no extracted source values, every populated schema field was filled from a
 * constant, an enrichment literal or the pipeline's own clock — so the mapping
 * demonstrably carried no data, whatever ratio its lens computed. This is defence
 * in depth behind `scoreGoldenSpecCoverage`'s denominator fix: the flat and
 * Sentinel-table lenses compute their own ratios, and this rule holds for all of
 * them without per-lens logic.
 *
 * It caps rather than zeroes: the mapping FUNCTIONS may be perfectly correct and
 * merely starved by a broken parser, and reporting 0 would send repair rounds at
 * the wrong stage. `threshold - 1` keeps a usable number that can never be mistaken
 * for a pass or stored as a golden.
 */
export function capMappingScore(
  mappingScore: number | null | undefined,
  extractionScore: number | null | undefined,
  mappingThreshold: number,
): { score: number | null; capped: boolean; reason: string | null } {
  const score = typeof mappingScore === 'number' ? mappingScore : null;
  if (score === null) return { score: null, capped: false, reason: null };
  if (extractionCarriedSourceData(extractionScore)) return { score, capped: false, reason: null };
  if (score < mappingThreshold) return { score, capped: false, reason: null };
  const capped = Math.max(0, Math.min(score, mappingThreshold - 1));
  return {
    score: capped,
    capped: true,
    reason: `⚠ Capped from ${score}: extraction ${extractionScore == null ? 'could not be measured' : `pulled no source values out of _raw (score ${extractionScore})`}, so the mapping populates only constant schema-envelope values — no real data. Fix extraction first.`,
  };
}

// Did the source raw event carry the inputs this spec expr reads? Source-relative
// scoring hinges on this: a spec field whose source is absent is NOT a defect.
// For JSON sources the parse stage renames keys (eventName→api_operation); when
// a raw key is present, treat its canonical parser outputs as available too.
const RAW_CANONICAL_ALIASES: Record<string, Record<string, string[]>> = {
  aws_cloudtrail: {
    eventname: ['apioperation', 'eventcode'],
    eventsource: ['cloudservice', 'desthost'],
    sourceipaddress: ['srcip'],
    useragent: ['useragent'],
    eventtime: ['logtime'],
    useridentity: ['user', 'usertype', 'useruid', 'useraccount', 'userarn', 'srcuser', 'mfaused', 'credentialuid'],
    eventid: ['eventuid'],
    errorcode: ['errorcode', 'outcome'],
    errormessage: ['errormessage', 'outcome', 'reason'],
    readonly: ['isreadonly'],
    awsregion: ['cloudregion'],
    recipientaccountid: ['cloudaccount'],
    requestid: ['requestid'],
    requestparameters: ['objecttarget', 'resourcename'],
    responseelements: ['objecttarget', 'authaction'],
    resources: ['resourcename', 'resourcetype'],
  },
  // Linux auditd: the parser renames native KVP tokens (comm/exe/pid/ppid/uid/…)
  // into the canonical process model the endpoint golden specs read. Without
  // these aliases the source-relative scorer only recognizes the one raw key
  // (`user`) that survives verbatim, so every canonical spec field is skipped —
  // CIM/CEF then "check" a single field (fake 100 / fake 0). Map each native key
  // to the canonical field(s) it feeds so the scorer measures real coverage.
  linux_audit: {
    comm: ['process', 'processname', 'command'],
    exe: ['process', 'processname', 'command'],
    pid: ['processid'],
    ppid: ['parentprocessid'],
    uid: ['userid'],
    auid: ['audituserid'],
    ses: ['sessionid'],
    res: ['outcome', 'action'],
    success: ['outcome', 'action'],
    type: ['signature'],
    key: ['object', 'rulename'],
    msg: ['logtime', 'auditserial'],
  },
};

function squashFieldName(s: string): string {
  return s.toLowerCase().replace(/_/g, '');
}

function buildSpecSourceSet(rawSampleKeys: string[], sourcetype?: string): Set<string> {
  const rawSet = new Set(rawSampleKeys.map(squashFieldName));
  if (sourcetype) {
    const aliases = RAW_CANONICAL_ALIASES[canonicalizeSourcetype(sourcetype)];
    if (aliases) {
      for (const rawKey of rawSampleKeys) {
        for (const canon of aliases[squashFieldName(rawKey)] || []) rawSet.add(canon);
      }
    }
  }
  return rawSet;
}

function isQuotedLiteralExpr(expr: string): boolean {
  return /^'[^']*'$/.test(String(expr || '').trim());
}

function specFieldHasSource(expr: string, rawFieldSet: Set<string>): boolean {
  const refs = readFieldRefs(expr).filter(r => !JS_GLOBALS.has(r) && !JS_OPERATOR_KEYWORDS.has(r));
  if (refs.length === 0) return false; // string/number literals — not sample-gated
  return refs.some(r => rawFieldSet.has(squashFieldName(r)));
}

// A spec ratio needs enough checked fields to BE a measurement. Build 120 guarded
// `checked === 0` (an empty raw-key set faked an unconditional 100) but left every
// small non-zero denominator alone — and `populated/checked` with checked===1 is
// not a score, it's a coin flip: one unmapped field is 0, that same field mapped
// is 100, with nothing in between. Pack `aaa` (f5_bigip) hit exactly that: of the
// 6 field names collectSampleKeys could tokenize out of a heterogeneous syslog
// sample, exactly ONE (`user`) mapped to a spec field, it wasn't in the parser's
// contract, so all three pipelines scored 0/1 = 0 while real value coverage was
// 61-67. Below this floor the spec lens reports `supported:false` and callers fall
// through to value coverage, which had a 33-value denominator on the same sample.
const MIN_SPEC_CHECKS = 4;

export function validateOutputAgainstSpec(
  destFormat: string,
  outputEvents: any[],
  rawSampleKeys: string[],
  sourcetype?: string,
  sampleEvents?: string,
): SchemaValidationResult {
  const spec = resolveGoldenFormat(destFormat, sourcetype, sampleEvents);
  if (!spec || outputEvents.length === 0) {
    return { supported: false, score: 0, band: 'fail', outputFormatOk: false, findings: [], missingFields: [], emptyFields: [], checkedFields: 0, populatedFields: 0 };
  }
  // Every field check below is gated by specFieldHasSource(rawSampleKeys) —
  // with zero raw keys NOTHING is ever checkable, so checked stays 0 and the
  // ratio fallback below (checked===0 ? 1) would hand back a fake, unconditional
  // 100. That's a real signal for KVP/JSON sources (collectSampleKeys enumerates
  // their keys fine), but for unstructured text (Cisco ASA/syslog/Windows
  // events) collectSampleKeys can't tokenize field names at all — an empty set
  // means "no ground truth", not "nothing to map". Defer to the AI score, which
  // read the actual raw text, instead of faking 100 (the build-118 bug: every
  // non-KVP/JSON source scored 100 regardless of real output quality).
  if (rawSampleKeys.length === 0 && spec.outputShape !== 'passthrough') {
    return { supported: false, score: 0, band: 'fail', outputFormatOk: false, findings: [], missingFields: [], emptyFields: [], checkedFields: 0, populatedFields: 0 };
  }
  if (spec.outputShape === 'passthrough') {
    const sourcetypeKey = canonicalizeSourcetype(sourcetype || '');
    const resolution = resolveXsiamDestination(sourcetypeKey);
    const extras = legacyXsiamExtras(sourcetypeKey);
    if (!resolution.resolved) {
      return {
        supported: true, score: 0, band: 'fail', outputFormatOk: false,
        findings: [{ severity: 'high', field: '__sourceIdentifier', issue: resolution.failure?.reason || `No XSIAM knowledge source covers "${sourcetype}"`, pointImpact: 0 }],
        missingFields: [], emptyFields: [], checkedFields: 1, populatedFields: 0,
      };
    }
    const idField = resolution.sourceIdField || '__sourceIdentifier';
    const evs = outputEvents.slice(0, 8);
    const findings: SchemaValidationFinding[] = [];
    let checked = 0;
    let populated = 0;
    const tagField = (e: any, name: string) => e[name] || (name === '__sourceIdentifier' ? e.__sourceidentifier : undefined);

    const rawOk = evs.length > 0 && evs.every(e => typeof e._raw === 'string' && e._raw.length > 0);
    checked++;
    if (rawOk) populated++;
    else findings.push({ severity: 'high', field: '_raw', issue: '_raw missing or empty — XSIAM passthrough requires preserved raw log', pointImpact: 0 });

    const idOk = evs.length > 0 && evs.every(e => {
      const actual = tagField(e, idField) || tagField(e, '__sourceIdentifier');
      return Boolean(actual) && (!resolution.sourceIdentifier || actual === resolution.sourceIdentifier);
    });
    checked++;
    if (idOk) populated++;
    else findings.push({ severity: 'high', field: '__sourceIdentifier', issue: `XSIAM source identifier is missing or does not match ${resolution.sourceIdentifier || 'the source catalog'}`, pointImpact: 0 });

    const inputIdOk = evs.length > 0 && evs.every(e => typeof e.__inputId === 'string' && e.__inputId.length > 0);
    if (!inputIdOk) findings.push({
      severity: 'low',
      field: '__inputId',
      issue: 'Cribl supplies __inputId automatically for the XSIAM Integration-Identifier header. Keep it unmodified; its absence from Pipeline Preview is advisory only.',
      pointImpact: 0,
    });

    const needsVendorProduct = Boolean(resolution.vendor || resolution.product);
    if (needsVendorProduct) {
      const vendorOk = evs.length > 0 && evs.every(e => {
        const actual = tagField(e, '__vendor');
        return Boolean(actual) && (!resolution.vendor || actual === resolution.vendor);
      });
      checked++;
      if (vendorOk) populated++;
      else findings.push({ severity: 'high', field: '__vendor', issue: `XSIAM __vendor must exactly match ${resolution.vendor || 'the content-pack rule'}`, pointImpact: 0 });

      const productOk = evs.length > 0 && evs.every(e => {
        const actual = tagField(e, '__product');
        return Boolean(actual) && (!resolution.product || actual === resolution.product);
      });
      checked++;
      if (productOk) populated++;
      else findings.push({ severity: 'high', field: '__product', issue: `XSIAM __product must exactly match ${resolution.product || 'the content-pack rule'}`, pointImpact: 0 });
    }

    if (extras?.pattern === 'cef_extract' || resolution.tier === 'T1b') {
      const genericVendor = /^(security|checkpoint cef)$/i.test(String(evs[0]?.__vendor || ''));
      const genericProduct = /^security$/i.test(String(evs[0]?.__product || ''));
      if (genericVendor || genericProduct) {
        findings.push({
          severity: 'medium', field: '__vendor',
          issue: '__vendor/__product look like generic fallback values — cef_extract should populate them from the CEF header (fields 1–2)',
          pointImpact: 0,
        });
      }
    }

    if (extras?.payloadFormat === 'json') {
      const getPath = (value: any, path: string) => path.split('.').reduce((cur, part) => {
        if (typeof cur === 'string') {
          try { cur = JSON.parse(cur); } catch { return undefined; }
        }
        return cur && typeof cur === 'object' ? cur[part] : undefined;
      }, value);
      const payloads = evs.map(e => {
        try { return JSON.parse(e._raw); } catch { return null; }
      });
      const jsonOk = payloads.every(Boolean);
      checked++;
      if (jsonOk) populated++;
      else findings.push({ severity: 'high', field: '_raw', issue: 'XSIAM content pack expects a source-native JSON object, but _raw is not valid JSON', pointImpact: 0 });

      const expectedPaths = extras.expectedJsonPaths || [];
      if (jsonOk && expectedPaths.length > 0) {
        const compatible = payloads.every(payload => expectedPaths.every(path => getPath(payload, path) != null));
        checked++;
        if (compatible) populated++;
        else findings.push({
          severity: 'high', field: '_raw',
          issue: `JSON does not match the ${extras.contentPack || 'XSIAM'} parser contract; expected paths include ${expectedPaths.join(', ')}`,
          pointImpact: 0,
        });
      }
    }

    if (resolution.tier === 'T1c') {
      findings.push({
        severity: 'medium',
        field: '__sourceIdentifier',
        issue: 'T1c placeholder pipeline: the UUID is documented, but no Palo Alto-provided sample exercises this shape — not scored as a validated (T1a) replay.',
        pointImpact: 0,
      });
    }

    let score = checked > 0 ? Math.round((populated / checked) * 100) : 0;
    if (resolution.tier === 'T1c' && score > XSIAM_T1C_SCORE_CEILING) score = XSIAM_T1C_SCORE_CEILING;
    const band = score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail';
    const highFindings = findings.filter(f => f.severity === 'high');
    return { supported: true, score, band, outputFormatOk: rawOk && idOk && highFindings.length === 0, findings, missingFields: [], emptyFields: [], checkedFields: checked, populatedFields: populated };
  }
  const rules = spec.valueRules;
  const rawSet = buildSpecSourceSet(rawSampleKeys, sourcetype);
  const findings: SchemaValidationFinding[] = [];
  const missingFields: string[] = [];
  const emptyFields: string[] = [];
  let checked = 0, populated = 0;
  let structureOk = true;

  // Flat CIM specs serialize their mapped fields INTO `_raw` (Splunk HEC shape)
  // and then strip every top-level field — the correct CIM output nests the
  // mapped fields only inside the rebuilt `_raw` JSON (see getCompactOutputFunctions).
  // A plain top-level `readPath(e, dest)` therefore finds NOTHING and scores every
  // correct CIM pipeline 0 (golden AND AI). When the spec declares serializeRaw,
  // read the mapped field back out of the parsed `_raw`. Gated on serializeRaw so a
  // real top-level-field destination (plain JSON) can't get a false positive from
  // parsing the original source log that happens to be JSON.
  const serializesToRaw = !!spec.cleanup?.serializeRaw && spec.outputShape !== 'raw';
  const rawJsonCache = new WeakMap<object, any>();
  const parsedRaw = (e: any): any => {
    if (!e || typeof e !== 'object') return undefined;
    if (rawJsonCache.has(e)) return rawJsonCache.get(e);
    let parsed: any;
    if (typeof e._raw === 'string') {
      try { const p = JSON.parse(e._raw); if (p && typeof p === 'object') parsed = p; } catch { /* not JSON */ }
    }
    rawJsonCache.set(e, parsed);
    return parsed;
  };
  const readSpecField = (e: any, name: string): any => {
    const top = readPath(e, name);
    if (isPopulated(top)) return top;
    if (serializesToRaw) { const pr = parsedRaw(e); if (pr) return readPath(pr, name); }
    return top;
  };

  // Fields to check: CEF extension keys (raw shape) or canonicalMap dests.
  type Chk = { out: string; expr: string; number?: boolean; guard?: string };
  const checks: Chk[] = spec.outputShape === 'raw'
    ? (spec.extension || []).map(e => ({ out: e.key, expr: e.expr, guard: e.guard }))
    : (spec.canonicalMap || []).filter(m => !m.literalNumber && !isQuotedLiteralExpr(m.expr)).map(m => ({ out: m.dest, expr: m.expr, number: m.number }));

  // Structural checks per event (sampled up to 8).
  const evs = outputEvents.slice(0, 8);
  if (spec.outputShape === 'raw') {
    // CEF: every event's _raw must start with the CEF:0| header + 7 pipes.
    const prefix = (spec.header?.prefix || 'CEF:0');
    const bad = evs.filter(e => typeof e._raw !== 'string' || !e._raw.startsWith(prefix) || (e._raw.match(/\|/g) || []).length < 7);
    if (bad.length > 0) {
      structureOk = false;
      findings.push({ severity: 'high', field: '_raw', issue: `${bad.length}/${evs.length} events missing a valid ${prefix}|…| CEF header` });
    }
  }

  for (const chk of checks) {
    const src = resolveExpr(chk.expr, rules);
    // Source-relative: only expect this field when the sample supplied its input.
    if (!specFieldHasSource(src, rawSet)) continue;
    checked++;
    // Count an output field as populated if it's populated in ANY sampled event
    // (sparse sources legitimately leave some events without a given field).
    let anyPop = false, anyBadType = false;
    for (const e of evs) {
      const v = spec.outputShape === 'raw'
        ? (typeof e._raw === 'string' && new RegExp(`(?:^|[\\s|])${chk.out}=`).test(e._raw))  // CEF key present in _raw (first key follows the header `|`)
        : readSpecField(e, chk.out);
      if (spec.outputShape === 'raw') { if (v) anyPop = true; }
      else if (isPopulated(v)) { anyPop = true; if (chk.number && typeof v !== 'number') anyBadType = true; }
    }
    if (anyPop) {
      populated++;
      // A wrong-type value still counts as "populated" for the ratio (it's
      // present, just mistyped) — so this finding costs 0 points by design,
      // distinct from a genuinely-missing field below. Surfacing that as 0
      // is the point: it explains why a "medium" finding didn't move the score.
      if (anyBadType) findings.push({ severity: 'medium', field: chk.out, issue: `expected numeric but output is a string`, pointImpact: 0 });
    } else {
      missingFields.push(chk.out);
      emptyFields.push(chk.out);
      // Deferred: exact point cost needs `checked`'s FINAL value, computed below.
      findings.push({ severity: 'medium', field: chk.out, issue: `source value present but "${chk.out}" is empty in output` });
    }
  }

  // Timestamp check: _time must be set and not defaulting to "now-ish" only if
  // the spec has a timeField whose source exists.
  if (spec.timeField && specFieldHasSource(resolveExpr(spec.timeField, rules), rawSet)) {
    checked++;
    const hasTime = evs.some(e => typeof e._time === 'number' && e._time > 0);
    if (hasTime) populated++;
    else findings.push({ severity: 'medium', field: '_time', issue: 'timestamp not derived from the source time field' });
  }

  // Too few checkable fields to form a ratio — see MIN_SPEC_CHECKS. Report NOT
  // MEASURABLE rather than a verdict; `checkedFields` is carried through so the
  // caller can say WHY it declined (and so the property test can assert on it).
  if (checked < MIN_SPEC_CHECKS) {
    // Rule 9's convention: 0 = advisory, `undefined` = "not yet computed". These
    // findings can still be useful hints, but this lens is not producing a score,
    // so none of them cost points — say so explicitly rather than leaving the UI
    // to render an absent impact.
    for (const f of findings) if (f.pointImpact === undefined) f.pointImpact = 0;
    return {
      supported: false, score: 0, band: 'fail', outputFormatOk: structureOk,
      findings, missingFields, emptyFields, checkedFields: checked, populatedFields: populated,
    };
  }

  const ratio = populated / checked;
  // Structural failure caps the score hard (matches the AI rubric's <60 shape band).
  let score = Math.round(ratio * 100);
  if (!structureOk) score = Math.min(score, 40);
  const band: SchemaValidationResult['band'] = score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail';

  // Backfill pointImpact for every missing/empty-field finding: the score each
  // ALONE cost = 100 * (1/checked), i.e. what the ratio would be if this one
  // field had been populated instead, rounded the same way the score itself is.
  // Structural (_raw header) findings are excluded — they cap the score via a
  // min(), not a per-field ratio, so a "points" number would misrepresent them.
  const perFieldImpact = checked > 0 ? Math.round(100 / checked) : 0;
  for (const f of findings) {
    if (f.pointImpact === undefined && f.field !== '_raw') f.pointImpact = perFieldImpact;
  }

  return {
    supported: true, score, band, outputFormatOk: structureOk,
    findings, missingFields, emptyFields, checkedFields: checked, populatedFields: populated,
  };
}

// Authoritative post-deploy score: OCSF nested specs → golden-spec coverage;
// flat golden paths (CIM/ECS) → source-relative spec validation (only penalizes
// fields the sample actually carries); everything else → value coverage.
import { auditRawFidelity, type RawFidelityAudit } from './raw-fidelity';
export { auditRawFidelity, rawFidelityIssues, type RawFidelityAudit } from './raw-fidelity';

export type AuthoritativeScoreSource = 'golden-spec' | 'spec-validation' | 'value-coverage' | 'raw-fidelity' | 'ai';

export interface AuthoritativeScoreResult {
  score: number;
  band: 'good' | 'warn' | 'fail';
  scoreSource: AuthoritativeScoreSource;
  golden: GoldenCoverageResult | null;
  spec: SchemaValidationResult | null;
  coverage: ValueCoverageResult | null;
  real: boolean;
  ocsf?: OcsfEnvelopeAudit | null;
  ocsfClass?: OcsfClassAudit | null;
  ocsfSchema?: OcsfSchemaScore | null;
  cef?: CefFormatAudit | null;
  schema?: SchemaConformanceAudit | null;
  xsiamParse?: XsiamParseConformanceAudit | null;
  udm?: UdmConformanceAudit | null;
  rawFidelity?: RawFidelityAudit | null;
}

// OCSF nested content objects — real event signal, NOT metadata/envelope
// housekeeping. A well-formed OCSF event carries class_uid AND at least one of
// these populated; a "flat" output (canonical values but no nested objects) is
// NOT valid OCSF even though value-coverage happily rewards the canonical values.
const OCSF_CONTENT_OBJECTS = [
  'src_endpoint', 'dst_endpoint', 'device', 'actor', 'user', 'connection_info',
  'traffic', 'http_request', 'http_response', 'email', 'process', 'api', 'file',
  'query', 'malware', 'firewall_rule', 'dns_query', 'network_endpoint', 'endpoint',
];

export interface OcsfEnvelopeAudit {
  applicable: boolean;         // output looks like OCSF at all
  hasClassUid: boolean;
  contentObjects: string[];    // populated nested content objects
  complete: boolean;           // class_uid + ≥1 populated content object
  missing: string[];
}

// True when a value is real content: a non-empty scalar, or an object/array with
// at least one such leaf (recursive). Empty `{}` / `''` / `'-'` / null → false.
function ocsfValueHasContent(v: any): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.some(ocsfValueHasContent);
  if (typeof v === 'object') return Object.values(v).some(ocsfValueHasContent);
  if (typeof v === 'string') { const t = v.trim(); return t !== '' && t !== '-' && t !== 'undefined' && t !== 'null'; }
  return true; // number / boolean
}

// Inspect deterministic output for OCSF envelope completeness (Rule: flat OCSF
// must not score good / store golden — see the OCSF-completeness gate in
// scoreAuthoritative). Exported for the repair engine's finding.
export function ocsfEnvelopeAudit(outputEvents: any[]): OcsfEnvelopeAudit {
  const events = (outputEvents || []).filter(e => e && typeof e === 'object' && !Array.isArray(e));
  let hasClassUid = false;
  const present = new Set<string>();
  for (const ev of events) {
    if (ev.class_uid != null && String(ev.class_uid).trim() !== '') hasClassUid = true;
    for (const key of OCSF_CONTENT_OBJECTS) {
      // A content object must be a NESTED object/array with real content — a
      // flat scalar at this key (e.g. user='admin') is flat data, not the OCSF
      // nested object (user: { name: 'admin' }), and does not count.
      const v = ev[key];
      if (v != null && typeof v === 'object' && ocsfValueHasContent(v)) present.add(key);
    }
  }
  const contentObjects = [...present];
  const applicable = events.length > 0 && (hasClassUid || contentObjects.length > 0);
  const complete = hasClassUid && contentObjects.length >= 1;
  const missing: string[] = [];
  if (!hasClassUid) missing.push('class_uid');
  if (contentObjects.length === 0) missing.push('a populated content object (src_endpoint / dst_endpoint / actor / user / device / …)');
  return { applicable, hasClassUid, contentObjects, complete, missing };
}

// Cap applied to a value-coverage/ai OCSF score when the envelope is incomplete
// (flat canonical output). Lands in the fail band (<60) so it can neither score
// good nor be stored as a golden — a rescore of the 94 stored flat OCSF goldens
// demotes them organically.
const OCSF_INCOMPLETE_CAP = 55;

// --- OCSF class-correctness (semantic) gate ---------------------------------
// Value coverage (Rule 12) measures whether the DATA reached the output; it is
// silent on whether the events were mapped to the RIGHT OCSF class. A source
// whose data class we know UNAMBIGUOUSLY (firewall → Network 4001, EDR → Process
// 1007, SSL/network → 4001, mail → Email 4009) but whose output emits a different
// class_uid — never the expected one — is semantically wrong (SSL→Email,
// Sysmon→Base Event, PAN-system→Network) even when every value is present. This
// is the semantic blind spot the batch-review surfaced; it is a CAP (never an
// inflation), applied only on the value-coverage/AI branches like capOcsf — the
// golden/spec branches set the class from the same effectiveDataClass by
// construction, so they cannot mismatch.
//
// Classes with a SINGLE, unambiguous OCSF class are enforceable. `audit`→3002 and
// `generic`→0 are deliberately excluded: their OCSF class is genuinely ambiguous
// (a device system log — pan_system — has no clean OCSF class), so enforcing one
// would false-cap correct output.
const OCSF_ENFORCEABLE_CLASSES = new Set<DataClass>(['network', 'authentication', 'endpoint', 'web_proxy', 'email', 'dns', 'cloud_audit']);

export interface OcsfClassAudit {
  applicable: boolean;     // enforceable class + output carries a class_uid
  expectedUid: number;
  expectedClass: string;
  emitted: number[];       // distinct class_uid values seen in the output
  match: boolean;          // the expected class_uid appears in the output
}

// Conservative: applicable only when the source's class is enforceable AND the
// output carries a class_uid; a mismatch is flagged only when the expected class
// is ENTIRELY ABSENT from the output, so a mixed-class source (ASA VPN +
// firewall) that still emits its primary class is never penalised.
export function ocsfClassAudit(outputEvents: any[], expectedUid: number, expectedClass: string): OcsfClassAudit {
  const events = (outputEvents || []).filter(e => e && typeof e === 'object' && !Array.isArray(e));
  const emitted = new Set<number>();
  for (const ev of events) {
    const raw = ev.class_uid;
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) emitted.add(n);
  }
  const applicable = expectedUid > 0 && emitted.size > 0;
  return { applicable, expectedUid, expectedClass, emitted: [...emitted], match: emitted.has(expectedUid) };
}

const OCSF_CLASS_MISMATCH_CAP = 50;
// Classes a concretized key's golden spec legitimately emits besides its own.
const OCSF_KEY_CLASS_FAMILY: Record<string, number[]> = {
  'ocsf#endpoint': [1007, 1009, 1001, 4001, 4003],
  'ocsf#cloud_audit': [6003, 3002],
};

export interface OcsfStructuralAudit {
  envelope: OcsfEnvelopeAudit | null;
  classAudit: OcsfClassAudit | null;
  /** The lowest of the two caps that applies to this output, or null. */
  cap: number | null;
  /** One line naming each cap that applies, for a score card. */
  reason: string | null;
}

// The two OCSF structural gates (envelope completeness, class correctness) as
// ONE audit, so every scorer that grades OCSF output applies the same caps:
// `scoreAuthoritative` on its value-coverage/AI branches and the staged
// builder's mapping lens (`scoreStage`). The expected class comes from the same
// sample-aware effectiveDataClass the build concretized the schema with.
export function ocsfStructuralAudit(destFormat: string, sourcetype: string | undefined, sampleText: string, outputEvents: any[]): OcsfStructuralAudit {
  if (!isOcsfScoredFormat(destFormat)) return { envelope: null, classAudit: null, cap: null, reason: null };
  const envelope = ocsfEnvelopeAudit(outputEvents);
  let classAudit: OcsfClassAudit | null = null;
  // A concretized key names the class the build targeted (refineOcsfKey may pick
  // DHCP for a `dns`-classed source) — grade against it. Base Event: no class to
  // enforce. A bare key falls back to the sample-aware data class.
  const keyUid = ocsfClassUidForKey(destFormat);
  if (sourcetype && dispatchesOcsfClassPerEvent(destFormat, sourcetype)) {
    // The class is DATA here (the Windows dispatcher picks it per EventID), so a
    // Security sample of only 4688s legitimately emits no 3002. Grade that every
    // emitted class is one the dispatcher can assign, not that the key's is present.
    classAudit = ocsfClassAudit(outputEvents, keyUid || 0, 'Windows per-event class');
    classAudit = { ...classAudit, applicable: classAudit.emitted.length > 0, match: classAudit.emitted.every(u => WINDOWS_OCSF_DISPATCH_CLASSES.includes(u)) };
  } else if (keyUid != null) {
    if (keyUid > 0) {
      classAudit = ocsfClassAudit(outputEvents, keyUid, String(ocsfClassNameForKey(destFormat)).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
      // Per-event class families: the endpoint spec sends Sysmon 3/22/11 and
      // PowerShell 4104 to their own classes; cloud audit re-classes logins.
      const family = OCSF_KEY_CLASS_FAMILY[destFormat];
      if (family && classAudit.emitted.some(u => family.includes(u))) classAudit = { ...classAudit, match: true };
    }
  } else if (sourcetype && sourcetypeOcsfClassKey(sourcetype)) {
    // A bare key builds the class the sourcetype names (refineOcsfKey) — grade that.
    const stKey = sourcetypeOcsfClassKey(sourcetype)!;
    classAudit = ocsfClassAudit(outputEvents, ocsfClassUidForKey(stKey) || 0, String(ocsfClassNameForKey(stKey)).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
  } else if (sourcetype) {
    const dc = effectiveDataClass(sourcetype, sampleText);
    if (OCSF_ENFORCEABLE_CLASSES.has(dc)) {
      const rec = DATACLASS_RECOMMENDATION[dc];
      classAudit = ocsfClassAudit(outputEvents, rec.ocsfClassUid, rec.ocsfClass);
    }
  }
  const caps: number[] = [];
  const reasons: string[] = [];
  if (envelope.applicable && !envelope.complete) {
    caps.push(OCSF_INCOMPLETE_CAP);
    reasons.push(`capped at ${OCSF_INCOMPLETE_CAP}: not a complete OCSF event (missing ${envelope.missing.join(', ')})`);
  }
  if (classAudit && classAudit.applicable && !classAudit.match) {
    caps.push(OCSF_CLASS_MISMATCH_CAP);
    reasons.push(`capped at ${OCSF_CLASS_MISMATCH_CAP}: this source is ${classAudit.expectedClass} (${classAudit.expectedUid}), the output emits class_uid ${classAudit.emitted.join(', ')}`);
  }
  return {
    envelope,
    classAudit,
    cap: caps.length ? Math.min(...caps) : null,
    reason: reasons.length ? `OCSF ${reasons.join('; ')}.` : null,
  };
}

export function scoreAuthoritative(opts: {
  destFormat: string;
  sourcetype?: string;
  rawSampleKeys: string[];
  rawEvents: string[];
  outputEvents: any[];
  aiScore?: number | null;
}): AuthoritativeScoreResult {
  const { destFormat, sourcetype, rawSampleKeys, rawEvents, outputEvents, aiScore } = opts;
  // The score MUST resolve the same `#dataClass` schema the build did — so the
  // raw sample is threaded into every resolver (sample-aware effectiveDataClass).
  const sampleText = (rawEvents || []).join('\n');
  // rawSampleKeys ARE this source's real field names — pass them so the nested
  // spec lens scores against what the source can fill, not against its own output.
  const golden = scoreGoldenSpecCoverage(destFormat, outputEvents, sourcetype, sampleText, rawSampleKeys);
  const spec = validateOutputAgainstSpec(destFormat, outputEvents, rawSampleKeys, sourcetype, sampleText);
  const coverage = scoreValueCoverage(rawEvents, outputEvents);
  const isGoldenPath = sourcetype ? hasGoldenFormatPath(sourcetype, destFormat, sampleText) : false;

  // NG-SIEM ships the original line to a vendor parser, so no mapped schema (OCSF,
  // golden spec) describes what it receives, and value coverage over an unchanged
  // line only measures its own tokenizer. The score is the share of events whose
  // `_raw` is an original sample line with nothing billable beside it.
  if (isNextGenRawFidelityFormat(destFormat)) {
    const rawFidelity = auditRawFidelity(rawEvents, outputEvents);
    if (rawFidelity.applicable && rawFidelity.cap != null) {
      const score = rawFidelity.cap;
      return {
        score, band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail', scoreSource: 'raw-fidelity',
        golden: null, spec: null, coverage: coverage.supported ? coverage : null, real: true, rawFidelity,
      };
    }
    const score = aiScore ?? 0;
    return {
      score, band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail', scoreSource: 'ai',
      golden: null, spec: null, coverage: null, real: false, rawFidelity,
    };
  }

  // OCSF-completeness gate: for an OCSF destination, a "flat" output (canonical
  // values, no nested objects) is not valid OCSF even though value-coverage
  // rewards the values. Cap such a score into the fail band so it can neither
  // score good nor store golden. Applies ONLY to the value-coverage/ai branches —
  // the golden-spec and spec-validation branches measure the nested envelope
  // structure genuinely and are already complete by construction.
  const structural = ocsfStructuralAudit(destFormat, sourcetype, sampleText, outputEvents);
  const ocsf = structural.envelope;
  const capOcsf = (r: AuthoritativeScoreResult): AuthoritativeScoreResult => {
    if (ocsf && ocsf.applicable && !ocsf.complete && r.score > OCSF_INCOMPLETE_CAP) {
      return { ...r, score: OCSF_INCOMPLETE_CAP, band: 'fail' };
    }
    return r;
  };

  // OCSF class-correctness (semantic) gate — see OCSF_ENFORCEABLE_CLASSES. Uses
  // the SAME sample-aware effectiveDataClass the build resolved the schema with,
  // so build and score agree on the expected class.
  const ocsfClass = structural.classAudit;
  const capOcsfClass = (r: AuthoritativeScoreResult): AuthoritativeScoreResult => {
    if (ocsfClass && ocsfClass.applicable && !ocsfClass.match && r.score > OCSF_CLASS_MISMATCH_CAP) {
      return { ...r, score: OCSF_CLASS_MISMATCH_CAP, band: 'fail' };
    }
    return r;
  };

  // OCSF real-schema cap: the checks above are shape/class HEURISTICS (envelope
  // presence, single class_uid membership); this is the genuine article — every
  // required/recommended attribute, enum member and JSON type checked against the
  // vendored official OCSF schema (config/ocsf-classes.json, src/ocsf-schema.ts).
  // It is ORTHOGONAL to coverage (a fully-covered event can still emit an invalid
  // enum or a numeric attribute as a string) so — like CEF/schema/xsiam — it is a
  // CAP applied on EVERY branch, never an inflation: a golden/spec build that is
  // honestly schema-valid scores unchanged, one that is not gets caught here where
  // the shape-only checks above cannot see it.
  const ocsfSchema = isOcsfScoredFormat(destFormat) ? scoreOcsfAgainstSchema(outputEvents, destFormat) : null;
  const capOcsfSchema = (r: AuthoritativeScoreResult): AuthoritativeScoreResult => {
    if (ocsfSchema && ocsfSchema.supported && ocsfSchema.score < r.score) {
      const band: AuthoritativeScoreResult['band'] = ocsfSchema.score >= 85 ? 'good' : ocsfSchema.score >= 60 ? 'warn' : 'fail';
      return { ...r, score: ocsfSchema.score, band };
    }
    return r;
  };

  // CEF wire-format cap: a CEF destination that emits malformed CEF (bad header,
  // out-of-range severity, broken escaping) is rejected by an ArcSight/SIEM
  // collector regardless of how many values it carries. Unlike OCSF, CEF validity
  // is ORTHOGONAL to coverage, so this is a CAP (never an inflation) applied to
  // EVERY branch — including golden/spec, which only check header presence, not
  // severity range or escaping. The dictionary check is advisory (does not cap).
  const cef = isCefFormat(destFormat) ? auditCefFormat(outputEvents) : null;
  const capCef = (r: AuthoritativeScoreResult): AuthoritativeScoreResult => {
    if (cef && cef.applicable && cef.score < r.score) {
      return { ...r, score: cef.score, band: cef.band };
    }
    return r;
  };

  // Structured-format conformance cap (CIM/ASIM type conformance, ECS/Chronicle
  // envelope shape, JSON structural). Same rationale as CEF: format correctness is
  // ORTHOGONAL to value coverage — a CIM output that carries every source value but
  // emits a numeric field as a string, or an "ECS" output that is a flat blob with
  // no nested namespace, is wrong regardless of coverage. CAP only, never inflates.
  const schema = isSchemaConformanceFormat(destFormat) ? auditSchemaConformance(destFormat, outputEvents) : null;
  const capSchema = (r: AuthoritativeScoreResult): AuthoritativeScoreResult => {
    if (schema && schema.applicable && schema.score < r.score) {
      return { ...r, score: schema.score, band: schema.band };
    }
    return r;
  };

  // XSIAM parse-conformance cap: for every other destination we grade output against
  // a schema WE map to; XSIAM parses the vendor format itself, so the question is
  // whether ITS OWN rule accepts our wire shape. Tag correctness was already checked
  // and says nothing about shape — a perfectly-tagged pack whose raw line fails the
  // rule's gate delivers a dataset that is unparsed or (no_hit=drop) DISCARDED. The
  // cap expresses that consequence when the failure is SYSTEMIC (every event rejected);
  // a partial failure caps at the honest share of events XSIAM will parse. See
  // XSIAM_PARSE_DROP_CAP and the audit's own `cap`, which decides between the two — the
  // band travels with it so a proportionate cap is not reported as an outright fail.
  const xsiamParse = isXsiamParseConformanceFormat(destFormat)
    ? auditXsiamParseConformance({ sourcetype, outputEvents, rawEvents })
    : null;
  const capXsiam = (r: AuthoritativeScoreResult): AuthoritativeScoreResult => {
    if (xsiamParse && xsiamParse.applicable && xsiamParse.cap != null && r.score > xsiamParse.cap) {
      return { ...r, score: xsiamParse.cap, band: xsiamParse.band };
    }
    return r;
  };

  // Google SecOps UDM wire-contract cap: the envelope check (capSchema) only sees a
  // `metadata` object; the destination DROPS an event with a non-EventType
  // event_type or a malformed event_timestamp, and fails the whole batch on a
  // datatype mismatch. A consequence cap on every branch, like capXsiam — a golden
  // spec that breaks the contract is caught here. See auditUdmConformance.
  const udm = isUdmConformanceFormat(destFormat) ? auditUdmConformance(destFormat, outputEvents) : null;
  const capUdm = (r: AuthoritativeScoreResult): AuthoritativeScoreResult => {
    if (udm && udm.applicable && udm.cap != null && r.score > udm.cap) {
      return { ...r, score: udm.cap, band: udm.band };
    }
    return r;
  };

  if (golden.supported) {
    return capOcsfSchema(capUdm(capXsiam(capSchema(capCef({
      score: golden.score, band: golden.band, scoreSource: 'golden-spec',
      golden, spec: spec.supported ? spec : null, coverage: coverage.supported ? coverage : null, real: true, ocsf, ocsfClass, ocsfSchema, cef, schema, xsiamParse, udm,
    })))));
  }
  // Rule 12 makes value coverage THE score; the spec lens may only pre-empt it for
  // a flat golden path when it is genuinely a measurement. `spec.supported` already
  // encodes the MIN_SPEC_CHECKS floor, but assert the denominator here too: this is
  // the branch that let a 1-field spec ratio outvote a 33-value coverage
  // measurement and report 0 for three working f5_bigip pipelines (pack `aaa`).
  if (spec.supported && isGoldenPath && spec.checkedFields >= MIN_SPEC_CHECKS) {
    return capOcsfSchema(capUdm(capXsiam(capSchema(capCef({
      score: spec.score, band: spec.band, scoreSource: 'spec-validation',
      golden: null, spec, coverage: coverage.supported ? coverage : null, real: true, ocsf, ocsfClass, ocsfSchema, cef, schema, xsiamParse, udm,
    })))));
  }
  // XSIAM passthrough: tag checks are authoritative — never fall through to value-coverage
  // (which penalizes unmapped CEF/syslog fields that XSIAM parses natively). The parse
  // cap DOES apply here: tags being right is exactly the case where a rejected wire
  // shape is otherwise invisible, and this branch used to return uncapped.
  if (destFormat === 'xsiam' && spec.supported) {
    return capXsiam({
      score: spec.score, band: spec.band, scoreSource: 'spec-validation',
      golden: null, spec, coverage: null, real: true, ocsf, ocsfClass, ocsfSchema, cef, schema, xsiamParse, udm,
    });
  }
  if (coverage.supported) {
    // OCSF: a value parked in `unmapped` is preserved, not normalized — weight it
    // (OCSF_UNMAPPED_CREDIT) instead of counting it as fully covered.
    const carry = isOcsfScoredFormat(destFormat) ? scoreOcsfMappingCarry(rawEvents, null, outputEvents, destFormat) : null;
    const covScore = carry?.supported ? Math.min(coverage.score, carry.score) : coverage.score;
    return capOcsfSchema(capUdm(capXsiam(capSchema(capCef(capOcsfClass(capOcsf({
      score: covScore, band: covScore >= 85 ? 'good' : covScore >= 60 ? 'warn' : 'fail', scoreSource: 'value-coverage',
      golden: null, spec: spec.supported ? spec : null, coverage, real: true, ocsf, ocsfClass, ocsfSchema, cef, schema, xsiamParse, udm,
    })))))));
  }
  const score = aiScore ?? 0;
  return capOcsfSchema(capUdm(capXsiam(capSchema(capCef(capOcsfClass(capOcsf({
    score,
    band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail',
    scoreSource: 'ai',
    golden: null, spec: null, coverage: null, real: false, ocsf, ocsfClass, ocsfSchema, cef, schema, xsiamParse, udm,
  })))))));
}

// Canonical behavior key → Splunk source-native (colon) sourcetype name. Built
// once from source-samples.json (the authoritative curated set, e.g.
// cisco_asa → cisco:asa, pan_traffic → pan:traffic). Splunk/CIM expect the
// colon form as the emitted `sourcetype`; the wizard usually only has the
// canonical underscore key, so we resolve the native form here.
const SPLUNK_NATIVE_SOURCETYPE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [key, val] of Object.entries(sourceSamplesData as Record<string, { sourcetype?: string }>)) {
    const native = (val && typeof val === 'object' && typeof val.sourcetype === 'string') ? val.sourcetype.trim() : '';
    if (!native || native === key) continue;
    // Key the map by the ALIAS-RESOLVED canonical form (pan_traffic and
    // palo_alto_traffic collapse to one), and only trust an entry whose native
    // form canonicalizes back to that same source — so a colon/slash/casing
    // variant is accepted but a mislabelled entry is not.
    const canonicalKey = canonicalizeSourcetype(key);
    if (canonicalizeSourcetype(native) === canonicalKey) map[canonicalKey] = native;
  }
  return map;
})();

// Official Splunk pretrained sourcetypes for canonical sources that have NO
// colon-native form in source-samples.json (so the auto-built map above can't
// carry them). e.g. Apache/NCSA combined access logs are `access_combined` in
// Splunk — the canonical behaviour key `apache_access` is our internal name,
// not what a Splunk index expects. Keyed by ALIAS-RESOLVED canonical form.
// Windows event channels, keyed by the canonical source their parser serves.
// Splunk_TA_windows (5.x+) indexes XML event logs as sourcetype `XmlWinEventLog`
// with the channel in `source` (`XmlWinEventLog:Security`). The auto-built map
// above can't carry this: three source-samples entries (WinEventLog,
// XmlWinEventLog, XmlWinEventLog:…NTLM/Operational) all collapse to
// windows_security, and last-wins picked the NTLM channel for every Security log.
const WINDOWS_XML_CHANNEL: Record<string, string> = {
  windows_security: 'Security',
  windows_system: 'System',
  windows_application: 'Application',
  windows_dns_client: 'Microsoft-Windows-DNS-Client/Operational',
  windows_defender: 'Microsoft-Windows-Windows Defender/Operational',
  windows_sysmon: 'Microsoft-Windows-Sysmon/Operational',
};

const OFFICIAL_SPLUNK_SOURCETYPE: Record<string, string> = {
  apache_access: 'access_combined',
  nginx_access: 'access_combined',
  ...Object.fromEntries(Object.keys(WINDOWS_XML_CHANNEL).map(k => [k, 'XmlWinEventLog'])),
};

// Resolve the source-native sourcetype for the emitted `sourcetype` field. An
// explicit colon/slash form the caller passed always wins (the user typed the
// native name); otherwise look up the canonical key's Splunk name (the curated
// official names first — they exist precisely where the auto-built colon map is
// ambiguous or absent — then the auto-built map); otherwise keep whatever was given.
export function sourceNativeSourcetype(rawInput: string): string {
  const raw = (rawInput || '').trim();
  if (!raw) return raw;
  // A form the user already gave with Splunk separators is authoritative.
  if (/[:/]/.test(raw)) return raw;
  const canonical = canonicalizeSourcetype(raw);
  return OFFICIAL_SPLUNK_SOURCETYPE[canonical] || SPLUNK_NATIVE_SOURCETYPE[canonical] || raw;
}

// The Splunk `source` a source-native TA expects, or '' when there is no
// convention (the destination-metadata contract then falls back to the
// sourcetype). Only Windows has one: the event channel, `XmlWinEventLog:Security`.
export function sourceNativeSplunkSource(rawInput: string): string {
  const raw = (rawInput || '').trim();
  if (!raw) return '';
  // A channel-qualified name the user gave (`XmlWinEventLog:…NTLM/Operational`) IS the source.
  if (/^(Xml)?WinEventLog:./.test(raw)) return raw;
  const channel = WINDOWS_XML_CHANNEL[canonicalizeSourcetype(raw)];
  return channel ? `XmlWinEventLog:${channel}` : '';
}

// The emitted `sourcetype` field. Two flows differ (per product requirement):
//  • BATCH — the user explicitly selected a sourcetype (passed as
//    `outputSourcetype`); keep it VERBATIM, whatever they chose.
//  • INTERACTIVE pack creation — the wizard RECOGNISED the source and no
//    explicit output sourcetype is given; emit the official Splunk source-native
//    name (apache_access → access_combined, cisco_asa → cisco:asa).
export function resolveOutputSourcetype(outputSourcetype: string | undefined, sourcetypeRaw: string, canonical: string): string {
  const explicit = (outputSourcetype || '').trim();
  if (explicit) return explicit;
  return sourceNativeSourcetype((sourcetypeRaw || '').trim() || canonical);
}

// JS builtins / method names that appear in normalize expressions but are NOT
// source fields — excluded when reading the identifiers an alias step consumes.
const ALIAS_BUILTIN_IDENTS = new Set<string>([
  'Date', 'Number', 'String', 'Boolean', 'Math', 'JSON', 'Array', 'Object', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', 'undefined', 'null', 'true', 'false', 'typeof',
  'new', 'return', 'if', 'else', 'void', 'NaN', 'Infinity', '_time',
]);

// Build value-preserving alias EQUIVALENCE GROUPS from a pipeline's eval `add`
// steps. When a normalize/schematizer step assigns `T = <pure alias of sources>`
// (e.g. `url = uri || undefined`, `bytes_out = Number(bytes)`,
// `application = application || app || service`), T and its source fields all
// carry the same datum — so if any one is consumed by a downstream mapping, the
// others are duplicates. A step whose value can resolve to a STRING LITERAL via
// a ternary (`action = status>=400 ? 'blocked' : 'allowed'`) is LOSSY, not an
// alias — the raw source (status) is genuine unmapped data and must NOT be
// grouped. Returns groups of ≥2 field names.
export function computeAliasGroups(fns: PipelineFunction[]): string[][] {
  // Union-find over field names.
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const union = (a: string, b: string) => { parent.set(a, parent.get(a) || a); parent.set(b, parent.get(b) || b); parent.set(find(a), find(b)); };
  for (const f of fns || []) {
    if (f?.id !== 'eval') continue;
    const add = (f.conf as Record<string, any>)?.add;
    if (!Array.isArray(add)) continue;
    for (const a of add) {
      const name = String(a?.name || '').trim();
      const rawExpr = String(a?.value ?? '');
      if (!name || !rawExpr) continue;
      // Lossy: a ternary branch that yields a string literal (`? 'x'` / `: 'y'`).
      if (/[?:]\s*['"`]/.test(rawExpr)) continue;
      // Strip string, template and regex literals + method/property accessors so
      // only real source identifiers remain (regex bodies leak `\d`→`d` noise).
      const cleaned = rawExpr
        .replace(/'(?:[^'\\]|\\.)*'/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/`(?:[^`\\]|\\.)*`/g, ' ')
        .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, ' ')
        .replace(/\.[A-Za-z_$][\w$]*/g, ' ');
      const idents = (cleaned.match(/[A-Za-z_$][\w$]*/g) || []).filter(t => !ALIAS_BUILTIN_IDENTS.has(t));
      for (const src of idents) if (src !== name) union(name, src);
    }
  }
  const groups = new Map<string, Set<string>>();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(key);
  }
  return [...groups.values()].map(s => [...s]).filter(g => g.length >= 2);
}

// Expand the exclusion list of every `AdditionalExtensions` serialize step so a
// field that only exists as a value-preserving ALIAS of an already-excluded
// field is dropped too — otherwise the raw source token (uri, bytes, timestamp)
// duplicates a CSL column that already holds its value. `aliasContext` is the
// full pipeline (extraction + schematizer aliases + mapping) so the alias steps
// are visible even when the serialize step lives in a separately-built stage.
export function dedupeAliasedSerializeFields(fns: PipelineFunction[], aliasContext?: PipelineFunction[]): PipelineFunction[] {
  const groups = computeAliasGroups(aliasContext || fns);
  if (!groups.length) return fns;
  return (fns || []).map(f => {
    if (f?.id !== 'serialize') return f;
    const conf = f.conf as Record<string, any>;
    if (conf?.dstField !== 'AdditionalExtensions' || !Array.isArray(conf.fields)) return f;
    const fields: string[] = conf.fields.slice();
    // Names already excluded (`!name`, plain identifiers only — skip globs).
    const excluded = new Set(fields.filter(x => typeof x === 'string' && x.startsWith('!') && /^![A-Za-z_$][\w$]*$/.test(x)).map(x => x.slice(1)));
    const toAdd: string[] = [];
    for (const g of groups) {
      if (!g.some(m => excluded.has(m))) continue;
      for (const m of g) if (!excluded.has(m)) { toAdd.push(`!${m}`); excluded.add(m); }
    }
    if (!toAdd.length) return f;
    // Insert before the trailing catch-all `'*'` so negations still take effect.
    const star = fields.lastIndexOf('*');
    const next = star >= 0 ? [...fields.slice(0, star), ...toAdd, ...fields.slice(star)] : [...fields, ...toAdd];
    return { ...f, conf: { ...conf, fields: next } };
  });
}

// A golden spec is SHARED across many sourcetypes, so its canonicalMap exprs are
// portable coalescing chains: `src_ip || source_ip || src || saddr` — pick the
// first field name any source might use. For a KNOWN sourcetype we already know
// exactly which of those a parser can emit (`getParserFieldNames`), so we can
// collapse the chain to just those operands — usually one, occasionally two.
// This is a readability/debuggability cleanup ONLY: `||` already short-circuits
// to that same field at runtime, and dropped operands are ones the parser can
// NEVER produce, so the live output is byte-identical (proven in
// tests/alias-chain-resolution-test.mjs). Conservative by construction:
//   - ONLY a WHOLE-EXPRESSION pure bare-field chain (`a || b || c`) is touched.
//     `||` is also the boolean-OR operator, so a chain embedded in a ternary
//     guard, comparison or transform (`severity == null || severity === ''`,
//     `Number(bytes_in || bytes)`) is left exactly as-is — matching a sub-chain
//     inside such an expression would corrupt it (that was the build-687 bug).
//   - operand ORDER is preserved (fallback precedence is unchanged);
//   - if NONE of the operands are in the declared set we don't understand the
//     source, so the chain is kept intact (never resolve to empty);
//   - only runs when a declared field set exists (golden-path sources). AI /
//     non-golden extraction has no parser contract → chains are untouched.
//   - FALSY FALL-THROUGH: `a || b || c` returns the LAST operand when every
//     operand is falsy, and `||` skips a falsy-but-DEFINED value (numeric 0,
//     `false`, `''`). A never-produced dropped operand is always `undefined`
//     (falsy). So if the ORIGINAL chain's last operand is dropped, a lone kept
//     `0`/`false` must still fall through to `undefined` to stay byte-identical
//     — preserved with a trailing `|| undefined`. When the last operand is kept,
//     the clean join is already exact (verified in the corpus test with an
//     adversarial numeric-0 battery).
//   - `keepFalsyTail=false` DROPS that trailing `|| undefined` for the cleaner
//     `a || b`. Only pass it where the fall-through is provably unobservable:
//       * a source whose parser is string-only (regex `unstructured`) feeding a
//         leaf whose presence guard already rejects '' (numeric 0/false can't
//         arise, so the only falsy-defined kept value is '' → guard → undefined);
//       * a TRUTHINESS-guarded consumer (`(x) && …` in the CEF extension and the
//         `_time` assembly) where 0/false/undefined all collapse identically.
//     NEVER pass it for the CEF header (`String(__sig)` turns undefined into the
//     text "undefined" but '' into '' — the tail preserves that distinction) or
//     for any JSON/kvp/cef source (see sourceMayEmitNativeFalsy).
const isBareFieldRef = (p: string): boolean => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(p);
export function resolveAliasChainToParser(expr: string, declared: Set<string>, keepFalsyTail = true): string {
  if (!declared.size || !expr.includes('||')) return expr;
  const parts = expr.trim().split('||').map(s => s.trim());
  // Every operand must be a bare field ref (or dotted path) — anything else
  // (literal, call, comparison) means this isn't a pure alias chain → leave it.
  if (parts.length < 2 || !parts.every(isBareFieldRef)) return expr;
  const isDeclared = (p: string) => declared.has(p.split(/[.[]/)[0]);
  const kept = parts.filter(isDeclared);
  if (!kept.length) return expr;
  const lastDropped = !isDeclared(parts[parts.length - 1]);
  return lastDropped && keepFalsyTail ? `${kept.join(' || ')} || undefined` : kept.join(' || ');
}

// Deterministically build the destination mapping from a golden format spec,
// reading the canonical fields the parser produced. No AI. This guarantees a
// repeatable, spec-perfect output for known sourcetypes.
// Routing/metadata fields every golden keep-list retains.
const GOLDEN_ROUTING_FIELDS = new Set(['_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe']);

// Google SecOps UDM: metadata.event_timestamp as {seconds, nanos}, from _time.
// The Cribl Google SecOps destination accepts ONLY that shape and silently
// DROPS any UDM event without it (Cribl engineering test plan;
// the destination's Test tab still reports success — only Status > Dropped
// shows it). Built with the parent-init idiom (`x = cond ? {} : undefined`,
// then dotted leaves), not an object literal. A value that is already numeric
// seconds/nanos is left alone, so this is safe to append after an AI mapping.
export function udmEventTimestampFunctions(): PipelineFunction[] {
  const ms = 'Math.round(Number(_time) * 1000)';
  const ts = 'metadata.event_timestamp';
  const has = `metadata && ${ts} && typeof ${ts}.seconds == 'number' && typeof ${ts}.nanos == 'number'`;
  return [{
    id: 'eval', description: 'Set UDM metadata.event_timestamp {seconds, nanos}',
    conf: { add: [
      { name: ts, value: `metadata && !(${has}) && Number.isFinite(${ms}) ? {} : undefined` },
      { name: `${ts}.seconds`, value: `metadata && ${ts} && typeof ${ts}.seconds != 'number' ? Math.floor(${ms} / 1000) : undefined` },
      { name: `${ts}.nanos`, value: `metadata && ${ts} && typeof ${ts}.nanos != 'number' ? (${ms} % 1000) * 1000000 : undefined` },
    ] },
  }];
}

type GoldenMapEntry = NonNullable<GoldenFormatSpec['canonicalMap']>[number] & { guard?: string };

/**
 * Post-process-only inputs to buildGoldenFormatMapping (an OCSF→destination
 * post pack). Absent for every raw-log build, which therefore stays
 * byte-identical.
 *  - `mapOverlay`: per-pair edits to the resolved canonicalMap — `override`
 *    replaces a leaf's expression (string) or merges fields into it (object),
 *    `drop` removes leaves, `add` appends leaves, `valueRules` adds macros.
 *    It lets the OCSF bridge target columns the shared raw-log map leaves
 *    empty, or read the OCSF device instead of the routing `host`.
 *  - `leftovers`: capture every source value no destination field took, flat
 *    and de-duplicated, in the destination's overflow container.
 *    `reads[canonical]` lists the source paths each canonical name is read
 *    from; `canonical` lists every derived name (never itself a leftover).
 */
export interface GoldenPostOptions {
  mapOverlay?: {
    override?: Record<string, string | Partial<GoldenMapEntry>>;
    drop?: string[];
    add?: GoldenMapEntry[];
    valueRules?: Record<string, string>;
  };
  leftovers?: { reads: Record<string, string[]>; canonical: string[]; sourceFields: string[] };
  /** Evals run right before the map (after the leftover snapshot). */
  bridge?: { name: string; value: string }[];
}

// A source field the bridge or the map overwrites (OCSF `user` → the bridge's
// user string) is copied here first, so its unmapped sub-fields still reach the
// leftovers; the prefix is stripped from the serialized keys afterwards.
const POST_SNAPSHOT_PREFIX = 'gfsnap_';

/** The golden key a key is an alias of (`asim#network` → `asim`), or undefined. */
export function goldenFormatAliasOf(key: string): string | undefined {
  return GOLDEN_FORMATS[key]?.aliasOf;
}

export function applyGoldenMapOverlay(spec: GoldenFormatSpec, overlay: NonNullable<GoldenPostOptions['mapOverlay']>): GoldenFormatSpec {
  const override = overlay.override || {};
  const drop = new Set(overlay.drop || []);
  const added = new Set((overlay.add || []).map(m => m.dest));
  const base = (spec.canonicalMap || []).filter(m => !drop.has(m.dest) && !added.has(m.dest)).map(m => {
    const o = override[m.dest];
    if (o == null) return m;
    return typeof o === 'string' ? { ...m, expr: o } : { ...m, ...o };
  });
  return {
    ...spec,
    canonicalMap: [...base, ...(overlay.add || [])],
    valueRules: { ...(spec.valueRules || {}), ...(overlay.valueRules || {}) },
  };
}

// Never a leftover: the raw copy, the event time, and OCSF's re-derivable
// enum ids / class labels. `*_id` is an OCSF enum (severity_id, activity_id …)
// except inside `unmapped`, where it is vendor data (an ICMP id), hence the
// positive `unmapped.*` before it — the serialize list is first-match-wins.
const POST_LEFTOVER_EXCLUDE = ['raw_data', 'time', 'class_uid', 'category_uid', 'type_uid', 'class_name', 'category_name', 'type_name', 'metadata.version', 'metadata.original_time', 'metadata.logged_time', 'metadata.processed_time', 'metadata.profiles'];

/**
 * The leftover step of a post-process mapping, run after the map. (1) Blank
 * each source path whose value a destination field already carries — compared
 * against the fields that READ it, case-insensitively, so a normalised output
 * (CIM action=blocked from `Refuse`) keeps the vendor value as a leftover
 * instead of losing it. (2) Flatten what remains to dot paths. (3) Serialize it
 * — KVP for CommonSecurityLog, JSON (into `dstField`) otherwise.
 */
function postLeftoverFunctions(
  map: GoldenMapEntry[], rules: Record<string, string> | undefined,
  leftovers: NonNullable<GoldenPostOptions['leftovers']>, snapshotted: Set<string>,
  exclude: Set<string>, type: 'kvp' | 'json', dstField: string,
): PipelineFunction[] {
  const canonical = new Set(leftovers.canonical);
  const live = (path: string) => {
    const root = path.split('.')[0];
    return snapshotted.has(root) ? POST_SNAPSHOT_PREFIX + path : path;
  };
  const readers = new Map<string, Set<string>>();
  for (const m of map) {
    if (m.literalNumber || m.dest.includes('.')) continue;
    const src = stripStringLiterals(resolveExpr(m.expr || '', rules));
    for (const tok of new Set(src.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])) {
      // A snapshotted source field read by its own name (JSON `duration`) reads itself.
      for (const path of leftovers.reads[tok] || (snapshotted.has(tok) ? [tok] : [])) {
        // An output name is never a leftover — unless it was snapshotted: the
        // source value then rides along as `gfsnap_<name>` and must be compared.
        if (canonical.has(path) || (exclude.has(path) && !snapshotted.has(path.split('.')[0]))) continue;
        if (!readers.has(path)) readers.set(path, new Set());
        readers.get(path)!.add(m.dest);
      }
    }
  }
  // A URL part is carried inside a composed URL (`host/path?query`), never equal to it.
  const urlPart = /(^|\.)url\.(path|query_string|hostname|port|scheme)$/;
  const blanks = [...readers].map(([path, dests]) => {
    const p = live(path);
    const same = [...dests].map(d => urlPart.test(path)
      ? `String(${d}).toLowerCase().indexOf(String(${p}).toLowerCase()) >= 0`
      : `String(${p}).toLowerCase() === String(${d}).toLowerCase()`).join(' || ');
    return { name: p, value: `${p} != null && (${same}) ? undefined : ${p}` };
  });
  const fns: PipelineFunction[] = [];
  for (let i = 0; i < blanks.length; i += 15) {
    fns.push({ id: 'eval', description: i === 0 ? 'Drop source values a destination field already carries' : `Drop carried values (cont. ${i + 1})`, conf: { add: blanks.slice(i, i + 15) } });
  }
  fns.push({ id: 'flatten', filter: 'true', description: 'Flatten the remaining source fields to dot paths', conf: { fields: [], prefix: '', depth: 10, delimiter: '.' } });
  // A KVP key cannot hold whitespace (vendor keys like `Logon Information`).
  if (type === 'kvp') fns.push({ id: 'rename', filter: 'true', description: 'Make flattened key names KVP-safe', conf: { baseFields: [], renameExpr: "/\\s/.test(name) ? name.replace(/\\s+/g, '_') : name", rename: [] } });
  const neverLeft = [...POST_LEFTOVER_EXCLUDE, ...canonical, ...exclude].map(f => `!${f}`);
  fns.push({
    id: 'serialize', filter: 'true',
    description: type === 'kvp' ? `Capture unmapped fields → ${dstField} (KVP)` : `Capture unmapped fields → ${dstField}`,
    conf: { type, dstField, fields: ['!__*', '!cribl_*', ...neverLeft, 'unmapped.*', '!*_id', '*'] },
  });
  if (snapshotted.size) {
    const re = type === 'kvp' ? `/(^| )${POST_SNAPSHOT_PREFIX}/g, '$1'` : `/"${POST_SNAPSHOT_PREFIX}/g, '"'`;
    fns.push({ id: 'eval', description: 'Restore source names of snapshotted fields', conf: { add: [{ name: dstField, value: `${dstField} ? ${dstField}.replace(${re}) : ${dstField}` }] } });
  }
  return fns;
}

/**
 * The source top-level fields (`leftovers.sourceFields`) the bridge or the map
 * overwrites — see POST_SNAPSHOT_PREFIX. An alias name is not one: the alias
 * step already replaced it, and its value is the mapped one.
 */
function postSnapshotNames(map: GoldenMapEntry[], post: GoldenPostOptions): Set<string> {
  const source = new Set(post.leftovers?.sourceFields || []);
  const bridge = new Set((post.bridge || []).map(b => b.name));
  const aliases = new Set((post.leftovers?.canonical || []).filter(n => !bridge.has(n)));
  const written = new Set<string>([...map.map(m => m.dest.split('.')[0]), ...bridge]);
  return new Set([...written].filter(n => source.has(n) && !aliases.has(n) && !GOLDEN_ROUTING_FIELDS.has(n)));
}

export function buildGoldenFormatMapping(sourcetypeRaw: string, destFormat: string, outputSourcetype?: string, sampleEvents?: string, extractedFields: string[] = [], keepUnmapped = false, postProcess = false, resolveAliases = true, post: GoldenPostOptions = {}): PipelineFunction[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  // The emitted `sourcetype` field: batch keeps the user's explicit selection
  // verbatim; interactive recognition emits the official Splunk source-native
  // name. See resolveOutputSourcetype.
  const outSourcetype = resolveOutputSourcetype(outputSourcetype, sourcetypeRaw, sourcetype);
  // XSIAM is not a field-mapping schema. Its content-pack parser expects the
  // source-native payload plus routing tags resolved from the UUID/Demisto XIF
  // catalog. Bypass the generic mapping builder entirely.
  if (destFormat === 'xsiam') return buildXsiamTagging(sourcetype, sampleEvents);
  // Passthrough forwards events unchanged — no field mapping at all.
  if (destFormat === 'passthrough') return [];
  // Sample-aware: the `#dataClass` schema variant is chosen from the sample when
  // one is present, so the mapping matches what the source actually carries.
  const resolvedSpec = resolveGoldenFormat(destFormat, sourcetype, sampleEvents);
  if (!resolvedSpec) return [];
  const spec = postProcess && post.mapOverlay ? applyGoldenMapOverlay(resolvedSpec, post.mapOverlay) : resolvedSpec;
  const rules = spec.valueRules;
  // Per-sourcetype field contract used to collapse portable alias chains down to
  // the operand(s) that can actually be PRESENT at runtime (see
  // resolveAliasChainToParser). Empty for AI/non-golden sources → chains stay
  // intact. An operand is kept if it is ANY of:
  //   - a field this sourcetype's parser emits (getParserFieldNames);
  //   - a field this builder always injects (vendor/product/version, set below);
  //   - an event builtin (_time/_raw/host/sourcetype);
  //   - a field the mapping ITSELF produces — a later leaf's chain can fall back
  //     to an earlier leaf's dest (CIM `query = query || dns_query || … || name`
  //     reads the already-set `name`); dropping it would change output.
  // Keeping a possibly-present operand is always byte-identical-safe; only
  // DROPPING a present operand can diverge. So we only ever drop operands that
  // are provably never present (the portable-but-dead vendor aliases) — proven
  // byte-identical in tests/alias-chain-resolution-test.mjs.
  const producedNames = new Set<string>();
  for (const m of (spec.canonicalMap || [])) {
    producedNames.add(m.dest.split('.')[0]);
    producedNames.add(m.dest);
  }
  // A post-process build has no parser: its contract is the canonical names the
  // caller's alias step produced (`extractedFields`). Without them every chain
  // collapsed to its one always-declared operand — the routing `host`.
  const declaredFields = resolveAliases
    ? new Set([...getParserFieldNames(sourcetype), ...(postProcess ? extractedFields : []), 'vendor', 'product', 'version', '_time', '_raw', 'host', 'sourcetype', ...producedNames])
    : new Set<string>();
  // Whether a resolved chain keeps its trailing `|| undefined` fall-through. The
  // presence-guarded leaf can drop it for a string-only (regex `unstructured`)
  // source — its guard already maps the only possible falsy-defined value ('') to
  // undefined. A JSON/kvp/cef source may carry a real 0/false the guard admits, so
  // the tail stays. Truthiness-guarded sites (CEF ext, _time) always pass false;
  // the CEF header (String()-wrapped) always keeps it. See resolveAliasChainToParser.
  const leafKeepTail = !resolveAliases || sourceMayEmitNativeFalsy(sourcetype);
  const resolveChain = (e: string, keepFalsyTail = true) => resolveAliasChainToParser(e, declaredFields, keepFalsyTail);
  const functions: PipelineFunction[] = [];

  // Vendor/product/version so specs can reference `vendor`/`product`/`version`.
  // In POST-PROCESS mode the caller (buildPostProcessFunctions) has already set
  // vendor/product/version from the source schema's own metadata — do not clobber
  // those real values with a per-sourcetype constant.
  const V = getCefVendorInfo(sourcetype);
  // A CEF source carries its vendor in the header, so the constant must not
  // clobber what the parser already read off the wire (cefVendorExpressions).
  // CommonSecurityLog takes the identity Sentinel content filters on instead.
  const cslId = destFormat === 'commonsecuritylog' && SENTINEL_CSL_IDENTITY[canonicalizeSourcetype(sourcetype)] ? sentinelCslIdentity(sourcetype) : null;
  const VE = cslId
    ? { vendor: `'${cslId.vendor.replace(/'/g, "\\'")}'`, product: `'${cslId.product.replace(/'/g, "\\'")}'`, version: `'${cslId.version}'` }
    : cefVendorExpressions(sourcetype);
  if (!postProcess) {
    functions.push({
      id: 'eval', description: 'Set device vendor/product/version',
      conf: { add: [
        { name: 'vendor', value: VE.vendor },
        { name: 'product', value: VE.product },
        { name: 'version', value: VE.version },
      ] },
    });
  }

  if (spec.outputShape === 'raw' && spec.header && spec.extension) {
    // CEF-style: build header + space-separated key=value extension into _raw.
    const h = spec.header;
    // Header identity: a curated source inlines its constant exactly as before;
    // a header-derived source re-emits the Device Vendor/Product/Version it read.
    const hdrIdentity = postProcess || !cefHeaderCarriesVendor(sourcetype)
      ? `'${h.prefix}|${V.vendor}|${V.product}|${V.version}|'`
      : `'${h.prefix}|' + String(${VE.vendor}) + '|' + String(${VE.product}) + '|' + String(${VE.version}) + '|'`;
    functions.push({
      id: 'eval', description: 'Build CEF header',
      conf: { add: [
        { name: '__sig', value: resolveChain(resolveExpr(h.signatureId, rules)) },
        { name: '__name', value: resolveChain(resolveExpr(h.name, rules)) },
        { name: '__sev', value: resolveChain(resolveExpr(h.severity, rules)) },
        { name: '__hdr', value: `${hdrIdentity} + String(__sig) + '|' + String(__name) + '|' + String(__sev) + '|'` },
        { name: '__ext', value: "''" },
      ] },
    });
    // Extension in chunks of 6.
    const ext = spec.extension;
    for (let i = 0; i < ext.length; i += 6) {
      const chunk = ext.slice(i, i + 6);
      const adds = chunk.map(e => {
        const src = resolveChain(resolveExpr(e.expr, rules), false); // `(src) &&` guard drops all falsy → tail unobservable
        // epochMillis: emit epoch ms. Handles a value that's ALREADY numeric
        // epoch (ms=13 digits, s=10 digits, with or without a fractional-second
        // suffix) as well as a parseable date string.
        const epochMs = epochMsExpr(src);
        let valExpr = e.transform === 'epochMillis'
          ? `String(${epochMs} || '')`
          : e.maxLen ? `String(${src}).substring(0, ${e.maxLen})`
          : `String(${src})`;
        // Presence condition — value must be truthy AND not the literal strings
        // "undefined"/"null"/"-" (which upstream evals can leave as text), AND
        // any extra guard (e.g. only emit ICMP type/code on icmp transport).
        const present = `(${src}) && String(${src}) != 'undefined' && String(${src}) != 'null' && String(${src}) != '-'`;
        const cond = e.guard ? `${present} && (${e.guard})` : present;
        // Only append when present; include label pairs together.
        const pair = e.labelKey && e.label
          ? `${cond} ? __ext + '${e.key}=' + ${valExpr} + ' ${e.labelKey}=${e.label} ' : __ext`
          : `${cond} ? __ext + '${e.key}=' + ${valExpr} + ' ' : __ext`;
        return { name: '__ext', value: pair };
      });
      functions.push({ id: 'eval', description: i === 0 ? 'Build CEF extension' : `CEF extension (cont. ${i + 1})`, conf: { add: adds } });
    }
    // Set _time from the parsed timestamp so events don't default to pipeline
    // processing time (a common validator ding).
    const timeSrc = spec.timeField ? resolveChain(resolveExpr(spec.timeField, rules), false) : null; // `(ts) &&` guard → tail unobservable
    const assembleAdds: { name: string; value: string }[] = [
      { name: '_raw', value: '__hdr + __ext.trim()' },
      { name: 'sourcetype', value: `'${outSourcetype}'` },
    ];
    if (timeSrc) {
      // _time in epoch SECONDS. Accept already-numeric epoch (ms/s, with or
      // without a fractional-second suffix) or a date string.
      const ms = epochMsExpr(timeSrc);
      assembleAdds.push({ name: '_time', value: `(${timeSrc}) && ${ms} ? ${ms} / 1000 : _time` });
    }
    functions.push({
      id: 'eval', description: 'Assemble CEF _raw + set _time + sourcetype',
      conf: { add: assembleAdds },
    });
    functions.push({
      id: 'eval', description: 'Keep only CEF _raw + routing (strip source fields)',
      // remove:['*'] does NOT strip __-prefixed fields (Cribl treats them as
      // internal), so the CEF temp fields must be removed explicitly or they
      // leak into every output event alongside _raw.
      conf: { remove: ['__sig', '__name', '__sev', '__hdr', '__ext', '*'], keep: ['_raw', '_time', 'cribl_breaker', 'cribl_pipe', 'index', 'source', 'sourcetype', 'host'] },
    });
    return functions;
  }

  // flat / nested: emit destField = expr. Chunk into groups of 15.
  const map = spec.canonicalMap || [];
  const outputFields = new Set<string>();
  const udmRepeated = new Set(spec.udm?.repeated || []);
  // Post-process: snapshot the OCSF objects the mapping is about to overwrite
  // (a CIM `user` dest replaces the OCSF `user` object) so the leftover step can
  // still report them, then bridge canonical spellings the target map reads.
  const snapshotted = postProcess && post.leftovers ? postSnapshotNames(map, post) : new Set<string>();
  if (snapshotted.size) {
    functions.push({ id: 'eval', description: 'Snapshot source fields the mapping overwrites', conf: { add: [...snapshotted].map(n => ({ name: POST_SNAPSHOT_PREFIX + n, value: n })) } });
  }
  if (postProcess && post.bridge?.length) {
    functions.push({ id: 'eval', description: 'Bridge canonical field spellings for downstream mapping', conf: { add: post.bridge } });
  }

  // NESTED OBJECTS: Cribl eval `add` with a dotted name (`api.operation`) is
  // DROPPED unless its parent object already exists on the event. So for every
  // dotted dest, first create each intermediate object `{}` (parent-first),
  // then assign the leaves. Ordered init entries precede the leaf assignments
  // in the SAME eval sequence — the working idiom from hand-built OCSF pipelines
  // (traffic={}, traffic.bytes=…; src_endpoint={}, src_endpoint.owner={}, …).
  // Compute the parent-object set from the dest NAMES first (before building
  // values), so leaf assembly below can account for name collisions.
  const parents: string[] = [];
  const seenParent = new Set<string>();
  for (const m of map) {
    const segs = m.dest.split('.');
    for (let d = 1; d < segs.length; d++) {
      const prefix = segs.slice(0, d).join('.');
      if (!seenParent.has(prefix)) { seenParent.add(prefix); parents.push(prefix); }
    }
  }
  // A parent that is ALSO a mapped leaf (rare) must not be zeroed to {} — the
  // leaf assignment wins; drop it from the init list.
  const leafDestNames = new Set(map.map(m => m.dest));
  const parentInits = parents.filter(p => !leafDestNames.has(p));

  // NAME COLLISION: a canonical INPUT field can share a name with a golden
  // OUTPUT object — e.g. Sysmon's `process` (the image path) vs OCSF's `process`
  // object (process.name, process.pid, …). The parent-init `process = {}` would
  // clobber the input BEFORE its leaves read it, and `process.name = process`
  // then points at its own {} parent → circular ref → the event fails to
  // serialize and is DROPPED. Snapshot every top-level parent-object name that a
  // leaf expression reads into a temp `gfsrc_tmp_<name>` BEFORE zeroing it, and
  // rewrite those leaf SOURCES to read the snapshot. Temps aren't in
  // outputFields, so the keep-list cleanup strips them from the output. (Plain
  // name, NOT `__`-prefixed: Cribl protects `__` fields from removal.)
  // Whole-word, quote-aware replacement so we never touch a field name that
  // appears inside a string literal (e.g. ECS `event.kind = 'event'`).
  // stripQuoted / replaceIdent (ocsf-finalize) treat string AND regex literals as opaque.
  const topParents = parentInits.filter(p => !p.includes('.'));
  const aliasFor = new Map<string, string>();
  for (const p of topParents) {
    const wordRe = new RegExp(`\\b${p}\\b`);
    const collides = map.some(m => !m.literalNumber && wordRe.test(stripQuoted(resolveChain(resolveExpr(m.expr, rules)))));
    if (collides) aliasFor.set(p, `gfsrc_tmp_${p}`);
  }

  // Compute each leaf's dest + value AND its standalone presence expression, so
  // the parent-object init below can be gated on "does any descendant leaf carry
  // real data" (see the conditional-parent-init note further down).
  const leafInfo = map.map(m => {
    let value: string;
    let present: string; // boolean expr: does this leaf emit a real value?
    if (m.literalNumber) {
      value = m.expr; // already a number literal → always emitted
      present = 'true';
    } else {
      let src = resolveChain(resolveExpr(m.expr, rules), leafKeepTail);
      for (const [p, alias] of aliasFor) src = replaceIdent(src, p, alias);
      // Presence guard: emit `undefined` (Cribl omits the field) when the source
      // is absent or a junk literal, so we never leak dest_zone='undefined' or
      // Number(undefined)→NaN→null translated ports. `!= null` keeps a real 0.
      present = presentExpr(src);
      if ((m as any).guard) present = `${present} && (${(m as any).guard})`;
      const scalar = m.number ? `Number(${src})` : spec.udm ? `String(${src})` : `(${src})`;
      const emit = udmRepeated.has(m.dest) ? `[${scalar}]` : scalar;
      value = `${present} ? ${emit} : undefined`;
    }
    outputFields.add(m.dest.split('.')[0]);
    return { name: m.dest, value, present };
  });
  const leafAdds = leafInfo.map(({ name, value }) => ({ name, value }));

  // CONDITIONAL PARENT INIT: a nested spec must pre-create each parent object so
  // dotted leaves can be assigned (Cribl drops a dotted `add` whose parent is
  // absent). But an unconditional `parent = {}` leaks an empty `{}` when the
  // source carries none of that parent's leaves (Linux auditd has no
  // src_endpoint/dst_endpoint/file/reg_key/query that the Sysmon-shaped
  // ocsf#endpoint spec defines) — noise in the output AND counted as an
  // unpopulated expected field by the golden-spec scorer. A post-hoc prune can't
  // fix this: Cribl's eval `add` treats a value of `undefined` as "leave the
  // field unchanged", so re-setting an already-created `{}` to `undefined` is a
  // no-op. Instead, create the parent ONLY when at least one descendant leaf is
  // present: `parent = (leafA_present || leafB_present || ...) ? {} : undefined`.
  // Parents are ordered shallow-first, and an ancestor's presence OR ⊇ a child's,
  // so whenever a child object is created its ancestor is too (no orphaned add).
  const parentInitAdds = parentInits.map(p => {
    const prefix = p + '.';
    const descendantPresence = leafInfo
      .filter(l => l.name.startsWith(prefix))
      .map(l => `(${l.present})`);
    // Every parent prefix originates from a leaf dest, so there is always ≥1.
    const guard = descendantPresence.length ? descendantPresence.join(' || ') : 'false';
    return { name: p, value: `(${guard}) ? {} : undefined` };
  });
  const snapshots = [...aliasFor].map(([p, alias]) => ({ name: alias, value: p }));
  // UDM: a source field named like a UDM noun (Okta's `target` array) survives
  // a parent init that evaluates to undefined and ships as a malformed noun.
  // Snapshot what the leaves read, then remove the source copies before mapping.
  // ECS has the same collision (SonicWall's `rule` string vs the ECS `rule`
  // object, an empty Sophos `source`), and there the routing `source`/`host` are
  // ECS objects too: Elasticsearch rejects a scalar where it maps an object.
  const clearedParents = spec.udm ? topParents.filter(p => !GOLDEN_ROUTING_FIELDS.has(p))
    : spec.cleanup?.clearObjectCollisions ? topParents : [];
  if (clearedParents.length) {
    const noun = spec.udm ? 'UDM nouns' : `${spec.label} objects`;
    if (snapshots.length) functions.push({ id: 'eval', description: `Snapshot source fields named like ${noun}`, conf: { add: snapshots.splice(0) } });
    functions.push({ id: 'eval', description: `Clear source fields named like ${noun}`, conf: { remove: clearedParents } });
  }
  const adds = [...snapshots, ...parentInitAdds, ...leafAdds];
  for (let i = 0; i < adds.length; i += 15) {
    const chunk = adds.slice(i, i + 15);
    functions.push({ id: 'eval', description: i === 0 ? `Map canonical fields → ${spec.label}` : `Map (cont. ${i + 1})`, conf: { add: chunk } });
  }
  // Set sourcetype + _time (from the spec's timeField) so events don't default
  // to pipeline processing time. Post-process mode PRESERVES the incoming
  // sourcetype (the upstream pack already set it) — it only re-derives _time.
  const flatFinal: { name: string; value: string }[] = postProcess ? [] : [{ name: 'sourcetype', value: `'${outSourcetype}'` }];
  if (spec.timeField) {
    const ts = resolveChain(resolveExpr(spec.timeField, rules), false); // `(ts) &&` guard → tail unobservable
    const ms = epochMsExpr(ts);
    // When the spec already maps OCSF `time` (epoch ms), derive _time from it
    // instead of parsing the timestamp a second time. `> 1e11` (epoch ms) ignores
    // a source field that happens to be called `time` when the map left it alone.
    const mapsOcsfTime = spec.outputShape === 'nested' && map.some(m => m.dest === 'time' && /ocsfTime/.test(m.expr));
    flatFinal.push({ name: '_time', value: mapsOcsfTime
      ? 'Number.isFinite(time) && time > 1e11 ? time / 1000 : _time'
      : `(${ts}) && ${ms} ? ${ms} / 1000 : _time` });
  }
  if (flatFinal.length) functions.push({ id: 'eval', description: 'Set sourcetype + _time', conf: { add: flatFinal } });
  if (spec.udm) {
    // After _time is final (it carries the event time), and after every dotted
    // leaf: Cribl drops a dotted add into an array, so the repeated-message
    // wrap must be the last write to those objects.
    functions.push(...udmEventTimestampFunctions());
    // A repeated message may sit mid-path (network.dns.questions), not only top-level.
    const wraps = (spec.udm.repeatedMessages || []).filter(p => map.some(m => m.dest === p || m.dest.startsWith(p + '.')));
    if (wraps.length) {
      functions.push({ id: 'eval', description: 'Wrap repeated UDM messages as arrays', conf: { add: wraps.map(p => ({ name: p, value: `${p} && !Array.isArray(${p}) ? [${p}] : undefined` })) } });
    }
  }

  // Cleanup — keep only the mapped output (+ _raw per spec) and routing.
  // Keep exact top-level dest key AND its dotted children (`f` + `f.*`), but
  // NOT underscore-siblings: a bare `${f}*` glob would also keep the canonical
  // INPUT `api_operation` (sibling of dest `api`) / `resource_name` (sibling of
  // `resource`), leaking parse-stage fields into the output. Listing both `f`
  // and `f.*` retains flat CIM fields and nested OCSF subtrees cleanly.
  const keep = [...GOLDEN_ROUTING_FIELDS,
    ...[...outputFields].flatMap(f => [f, `${f}.*`])];
  if (spec.cleanup?.keepRaw) keep.push('_raw');

  // CIM "keep unmapped source fields in _raw" passthrough. Only for the CIM
  // _raw-rebuild shape (serializeRaw): add the extracted source fields the
  // mapping didn't consume to the keep-list so they survive remove:['*'] and get
  // folded into the rebuilt _raw JSON below (the final metadata-only cleanup then
  // strips them from the top level). `consumed` = the mapped dest fields + every
  // canonical input the mapping expressions reference (resolved through the
  // spec's valueRules so rule-indirected fields count), mirroring how the CSL
  // AdditionalExtensions capture computes genuinely-unmapped source data.
  if (keepUnmapped && spec.cleanup?.serializeRaw && extractedFields.length > 0) {
    const canonicalInputs = new Set<string>();
    for (const m of map) {
      const src = resolveExpr(m.expr || '', rules);
      for (const tok of src.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) canonicalInputs.add(tok);
    }
    keep.push(...unmappedSourceFields(extractedFields, new Set([...outputFields, ...canonicalInputs])));
  }
  // A post-process build maps `message` from the OCSF event; its _raw is the
  // OCSF JSON, not an original log, and would overwrite it.
  if (spec.cleanup?.rawToMessage && !(postProcess && map.some(m => m.dest === 'message'))) {
    functions.push({ id: 'eval', description: 'Preserve original log in message', conf: { add: [{ name: 'message', value: '_raw' }] } });
    keep.push('message');
  }
  // CommonSecurityLog: capture every extracted field that has NO CSL column into
  // the schema's `AdditionalExtensions` column as JSON, so no source data is lost.
  // Serialize top-level fields EXCEPT the mapped dest fields, routing, and the
  // canonical input fields (which the cleanup drops anyway). `fields` negation
  // (`!x`) excludes; whatever remains is the leftover source data.
  if (destFormat === 'commonsecuritylog') {
    // Exclude: the mapped CSL dest fields, routing, vendor/product/version, AND
    // the canonical INPUT fields the mapping already read (src_ip, dest_ip,
    // log_time, bytes_*, transport, …) so AdditionalExtensions holds only the
    // genuinely-unmapped source data, not duplicates of what CSL columns hold.
    //
    // A mapped column's expr may be a RULE NAME (`LogSeverity <=
    // cefSeverityFromLevel`, `TimeGenerated <= sentinelTimeGenerated`) rather
    // than a raw field. Tokenizing the bare expr would miss the fields the rule
    // actually consumes (severity, level, log_time, _time), so those leaked into
    // AdditionalExtensions as duplicates of a column that already holds them.
    // Resolve the expr through the spec's valueRules FIRST, then tokenize, so a
    // field used by any mapped column is excluded regardless of indirection.
    const canonicalInputs = new Set<string>();
    for (const m of map) {
      const src = resolveExpr(m.expr || '', rules);
      for (const tok of src.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) canonicalInputs.add(tok);
    }
    const exclude = new Set<string>([
      ...outputFields, ...canonicalInputs, '_raw', '_time', 'index', 'source', 'sourcetype', 'host',
      'cribl_breaker', 'cribl_pipe', 'vendor', 'product', 'version', 'AdditionalExtensions',
    ]);
    // Serialize as KVP (`key=value key2=value2`), NOT JSON. AdditionalExtensions
    // is CEF's native extension format; a JSON string here becomes a
    // backslash-escaped JSON-in-JSON blob once the whole event is serialized for
    // the Sentinel API. KVP keeps it flat and readable with no escaping.
    // `!__*` drops Cribl's internal control fields (__criblEventType, __id, …).
    if (postProcess && post.leftovers) {
      // Post-process: only values no mapped column already holds, flattened.
      functions.push(...postLeftoverFunctions(map, rules, post.leftovers, snapshotted, exclude, 'kvp', 'AdditionalExtensions'));
    } else {
      functions.push({
        id: 'serialize', filter: 'true', description: 'Capture unmapped fields → AdditionalExtensions (KVP)',
        // `!future_use*` drops PAN-OS positional CSV placeholder columns (future_use1
        // often carries the syslog-header prefix) — junk, not real source data.
        conf: { type: 'kvp', dstField: 'AdditionalExtensions', fields: ['!__*', '!cribl_*', '!future_use*', ...[...exclude].map(f => `!${f}`), '*'] },
      });
    }
    keep.push('AdditionalExtensions');
  }
  // Post-process leftovers for the other flat families: ASIM's dynamic
  // AdditionalFields column, a Clean-JSON `additional_fields` object, or extra
  // keys merged into CIM's JSON _raw (Splunk extracts them at search time).
  const leftoverObject = !postProcess || !post.leftovers || destFormat === 'commonsecuritylog' ? null
    : isAsimFormat(destFormat) ? 'AdditionalFields'
    : spec.cleanup?.serializeRaw ? '_raw'
    : destFormat === 'json' ? 'additional_fields' : null;
  if (leftoverObject && post.leftovers) {
    const canonicalInputs = new Set<string>();
    for (const m of map) {
      const src = resolveExpr(m.expr || '', rules);
      for (const tok of src.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) canonicalInputs.add(tok);
    }
    const exclude = new Set<string>([
      ...outputFields, ...canonicalInputs, '_raw', '_time', 'index', 'source', 'sourcetype', 'host',
      'cribl_breaker', 'cribl_pipe', 'vendor', 'product', 'version', leftoverObject,
    ]);
    functions.push(...postLeftoverFunctions(map, rules, post.leftovers, snapshotted, exclude, 'json', '__left'));
  }
  // A Sentinel table (CommonSecurityLog, ASim*) takes its DCR column types, not
  // the source's: cast before the keep-list (see sentinelColumnCoercionFunctions).
  functions.push(...sentinelColumnCoercionFunctions(sentinelTableForFormat(destFormat), outputFields));
  // The Windows OCSF dispatcher (source-recognition.ts windowsOcsfDispatchFn)
  // leaves its scratch `__ocsf_*` fields on the event for EVERY destination
  // format built from this extraction (CIM/ECS/CEF/OCSF/...), not only the
  // `ocsf@windows_*` goldens that read them. `remove:['*']` below does NOT
  // strip `__`-prefixed names (Cribl protects them from WILDCARD removal), so
  // without this they would leak into every mapped output for these 6
  // sourcetypes. List each exact name (no `*`) so the protection does not apply.
  const removeList = ['*', ...(getParserFieldNames(sourcetype).includes('__ocsf_class_uid') ? WINDOWS_OCSF_DISPATCH_FIELDS : [])];
  functions.push({
    id: 'eval', description: `Keep only ${spec.label} fields + routing`,
    // Collision snapshots use a plain `gfsrc_tmp_*` name (NOT `__`-prefixed:
    // Cribl protects `__` fields from removal), so they aren't in the keep-list
    // and this `remove:['*']` strips them from the mapped output.
    conf: { remove: removeList, keep },
  });
  // The leftover object is built AFTER the keep-list: live, `remove:['*']` empties
  // a kept object whose keys contain dots (`device.ip`), even though the object
  // itself is kept. `__left` is removed by exact name (wildcards skip `__*`).
  if (leftoverObject && leftoverObject !== '_raw') {
    functions.push({
      id: 'eval', description: `Unmapped fields → ${leftoverObject}`,
      conf: { add: [{ name: leftoverObject, value: "__left && __left != '{}' ? JSON.parse(__left) : undefined" }], remove: ['__left'] },
    });
  }
  // serializeRaw: rebuild _raw as compact JSON of the mapped fields (CIM), then
  // DROP those fields from the top level. Splunk's model (and HEC): only the
  // metadata fields — _time, index, source, sourcetype, host — stay as top-level
  // (indexed) fields; everything else lives in _raw and is search-time extracted.
  // Leaving the CIM fields ALSO at the top level duplicates every value (once as
  // an indexed field, once in _raw JSON), bloating the index — which is exactly
  // the wrong CIM shape. So: serialize the CIM fields into _raw, then keep only
  // _raw + the 5 metadata fields (+ cribl routing internals).
  if (spec.cleanup?.serializeRaw) {
    functions.push({
      id: 'serialize', filter: 'true',
      description: 'Rebuild _raw as compact JSON of mapped fields',
      conf: {
        type: 'json', dstField: '_raw',
        fields: ['!_raw', '!_time', '!index', '!source', '!sourcetype', '!host', '!cribl_breaker', '!cribl_pipe', '!__*', '!cribl*', '*'],
      },
    });
    if (leftoverObject === '_raw') {
      functions.push({
        id: 'eval', filter: 'true', description: 'Append unmapped fields to the _raw JSON',
        conf: { add: [{ name: '_raw', value: "__left && __left != '{}' ? (_raw == '{}' ? __left : _raw.slice(0, -1) + ',' + __left.slice(1)) : _raw" }] },
      });
    }
    functions.push({
      id: 'eval', filter: 'true',
      description: 'Keep only _raw + Splunk metadata (CIM fields live in _raw)',
      conf: { remove: ['*', ...(leftoverObject === '_raw' ? ['__left'] : [])], keep: ['_raw', '_time', 'index', 'source', 'sourcetype', 'host', 'cribl_breaker', 'cribl_pipe'] },
    });
  }
  return functions;
}

// Strip JS string/template literals so only real identifiers remain — used by
// the synthetic-message check so separator strings ('->', ':', ' ') don't count.
function stripStringLiterals(expr: string): string {
  return expr
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// A `message`/`Message` mapping that concatenates 2+ DISTINCT source fields is a
// synthetic summary — those fields belong in dedicated columns. A single field,
// `field || fallback`, or `field + ' literal'` is legitimate and kept.
const MESSAGE_CONCAT_BUILTINS = new Set([
  'String', 'Number', 'Date', 'JSON', 'Math', 'Boolean', 'Array', 'Object',
  'typeof', 'new', 'null', 'undefined', 'true', 'false', 'toISOString', 'test',
  'parseInt', 'parseFloat', 'toString', 'toFixed',
]);
function isSyntheticMessageConcat(destField: string, expression: string): boolean {
  if (!/^message$/i.test(destField)) return false;
  const noStrings = stripStringLiterals(expression);
  if (!noStrings.includes('+')) return false; // no concatenation → keep
  const idents = (noStrings.match(/[A-Za-z_$][A-Za-z0-9_$.]*/g) || [])
    .filter(t => !MESSAGE_CONCAT_BUILTINS.has(t));
  return new Set(idents).size >= 2;
}

// Columns that are unambiguously an IP address (Sentinel CSL, ASim). NOTE: CIM
// `src`/`dest` are intentionally EXCLUDED — they legitimately hold a hostname.
const IP_COLUMN_NAMES = new Set([
  'DestinationIP', 'SourceIP', 'DestinationIp', 'SourceIp',
  'DstIpAddr', 'SrcIpAddr', 'DstIp', 'SrcIp', 'dest_ip', 'src_ip',
]);
// Wrap an IP-column expression so only an IPv4/IPv6-shaped value passes; a
// URL/hostname yields `undefined` (column absent) instead of polluting the field.
function guardIpColumn(destField: string, value: string): string {
  if (!IP_COLUMN_NAMES.has(destField)) return value;
  const v = `(${value})`;
  return `(/^(\\d{1,3}(\\.\\d{1,3}){3}|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]+)$/.test(String(${v})) ? ${v} : undefined)`;
}

/**
 * Flat source keys that contain a dot or hyphen (Zeek/Corelight `id.orig_h`) are
 * ONE field, readable only as `__e['id.orig_h']`. The AI wrote them as a nested
 * path (`id.orig_h` → undefined, `id` does not exist) or as a bare `['id.orig_h']`
 * (an array literal: the IP column then carried the field NAME). All 25 Corelight
 * packs in the 2026-10-10 packtester audit lost their connection tuple this way.
 * Also: an index whose whole key is a bare field (`map[sev]`) fails live and takes
 * the expression with it, so it is read as `map[__e['sev']]` (audit 2026-10-12).
 */
const BARE_KEY_GLOBALS = new Set(['undefined', 'NaN', 'Infinity', 'true', 'false', 'null']);
export function rewriteFlatDottedReads(expr: string): string {
  const masked = maskQuoted(expr);
  const edits: { at: number; len: number; text: string }[] = [];
  // 1. A single-element `['a.b']` in operand position (not an index, not `['a.b'].x`).
  const lit = /\[\s*(['"])([A-Za-z_][\w]*(?:[.-][\w]+)+)\1\s*\]/g;
  for (let m: RegExpExecArray | null; (m = lit.exec(expr)) !== null;) {
    if (masked[m.index] !== '[') continue;                          // inside a literal
    const before = masked.slice(0, m.index).trimEnd().slice(-1);
    const after = masked.slice(m.index + m[0].length).trimStart()[0];
    if (/[\w$\])]/.test(before) || after === '.' || after === '[' || after === '(') continue;
    edits.push({ at: m.index, len: m[0].length, text: `__e['${m[2]}']` });
  }
  // 2. The Zeek tuple read as a path; drop a now-pointless `id &&` guard.
  const zeek = /(?<![\w$.])(?:id\s*&&\s*)?id\.(orig|resp)_(h|p)\b/g;
  for (let m: RegExpExecArray | null; (m = zeek.exec(masked)) !== null;) {
    edits.push({ at: m.index, len: m[0].length, text: `__e['id.${m[1]}_${m[2]}']` });
  }
  // 3. An index whose whole key is a bare field: `x[k]` → `x[__e['k']]`.
  const bareKey = /([\w$\])])\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g;
  for (let m: RegExpExecArray | null; (m = bareKey.exec(masked)) !== null;) {
    if (m[2] === '__e' || BARE_KEY_GLOBALS.has(m[2])) continue;
    if (expr.slice(m.index, m.index + m[0].length) !== m[0]) continue;   // a masked literal key
    const at = m.index + m[1].length;
    edits.push({ at, len: m[0].length - m[1].length, text: `[__e['${m[2]}']]` });
  }
  if (!edits.length) return expr;
  edits.sort((a, b) => a.at - b.at);
  let out = '', last = 0;
  for (const e of edits) {
    if (e.at < last) continue;
    out += expr.slice(last, e.at) + e.text;
    last = e.at + e.len;
  }
  return out + expr.slice(last);
}

export function buildAiMappingFunctions(aiMappings: AiMappingInput, sourcetypeRaw: string, destFormat: string, outputSourcetype?: string): PipelineFunction[] {
  const sourcetype = canonicalizeSourcetype(sourcetypeRaw);
  // The emitted `sourcetype` field must carry the SOURCE-NATIVE value (e.g.
  // `cisco:asa`), matching buildGoldenFormatMapping. AI mappings almost never
  // set it (or set the canonical form), which left AI-path CIM packs with a
  // wrong sourcetype (fortigate → `fortigate_traffic`) or none at all
  // (corelight/zscaler → undefined). Force it here for every schema format:
  // batch keeps the user's explicit selection, interactive emits the official
  // Splunk source-native name (see resolveOutputSourcetype).
  const outSourcetype = resolveOutputSourcetype(outputSourcetype, sourcetypeRaw, sourcetype);
  const functions: PipelineFunction[] = [];

  // Add class/type identifiers if provided (skip for CEF — classInfo fields are metadata, not CEF extension fields)
  const classFields: { name: string; value: string }[] = [];
  if (aiMappings.classInfo && destFormat !== 'cef') {
    for (const [key, value] of Object.entries(aiMappings.classInfo)) {
      if (value) {
        const v = typeof value === 'number' ? String(value) : `'${value}'`;
        classFields.push({ name: key, value: v });
      }
    }
  }

  // Build the mapping eval from AI-generated mappings
  // For CEF: filter out _raw (we assemble it ourselves) and any expressions over 512 chars
  const mappingFields = aiMappings.mappings
    .filter(m => {
      if (destFormat === 'cef' && m.destField === '_raw') return false;
      if (m.expression.length > 512) return false;
      // Drop dest fields whose name isn't a valid Cribl accessor path
      // (e.g. ECS `@timestamp`) — they break the pipeline at deploy time.
      if (!isSafeFieldName(m.destField)) {
        console.warn(`[pack-builder] Dropping AI mapping with invalid field name: "${m.destField}"`);
        return false;
      }
      // Skip AI expressions that aren't a single Cribl eval expression
      // (multi-statement functions/IIFEs would fail Cribl's jsExpression validation).
      // Normalize '@'-prefixed field refs first (github/ECS `@timestamp`), so a
      // rescuable expression isn't dropped and an unrescuable '@' still is.
      if (!isSafeEvalExpression(stripAtPrefixIdentifiers(stripAtPrefixLiterals(m.expression)))) {
        console.warn(`[pack-builder] Dropping unsafe AI mapping for "${m.destField}": ${m.expression}`);
        return false;
      }
      // P1a: reject a synthetic `message` built by concatenating 2+ distinct
      // source fields (e.g. `src_ip + ':' + src_port + ' -> ' + dest_ip`). Those
      // fields belong in their own dedicated columns, not smushed into a summary
      // string. A single field, a `||` fallback, or `field + literal` is fine.
      if (isSyntheticMessageConcat(m.destField, m.expression)) {
        console.warn(`[pack-builder] Dropping synthetic message concat for "${m.destField}": ${m.expression}`);
        return false;
      }
      return true;
    })
    .map(m => ({
      name: m.destField,
      // P1b: shape-guard IP columns so a URL/hostname never lands in an IP field
      // (users saw a link in DestinationIP). Applied AFTER the safety/length
      // checks above so the guard wrapper isn't itself rejected.
      // A missing value stays missing: `Number(src_port || 0)` is guarded so an
      // event without a port gets no port, not port 0 (see zero-defaults.ts).
      value: guardZeroDefaultFor(m.destField, guardIpColumn(m.destField, escapeReservedWords(rewriteFlatDottedReads(stripAtPrefixIdentifiers(stripAtPrefixLiterals(m.expression)))))),
    }));

  let allFields = [...classFields, ...mappingFields];

  // OCSF (not CEF / NextGen raw-fidelity): Cribl DROPS a dotted add whose parent
  // object is missing, so `src_endpoint.ip`/`metadata.version` silently vanished
  // from 43 AI-mapped packtester packs. Create the parents (snapshotting any
  // same-named source field), pin the targeted class, prune empty objects after,
  // and ground the schema-derivable required attributes. See ocsf-finalize.ts.
  const ocsfStructured = isOcsfFormat(destFormat) && !isNextGenRawFidelityFormat(destFormat)
    ? structureOcsfMappingFields(allFields, destFormat)
    : null;
  if (ocsfStructured) {
    allFields = ocsfStructured.fields;
    for (const n of ocsfStructured.notes) console.warn(`[pack-builder] OCSF AI mapping: ${n}`);
  }

  // `_time` must be correct BEFORE the mapping chunks run, not after them.
  //
  // Destination schemas routinely derive their own time column FROM `_time`
  // (Sentinel `TimeGenerated`, ECS `@timestamp`, …). While this ran after the
  // chunks, those expressions read the pipeline/ingest `_time` and every event got
  // the time the sample was processed instead of the time it happened: pack `aaaaa`
  // (aws_vpc_flow → AWSVPCFlow) shipped TimeGenerated 11:45:28 for a flow that
  // started 11:42:44. STEP 1 (buildLogTimeAliasFn) has already aliased any captured
  // timestamp to `log_time` by now, so this is safe to do first — and it still runs
  // BEFORE the CEF branch's cleanup, which was the original reason for its position.
  //
  // An AI mapping that maps `_time` itself still wins (its chunk runs after): that
  // is an explicit destination mapping, not the "left at pipeline time" bug.
  {
    const logTimeMs = epochMsExpr('log_time');
    functions.push({
      id: 'eval',
      // A time-only or otherwise unparseable log_time (`03:14:27`) keeps the
      // event's _time instead of nulling it (audit 2026-10-12: 16 packs).
      description: 'Set _time from the parsed timestamp (log_time), if one was captured',
      conf: { add: [{ name: '_time', value: `(typeof log_time != 'undefined' && log_time && Number.isFinite(${logTimeMs})) ? ${logTimeMs} / 1000 : _time` }] },
    });
  }

  if (ocsfStructured) functions.push(...(ocsfStructured.pre as PipelineFunction[]));

  // Split into chunks of 15 to avoid overly large eval functions
  const CHUNK_SIZE = 15;
  for (let i = 0; i < allFields.length; i += CHUNK_SIZE) {
    const chunk = allFields.slice(i, i + CHUNK_SIZE);
    const chunkLabel = i === 0 ? 'Map fields to destination schema' : `Map fields (continued ${i + 1}-${i + chunk.length})`;
    functions.push({
      id: 'eval',
      description: chunkLabel,
      conf: { add: chunk },
    });
  }

  if (ocsfStructured) {
    functions.push(...(ocsfStructured.post as PipelineFunction[]));
    const curated = CEF_VENDOR_INFO[sourcetype];
    const grounded = groundOcsfPipeline([], {
      productName: curated?.product || sourcetype.replace(/_/g, ' '),
      vendorName: curated?.vendor,
    });
    functions.push(...(grounded.functions as PipelineFunction[]));
  }

  // The `_time` assignment that used to sit here now runs BEFORE the mapping
  // chunks (see above) so schema time columns can read it.
  {
    // Always emit the source-native sourcetype (Splunk expects `cisco:asa`,
    // `infoblox:dns`, …). AI mappings routinely omit it; without this the
    // top-level sourcetype ends up canonical or undefined.
    functions.push({
      id: 'eval',
      description: 'Set source-native sourcetype',
      conf: { add: [{ name: 'sourcetype', value: `'${outSourcetype.replace(/'/g, "\\'")}'` }] },
    });
  }

  // P0a: Sentinel-family tables REQUIRE a TimeGenerated column. AI mappings
  // routinely omit it (or set a fragile version), which left many Sentinel packs
  // with no TimeGenerated at all. Force the same deterministic expression the
  // golden path uses. Runs AFTER the mapping chunks so it wins over any AI
  // TimeGenerated, and AFTER `_time` is set so the fallback is correct. Skipped
  // for CEF (not a Log Analytics table; the CEF branch below strips fields).
  if (isSentinelFamilyFormat(destFormat) && destFormat !== 'cef') {
    functions.push({
      id: 'eval',
      description: 'Force Sentinel TimeGenerated (required ingest-time column)',
      conf: { add: [{ name: 'TimeGenerated', value: SENTINEL_TIME_GENERATED_EXPR }] },
    });
  }

  // For CEF, assemble the CEF string in _raw and strip all other fields.
  // Template literals with many interpolations fail silently in Cribl eval,
  // so we build the header and extension in separate small steps.
  if (destFormat === 'cef') {
    // Resolve vendor info from the known map or from AI-mapped fields
    const CEF_VENDOR_MAP: Record<string, { vendor: string; product: string; version: string }> = {
      cisco_asa: { vendor: 'Cisco', product: 'ASA', version: '9.x' },
      cisco_firepower: { vendor: 'Cisco', product: 'Firepower', version: '7.x' },
      palo_alto_traffic: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x' },
      palo_alto_threat: { vendor: 'Palo Alto Networks', product: 'PAN-OS', version: '10.x' },
      fortinet_fortigate: { vendor: 'Fortinet', product: 'FortiGate', version: '7.x' },
      checkpoint_firewall: { vendor: 'Check Point', product: 'SmartDefense', version: 'R81' },
      windows_security: { vendor: 'Microsoft', product: 'Windows', version: '10' },
      windows_powershell: { vendor: 'Microsoft', product: 'PowerShell', version: '5.1' },
      windows_sysmon: { vendor: 'Microsoft', product: 'Sysmon', version: '15.x' },
      windows_system: { vendor: 'Microsoft', product: 'Windows', version: '10' },
      windows_application: { vendor: 'Microsoft', product: 'Windows', version: '10' },
      windows_defender: { vendor: 'Microsoft', product: 'Defender Antivirus', version: '4.18' },
      windows_dns_client: { vendor: 'Microsoft', product: 'DNS Client', version: '10' },
      roundcube_mail: { vendor: 'Roundcube', product: 'Webmail', version: '1.6' },
    };
    const vendorInfo = CEF_VENDOR_MAP[sourcetype] || { vendor: sourcetype.replace(/_/g, ' '), product: 'Security', version: '1.0' };
    // A CEF source states its own Device Vendor/Product/Version in the header;
    // reading it back beats a constant guessed from the sourcetype name.
    const VE = cefVendorExpressions(sourcetype);
    const cefIdentity = CEF_VENDOR_MAP[sourcetype] || !cefHeaderCarriesVendor(sourcetype)
      ? `'CEF:0|${vendorInfo.vendor}|${vendorInfo.product}|${vendorInfo.version}|'`
      : `'CEF:0|' + String(${VE.vendor}) + '|' + String(${VE.product}) + '|' + String(${VE.version}) + '|'`;

    // Build the CEF header using known vendor info (not from AI fields).
    // A valid CEF _raw MUST begin with 'CEF:0|' — do NOT prepend a bare host
    // word (that produces invalid 'host CEF:0|...'). Any syslog framing is added
    // by the destination, not embedded here.
    functions.push({
      id: 'eval',
      description: 'Build CEF header string',
      conf: {
        add: [
          { name: '__cef_hdr', value: cefIdentity },
        ],
      },
    });
    functions.push({
      id: 'eval',
      description: 'Complete CEF header with signature, name, severity',
      conf: {
        add: [
          // SignatureID: the source's native code, used verbatim.
          { name: '__cef_sigId', value: "DeviceEventClassID || signatureId || event_type || action || 'event'" },
          // Name: prefer the AI's human-readable Name/Activity; only if BOTH are
          // absent or equal to the code do we humanize the code (never emit the
          // bare code as Name — that gives 'sigId|sigId').
          { name: '__cef_name_raw', value: "Name || Activity || ''" },
          { name: '__cef_name', value: "__cef_name_raw && String(__cef_name_raw) != String(__cef_sigId) && String(__cef_name_raw).length < 60 ? String(__cef_name_raw) : (action ? String(action) + ' event' : 'Event')" },
          // Severity: prefer the AI's LogSeverity (0-10). If absent, derive from
          // the parsed ASA/syslog severity LEVEL (0-7, LOWER = more severe) via
          // inversion to CEF's 0-10 (HIGHER = more severe). Never hardcode.
          { name: '__cef_sev', value: "String(Number(LogSeverity) >= 0 && Number(LogSeverity) <= 10 && LogSeverity != null ? Number(LogSeverity) : (severity != null && severity !== '' ? Math.max(0, Math.min(10, 10 - Number(severity) * 1.3)) : 5))" },
          { name: '__cef_hdr', value: "__cef_hdr + String(__cef_sigId) + '|' + String(__cef_name) + '|' + String(Math.round(Number(__cef_sev))) + '|'" },
        ],
      },
    });

    // Build the extension by iterating mapped fields into key=value pairs.
    // We collect all non-header, non-internal fields from the AI mappings.
    const cefHeaderFields = new Set([
      '__host', '__cef_vendor', '__cef_product', '__cef_version', '__cef_id',
      '__cef_name', '__cef_severity', '__cef_hdr', '__cef_ext', '__cef_sigId', '__cef_sev',
      'DeviceVendor', 'DeviceProduct', 'DeviceVersion', 'DeviceEventClassID',
      'Activity', 'LogSeverity', 'deviceVendor', 'deviceProduct', 'deviceVersion',
      'signatureId', 'name', 'severity', 'cefVersion',
    ]);
    // Collect extension field names from AI mappings — exclude header fields, internal fields, and _raw
    const cefExcludeFields = new Set([
      '_raw', '_time', 'event_type', 'class_uid', 'category_uid',
      'sourcetype', 'host', 'source', 'index', 'cribl_pipe', 'cribl_breaker',
      'Severity', 'LogSeverity', 'severity', 'log_level',
      'Name', 'Activity', 'SignatureID', 'DeviceEventClassID',
    ]);
    const allExtCandidates = aiMappings.mappings
      .map(m => m.destField)
      .filter(f => !cefHeaderFields.has(f) && !f.startsWith('__') && !f.startsWith('_') && !cefExcludeFields.has(f));
    // Remove unpaired DeviceCustomStringNLabel without corresponding DeviceCustomStringN (and vice versa)
    const extFieldSet = new Set(allExtCandidates);
    const extFields = allExtCandidates.filter(f => {
      if (f.endsWith('Label') && f.startsWith('DeviceCustom')) {
        const valueField = f.replace(/Label$/, '');
        return extFieldSet.has(valueField);
      }
      if (f.startsWith('DeviceCustom') && !f.endsWith('Label')) {
        const labelField = f + 'Label';
        return extFieldSet.has(labelField);
      }
      return true;
    });

    // Build extension — only include fields that have values (skip empty)
    // Initialize __cef_ext, then conditionally append each field
    functions.push({
      id: 'eval',
      description: 'Initialize CEF extension',
      conf: { add: [{ name: '__cef_ext', value: "''" }] },
    });

    const EXT_CHUNK = 6;
    for (let i = 0; i < extFields.length; i += EXT_CHUNK) {
      const chunk = extFields.slice(i, i + EXT_CHUNK);
      const adds: { name: string; value: string }[] = [];
      for (const field of chunk) {
        const fieldAccess = JS_RESERVED_FIELDNAMES.has(field) ? `__e['${field}']` : field;
        // Only append if the field has a value
        adds.push({ name: '__cef_ext', value: `${fieldAccess} ? (__cef_ext ? __cef_ext + ' ' : '') + '${field}=' + String(${fieldAccess}) : __cef_ext` });
      }
      functions.push({
        id: 'eval',
        description: i === 0 ? 'Build CEF extension key=value pairs' : `CEF extension (continued ${i + 1}-${i + chunk.length})`,
        conf: { add: adds },
      });
    }

    // Final assembly: _raw = header + extension
    functions.push({
      id: 'eval',
      description: 'Assemble final CEF _raw',
      conf: {
        add: [
          { name: '_raw', value: "__cef_hdr + __cef_ext" },
        ],
      },
    });
    functions.push({
      id: 'eval',
      description: 'Remove all parsed fields — keep only CEF _raw',
      conf: {
        remove: ['*'],
        keep: ['_raw', '_time', 'cribl_breaker', 'cribl_pipe', 'index', 'source', 'sourcetype', 'host'],
      },
    });
  }

  return functions;
}

function buildPipelineConfWithMappings(state: WizardState, sourcetype: string, reductionToggles: Record<string, boolean>, allowCodeFunctions: boolean, aiMappings?: AiMappingInput | null, aiParseFunctions?: PipelineFunction[] | null, prebuiltFunctions?: PipelineFunction[] | null) {
  const formatLabel = getFormatLabel(state);
  // Post-processing packs (e.g. OCSF→CEF) supply a fully-built function list and
  // skip the sourcetype parse/map assembly entirely — see src/postprocess-builder.ts.
  const functions = (prebuiltFunctions && prebuiltFunctions.length)
    ? prebuiltFunctions
    : buildPipelineFunctionsWithMappings(sourcetype, state.destFormat, state.manualFormat, reductionToggles, allowCodeFunctions, aiMappings, aiParseFunctions, state.sampleEvents);

  return {
    output: 'default',
    streamtags: [] as string[],
    groups: {},
    asyncFuncTimeout: 1000,
    functions: functions.map(f => {
      const entry: Record<string, unknown> = {
        id: f.id,
        filter: f.filter || 'true',
        conf: f.conf,
      };
      // Preserve `disabled: null` on XSIAM replay. Omit the key when the mirror
      // omitted it — writing `false` would fail byte-identity.
      if (f.disabled !== undefined) entry.disabled = f.disabled;
      else if (state.destFormat !== 'xsiam') entry.disabled = false;
      if (f.description) entry.description = f.description;
      if (f.final) entry.final = true;
      return entry;
    }),
    description: `Transform ${sourcetype} events to ${formatLabel}`,
  };
}

// Run both contract lints on a would-be pipeline and merge the findings. Called
// by buildPack so every generated pack carries its contract report — errors here
// are the field-mismatch bugs that otherwise only surface as low scores after
// deploy.
// Slice out the parse-stage functions (everything from after the "STEP 1: Parse"
// comment up to the next "STEP" comment) so the extraction check models only
// what the parser captures, not downstream mapping evals.
export function sliceParseFunctions(functions: PipelineFunction[]): PipelineFunction[] {
  const isStep = (f: PipelineFunction) => f.id === 'comment' && /---\s*STEP\s/i.test(String((f.conf as any)?.comment || ''));
  const startIdx = functions.findIndex(f => f.id === 'comment' && /STEP 1: Parse/i.test(String((f.conf as any)?.comment || '')));
  if (startIdx === -1) {
    // No step markers (e.g. AI-supplied parse only) — take until first drop.
    const end = functions.findIndex(f => f.id === 'drop');
    return functions.slice(0, end === -1 ? functions.length : end).filter(f => f.id !== 'comment');
  }
  let endIdx = functions.length;
  for (let i = startIdx + 1; i < functions.length; i++) { if (isStep(functions[i])) { endIdx = i; break; } }
  return functions.slice(startIdx + 1, endIdx).filter(f => f.id !== 'comment');
}

export function lintPack(
  state: WizardState, sourcetype: string, reductionToggles: Record<string, boolean>,
  allowCodeFunctions = true, aiMappings?: AiMappingInput | null, aiParseFunctions?: PipelineFunction[] | null,
): ContractLintFinding[] {
  const canonical = canonicalizeSourcetype(sourcetype);
  const functions = buildPipelineFunctionsWithMappings(canonical, state.destFormat, state.manualFormat, reductionToggles, allowCodeFunctions, aiMappings, aiParseFunctions, state.sampleEvents);
  const parseFns = sliceParseFunctions(functions);
  const coverage = checkExtractionCoverage(parseFns, state.sampleEvents || '');
  // On the GOLDEN path, the mapping stage reads canonical names the shared spec
  // defines; the parse stage produces them in ways lintPipelineContract can't
  // statically see (serde/code/assign), so its "no earlier stage produced it"
  // reads are pure false positives — the deterministic preview score is the real
  // proof. lintGoldenContract already catches golden-specific (near-miss) drift.
  // So run the generic stage linter ONLY off the golden path.
  const isGolden = hasGoldenFormatPath(canonical, state.destFormat, state.sampleEvents || '');
  const isXsiam = state.destFormat === 'xsiam';
  // The declaration check only means anything when the STATIC parser is the one
  // that ran: with an AI-generated parse stage, `getParserFieldNames` is not the
  // contract the build used, so a mismatch is expected rather than a defect.
  const staticParse = !aiParseFunctions || !aiParseFunctions.length;
  // Vacuity runs against the fields the build's own parse stage really produces
  // (not the declaration), so it also catches an AI parse that emits vendor-native
  // names the golden spec cannot read.
  const produced = parserProducedFields(parseFns);
  return [
    ...lintGoldenContract(canonical, state.destFormat),
    ...(isXsiam ? lintXsiamBuild(canonical, state.sampleEvents || '') : []),
    ...(isXsiam || !staticParse ? [] : lintParserContract(canonical, { functions: parseFns })),
    ...(isXsiam || produced.dynamic || !produced.fields.length
      ? [] : lintMappingVacuity(canonical, state.destFormat, { emitted: produced.fields, sampleEvents: state.sampleEvents || '' })),
    ...(isXsiam ? [] : lintTimeContract(state.destFormat, parseFns)),
    ...(isXsiam ? [] : coverage.findings),
    ...(isGolden || isXsiam ? [] : lintPipelineContract(functions)),
  ];
}

function buildPipelineFunctionsWithMappings(
  sourcetype: string,
  destFormat: string,
  manualFormat: string,
  reductionToggles: Record<string, boolean>,
  allowCodeFunctions: boolean,
  aiMappings?: AiMappingInput | null,
  aiParseFunctions?: PipelineFunction[] | null,
  sampleEvents?: string,
): PipelineFunction[] {
  const formatLabel = formatLabelShort(destFormat, manualFormat);
  const functions: PipelineFunction[] = [];

  // XSIAM: passthrough — replay a mirrored pipeline or construct routing tags.
  if (destFormat === 'xsiam') {
    const canonical = canonicalizeSourcetype(sourcetype);
    const resolution = resolveXsiamForBuild(canonical, sampleEvents);
    functions.push(xsiamProvenanceComment(canonical, resolution) as PipelineFunction);
    const blockers = lintXsiamBuild(canonical, sampleEvents).filter(f => f.severity === 'error');
    if (blockers.length) {
      functions.push({
        id: 'comment',
        description: 'XSIAM build blocked',
        conf: { comment: blockers.map(f => f.hint).join('\n') },
      });
      return functions;
    }
    const flagFns = getSuspiciousFlagFunctions(canonical, reductionToggles);
    if (flagFns.length > 0) {
      functions.push({ id: 'comment', conf: { comment: '--- STEP 1: Flag suspicious activity ---' } });
      functions.push(...flagFns);
    }
    const tagStep = flagFns.length > 0 ? '2' : '1';
    functions.push({ id: 'comment', conf: { comment: `--- STEP ${tagStep}: Tag XSIAM routing metadata ---` } });
    if (resolution.packPipeline) {
      functions.push(...replayXsiamFunctions(resolution) as PipelineFunction[]);
    } else {
      functions.push(...buildXsiamConstructedTags(resolution) as PipelineFunction[]);
    }
    return functions;
  }

  functions.push({
    id: 'comment',
    conf: { comment: `${sourcetype} to ${formatLabel} pipeline.\nParses events, drops noise, maps to ${formatLabel} schema, and outputs compact JSON.` },
  });

  functions.push({ id: 'comment', conf: { comment: '--- STEP 1: Parse raw events ---' } });
  let parseFns: PipelineFunction[];
  if (aiParseFunctions && aiParseFunctions.length > 0) {
    // AI parse output must clear the same field-name/expression gate the AI
    // mapping path uses — it can emit serde-derived hyphenated field names
    // (SAP's SY-MANDT) and bracket reads that break Cribl's accessor builder.
    const { functions: safeParse } = sanitizeCriblFunctions(aiParseFunctions);
    parseFns = safeParse;
  } else {
    parseFns = getParserForSourcetype(sourcetype, allowCodeFunctions);
  }
  // Keep the vendor's own token for every field the parser normalizes in place,
  // so a vendor-native destination can still reach it (see
  // preserveNativeVocabularyValues). Must happen before the list is pushed —
  // the alias goes INSIDE the overwriting eval.
  parseFns = preserveNativeVocabularyValues(parseFns);
  functions.push(...parseFns);
  // A timestamp-shaped field captured under some other name (AI's `timestamp`,
  // `epoch`, `ids_timestamp`…) never reaches `_time` unless aliased to
  // `log_time` — the one name every golden spec's time-assembly reads. Without
  // this, every output event silently shares one pipeline-processing-time
  // value instead of the real source timestamp (see lintTimeContract).
  const logTimeAlias = buildLogTimeAliasFn(destFormat, parseFns);
  if (logTimeAlias) functions.push(logTimeAlias);

  const flagFunctions = getSuspiciousFlagFunctions(sourcetype, reductionToggles);
  if (flagFunctions.length > 0) {
    functions.push({ id: 'comment', conf: { comment: '--- STEP 2: Flag suspicious activity ---' } });
    functions.push(...flagFunctions);
  }

  // NextGen SIEM (CrowdStrike): raw-fidelity, like XSIAM above — but reached
  // through the SAME shared function Post-Processing's crowdstrike_ngsiem
  // destination calls (src/raw-fidelity.ts), not a second hand-rolled tagging
  // step. Parse + noise-drop + suspicious-flag (above) are untouched — this
  // destination just stops HERE rather than falling into full field-by-field
  // OCSF mapping. A minimal envelope (class/category/metadata.product only,
  // no per-leaf mapping) gives the tag function and the optimization stage's
  // runtime guards something real to read; `_raw` and every already-extracted
  // canonical field survive exactly as parse produced them.
  if (isNextGenRawFidelityFormat(destFormat)) {
    // A concretized `nextgen#<class>` (from concretizeOcsfFormat's schema-variant
    // picking) names its class directly; bare `nextgen` infers it from the
    // sourcetype the same way the old full-mapping path did.
    const dataClass = destFormat.includes('#') ? destFormat.split('#')[1] : staticDataClassFor(sourcetype);
    const rawTagStep = flagFunctions.length > 0 ? '3' : '2';
    functions.push({ id: 'comment', conf: { comment: `--- STEP ${rawTagStep}: Minimal OCSF envelope + raw-fidelity tag (no field mapping) ---` } });
    functions.push(...buildOcsfEnvelopeHeader(sourcetype, dataClass));
    functions.push(...buildRawFidelityTagFunctions());
    return withNextGenRawRestore(functions);
  }

  // Destination mapping. Priority:
  //  1. GOLDEN FORMAT PATH (deterministic) — known parser (canonical fields) +
  //     a golden format spec. gold source + gold dest = perfect, repeatable.
  //     Skips AI entirely and self-cleans, so no compact/AI-keep steps needed.
  //  2. AI mappings — for custom sourcetypes or formats without a golden spec.
  //  3. Static built-in mapping — last resort.
  const stepNum = flagFunctions.length > 0 ? '3' : '2';
  functions.push({ id: 'comment', conf: { comment: `--- STEP ${stepNum}: Map fields to ${formatLabel} schema ---` } });
  // Copilot/schematizer → canonical BEFORE any dest map (golden/static/AI). Ground
  // the alias chains in the fields the parse stage actually produced, so a serde
  // column named `time`/`http_method`/`bytes_received` (not in the static table) is
  // still bridged to the canonical the OCSF maps read instead of emptying the output.
  functions.push(
    repairCanonicalAliases([buildSchematizerCanonicalAliases()], producedParseFields(parseFns))[0],
  );
  const useGolden = hasGoldenFormatPath(sourcetype, destFormat, sampleEvents || '') && goldenPathMatchesSample(sourcetype, destFormat, sampleEvents || '');
  // Every mapping branch goes through the same vendor-native preference: a
  // vendor-native Sentinel column must read the vendor's own token, whichever
  // mapper produced the expression.
  const parseProduced = parseFns.flatMap(f => ((f.conf as Record<string, any>)?.add || []).map((a: Record<string, any>) => String(a?.name || '')));
  const mapped = (fns: PipelineFunction[]) => preferNativeVocabularyValues(destFormat, fns, parseProduced);
  // CIM "keep unmapped source fields in _raw" (default on). Applies to both the
  // golden and AI/static mapping paths so the output shape is identical either
  // way; a no-op for every non-CIM destination.
  const keepUnmappedCim = isCimFormat(destFormat) && (reductionToggles['cim_keep_unmapped'] ?? true);
  if (useGolden) {
    functions.push({ id: 'comment', conf: { comment: `Golden ${formatLabel} mapping — deterministic from canonical fields (no AI).` } });
    functions.push(...mapped(buildGoldenFormatMapping(sourcetype, destFormat, undefined, sampleEvents || '', parseProduced, keepUnmappedCim)));
  } else if (aiMappings && aiMappings.mappings.length > 0) {
    functions.push(...mapped(buildAiMappingFunctions(aiMappings, sourcetype, destFormat)));
  } else {
    functions.push(...mapped(getMappingFunctions(sourcetype, destFormat)));
  }

  // The golden path already assembled + cleaned the output; skip the
  // compact/keep/null stages that exist for the AI/static paths.
  if (useGolden) {
    // Now that parse + schematizer aliases + mapping are all visible, drop raw
    // alias fields (uri→url, bytes→bytes_out) from AdditionalExtensions.
    return dedupeAliasedSerializeFields(functions);
  }

  // Field names the AI mapping produced — the keep-list compact stages
  // (remove:['*']) must preserve these or they'd strip the entire AI output.
  const aiDestFields = (aiMappings && aiMappings.mappings.length > 0)
    ? aiMappings.mappings.map(m => m.destField).filter(Boolean)
    : [];

  const compactEnabled = reductionToggles['compact_output'] ?? true;
  const compactStepNum = flagFunctions.length > 0 ? '4' : '3';
  functions.push({ id: 'comment', conf: { comment: `--- STEP ${compactStepNum}: Build compact output ---` } });
  // When "keep unmapped source fields in _raw" is on (default), the compact stage
  // uses a denylist so ALL extracted fields survive into _raw — including those
  // produced by a dynamic serde/regex whose names can't be enumerated for an
  // allowlist. When off, it compacts _raw to just the mapped CIM fields.
  functions.push(...getCompactOutputFunctions(sourcetype, destFormat, compactEnabled, aiDestFields, keepUnmappedCim));

  const removeNullEnabled = reductionToggles['remove_null_fields'] ?? true;
  functions.push({
    id: 'eval',
    filter: 'true',
    disabled: !removeNullEnabled,
    description: 'Remove null/empty fields',
    conf: {
      remove: ['__*'],
      keep: ['_raw', '_time', 'index', 'host', 'source', 'sourcetype'],
    },
  });

  const cleanupEnabled = reductionToggles['field_cleanup'] ?? true;
  const cleanupStepNum = flagFunctions.length > 0 ? '5' : '4';
  functions.push({ id: 'comment', conf: { comment: `--- STEP ${cleanupStepNum}: Final cleanup ---` } });
  functions.push({
    id: 'eval',
    filter: 'true',
    disabled: !cleanupEnabled,
    description: 'Final cleanup - remove all fields except routing fields',
    conf: {
      add: [{ name: 'sourcetype', value: `'${sourcetype}'` }],
      remove: ['__parsed', '__*'],
      keep: ['_raw', '_time', 'index', 'host', 'source', 'sourcetype'],
    },
  });

  return dedupeAliasedSerializeFields(functions);
}

export function buildPack(stateRaw: WizardState, sourcetype: string, reductionToggles: Record<string, boolean>, allowCodeFunctions = true, aiMappings?: AiMappingInput | null, aiParseFunctions?: PipelineFunction[] | null, prebuiltFunctions?: PipelineFunction[] | null) {
  // A bare `asim` destination is concretized to the specific ASIM schema for this
  // source+sample (asim#authentication, asim#dns, …) so mapping, column-keep
  // cleanup, pipeline ID and scoring all agree. Works for interactive AND
  // batch/API paths (the UI may also pre-set an explicit asim#x, respected as-is).
  // Same for bare `cim` → cim#network / cim#authentication / … (explicit
  // WizardState.cimModel wins over the data-class default).
  let state = stateRaw;
  if (stateRaw.destFormat === 'asim') {
    state = { ...stateRaw, destFormat: concretizeAsimFormat('asim', sourcetype, stateRaw.sampleEvents) as DestFormat };
  } else if (stateRaw.destFormat === 'cim') {
    state = {
      ...stateRaw,
      destFormat: concretizeCimFormat('cim', sourcetype, stateRaw.sampleEvents, stateRaw.cimModel) as DestFormat,
    };
  } else if (stateRaw.destFormat === 'ocsf' || stateRaw.destFormat === 'nextgen') {
    state = {
      ...stateRaw,
      destFormat: concretizeOcsfFormat(stateRaw.destFormat, sourcetype, stateRaw.sampleEvents, stateRaw.ocsfSchema) as DestFormat,
    };
  }
  const packId = toKebab(state.packName);
  const pipelineId = getPipelineId(sourcetype, state.destFormat);
  const sampleEvents = wrapSampleEvents(state.sampleEvents);
  const sampleData = JSON.stringify(sampleEvents);
  const sampleId = generateSampleId();
  const pipelineConf = buildPipelineConfWithMappings(state, sourcetype, reductionToggles, allowCodeFunctions, aiMappings, aiParseFunctions, prebuiltFunctions);
  const enabledOptions: string[] = [];
  const disabledOptions: string[] = [];
  // Build-time contract report: field-mismatch bugs caught statically, before
  // deploy — so a new source doesn't need post-deploy debugging. Post-processing
  // packs bring their own curated functions and have no sourcetype contract to lint.
  const contractFindings = (prebuiltFunctions && prebuiltFunctions.length)
    ? []
    : lintPack(state, sourcetype, reductionToggles, allowCodeFunctions, aiMappings, aiParseFunctions);
  const xsiamResolution = state.destFormat === 'xsiam' ? resolveXsiamForBuild(canonicalizeSourcetype(sourcetype), state.sampleEvents) : null;

  return {
    packId,
    pipelineId,
    sampleId,
    packageJson: buildPackageJson(state, sourcetype, state.destFormat),
    routeYml: buildRouteYml(state, sourcetype),
    pipelineYml: JSON.stringify(pipelineConf, null, 2),
    pipelineConf,
    samplesYml: buildSamplesYml(getSampleName(sourcetype), sampleEvents.length, sampleData.length, sampleId),
    sampleData: sampleEvents,
    readme: buildReadme(state, sourcetype, enabledOptions, disabledOptions, pipelineId, allowCodeFunctions),
    contractFindings,
    breakerYml: xsiamResolution ? buildXsiamBreakerYml(xsiamResolution.breakerRulesets) : null,
    breakerRulesets: xsiamResolution?.breakerRulesets || [],
  };
}

export { toKebab, destFormatDescription, getPipelineId, getSampleName };
