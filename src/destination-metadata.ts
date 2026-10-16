// Destination metadata contract — the routing fields a destination REQUIRES on
// every event it receives, whatever pack, pipeline or flow stage produced it.
//
// Splunk is the first contract: an event reaching any
// Splunk-family output — a main pack's CIM / Splunk raw / Splunk JSON pipeline,
// or a post-processing pack's splunk#raw / splunk#ocsf / cim#* pipeline — must
// carry `host`, `source` and `sourcetype`. Without them the Splunk HEC receiver
// falls back to the token defaults, so every event lands under one sourcetype
// and no TA's props/transforms ever fire.
//
// Elastic is the second: an event for an Elastic integration (the main pack's
// `elastic_raw`, the post pack's `elasticsearch` raw) goes through the Elastic
// `cribl` integration, which reroutes on `_dataId` and hands `message` to the
// integration's ingest pipeline. The contract stamps `_dataId`, puts the
// original line in `message` (overwriting a Cribl Syslog source's header-less
// `message`, which the integration grok would misread) and drops `_raw` so the
// line is not stored twice. It stamps only a route the CALLER resolved
// (elastic-integration.ts) — no route, or an Elastic Agent-only one, = [].
//
// Google SecOps is the third: the raw card (`chronicle_raw`, the post pack's
// `chronicle#raw`) sends `_raw` untouched as the log text, and the Cribl Google
// SecOps destination reads the ingestion label from `__logType` per event. The
// contract stamps only a COMMITTED Google label (secops-log-types.ts) — an
// unknown log type fails the whole batch with HTTP 400, so no label = [] and the
// destination's Default log type applies.
//
// A new destination slots in as one CONTRACTS entry plus its family mapping in
// destinationMetadataFamily().
//
// A LEAF module (imports only a type) so pack-builder, staged-build,
// pipeline-stages and postprocess-builder can all reach it without an import
// cycle. Callers resolve the source-native values (sourceNativeSourcetype /
// sourceNativeSplunkSource in pack-builder.ts) and pass them in as literals.
import type { PipelineFunction } from './source-recognition';

interface MetadataContract { label: string; fields: readonly string[] }

const CONTRACTS: Record<'splunk' | 'elastic' | 'secops', MetadataContract> = {
  splunk: { label: 'Splunk', fields: ['host', 'source', 'sourcetype'] },
  elastic: { label: 'Elastic cribl integration', fields: ['_dataId', 'message'] },
  secops: { label: 'Google SecOps log type', fields: ['__logType'] },
};

export type DestinationMetadataFamily = keyof typeof CONTRACTS;

/** Every contract function carries this description prefix — it is how
 * pipeline-stages recognises one when it re-splits a deployed pipeline. */
export const DESTINATION_METADATA_DESCRIPTION = 'Destination metadata contract';

/**
 * The sourcetype for a Splunk event whose `_raw` is the OCSF JSON document
 * (splunk#ocsf, or a raw output that had no original event to restore). It must
 * NOT be the vendor's sourcetype: that would hand OCSF JSON to the vendor TA's
 * XML/syslog extractions. Change it here if your OCSF add-on expects another name.
 */
export const SPLUNK_OCSF_SOURCETYPE = 'ocsf';

/**
 * `host` = the device that REPORTED the event, never its peer: an incoming
 * `host`, the OCSF `device.hostname`, the canonical `dvc_host`/`dvc`, the
 * Windows `Computer`, a parsed `hostname`; last, the Cribl worker's own name —
 * what a Splunk forwarder records for a line it forwards. Guarded accessors, no
 * `?.` (Cribl eval), so an absent `device` yields undefined, never a throw.
 */
export const SPLUNK_HOST_EXPR = 'host || (device||{}).hostname || dvc_host || dvc || Computer || hostname || C.os.hostname()';

/** Which contract (if any) a destination key belongs to. Accepts main-pack
 * formats (`cim#network`, `splunk_raw`, `splunk_json`) and post-processing
 * formats (`splunk`, `splunk#raw`, `splunk#ocsf`, `cim#authentication`). */
export function destinationMetadataFamily(destKey?: string | null): DestinationMetadataFamily | null {
  const key = String(destKey || '');
  const family = key.split('#')[0];
  if (family === 'cim' || family === 'splunk' || key === 'splunk_raw' || key === 'splunk_json') return 'splunk';
  if (key === 'elastic_raw' || key === 'elasticsearch') return 'elastic';
  if (key === 'chronicle_raw' || key === 'chronicle#raw') return 'secops';
  return null;
}

/** The fields a destination requires on every event ([] = no contract). For
 * Elastic, the fields a stamped route carries (an unrouted source has none). */
export function requiredDestinationMetadata(destKey?: string | null): readonly string[] {
  const family = destinationMetadataFamily(destKey);
  return family ? CONTRACTS[family].fields : [];
}

export interface DestinationMetadataContext {
  /** Splunk sourcetype literal (e.g. `XmlWinEventLog`, `cisco:asa`, `ocsf`). */
  sourcetype: string;
  /** Splunk source literal; default: keep an incoming `source`, else the sourcetype. */
  source?: string;
  /**
   * Overwrite an incoming sourcetype/source. Set when the builder KNOWS what
   * `_raw` holds (a restored vendor event, or OCSF JSON); leave off to keep what
   * an upstream stage already set (a CIM post pack preserves the routing sourcetype).
   */
  force?: boolean;
  /** Only stamp events this filter selects (default: every event). */
  filter?: string;
  /** Appended to the description, e.g. 'restored vendor event'. */
  note?: string;
  /** Elastic: the caller-resolved route (elasticIntegrationStamp). Absent/null = stamp nothing. */
  elastic?: { dataId: string; inputType?: string } | null;
  /** Google SecOps: the caller-resolved label (secopsLogTypeStamp). Absent/null = stamp nothing. */
  secops?: { logType: string } | null;
}

function quote(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The ONE eval that satisfies a destination's contract, or [] when the
 * destination has none. Adds run in order, so `source` may read the
 * `sourcetype` set just before it.
 */
export function buildDestinationMetadataFunctions(destKey: string | null | undefined, ctx: DestinationMetadataContext): PipelineFunction[] {
  const family = destinationMetadataFamily(destKey);
  if (!family) return [];
  if (family === 'elastic') return buildElasticContract(ctx);
  if (family === 'secops') return buildSecopsContract(ctx);
  const st = quote(ctx.sourcetype || SPLUNK_OCSF_SOURCETYPE);
  const source = ctx.source ? quote(ctx.source) : 'sourcetype';
  const add = [
    { name: 'sourcetype', value: ctx.force ? st : `sourcetype || ${st}` },
    { name: 'source', value: ctx.force && ctx.source ? source : `source || ${source}` },
    { name: 'host', value: SPLUNK_HOST_EXPR },
  ];
  return [{
    id: 'eval',
    filter: ctx.filter || 'true',
    description: `${DESTINATION_METADATA_DESCRIPTION} (${CONTRACTS[family].label}): ${CONTRACTS[family].fields.join(', ')}${ctx.note ? ` — ${ctx.note}` : ''}`,
    conf: { add },
  }];
}

function buildElasticContract(ctx: DestinationMetadataContext): PipelineFunction[] {
  const route = ctx.elastic;
  if (!route || !/^[a-zA-Z0-9._-]{1,100}$/.test(route.dataId || '')) return [];
  const add = [
    { name: 'message', value: "typeof _raw == 'string' && _raw != '' ? _raw : message" },
    { name: '_dataId', value: quote(route.dataId) },
  ];
  // Nested, not a dotted key: the integration pipelines test ctx.input?.type.
  if (route.inputType) add.push({ name: 'input', value: `Object.assign({}, input, {type: ${quote(route.inputType)}})` });
  return [{
    id: 'eval',
    filter: ctx.filter || 'true',
    description: `${DESTINATION_METADATA_DESCRIPTION} (${CONTRACTS.elastic.label}): _dataId=${route.dataId}, message = original line${route.inputType ? `, input.type=${route.inputType}` : ''}${ctx.note ? ` — ${ctx.note}` : ''}`,
    conf: { add, remove: ['_raw'] },
  }];
}

function buildSecopsContract(ctx: DestinationMetadataContext): PipelineFunction[] {
  const logType = ctx.secops?.logType || '';
  if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(logType)) return [];
  // _raw is the log text and stays byte-identical; `__logType` is internal, so
  // no wildcard cleanup removes it and the destination never indexes it.
  return [{
    id: 'eval',
    filter: ctx.filter || 'true',
    description: `${DESTINATION_METADATA_DESCRIPTION} (${CONTRACTS.secops.label}): __logType=${logType}, _raw unchanged${ctx.note ? ` — ${ctx.note}` : ''}`,
    conf: { add: [{ name: '__logType', value: quote(logType) }] },
  }];
}

/** True for a function buildDestinationMetadataFunctions emitted. */
export function isDestinationMetadataFunction(fn: unknown): boolean {
  const f = fn as { id?: unknown; description?: unknown } | null;
  return !!f && f.id === 'eval' && typeof f.description === 'string' && f.description.startsWith(DESTINATION_METADATA_DESCRIPTION);
}

/** The contract fields absent (undefined / null / '') on at least one output event. */
export function missingDestinationMetadata(destKey: string | null | undefined, events: unknown[]): string[] {
  const fields = requiredDestinationMetadata(destKey);
  const objects = (events || []).filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
  if (!objects.length) return [];
  return fields.filter(f => objects.some(e => e[f] === undefined || e[f] === null || e[f] === ''));
}
