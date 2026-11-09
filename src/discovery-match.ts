/**
 * Match what was said on a discovery board to what the app can build (spec R8, R9;
 * plan Task 8). Deterministic and local (ADR-3): the bundled catalogue, curated maps
 * for the board's built-in items, and the SE's own learned aliases — no AI, no network.
 * Same board, same build → same suggestions, with or without Tailscale.
 *
 * Every curated target is checked by tests/discovery-catalog-guard-test.mjs against
 * the live catalogue and FLOW_FORMATS, and every built-in board item must be covered
 * — so a renamed sourcetype or a new upstream board item breaks CI, not the meeting.
 */
import type { IntakeItem } from './discovery-intake';
import { FLOW_FORMATS, FLOW_SYSTEMS, flowSystemFormats } from './flow-builder';
import { getFamilyTokenVariants, searchSupportedSourcetypes } from './pack-builder';
import { getSupportedSourcetypeCatalog, recognizeSourcetype, describeSourcetype } from './source-recognition';
import { BOARD_DEFAULTS, BOARD_FR_ITEMS, BOARD_ITEM_I18N } from './whiteboard/catalog.generated';
import type { DiscoveryAliases } from './whiteboard/types';

export type SampleTier = 'ready' | 'ai';

export interface SourceCandidate { sourcetype: string; description: string; golden: boolean; sample: SampleTier }
export interface SourceMatch {
  status: 'matched' | 'choose' | 'transport' | 'unresolved';
  /** What the row builds unless the SE changes it. */
  picks: string[];
  /** What the picker offers first (max 8). */
  candidates: SourceCandidate[];
  /** One plain sentence: why this suggestion, or what the SE has to decide. */
  why: string;
  learned?: boolean;
}

export interface DestCandidate { format: string; label: string; system: string }
export interface DestMatch {
  status: 'matched' | 'choose' | 'hint' | 'no-format' | 'lake' | 'cribl' | 'unresolved';
  format?: string;
  candidates: DestCandidate[];
  why: string;
  cribl?: 'lakehouse' | 'detect' | 'metrics';
  learned?: boolean;
  /**
   * The product system the row names (a FLOW_SYSTEMS key: 'splunk', 'elastic', …): its
   * format picker offers that system's formats only, as the pack flow picker does.
   */
  system?: string;
}

export interface MatchContext {
  /** Sourcetype → has a real sample somewhere in the tiers (fetchReferenceAvailability). */
  availability: Record<string, { hasSamples: boolean }>;
  aliases?: DiscoveryAliases;
}

export const normWords = (s: string): string =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// --- sources ------------------------------------------------------------------

/** The board's built-in sources → the sourcetypes a demo of them builds, best first. */
export const BOARD_SOURCE_MAP: Record<string, string[]> = {
  'src-ai': ['openai_audit', 'openai_completions'],
  'src-win': ['windows_security', 'windows_sysmon', 'windows_powershell'],
  'src-fw': ['palo_alto_traffic', 'fortinet_fortigate'],
  'src-edr': ['crowdstrike_falcon', 'falcon_fdr', 'ms_defender_atp_alerts'],
  'src-cloudtrail': ['aws_cloudtrail'],
  'src-azure': ['azure_signin', 'azure_graph_directory_audits'],
  'src-m365': ['o365_management_activity'],
  'src-idp': ['okta_system'],
  'src-proxy': ['zscaler_web'],
  'src-dns': ['infoblox_dns', 'microsoft_dns_server_eventlog', 'corelight_dns'],
  'src-flow': ['aws_vpc_v2', 'cisco_netflow_v9'],
  'src-k8s': ['aws_eks_audit'],
  'src-db': ['mysql_server_audit', 'syncsort_zos_smf'],
  'src-otel': ['otel_spans'],
};
/**
 * Sources that have no parser in the catalogue but a REAL reference sample
 * (config/reference-catalog.json) the demo builds from. The guard test checks each one.
 */
export const REFERENCE_SOURCES: ReadonlySet<string> = new Set(['otel_spans']);
/** A built-in whose suggestion needs its own explanation. */
const BOARD_SOURCE_WHY: Record<string, string> = {
  'src-otel': 'OpenTelemetry is also how data arrives. otel_spans demos OTel traces with real spans from Cribl’s OpenTelemetry pack; pick another source if the prospect sends logs over OTLP.',
};
/** Built-ins where one label names several products: every candidate is offered, the first one picked. */
const BOARD_SOURCE_MULTI = new Set(['src-fw']);
/** Built-ins whose first candidate is a guess the SE must confirm. */
const BOARD_SOURCE_CHOOSE = new Set(['src-ai', 'src-win', 'src-edr', 'src-dns', 'src-flow', 'src-db', 'src-azure', 'src-otel']);

/** How data arrives, not what it is: the SE picks the source behind it. */
export const BOARD_TRANSPORTS: ReadonlySet<string> = new Set(['src-uf', 'src-obj', 'src-syslog', 'src-kafka', 'src-edge', 'src-hec']);
const TRANSPORT_WORDS = new Set([
  'syslog', 'kafka', 'hec', 'http', 'http hec', 'splunk uf', 'universal forwarder',
  'splunk forwarder', 'object storage', 's3', 'blob', 'gcs', 'fluentd', 'fluent bit', 'fluentbit', 'beats', 'filebeat',
  'logstash', 'edge agent', 'cribl edge', 'agent', 'agents', 'api', 'webhook', 'event hub', 'eventhub', 'kinesis', 'pubsub',
]);
/** Built-ins that are real data but no source the demo builds. */
export const BOARD_SOURCE_UNSUPPORTED: Record<string, string> = {
  'src-prom': 'Metrics are not built as packs here. Leave it out, or pick a log source.',
  'src-ot': 'No OT or IoT source has a parser yet. Leave it out, or pick the nearest source.',
};

let catalogMemo: Map<string, boolean> | null = null;
const catalog = (): Map<string, boolean> => (catalogMemo ??= new Map(getSupportedSourcetypeCatalog().map(c => [c.name, c.golden])));

function candidate(name: string, ctx: MatchContext): SourceCandidate {
  const description = describeSourcetype(name);
  return {
    sourcetype: name,
    description: description === 'Unknown source type' ? '' : description,
    golden: catalog().get(name) === true,
    sample: ctx.availability[name]?.hasSamples ? 'ready' : 'ai',
  };
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** "Firewalls (Palo Alto, Fortinet)" → ["Palo Alto", "Fortinet"]. */
function parenParts(label: string): string[] {
  const m = label.match(/\(([^)]+)\)/);
  return m ? m[1].split(/,|\/|\band\b|&|\+/i).map(s => s.trim()).filter(Boolean) : [];
}

/** One phrase → the sourcetypes it most plausibly names, best first. */
function resolvePhrase(phrase: string): { exact?: string; options: string[] } {
  const rec = recognizeSourcetype(phrase);
  const exact = (rec.tier === 'exact' || rec.tier === 'alias') && catalog().has(rec.canonical) ? rec.canonical : undefined;
  const family = getFamilyTokenVariants(phrase, 12);
  const search = searchSupportedSourcetypes(phrase, 8).map(s => s.name);
  const fuzzy = rec.tier === 'fuzzy' && rec.suggestion && catalog().has(rec.suggestion) ? [rec.suggestion] : [];
  let options = uniq([...(exact ? [exact] : []), ...family, ...fuzzy, ...search]);
  // "Mainframe SMF" finds nothing as a phrase but `smf` does: fall back to its words.
  if (!options.length) {
    const words = normWords(phrase).split(' ').filter(w => w.length >= 3 && !STOP_WORDS.has(w));
    if (words.length > 1) options = uniq(words.flatMap(w => searchSupportedSourcetypes(w, 6).map(s => s.name)));
  }
  // "Firewall Fortinet" and "Fortinet firewall" must agree: the vendor word leads, the generic one does not.
  // A hyphenated product name is one word: "Big-IP" → "bigip" (else "big" matches bigquery).
  const joined = (phrase.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g) || []).map(w => w.replace(/-/g, '').toLowerCase());
  const vendorWords = [...joined, ...normWords(phrase).split(' ')].filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !GENERIC_WORDS.has(w));
  if (vendorWords.length && vendorWords.length < normWords(phrase).split(' ').length) {
    const named = vendorWords.flatMap(w => uniq([...getFamilyTokenVariants(w, 12), ...searchSupportedSourcetypes(w, 8).map(x => x.name)]).filter(n => n.toLowerCase().includes(w)));
    options = uniq([...named, ...options]);
  }
  return { exact: family.length >= 2 ? undefined : exact, options };
}
/** Words that name a kind of product, not a product — they never lead a match. */
const GENERIC_WORDS = new Set(['firewall', 'firewalls', 'proxy', 'edr', 'siem', 'waf', 'vpn', 'router', 'routers', 'switch', 'switches', 'endpoint', 'identity', 'dns', 'web', 'network']);
const STOP_WORDS = new Set(['logs', 'log', 'events', 'event', 'the', 'and', 'data', 'audit', 'security', 'server', 'servers', 'cloud']);

/** Candidates with a real sample first, then golden ones — otherwise the matcher's order. */
function bySampleThenGolden(cands: SourceCandidate[]): SourceCandidate[] {
  const rank = (c: SourceCandidate) => (c.sample === 'ready' ? 0 : 2) + (c.golden ? 0 : 1);
  return cands.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(x => x.c);
}

/** Product words the SE types that name one of the board's built-in sources. */
const SOURCE_WORDS: Array<[RegExp, string]> = [
  [/\b(entra|azure ad|aad|azure active directory)\b/, 'src-azure'],
  [/\bokta\b/, 'src-idp'],
  [/\b(o365|office 365|m365|microsoft 365)\b/, 'src-m365'],
  [/\b(zscaler|zia)\b/, 'src-proxy'],
  [/\bcloudtrail\b/, 'src-cloudtrail'],
  [/\b(vpc flow|netflow)\b/, 'src-flow'],
  [/\b(otel|otlp|opentelemetry|open telemetry)\b/, 'src-otel'],
];

/** A bare vendor name: the sources a demo of that vendor usually shows, best first. */
export const VENDOR_FAMILIES: Record<string, string[]> = {
  microsoft: ['windows_security', 'azure_signin', 'o365_management_activity', 'ms_defender_atp_alerts', 'windows_sysmon', 'windows_powershell', 'microsoft_dns_server_eventlog', 'microsoft_iis_accesslog'],
  aws: ['aws_cloudtrail', 'aws_vpc_v2', 'aws_eks_audit'],
  amazon: ['aws_cloudtrail', 'aws_vpc_v2', 'aws_eks_audit'],
};

/** Built-in board items by their drawn text (EN and FR), so a typed "Datadog" gets the built-in's answer. */
function builtinByLabel(group: string, label: string): string | undefined {
  const w = normWords(label);
  for (const d of BOARD_DEFAULTS[group] || []) {
    const names = [d.label, BOARD_FR_ITEMS[d.id]?.l, ...Object.values(BOARD_ITEM_I18N).map(m => m[d.id]?.l)].filter(Boolean).map(x => normWords(x!));
    if (names.some(n => n === w || n.replace(/ \(.*\)$/, '') === w)) return d.id;
  }
  if (group === 'sources') for (const [re, id] of SOURCE_WORDS) if (re.test(w)) return id;
  return undefined;
}

function builtinSource(id: string, label: string, ctx: MatchContext): SourceMatch | null {
  if (BOARD_TRANSPORTS.has(id)) {
    return { status: 'transport', picks: [], candidates: [], why: `${label} is how data arrives, not what it is. Pick the source behind it, or leave it out.` };
  }
  if (BOARD_SOURCE_UNSUPPORTED[id]) return { status: 'unresolved', picks: [], candidates: [], why: BOARD_SOURCE_UNSUPPORTED[id] };
  const mapped = BOARD_SOURCE_MAP[id];
  if (!mapped) return null;
  const candidates = mapped.map(n => candidate(n, ctx));
  if (BOARD_SOURCE_MULTI.has(id)) {
    return { status: 'matched', picks: mapped, candidates, why: `${label} names ${mapped.length} products; each becomes its own source.` };
  }
  if (BOARD_SOURCE_CHOOSE.has(id)) {
    return { status: 'choose', picks: [mapped[0]], candidates, why: BOARD_SOURCE_WHY[id] ?? `"${label}" covers ${mapped.length} sources. Keep the suggestion or pick the ones the prospect mentioned.` };
  }
  return { status: 'matched', picks: [mapped[0]], candidates, why: '' };
}

export function matchSource(item: IntakeItem, ctx: MatchContext): SourceMatch {
  const words = normWords(item.label);
  const learned = ctx.aliases?.sources?.[words];
  if (learned && learned.picks.length) {
    return { status: 'matched', picks: learned.picks, candidates: learned.picks.map(n => candidate(n, ctx)), why: 'Your choice last time for the same words.', learned: true };
  }
  const builtinId = item.builtin ? item.id : builtinByLabel('sources', item.label);
  if (builtinId) {
    const m = builtinSource(builtinId, item.label, ctx);
    if (m) return m;
  }
  if (VENDOR_FAMILIES[words]) {
    const list = VENDOR_FAMILIES[words];
    return {
      status: 'choose', picks: [], candidates: bySampleThenGolden(list.map(n => candidate(n, ctx))),
      why: `"${item.label}" covers many sources. Pick the ones the prospect mentioned.`,
    };
  }
  if (TRANSPORT_WORDS.has(words)) {
    return { status: 'transport', picks: [], candidates: [], why: `${item.label} is how data arrives, not what it is. Pick the source behind it, or leave it out.` };
  }
  // The SE's own text: a "(A, B)" list names several products; otherwise the whole label.
  const parts = parenParts(item.label);
  if (parts.length >= 2) {
    const resolved = parts.map(resolvePhrase);
    const picks = uniq(resolved.map(r => r.exact || r.options[0]));
    if (picks.length) {
      const options = uniq([...picks, ...resolved.flatMap(r => r.options)]).slice(0, 8);
      const all = resolved.every(r => r.exact);
      return {
        status: all ? 'matched' : 'choose', picks, candidates: bySampleThenGolden(options.map(n => candidate(n, ctx))),
        why: all ? `${item.label} names ${picks.length} products; each becomes its own source.` : `Check the suggestions for ${parts.join(', ')}.`,
      };
    }
  }
  const r = resolvePhrase(item.label.replace(/\([^)]*\)/g, ' ').trim() || item.label);
  if (r.exact) return { status: 'matched', picks: [r.exact], candidates: r.options.slice(0, 8).map(n => candidate(n, ctx)), why: '' };
  if (r.options.length === 1) return { status: 'matched', picks: r.options, candidates: [candidate(r.options[0], ctx)], why: '' };
  if (r.options.length > 1) {
    return {
      status: 'choose', picks: [], candidates: bySampleThenGolden(r.options.slice(0, 8).map(n => candidate(n, ctx))),
      why: `"${item.label}" matches ${r.options.length}${r.options.length >= 8 ? '+' : ''} sources. Pick the ones the prospect mentioned.`,
    };
  }
  return { status: 'unresolved', picks: [], candidates: [], why: `No supported source matches "${item.label}". Search the catalogue, or leave it out.` };
}

// --- destinations -------------------------------------------------------------

const destCandidate = (format: string): DestCandidate => {
  const info = FLOW_FORMATS[format];
  return { format, label: info?.label || format, system: info ? (FLOW_SYSTEMS[info.system]?.name || info.system) : format };
};

/** The board's built-in destinations → the format a demo of them builds. */
export const BOARD_DEST_MAP: Record<string, { status: DestMatch['status']; format?: string; family?: string[]; why?: string; cribl?: DestMatch['cribl'] }> = {
  'pt-detect': { status: 'cribl', cribl: 'detect', why: 'Cribl Detect is shown for the story; the demo does not deploy it.' },
  'pt-xsiam': { status: 'matched', format: 'xsiam' },
  'pt-cs': { status: 'matched', format: 'nextgen', why: 'Raw events for the CrowdStrike vendor parser.' },
  'pt-sentinel': { status: 'matched', format: 'sentinel', family: ['asim'] },
  'pt-splunk': { status: 'matched', format: 'cim', family: ['splunk_json', 'splunk_raw'] },
  // Raw events for the Elastic integration to parse, as SEs demo it (2026-11-01); ECS is the alternative.
  'pt-elastic': { status: 'matched', format: 'elastic_raw', family: ['ecs', 'elastic_json'] },
  'pt-secops': { status: 'matched', format: 'chronicle', family: ['chronicle_raw'] },
  'pt-qradar': { status: 'choose', format: 'cef', family: ['json'], why: 'QRadar parses CEF through its Universal CEF DSM.' },
  'pt-datadog': { status: 'no-format', format: 'json', family: ['passthrough'] },
  'pt-dynatrace': { status: 'no-format', format: 'json', family: ['passthrough'] },
  'pt-newrelic': { status: 'no-format', format: 'json', family: ['passthrough'] },
  'pt-exabeam': { status: 'no-format', format: 'json', family: ['cef', 'passthrough'] },
  'pt-sumo': { status: 'no-format', format: 'json', family: ['passthrough'] },
  'pt-securonix': { status: 'no-format', format: 'json', family: ['cef', 'passthrough'] },
  'pt-grafana': { status: 'no-format', format: 'json', family: ['passthrough'] },
  'pt-splunkobs': { status: 'no-format', format: 'json', family: ['passthrough'] },
  'pt-s1': { status: 'no-format', format: 'json', family: ['passthrough'] },
  'cr-lake': { status: 'lake' },
  'cr-byob': { status: 'lake' },
  'cr-lakehouse': { status: 'cribl', cribl: 'lakehouse', why: 'The Lakehouse Engine is shown for the story; the demo does not deploy it.' },
  'cr-metrics': { status: 'cribl', cribl: 'metrics', why: 'Cribl Metrics is shown for the story; the demo does not deploy it.' },
  'pf-databricks': { status: 'choose', format: 'ocsf', family: ['json', 'raw_fields'] },
  'pf-snowflake': { status: 'choose', format: 'ocsf', family: ['json', 'raw_fields'] },
  'pf-clickhouse': { status: 'choose', format: 'ocsf', family: ['json', 'raw_fields'] },
  'pf-bigquery': { status: 'choose', format: 'ocsf', family: ['json', 'raw_fields'] },
  'pf-obj': { status: 'choose', format: 'ocsf', family: ['passthrough', 'raw_fields'] },
  'pf-adx': { status: 'choose', format: 'ocsf', family: ['json', 'sentinel'] },
  'pf-fabric': { status: 'choose', format: 'ocsf', family: ['json'] },
  'pf-seclake': { status: 'matched', format: 'ocsf', why: 'Amazon Security Lake stores OCSF.' },
  'pf-iceberg': { status: 'choose', format: 'ocsf', family: ['raw_fields'] },
  'pf-opensearch': { status: 'hint', format: 'elastic_json', why: 'OpenSearch keeps the Elasticsearch _bulk API.' },
  'pf-hadoop': { status: 'choose', format: 'ocsf', family: ['raw_fields', 'passthrough'] },
};

/**
 * A destination that ingests through another product's API. Shown as a suggestion the
 * SE must accept — never applied on its own. Keyed by normalised words of the label.
 */
export const DEST_COMPAT_HINTS: Record<string, { format: string; why: string; source: string }> = {
  sekoia: { format: 'ecs', why: 'Sekoia ingests through an Elasticsearch-compatible API, so Elastic ECS is the closest match.', source: 'SE field knowledge (requested 2026-10-31); confirm before relying on it' },
  opensearch: { format: 'elastic_json', why: 'OpenSearch keeps the Elasticsearch _bulk API.', source: 'OpenSearch is a fork of Elasticsearch 7.10 and keeps its REST/_bulk API' },
  'amazon opensearch': { format: 'elastic_json', why: 'Amazon OpenSearch Service keeps the Elasticsearch _bulk API.', source: 'as opensearch' },
  wazuh: { format: 'elastic_json', why: 'The Wazuh indexer is an OpenSearch fork.', source: 'Wazuh indexer documentation: based on OpenSearch' },
  qradar: { format: 'cef', why: 'QRadar parses CEF through its Universal CEF DSM.', source: 'IBM QRadar DSM guide: Universal CEF; confirm before relying on it' },
};

/** Other names of products that DO have a format. */
const DEST_NAMES: Array<[RegExp, string]> = [
  [/\b(splunk( cloud| enterprise| es)?)\b/, 'cim'],
  [/\b(sentinel|log analytics)\b/, 'sentinel'],
  [/\b(elastic|elasticsearch|kibana)\b/, 'elastic_raw'],
  [/\b(xsiam|cortex)\b/, 'xsiam'],
  [/\b(crowdstrike|ng ?siem|next ?gen siem|logscale|falcon logscale|humio)\b/, 'nextgen'],
  [/\b(secops|chronicle|google security operations)\b/, 'chronicle'],
  [/\b(arcsight)\b/, 'cef'],
  [/\b(security lake)\b/, 'ocsf'],
];
const LAKE_WORDS = /\b(cribl lake)\b/;

/** Systems that are one product: a row naming one is offered only that product's formats. */
const PRODUCT_SYSTEMS: ReadonlySet<string> = new Set(['splunk', 'sentinel', 'elastic', 'secops', 'arcsight', 'xsiam', 'crowdstrike']);
const productSystemOf = (format: string | undefined): string | undefined => {
  const sys = format ? FLOW_FORMATS[format]?.system : undefined;
  return sys && PRODUCT_SYSTEMS.has(sys) ? sys : undefined;
};

/** The product a destination label names, whatever format was learned for it. */
function productSystem(words: string, builtinId: string | undefined): string | undefined {
  const m = builtinId ? BOARD_DEST_MAP[builtinId] : undefined;
  if (m) return m.status === 'matched' ? productSystemOf(m.format) : undefined;
  for (const [re, format] of DEST_NAMES) if (re.test(words)) return productSystemOf(format);
  return undefined;
}

export function matchDestination(item: IntakeItem, ctx: MatchContext): DestMatch {
  const words = normWords(item.label);
  const builtinId = item.builtin ? item.id
    : (['point', 'cribl', 'platform'].map(g => builtinByLabel(g, item.label)).find(Boolean));
  const system = productSystem(words, builtinId);
  const sys = system ? { system } : {};
  const learned = ctx.aliases?.dests?.[words];
  if (learned && FLOW_FORMATS[learned.format]) {
    return { status: 'matched', format: learned.format, candidates: [destCandidate(learned.format)], why: learned.note || 'Your choice last time for the same words.', learned: true, ...sys };
  }
  if (builtinId && BOARD_DEST_MAP[builtinId]) {
    const m = BOARD_DEST_MAP[builtinId];
    const formats = uniq([...(m.format ? [m.format] : []), ...(m.family || [])]);
    const why = m.why
      ?? (m.status === 'no-format' ? `No dedicated format for ${item.label}. Clean JSON is the closest.`
        : m.status === 'choose' ? `A data platform has no format of its own. ${destCandidate(m.format!).label} is the suggestion.`
        : '');
    return { status: m.status, ...(m.format ? { format: m.format } : {}), candidates: formats.map(destCandidate), why, ...(m.cribl ? { cribl: m.cribl } : {}), ...sys };
  }
  for (const [key, hint] of Object.entries(DEST_COMPAT_HINTS)) {
    if (words === key || words.split(' ').includes(key) || words.startsWith(`${key} `)) {
      return { status: 'hint', format: hint.format, candidates: [destCandidate(hint.format)], why: `The app has no ${item.label} format. ${hint.why}` };
    }
  }
  if (LAKE_WORDS.test(words)) return { status: 'lake', candidates: [], why: '' };
  for (const [re, format] of DEST_NAMES) {
    if (re.test(words)) return { status: 'matched', format, candidates: [destCandidate(format)], why: '', ...sys };
  }
  return { status: 'unresolved', candidates: [], why: `No format matches "${item.label}". Pick the format its ingestion API expects, or leave it out.` };
}

/** Every format the destination picker offers (everything the demo can build). */
export function demoFormatOptions(): DestCandidate[] {
  return Object.keys(FLOW_FORMATS).filter(f => f !== 'manual').map(destCandidate);
}

export interface DestFormatGroup { title: string; options: DestCandidate[] }

/** The FLOW_SYSTEMS key of Cribl Lake & storage: what a Cribl Lake row is offered. */
const LAKE_SYSTEM = 'lake';

/**
 * What a destination row's format picker offers — only what makes sense for it, as the
 * pack flow picker groups formats by destination system:
 *   - Cribl Lake: the three Lake formats (OCSF, raw copy, raw + extracted fields)
 *   - a product (Splunk, Sentinel, Elastic, …): that product's formats
 *   - a data platform or a tool with no format: its curated family
 *   - anything else (a compatibility hint, nothing matched): every format, by system
 * The row's current format is always offered, so a choice saved earlier can be kept.
 */
export function destFormatChoices(match: DestMatch, current?: string): DestFormatGroup[] {
  const withCurrent = (formats: string[]) => uniq([...formats, ...(current && FLOW_FORMATS[current] ? [current] : [])]);
  const one = (title: string, formats: string[]): DestFormatGroup[] => [{ title, options: withCurrent(formats).map(destCandidate) }];
  if (match.status === 'lake') return one(FLOW_SYSTEMS[LAKE_SYSTEM].name, flowSystemFormats(LAKE_SYSTEM));
  if (match.system) return one(FLOW_SYSTEMS[match.system]?.name || match.system, flowSystemFormats(match.system));
  if ((match.status === 'choose' || match.status === 'no-format') && match.candidates.length) {
    return one('Suggested', match.candidates.map(c => c.format));
  }
  return Object.keys(FLOW_SYSTEMS)
    .map(sys => ({ title: FLOW_SYSTEMS[sys].name, options: flowSystemFormats(sys).map(destCandidate) }))
    .filter(g => g.options.length);
}
