import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_MODEL as MODEL_ID, invokeModel } from './cribl-auth.mjs';
import { recognizeCefSource } from '../src/source-recognition.ts';
import { describeSampleFormat } from '../src/sample-format.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extra recognizable sourcetypes from the Cribl Search stock datatype library
// (config/datatype-parsers.json) — widens detection well beyond the ~20 built-ins.
function datatypeTaxonomy() {
  try {
    const d = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'datatype-parsers.json'), 'utf-8'));
    return Object.keys(d.parsers || {}).filter(id => !/^generic|^v2_|^Pan_Traffic_Fixed/.test(id));
  } catch { return []; }
}

// All sourcetypes we recognise from bundled config data — if the input matches
// one of these, skip AI validation entirely (instant accept, no false rejects).
let _knownCache = null;
function knownSourcetypes() {
  if (_knownCache) return _knownCache;
  const s = new Set();
  try {
    const gp = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'golden-pipelines.json'), 'utf-8'));
    Object.keys(gp.pipelines || gp).forEach(k => s.add(k.split('::')[0].toLowerCase()));
  } catch {}
  try {
    const rc = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'reference-catalog.json'), 'utf-8'));
    const sts = rc.sourcetypes || rc;
    Object.keys(sts).forEach(k => s.add(k.toLowerCase().replace(/[\s-]+/g, '_')));
  } catch {}
  try {
    const et = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'extraction-templates.json'), 'utf-8'));
    Object.keys(et.templates || et).forEach(k => s.add(k.toLowerCase()));
  } catch {}
  datatypeTaxonomy().forEach(k => s.add(k));
  _knownCache = s;
  return s;
}

// Namespace / collector / tenant prefixes customers prepend to a real sourcetype
// (ncsc:cisco:asa, custom::paloalto). A namespace is NOT a product.
const NAMESPACE_PREFIXES = new Set([
  'ncsc', 'nci', 'custom', 'tenant', 'corp', 'org', 'prod', 'dev', 'test',
  'lab', 'internal', 'ext', 'external', 'collector', 'ingest', 'src', 'source',
]);
// Format / transport tokens that are representation, not a product.
const FORMAT_TOKENS = new Set([
  'syslog', 'cef', 'leef', 'json', 'xml', 'kv', 'kvp', 'raw', 'log', 'logs',
  'estreamer', 'operational', 'rfc3164', 'rfc5424', 'nopri', 'tcp', 'udp',
]);

export async function handleAiValidate(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { sourcetype, destFormat, mode, catalog } = JSON.parse(body);

    // --- Fast-path: only an EXACT hit in bundled reference data is accepted
    // without AI. The old "looks like vendor_product" heuristic wrongly accepted
    // customer-namespaced junk (ncsc_microsoft_sharepoint) as-is — those must go
    // through the grounded resolver so we map to a SUPPORTED name or abstain.
    if (mode !== 'dest' && sourcetype) {
      const norm = sourcetype.trim().toLowerCase().replace(/[\s:/-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      if (knownSourcetypes().has(norm)) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ valid: true, sourcetypeOk: true, destFormatOk: true, suggestion: '', clarification: '' }));
        return;
      }
    }

    // --- Destination-aware validation (mode:'dest') ---------------------------
    // A destination can be a normalized schema (OCSF, ECS, CIM…) OR a specific
    // SIEM table. Notably "Azure Sentinel" is ambiguous — it has MANY tables
    // (CommonSecurityLog, Syslog, SecurityEvent, SigninLogs, the ASIM Asim* set,
    // custom *_CL tables…). Identify the SPECIFIC table when possible.
    const destSystemPrompt = `You validate a DESTINATION for a Cribl Stream pack generator. Return ONLY valid JSON, no markdown.

A destination is either a normalized schema or a specific SIEM/analytics table the data will be written to.

Return JSON:
{"destFormatOk":true/false,"canonical":"the specific recognized destination/table name, or empty","displayName":"a friendly, fully-qualified label including the platform, or empty","suggestion":"comma-separated specific destinations the user likely means, or empty","clarification":"short note (why ambiguous / what to pick), or empty"}

Rules:
- If the input names a SPECIFIC recognized target (e.g. "CommonSecurityLog", "SecurityEvent", "Syslog", "SigninLogs", "AsimNetworkSession", "AsimAuthentication", "OCSF", "Elastic ECS", "Splunk CIM Network Traffic", "Chronicle UDM", "Cortex XSIAM"): destFormatOk=true, canonical=the proper table/schema name, empty clarification.
- ALWAYS set displayName to a friendly fully-qualified label that names the platform so the user sees we understood their intent. Examples: "Syslog"→displayName "Azure Sentinel Syslog", canonical "Syslog"; "sentinel securityevent"→displayName "Azure Sentinel SecurityEvent", canonical "SecurityEvent"; "asim network"→displayName "Azure Sentinel ASIM NetworkSession", canonical "AsimNetworkSession"; "commonsecuritylog"→displayName "Azure Sentinel CommonSecurityLog"; "ecs"→displayName "Elastic ECS"; "cim network traffic"→displayName "Splunk CIM: Network Traffic". Keep canonical as the exact table/schema id used for mapping.
- If the input is an AMBIGUOUS platform with many tables (e.g. "Sentinel", "Azure Sentinel", "Splunk", "Elastic", "Log Analytics"): destFormatOk=false, clarification explains it's ambiguous, and suggestion lists 3-5 SPECIFIC tables/schemas for that platform. Example for "Azure Sentinel": "CommonSecurityLog, Syslog, SecurityEvent, SigninLogs, AsimNetworkSession".
- If gibberish/unknown: destFormatOk=false, empty canonical, suggestion of the closest known schemas ("OCSF, CEF, Splunk CIM, Elastic ECS").
- A reasonable custom table name (e.g. "my_app_events_CL") is acceptable: destFormatOk=true, canonical=that name.`;

    if (mode === 'dest') {
      const destUserPrompt = `Destination: "${destFormat || ''}"${sourcetype ? `\n(source data is: "${sourcetype}")` : ''}`;
      let out = { destFormatOk: true, canonical: '', displayName: '', suggestion: '', clarification: '' };
      try {
        const t = await invokeModel(MODEL_ID, destSystemPrompt, destUserPrompt, 256);
        try { out = JSON.parse(t); } catch {
          const s = t.indexOf('{'), e = t.lastIndexOf('}');
          if (s !== -1 && e > s) { try { out = JSON.parse(t.substring(s, e + 1)); } catch { /* keep default */ } }
        }
      } catch { /* AI unavailable — pass through */ }
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
      return;
    }

    // Ground the resolver in the names the app can actually BUILD. Prefer the
    // client-supplied catalog (the authoritative getSupportedSourcetypeCatalog);
    // fall back to the datatype taxonomy if the client didn't send one.
    const supported = Array.isArray(catalog) && catalog.length
      ? catalog.map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean)
      : datatypeTaxonomy();

    const systemPrompt = `You resolve a customer-delivered sourcetype label to a SUPPORTED sourcetype for a Cribl Stream pack generator. Return ONLY valid JSON, no markdown.

You MUST map to one of the SUPPORTED sourcetypes listed below, or abstain. NEVER invent a name that is not in the list.

SUPPORTED SOURCETYPES:
${supported.join(', ')}

How customers label sources (strip/ignore these — they are NOT the product):
- Namespace / tenant / collector prefixes: ${[...NAMESPACE_PREFIXES].join(', ')} (e.g. "ncsc:cisco:asa" is cisco_asa; "custom::paloalto:traffic" is palo_alto_traffic).
- Format / transport tokens: ${[...FORMAT_TOKENS].join(', ')} (e.g. "cisco_asa_syslog" is cisco_asa; "XmlWinEventLog" is a Windows event log). These describe representation, not the vendor/product.
- Colons, slashes, and double-colons are just separators.

Return JSON:
{"sourcetypeOk":true/false,"isRealSource":true/false,"suggestion":"the single BEST matching SUPPORTED sourcetype (exact name from the list), or a comma-separated shortlist of 2-3 supported names if genuinely ambiguous, or empty string","clarification":"short reason if you can't confidently map it, or empty string","valid":true/false,"destFormatOk":true,"description":"one-sentence description of what this source IS (vendor, product, what it logs) — only if isRealSource, else empty","logFormat":"the log format/encoding this source typically emits (e.g. 'syslog RFC5424', 'key=value', 'JSON', 'CEF', 'CSV', 'XML Windows Event') — only if isRealSource, else empty","typicalFields":["up to ~12 field names this source commonly emits — only if isRealSource, else omit or empty array"]}

"isRealSource" = this label clearly names a REAL, identifiable product/log source from a known vendor (aws:waf, juniper:junos:firewall, citrix:netscaler, f5:bigip, cloudflare:dns, microsoft:sharepoint), REGARDLESS of whether it's in the supported list. false ONLY for gibberish or a token so generic it names no product ("firewall","test","asdf","misc-logs","syslog","metrics").

When isRealSource is true, fill "description", "logFormat", and "typicalFields" from your own knowledge of the product — this is reused later to generate realistic sample events, so be accurate. Do NOT invent fields for a source you don't recognize; leave them empty when isRealSource is false.

Rules:
- If, after stripping namespace/format tokens, the remaining product clearly matches ONE supported name: sourcetypeOk=true, isRealSource=true, suggestion=that exact supported name, empty clarification.
- If it plausibly matches 2-3 supported names: sourcetypeOk=false, isRealSource=true, suggestion=that shortlist, clarification=why.
- If the product is real and identifiable but NOT in the supported list (SharePoint/Cloudflare/Juniper/AWS WAF…): sourcetypeOk=false, isRealSource=true, suggestion="", clarification="Real source, no golden path — build via AI." DO NOT invent a name.
- If it's gibberish/too generic ("firewall","test","asdf","misc-logs"): sourcetypeOk=false, isRealSource=false, suggestion=closest supported names, clarification=why.
- Always output a supported name verbatim in suggestion (copy it from the list) — never a made-up variant.`;

    const userPrompt = `Customer sourcetype label: "${sourcetype || ''}"${destFormat ? `\nDestination format: "${destFormat}"` : ''}`;

    let text;
    try { text = await invokeModel(MODEL_ID, systemPrompt, userPrompt, 512); }
    catch {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ valid: true, sourcetypeOk: true, destFormatOk: true, suggestion: '', clarification: '' }));
      return;
    }

    let validation;
    try {
      validation = JSON.parse(text);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        validation = JSON.parse(text.substring(start, end + 1));
      } else {
        validation = { valid: true, sourcetypeOk: true, destFormatOk: true, suggestion: '', clarification: '' };
      }
    }

    // Enforce grounding: every name the model returns in `suggestion` must be a
    // real supported name (normalized). Drop hallucinated names so the UI never
    // pre-fills a sourcetype the app can't build. If nothing survives, abstain.
    if (validation && typeof validation.suggestion === 'string' && validation.suggestion) {
      const norm = s => s.trim().toLowerCase().replace(/[\s:/-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const supSet = new Set(supported.map(norm));
      const kept = validation.suggestion.split(',').map(s => s.trim()).filter(Boolean)
        .filter(s => supSet.has(norm(s)));
      validation.suggestion = kept.join(', ');
      if (!validation.suggestion) {
        validation.sourcetypeOk = false;
        if (!validation.clarification) validation.clarification = 'No supported sourcetype matches this label.';
      }
    }

    // Normalize the enrichment bundle: only trust it for a real source.
    if (validation && !validation.isRealSource) { validation.description = ''; validation.logFormat = ''; validation.typicalFields = []; }
    if (validation && !Array.isArray(validation.typicalFields)) validation.typicalFields = validation.typicalFields ? [String(validation.typicalFields)] : [];

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(validation));
  } catch {
    // Fail open — don't block user
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ valid: true, sourcetypeOk: true, destFormatOk: true, suggestion: '', clarification: '' }));
  }
}

export async function handleDetectSourcetype(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { sampleEvents } = JSON.parse(body);

    if (!sampleEvents || sampleEvents.trim().length === 0) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sourcetype: '', confidence: 'none', reason: 'No sample events provided' }));
      return;
    }

    // Take the first 10 lines for detection (enough to identify format)
    const lines = sampleEvents.trim().split('\n').filter(Boolean).slice(0, 10);
    const preview = lines.join('\n');
    // Format first: a CEF sample (bare or syslog-framed) names its source in the
    // header, so it is answered locally — the same rule as the wizard's Tier 0
    // and the client detector (src/ai-client.ts aiDetectSourcetype).
    const cefSource = recognizeCefSource(sampleEvents);
    if (cefSource) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sourcetype: cefSource.sourcetype, confidence: 'high', reason: cefSource.reason }));
      return;
    }
    // The model is told the wire format rather than left to infer it.
    const wire = describeSampleFormat(lines);

    const systemPrompt = `You are a log format classifier. Given sample log events, identify the sourcetype (data source).
Return ONLY valid JSON with these fields:
{"sourcetype":"<value>","confidence":"high|medium|low","reason":"one sentence explaining why"}

Known sourcetypes (use these exact values when matched):
cef, cisco_asa, cisco_firepower, palo_alto_traffic, palo_alto_threat, fortinet_fortigate, checkpoint_firewall,
windows_powershell, windows_security, windows_sysmon, linux_syslog, linux_audit, crowdstrike_falcon,
aws_cloudtrail, aws_vpc_flow, azure_signin, gcp_audit, okta_system, zscaler_web, apache_access, nginx_access

Extended catalog (Cribl Search stock datatypes — prefer these exact IDs when the data matches a specific vendor/variant, e.g. distinct PAN log types):
${datatypeTaxonomy().join(', ')}

If the events don't match any known type, return a descriptive kebab-case sourcetype (e.g. "juniper_srx", "f5_bigip_ltm", "custom_json_app").

Identification hints:
- Decide the wire format FIRST (it is given below), then the source from the fields it carries.
- A CEF:<n>| header (at line start or after a syslog frame) → sourcetype "cef", unless its Device Vendor|Product is Fortinet|FortiGate → fortinet_fortigate, or Check Point → checkpoint_firewall. Never name any other vendor (Zscaler / Infoblox / Imperva / Palo Alto…) from a CEF header.
- %ASA- in syslog → cisco_asa
- Comma-separated with 40+ fields, starts with 1,date → palo_alto_traffic or palo_alto_threat (threat has threat_id field)
- key=value with devname="FGT → fortinet_fortigate
- product="VPN-1 & FireWall-1" → checkpoint_firewall
- SFIMS: Protocol: → cisco_firepower
- XML with <Event><System><EventID> → windows_security or windows_sysmon or windows_powershell (check Provider Name)
- RFC3164 syslog (month day time host process[pid]) → linux_syslog
- type=SYSCALL msg=audit → linux_audit
- JSON with eventName + userIdentity + awsRegion → aws_cloudtrail
- Space-separated: version account-id interface-id srcaddr dstaddr → aws_vpc_flow
- JSON with properties.userDisplayName + status.errorCode → azure_signin
- JSON with protoPayload + resource.type → gcp_audit
- JSON with eventType + actor + outcome → okta_system
- Combined log format (IP - user [date] "METHOD path" status bytes) → apache_access or nginx_access
- JSON with DetectionSummaryEvent or detect → crowdstrike_falcon`;

    let text;
    try { text = await invokeModel(MODEL_ID, systemPrompt, `Wire format (detected locally): ${wire.label}${wire.mixed ? ' — mixed sample' : ''}\n\nIdentify the sourcetype of these events:\n\n${preview}`, 256); }
    catch {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sourcetype: '', confidence: 'none', reason: 'Detection unavailable' }));
      return;
    }

    let detection;
    try {
      detection = JSON.parse(text);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        detection = JSON.parse(text.substring(start, end + 1));
      } else {
        detection = { sourcetype: '', confidence: 'none', reason: 'Could not parse response' };
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(detection));
  } catch {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sourcetype: '', confidence: 'none', reason: 'Detection failed' }));
  }
}
