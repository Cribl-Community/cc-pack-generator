import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_MODEL as MODEL_ID, invokeModel } from './cribl-auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEARNINGS_PATH = join(__dirname, '..', 'config', 'validation-learnings.json');
const RULES_PATH = join(__dirname, '..', 'config', 'pipeline-rules.md');
const FIELD_MAP_PATH = join(__dirname, '..', 'config', 'field-schema-map.md');
const GOLDEN_LOOKUPS_PATH = join(__dirname, '..', 'config', 'golden-lookups');
const REFERENCE_CATALOG_PATH = join(__dirname, '..', 'config', 'reference-catalog.json');
const EXTRACTION_TEMPLATES_PATH = join(__dirname, '..', 'config', 'extraction-templates.json');
const TRANSFORMATION_TEMPLATES_PATH = join(__dirname, '..', 'config', 'transformation-templates.json');
const GOLDEN_FORMATS_PATH = join(__dirname, '..', 'config', 'golden-formats.json');
const XSIAM_SOURCES_PATH = join(__dirname, '..', 'config', 'xsiam-sources.json');
const SENTINEL_DESTINATIONS_PATH = join(__dirname, '..', 'config', 'sentinel-destinations.json');
const SENTINEL_SOLUTION_MAPPINGS_PATH = join(__dirname, '..', 'config', 'sentinel-solution-mappings.json');
const CIM_MODELS_PATH = join(__dirname, '..', 'config', 'cim-data-models.json');

// Load pipeline generation rules (static knowledge base).
function loadPipelineRules() {
  try { return readFileSync(RULES_PATH, 'utf-8'); }
  catch { return ''; }
}

// Load field name schema map (correct field names per target schema).
function loadFieldSchemaMap(destFormat) {
  try {
    const content = readFileSync(FIELD_MAP_PATH, 'utf-8');
    if (!destFormat) return content;
    const relevant = content.split('\n').filter(l =>
      l.startsWith('#') || l.startsWith('Raw:') || l.startsWith('Note:') ||
      l.includes(destFormat) || l.includes('cim') || l.trim() === ''
    );
    return relevant.join('\n');
  } catch { return ''; }
}

// Map a sourcetype to its golden-lookup category. Shared by the prompt builder
// and the deploy path (which bundles the CSVs into the pack).
function lookupCategoryFor(sourcetype) {
  const st = (sourcetype || '').toLowerCase();
  if (st.includes('cisco_asa') || st.includes('asa')) return 'cisco_asa';
  if (st.includes('cisco_ftd') || st.includes('ftd') || st.includes('firepower')) return 'cisco_ftd';
  if (st.includes('fortinet') || st.includes('fortigate')) return 'fortinet_fortigate';
  return null;
}

// Count data rows in a lookup CSV (excludes header + blank lines).
function csvRowCount(file) {
  try {
    const csv = readFileSync(join(GOLDEN_LOOKUPS_PATH, file), 'utf-8');
    return csv.split('\n').filter(l => l.trim()).length - 1;
  } catch { return 0; }
}

// Load golden lookup context for a sourcetype — returns regex patterns and
// normalization tables that the AI should reference or include in the pipeline.
//
// KEY PRINCIPLE: the lookup covers FAR more of the sourcetype than the handful
// of events in the samples (e.g. 169 ASA codes vs. ~6 codes seen in a sample).
// We tell the AI the lookup's full coverage and instruct it to build
// lookup-DRIVEN parsing that handles every code in the lookup — NOT hardcoded
// regex for only the codes that happen to appear in the samples. The full CSV is
// bundled into the generated pack at deploy time (see deploy-api bundleLookups).
function loadGoldenLookups(sourcetype) {
  try {
    const index = JSON.parse(readFileSync(join(GOLDEN_LOOKUPS_PATH, 'index.json'), 'utf-8'));
    const lookups = index.lookups || {};
    let context = '';

    const category = lookupCategoryFor(sourcetype);

    if (category && lookups[category]) {
      const cat = lookups[category];
      const parsing = cat.parsing;
      const parsingRows = parsing ? csvRowCount(parsing.file) : 0;

      context += `\n\nGOLDEN LOOKUPS available for ${sourcetype} — these will be BUNDLED into the generated pack (uploaded to data/lookups/), so the pipeline can reference them at runtime:\n`;

      if (parsing && parsingRows > 0) {
        context += `\nCRITICAL — LOOKUP-DRIVEN PARSING:\n`;
        context += `  The lookup "${parsing.file}" contains ${parsingRows} per-code regex patterns covering ${parsingRows} distinct event codes for this sourcetype.\n`;
        context += `  The sample events you were given show only a FEW of these codes. Do NOT build hardcoded regex_extract functions for just the codes visible in the samples.\n`;
        context += `  INSTEAD: (1) extract the message/event code with one regex_extract, (2) use a Lookup function against "${parsing.file}" keyed on that code to fetch the per-code regex, (3) apply it. This covers ALL ${parsingRows} codes, not just the sampled ones.\n`;
        context += `  ${parsing.usage || ''}\n`;
      }

      // List every lookup in the category with its full row count so the AI
      // understands the true coverage (not the sample subset).
      context += `\n  Bundled lookup files (full coverage):\n`;
      for (const [key, info] of Object.entries(cat)) {
        const rows = csvRowCount(info.file);
        context += `  - ${info.file}: ${info.description} [fields: ${info.fields.join(', ')}]${rows ? ` — ${rows} rows` : ''}\n`;

        // For small normalization lookups, include ALL rows (the AI can inline
        // these or reference the file). Parsing lookups are too big to inline —
        // the AI must use a Lookup function against the bundled file.
        if (['cim_action', 'cim_severity', 'sentinel_severity', 'protocol'].includes(key) && rows > 0 && rows <= 40) {
          try {
            const csv = readFileSync(join(GOLDEN_LOOKUPS_PATH, info.file), 'utf-8');
            context += '    Full content:\n';
            csv.split('\n').forEach(l => { if (l.trim()) context += '    ' + l + '\n'; });
          } catch { /* skip */ }
        }
      }
      context += `\n  Build the pipeline for the FULL lookup coverage above, not only what appears in the sample events.\n`;
    }

    // Always include generic protocol lookup hint
    if (lookups.generic?.ip_protocols) {
      context += '\nGeneric: ip_protocols.csv (137 IANA protocol number→name mappings) available for any network source.\n';
    }

    return context;
  } catch { return ''; }
}

// Load accumulated validation learnings for a source+format so the mapping AI
// avoids previously-observed mistakes. Written by the schema validator's repair
// flow (scripts/schema-validator.mjs). Fails silent if the file is missing.
function learningsPromptFor(sourcetype, destFormat) {
  try {
    const l = JSON.parse(readFileSync(LEARNINGS_PATH, 'utf-8'));
    const bullets = [
      ...((l.byFormat && l.byFormat[destFormat]) || []),
      ...((l.bySource && l.bySource[`${sourcetype}::${destFormat}`]) || []),
    ];
    return bullets.length ? `\n\nKnown pitfalls to avoid (learned from prior validations):\n- ${bullets.join('\n- ')}` : '';
  } catch { return ''; }
}

const DEST_SCHEMA_HINTS = {
  ocsf: `OCSF v1.9 schema. Required fields by class:
- Network Activity (class_uid=4001, category_uid=4): activity_id (1=open,2=close,5=refuse), severity_id (0-6), src_endpoint.ip, src_endpoint.port, dst_endpoint.ip, dst_endpoint.port, connection_info.protocol_name, metadata.version="1.9.0", metadata.product.name, type_uid=400100+activity_id
- Authentication (class_uid=3002, category_uid=3): activity_id (1=logon,2=logoff), actor.user.name, src_endpoint.ip, dst_endpoint.hostname, status_id (1=success,2=failure), metadata.version="1.9.0"
- Process Activity (class_uid=1007, category_uid=1): activity_id (1=launch,2=terminate), process.name, process.cmd_line, process.pid, actor.user.name, device.hostname
Use dot notation for nested fields. Values must be valid Cribl eval expressions (no arrow functions).`,

  cef: `CEF / Microsoft Sentinel CommonSecurityLog — ArcSight CEF format.

CEF header structure: CEF:0|DeviceVendor|DeviceProduct|DeviceVersion|DeviceEventClassID|Name|Severity|extensions
- DeviceEventClassID (SignatureID): the source's NATIVE event identifier. If the source already has a canonical event/message code (Cisco ASA/FTD message codes like 302014 or 106023, Windows EventIDs like 4624, PAN threat IDs, Fortinet logid), use that code VERBATIM — do NOT prefix it with the product name (use "302014", never "asa:302014"). Only synthesize a "class:subclass" string (e.g. "auth:success") when the source has NO native code. Never the raw message.
- Name (Activity): SHORT human-readable event name like "User Login Success", "Email Sent", "IMAP Connection" — NOT the full log message, max 5 words
- Severity (LogSeverity): 0-10 scale based on log level or event risk (INFO=2, WARNING=5, ERROR=8, auth failure=5, brute force=9)

Extension fields (key=value pairs, space-separated):
- act (DeviceAction): allow, deny, block, observed — the action taken
- src (SourceIP): source IP address
- suser (SourceUserName): source/actor username
- dhost (DestinationHostName): destination hostname
- dpt (DestinationPort): destination port number
- duser (DestinationUserName): recipient/target username
- app (ApplicationProtocol): HTTPS, IMAP, SMTP, etc.
- rt (DeviceReceiptTime): event timestamp
- requestClientApplication: user agent string
- msg: short summary of what happened (first 200 chars of message)

CRITICAL RULES:
- Only include extension fields that have actual values — NEVER include empty fields or labels without values
- DeviceCustomStringNLabel MUST be paired with DeviceCustomStringN — if one is empty, omit BOTH
- SignatureID (DeviceEventClassID) must be a meaningful event class string, NOT a number or raw message
- Name (Activity) must be SHORT and DIFFERENT from SignatureID — it is human-readable (e.g. SignatureID="auth:failure" → Name="Authentication Failed")
- Severity (LogSeverity) MUST be a NUMBER 0-10, NEVER a word like "high"/"low"/"medium". Use: 0=unknown, 1-3=low/info, 4-6=medium/warning, 7-9=high/error, 10=critical
- Do NOT include "Severity" or "LogSeverity" as an extension field — it is ONLY in the CEF header
- Do NOT duplicate header fields in extensions (no DeviceEventClassID, Activity, or LogSeverity in extension key=value pairs)
Values must be valid Cribl eval expressions.`,

  cim: `Splunk CIM data model fields:
- Network Traffic: src, src_port, dest, dest_port, transport, action (allowed/blocked), app, bytes_in, bytes_out, packets_in, packets_out, duration, vendor_action, rule, user
- Authentication: user, src, dest, action (success/failure), app, authentication_method, signature
- Endpoint/Process: process, process_id, parent_process, user, dest, action, file_name, file_path
Values must be valid Cribl eval expressions.`,

  ecs: `Elastic Common Schema (ECS) — dot notation:
- event.kind, event.category (array), event.type (array), event.outcome, event.action
- source.ip, source.port, source.bytes, source.user.name
- destination.ip, destination.port, destination.bytes
- network.transport, network.protocol, network.bytes, network.direction
- user.name, user.domain, host.name, host.ip
- process.name, process.pid, process.command_line, process.parent.name
- observer.vendor, observer.product, rule.name
Values must be valid Cribl eval expressions.`,

  asim: `Microsoft Sentinel ASIM fields:
- NetworkSession: EventType, EventSchema, EventSchemaVersion, EventResult, EventSeverity, DvcAction, SrcIpAddr, SrcPortNumber, DstIpAddr, DstPortNumber, NetworkProtocol, SrcBytes, DstBytes, NetworkDirection, EventProduct, EventVendor
- Authentication: EventType="Logon", EventSchema="Authentication", EventResult, TargetUsername, SrcIpAddr, TargetHostname, LogonMethod, EventProduct, EventVendor
Values must be valid Cribl eval expressions.`,

  chronicle: `Google Chronicle UDM — dot notation:
- metadata.event_type (NETWORK_CONNECTION/USER_LOGIN/PROCESS_LAUNCH/GENERIC_EVENT), metadata.vendor_name, metadata.product_name
- principal.ip, principal.port, principal.hostname, principal.user.userid, principal.process.file.full_path, principal.process.command_line
- target.ip, target.port, target.hostname, target.user.userid
- network.ip_protocol, network.sent_bytes, network.received_bytes
- security_result.action (ALLOW/BLOCK), security_result.severity, security_result.rule_name
- extensions.auth.type
Values must be valid Cribl eval expressions.`,

  xsiam: `Cortex XSIAM passthrough — preserve _raw, tag routing metadata only. Do NOT field-map.
- Preserve Cribl __inputId for the Integration-Identifier header
- __sourceIdentifier: per-source UUID from XSIAM data-source catalog
- __vendor + __product: exact, case-sensitive INGEST values required with generic UUID af01292940d7426594d3d3e55ae17ee0
- Preserve the source-native payload shape expected by the demisto content-pack ParsingRule/ModelingRule
- cef_extract: regex __vendor/__product from CEF header for Check Point
- zscaler_wrap: event=_raw + serialize JSON envelope for Zscaler ZIA
Values must be valid Cribl eval expressions.`,

  json: `Clean normalized JSON — flat structure:
- event_type, timestamp, src_ip, src_port, dst_ip, dst_port, protocol, action, outcome
- user, src_host, dst_host, app, rule, severity
- bytes_in, bytes_out, duration, process_name, command_line, sourcetype
Only include fields relevant to the data. Values must be valid Cribl eval expressions.`,
};



// --- Knowledge-base lookup plumbing -----------------------------------------
// Every loader below grounds an AI prompt. A WRONG hit is worse than no hit: the
// model gets confidently mis-grounded and produces a plausible pipeline that
// scores near-zero, with no error anywhere (the sap_audit build-430 and
// empty-extraction build-364/365 incidents both had this shape).
//
// The old resolver was `k.includes(st) || st.includes(k)` over the whole table,
// returning the FIRST insertion-order hit. Against the real 1,279-key catalog
// that meant: 'audit' → push_audit_api_key_added, 'trail' → cloudtrail_to_azure
// _sentinel, 'cisco' → cisco-asa-drop-based-on-eventID, 'web' → push_security_
// webhook_events. Substring containment in EITHER direction is not similarity.
//
// resolveKnowledgeKey() replaces it with an explicit, ordered ladder and returns
// null rather than a wrong answer:
//   1. exact
//   2. separator-normalized exact  (cisco:asa / cisco-asa / cisco_asa)
//   3. shared alias table          (the run-mode-shared canonical → variants map)
//   4. token-boundary prefix       (key starts with the full probe + separator)
// Bare-substring matching is deliberately NOT a tier.
const SOURCETYPE_ALIASES_PATH = join(__dirname, '..', 'config', 'sourcetype-aliases.json');

// Config caches. These files are 0.6-3.9 MB; re-reading + re-parsing them on
// every prompt build (the old behaviour) cost 4-14 ms each per call for data
// that never changes during a run.
const _jsonCache = new Map();
function readJsonCached(path) {
  if (!_jsonCache.has(path)) _jsonCache.set(path, JSON.parse(readFileSync(path, 'utf-8')));
  return _jsonCache.get(path);
}

// Log a knowledge-base miss ONCE per (context, key). These loaders are
// best-effort by design and all return '' on failure, which makes "config is
// missing/renamed" indistinguishable from "no reference data for this source" —
// CLAUDE.md notes these silent failures "look like a data problem". One line on
// the dev console, never on the happy path.
const _warned = new Set();
function warnOnce(context, detail) {
  const key = `${context}::${detail}`;
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`[ai-advisor] ${context}: ${detail}`);
}

const normalizeStName = (s) => (s || '').trim().toLowerCase()
  .replace(/[\s:/\-.]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

let _aliasVariants = null;
// canonical sourcetype -> its declared variants, plus each variant -> canonical.
function aliasVariantsFor(st) {
  if (!_aliasVariants) {
    _aliasVariants = new Map();
    try {
      const aliases = readJsonCached(SOURCETYPE_ALIASES_PATH).aliases || {};
      for (const [canonical, variants] of Object.entries(aliases)) {
        const all = [canonical, ...variants].map(normalizeStName);
        for (const v of all) {
          if (!_aliasVariants.has(v)) _aliasVariants.set(v, new Set());
          all.forEach((x) => _aliasVariants.get(v).add(x));
        }
      }
    } catch { warnOnce('alias table', `could not read ${SOURCETYPE_ALIASES_PATH}`); }
  }
  return _aliasVariants.get(normalizeStName(st)) || null;
}

// Resolve a probe sourcetype to a real key of `table`, or null. `label` is used
// only for the one-time miss warning.
export function resolveKnowledgeKey(table, sourcetype, label) {
  const raw = (sourcetype || '').toLowerCase().trim();
  if (!raw || !table) return null;
  if (Object.hasOwn(table, raw)) return raw;

  const keys = Object.keys(table);
  const norm = normalizeStName(raw);
  if (!norm) return null;

  // 2. separator-normalized exact match.
  const byNorm = keys.find((k) => normalizeStName(k) === norm);
  if (byNorm) return byNorm;

  // 3. shared alias table. Its values are CURATED catalog-key substrings — that
  //    is their documented semantics, and the curation is the whole point (the
  //    table deliberately says 'zscaler_web_logs' rather than a greedy bare
  //    'zscaler', 'auditd' rather than 'audit'). Curated substrings are safe to
  //    match loosely; an arbitrary caller-supplied probe is NOT, which is why
  //    tier 4 stays strict. Longest variant first = most specific.
  const variants = aliasVariantsFor(norm);
  if (variants) {
    for (const v of [...variants].sort((a, b) => b.length - a.length)) {
      const hits = keys.filter((k) => normalizeStName(k).includes(v));
      if (hits.length) return hits.sort((a, b) => a.length - b.length)[0];
    }
  }

  // 4. token-boundary prefix: 'cisco_asa' may resolve 'cisco_asa_traffic', but
  //    'cisco' must NOT resolve 'cisco-asa-drop-based-on-eventID'. Require the
  //    probe to be multi-token so single vendor words can't match broadly.
  if (norm.includes('_')) {
    const prefixed = keys.filter((k) => normalizeStName(k).startsWith(`${norm}_`));
    if (prefixed.length === 1) return prefixed[0];
    // Ambiguous prefix → prefer the shortest (closest to the probe) only when it
    // is unambiguously shorter than the rest; otherwise refuse.
    if (prefixed.length > 1) {
      const sorted = prefixed.sort((a, b) => a.length - b.length);
      if (sorted[0].length < sorted[1].length) return sorted[0];
    }
  }

  warnOnce(label, `no reference entry for "${sourcetype}" — AI will run ungrounded`);
  return null;
}

// Load reference catalog entry for a sourcetype — returns extraction fields,
// known transformations, and sample availability.
function loadReferenceCatalog(sourcetype) {
  try {
    const catalog = readJsonCached(REFERENCE_CATALOG_PATH);
    const key = resolveKnowledgeKey(catalog.sourcetypes, sourcetype, 'reference catalog');
    const entry = key ? catalog.sourcetypes[key] : null;
    if (!entry) return '';
    let context = '\nREFERENCE DATA available for this sourcetype:\n';
    if (entry.extractionFields?.length > 0) {
      context += '  Known fields: ' + entry.extractionFields.slice(0, 40).join(', ') + '\n';
    }
    if (Object.keys(entry.transformations || {}).length > 0) {
      context += '  Known transformations: ' + Object.entries(entry.transformations).map(([k,v]) => k + ' (' + v + ')').join(', ') + '\n';
    }
    return context;
  } catch { return ''; }
}

// Load extraction template for a sourcetype — returns the professional extraction
// functions that should be used as a reference or starting point.
function loadExtractionTemplate(sourcetype) {
  try {
    const templates = readJsonCached(EXTRACTION_TEMPLATES_PATH);
    const key = resolveKnowledgeKey(templates.templates, sourcetype, 'extraction template');
    const template = key ? templates.templates[key] : null;
    if (!template) return '';
    let context = '\nGOLDEN EXTRACTION TEMPLATE (from professional pack ' + template.pack + '):\n';
    context += '  Fields extracted: ' + template.fields.slice(0, 30).join(', ') + '\n';
    context += '  Functions:\n';
    for (const f of template.functions.slice(0, 3)) {
      context += '    - ' + f.id + ': ' + (f.description || JSON.stringify(f.conf).slice(0, 150)) + '\n';
    }
    return context;
  } catch { return ''; }
}

// Load Cortex XSIAM content-pack field contract for a sourcetype (from Simon's
// sync-xsiam-content import). `modelInputPaths` = the source JSON paths the
// XSIAM modeling rules actually read = an authoritative "extract these" list.
// Grounds the AI parser toward the fields Palo Alto's own model considers
// meaningful, instead of guessing. Best-effort, returns '' if none.
function loadXsiamModelPaths(sourcetype) {
  try {
    const data = JSON.parse(readFileSync(XSIAM_SOURCES_PATH, 'utf-8'));
    const sources = data.sources || {};
    const st = (sourcetype || '').toLowerCase();
    let src = sources[st];
    if (!src) {
      src = Object.values(sources).find(s =>
        (s.aliases || []).some(a => String(a).toLowerCase() === st) ||
        String(s.product || '').toLowerCase() === st);
    }
    const paths = src?.modelInputPaths || [];
    if (!paths.length) return '';
    let context = `\nCORTEX XSIAM MODEL CONTRACT (${src.contentPack || 'content pack'} — authoritative fields the vendor's XSIAM modeling rules read):\n`;
    context += '  Extract these source paths (they carry the meaningful signal for this source): ' + paths.slice(0, 40).join(', ') + '\n';
    return context;
  } catch { return ''; }
}

// Load transformation template for sourcetype + destination format.
function loadTransformationTemplate(sourcetype, destFormat) {
  try {
    const templates = readJsonCached(TRANSFORMATION_TEMPLATES_PATH);
    const st = (sourcetype || '').toLowerCase();
    const df = (destFormat || '').toLowerCase();
    // Try exact key match
    let template = templates.templates[st + ':' + df];
    // Keys are `sourcetype:destFormat`. Narrow to THIS destination first, then
    // resolve the sourcetype side through the same precise ladder — the old
    // bare-substring match let an unrelated source's mapping template ground a
    // completely different vendor (see resolveKnowledgeKey).
    if (!template) {
      const sameDest = {};
      for (const k of Object.keys(templates.templates)) {
        const idx = k.lastIndexOf(':');
        if (idx > 0 && k.slice(idx + 1) === df) sameDest[k.slice(0, idx)] = k;
      }
      const key = resolveKnowledgeKey(sameDest, st, `transformation template (${df})`);
      if (key) template = templates.templates[sameDest[key]];
    }
    if (!template) return '';
    let context = '\nGOLDEN TRANSFORMATION TEMPLATE (from ' + template.pack + '/' + template.pipeline + '):\n';
    context += '  Source: ' + template.sourcetype + ' → Destination: ' + template.destFormat + '\n';
    context += '  Mappings:\n';
    for (const f of template.functions) {
      if (f.conf?.add) {
        for (const a of f.conf.add.slice(0, 15)) {
          context += '    ' + a.name + ' = ' + (a.value || '').toString().slice(0, 80) + '\n';
        }
      }
    }
    return context;
  } catch { return ''; }
}

// Ground the DESTINATION side of the mapping in the FORMAL target-field list
// from golden-formats.json (not prose). Copilot feeds the actual JSON Schema to
// its generator; this is our equivalent — the exact target field names + which
// are numeric — so the AI stops inventing target-schema field names.
let _goldenFormatsCache = null;
function loadGoldenTargetFields(destFormat) {
  try {
    if (!_goldenFormatsCache) _goldenFormatsCache = JSON.parse(readFileSync(GOLDEN_FORMATS_PATH, 'utf-8'));
    const formats = _goldenFormatsCache.formats || {};
    let spec = formats[(destFormat || '').toLowerCase()];
    if (spec?.aliasOf) spec = formats[spec.aliasOf];
    if (!spec) return '';
    let fields, numeric;
    if (spec.outputShape === 'raw' && Array.isArray(spec.extension)) {
      // CEF: extension keys are the target fields.
      fields = spec.extension.map(e => e.key);
      numeric = [];
    } else if (Array.isArray(spec.canonicalMap)) {
      fields = spec.canonicalMap.map(m => m.dest);
      numeric = spec.canonicalMap.filter(m => m.number || m.literalNumber).map(m => m.dest);
    } else return '';
    if (!fields.length) return '';
    let ctx = `\n\n════ TARGET SCHEMA FIELDS for ${destFormat} (use these EXACT destField names) ════\n`;
    ctx += fields.join(', ');
    if (numeric.length) ctx += `\nNumeric fields (emit as numbers, e.g. Number(src_port)): ${numeric.join(', ')}`;
    ctx += `\nUse ONLY these destField names for ${destFormat}. Do not invent target field names not in this list; omit a field rather than rename it.\n`;
    return ctx;
  } catch { return ''; }
}

let _sentinelDestinationsCache = null;
let _sentinelSolutionMappingsCache = null;
// Must stay byte-identical to SENTINEL_NATIVE_VALUE_RULE in src/sentinel-knowledge.ts.
export const SENTINEL_NATIVE_VALUE_RULE =
  'Value contract: this table is the vendor\'s OWN log shape, so every column takes the vendor\'s own value VERBATIM (e.g. an AWS VPC flow Action is ACCEPT/REJECT). Never substitute a normalized vocabulary (allowed/blocked, Success/Failure) — that belongs in CIM/ASIM, not here. Where the parse stage normalized a value it preserves the original as vendor_<field> (vendor_action, vendor_severity); prefer that field for such a column.';
const normalizeSentinelName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function loadSentinelTargetContext(sourcetype, destFormat) {
  try {
    if (!_sentinelDestinationsCache) _sentinelDestinationsCache = JSON.parse(readFileSync(SENTINEL_DESTINATIONS_PATH, 'utf-8'));
    const catalog = _sentinelDestinationsCache;
    let resolved = null;
    for (const [name, table] of Object.entries(catalog.tables || {})) {
      const names = [name, ...(table.aliases || []), table.inputStream, table.outputStream];
      if (names.some((candidate) => normalizeSentinelName(candidate) === normalizeSentinelName(destFormat))) {
        resolved = { name, table };
        break;
      }
    }
    if (!resolved) return { schema: '', mappings: '' };

    const columns = resolved.table.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    // Hard Rule 18 — the iframe path says the same thing from
    // SENTINEL_NATIVE_VALUE_RULE / isVendorNativeSentinelTable in
    // src/sentinel-knowledge.ts. Kept as a literal because this handler is pure
    // Node and imports nothing from src/; a test asserts the two never drift.
    const isVendorNative = !/^asim/i.test(resolved.name) && !['commonsecuritylog', 'syslog'].includes(resolved.name.toLowerCase());
    const valueRule = isVendorNative ? ` ${SENTINEL_NATIVE_VALUE_RULE}` : '';
    const schema = `Microsoft Sentinel native table ${resolved.name}. Emit flat top-level fields; never serialize the event into _raw. Cribl destination streamName=${resolved.table.inputStream}; Azure outputStream=${resolved.table.outputStream}. Exact columns and types: ${columns}. Unknown fields must be removed before delivery. TimeGenerated must be ISO-8601 UTC from source event time.${valueRule} Validate against the deployed DCR because this is a versioned schema snapshot.`;

    if (!_sentinelSolutionMappingsCache) _sentinelSolutionMappingsCache = JSON.parse(readFileSync(SENTINEL_SOLUTION_MAPPINGS_PATH, 'utf-8'));
    const st = normalizeSentinelName(sourcetype);
    const lines = [];
    for (const pack of _sentinelSolutionMappingsCache) {
      if (!(pack.solutionKeywords || []).some((keyword) => st.includes(normalizeSentinelName(keyword)) || normalizeSentinelName(keyword).includes(st))) continue;
      let mappings = pack.mappings || [];
      const tableMappings = mappings.filter((m) => String(m.doc || '').toLowerCase().includes(`-> ${resolved.name.toLowerCase()}`));
      if (tableMappings.length) mappings = tableMappings;
      for (const mapping of mappings.slice(0, 200)) lines.push(`${mapping.sourceName} -> ${mapping.destName}`);
    }
    const mappings = lines.length
      ? `\n\nOFFICIAL SENTINEL SOLUTION DCR MAPPINGS (higher authority than generic aliases):\n${lines.join('\n')}`
      : '';
    return { schema, mappings };
  } catch {
    return { schema: '', mappings: '' };
  }
}

// Ground the mapping on a specific Splunk CIM data model's field list. Distilled
// from the Splunk CIM Add-on JSON models (config/cim-data-models.json). Returns a
// schema-hint string listing the model's exact CIM field names + types so the AI
// maps to them (the CIM counterpart of loadSentinelTargetContext).
let _cimModelsCache = null;
const CIM_FORMAT_TO_MODEL = {
  network: 'Network_Traffic',
  authentication: 'Authentication',
  email: 'Email',
  web_proxy: 'Web',
  dns: 'Network_Resolution',
  endpoint: 'Endpoint',
  change: 'Change',
  cloud_audit: 'Change',
  audit: 'Change',
  intrusion_detection: 'Intrusion_Detection',
  malware: 'Malware',
  network_sessions: 'Network_Sessions',
  data_access: 'Data_Access',
  dlp: 'DLP',
  vulnerabilities: 'Vulnerabilities',
  alerts: 'Alerts',
};
function cimModelFromDestFormat(destFormat, cimModel) {
  if (cimModel) return cimModel;
  const m = String(destFormat || '').match(/^cim#(.+)$/i);
  if (!m) return '';
  const key = m[1];
  return CIM_FORMAT_TO_MODEL[key] || CIM_FORMAT_TO_MODEL[key.toLowerCase()] || key;
}
function loadCimModelContext(cimModel) {
  if (!cimModel) return '';
  try {
    if (!_cimModelsCache) _cimModelsCache = JSON.parse(readFileSync(CIM_MODELS_PATH, 'utf-8'));
    const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const models = _cimModelsCache.models || {};
    let resolved = null;
    for (const [name, model] of Object.entries(models)) {
      if (norm(name) === norm(cimModel) || norm(model.displayName) === norm(cimModel)) { resolved = { name, model }; break; }
    }
    if (!resolved) return '';
    const seen = new Set(); const cols = [];
    for (const o of resolved.model.objects || []) for (const f of o.fields || []) if (!seen.has(f.name)) { seen.add(f.name); cols.push(`${f.name}:${f.type}`); }
    return `Splunk CIM data model ${resolved.name} (${resolved.model.displayName}). Map to these EXACT canonical CIM field names (flat, top-level; e.g. dest_ip/src_ip/dest_port/src_port/user/action/bytes_in/bytes_out). Fields the source cannot supply are simply omitted; never invent values. Fields and types: ${cols.join(', ')}.`;
  } catch { return ''; }
}

// Sample resolution used to live here (referenceEntryFor / hasReferenceSample /
// loadReferenceSample, reading config/sample-library/). It is now the shared tier ladder
// in src/sample-library.ts + reference-api.mjs `resolveFallbackSample`, which every run
// mode goes through, so this copy was dead code — removed rather than left to drift.

// Destination + source constraints (src/optimization-knowledge.ts, the same
// block the browser client sends). A missing module degrades to no guidance.
async function knowledgeGuidance(sourcetype, destFormat, mode) {
  try {
    const { optimizationGuidance } = await import('../src/optimization-knowledge.ts');
    return optimizationGuidance(sourcetype, destFormat, mode);
  } catch {
    return '';
  }
}

export async function handleAiAdvise(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { sourcetype, destFormat, sampleSnippet, allowCodeFunctions } = JSON.parse(body);

    const systemPrompt = `You are a Cribl Stream pipeline architect. Return ONLY valid JSON — no markdown, no code fences, no text outside the JSON.

Be concise: each string value should be 1-2 sentences max. Lists should have 3-5 items max, each under 15 words.

Required JSON shape:
{"summary":"...","parseStrategy":"...","mappingNotes":"...","reductionOpportunities":["..."],"risks":["..."],"pipelineSteps":["..."],"reductions":[{"id":"...","label":"...","description":"...","defaultEnabled":true/false,"reduction":N}]}

The "reductions" array is CRITICAL — it must contain 4-6 concrete, sourcetype-specific data reduction options based on what you ACTUALLY SEE in the sample events. For each option:
- id: snake_case identifier (e.g. "drop_noise", "remove_null_fields", "compact_output")
- label: short human-readable label (e.g. "Drop health check events")
- description: one sentence explaining EXACTLY what gets dropped/reduced and WHY, referencing specific event IDs, field names, or patterns you observed in the sample data
- defaultEnabled: true for safe reductions (null field removal, compacting), false for aggressive ones (dropping event types)
- reduction: estimated percentage of data volume this would eliminate, based on what you see in the sample. Be realistic — count the proportion of events or fields that match. Use 0 if you cannot estimate.

Always include these standard options (with accurate descriptions for this sourcetype):
1. A noise-dropping option (specific event IDs/types that are high-volume low-value in the sample)
2. Remove null/empty fields (describe which fields you see are empty/null in the sample)
3. Compact JSON output (describe the input format and what compacting achieves)
4. Field cleanup (which internal/temp fields to remove)
Plus 1-2 sourcetype-specific options based on patterns in the actual sample data.

Cribl context:
- Functions: comment, eval, serde, regex_extract, rename, drop, serialize, mask, lookup
${allowCodeFunctions ? '- Code functions are allowed, but still prefer regex_extract + eval' : '- IMPORTANT: Do NOT recommend code functions — prefer regex_extract + eval'}
- Eval cannot use arrow functions or function declarations
- CEF = Microsoft Sentinel CommonSecurityLog (DeviceVendor, SourceIP, DestinationIP, DeviceAction, etc.)
- OCSF = v1.4 schema (class_uid, category_uid, src_endpoint, dst_endpoint, etc.)
- CIM = Splunk (src, dest, action, app, user, bytes_in, bytes_out, etc.)`;

    const guidance = await knowledgeGuidance(sourcetype, destFormat, 'advise');
    const userPrompt = `Source: ${sourcetype}
Destination format: ${destFormat}
Code functions allowed: ${allowCodeFunctions ? 'yes' : 'no'}${guidance}
${sampleSnippet ? `\nSample events (analyze these to estimate reduction percentages — count how many would be dropped by each filter):\n${sampleSnippet}` : ''}

Provide your pipeline recommendations as JSON. For the "reductions" array, base your estimates on the actual events shown above — count how many events match each drop filter and what proportion of fields are null/empty. Every reduction must respect the destination constraints above (a destination that parses the original line allows only whole-event reductions).`;

    const text = await invokeModel(MODEL_ID, systemPrompt, userPrompt, 3000);

    let advice;
    try {
      advice = JSON.parse(text);
    } catch {
      // Try extracting JSON from markdown code fences
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        advice = JSON.parse(fenceMatch[1].trim());
      } else {
        // Last resort: find first { to last }
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
          advice = JSON.parse(text.substring(start, end + 1));
        } else {
          throw new Error('AI did not return valid JSON');
        }
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(advice));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'AI advisor failed' }));
  }
}

export async function handleAiAnalyzeTrace(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { traceSummary, comment } = JSON.parse(body);

    const systemPrompt = `You are a Cribl Stream pipeline reviewer. You are given a condensed build trace for one or more generated pipelines (source recognition, candidate scores, chosen stage sources, key events, and the final pipeline's function composition) plus a note from the person who built it about what they think is wrong.

Answer in plain text (no JSON, no markdown headers) in 3 short sections:
1. What the trace actually shows — cite specific stage scores, reasons, or events that support or contradict the reporter's comment.
2. Likely root cause(s) of the quality problem, grounded ONLY in what appears in the trace (do not invent fields or events not mentioned).
3. Concrete next steps in the Cribl Pack Generator app to improve it (e.g. re-run with a real/extended sample, add a static parser for this sourcetype, adjust the destination format mapping, check for a canonical field-name mismatch) — be specific to what the trace shows, not generic advice.

Keep the whole answer under 300 words.`;

    const userPrompt = `Reporter's comment on what is wrong with this pack:
${(comment || '').trim() || '(no comment provided — just analyze the trace for signs of a quality problem)'}

Build trace:
${traceSummary}`;

    const text = await invokeModel(MODEL_ID, systemPrompt, userPrompt, 1200);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'AI trace analysis failed' }));
  }
}

export async function handleAiMapping(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { sourcetype, destFormat, sampleSnippet, parsedFields, improveHints, model, cimModel } = JSON.parse(body);
    // Optional per-request model override (second-model retry). Defaults otherwise.
    const modelId = (typeof model === 'string' && model.trim()) ? model.trim() : MODEL_ID;
    const sentinelContext = loadSentinelTargetContext(sourcetype, destFormat);
    // CIM: when a specific data model was recommended/selected, ground on ITS
    // exact field list (overrides the generic CIM hint) — the recommend-and-map
    // flow, same idea as the Sentinel table grounding.
    const cimSchema = (destFormat === 'cim' || String(destFormat || '').startsWith('cim#'))
      ? loadCimModelContext(cimModelFromDestFormat(destFormat, cimModel))
      : '';
    // A concretized OCSF key (ocsf#dhcp) gets its class's vendored schema, not the
    // generic multi-class blurb (which only knows four classes).
    let ocsfClassHint = '';
    if (/^ocsf#/.test(String(destFormat || ''))) {
      try {
        const { ocsfMappingHintForKey } = await import('../src/ocsf-schema.ts');
        ocsfClassHint = ocsfMappingHintForKey(destFormat) || '';
      } catch { /* schema index unavailable — generic hint */ }
    }
    const schemaHint = cimSchema || ocsfClassHint || DEST_SCHEMA_HINTS[destFormat] || sentinelContext.schema || DEST_SCHEMA_HINTS['json'];

    // Load golden pipeline reference if available
    let goldenHint = '';
    try {
      const { getGoldenPipeline } = await import('./schema-validator.mjs');
      const { goldenWireFormatForSample } = await import('../src/golden-variant.ts');
      // Same wire-format variant as the build: a key=value golden's mappings
      // name fields a CEF parser never produces.
      const golden = getGoldenPipeline(sourcetype, destFormat, goldenWireFormatForSample(sampleSnippet));
      if (golden && golden.functions) {
        const evalFns = golden.functions.filter(f => f.id === 'eval' && f.conf?.add);
        const mappingPairs = evalFns.flatMap(f => (f.conf.add || []).map(a => `${a.name} = ${a.value}`));
        if (mappingPairs.length > 0) {
          goldenHint = `\n\nREFERENCE — a previously validated pipeline (score ${golden.score}) used these mappings. Produce equivalent or better:\n${mappingPairs.slice(0, 25).join('\n')}\n`;
        }
      }
    } catch { /* golden not available */ }

    const systemPrompt = `You are a field mapping expert for log data normalization. Given sample events from a specific source and a target schema, produce precise field mappings.

Return ONLY valid JSON with this shape:
{"mappings":[{"sourceField":"<field from parsed event>","destField":"<target schema field>","expression":"<Cribl eval expression>"}],"classInfo":{"class_uid":"...","category_uid":"...","event_type":"..."}}

Rules for expressions:
- Must be valid Cribl eval expressions (NO arrow functions, NO function keyword, NO optional chaining ?., NO nullish coalescing ??)
- destField names must be valid Cribl accessor paths: letters/digits/_ per dotted segment, not starting with a digit. Do NOT use '@' prefixes (e.g. write 'timestamp' or 'event_time', never '@timestamp') or hyphens/spaces in field names.
- Use field names directly: src_ip, EventID, action — these are available after parsing
- IMPORTANT: Only use field names from the "Available fields after parsing" list below. Do NOT invent field names that don't exist.
- For string literals use single quotes: 'TCP'
- For conditionals: action == 'allow' ? 'Success' : 'Failure'
- For type coercion: src_port ? Number(src_port) : undefined, String(EventID || '') — never default a missing number to 0; a value the event does not carry must stay absent
- For string methods: (protocol || '').toUpperCase()
- For fallback chains: src_ip || srcaddr || srcip || ''
- For nested source fields use && chains: properties && properties.status && properties.status.errorCode

classInfo should contain schema-specific class/type identifiers (e.g. OCSF class_uid, UDM event_type, ASIM EventSchema).

CEF-SPECIFIC RULES (when target is CEF):
- DeviceEventClassID: the source's NATIVE code when it has one (ASA/FTD code like 302014 used VERBATIM with no product prefix — never "asa:302014"; Windows EventID; PAN threat ID). Synthesize "class:subclass" only when there is no native code.
- Activity: a SHORT human-readable name DIFFERENT from DeviceEventClassID (e.g. "Login Failed", "Email Sent") — NOT the raw message, NOT the same as DeviceEventClassID
- LogSeverity: MUST be a number 0-10. Never a word like "high"/"low"
- Do NOT map any field to "Severity" — only use "LogSeverity"
- Do NOT create DeviceCustomString fields for severity/log level — that already goes in the header
- Only map DeviceCustomStringN if you also map DeviceCustomStringNLabel — always in pairs
- Extension fields should use CEF short names: src, suser, dhost, dpt, act, app, rt, msg, duser

Produce 10-20 mappings covering all relevant fields from the source data. Focus on fields actually present in the sample.`;

    // Inject pipeline rules + field schema map + golden lookups knowledge base
    const rules = loadPipelineRules();
    const fieldMap = loadFieldSchemaMap(destFormat);
    const lookupsContext = loadGoldenLookups(sourcetype);
    const transformContext = loadTransformationTemplate(sourcetype, destFormat);
    const targetFieldsContext = loadGoldenTargetFields(destFormat);
    const refCatalogContext = loadReferenceCatalog(sourcetype);
    const rulesContext = rules ? `\n\n--- Pipeline Generation Rules ---\n${rules}\n--- End Rules ---\n` : '';
    const fieldMapContext = fieldMap ? `\n\n--- Field Name Reference (use EXACT names for ${destFormat}) ---\n${fieldMap}\n--- End Field Reference ---\n` : '';

    let fieldsContext = '';
    if (parsedFields && parsedFields.length > 0) {
      fieldsContext = `\n\n════ SOURCE FIELDS (the parse stage produces EXACTLY these) ════
${parsedFields.join(', ')}

CRITICAL — SOURCE→DESTINATION SEPARATION:
- Every mapping has two sides: destField (the target-schema name) and expression (JS that READS the source).
- The expression MUST read ONLY from the SOURCE FIELDS listed above. Example for CEF: destField "src" → expression "src_ip" (NOT "src"). destField "dpt" → expression "dest_port" (NOT "dpt").
- NEVER write an expression that reads a target-schema name (src, dst, spt, dpt, suser…) as if it were a source field — those do not exist at this stage; doing so yields empty output.
- If a target field has no corresponding source field above, OMIT that mapping. Do not invent source fields.
- Ground every single expression in the list above.\n`;
    }

    // When retrying to raise a low score, TARGET the specific problems the
    // previous validation surfaced instead of regenerating blind.
    let improveContext = '';
    if (improveHints && (improveHints.findings?.length || improveHints.missingFields?.length || improveHints.emptyFields?.length)) {
      const f = (improveHints.findings || []).map(x => `- [${x.severity}] ${x.field}: ${x.issue}`).join('\n');
      const mf = (improveHints.missingFields || []).map(x => `- ${x}`).join('\n');
      const ef = (improveHints.emptyFields || []).map(x => `- ${x}`).join('\n');
      improveContext = `\n\n════ FIX THESE PROBLEMS FROM THE LAST ATTEMPT (this is why the score was low) ════
Findings to resolve:
${f || '(none)'}
Missing fields — values present in the source but NOT mapped; ADD a mapping for each:
${mf || '(none)'}
Empty fields — mapped but blank; populate from the correct source field or omit:
${ef || '(none)'}
Prioritize resolving the above. Keep everything that already works.\n`;
    }
    const guidanceContext = typeof improveHints?.guidance === 'string' && improveHints.guidance.trim()
      ? `\n\nOPERATOR GUIDANCE (must honour unless it would break Cribl eval rules):
${improveHints.guidance.trim()}\n`
      : '';
    const currentPipelineContext = Array.isArray(improveHints?.currentFunctions) && improveHints.currentFunctions.length
      ? `\n\n════ CURRENT PIPELINE FUNCTIONS (preserve working behavior unless improving it) ════
${JSON.stringify(improveHints.currentFunctions).slice(0, 12000)}
`
      : '';

    const shapeGuidance = await knowledgeGuidance(sourcetype, destFormat, 'mapping');
    const userPrompt = `Source: ${sourcetype}
Target schema: ${destFormat}

Target schema reference:
${schemaHint}${shapeGuidance}
${targetFieldsContext}${sentinelContext.mappings}${fieldsContext}${goldenHint}${rulesContext}${fieldMapContext}${lookupsContext}${transformContext}${refCatalogContext}${improveContext}${guidanceContext}${currentPipelineContext}
Sample events (first 5):
${sampleSnippet}
${learningsPromptFor(sourcetype, destFormat)}
Generate precise field mappings. Each mapping's expression must read from the SOURCE FIELDS listed above; the destField uses the target schema's naming. Map only fields that exist in the source.`;

    const text = await invokeModel(modelId, systemPrompt, userPrompt, 4096);

    let mapping;
    try {
      mapping = JSON.parse(text);
    } catch {
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        mapping = JSON.parse(fenceMatch[1].trim());
      } else {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
          mapping = JSON.parse(text.substring(start, end + 1));
        } else {
          throw new Error('AI did not return valid JSON');
        }
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mapping));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'AI mapping failed' }));
  }
}

export async function handleAiParse(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { sourcetype, sampleSnippet, model, guidance } = JSON.parse(body);
    // Optional per-request model override (used for the second-model retry when a
    // stage stays below the golden threshold). Falls back to the default.
    const modelId = (typeof model === 'string' && model.trim()) ? model.trim() : MODEL_ID;

    const systemPrompt = `You are an expert at building Cribl Stream pipeline parse functions. Given sample log events, generate the correct Cribl pipeline functions to extract structured fields from _raw.

Return ONLY valid JSON with this shape:
{"functions":[...array of Cribl pipeline function objects...]}

Each function object must be a valid Cribl pipeline function with this structure:
- id: "regex_extract" | "eval" | "serde"
- filter: JS expression string (usually "true")
- disabled: false
- description: short explanation
- conf: configuration object specific to the function type

IMPORTANT: Do NOT use "code" functions. Use only regex_extract and eval.

For regex_extract:
- conf.source: "_raw" (the field to extract from) — or another field name if extracting from a previously parsed field
- conf.regex: "/regex with (?<named_groups>...)/" (Cribl regex format with forward slashes)
- conf.iterations: 1
- conf.overwrite: false

For eval:
- conf.add: array of {name, value} objects
- conf.remove: optional array of field names to remove
- value must be a valid Cribl eval expression (NO arrow functions, NO function keyword, NO optional chaining ?., NO nullish coalescing ??)
- Use ternary expressions for conditionals: field.match(/pattern/) ? 'value1' : 'value2'
- For capture groups, assign the match to a field first, then index it — do NOT use ?. . Prefer a regex_extract function over inline .match() for pulling fields out of _raw.

For serde (ONLY for confirmed JSON/CSV/KVP sources):
- conf.mode: "extract"
- conf.type: "json" | "csv" | "kvp"
- conf.srcField: "_raw"

Rules:
- Analyse the sample events to determine the log format (text with brackets, syslog, JSON, CSV, KVP, etc.)
- For text-based logs: use regex_extract to parse the base structure, then additional regex_extract functions (with filters) to handle different message patterns, and eval for classification
- For JSON logs: use serde with type "json"
- For CSV logs: use serde with type "csv" with appropriate field names
- For KVP logs: use serde with type "kvp" with correct delimiters
- NEVER use serde type "json" on non-JSON text logs
- Named capture groups in regex must produce meaningful field names
- Use MULTIPLE regex_extract functions with appropriate filters to handle different event patterns (e.g. filter: "message && message.startsWith('Successful login')")
- Use eval functions with ternary chains for event classification
- After parsing, the following fields should be available: user, src_ip, dst_ip, dst_host, dst_port, action, protocol, severity, timestamp, message, etc. — whatever the source contains
- Keep it minimal: 2-6 functions total for most formats (regex_extract + eval, no code)`;

    const parseRules = loadPipelineRules();
    const parseRulesContext = parseRules ? `\n\nRelevant pipeline rules:\n${parseRules.split('\n').filter(l => /Rule [1-5]|Field Lifecycle|Timestamp|CEF Key-Value|Match Parse/.test(l)).join('\n')}\nFull rules available — key point: field names produced by parse stages are what mapping stages will consume. Use consistent, clean names.` : '';
    const parseLookupsContext = loadGoldenLookups(sourcetype);
    const referenceContext = loadReferenceCatalog(sourcetype);
    const extractionContext = loadExtractionTemplate(sourcetype);
    const xsiamModelContext = loadXsiamModelPaths(sourcetype);
    const guidanceContext = typeof guidance === 'string' && guidance.trim()
      ? `\n\nOPERATOR GUIDANCE (must honour unless it would break Cribl eval rules):
${guidance.trim()}\n`
      : '';

    const userPrompt = `Source type: ${sourcetype}

Sample events (first lines from _raw):
${sampleSnippet}
${parseRulesContext}${parseLookupsContext}${referenceContext}${extractionContext}${xsiamModelContext}${guidanceContext}
Analyze the format and generate the minimal set of Cribl pipeline functions needed to parse these events into structured fields.`;

    // Salvage a {"functions":[...]} object from a model response that may be
    // wrapped in prose / markdown fences. Returns the parsed object with a real
    // functions[] array, or null if none can be recovered. Heterogeneous
    // free-text sources (e.g. aruba_wireless_ap: 15+ distinct message shapes)
    // intermittently make the reasoning model interleave prose or emit reduction
    // rules instead of functions — so a parse that yields no functions[] is a
    // failure to retry, not a success.
    const salvageFunctions = (text) => {
      const candidates = [];
      candidates.push(text);
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) candidates.push(fence[1].trim());
      const start = text.indexOf('{'), end = text.lastIndexOf('}');
      if (start !== -1 && end > start) candidates.push(text.substring(start, end + 1));
      for (const c of candidates) {
        try {
          const p = JSON.parse(c);
          // Require REAL function objects (id + conf), not prose descriptions —
          // the advise-shape emits functions/pipelineSteps as ["text", …] which
          // must count as a failure so the reinforced retry fires.
          if (p && Array.isArray(p.functions) && p.functions.some(f => f && typeof f === 'object' && f.id)) {
            p.functions = p.functions.filter(f => f && typeof f === 'object' && f.id);
            return p;
          }
        } catch { /* try next candidate */ }
      }
      return null;
    };

    // ONE reinforced retry on failure. A single retry-on-bad-output is cheaper
    // (and more deterministic) than letting prepareSource return null and having
    // every destination format re-derive extraction from scratch downstream.
    // Proven wording (verified 4/4 on the pathological aruba_wireless_ap sample):
    // the reasoning model intermittently answers with an ADVISE-shaped object
    // ({summary, parseStrategy, pipelineSteps:[...prose...], reductions}) instead
    // of the functions contract. Naming the forbidden keys + "OBJECT not text
    // description" snaps it back to real Cribl function objects.
    const REINFORCE = '\n\nCRITICAL OUTPUT CONTRACT: Respond with ONLY a single JSON object of the exact shape {"functions":[ ... ]}. Each array element is a Cribl pipeline function OBJECT with id/filter/conf (NOT a text description). No markdown, no prose, no summary/parseStrategy/pipelineSteps keys, no reduction rules — just {"functions":[...]}. Keep it to 2-6 functions.';
    // Apply the reinforced contract on the FIRST attempt too — it's proven to
    // make the functions-shape reliable (4/4 on the worst-case heterogeneous
    // sample) at no extra latency, so the first try succeeds instead of failing
    // to the advise-shape and forcing a second ~20-80s call.
    const RETRY_SUFFIX = '\n\nYour previous response did not follow the contract. Output NOTHING except the JSON object starting with {"functions":[ — no other keys, no commentary.';
    let parsed = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const content = userPrompt + REINFORCE + (attempt === 0 ? '' : RETRY_SUFFIX);
      let text;
      try { text = await invokeModel(modelId, systemPrompt, content, 8192); }
      catch (e) { lastErr = e.message; continue; }
      parsed = salvageFunctions(text);
      if (!parsed) lastErr = 'AI did not return a valid {"functions":[...]} object';
    }
    if (!parsed) throw new Error(lastErr || 'AI did not return valid JSON');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(parsed));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'AI parse generation failed' }));
  }
}
