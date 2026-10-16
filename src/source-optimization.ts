// Source optimization for "Build pack flow (including post-processing)" — the
// per-sourcetype noise reduction the pack builder shipped before commit 5566b39
// retired it from "Create new pack", plus the lookup-driven drops and
// suppression from the original Cribl packs (cribl-cisco-asa-cleanup,
// cribl-exabeam-fortigate-firewall). Flow-only and opt-in per destination card.
//
// Rules:
//   - Never for OCSF (full fidelity; optimize downstream in post-processing) and
//     never for passthrough/xsiam (a raw copy has nothing to reduce).
//   - Only for "mapped" destinations (extractionClassOf): the filters read the
//     canonical parse-stage names. JSON/custom use Search-native names, which
//     these filters would silently miss.
//   - Runs at the head of the optimization slot: after mapping (which keeps the
//     parser's fields) and before compaction strips them, so the filters see
//     the parser's own names (verified in tests against getParserFieldNames).
//   - A rule the user leaves off still ships, disabled, so it's one click in the
//     Cribl UI. A lookup rule ships only when its CSV ships in the pack.
//
// Category rules (build 833): a vendor rule that is really about the CATEGORY
// (a PAN link-local drop, a FortiGate PING drop, an apache health check) is
// restated once over canonical parse names and offered to every source of that
// data class whose parser produces the fields — juniper_srx, sophos_xg,
// pfsense, sonicwall… get the firewall rules, squid/zscaler the web rules. They
// ship OFF (a vendor rule was measured on its vendor; a generalization was
// not), never replace a vendor's own rule (`from`), and never touch IDS/threat
// feeds, where every event is a detection. docs/optimization-catalog.md is the
// human-readable list; keep the two in step.

import { canonicalizeSourcetype, getParserFieldNames, type DataClass } from './source-recognition';
import { staticDataClassFor } from './pack-builder';

export interface SourceOptRule {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  /** Plain drop: events matching this filter are dropped. */
  filter?: string;
  /** Lookup drop: the event's key is looked up; a hit (or a truthy `dropColumn`) drops it. */
  lookup?: { file: string; keys: { eventExpr: string; lookupField: string }[]; hitField: string; dropColumn?: string };
  /** Suppress: allow 1 event per key per window, drop the rest. */
  suppress?: { filter: string; keyExpr: string; periodSec: number };
  /** Parse-stage fields the rule reads (tests check these exist in the parser output). */
  reads: string[];
  /** Where the knowledge came from, shown in the function description. */
  origin: 'cribl-pack' | 'legacy' | 'generalized';
  /** For a generalized rule: what it was generalized from ("Palo Alto pan_drop_health"). */
  generalizedFrom?: string;
}

const ASA_CODE = "String(asa_code || event_code || '')";
// The OCSF-qualified security-relevant Windows Security IDs (config/ocsf-optimization-qualified.json).
const WIN_SECURITY_IDS = '/^(4624|4625|4648|4672|4688|4697|4720|4728|4732|4740|1102|4768|4769|4771|4776|5140|5145|7045)$/';
// Read-only API calls that still matter: secret/credential/key material.
const CREDENTIAL_READ = '/(Secret|Token|Password|Credential|Decrypt|Key)/i';

const RULES: Record<string, SourceOptRule[]> = {
  cisco_asa: [
    {
      id: 'asa_drop_codes', label: 'Drop no-value ASA codes', origin: 'cribl-pack', defaultEnabled: true,
      description: 'Drop the 35 ASA message codes listed in cisco_asa_drops.csv (connection build/teardown, ICMP echo discards…)',
      lookup: { file: 'cisco_asa_drops.csv', keys: [{ eventExpr: ASA_CODE, lookupField: 'asa_code' }], hitField: 'asa_code' },
      reads: ['asa_code', 'event_code'],
    },
    {
      id: 'asa_suppress_codes', label: 'Rate-limit verbose ACL codes', origin: 'cribl-pack', defaultEnabled: true,
      description: 'Suppress 106100/106023 (cisco_asa_suppress.csv): keep 1 per code + source + destination every 30s',
      lookup: { file: 'cisco_asa_suppress.csv', keys: [{ eventExpr: ASA_CODE, lookupField: 'asa_code' }], hitField: 'asa_code' },
      suppress: { filter: '', keyExpr: "`${asa_code || event_code}:${src_ip}:${dest_ip}`", periodSec: 30 },
      reads: ['asa_code', 'event_code', 'src_ip', 'dest_ip'],
    },
    {
      id: 'asa_drop_acl_permit', label: 'Drop ACL permit logs', origin: 'legacy', defaultEnabled: false,
      description: 'Drop routine ACL permit events (106100 with a permit action)',
      filter: "(asa_code == '106100' || event_code == '106100') && action && String(action).toLowerCase().indexOf('permit') >= 0",
      reads: ['asa_code', 'event_code', 'action'],
    },
  ],
  palo_alto_traffic: [
    {
      id: 'pan_drop_start', label: 'Drop session-start logs', origin: 'cribl-pack', defaultEnabled: true,
      description: 'Drop TRAFFIC "start" logs: the "end" log of the same session carries the same fields plus bytes and duration',
      filter: "threat_content_type == 'start'",
      reads: ['threat_content_type'],
    },
    {
      id: 'pan_drop_health', label: 'Drop link-local health checks', origin: 'legacy', defaultEnabled: true,
      description: 'Drop management/health-probe traffic from 169.254.0.0/16',
      filter: "src_ip && String(src_ip).startsWith('169.254.')",
      reads: ['src_ip'],
    },
    {
      id: 'pan_drop_allowed_dns', label: 'Drop allowed DNS', origin: 'legacy', defaultEnabled: false,
      description: 'Drop routine allowed DNS sessions (keep denied)',
      filter: "action == 'allow' && dest_port == '53'",
      reads: ['action', 'dest_port'],
    },
  ],
  palo_alto_threat: [
    {
      id: 'pan_drop_informational', label: 'Drop informational severity', origin: 'legacy', defaultEnabled: false,
      description: 'Drop threat logs with severity "informational"',
      filter: "String(severity || '').toLowerCase() == 'informational'",
      reads: ['severity'],
    },
  ],
  fortinet_fortigate: [
    {
      id: 'ftnt_drop_events', label: 'Drop event types marked in the lookup', origin: 'cribl-pack', defaultEnabled: true,
      description: 'Drop type/subtype/eventtype rows set to drop=true in ftnt_events_drop.csv (ships all false: edit the lookup to choose)',
      lookup: {
        file: 'ftnt_events_drop.csv',
        keys: [
          { eventExpr: "String(type || '')", lookupField: 'type' },
          { eventExpr: "String(subtype || '')", lookupField: 'subtype' },
          // \x22 = a double quote: a literal one inside the regex reads as a string to
          // the Cribl-safety scanner.
          { eventExpr: "(String(_raw || '').match(/\\beventtype=\\x22?([^\\s\\x22]+)/) || [])[1] || ''", lookupField: 'eventtype' },
        ],
        hitField: 'drop', dropColumn: 'drop',
      },
      reads: ['type', 'subtype'],
    },
    {
      id: 'ftnt_drop_loopback', label: 'Drop local loopback traffic', origin: 'legacy', defaultEnabled: true,
      description: 'Drop events where source and destination IP are the same',
      filter: 'src_ip && dest_ip && src_ip === dest_ip',
      reads: ['src_ip', 'dest_ip'],
    },
    {
      id: 'ftnt_drop_ping', label: 'Drop accepted PING keepalives', origin: 'legacy', defaultEnabled: false,
      description: 'Drop accepted PING health-check sessions',
      filter: "action === 'accept' && app === 'PING'",
      reads: ['action', 'app'],
    },
  ],
  checkpoint_firewall: [
    {
      id: 'chkp_drop_log_only', label: 'Drop Log-only actions', origin: 'legacy', defaultEnabled: false,
      description: 'Drop events with action=Log (monitoring only, no security action)',
      filter: "action === 'Log'",
      reads: ['action'],
    },
  ],
  windows_security: [
    {
      id: 'win_drop_wfp', label: 'Drop Filtering Platform events', origin: 'legacy', defaultEnabled: true,
      description: 'Drop 5156/5157 (Windows Filtering Platform connections): high volume, low value',
      filter: "['5156','5157'].includes(String(EventID || event_code))",
      reads: ['EventID', 'event_code'],
    },
    {
      id: 'win_drop_logon_type3', label: 'Drop network logon success', origin: 'legacy', defaultEnabled: false,
      description: 'Drop 4624 with LogonType 3 (routine network logons)',
      filter: "String(EventID || event_code) === '4624' && String(LogonType) === '3'",
      reads: ['EventID', 'event_code', 'LogonType'],
    },
    {
      id: 'win_keep_security_ids', label: 'Keep only security-relevant Event IDs', origin: 'generalized', defaultEnabled: false,
      generalizedFrom: 'OCSF post-processing authentication::microsoft keep_only_security_relevant_event_ids (17% measured)',
      description: 'Drop Security events outside a curated 17-ID set (logons, privilege use, process/service creation, account and group changes, log clearing, Kerberos, share access) (generalized from the OCSF authentication::microsoft keep-list)',
      filter: "(EventID || event_code) && !" + WIN_SECURITY_IDS + ".test(String(EventID || event_code))",
      reads: ['EventID', 'event_code'],
    },
  ],
  windows_system: [
    {
      id: 'win_drop_7036', label: 'Drop service state chatter', origin: 'legacy', defaultEnabled: true,
      description: 'Drop 7036 (service entered running/stopped state)',
      filter: "String(EventID || event_code) === '7036'",
      reads: ['EventID', 'event_code'],
    },
  ],
  windows_sysmon: [
    {
      id: 'sysmon_drop_terminate', label: 'Drop process termination', origin: 'legacy', defaultEnabled: false,
      description: 'Drop Sysmon EventID 5 (process terminated)',
      filter: "String(EventID) === '5'",
      reads: ['EventID'],
    },
    {
      id: 'sysmon_drop_ms_image_loads', label: 'Drop Microsoft image loads', origin: 'legacy', defaultEnabled: false,
      description: 'Drop Sysmon EventID 7 for images under \\Windows\\ or \\Microsoft\\',
      filter: "String(EventID) === '7' && Image && /\\\\(Windows|Microsoft)\\\\/i.test(String(Image))",
      reads: ['EventID', 'Image'],
    },
  ],
  windows_powershell: [
    {
      id: 'ps_drop_lifecycle', label: 'Drop provider lifecycle events', origin: 'legacy', defaultEnabled: true,
      description: 'Drop 600/800 (provider start/stop): low security value',
      filter: "['600','800'].includes(String(event_code || EventCode))",
      reads: ['event_code', 'EventCode'],
    },
    {
      id: 'ps_drop_script_start_stop', label: 'Drop script start/stop', origin: 'legacy', defaultEnabled: false,
      description: 'Drop 4105/4106 (script run start/stop markers)',
      filter: "['4105','4106'].includes(String(event_code || EventCode))",
      reads: ['event_code', 'EventCode'],
    },
    {
      id: 'ps_drop_benign_scriptblocks', label: 'Drop interactive-console script blocks', origin: 'legacy', defaultEnabled: false,
      description: 'Drop 4104 script blocks that are only console plumbing (prompt, TabExpansion2, $global:, Set-StrictMode, …); every real script is kept',
      // The drop the windows_powershell goldens carry, exact-match on the whole
      // block so a script that merely starts with `prompt` is never touched.
      filter: "String(EventID || event_code || EventCode) === '4104' && ScriptBlockText && /^(prompt|\\$global:?|TabExpansion2|\\$ErrorActionPreference\\s*=|Set-StrictMode|Import-Module\\s+Microsoft\\.PowerShell)$/i.test(String(ScriptBlockText).trim())",
      reads: ['EventID', 'event_code', 'EventCode', 'ScriptBlockText'],
    },
  ],
  windows_defender: [
    {
      id: 'defender_drop_lifecycle', label: 'Drop scan and update events', origin: 'legacy', defaultEnabled: true,
      description: 'Drop 1000/1001 (scan start/finish) and 2000/2001 (definition updates); keep detections',
      filter: "['1000','1001','2000','2001'].includes(String(EventID || event_code))",
      reads: ['EventID', 'event_code'],
    },
  ],
  windows_dns_client: [
    {
      id: 'dns_client_drop_3006', label: 'Drop query-sent half', origin: 'legacy', defaultEnabled: true,
      description: 'Drop 3006 (query sent): 3008 already carries the query and its result',
      filter: "String(EventID || event_code) === '3006'",
      reads: ['EventID', 'event_code'],
    },
  ],
  windows_application: [
    {
      id: 'winapp_drop_info', label: 'Drop informational chatter', origin: 'legacy', defaultEnabled: false,
      description: 'Drop Level 0/4 (informational) events; keep warnings and errors',
      filter: "['0','4'].includes(String(Level))",
      reads: ['Level'],
    },
  ],
  linux_syslog: [
    {
      id: 'syslog_drop_cron', label: 'Drop CRON session noise', origin: 'legacy', defaultEnabled: true,
      description: 'Drop CRON runs and PAM "session opened/closed for user" messages',
      // Strings, not /…for user/: the safety scanner reads a bare `for` as a statement.
      filter: "process === 'CRON' || (message && (String(message).indexOf('session opened for user') >= 0 || String(message).indexOf('session closed for user') >= 0))",
      reads: ['process', 'message'],
    },
    {
      id: 'syslog_drop_slice', label: 'Drop systemd slice events', origin: 'legacy', defaultEnabled: false,
      description: 'Drop "Created slice" / "Removed slice" messages',
      filter: 'message && /Created slice|Removed slice/.test(String(message))',
      reads: ['message'],
    },
  ],
  linux_audit: [
    {
      id: 'audit_drop_context', label: 'Drop CWD/PATH records', origin: 'legacy', defaultEnabled: true,
      description: 'Drop audit CWD and PATH records (context for a SYSCALL, not standalone events)',
      filter: "audit_type === 'CWD' || audit_type === 'PATH'",
      reads: ['audit_type'],
    },
  ],
  aws_cloudtrail: [
    {
      id: 'ct_drop_readonly', label: 'Drop read-only API calls', origin: 'legacy', defaultEnabled: false,
      description: 'Drop Describe*, List*, Get* and Head* calls (read-only, high volume); keeps secret, key and token reads',
      // GetSecretValue / GetSessionToken / Decrypt are read-only too, and exactly
      // what an investigation looks for: never part of the noise.
      filter: 'api_operation && /^(Describe|List|Get|Head)/.test(String(api_operation)) && !' + CREDENTIAL_READ + '.test(String(api_operation))',
      reads: ['api_operation'],
    },
    {
      id: 'ct_drop_service_assumerole', label: 'Drop AWS-service AssumeRole', origin: 'legacy', defaultEnabled: true,
      description: 'Drop AssumeRole calls made by AWS services themselves',
      filter: "api_operation === 'AssumeRole' && user_type === 'AWSService'",
      reads: ['api_operation', 'user_type'],
    },
  ],
  aws_vpc_v5: [
    {
      id: 'vpc_drop_https_accept', label: 'Drop accepted HTTPS flows', origin: 'legacy', defaultEnabled: false,
      description: 'Drop routine accepted flows to port 443 (keep rejects and unusual ports)',
      filter: "(action === 'allowed' || action === 'ACCEPT') && String(dest_port) === '443'",
      reads: ['action', 'dest_port'],
    },
    {
      id: 'vpc_drop_nodata', label: 'Drop NODATA records', origin: 'cribl-pack', defaultEnabled: true,
      description: 'Drop log-status NODATA records (no traffic in the window, every field "-"); SKIPDATA is kept, it reports lost records',
      filter: "String(log_status || '').toUpperCase() === 'NODATA'",
      reads: ['log_status'],
    },
  ],
  apache_access: [
    {
      id: 'web_drop_health', label: 'Drop health checks', origin: 'legacy', defaultEnabled: true,
      description: 'Drop /health and /favicon.ico requests',
      filter: "uri === '/health' || uri === '/favicon.ico'",
      reads: ['uri'],
    },
    {
      id: 'web_drop_static', label: 'Drop static assets', origin: 'legacy', defaultEnabled: false,
      description: 'Drop requests for .js, .css, images and fonts',
      filter: 'uri && /\\.(js|css|png|jpe?g|gif|svg|ico|woff2?|map)(\\?|$)/i.test(String(uri))',
      reads: ['uri'],
    },
  ],
};
RULES.nginx_access = RULES.apache_access;
// Same vendor, same canonical fields, different framing: the PAN-OS syslog
// sourcetypes and VPC v2 are not aliases of the vendor entry, so they had no rules.
RULES.pan_traffic_syslog = RULES.pan_traffic_syslog_nopri = RULES.palo_alto_traffic;
RULES.pan_threat_syslog = RULES.pan_threat_syslog_nopri = RULES.palo_alto_threat;
RULES.aws_vpc_v2 = RULES.aws_vpc_v5;

// ---- Category rules -------------------------------------------------------

/** A rule stated over canonical fields and offered to a whole data class. */
export interface CategoryOptRule {
  id: string;
  label: string;
  description: string;
  filter?: string;
  suppress?: { filter: string; keyExpr: string; periodSec: number };
  classes: DataClass[];
  /** Only sourcetypes whose canonical name matches (a class is sometimes too broad). */
  family?: RegExp;
  /** Every group needs one field the parser produces; a group lists alternatives. */
  requires: string[][];
  /** Read behind a guard or a `||` fallback; never required. */
  optional?: string[];
  /** Vendor rule ids this generalizes: a source that has one keeps its own. */
  from: string[];
  generalizedFrom: string;
}

// Allow/deny vocabularies across vendors (PAN allow, FortiGate accept, ASA
// permitted, VPC ACCEPT, pfSense pass, CIM allowed/blocked).
const ALLOWED = "/^(allow|allowed|accept|accepted|permit|permitted|pass|passed)$/i.test(String(action || ''))";
const DENIED = "/^(deny|denied|drop|dropped|block|blocked|reject|rejected|reset-both|reset-client|reset-server)$/i.test(String(action || ''))";
const PRIVATE_IP = '/^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)/';
// IDS/IPS and threat feeds: every event is a detection, never category noise.
const DETECTION_FEEDS = /(threat|ids|ips|snort|suricata|alert|estreamer|correlation)/;
// Network-class sourcetypes that are not flow logs (PAN User-ID/IP-tag/HIP,
// config and system logs) or carry any vendor (bare CEF/LEEF).
const NOT_FLOW_LOGS = /(^(cef|leef)$|iptag|userid|hipmatch|globalprotect|_config|_system|decryption)/;
const WEB_SERVERS = /^(apache|nginx|microsoft_iis|aws_(alb|elb)|aws_cloudfront|corelight_http|(bro|zeek)_http|imperva|cloudflare_http|stream_http)/;

const CATEGORY_RULES: CategoryOptRule[] = [
  {
    id: 'net_drop_session_start', label: 'Drop session-start logs',
    description: 'Drop session-start records (PAN start, FortiGate action=start): the end record of the same session carries the same fields plus bytes and duration',
    // PAN puts start/end in threat_content_type, FortiGate in action.
    filter: "(threat_content_type || action) === 'start'",
    // Only vendors that emit a separate start record (PAN-OS, FortiGate logtraffic-start).
    classes: ['network'], family: /^(pan_|palo_alto|fortinet|fortigate)/, requires: [['threat_content_type', 'action']],
    from: ['pan_drop_start'], generalizedFrom: 'Palo Alto pan_drop_start (Cribl PAN pack)',
  },
  {
    id: 'net_drop_link_local_src', label: 'Drop link-local sources',
    description: 'Drop traffic from 169.254.0.0/16 (APIPA / cloud metadata health probes)',
    filter: "src_ip && String(src_ip).startsWith('169.254.')",
    classes: ['network'], requires: [['src_ip']],
    from: ['pan_drop_health'], generalizedFrom: 'Palo Alto pan_drop_health',
  },
  {
    id: 'net_drop_broadcast_multicast', label: 'Drop broadcast and multicast',
    description: 'Drop traffic to 255.255.255.255, 224.0.0.0/4 and ff00::/8 (NetBIOS, mDNS, SSDP, routing chatter)',
    filter: "dest_ip && /^(255\\.255\\.255\\.255|2(2[4-9]|3[0-9])\\.|ff[0-9a-f]{2}:)/i.test(String(dest_ip))",
    classes: ['network'], requires: [['dest_ip']],
    from: [], generalizedFrom: 'firewall reduction guidance (non-routable destinations)',
  },
  {
    id: 'net_drop_allowed_dns', label: 'Drop allowed DNS sessions',
    description: 'Drop allowed sessions to port 53 (the resolver log has the query); denied DNS is kept',
    filter: `${ALLOWED} && String(dest_port) === '53'`,
    classes: ['network'], requires: [['action'], ['dest_port']],
    from: ['pan_drop_allowed_dns'], generalizedFrom: 'Palo Alto pan_drop_allowed_dns',
  },
  {
    id: 'net_drop_allowed_icmp', label: 'Drop allowed ICMP',
    description: 'Drop allowed ICMP/ICMPv6 sessions (ping keepalives, path MTU); denied ICMP is kept',
    filter: `${ALLOWED} && /^(icmp|icmp6|icmpv6|ipv6-icmp|1|58)$/i.test(String(transport || protocol || ''))`,
    classes: ['network'], requires: [['action'], ['transport', 'protocol']],
    from: ['ftnt_drop_ping'], generalizedFrom: 'FortiGate ftnt_drop_ping; OCSF network::generic drop_icmp_traffic',
  },
  {
    id: 'net_drop_east_west_allowed', label: 'Drop allowed east-west traffic',
    description: 'Drop allowed internal-to-internal (RFC1918) flows; denied internal traffic (lateral movement) is kept',
    filter: `${ALLOWED} && src_ip && dest_ip && ${PRIVATE_IP}.test(String(src_ip)) && ${PRIVATE_IP}.test(String(dest_ip))`,
    classes: ['network'], requires: [['action'], ['src_ip'], ['dest_ip']],
    from: [], generalizedFrom: 'OCSF network::generic drop_east_west_rfc1918_traffic (7% measured); Cribl VPC Flow pack',
  },
  {
    id: 'net_suppress_repeat_denies', label: 'Rate-limit repeated denies',
    description: 'Keep 1 denied connection per source + destination + port every 30s (scanner and retry floods)',
    suppress: { filter: DENIED, keyExpr: "`${src_ip}:${dest_ip}:${dest_port}`", periodSec: 30 },
    classes: ['network'], requires: [['action'], ['src_ip'], ['dest_ip'], ['dest_port']],
    from: ['asa_suppress_codes'], generalizedFrom: 'Cisco ASA asa_suppress_codes (106023/106100, Cribl ASA pack)',
  },
  {
    id: 'web_drop_health_checks', label: 'Drop health checks',
    description: 'Drop load-balancer and orchestrator probes (/health, /healthz, /healthcheck, /ready, /readyz, /livez) and /favicon.ico',
    filter: "/^([a-z]+:\\/\\/)?[^\\/?]*\\/(health|healthz|healthcheck|health-check|ready|readyz|livez|favicon\\.ico)\\/?(\\?|$)/i.test(String(uri || url || ''))",
    classes: ['web_proxy'], family: WEB_SERVERS, requires: [['uri', 'url']],
    from: ['web_drop_health'], generalizedFrom: 'apache/nginx web_drop_health',
  },
  {
    id: 'web_drop_static_assets', label: 'Drop static assets',
    description: 'Drop successful requests for .js, .css, images and fonts; errors (4xx/5xx) and blocked requests are kept',
    filter: "/\\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)(\\?|$)/i.test(String(uri || url || '')) && !/^[45]/.test(String(http_status || status || '')) && !/^(block|blocked|deny|denied)$/i.test(String(action || ''))",
    classes: ['web_proxy'], requires: [['uri', 'url']], optional: ['http_status', 'status', 'action'],
    from: ['web_drop_static'], generalizedFrom: 'apache/nginx web_drop_static; OCSF web_proxy::generic drop_static_asset_requests',
  },
  {
    id: 'cloud_drop_readonly', label: 'Drop read-only API calls',
    description: 'Drop read-only control-plane calls (Describe/List/Get/Head, GCP *.get/*.list); secret, key and token reads are kept',
    filter: "api_operation && /(^|\\.)(Describe|List|Get|Head|describe|list|get)([A-Z]|$)/.test(String(api_operation)) && !" + CREDENTIAL_READ + ".test(String(api_operation))",
    classes: ['cloud_audit'], requires: [['api_operation']],
    from: ['ct_drop_readonly'], generalizedFrom: 'AWS CloudTrail ct_drop_readonly; OCSF cloud_audit::generic drop_readonly_api_calls',
  },
  {
    id: 'dns_suppress_repeat_queries', label: 'Rate-limit repeated lookups',
    description: 'Keep 1 successful lookup per client + name + type every 60s; NXDOMAIN/SERVFAIL (DGA, tunnelling) is never suppressed',
    suppress: {
      filter: "!reply_code || /^(noerror|0)$/i.test(String(reply_code))",
      keyExpr: "`${src_ip}:${query || dns_query}:${query_type || ''}`", periodSec: 60,
    },
    classes: ['dns'], requires: [['query', 'dns_query'], ['src_ip']], optional: ['reply_code', 'query_type'],
    from: [], generalizedFrom: 'OCSF dns::generic suppress_repeated_popular_domain_queries (20% measured); Cribl CrowdStrike pack DNS reduction',
  },
  {
    id: 'syslog_drop_cron_session', label: 'Drop CRON PAM sessions',
    description: 'Drop pam_unix(cron:session) opened/closed pairs (every cron run logs two)',
    filter: "message && String(message).indexOf('(cron:session)') >= 0",
    classes: ['authentication', 'endpoint', 'generic'], family: /^(linux_|syslog_rfc|auditd)/, requires: [['message']],
    from: ['syslog_drop_cron'], generalizedFrom: 'linux_syslog syslog_drop_cron',
  },
];

const categoryCache = new Map<string, SourceOptRule[]>();

/** The category rules a sourcetype's parser can carry (none when it keeps a vendor rule). */
export function categoryOptimizationRules(sourcetype: string, vendorRules: SourceOptRule[] = []): SourceOptRule[] {
  const st = canonicalizeSourcetype(sourcetype || '') || sourcetype;
  const cached = categoryCache.get(st);
  if (cached) return cached;
  const cls = staticDataClassFor(st);
  const fields = new Set(getParserFieldNames(st) || []);
  const own = new Set(vendorRules.map(r => r.id));
  const out: SourceOptRule[] = [];
  for (const c of CATEGORY_RULES) {
    if (!c.classes.includes(cls) || DETECTION_FEEDS.test(st)) continue;
    if (cls === 'network' && NOT_FLOW_LOGS.test(st)) continue;
    if (c.family && !c.family.test(st)) continue;
    if (c.from.some(id => own.has(id))) continue;
    if (!c.requires.every(group => group.some(f => fields.has(f)))) continue;
    out.push({
      id: c.id, label: c.label, description: `${c.description} (generalized from ${c.generalizedFrom})`,
      defaultEnabled: false, origin: 'generalized', generalizedFrom: c.generalizedFrom,
      ...(c.filter ? { filter: c.filter } : {}), ...(c.suppress ? { suppress: c.suppress } : {}),
      reads: [...new Set([...c.requires.flat(), ...(c.optional || [])])],
    });
  }
  categoryCache.set(st, out);
  return out;
}

/** Every category rule, for docs/tests. */
export function categoryOptimizationCatalog(): readonly CategoryOptRule[] {
  return CATEGORY_RULES;
}

/** The vendor rules for a sourcetype, then the category rules its parser can carry. */
export function sourceOptimizationRules(sourcetype: string): SourceOptRule[] {
  if (!sourcetype) return [];
  const vendor = RULES[canonicalizeSourcetype(sourcetype)] || RULES[sourcetype] || [];
  return [...vendor, ...categoryOptimizationRules(sourcetype, vendor)];
}

/** Every sourcetype with vendor rules — for tests. */
export function sourceOptimizationSourcetypes(): string[] {
  return Object.keys(RULES);
}

/** Destination formats that can carry a source optimization. */
export function formatSupportsSourceOptimization(destFormat: string): boolean {
  const base = destFormat.split('#')[0];
  return !['ocsf', 'passthrough', 'raw_fields', 'xsiam', 'json', 'manual', 'raw', ''].includes(base);
}

/** Toggle keys carried in the build's reduction toggles. */
export const optimizeToggleKey = (destFormat: string) => `srcopt_on:${destFormat.split('#')[0]}`;
export const ruleToggleKey = (ruleId: string) => `srcopt_rule:${ruleId}`;

/** Is rule `r` enabled under these toggles (falls back to its default)? */
export function ruleEnabled(r: SourceOptRule, toggles: Record<string, boolean>): boolean {
  return toggles[ruleToggleKey(r.id)] ?? r.defaultEnabled;
}

const SCRATCH = '__srcopt_';
const OFF_HINT = ' (off: enable in the Cribl UI to activate)';

export interface SourceOptimizationBuild {
  functions: any[];
  /** Rules shipped enabled. */
  applied: { label: string; description: string }[];
  appliedRules: SourceOptRule[];
  /** Rules shipped disabled (user left them off). */
  shippedOff: string[];
  /** Lookup rules left out because their CSV is not in the pack. */
  skipped: string[];
}

/**
 * The pipeline functions for a source optimization, or none when the format
 * doesn't take one or the card's Optimize is off. `packLookups` = the files the
 * pack actually ships; a lookup rule without its CSV is left out, never shipped
 * pointing at a missing file.
 */
export function buildSourceOptimizationFunctions(
  sourcetype: string,
  destFormat: string,
  toggles: Record<string, boolean>,
  packLookups: string[],
): SourceOptimizationBuild {
  const res: SourceOptimizationBuild = { functions: [], applied: [], appliedRules: [], shippedOff: [], skipped: [] };
  if (!formatSupportsSourceOptimization(destFormat) || toggles[optimizeToggleKey(destFormat)] !== true) return res;
  const scratch: string[] = [];
  // Emitted in the order splitPipelineFunctions would put them back in, so a
  // later re-split (Improve) can't reorder them: lookup plumbing and suppress
  // classify as mapping, drops and the scratch cleanup as optimization.
  const plumbing: any[] = []; const suppress: any[] = []; const drops: any[] = [];
  for (const r of sourceOptimizationRules(sourcetype)) {
    if (r.lookup && !packLookups.includes(r.lookup.file)) { res.skipped.push(r.label); continue; }
    const on = ruleEnabled(r, toggles);
    const tag = r.origin === 'cribl-pack' ? '[Cribl pack] ' : '';
    const description = `${tag}${r.description}${on ? '' : OFF_HINT}`;
    let predicate = r.filter || '';
    if (r.lookup) {
      // Lookup plumbing stays enabled even when the action is off, so turning
      // the rule on in the Cribl UI is one click.
      const keyFields = r.lookup.keys.map((_, i) => `${SCRATCH}${r.id}_k${i}`);
      const hit = `${SCRATCH}${r.id}_hit`;
      scratch.push(...keyFields, hit);
      plumbing.push({
        id: 'eval', filter: 'true', description: `Prepare lookup key for: ${r.label}`,
        conf: { add: r.lookup.keys.map((k, i) => ({ name: keyFields[i], value: k.eventExpr })) },
      });
      plumbing.push({
        id: 'lookup', filter: 'true', description: `Match against ${r.lookup.file} (editable in-pack list)`,
        conf: {
          matchMode: 'exact', reloadPeriodSec: 60, addToEvent: false, ignoreCase: true,
          inFields: r.lookup.keys.map((k, i) => ({ eventField: keyFields[i], lookupField: k.lookupField })),
          outFields: [{ lookupField: r.lookup.hitField, eventField: hit }],
          file: r.lookup.file,
        },
      });
      const hitExpr = r.lookup.dropColumn
        ? `['true','1','yes'].includes(String(${hit} || '').toLowerCase())`
        : `String(${hit} || '') != ''`;
      predicate = predicate ? `(${predicate}) && (${hitExpr})` : hitExpr;
    }
    if (r.suppress) {
      const filter = [r.suppress.filter, predicate].filter(Boolean).map(p => `(${p})`).join(' && ') || 'true';
      suppress.push({
        id: 'suppress', filter, disabled: !on, description,
        conf: {
          allow: 1, suppressPeriodSec: r.suppress.periodSec, dropEventsMode: true, maxCacheSize: 50000,
          cacheIdleTimeoutPeriods: 2, numEventsIdleTimeoutTrigger: 10000, keyExpr: r.suppress.keyExpr,
        },
      });
    } else {
      drops.push({ id: 'drop', filter: predicate, disabled: !on, final: true, description, conf: {} });
    }
    if (on) { res.applied.push({ label: r.label, description: r.description }); res.appliedRules.push(r); }
    else res.shippedOff.push(r.label);
  }
  res.functions.push(...plumbing, ...suppress, ...drops);
  if (scratch.length) {
    res.functions.push({ id: 'eval', filter: 'true', description: 'Remove source-optimization scratch fields', conf: { remove: scratch } });
  }
  return res;
}

/** The same functions with every action disabled (the scoring variant). */
export function withSourceOptimizationOff(fns: any[]): any[] {
  return fns.map(f => (f.id === 'drop' || f.id === 'suppress') ? { ...f, disabled: true } : f);
}
