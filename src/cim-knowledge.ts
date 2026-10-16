// Splunk CIM data-model knowledge — the CIM counterpart of sentinel-knowledge.ts.
// Catalog (config/cim-data-models.json) is distilled from the official Splunk
// CIM Add-on (Splunk_SA_CIM) JSON models: model → objects → fields. Powers the
// recommend-and-map flow for CIM (recommend a data model from the sourcetype,
// then AI-map to that model's exact field list, scored like any flat schema).
import cimCatalog from '../config/cim-data-models.json';

interface CimField { name: string; type: string }
interface CimObject { object: string; displayName: string; fields: CimField[] }
interface CimModel { displayName: string; objects: CimObject[] }
const MODELS: Record<string, CimModel> = (cimCatalog as any).models || {};

const normalize = (v: string) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Resolve a model name (e.g. "Network_Traffic", "network traffic", "cim:Authentication")
// to its full object/field catalog. Accepts the model name or displayName.
export function resolveCimModel(input: string): { name: string; model: CimModel } | null {
  const n = normalize(String(input).replace(/^cim[:_-]?/i, ''));
  for (const [name, model] of Object.entries(MODELS)) {
    if (normalize(name) === n || normalize(model.displayName) === n) return { name, model };
  }
  return null;
}

// The union of every field across a model's objects (what the mapping can target).
export function cimModelFields(input: string): CimField[] {
  const resolved = resolveCimModel(input);
  if (!resolved) return [];
  const seen = new Set<string>();
  const out: CimField[] = [];
  for (const o of resolved.model.objects) {
    for (const f of o.fields) if (!seen.has(f.name)) { seen.add(f.name); out.push(f); }
  }
  return out;
}

// Recommend CIM data models from a sourcetype, best-first (mirrors
// sentinelDestinationSuggestions). Keyword-driven against the known model set.
export function cimModelSuggestions(sourcetype: string): string[] {
  const st = normalize(sourcetype);
  const has = (...keys: string[]) => keys.some(k => st.includes(normalize(k)));
  let ranked: string[] = [];
  // ORDER MATTERS: `linux_audit` / `auditd` contain the substring "audit" and
  // used to fall through to Change (cloudtrail/audit). Golden + SOURCETYPE_DATACLASS
  // classify them as Endpoint — batch preflight wrote that wrong Change pick into
  // cimModel and mapping scored M=0 while extraction stayed high.
  if (has('linux_audit', 'auditd', 'linuxaudit') || st === 'audit')
    ranked = ['Endpoint', 'Change', 'Authentication'];
  else if (has('firewall', 'fortigate', 'fortinet', 'paloalto', 'palo_alto', 'ciscoasa', 'asa', 'ftd', 'firepower', 'checkpoint', 'sonicwall', 'juniper', 'meraki', 'zscaler', 'netskope', 'cloudflare', 'vpcflow', 'vpc_flow', 'vpc_v5', 'traffic'))
    ranked = ['Network_Traffic', 'Network_Sessions', 'Intrusion_Detection'];
  else if (has('ids', 'ips', 'suricata', 'snort', 'firepower', 'guardduty', 'darktrace'))
    ranked = ['Intrusion_Detection', 'Network_Traffic', 'Alerts'];
  else if (has('auth', 'okta', 'signin', 'sign_in', 'duo', 'ad_', 'azure_ad', 'ldap', 'kerberos', 'radius', 'cyberark'))
    ranked = ['Authentication', 'Change'];
  else if (has('windows_security', 'winsecurity', 'wineventlog', 'security'))
    ranked = ['Authentication', 'Change', 'Endpoint'];
  else if (has('sysmon', 'crowdstrike', 'falcon', 'sentinelone', 'carbonblack', 'defender', 'edr', 'endpoint', 'osquery'))
    ranked = ['Endpoint', 'Malware', 'Intrusion_Detection'];
  else if (has('malware', 'antivirus', 'av_', 'proofpoint', 'mimecast'))
    ranked = ['Malware', 'Email', 'Endpoint'];
  else if (has('email', 'exchange', 'o365', 'office365', 'messagetracking', 'smtp'))
    ranked = ['Email', 'Authentication'];
  else if (has('proxy', 'web', 'apache', 'nginx', 'iis', 'squid', 'bluecoat', 'http'))
    ranked = ['Web', 'Network_Traffic'];
  else if (has('dns', 'infoblox', 'bind', 'resolution'))
    ranked = ['Network_Resolution', 'Network_Traffic'];
  else if (has('cloudtrail', 'gcp_audit', 'azure_audit', 'aws_config', 'change'))
    ranked = ['Change', 'Authentication', 'Data_Access'];
  else if (has('vuln', 'qualys', 'tenable', 'nessus', 'rapid7'))
    ranked = ['Vulnerabilities', 'Intrusion_Detection'];
  else if (has('dlp', 'casb'))
    ranked = ['DLP', 'Data_Access'];
  else
    ranked = ['Network_Traffic', 'Authentication', 'Endpoint', 'Web', 'Change'];
  // Only return models that actually exist in the catalog.
  return ranked.filter(m => MODELS[m]);
}

// A compact prompt-grounding string for the AI mapping: the model's fields with
// types, so the AI maps to the exact CIM field names (like the Sentinel schema
// grounding). Union across the model's objects.
export function getCimModelSchema(input: string): string {
  const resolved = resolveCimModel(input);
  if (!resolved) return '';
  const fields = cimModelFields(input);
  const cols = fields.map(f => `${f.name}:${f.type}`).join(', ');
  return `Splunk CIM data model: ${resolved.name} (${resolved.model.displayName}). Map source fields to these exact CIM field names (flat, top-level; use the canonical CIM name, e.g. dest_ip/src_ip/dest_port/user/action). Fields and types: ${cols}. Fields the source cannot supply are simply omitted — do not invent values.`;
}

export function listCimModels(): string[] {
  return Object.keys(MODELS);
}

/** Models we ship a golden mapping for (UI picker + batch). */
export const CIM_GOLDEN_MODELS = [
  'Network_Traffic', 'Authentication', 'Email', 'Web', 'Network_Resolution',
  'Endpoint', 'Change', 'Intrusion_Detection', 'Malware', 'Network_Sessions',
  'Data_Access', 'DLP', 'Vulnerabilities', 'Alerts',
] as const;

/** Suggested first, then every other golden-backed model (so the UI can offer all). */
export function cimModelPickerOptions(sourcetype: string): string[] {
  const suggested = cimModelSuggestions(sourcetype);
  const rest = CIM_GOLDEN_MODELS.filter(m => MODELS[m] && !suggested.includes(m));
  return [...suggested.filter(m => (CIM_GOLDEN_MODELS as readonly string[]).includes(m)), ...rest];
}
