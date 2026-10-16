// Optimization knowledge: what each destination will accept and what each
// source's wire format allows, so an AI suggestion about reduction/reformatting
// is grounded in the destination's real constraints instead of generic advice.
//
// The long-form, human-readable versions are
//   docs/destination-specs/destination-constraints.md   (per destination)
//   docs/source-formats.md                               (per source)
//   docs/optimization-catalog.md                         (the rules we ship)
// This file is the machine copy the prompts read. Keep the three in step.
//
// A LEAF module on purpose: no imports. It is read by the browser AI client,
// the standalone Vite handlers (scripts/ai-advisor.mjs) and the Backend
// Function bundle alike, and must not drag the pack builder or bundled data in.

/** How the destination finds fields in what we send. */
export type DestinationParsing =
  /** The destination runs its own vendor parser over the ORIGINAL line: the wire shape is the contract. */
  | 'parses-raw'
  /** The destination reads the fields we send by name (and type): the field contract is the contract. */
  | 'mapped-fields'
  /** Either, depending on the sub-mode chosen (raw vs mapped card). */
  | 'either';

export interface DestinationProfile {
  key: string;
  label: string;
  parsing: DestinationParsing;
  /** What may change about the event, one sentence. */
  reshape: string;
  /** What is metered — decides which reduction actually saves money. */
  billing: string;
  /** Reductions that are safe for this destination. */
  levers: string[];
  /** Things that break ingestion, parsing or detections here. */
  never: string[];
  /** Hard size/rate limits worth knowing when batching or compacting. */
  limits?: string[];
  /** Sub-mode notes keyed by the app's destination format key. */
  modes?: Record<string, string>;
}

const DESTINATIONS: Record<string, DestinationProfile> = {
  xsiam: {
    key: 'xsiam', label: 'Palo Alto Cortex XSIAM', parsing: 'parses-raw',
    reshape: 'None. XSIAM parses the vendor line itself (dataset <vendor>_<product>_raw); _raw must stay byte-for-byte the vendor format.',
    billing: 'Ingest volume (GB/day of the event as received).',
    levers: [
      'Whole-event drop, sample or suppress only (the same rules the event-scope optimization applies).',
      'Drop envelope fields Cribl added (they are not part of the parsed line).',
      'Send each vendor in the format its XSIAM parsing rule expects (FortiGate must be CEF; PAN-OS its native CSV).',
    ],
    never: [
      'Reformat, reorder, trim or rename anything inside _raw (the parsing-rule regex then rejects the line).',
      'Map fields: XSIAM ignores them and the dataset shows unparsed events.',
      'Omit the Source-Identifier / Integration-Identifier / Format headers, or Vendor/Product for the generic ("Other") integration.',
    ],
    limits: ['5 MB per event', '9.5 MB per batch', '~400 requests/s per tenant'],
  },
  crowdstrike_ngsiem: {
    key: 'crowdstrike_ngsiem', label: 'CrowdStrike Falcon NG-SIEM', parsing: 'either',
    reshape: 'With a vendor parser: none, only the HEC `event` (_raw) is parsed and it must be in the vendor\'s exact native shape. With a JSON parser: the JSON keys are the contract.',
    billing: 'The whole ingested payload, so every extra field in the HEC envelope costs money.',
    levers: [
      'Send _raw only (Syslog/HEC source "Fields to keep" = _raw); drop Cribl envelope fields.',
      'Add connectors (each with its own destination) for peak load; about 10K EPS per connector is an old benchmark, so load-test. Check a parser by pasting one _raw into its test pane in NG SIEM.',
      'Whole-event drop/sample/suppress for vendor-parser connectors.',
      'For a JSON parser, drop null/empty keys and unmapped vendor keys.',
    ],
    never: [
      'Change column order of a CSV source (PAN-OS, VPC) or key names of a JSON source a vendor parser reads.',
      'Mix parsers on one connector: one connector (and ingest token) per parser.',
      'Send a JSON array as one event: break it into one event per record before the destination.',
    ],
    limits: ['Cribl destination body size 4096 KB by default (docs.cribl.io)', '16 MB per request on the HEC /raw endpoint (unverified)'],
    modes: {
      nextgen: 'The app\'s NG-SIEM card is raw fidelity: the original _raw is restored byte-for-byte for the connector\'s vendor parser and every other field is removed, so only _raw and _time are sent. Parsing happens only inside the pipeline (for drops and flags), not for the output. Map nothing.',
      crowdstrike_ngsiem: 'Raw-fidelity post-processing: vendor parser, event-scope optimization only, only _raw and _time sent.',
    },
  },
  secops: {
    key: 'secops', label: 'Google SecOps (Chronicle)', parsing: 'either',
    reshape: 'Unstructured mode: none, log_text = the original line and a valid log type, Google\'s parser does the rest. UDM mode: the UDM field contract (metadata/principal/target/network) is the contract.',
    billing: 'Ingest volume (GB). Unstructured and UDM cost the same per byte, so UDM compaction is where field reduction pays.',
    levers: [
      'Unstructured: whole-event drop/sample/suppress, never edit log_text.',
      'UDM: drop unmapped vendor keys and empty values, keep metadata.event_type and metadata.event_timestamp {seconds, nanos}.',
    ],
    never: [
      'Send an unknown or misspelled log type (400 INVALID_ARGUMENT fails the whole batch).',
      'Send _raw together with UDM fields in UDM mode (it is double-billed and ignored).',
      'Drop or rename metadata.event_type / metadata.event_timestamp: the destination silently DROPS an event without a valid EventType or a numeric {seconds, nanos} timestamp, and the Test tab still says success.',
      'Send a scalar for a repeated UDM field (principal.ip, security_result, security_result.action) or a value outside a UDM enum: 400 for the whole batch.',
    ],
    limits: ['4 MB per request; 1 MB per log (legacy API) or 4 MB (Chronicle API) — set the destination body size to 4096 KB or less (default 5120 KB)', 'The legacy ingestion API is retired on 2027-07-20'],
    modes: {
      chronicle: 'The app\'s Chronicle card is UDM mode.',
      chronicle_raw: 'Raw + log type card (unstructured mode): _raw stays byte-identical and __logType is stamped only from the committed Google default-parser table (config/secops-log-types.json); a source with no entry gets no label rather than a guess. Map nothing. Recommended only when Google\'s parser accepts the sample\'s wire format; otherwise use the UDM card.',
      'chronicle#raw': 'Raw + log type post-processing: a restored vendor line gets its committed __logType and is not reshaped; OCSF JSON is not a Google parser format and gets no label.',
    },
  },
  sentinel: {
    key: 'sentinel', label: 'Microsoft Sentinel', parsing: 'mapped-fields',
    reshape: 'The DCR stream is the contract: column names and types must match the table (native or _CL) exactly. An undeclared column is discarded and a mistyped value lands as an empty column, both with a 2xx and no error.',
    billing: 'GB ingested per table tier (Analytics, Basic, Auxiliary/data lake). Columns the DCR does not map are not billed; check _BilledSize.',
    levers: [
      'Drop columns the table does not have before sending (they cost bandwidth, not ingestion).',
      'Route high-volume, low-query tables to a Basic/Auxiliary tier.',
      'Whole-event drop/sample/suppress; field trimming within mapped columns.',
    ],
    never: [
      'Send a wrong type (a string into an int/datetime column, a number into a string column): the column is stored empty with no error. The pack casts written columns to the DCR type.',
      'Target a table the Logs Ingestion API cannot write (DeviceEvents, DeviceFileEvents, AzureActivity, AzureDiagnostics): nothing lands.',
      'Use a DCR stream name that does not match the Cribl destination.',
      'Rename DeviceVendor/DeviceProduct in CommonSecurityLog to a marketing name: the data lands but no solution rule or workbook matches it.',
      'Rely on a DCR transform or XPath filter for reduction: it is lossy and invisible to the pack.',
      'Column names over 45 characters, reserved names, or a custom column without the _CF suffix on a native table.',
    ],
    limits: ['1 MB per API call', '64 KB per column value', '500 columns per table', '2 GB/min per DCR'],
    modes: {
      asim: 'ASIM is a query-time normalization: the pack emits the ASIM column names into a table whose DCR accepts them.',
      commonsecuritylog: 'CommonSecurityLog is the CEF-derived table; send its columns (DeviceVendor, SourceIP, …), not CEF text. Solution content filters on the DeviceVendor/DeviceProduct the vendor\'s own CEF feed writes (Zscaler NSSWeblog, CrowdStrike FalconHost, Check Point VPN-1 & FireWall-1); the pack writes that identity.',
    },
  },
  splunk: {
    key: 'splunk', label: 'Splunk', parsing: 'either',
    reshape: 'Raw: the Splunk TA parses the original line, so the shape and the sourcetype must be the TA\'s. CIM/JSON: flexible, as long as the field names match what searches and data models expect.',
    billing: 'Ingest licence counts only the HEC `event` payload (the _raw), not index-time fields or metadata.',
    levers: [
      'Drop unused fields/key-value pairs inside _raw when the TA extracts at search time and the removed keys are not used by the TA\'s field aliases.',
      'Reformat a repeated-key KV source to CSV only when the pack also ships the matching props/transforms (e.g. the Fortinet pack\'s fortigate CSV sourcetype, ~55% smaller).',
      'Move stable values to index-time fields (host, source, sourcetype, index): they are not metered.',
    ],
    never: [
      'Rely on index-time TRANSFORMS or SEDCMD to trim: events from Cribl arrive cooked and those never run. Trim in Stream.',
      'Rename fields a TA or a correlation search reads (e.g. Cisco ISE Step fields).',
      'Change the sourcetype away from the TA\'s without re-pointing the TA.',
    ],
    modes: {
      cim: 'CIM card: the pack emits CIM field names into _raw JSON; the CIM data models find them by name.',
      splunk_raw: 'Raw card: nothing inside _raw changes; only whole-event reduction.',
      splunk_json: 'JSON card: every extracted field as JSON with canonical names; KV_MODE=json at search time.',
    },
  },
  elastic: {
    key: 'elastic', label: 'Elastic', parsing: 'either',
    reshape: 'With an Elastic integration: the integration\'s ingest pipeline does ECS and needs the original line in message plus the data stream (_dataId for the Elastic cribl integration\'s route_entries, or __index = logs-<pkg>.<dataset>-<namespace>), with the integration assets installed. With the ECS card: the ECS field contract is the contract, into a custom logs-* data stream.',
    billing: 'Storage / ingest volume (self-managed: disk; Cloud: GB ingested and retained).',
    levers: [
      'Whole-event drop/sample/suppress in front of an integration.',
      'ECS card: drop the duplicate original once fields are mapped (event.original is optional), drop empty fields.',
    ],
    never: [
      'Pre-populate event.original when the integration also sets it (the ingest pipeline errors).',
      'Pre-ECS the event AND route it to an integration pipeline (double mapping).',
      'Send to an integration without _dataId or __index: the document stays in logs-cribl-default (or the static index) and is never parsed.',
      'Send Windows raw XML to a Windows integration: it parses Winlogbeat-shaped winlog.* fields, so route Windows through Elastic Agent.',
    ],
    modes: {
      ecs: 'ECS card: nested ECS fields, the envelope (event/source/destination/network) must nest correctly. Target a custom logs-* data stream, never an integration data stream.',
      elastic_raw: 'Elastic integration card: for the Elastic cribl integration. It sets message = the original line (overriding a Syslog-source message that lost its header), _dataId = the source (the key in the integration route_entries), input.type = log for system.auth/system.syslog, and removes _raw. The original line is the whole contract: do not reshape it. Sources only Elastic Agent parses (Windows, CEF, Umbrella) get no _dataId and should use the ECS card.',
      elastic_json: 'JSON card: canonical field names as a JSON document.',
    },
  },
  cef_siem: {
    key: 'cef_siem', label: 'CEF SIEM (ArcSight and others)', parsing: 'mapped-fields',
    reshape: 'The CEF header (7 pipe fields) and extension keys are the contract; a SmartConnector/receiver parses CEF, not the vendor format.',
    billing: 'Usually EPS or GB per day, depending on the product.',
    levers: ['Map only fields with a CEF key or a labelled custom pair; drop the rest.', 'Whole-event drop/sample/suppress.'],
    never: ['Break header escaping (| and \\ in header, = and \\ in extensions).', 'Use a csN/cnN value without its csNLabel/cnNLabel.'],
  },
  qradar: {
    key: 'qradar', label: 'IBM QRadar', parsing: 'parses-raw',
    reshape: 'None for vendor DSMs: the DSM regex expects the native line (or LEEF). The syslog header hostname is the log source identity.',
    billing: 'Licensed by EPS, so only event COUNT matters; byte trimming saves nothing, coalescing happens after licensing.',
    levers: ['Whole-event drop/sample/suppress (the only lever that changes EPS).', 'Aggregate repeated events into one in Stream.'],
    never: ['Reformat the line a DSM parses.', 'Add a second syslog header (set __syslogout=_raw).', 'Spoof UDP source addresses.'],
  },
  ocsf: {
    key: 'ocsf', label: 'OCSF (Cribl Lake, Amazon Security Lake, OCSF consumers)', parsing: 'mapped-fields',
    reshape: 'The OCSF class is the contract: class_uid, category_uid, activity_id, type_uid, time (epoch ms) and metadata.version. Security Lake needs one class per source, OCSF 1.x as Parquet.',
    billing: 'Storage (S3/Lake) and query scan: compaction and Parquet matter more than event count.',
    levers: [
      'Full-fidelity OCSF in the main pack; optimize downstream in the OCSF post-processing pack (qualified drop/suppress rules, measured on real samples).',
      'Drop empty objects and unmapped.* keys that no consumer reads.',
    ],
    never: [
      'Put the wrong class on an event (a Network Activity event in Authentication fails downstream analytics silently).',
      'Emit seconds or ISO strings in time: it is epoch milliseconds.',
    ],
  },
  lake: {
    key: 'lake', label: 'Cribl Lake / object storage (raw)', parsing: 'parses-raw',
    reshape: 'None: the point of a raw copy is a byte-identical _raw for replay.',
    billing: 'Storage. JSON with only _raw is the cheapest shape; Parquet with extracted fields searches fastest.',
    levers: ['Keep only _raw plus a few routing fields; compress.', 'Raw + extracted fields: Parquet columns instead of a JSON blob.'],
    never: ['Alter _raw (replay to any other destination must reproduce the original).'],
  },
  json: {
    key: 'json', label: 'Generic JSON destination', parsing: 'mapped-fields',
    reshape: 'Free: canonical field names in a JSON document.',
    billing: 'Destination-specific (Sumo Logic bills decompressed bytes; Datadog bills per indexed event, 1 MB/log max).',
    levers: ['Drop null/empty and unmapped fields.', 'Whole-event drop/sample/suppress.'],
    never: ['Assume a flow-control 200 means stored (Sumo Ingest Budget answers 200 while dropping).'],
  },
  custom: {
    key: 'custom', label: 'Custom format', parsing: 'mapped-fields',
    reshape: 'Whatever the user\'s format definition says.',
    billing: 'Unknown.',
    levers: ['Follow the custom format definition; only generic null/empty removal is safe.'],
    never: ['Add fields the definition does not list.'],
  },
};

// The app's destination format keys → destination family.
const FAMILY_OF: Record<string, string> = {
  xsiam: 'xsiam',
  nextgen: 'crowdstrike_ngsiem', crowdstrike_ngsiem: 'crowdstrike_ngsiem', crowdstrike: 'crowdstrike_ngsiem',
  chronicle: 'secops', chronicle_raw: 'secops', secops: 'secops', udm: 'secops',
  sentinel: 'sentinel', asim: 'sentinel', commonsecuritylog: 'sentinel',
  cim: 'splunk', splunk: 'splunk', splunk_raw: 'splunk', splunk_json: 'splunk',
  ecs: 'elastic', elastic: 'elastic', elastic_raw: 'elastic', elastic_json: 'elastic', elasticsearch: 'elastic',
  cef: 'cef_siem', arcsight: 'cef_siem',
  leef: 'qradar', qradar: 'qradar',
  ocsf: 'ocsf', security_lake: 'ocsf',
  passthrough: 'lake', raw_fields: 'lake', lake: 'lake', raw: 'lake',
  json: 'json', anyjson: 'json',
  manual: 'custom', custom: 'custom',
};

/** The destination profile for an app destination format key (`cim#authentication` → Splunk). */
export function destinationProfile(destFormat: string): DestinationProfile | null {
  const base = String(destFormat || '').toLowerCase().split('#')[0];
  const fam = FAMILY_OF[base];
  return fam ? DESTINATIONS[fam] : null;
}

/** Whether the destination (for this exact card) parses the original line itself. */
export function destinationParsesRaw(destFormat: string): boolean {
  const full = String(destFormat || '').toLowerCase();
  const base = full.split('#')[0];
  if (/(^|_)raw$|^passthrough$|^xsiam$|^crowdstrike_ngsiem$|^nextgen$|^splunk$|^elasticsearch$/.test(base)) return true;
  if (full.endsWith('#raw')) return true; // a raw sub-schema of a mapped family (chronicle#raw)
  return destinationProfile(destFormat)?.parsing === 'parses-raw';
}

export function destinationProfiles(): readonly DestinationProfile[] {
  return Object.values(DESTINATIONS);
}

// ---- Sources --------------------------------------------------------------

/** The structure of the source's wire format — decides what reformatting can save. */
export type SourceStructure = 'kv' | 'csv' | 'json' | 'xml' | 'freetext' | 'multi-record' | 'cef' | 'mixed';

export interface SourceProfile {
  key: string;
  label: string;
  /** Matched against the canonical sourcetype. */
  match: RegExp;
  /** Formats the device itself can emit (what the customer can switch to at the source). */
  nativeFormats: string[];
  structure: SourceStructure;
  /**
   * Whether a condensed re-encoding (KV/JSON → CSV, dropping repeated keys)
   * pays: 'high' for repeated-key KV/JSON, 'low' for already-positional CSV.
   */
  condense: 'high' | 'medium' | 'low';
  /** High-volume, low-value events: what the noise rules target. */
  noise: string[];
  /** Never drop these: detections depend on them. */
  keep: string[];
  notes: string[];
}

const SOURCES: SourceProfile[] = [
  {
    key: 'fortinet_fortigate', label: 'Fortinet FortiGate', match: /^(fortinet|fortigate|ftnt)/,
    nativeFormats: ['syslog key=value (default)', 'CSV (format csv)', 'CEF (format cef)', 'RFC 5424', 'JSON (FortiOS 7.4+)', 'custom field list (FortiOS 8.0+)'],
    structure: 'kv', condense: 'high',
    noise: ['traffic/forward accept on internal zones', 'type=traffic action=start (logtraffic-start)', 'PING accept', 'utm/dns informational', 'event/system performance stats'],
    keep: ['action=deny/block/timeout', 'utm/ips, utm/virus, utm/webfilter blocks', 'event/user and vpn logins'],
    notes: [
      'Key=value repeats every key on every line: a CSV or custom-format re-encoding saves ~50% for a destination that parses mapped fields, or for Splunk only with the matching CSV props/transforms.',
      'XSIAM requires FortiGate as CEF; NG-SIEM\'s FortiGate parser expects the native key=value.',
      'The Cribl Fortinet pack ships ftnt_events_drop.csv (type/subtype drop list, all false by default).',
    ],
  },
  {
    key: 'palo_alto', label: 'Palo Alto Networks PAN-OS', match: /^(palo_alto|pan_)/,
    nativeFormats: ['syslog CSV (positional, per log type)', 'CEF', 'LEEF', 'custom format per log type', 'HTTP/JSON (log forwarding profile)'],
    structure: 'csv', condense: 'low',
    noise: ['TRAFFIC start records (threat_content_type=start)', '169.254/16 health checks', 'allowed DNS sessions', 'THREAT informational'],
    keep: ['THREAT medium+', 'TRAFFIC deny/drop', 'GLOBALPROTECT, USERID auth events'],
    notes: [
      'Already positional CSV: key repetition is zero, so reformatting saves little; blank future_use columns are the only structural waste.',
      'Column ORDER is the contract for XSIAM and NG-SIEM parsers; never reorder or drop columns there.',
    ],
  },
  {
    key: 'cisco_asa', label: 'Cisco ASA / FTD', match: /^cisco_(asa|ftd|firepower|fwsm)/,
    nativeFormats: ['syslog free text per message ID (%ASA-6-302013)', 'FTD also: EMBLEM, eStreamer (unified events)'],
    structure: 'freetext', condense: 'low',
    noise: ['302013-302016 build/teardown pairs', '106100/106023 repeated ACL hits', '110002/305011/305012 NAT and routing chatter'],
    keep: ['106001/106006/106015/106021 denies', '113004-113039 auth', '611101-611103, 605004/605005 admin logins', '733100 threat detection'],
    notes: [
      'Free text differs per message ID, so there is no reformatting lever; reduction is by message ID (the Cribl ASA pack\'s cisco_asa_drops.csv and cisco_asa_suppress.csv).',
      'FTD shares the ASA message IDs and can reuse the ASA drop list.',
    ],
  },
  {
    key: 'checkpoint', label: 'Check Point', match: /^(checkpoint|check_point|cp_)/,
    nativeFormats: ['Log Exporter: syslog, splunk (key=value), CEF, LEEF, generic, JSON, OCSF'],
    structure: 'kv', condense: 'high',
    noise: ['Accept logs on internal rules', 'repeated log updates sharing one loguid'],
    keep: ['Drop/Reject', 'Threat Prevention blades (IPS, AV, Anti-Bot)', 'SmartConsole audit'],
    notes: ['Aggregating updates by loguid plus a CSV re-encoding measured ~55% smaller; Log Exporter can emit a leaner format at the source.'],
  },
  {
    key: 'windows', label: 'Windows Event Log', match: /^(windows|wineventlog|xmlwineventlog|microsoft_windows)/,
    nativeFormats: ['XML (Rendered/XmlWinEventLog)', 'Classic (key: value text)', 'JSON (Cribl Edge / WEF / agents)'],
    structure: 'xml', condense: 'medium',
    noise: ['5156/5157 WFP connection allowed/blocked', '4658/4690 handle close', '4624 LogonType 3 from machine accounts', 'Sysmon 5 (terminate), 7 (image loaded) from Microsoft binaries', 'PowerShell 4105/4106 and 4104 console plumbing (prompt, TabExpansion2)'],
    keep: ['4625, 4648, 4672, 4688, 4697, 4720, 4728, 4732, 4740, 1102, 4768/4769/4771/4776, 5140/5145, 7045', 'Sysmon 1, 3, 8, 10, 11, 13, 22', 'PowerShell 4104 with real script content'],
    notes: [
      'XML is ~3x the size of Classic; the Classic long description ("This event is generated when…") is ~78% of a Classic event and is boilerplate.',
      'Splunk TA_windows parses both XML and Classic but by sourcetype: do not convert one into the other for a raw Splunk destination.',
      'Break XML on the <Event boundary, never on newlines.',
    ],
  },
  {
    key: 'linux', label: 'Linux syslog / auditd', match: /^(linux_|syslog_rfc|auditd|linux$)/,
    nativeFormats: ['RFC 3164 / RFC 5424 syslog', 'auditd key=value, multi-record per event (same msg=audit(ts:serial))', 'journald JSON'],
    structure: 'multi-record', condense: 'medium',
    noise: ['CRON pam_unix(cron:session) opened/closed', 'systemd slice/scope created/removed', 'auditd PROCTITLE/PATH context records for benign SYSCALLs'],
    keep: ['sshd auth failures and accepts', 'sudo', 'auditd EXECVE, USER_AUTH, USER_ACCT, CONFIG_CHANGE'],
    notes: ['auditd records sharing a serial belong to one event: aggregate by serial before mapping, never drop half a group.'],
  },
  {
    key: 'aws_cloudtrail', label: 'AWS CloudTrail', match: /^aws_cloudtrail/,
    nativeFormats: ['JSON (Records[] array from S3, or single events from EventBridge/CloudTrail Lake)'],
    structure: 'json', condense: 'high',
    noise: ['read-only Describe*/List*/Get*/Head* calls', 'service-principal AssumeRole', 'KMS Decrypt/GenerateDataKey by AWS services (>99% of KMS volume)'],
    keep: ['errorCode present (AccessDenied)', 'ConsoleLogin', 'IAM/STS writes', 'GetSecretValue, GetSessionToken, Decrypt by users'],
    notes: [
      'Deeply nested JSON: requestParameters/responseElements are the bulk; dropping responseElements on read-only calls is the biggest field lever for mapped destinations.',
      'Prefer a readOnly/management-event selector at the trail (free, before ingestion) over dropping in Stream.',
    ],
  },
  {
    key: 'aws_vpc', label: 'AWS VPC Flow Logs', match: /^aws_vpc/,
    nativeFormats: ['space-separated positional (default v2 format)', 'custom field list (v3-v5 fields)', 'Parquet to S3'],
    structure: 'csv', condense: 'low',
    noise: ['log-status NODATA', 'ACCEPT to 443 inside the VPC', 'east-west ACCEPT'],
    keep: ['REJECT', 'SKIPDATA (records were lost)', 'traffic to/from the internet gateway'],
    notes: ['Already positional: reduction is aggregation (5-tuple over a window, ~99% in the Cribl VPC pack) or event drops, not reformatting.'],
  },
  {
    key: 'dns', label: 'DNS (Infoblox, BIND, Windows DNS, Umbrella, Zeek)', match: /(dns|infoblox|umbrella|bind_query)/,
    nativeFormats: ['BIND query log syslog', 'Infoblox syslog; RPZ hits as CEF', 'Windows DNS Analytical ETW / debug log', 'Umbrella CSV to S3', 'Zeek/Corelight JSON or TSV'],
    structure: 'mixed', condense: 'medium',
    noise: ['repeated successful lookups of the same name by the same client', 'queries for top popular domains', 'PTR lookups of internal ranges'],
    keep: ['NXDOMAIN/SERVFAIL bursts (DGA, tunnelling)', 'TXT/NULL records', 'RPZ/blocked responses'],
    notes: ['Suppression by client + name + type over a short window measured 20% on OCSF DNS samples; the Cribl CrowdStrike pack drops the top 5000 domains by lookup.'],
  },
  {
    key: 'zscaler', label: 'Zscaler (ZIA/NSS)', match: /^(zscaler|zia_|zpa_)/,
    nativeFormats: ['NSS feed: configurable CSV, TSV, key=value, JSON, CEF, LEEF'],
    structure: 'mixed', condense: 'high',
    noise: ['allowed requests for static assets', 'allowed requests to well-known SaaS CDNs'],
    keep: ['blocked/cautioned requests', 'threat/sandbox verdicts', 'DLP events'],
    notes: [
      'The feed format is whatever the NSS feed template says: the customer can pick a leaner one at the source.',
      'Disable array notation in JSON feeds, or every multi-value field becomes an object per value.',
    ],
  },
  {
    key: 'web_access', label: 'Web server / load balancer access logs', match: /^(apache|nginx|microsoft_iis|iis|aws_(alb|elb|cloudfront)|haproxy)/,
    nativeFormats: ['Common/Combined Log Format', 'custom log_format / W3C extended', 'JSON (nginx escape=json, ALB is space-separated)'],
    structure: 'csv', condense: 'low',
    noise: ['/health, /healthz, /readyz, /livez probes', '/favicon.ico', 'successful static assets (.js, .css, images, fonts)'],
    keep: ['4xx/5xx', 'POST/PUT/DELETE', 'auth endpoints'],
    notes: ['Already a positional line; reduction is event drops, not reformatting.'],
  },
  {
    key: 'identity_saas', label: 'Identity and SaaS audit (Okta, Entra ID, O365, Google Workspace)', match: /^(okta|azure_|entra|o365|m365|office365|gws_|gsuite)/,
    nativeFormats: ['JSON via API polling or event hub'],
    structure: 'json', condense: 'high',
    noise: ['token refresh and session keep-alive events', 'O365 FileAccessed by service accounts'],
    keep: ['sign-in failures and MFA events', 'admin and role changes', 'mailbox rule creation'],
    notes: ['Nested JSON with repeated envelope fields; correlationId/transaction ids tie multi-event flows together, keep them when dropping fields.'],
  },
  {
    key: 'crowdstrike_fdr', label: 'CrowdStrike Falcon Data Replicator', match: /^(crowdstrike|falcon)/,
    nativeFormats: ['JSON lines in S3 (one event_simpleName per line)'],
    structure: 'json', condense: 'high',
    noise: ['high-volume event_simpleName types with no detection use (lookup-driven drop in the Cribl CrowdStrike pack)', 'DnsRequest for top-5000 domains'],
    keep: ['ProcessRollup2', 'DetectionSummaryEvent', 'NetworkConnectIP4 to external'],
    notes: ['Reduction is an event_simpleName allow/drop lookup (~51% field reduction measured by the Cribl pack).'],
  },
  {
    key: 'cef_generic', label: 'Generic CEF / LEEF', match: /^(cef|leef)/,
    nativeFormats: ['CEF:0 or LEEF:1/2, bare or syslog-framed'],
    structure: 'cef', condense: 'medium',
    noise: [],
    keep: ['everything until the vendor behind the header is known'],
    notes: ['Read the vendor from the CEF header before choosing rules; a multi-vendor CEF feed gets no category rules.'],
  },
];

/** The source profile for a canonical sourcetype, or null. */
export function sourceProfile(sourcetype: string): SourceProfile | null {
  const st = String(sourcetype || '').toLowerCase();
  if (!st) return null;
  return SOURCES.find(s => s.match.test(st)) || null;
}

export function sourceProfiles(): readonly SourceProfile[] {
  return SOURCES;
}

// ---- Prompt guidance ------------------------------------------------------

/** The one-line combined verdict for a source → destination pair. */
export function pairVerdict(sourcetype: string, destFormat: string): string {
  const dest = destinationProfile(destFormat);
  const src = sourceProfile(sourcetype);
  if (!dest) return '';
  if (destinationParsesRaw(destFormat)) {
    return `${dest.label} parses the original line: keep _raw exactly as received${src ? ` (${src.nativeFormats[0]})` : ''}; only whole-event drop/sample/suppress and removal of Cribl-added envelope fields are safe.`;
  }
  if (!src) return `${dest.label} reads mapped fields by name: map to its exact field names and types, drop unmapped and empty fields.`;
  if (src.condense === 'high') {
    return `${src.label} is ${src.structure === 'json' ? 'nested JSON' : 'repeated-key key=value'}; ${dest.label} reads mapped fields, so the mapped output already removes the key repetition: dropping unmapped vendor fields is the main lever (typically 40-70%).`;
  }
  if (src.condense === 'low') {
    return `${src.label} is already a compact positional line; for ${dest.label} the savings come from event-level drops/suppression, not from reformatting.`;
  }
  return `${dest.label} reads mapped fields: map to its exact names and types; ${src.label} savings come from both event drops and dropping unmapped fields.`;
}

/**
 * A compact prompt block: destination constraints, source format facts and
 * the pair verdict. `mode: 'mapping'` keeps only what constrains the SHAPE of
 * the output (a mapping prompt has no business proposing drops); 'advise'
 * adds the reduction levers, noise and must-keep lists.
 */
export function optimizationGuidance(sourcetype: string, destFormat: string, mode: 'advise' | 'mapping' = 'advise'): string {
  const dest = destinationProfile(destFormat);
  const src = sourceProfile(sourcetype);
  if (!dest && !src) return '';
  const lines: string[] = ['════ DESTINATION + SOURCE CONSTRAINTS (authoritative — do not contradict) ════'];
  if (dest) {
    const full = String(destFormat || '').toLowerCase();
    const base = full.split('#')[0];
    lines.push(`Destination: ${dest.label}. ${dest.reshape}`);
    const card = dest.modes?.[full] || dest.modes?.[base];
    if (card) lines.push(`This card: ${card}`);
    lines.push(`Never: ${dest.never.join(' | ')}`);
    if (mode === 'advise') {
      lines.push(`Billing: ${dest.billing}`);
      lines.push(`Safe levers: ${dest.levers.join(' | ')}`);
      if (dest.limits?.length) lines.push(`Limits: ${dest.limits.join(', ')}`);
    }
  }
  if (src) {
    lines.push(`Source: ${src.label}, ${src.structure}. Native formats: ${src.nativeFormats.join('; ')}.`);
    if (mode === 'advise') {
      if (src.noise.length) lines.push(`Known noise: ${src.noise.join('; ')}.`);
      if (src.keep.length) lines.push(`Never drop: ${src.keep.join('; ')}.`);
      lines.push(...src.notes.map(n => `Note: ${n}`));
    }
  }
  const v = pairVerdict(sourcetype, destFormat);
  if (v) lines.push(`Verdict: ${v}`);
  return `\n\n${lines.join('\n')}\n`;
}
