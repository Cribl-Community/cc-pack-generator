// Post-processing pipeline builder — transforms events that are ALREADY in a
// structured schema (e.g. OCSF) into a SIEM wire format (e.g. ArcSight CEF).
//
// This is distinct from the normal pack flow (raw sourcetype → parse → map).
// Here the INPUT is already structured, so there is no parse/AI stage: the maps
// are curated + deterministic (config/postprocess-mappings.json), keyed
// `<sourceFormat>::<destFormat>`. v1 ships `ocsf::cef`; future pairs slot in as
// new registry entries with no engine change.
//
// Kept as its own module (imports only epochMsExpr from pack-builder) so it stays
// out of the AI-free sample-sanitizer graph (CLAUDE.md Hard Rule 25) and remains
// the single, testable home for post-processing.
import type { PipelineFunction } from './source-recognition';
import { epochMsExpr, buildGoldenFormatMapping, goldenFormatAliasOf, type GoldenPostOptions, cimSchemaOptions, asimSchemaOptions, canonicalizeSourcetype, sourceNativeSourcetype, sourceNativeSplunkSource } from './pack-builder';
import { buildDestinationMetadataFunctions, SPLUNK_OCSF_SOURCETYPE } from './destination-metadata';
import { elasticIntegrationStamp } from './elastic-integration';
import { secopsLogTypeStamp } from './secops-log-types';
import { compileOptimizationFunctions, requiresRawFidelity, isRawPassthroughDestination } from './postprocess-optimization';
import { buildRawFidelityTagFunctions } from './raw-fidelity';
import { ocsfAttributeTypes, ocsfClassNames } from './ocsf-schema';
import mappings from '../config/postprocess-mappings.json';
import ocsfNetwork from '../config/ocsf-samples/ocsf_network.json';
import ocsfAuth from '../config/ocsf-samples/ocsf_authentication.json';
import ocsfHttp from '../config/ocsf-samples/ocsf_http.json';
import ocsfFirewall from '../config/ocsf-samples/ocsf_firewall.json';
import ocsfWindows from '../config/ocsf-samples/ocsf_windows.json';
import ocsfWebproxy from '../config/ocsf-samples/ocsf_webproxy.json';
import ocsfDns from '../config/ocsf-samples/ocsf_dns.json';
import ocsfCloudAudit from '../config/ocsf-samples/ocsf_cloud_audit.json';
import ocsfEndpoint from '../config/ocsf-samples/ocsf_endpoint.json';

interface ExtEntry {
  key: string;
  expr: string;
  labelKey?: string;
  label?: string;
  guard?: string;
  transform?: string;
  maxLen?: number;
}
interface ClassLookup {
  file: string;
  key: string;
  outFields: { lookupField: string; eventField: string }[];
}
interface ClassRow { class_uid: string; cef_name: string; device_event_class_id: string; cef_severity: string }
export interface PostProcessPair {
  label: string;
  sourceFormat: string;
  destFormat: string;
  description: string;
  timeField?: string;
  valueRules?: Record<string, string>;
  header: { prefix: string; vendor: string; product: string; version: string; signatureId: string; name: string; severity: string };
  classLookup?: ClassLookup;
  classMap?: ClassRow[];
  aliases: { name: string; value: string }[];
  extension: ExtEntry[];
  /**
   * Non-CEF only: edits to the destination's golden canonicalMap, keyed `*`
   * (every schema of the family) or by a concrete golden key (`asim#dns`; an
   * alias key like `asim#network` also matches its target `asim`).
   */
  mapOverlay?: Record<string, NonNullable<GoldenPostOptions['mapOverlay']>>;
}
// A pair as stored on disk: either a full pair, or a DELTA extending another
// (`extends` + `aliasesAdd`/`extensionAdd`). resolvePair() folds a delta into its
// base and always returns a complete PostProcessPair.
type RawPair = (Partial<PostProcessPair> & Pick<PostProcessPair, 'label' | 'sourceFormat' | 'destFormat' | 'description'>) & {
  extends?: string;
  aliasesAdd?: { name: string; value: string }[];
  extensionAdd?: ExtEntry[];
};

const PAIRS = (mappings as unknown as { pairs: Record<string, RawPair> }).pairs;

export const POSTPROCESS_SOURCE_FORMATS = [
  { value: 'ocsf', label: 'OCSF', description: 'Open Cybersecurity Schema Framework (already-normalized events)' },
];
export const POSTPROCESS_DEST_FORMATS = [
  { value: 'cef', label: 'CEF', description: 'Standard ArcSight Common Event Format (header + extension dictionary)' },
  { value: 'arcsight', label: 'CEF — ArcSight (categorized)', description: 'CEF plus ArcSight ESM categorization (cat / CategoryOutcome / CategorySignificance) derived from OCSF' },
  { value: 'cim', label: 'Splunk CIM', description: 'Flat Splunk Common Information Model fields rebuilt into _raw JSON — pick the data model below (Network Traffic, Authentication, Web…)' },
  { value: 'ecs', label: 'Elastic ECS', description: 'Nested Elastic Common Schema (event / source / destination / network namespaces)' },
  { value: 'asim', label: 'Microsoft Sentinel ASIM', description: 'Flat Microsoft ASIM normalized columns — pick the schema below (NetworkSession, Authentication, Dns…)' },
  { value: 'commonsecuritylog', label: 'Microsoft Sentinel — CommonSecurityLog', description: 'Flat Sentinel CommonSecurityLog table columns (DeviceVendor / SourceIP / DestinationPort…) — the CEF-derived Sentinel table' },
  { value: 'chronicle', label: 'Google Chronicle UDM', description: 'Nested Google SecOps UDM (metadata / principal / target / network) — pick the event class below' },
  { value: 'json', label: 'Clean JSON', description: 'Flat normalized JSON fields (canonical names) rebuilt into _raw JSON' },
  { value: 'xsiam', label: 'Palo Alto Cortex XSIAM', description: 'Raw fidelity — no field mapping. XSIAM parses _raw itself; only event-scope optimization (drop/sample/suppress) and a vendor/product tag are applied.' },
  { value: 'crowdstrike_ngsiem', label: 'CrowdStrike NG-SIEM', description: 'Raw fidelity — no field mapping. Only event-scope optimization (drop/sample/suppress) and a vendor/product tag are applied, and only _raw + _time are sent (NG SIEM bills every field).' },
  { value: 'splunk', label: 'Splunk', description: 'Two sub-modes — pick below: raw passthrough, or the optimized OCSF event re-serialized as real nested JSON (no CIM mapping; Splunk ships its own official OCSF-to-CIM TA).' },
  { value: 'elasticsearch', label: 'Elasticsearch', description: 'Two sub-modes — pick below: raw passthrough (only event-scope optimization — drop/sample/suppress — is applied), or the optimized OCSF event re-serialized as real nested JSON. Use "Elastic ECS" above for the mapped equivalent.' },
];

// The selectable sub-schemas for a destination FAMILY (CIM data model / ASIM
// schema / Chronicle event class / Splunk and Elasticsearch sub-mode). A family
// with no sub-schema (cef, arcsight, ecs, commonsecuritylog, json) returns [].
// The `key` is the CONCRETE golden format (`cim#authentication`, `asim#dns`,
// `chronicle#endpoint`, `splunk#raw`) passed straight to
// buildGoldenFormatMapping (or, for splunk/elasticsearch, read directly by
// buildPostProcessFunctions); the first entry is the family default.
const CHRONICLE_SCHEMA_OPTIONS = [
  { key: 'chronicle', label: 'Network (base UDM)' },
  { key: 'chronicle#endpoint', label: 'Endpoint / Process' },
  { key: 'chronicle#authentication', label: 'User Login' },
  // Not a UDM class: the original line + its Google log type, for Google's own
  // default parser (raw passthrough, like splunk#raw — no golden mapping).
  { key: 'chronicle#raw', label: 'Raw + log type (Google parser)' },
];
// Raw is the family default (first entry) — it is the lossless choice; a bare
// `splunk` destFormat (no sub-schema chosen yet) resolves to it, never to the
// reshaping `splunk#ocsf` variant. See SPLUNK_RAW_KEY/isSplunkOcsf below.
const SPLUNK_SCHEMA_OPTIONS = [
  { key: 'splunk#raw', label: 'Raw passthrough' },
  { key: 'splunk#ocsf', label: 'Nested OCSF JSON' },
];
// Same two sub-modes for Elasticsearch. The raw key stays the bare
// `elasticsearch` (what it always was, and what RAW_PASSTHROUGH_FORMATS lists),
// so existing packs and the default keep their meaning.
const ELASTICSEARCH_SCHEMA_OPTIONS = [
  { key: 'elasticsearch', label: 'Raw passthrough' },
  { key: 'elasticsearch#ocsf', label: 'Nested OCSF JSON' },
];
export function postProcessSchemaOptions(destFormat: string): { key: string; label: string }[] {
  const family = postProcessFamilyOf(destFormat);
  if (family === 'cim') return cimSchemaOptions().map(o => ({ key: o.key, label: o.label }));
  if (family === 'asim') return asimSchemaOptions().map(o => ({ key: o.key, label: o.label }));
  if (family === 'chronicle') return CHRONICLE_SCHEMA_OPTIONS;
  if (family === 'splunk') return SPLUNK_SCHEMA_OPTIONS;
  if (family === 'elasticsearch') return ELASTICSEARCH_SCHEMA_OPTIONS;
  return [];
}

// The destination FAMILY a (possibly concrete) post-process format belongs to.
// `cim#authentication`→`cim`, `asim#dns`→`asim`, `chronicle#endpoint`→`chronicle`;
// a bare family or a standalone format (`commonsecuritylog`, `cef`) is itself.
// The family drives pair lookup, the CEF-engine decision and lookup shipping;
// the concrete key drives buildGoldenFormatMapping (which schema to emit).
export function postProcessFamilyOf(destFormat: string): string {
  return String(destFormat || '').split('#')[0];
}

/**
 * True for every destination that legitimately has NO `PostProcessPair` —
 * raw-fidelity (xsiam/crowdstrike_ngsiem), raw-passthrough (splunk#raw,
 * elasticsearch, chronicle#raw), and splunk#ocsf / elasticsearch#ocsf (re-serialize; no golden
 * mapping either).
 * A bare `splunk` (no sub-schema chosen yet in the UI) is included too — it
 * resolves to the lossless `splunk#raw` default, never to a pair. The single
 * place App.tsx and this module's own tests should ask "is a missing pair
 * expected here", instead of re-deriving the OR of raw-fidelity/raw-
 * passthrough/family checks at every call site.
 */
export function isNoPairPostProcessDestination(destFormat: string): boolean {
  const family = postProcessFamilyOf(destFormat);
  return requiresRawFidelity(destFormat) || isRawPassthroughDestination(destFormat)
    || family === 'splunk' || family === 'elasticsearch';
}

// Formats whose transform is the curated CEF header+extension engine below. Every
// other registered dest format is produced by REUSING the canonical→dest golden
// mapping engine (buildGoldenFormatMapping) after the OCSF→canonical alias step —
// no per-format extension table to hand-author. See buildPostProcessFunctions.
const POSTPROCESS_CEF_FORMATS = new Set(['cef', 'arcsight']);

// Curated source-format input samples, one representative event per class,
// bundled via Vite import so BOTH run modes (iframe + standalone) can load them
// with no network/fs. Used to build/preview/score the transform; the user may
// also paste their own. Returns newline-delimited JSON (one event per line),
// matching WizardState.sampleEvents.
const SOURCE_SAMPLES: Record<string, { events: unknown[] }[]> = {
  ocsf: [ocsfNetwork, ocsfAuth, ocsfHttp, ocsfFirewall, ocsfWindows, ocsfWebproxy, ocsfDns, ocsfCloudAudit, ocsfEndpoint],
};
export function postProcessSampleEvents(sourceFormat: string): string {
  const files = SOURCE_SAMPLES[sourceFormat] || [];
  const lines: string[] = [];
  for (const f of files) for (const ev of (f.events || [])) lines.push(JSON.stringify(ev));
  return lines.join('\n');
}
/** The same curated events as objects — what the §4 noise cleanup is measured on. */
function curatedSourceEvents(sourceFormat: string): unknown[] {
  const out: unknown[] = [];
  for (const f of (SOURCE_SAMPLES[sourceFormat] || [])) for (const ev of (f.events || [])) out.push(ev);
  return out;
}

export function postProcessPairKey(sourceFormat: string, destFormat: string): string {
  return `${sourceFormat}::${destFormat}`;
}
// Resolve a pair, folding an `extends` base in. A derived pair (e.g. ocsf::arcsight
// extends ocsf::cef) declares only its DELTA — `aliasesAdd`, `extensionAdd`,
// `valueRules` — so the shared OCSF→CEF map is never duplicated. Scalar fields
// (label/description/destFormat) and header keys on the derived pair win.
function resolvePair(key: string, seen: Set<string> = new Set()): PostProcessPair | null {
  const raw = PAIRS[key];
  if (!raw) return null;
  if (!raw.extends) return raw as PostProcessPair;   // full pair stored as-is
  if (seen.has(key)) throw new Error(`Cyclic extends in post-process pair "${key}"`);
  seen.add(key);
  const base = resolvePair(raw.extends, seen);
  if (!base) throw new Error(`Post-process pair "${key}" extends unknown pair "${raw.extends}"`);
  return {
    ...base,
    ...raw,
    valueRules: { ...(base.valueRules || {}), ...(raw.valueRules || {}) },
    aliases: [...base.aliases, ...(raw.aliasesAdd || [])],
    extension: [...base.extension, ...(raw.extensionAdd || [])],
    header: { ...base.header, ...(raw.header || {}) },
    classLookup: raw.classLookup || base.classLookup,
    classMap: raw.classMap || base.classMap,
  };
}

export function hasPostProcessPair(sourceFormat: string, destFormat: string): boolean {
  return !!getPostProcessPair(sourceFormat, destFormat);
}
// The pair is keyed by the destination FAMILY (its OCSF→canonical alias step is
// class-independent), so a concrete schema like `cim#authentication` resolves to
// the same `ocsf::cim` pair — only the golden key passed downstream differs.
export function getPostProcessPair(sourceFormat: string, destFormat: string): PostProcessPair | null {
  return resolvePair(postProcessPairKey(sourceFormat, postProcessFamilyOf(destFormat)));
}
export function listPostProcessPairs(): { key: string; pair: PostProcessPair }[] {
  return Object.keys(PAIRS).map(key => ({ key, pair: resolvePair(key)! }));
}

// Substitute a named valueRules macro (else return the expression verbatim) —
// mirrors resolveExpr in pack-builder.ts.
function resolveExpr(expr: string, rules?: Record<string, string>): string {
  if (rules && rules[expr]) return rules[expr];
  return expr;
}

/** Build the editable in-pack CSV lookup content from the curated classMap. */
export function postProcessClassCsv(pair: PostProcessPair): string {
  const rows = pair.classMap || [];
  const header = 'class_uid,cef_name,device_event_class_id,cef_severity';
  const body = rows.map(r =>
    [r.class_uid, r.cef_name, r.device_event_class_id, r.cef_severity]
      .map(v => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)))
      .join(',')
  );
  return [header, ...body].join('\n') + '\n';
}

/** Reference lookups (bundled into the .crbl) for a pair, in the deploy payload shape. */
export function postProcessLookupsFor(sourceFormat: string, destFormat: string, options: { optimize?: boolean } = {}): { file: string; content: string; description: string }[] {
  // Only the CEF engine consumes the editable class dictionary. Non-CEF pairs
  // inherit `classLookup`/`classMap` via `extends: ocsf::cef` but their delegated
  // golden mapping never reads it — do not ship an unused lookup file with them.
  // Lookup-driven OPTIMIZATION rules ship their membership CSV through this same
  // door (they apply to every destination, CEF or not — an event-scope rule has no
  // destination-dependent behaviour), so resolve those first.
  // A "Full copy" (optimize:false) emits no optimization rules, so it ships none
  // of their membership CSVs either — only the transform's own class dictionary.
  const optimization = options.optimize === false ? [] : compileOptimizationFunctions(destFormat).lookups;
  if (!POSTPROCESS_CEF_FORMATS.has(postProcessFamilyOf(destFormat))) return optimization;
  const pair = getPostProcessPair(sourceFormat, destFormat);
  if (!pair || !pair.classLookup || !pair.classMap) return optimization;
  return [{
    file: pair.classLookup.file,
    content: postProcessClassCsv(pair),
    description: `${pair.sourceFormat.toUpperCase()} class dictionary — edit to add classes/severities without changing pipeline code`,
  }, ...optimization];
}

/**
 * Build the full pipeline function list for a post-processing pair. Deterministic;
 * no AI, no sourcetype parser. Reuses the proven chunked-CEF idiom from
 * buildGoldenFormatMapping (chunks of 6, presence guards, epochMsExpr).
 */
// Bridge the OCSF→canonical alias spellings (STEP 1) onto the alternate canonical
// names some golden canonicalMaps read. The OCSF aliases emit src_user/dest_user,
// protocol, src_hostname/dest_hostname, device_*; CIM/ECS/ASIM/Chronicle maps also
// read the bare `user`, `transport`, `src`/`dest`, `dvc`. `|| undefined` keeps an
// absent bridge a no-op (Cribl eval leaves the field unchanged on undefined).
const POSTPROCESS_CANONICAL_BRIDGE: { name: string; value: string }[] = [
  // OCSF `user` is an object; only a string `user` is already the canonical one.
  { name: 'user', value: "(typeof user == 'string' ? user : undefined) || src_user || dest_user || undefined" },
  { name: 'transport', value: 'transport || protocol || undefined' },
  { name: 'src', value: 'src || src_hostname || undefined' },
  { name: 'dest', value: 'dest || dest_hostname || undefined' },
  { name: 'dvc', value: 'dvc || device_host || device_ip || undefined' },
  { name: 'dvc_ip', value: 'dvc_ip || device_ip || undefined' },
];

// Families whose post pack keeps every unmapped source value in an overflow
// container (CSL AdditionalExtensions, ASIM AdditionalFields, CIM's _raw JSON,
// Clean JSON additional_fields). ECS and Chronicle have no such container.
const POSTPROCESS_LEFTOVER_FAMILIES = new Set(['commonsecuritylog', 'asim', 'cim', 'json']);

// Every OCSF top-level attribute (any class) — the roots a leftover may have.
const OCSF_SOURCE_FIELDS = [...new Set([...Object.keys(ocsfAttributeTypes(ocsfClassNames())), 'unmapped'])];
const JS_NAMES = new Set(['typeof', 'undefined', 'null', 'true', 'false', 'new', 'String', 'Number', 'Math', 'JSON', 'Date', 'Array', 'Object', 'isNaN', 'parseInt', 'parseFloat']);

/**
 * The OCSF source paths an alias expression reads: `(((metadata||{}).product)||{}).name`
 * → `metadata.product.name`. Method calls on a path (`x.ip.split(…)`) count as `x.ip`.
 */
export function ocsfReadPaths(expr: string): string[] {
  let e = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, "''");
  for (let prev = ''; prev !== e;) {
    prev = e;
    e = e.replace(/\(([A-Za-z_][\w.]*)\s*\|\|\s*\{\}\)\.(\w+)/g, '$1.$2').replace(/(^|[^\w$])\(([A-Za-z_][\w.]*)\)/g, '$1$2');
  }
  const roots = new Set(OCSF_SOURCE_FIELDS);
  const out = new Set<string>();
  for (const m of e.matchAll(/(?<![\w$.])([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)(\s*\()?/g)) {
    let path = m[1];
    if (m[2]) {
      if (!path.includes('.')) continue;
      path = path.slice(0, path.lastIndexOf('.'));
    }
    if (JS_NAMES.has(path.split('.')[0]) || !roots.has(path.split('.')[0])) continue;
    out.add(path);
  }
  return [...out];
}

/** Leftover inputs for buildGoldenFormatMapping: which OCSF paths each canonical name reads. */
function postLeftovers(pair: PostProcessPair): NonNullable<GoldenPostOptions['leftovers']> {
  const reads: Record<string, string[]> = {};
  for (const a of pair.aliases) reads[a.name] = [...new Set([...(reads[a.name] || []), ...ocsfReadPaths(a.value)])];
  for (const b of POSTPROCESS_CANONICAL_BRIDGE) {
    const paths = new Set<string>(ocsfReadPaths(b.value).filter(p => p !== b.name));
    for (const tok of b.value.match(/[A-Za-z_]\w*/g) || []) for (const p of reads[tok] || []) paths.add(p);
    reads[b.name] = [...paths];
  }
  return {
    reads,
    canonical: [...pair.aliases.map(a => a.name), ...POSTPROCESS_CANONICAL_BRIDGE.map(b => b.name)],
    sourceFields: OCSF_SOURCE_FIELDS,
  };
}

/** The pair's map overlay for a concrete destination key (`*` first, then the key and its aliasOf target). */
export function postMapOverlay(pair: PostProcessPair, destFormat: string): GoldenPostOptions['mapOverlay'] {
  const table = pair.mapOverlay;
  if (!table) return undefined;
  const target = goldenFormatAliasOf(destFormat);
  const parts = ['*', ...(target ? [target] : []), destFormat].map(k => table[k]).filter(Boolean) as NonNullable<GoldenPostOptions['mapOverlay']>[];
  if (!parts.length) return undefined;
  // Later parts win: a concrete schema's override or add replaces what the
  // family-wide `*` part added for the same dest, not just the base map entry.
  type Entry = NonNullable<NonNullable<GoldenPostOptions['mapOverlay']>['add']>[number];
  const add = new Map<string, Entry>();
  const override: Record<string, string | Partial<Entry>> = {};
  const drop: string[] = [];
  for (const p of parts) {
    for (const d of p.drop || []) { add.delete(d); drop.push(d); }
    for (const [dest, o] of Object.entries(p.override || {})) {
      const a = add.get(dest);
      if (a) add.set(dest, typeof o === 'string' ? { ...a, expr: o } : { ...a, ...o });
      else override[dest] = o;
    }
    for (const a of p.add || []) { add.delete(a.dest); add.set(a.dest, a); }
  }
  return {
    override,
    drop,
    add: [...add.values()],
    valueRules: Object.assign({}, ...parts.map(p => p.valueRules || {})),
  };
}

export interface PostProcessBuildOptions {
  /**
   * Events the §4 universal noise cleanup is measured against. Defaults to the
   * curated source samples; a caller holding the user's OWN sample should pass it,
   * because the cleanup only ever omits fields it observed carrying nothing and a
   * six-event curated sample is a narrower observation than real data.
   */
  sampleEvents?: unknown[] | null;
  /**
   * Emit the OCSF optimization step (default true). `false` = "Full copy": the
   * pipeline only reshapes to the destination format and drops nothing — the
   * Build-pack-flow screen's per-output "Full copy / Optimize by category" choice.
   */
  optimize?: boolean;
  /**
   * The source the upstream pack parsed (Build pack flow knows it, e.g.
   * `windows_security`). Lets a Splunk output stamp the vendor's own sourcetype
   * and source (`XmlWinEventLog` / `XmlWinEventLog:Security`) on an event whose
   * original was restored from `raw_data`. Absent (standalone Post-Processing, a
   * mixed OCSF stream): an incoming sourcetype is kept instead.
   */
  sourceSourcetype?: string;
}

function optimizationFunctions(sourceFormat: string, destFormat: string, options: PostProcessBuildOptions): PipelineFunction[] {
  if (options.optimize === false) return [];
  return compileOptimizationFunctions(destFormat, {
    sampleEvents: options.sampleEvents ?? curatedSourceEvents(sourceFormat),
  }).functions;
}

/** Shared by every branch that skips the pair-based canonical alias entirely
 * (raw-fidelity, raw-passthrough, splunk#ocsf) — parse only, no aliasing. */
function parseOcsfPayloadFunctions(sourceFormat: string): PipelineFunction[] {
  return [{
    id: 'serde',
    filter: "typeof _raw=='string' && _raw.charAt(0)=='{'",
    description: `Parse ${sourceFormat.toUpperCase()} JSON payload`,
    conf: { mode: 'extract', type: 'json', srcField: '_raw' },
  }];
}

// Fields every serialize-to-_raw step must exclude — routing metadata and
// Cribl internals, so they aren't duplicated inside the rebuilt JSON body
// (mirrors the exact exclusion list pack-builder.ts's CIM serialize step uses).
const SERIALIZE_EXCLUDE_ROUTING_FIELDS = ['!_raw', '!_time', '!index', '!source', '!sourcetype', '!host', '!cribl_breaker', '!cribl_pipe', '!__*', '!cribl*', '*'];

// Set on an event whose `_raw` is the ORIGINAL vendor event restored from OCSF
// `raw_data` — the Splunk contract below stamps the vendor sourcetype only there.
const VENDOR_RAW_MARKER = '__pg_vendor_raw';

/**
 * A raw destination forwards the ORIGINAL event, but a Build-pack-flow OCSF
 * pipeline hands over no `_raw` at all: the source parser consumed it (Windows
 * XML: parseWinEvent + flatten) and the OCSF cleanup drops whatever is left. The
 * original survives only as the OCSF `raw_data` attribute ("Keep original _raw"),
 * so restore it into `_raw` (add runs before remove, so `raw_data` is read first).
 * With no original to restore and no `_raw`, serialize the OCSF event into `_raw`
 * — an event without `_raw` is an empty line at every raw destination.
 */
function restoreOriginalRawFunctions(): PipelineFunction[] {
  return [
    {
      id: 'eval',
      filter: "typeof raw_data=='string' && raw_data.length>0",
      description: 'Restore the original event: OCSF raw_data → _raw',
      conf: { add: [{ name: '_raw', value: 'raw_data' }, { name: VENDOR_RAW_MARKER, value: 'true' }], remove: ['raw_data'] },
    },
    {
      id: 'serialize',
      filter: "typeof _raw!='string'",
      description: 'No original event to restore — serialize the OCSF event into _raw',
      conf: { type: 'json', dstField: '_raw', fields: SERIALIZE_EXCLUDE_ROUTING_FIELDS },
    },
  ];
}

/** The Splunk sourcetype/source this post pack can stamp, from the flow's source. */
function splunkIdentity(options: PostProcessBuildOptions): { vendorSourcetype: string; vendorSource: string; ocsfSource: string } {
  const src = (options.sourceSourcetype || '').trim();
  const canonical = src ? canonicalizeSourcetype(src) : '';
  return {
    vendorSourcetype: src ? sourceNativeSourcetype(src) : '',
    vendorSource: src ? sourceNativeSplunkSource(src) : '',
    // Never the vendor source for an OCSF JSON payload: a TA bound to
    // `source::XmlWinEventLog:*` would run its XML extractions over JSON.
    ocsfSource: canonical ? `${SPLUNK_OCSF_SOURCETYPE}:${canonical}` : SPLUNK_OCSF_SOURCETYPE,
  };
}

/**
 * Splunk HEC turns every non-internal top-level field into an INDEXED field, so
 * a Splunk output keeps only `_raw` + routing — the OCSF attributes are either
 * inside `_raw` (splunk#ocsf) or deliberately not sent (splunk#raw).
 */
function splunkFinalCleanup(): PipelineFunction[] {
  return [{
    id: 'eval',
    filter: 'true',
    description: 'Keep only _raw + Splunk routing (strip the OCSF fields)',
    conf: {
      remove: [VENDOR_RAW_MARKER, '*'],
      keep: ['_raw', '_time', 'cribl_breaker', 'cribl_pipe', 'index', 'source', 'sourcetype', 'host'],
    },
  }];
}

/**
 * Raw-fidelity destinations (xsiam, crowdstrike_ngsiem — plan Task 5) have NO
 * `PostProcessPair` and never will: there is no field mapping to define one
 * for. Short-circuits BEFORE `getPostProcessPair` (which would otherwise
 * return null and bail with `[]`, dropping even optimization/tagging) —
 * parse, then event-scope-only optimization (field-scope rules are already
 * suppressed for these destFormats by `compileOptimizationFunctions` itself,
 * via `requiresRawFidelity`), then the original event restored into `_raw`
 * (the vendor parses THAT, not OCSF), then the SAME vendor/product tag the main
 * wizard's `nextgen` destination applies (src/raw-fidelity.ts) — never `pair`
 * lookups, never `buildGoldenFormatMapping`. Every OCSF field survives as it arrived.
 */
function buildRawFidelityPostProcessFunctions(
  sourceFormat: string,
  destFormat: string,
  options: PostProcessBuildOptions,
): PipelineFunction[] {
  const fns: PipelineFunction[] = [];
  const step = stepCounter(fns);
  step('Parse OCSF input', parseOcsfPayloadFunctions(sourceFormat));
  step('Optimization — drop/reshape noisy OCSF events', optimizationFunctions(sourceFormat, destFormat, options));
  step('Restore the original event into _raw', restoreOriginalRawFunctions());
  step('Destination-specific formatting', buildRawFidelityTagFunctions());
  if (destFormat === 'crowdstrike_ngsiem') step('Final cleanup', ngSiemFinalCleanup());
  return fns;
}

/**
 * NG SIEM bills the WHOLE payload and its vendor parser reads only the HEC
 * `event`, so the OCSF fields that rode along are pure cost: ship `_raw` and
 * `_time`. `__vendor`/`__product` survive (a wildcard remove skips `__` fields)
 * for routing, and never leave Cribl.
 */
function ngSiemFinalCleanup(): PipelineFunction[] {
  return [{
    id: 'eval',
    filter: 'true',
    description: 'Keep only _raw + _time (NG SIEM bills every field it receives)',
    conf: { remove: [VENDOR_RAW_MARKER, '*'], keep: ['_raw', '_time'] },
  }];
}

/**
 * Raw PASSTHROUGH destinations (`splunk#raw`, `elasticsearch`, `chronicle#raw` — plan Task 7a):
 * the same "no field mapping, no PostProcessPair" shape as raw-fidelity above,
 * but with NO vendor/product tag — unlike XSIAM/CrowdStrike NG-SIEM, neither
 * of these needs a routing tag on the event itself. `isRawPassthroughDestination`
 * (the superset `requiresRawFidelity` is built from) already suppresses
 * field-scope optimization for both, so only the event-scope rules ever fire.
 *
 * `splunk#raw` then meets the Splunk destination-metadata contract: a restored
 * vendor event gets the vendor's sourcetype/source (forced when the flow knows
 * the source — the upstream OCSF stage's sourcetype is not trustworthy), an OCSF
 * JSON `_raw` gets the OCSF sourcetype, and the OCSF fields are stripped so HEC
 * doesn't index them.
 */
function buildRawPassthroughPostProcessFunctions(
  sourceFormat: string,
  destFormat: string,
  options: PostProcessBuildOptions,
): PipelineFunction[] {
  const fns: PipelineFunction[] = [];
  const step = stepCounter(fns);
  step('Parse OCSF input', parseOcsfPayloadFunctions(sourceFormat));
  step('Optimization — drop/reshape noisy OCSF events', optimizationFunctions(sourceFormat, destFormat, options));
  step('Restore the original event into _raw', restoreOriginalRawFunctions());
  if (destFormat === 'splunk#raw') {
    const id = splunkIdentity(options);
    step('Destination metadata — Splunk host/source/sourcetype', [
      ...buildDestinationMetadataFunctions(destFormat, {
        sourcetype: id.vendorSourcetype || SPLUNK_OCSF_SOURCETYPE,
        source: id.vendorSource || undefined,
        force: !!id.vendorSourcetype,
        filter: VENDOR_RAW_MARKER,
        note: 'restored vendor event',
      }),
      ...buildDestinationMetadataFunctions(destFormat, {
        sourcetype: SPLUNK_OCSF_SOURCETYPE,
        source: id.ocsfSource,
        force: true,
        filter: `!${VENDOR_RAW_MARKER}`,
        note: 'OCSF JSON _raw',
      }),
    ]);
    step('Final cleanup', splunkFinalCleanup());
  }
  if (destFormat === 'elasticsearch') {
    // Only a RESTORED vendor line can go through an integration pipeline; an
    // OCSF JSON _raw is not what any integration parses, so it gets no _dataId.
    const src = (options.sourceSourcetype || '').trim();
    const contract = buildDestinationMetadataFunctions(destFormat, {
      sourcetype: '',
      elastic: src ? elasticIntegrationStamp(canonicalizeSourcetype(src)) : null,
      filter: VENDOR_RAW_MARKER,
      note: 'restored vendor event',
    });
    step('Destination metadata — Elastic cribl integration _dataId/message', contract);
    // The integration's pipeline parses message; OCSF fields beside it would be
    // indexed into the integration data stream as stray, unmapped fields.
    if (contract.length) step('Final cleanup', [{
      id: 'eval',
      filter: VENDOR_RAW_MARKER,
      description: 'Keep only message + routing for the Elastic integration (strip the OCSF fields)',
      conf: { remove: ['*'], keep: ['message', '_dataId', 'input', '_time'] },
    }]);
  }
  if (destFormat === 'chronicle#raw') {
    // Google's parser reads the ORIGINAL line, so only a restored vendor line is
    // labelled; an OCSF JSON _raw keeps the destination's Default log type.
    const src = (options.sourceSourcetype || '').trim();
    step('Destination metadata — Google SecOps log type', buildDestinationMetadataFunctions(destFormat, {
      sourcetype: '',
      secops: src ? secopsLogTypeStamp(canonicalizeSourcetype(src)) : null,
      filter: VENDOR_RAW_MARKER,
      note: 'restored vendor event',
    }));
  }
  return fns;
}

/**
 * `splunk#ocsf` (plan Task 7a): re-serializes the ALREADY-OPTIMIZED OCSF event
 * as real nested JSON — `{"src_endpoint":{"ip":"..."}}`, never a flat blob
 * with dotted-string key names — with NO field renaming and NO CIM mapping.
 * Splunk ships its own official OCSF-to-CIM TA, so this pack's only job is to
 * hand it conformant nested OCSF JSON; building a Cribl-side compatibility TA
 * or CIM extension table for Splunk specifically would duplicate that.
 *
 * Unlike the raw-passthrough branch above, this is NOT in
 * `RAW_PASSTHROUGH_FORMATS` — the output IS reshaped (re-serialized), so
 * field-scope optimization (`omit`/`transform`) and the §4 universal noise
 * cleanup apply normally, same as every schema-mapped destination.
 *
 * `elasticsearch#ocsf` ("Elastic JSON" in Build pack flow) is the same nested
 * OCSF JSON document, for an Elastic index that wants JSON rather than ECS. Only
 * the Splunk variant carries the Splunk metadata contract + field strip.
 */
function buildSplunkOcsfPostProcessFunctions(
  sourceFormat: string,
  destFormat: string,
  options: PostProcessBuildOptions,
): PipelineFunction[] {
  const fns: PipelineFunction[] = [];
  const step = stepCounter(fns);
  step('Parse OCSF input', parseOcsfPayloadFunctions(sourceFormat));
  step('Optimization — drop/reshape noisy OCSF events', optimizationFunctions(sourceFormat, destFormat, options));
  step('Destination metadata — Splunk host/source/sourcetype', buildDestinationMetadataFunctions(destFormat, {
    sourcetype: SPLUNK_OCSF_SOURCETYPE, source: splunkIdentity(options).ocsfSource, force: true, note: 'OCSF JSON _raw',
  }));
  step('Destination-specific formatting', [{
    id: 'serialize',
    filter: 'true',
    description: 'Re-serialize the optimized OCSF event as real nested JSON',
    conf: { type: 'json', dstField: '_raw', fields: SERIALIZE_EXCLUDE_ROUTING_FIELDS },
  }]);
  if (destFormat === 'splunk#ocsf') step('Final cleanup', splunkFinalCleanup());
  return fns;
}

/**
 * Comment-function grouping (plan Task 6): the exact `{id:'comment', conf:
 * {comment:'--- STEP N: <label> ---'}}` shape `src/pack-builder.ts` already
 * uses (grep `id: 'comment'`), pushed immediately before a group ONLY when
 * that group actually emits at least one function — an empty optimization
 * catalog contributes no comment and does not consume a step number, so
 * numbering stays contiguous regardless of which groups a given destination
 * happens to skip.
 */
function stepCounter(fns: PipelineFunction[]): (label: string, group: PipelineFunction[]) => void {
  let n = 0;
  return (label, group) => {
    if (!group.length) return;
    n += 1;
    fns.push({ id: 'comment', conf: { comment: `--- STEP ${n}: ${label} ---` } });
    fns.push(...group);
  };
}

export function buildPostProcessFunctions(
  sourceFormat: string,
  destFormat: string,
  options: PostProcessBuildOptions = {},
): PipelineFunction[] {
  if (requiresRawFidelity(destFormat)) {
    return buildRawFidelityPostProcessFunctions(sourceFormat, destFormat, options);
  }
  // A bare `splunk` (no sub-schema chosen yet) resolves to the lossless
  // default — raw passthrough, never the reshaping `splunk#ocsf` variant.
  if (destFormat === 'splunk#ocsf' || destFormat === 'elasticsearch#ocsf') {
    return buildSplunkOcsfPostProcessFunctions(sourceFormat, destFormat, options);
  }
  if (destFormat === 'splunk#raw' || destFormat === 'splunk' || destFormat === 'elasticsearch' || destFormat === 'chronicle#raw') {
    return buildRawPassthroughPostProcessFunctions(sourceFormat, destFormat === 'splunk' ? 'splunk#raw' : destFormat, options);
  }
  const pair = getPostProcessPair(sourceFormat, destFormat);
  if (!pair) return [];
  const family = postProcessFamilyOf(destFormat);
  const rules = pair.valueRules;
  const fns: PipelineFunction[] = [];
  const step = stepCounter(fns);

  // Ensure the OCSF payload is parsed (events may arrive as structured fields
  // already, or as a JSON string in _raw), then read the source schema's
  // normalized objects into the canonical field names the mapping below
  // consumes. One group: design's flow diagram treats parse+alias as a single
  // relabeled "STEP 1" (the two existed as separate pushes before Task 6, with
  // no comment of their own).
  step('Parse OCSF input', [
    {
      id: 'serde',
      filter: "typeof _raw=='string' && _raw.charAt(0)=='{'",
      description: `Parse ${pair.sourceFormat.toUpperCase()} JSON payload`,
      conf: { mode: 'extract', type: 'json', srcField: '_raw' },
    },
    {
      id: 'eval',
      description: `Map ${pair.sourceFormat.toUpperCase()} fields to canonical names`,
      conf: { add: pair.aliases.map(a => ({ name: a.name, value: a.value })) },
    },
  ]);

  // OCSF-field optimization (drop / sample / suppress / omit / transform).
  // Emitted for BOTH branches and before any destination formatting, so a
  // dropped event costs no mapping work. Each rule carries its own runtime
  // class_uid + vendor guard (the input is a mixed OCSF stream), event-scope
  // rules ship DISABLED, and field-scope rules are absent for a raw-fidelity
  // destination. An empty catalog emits nothing at all — no comment, no
  // placeholder function, and (via `step`) no step number consumed either.
  step('Optimization — drop/reshape noisy OCSF events', optimizationFunctions(sourceFormat, destFormat, options));

  // Destination metadata contract (Splunk CIM: host/source/sourcetype; [] for a
  // destination with no contract). BEFORE the mapping, whose cleanup strips the
  // OCSF `device` the host chain reads — the keep-list preserves the three
  // routing fields. Not forced: a CIM post pack keeps the upstream routing sourcetype.
  const cimId = splunkIdentity(options);
  step('Destination metadata — Splunk host/source/sourcetype', buildDestinationMetadataFunctions(destFormat, {
    sourcetype: cimId.vendorSourcetype || SPLUNK_OCSF_SOURCETYPE,
    source: cimId.vendorSource || undefined,
  }));

  // NON-CEF formats: reuse the canonical→dest golden mapping engine (the same one
  // the raw-log pack flow uses) over the canonical fields the parse group just
  // produced. This is what makes OCSF→{CIM,ECS,ASIM,Chronicle,JSON} work with no
  // per-format extension table — the target's canonicalMap in golden-formats.json
  // IS the map.
  if (!POSTPROCESS_CEF_FORMATS.has(family)) {
    const canonicalFields = [...pair.aliases.map(a => a.name), ...POSTPROCESS_CANONICAL_BRIDGE.map(b => b.name)];
    // postProcess=true → the golden builder skips its per-sourcetype vendor and
    // sourcetype emission, so the OCSF-derived vendor/product/version (set by the
    // parse group's aliases) and the incoming routing sourcetype are preserved.
    // The CONCRETE destFormat (e.g. `cim#authentication`, `commonsecuritylog`)
    // selects which schema the golden builder emits — a bare family key falls to
    // its base.
    step(`Map fields to ${family} schema`, [
      ...buildGoldenFormatMapping('', destFormat, undefined, '', canonicalFields, false, true, true, {
        bridge: POSTPROCESS_CANONICAL_BRIDGE,
        mapOverlay: postMapOverlay(pair, destFormat),
        leftovers: POSTPROCESS_LEFTOVER_FAMILIES.has(family) ? postLeftovers(pair) : undefined,
      }),
    ]);
    return fns;
  }

  // CEF/ArcSight: per-class dictionary (editable in-pack CSV lookup, fills the
  // header Name / DeviceEventClassID / severity with OCSF self-describing
  // fallbacks when a row is absent) + header + extension (chunked — Cribl fails
  // on large eval template literals, CLAUDE.md CEF gotcha) + _raw/_time assembly,
  // grouped as ONE "destination-specific formatting" step — CEF has no separate
  // canonical→schema mapping stage the way the non-CEF branch above does; the
  // header/extension ARE the mapping.
  const h = pair.header;
  const ext = pair.extension;
  const formatting: PipelineFunction[] = [];
  if (pair.classLookup) {
    formatting.push({
      id: 'lookup',
      filter: 'true',
      description: `Resolve CEF header from ${pair.classLookup.key} (editable ${pair.classLookup.file})`,
      conf: {
        matchMode: 'exact',
        reloadPeriodSec: 60,
        addToEvent: false,
        ignoreCase: false,
        inFields: [{ eventField: pair.classLookup.key, lookupField: pair.classLookup.key }],
        outFields: pair.classLookup.outFields.map(o => ({ lookupField: o.lookupField, eventField: o.eventField })),
        file: pair.classLookup.file,
      },
    });
  }
  formatting.push({
    id: 'eval',
    description: 'Build CEF header',
    conf: { add: [
      { name: '__sig', value: resolveExpr(h.signatureId, rules) },
      { name: '__name', value: resolveExpr(h.name, rules) },
      { name: '__sev', value: resolveExpr(h.severity, rules) },
      { name: '__hdr', value: `'${h.prefix}|' + String(${resolveExpr(h.vendor, rules)}) + '|' + String(${resolveExpr(h.product, rules)}) + '|' + String(${resolveExpr(h.version, rules)}) + '|' + String(__sig) + '|' + String(__name) + '|' + String(__sev) + '|'` },
      { name: '__ext', value: "''" },
    ] },
  });
  for (let i = 0; i < ext.length; i += 6) {
    const chunk = ext.slice(i, i + 6);
    const adds = chunk.map(e => {
      const src = resolveExpr(e.expr, rules);
      const epochMs = epochMsExpr(src);
      const valExpr = e.transform === 'epochMillis'
        ? `String(${epochMs} || '')`
        : e.maxLen ? `String(${src}).substring(0, ${e.maxLen})`
        : `String(${src})`;
      const present = `(${src}) && String(${src}) != 'undefined' && String(${src}) != 'null' && String(${src}) != '-'`;
      const cond = e.guard ? `${present} && (${e.guard})` : present;
      const pair2 = e.labelKey && e.label
        ? `${cond} ? __ext + '${e.key}=' + ${valExpr} + ' ${e.labelKey}=${e.label} ' : __ext`
        : `${cond} ? __ext + '${e.key}=' + ${valExpr} + ' ' : __ext`;
      return { name: '__ext', value: pair2 };
    });
    formatting.push({ id: 'eval', description: i === 0 ? 'Build CEF extension' : `CEF extension (cont. ${i + 1})`, conf: { add: adds } });
  }
  const assembleAdds: { name: string; value: string }[] = [
    { name: '_raw', value: '__hdr + __ext.trim()' },
  ];
  if (pair.timeField) {
    const timeSrc = resolveExpr(pair.timeField, rules);
    const ms = epochMsExpr(timeSrc);
    assembleAdds.push({ name: '_time', value: `(${timeSrc}) && ${ms} ? ${ms} / 1000 : _time` });
  }
  formatting.push({ id: 'eval', description: 'Assemble CEF _raw + set _time', conf: { add: assembleAdds } });
  step('Destination-specific formatting', formatting);

  // Final cleanup: keep only _raw + routing, strip the source schema + temp fields.
  step('Final cleanup', [{
    id: 'eval',
    description: 'Keep only CEF _raw + routing (strip source fields)',
    conf: {
      remove: ['__sig', '__name', '__sev', '__hdr', '__ext', '__cls_name', '__cls_deviceclass', '__cls_sev', '*'],
      keep: ['_raw', '_time', 'cribl_breaker', 'cribl_pipe', 'index', 'source', 'sourcetype', 'host'],
    },
  }]);

  return fns;
}
