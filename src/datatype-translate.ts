/**
 * Translate Cribl Search stock datatypes into Stream pipeline functions.
 * Portable library only: named regexp/kvp/csv/json extracts. No Parser Type=Auto,
 * no Parquet, no generic catch-alls (generic_ndjson, ocsf, …).
 */
export interface SearchDatatype {
  id: string;
  dataFormat?: string;
  description?: string;
  additionalExtractions?: SearchExtraction[];
  automaticExtraction?: { extractionType?: string };
  timestampExtraction?: { sourceField?: string };
}

export interface SearchExtraction {
  name?: string;
  extractionType?: string;
  sourceField?: string;
  regexpList?: { regexp?: string }[];
  fieldList?: string[];
  delimiter?: string;
  quote?: string;
  equals?: string;
}

export interface PipelineFn {
  id: string;
  filter?: string;
  description?: string;
  conf: Record<string, unknown>;
}

export interface TranslatedDatatype {
  dataFormat: string;
  functions: PipelineFn[];
  fields: string[];
  timeField: string | null;
  searchDatatypeId: string;
  description: string;
}

const NOISE_FIELDS = /^(future_use|__payload|__kvp_payload|__csv|reserved)/;

/** Catch-alls / dest-schema IDs — never ship as named extraction parsers. */
const GENERIC_DATATYPE_IDS = new Set([
  'generic_ndjson',
  'generic_xml',
  'generic_metrics',
  'generic_csv',
  'generic_kvp',
  'generic_tsv',
  'ocsf',
]);

export function isGenericDatatypeId(id: string): boolean {
  return GENERIC_DATATYPE_IDS.has((id || '').toLowerCase());
}

function alias(name: string, aliases: Record<string, string>): string {
  return aliases[name] || name;
}

function isJsonFormat(dt: SearchDatatype): boolean {
  const fmt = String(dt.dataFormat || '').toLowerCase();
  const auto = String(dt.automaticExtraction?.extractionType || '').toLowerCase();
  return auto === 'json'
    || /json|ndjson/.test(fmt)
    || fmt.includes('newline delimited');
}

export function isUsableDatatype(dt: SearchDatatype): boolean {
  if (!dt?.id || isGenericDatatypeId(dt.id)) return false;
  const fmt = String(dt.dataFormat || '').toLowerCase();
  if (fmt.includes('parquet')) return false;
  const hasRules = (dt.additionalExtractions || []).some(e =>
    ['regexp', 'kvp', 'delimited', 'json'].includes(String(e.extractionType || '')));
  const auto = String(dt.automaticExtraction?.extractionType || '').toLowerCase();
  const autoUseful = ['kvp', 'delimited', 'json', 'regexp'].includes(auto);
  return hasRules || autoUseful || isJsonFormat(dt);
}

export function translateDatatype(
  dt: SearchDatatype,
  aliases: Record<string, string> = {},
): TranslatedDatatype {
  const functions: PipelineFn[] = [];
  const fields = new Set<string>();
  let timeField: string | null = null;
  functions.push({
    id: 'comment',
    conf: { comment: `Parser derived from Cribl Search datatype "${dt.id}" (${dt.dataFormat || 'unknown'}).` },
  });

  const extras = dt.additionalExtractions || [];
  const hasJsonExtra = extras.some(e => e.extractionType === 'json');
  if (isJsonFormat(dt) && !hasJsonExtra) {
    functions.push({
      id: 'serde',
      description: 'Parse JSON',
      conf: { mode: 'extract', type: 'json', srcField: '_raw' },
    });
  }

  for (const ex of extras) {
    const src = ex.sourceField === '_raw' || !ex.sourceField ? '_raw' : ex.sourceField;
    if (ex.extractionType === 'regexp') {
      for (const r of (ex.regexpList || [])) {
        let rx = r.regexp || '';
        if (!rx) continue;
        if (!rx.startsWith('/')) rx = '/' + rx + '/';
        for (const m of rx.matchAll(/\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) {
          if (!NOISE_FIELDS.test(m[1])) fields.add(alias(m[1], aliases));
        }
        functions.push({ id: 'regex_extract', description: ex.name || 'Extract fields', conf: { source: src, regex: rx } });
      }
    } else if (ex.extractionType === 'delimited') {
      const fieldList = (ex.fieldList || []).map(f => NOISE_FIELDS.test(f) ? f : alias(f, aliases));
      fieldList.forEach(f => { if (!NOISE_FIELDS.test(f)) fields.add(f); });
      functions.push({
        id: 'serde',
        description: ex.name || 'Parse delimited',
        // csv ignores delimChar live; delim honours it (see extraction-delimiter.ts).
        conf: { mode: 'extract', type: !ex.delimiter || ex.delimiter === ',' ? 'csv' : 'delim', srcField: src, fields: fieldList, delimChar: ex.delimiter || ',', quoteChar: ex.quote || '"' },
      });
    } else if (ex.extractionType === 'kvp') {
      functions.push({
        id: 'serde',
        description: ex.name || 'Parse KVP',
        conf: { mode: 'extract', type: 'kvp', srcField: src, delimChar: ex.delimiter || ' ', pairDelim: ex.equals || '=' },
      });
    } else if (ex.extractionType === 'json') {
      functions.push({
        id: 'serde',
        description: ex.name || 'Parse JSON',
        conf: { mode: 'extract', type: 'json', srcField: src },
      });
    }
  }

  if ((!dt.additionalExtractions || dt.additionalExtractions.length === 0) && dt.automaticExtraction) {
    const t = dt.automaticExtraction.extractionType;
    if (t === 'kvp') {
      functions.push({ id: 'serde', description: 'Parse KVP', conf: { mode: 'extract', type: 'kvp', srcField: '_raw' } });
    } else if (t === 'delimited') {
      functions.push({ id: 'serde', description: 'Parse delimited', conf: { mode: 'extract', type: 'csv', srcField: '_raw' } });
    }
    // json automaticExtraction is handled above via isJsonFormat
  }

  if (dt.timestampExtraction?.sourceField) {
    timeField = alias(dt.timestampExtraction.sourceField, aliases);
    fields.add(timeField);
  }
  return {
    dataFormat: dt.dataFormat || '',
    functions,
    fields: [...fields],
    timeField,
    searchDatatypeId: dt.id,
    description: dt.description || '',
  };
}

/** Portable Search v2 JSON datatype IDs that v1 regex/kvp import skipped. */
export const PORTABLE_JSON_DATATYPE_IDS = [
  'aws_config', 'aws_eks_audit', 'aws_guardduty', 'aws_network_firewall',
  'aws_route53_resolver', 'aws_security_hub', 'aws_waf_log_json',
  'azure_graph_alerts', 'azure_graph_devices', 'azure_graph_directory_audits',
  'azure_graph_signins', 'azure_graph_user_registration', 'azure_graph_users',
  'azure_nsg_flowlog_json',
  'cloudflare_access_request', 'cloudflare_audit', 'cloudflare_firewall_event',
  'cloudflare_gateway', 'cloudflare_gateway_dns', 'cloudflare_http_request',
  'cloudflare_workers_trace', 'cloudflare_zero_trust_network_session',
  'cloudtrail_digest', 'cloudtrail_event',
  'confluent_audit', 'cribl_internal_logs', 'cribl_metrics', 'exabeam_cim',
  'falcon_events', 'falcon_fdr', 'falcon_fdr_aidmaster', 'falcon_fdr_external_api',
  'falcon_rest_alerts', 'falcon_rest_devices', 'falcon_rest_vulnerabilities',
  'gcp_audit_logs', 'gcp_firewall', 'gcp_vpc_flow',
  'gitlab_audit_log', 'gitlab_audit_streaming', 'gong_audit',
  'gws_activity_reports', 'gws_alerts', 'n8n_log_streaming',
  'netskope_alert_json', 'netskope_event_json',
  'okta_system_log', 'openai_audit', 'openai_completions', 'openai_costs',
  'openai_projects', 'openai_users',
  'proofpoint_tap_clicks', 'proofpoint_tap_messages',
  'salesforce_loginhistory', 'salesforce_setupaudittrail',
  'sentinelone_cloudfunnel_v1', 'sentinelone_cloudfunnel_v2',
  'slack_audit', 'syncsort_zos_smf', 'syncsort_zos_smf_racf', 'syncsort_zos_syslog',
  'terraform_enterprise_audit',
  'trellix_edr_event', 'trellix_epo_device', 'trellix_epo_event', 'trellix_epo_group',
  'wordpress_activity_log', 'workday_activity', 'workday_signon',
  'zeek_json', 'zia_json',
  'zpa_app_connector', 'zpa_audit', 'zpa_browser_access', 'zpa_user_activity', 'zpa_user_status',
] as const;

export function jsonStockParser(id: string, description = ''): TranslatedDatatype {
  return translateDatatype({
    id,
    dataFormat: 'json',
    description: description || `Cribl Search stock JSON datatype "${id}"`,
    automaticExtraction: { extractionType: 'json' },
  });
}

export function seedPortableJsonParsers(
  parsers: Record<string, TranslatedDatatype>,
): string[] {
  const added: string[] = [];
  for (const id of PORTABLE_JSON_DATATYPE_IDS) {
    if (parsers[id]) continue;
    parsers[id] = jsonStockParser(id);
    added.push(id);
  }
  return added;
}
