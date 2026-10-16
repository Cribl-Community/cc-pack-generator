import sentinelCatalogData from '../config/sentinel-destinations.json';
import sentinelSolutionMappingsData from '../config/sentinel-solution-mappings.json';

export interface SentinelColumn {
  name: string;
  /** The DCR stream type (what the pack must send). */
  type: string;
  /** The table's own type, when the stream declares it differently (guid → string). */
  tableType?: string;
}

export interface SentinelTableKnowledge {
  label: string;
  aliases: string[];
  dcrKind: string;
  /** false = the Logs Ingestion API (the Cribl Sentinel destination) cannot write this table. */
  ingestionApi: boolean;
  inputStream: string;
  outputStream: string;
  transformKql: string;
  columns: SentinelColumn[];
  sourcePath: string;
}

const catalog = sentinelCatalogData as {
  reliabilityRules: string[];
  destinationContract: Record<string, unknown>;
  tables: Record<string, SentinelTableKnowledge>;
};

const solutionPacks = sentinelSolutionMappingsData as Array<{
  vendor: string;
  solutionKeywords: string[];
  provenance: string;
  docUrl: string;
  mappings: Array<{ sourceName: string; destName: string; doc: string }>;
}>;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const tableIndex = new Map<string, [string, SentinelTableKnowledge]>();
for (const [name, table] of Object.entries(catalog.tables)) {
  for (const alias of [name, ...table.aliases, table.inputStream, table.outputStream]) {
    tableIndex.set(normalize(alias), [name, table]);
  }
}

const AMBIGUOUS_SENTINEL_NAMES = new Set([
  'sentinel',
  'microsoftsentinel',
  'azuresentinel',
  'loganalytics',
  'azureloganalytics',
]);

export function isAmbiguousSentinelDestination(input: string): boolean {
  return AMBIGUOUS_SENTINEL_NAMES.has(normalize(input));
}

export function resolveSentinelTable(input: string): { name: string; table: SentinelTableKnowledge } | null {
  const hit = tableIndex.get(normalize(input));
  return hit ? { name: hit[0], table: hit[1] } : null;
}

// All Sentinel table names the Cribl Sentinel destination can write, sorted — for
// the destination-step table dropdown (the user picks; no recommendations).
export function listSentinelTables(): string[] {
  return Object.keys(catalog.tables || {})
    .filter(isSentinelIngestionTable)
    .sort((a, b) => a.localeCompare(b));
}

// The Cribl Sentinel destination is the Logs Ingestion API; a table it cannot
// write (DeviceEvents, AzureActivity…) would deploy a pack that lands nothing.
export function isSentinelIngestionTable(name: string): boolean {
  const resolved = resolveSentinelTable(name);
  return !!resolved && resolved.table.ingestionApi !== false;
}

export function sentinelDestinationSuggestions(sourcetype: string): string[] {
  return rawSentinelSuggestions(sourcetype).filter(isSentinelIngestionTable);
}

function rawSentinelSuggestions(sourcetype: string): string[] {
  const st = normalize(sourcetype);
  if (/windowssecurity|winevent/.test(st)) return ['SecurityEvent', 'WindowsEvent', 'ASimAuthenticationEventLogs'];
  if (/windowssysmon|windowspowershell|crowdstrike|endpoint/.test(st)) return ['WindowsEvent', 'ASimProcessEventLogs'];
  if (/awscloudtrail/.test(st)) return ['AWSCloudTrail', 'ASimAuditEventLogs'];
  if (/awsguardduty/.test(st)) return ['AWSGuardDuty', 'CommonSecurityLog'];
  if (/awsvpcflow/.test(st)) return ['AWSVPCFlow', 'ASimNetworkSessionLogs', 'CommonSecurityLog'];
  if (/gcp|googlecloud/.test(st)) return ['GCPAuditLogs', 'ASimAuditEventLogs'];
  if (/linux|syslog/.test(st)) return ['Syslog', 'CommonSecurityLog'];
  if (/dns/.test(st)) return ['ASimDnsActivityLogs', 'CommonSecurityLog'];
  if (/firewall|fortinet|fortigate|paloalto|ciscoasa|zscaler|netskope|cloudflare/.test(st)) {
    return ['CommonSecurityLog', 'ASimNetworkSessionLogs', 'Syslog'];
  }
  return ['CommonSecurityLog', 'Syslog', 'SecurityEvent', 'WindowsEvent', 'ASimNetworkSessionLogs'];
}

// A table named after the vendor's own log (AWSVPCFlow, AWSCloudTrail,
// SecurityEvent…) has the VENDOR's field names as columns, so it wants the
// vendor's own VALUES too. ASim* tables carry Microsoft's normalized vocabulary,
// and CommonSecurityLog/Syslog are generic containers. Same split as
// vendorNativeSentinelTable() in pack-builder.ts, which enforces it in code.
export function isVendorNativeSentinelTable(name: string): boolean {
  return !/^asim/i.test(name) && !['commonsecuritylog', 'syslog'].includes(name.toLowerCase());
}

export const SENTINEL_NATIVE_VALUE_RULE =
  'Value contract: this table is the vendor\'s OWN log shape, so every column takes the vendor\'s own value VERBATIM (e.g. an AWS VPC flow Action is ACCEPT/REJECT). Never substitute a normalized vocabulary (allowed/blocked, Success/Failure) — that belongs in CIM/ASIM, not here. Where the parse stage normalized a value it preserves the original as vendor_<field> (vendor_action, vendor_severity); prefer that field for such a column.';

export function getSentinelDestinationSchema(input: string): string {
  const resolved = resolveSentinelTable(input);
  if (!resolved) return '';
  const { name, table } = resolved;
  const columns = table.columns.map((column) => `${column.name}:${column.type}`).join(', ');
  const valueRule = isVendorNativeSentinelTable(name) ? `\n${SENTINEL_NATIVE_VALUE_RULE}` : '';
  const apiRule = table.ingestionApi === false
    ? `\nWARNING: the Logs Ingestion API cannot write ${name}, so the Cribl Sentinel destination will land nothing here. Pick an ASim* or other API-capable table.`
    : '';
  return `Microsoft Sentinel native table: ${name}${apiRule}
Output shape: flat top-level JSON fields; do not serialize the event into _raw.
DCR input stream used by the Cribl destination: ${table.inputStream}
Azure output stream: ${table.outputStream}
Exact columns and Azure types: ${columns}${valueRule}
Required reliability rules:
- ${catalog.reliabilityRules.join('\n- ')}`;
}

export function getSentinelSolutionMappingContext(sourcetype: string, destination: string): string {
  const st = normalize(sourcetype);
  const table = resolveSentinelTable(destination)?.name || destination.replace(/^(Custom|Microsoft)-/i, '');
  const relevant = solutionPacks.filter((pack) =>
    pack.solutionKeywords.some((keyword) => st.includes(normalize(keyword)) || normalize(keyword).includes(st)),
  );
  if (!relevant.length) return '';

  const lines: string[] = [];
  for (const pack of relevant) {
    let mappings = pack.mappings;
    const tableMappings = mappings.filter((mapping) => mapping.doc.toLowerCase().includes(`-> ${table.toLowerCase()}`));
    if (tableMappings.length) mappings = tableMappings;
    for (const mapping of mappings.slice(0, 200)) {
      lines.push(`${mapping.sourceName} -> ${mapping.destName}`);
    }
  }
  return lines.length
    ? `Microsoft Sentinel solution DCR transform mappings (higher authority than generic aliases):\n${lines.join('\n')}`
    : '';
}

export function getSentinelDestinationContract() {
  return catalog.destinationContract;
}
