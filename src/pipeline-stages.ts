import { isDestinationMetadataFunction } from './destination-metadata';

export type PipelineStageId = 'extraction' | 'mapping' | 'optimization';

export interface SplitPipeline {
  extraction: any[];
  mapping: any[];
  optimization: any[];
}

export interface ExtractionStageValidation {
  valid: boolean;
  reasons: string[];
}

export interface MappingInputValidation {
  valid: boolean;
  populatedFields: string[];
  matchedFields: string[];
  reason: string;
}

export function averageStageScores(
  extraction: number | null | undefined,
  mapping: number | null | undefined,
  // A stage that grades what the destination RECEIVES (NG SIEM raw fidelity) is
  // the whole answer: its extraction only feeds drops and flags.
  delivery?: { score: number | null; decidesOverall?: boolean } | null,
): number | null {
  if (delivery?.decidesOverall) return delivery.score != null && Number.isFinite(delivery.score) ? delivery.score : null;
  const scores = [extraction, mapping].filter(
    (score): score is number => score != null && Number.isFinite(score),
  );
  if (!scores.length) return null;
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function meetsStageThreshold(
  score: number | null | undefined,
  threshold: number,
): boolean {
  return typeof score === 'number'
    && Number.isFinite(score)
    && score >= threshold;
}

export function shouldAcceptCombinedCandidate(
  extractionScore: number | null | undefined,
  mappingScore: number | null | undefined,
  extractionThreshold: number,
  mappingThreshold: number,
): boolean {
  return meetsStageThreshold(extractionScore, extractionThreshold)
    && meetsStageThreshold(mappingScore, mappingThreshold);
}

export function canScoreOptimization(
  extractionScore: number | null | undefined,
  mappingScore: number | null | undefined,
  extractionThreshold: number,
  mappingThreshold: number,
): boolean {
  return shouldAcceptCombinedCandidate(
    extractionScore,
    mappingScore,
    extractionThreshold,
    mappingThreshold,
  );
}

export function resolveDetectedSourcetype(
  current: string,
  detected: string,
  explicit: boolean,
): { selected: string; adopt: boolean } {
  if (explicit && current.trim()) return { selected: current, adopt: false };
  return { selected: detected, adopt: true };
}

// Fields that identify a destination schema envelope rather than a source parse.
// Canonical aliases such as src_ip/dest_ip intentionally stay allowed: extraction
// is responsible for producing those destination-independent names.
const DESTINATION_ONLY_FIELDS = new Set([
  // OCSF
  'activity_id', 'activity_name', 'category_uid', 'category_name',
  'class_uid', 'class_name', 'type_uid', 'type_name',
  'severity_id', 'severity_name', 'src_endpoint', 'dst_endpoint',
  'http_request', 'http_response', 'connection_info', 'traffic',
  'observables', 'unmapped',
  // Chronicle UDM
  'principal', 'target', 'security_result', 'intermediary', 'additional',
  // Microsoft CommonSecurityLog
  'DeviceVendor', 'DeviceProduct', 'DeviceVersion', 'DeviceEventClassID',
  'Activity', 'LogSeverity', 'SourceIP', 'SourcePort', 'DestinationIP',
  'DestinationPort', 'DestinationHostName', 'SourceUserName',
  'DestinationUserName', 'RequestURL', 'RequestMethod', 'Protocol',
  'ReceivedBytes', 'SentBytes', 'TimeGenerated',
]);

const DESTINATION_SCHEMA_ROOTS = new Set([
  // ECS namespaces whose children are destination fields.
  'ecs', 'event', 'source', 'destination', 'client', 'server', 'network',
  'observer', 'agent', 'cloud', 'container', 'process', 'file', 'registry',
  'threat',
]);

// These names are valid canonical scalar fields, but dotted children identify
// an ECS destination object (for example user.name or url.full).
const DOTTED_DESTINATION_ROOTS = new Set(['user', 'host', 'url', 'http', 'log']);

function isDestinationSchemaField(name: string): boolean {
  if (DESTINATION_ONLY_FIELDS.has(name)) return true;
  const dot = name.indexOf('.');
  if (dot < 0) return false;
  const root = name.slice(0, dot);
  return DESTINATION_ONLY_FIELDS.has(root)
    || DESTINATION_SCHEMA_ROOTS.has(root)
    || DOTTED_DESTINATION_ROOTS.has(root);
}

/**
 * Enforce the sealed extraction-stage contract.
 *
 * An extraction golden may parse and add destination-independent canonical
 * aliases. It may not construct a destination schema envelope or compact the
 * final event into `_raw`; those operations belong to mapping/optimization.
 */
export function validateExtractionStage(functions: any[]): ExtractionStageValidation {
  const reasons = new Set<string>();

  for (const fn of functions || []) {
    const id = fn?.id;
    const conf = fn?.conf || {};

    if (id === 'serialize' && (conf.dstField === '_raw' || conf.type === 'json')) {
      reasons.add('serializes output into _raw (optimization responsibility)');
    }

    const removed = Array.isArray(conf.remove) ? conf.remove : [];
    if (removed.some((field: unknown) => field === '_raw' || field === '*')) {
      reasons.add('removes _raw or all source fields (optimization responsibility)');
    }

    const added = Array.isArray(conf.add) ? conf.add : [];
    for (const entry of added) {
      const name = entry?.name;
      if (typeof name === 'string' && isDestinationSchemaField(name)) {
        reasons.add(`adds destination schema field '${name}'`);
      }
    }
  }

  return { valid: reasons.size === 0, reasons: [...reasons] };
}

export function validateMappingStage(functions: any[]): ExtractionStageValidation {
  const reasons = new Set<string>();
  for (const fn of functions || []) {
    if (isCompactOptFn(fn)) {
      reasons.add('contains output compaction (optimization responsibility)');
    }
    if (['regex_extract', 'serde', 'parser', 'code'].includes(fn?.id)) {
      reasons.add(`contains extraction function '${fn.id}'`);
    }
  }
  return { valid: reasons.size === 0, reasons: [...reasons] };
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function mappingExpressionText(functions: any[]): string {
  const expressions: string[] = [];
  for (const fn of functions || []) {
    if (typeof fn?.filter === 'string') expressions.push(fn.filter);
    const conf = fn?.conf || {};
    if (typeof conf.srcField === 'string') expressions.push(conf.srcField);
    if (Array.isArray(conf.add)) {
      for (const entry of conf.add) {
        if (entry?.value != null) expressions.push(String(entry.value));
      }
    }
    if (Array.isArray(conf.rename)) {
      for (const entry of conf.rename) {
        if (entry?.currentName != null) expressions.push(String(entry.currentName));
        if (entry?.from != null) expressions.push(String(entry.from));
      }
    }
  }
  return expressions.join('\n');
}

/**
 * Prove that a mapping candidate consumes the sealed extraction output.
 *
 * A mapping which reads none of the fields that carry values can only emit
 * constants or reference a stale extraction contract. It must be rejected
 * before deployment/scoring so the next grounded candidate gets a chance.
 */
export function validateMappingInputs(functions: any[], extractionEvents: any[]): MappingInputValidation {
  const populatedFields = Array.from(new Set(
    (extractionEvents || []).flatMap(event =>
      Object.entries(event || {})
        .filter(([name, value]) =>
          name !== '_raw'
          && !name.startsWith('__')
          && !name.startsWith('cribl_')
          && hasMeaningfulValue(value))
        .map(([name]) => name)),
  )).sort();
  const text = mappingExpressionText(functions);
  const matchedFields = populatedFields.filter(field => {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(text);
  });
  const valid = populatedFields.length > 0 && matchedFields.length > 0;
  return {
    valid,
    populatedFields,
    matchedFields,
    reason: valid
      ? `reads ${matchedFields.length}/${populatedFields.length} populated extraction fields`
      : populatedFields.length === 0
        ? 'extraction produced no populated fields for mapping'
        : `reads none of ${populatedFields.length} populated extraction fields`,
  };
}

export function isCompactOptFn(f: any): boolean {
  const id = f?.id;
  const conf = f?.conf || {};
  // CIM compact serialize must travel with optimization, not sit mid-mapping
  // (a mid-map serialize + later serialize nests _raw inside _raw).
  if (id === 'serialize' && (conf.dstField === '_raw' || conf.type === 'json')) return true;
  if (id !== 'eval' && id !== 'serialize') return false;
  // A final compaction may also add output metadata such as `sourcetype`.
  // keep/remove is the structural signal: it must stay with optimization so
  // replacing mappings cannot silently drop the final cleanup.
  return Array.isArray(conf.keep) || Array.isArray(conf.remove);
}

/** Drop keep/remove + _raw-json serialize stages (golden CIM cleanup / compact_output). */
export function withoutOutputCompaction(fns: any[]): any[] {
  return (fns || []).filter(f => {
    if (isCompactOptFn(f)) return false;
    if (f?.id === 'serialize' && (f?.conf?.dstField === '_raw' || f?.conf?.type === 'json')) return false;
    return true;
  });
}

function isOptFn(f: any): boolean {
  const id = f?.id;
  if (id === 'drop' || id === 'comment' || id === 'mask' || id === 'sampling') return true;
  // The destination-metadata contract heads the optimization slot (staged-build).
  if (isDestinationMetadataFunction(f)) return true;
  return isCompactOptFn(f);
}

// staged-build's ORIGINAL_RAW_COPY and pack-builder's NextGen snapshot share this
// field. Not imported: staged-build/pack-builder import this module.
const RAW_COPY_FIELD = 'pg_original_raw_copy';

/**
 * The "keep original _raw" copy (withOriginalRawCopy) and the NG-SIEM snapshot
 * (nextGenRawSnapshotFunction): an eval that only copies `_raw` aside, ahead of
 * the parser. It preserves extraction, so it belongs to the extraction stage —
 * otherwise the split ends at index 0 and every keep-raw pack scores extraction 0.
 */
export function isRawCopyFn(f: any): boolean {
  if (f?.id !== 'eval') return false;
  const conf = f?.conf || {};
  if (Array.isArray(conf.remove) || Array.isArray(conf.keep)) return false;
  const add = conf.add;
  return Array.isArray(add) && add.length > 0
    && add.every((a: any) => a?.name === RAW_COPY_FIELD && String(a?.value ?? '').trim() === '_raw');
}

function isExtFn(f: any): boolean {
  const id = f?.id;
  if (id === 'regex_extract' || id === 'serde' || id === 'parser' || id === 'code') return true;
  if (isRawCopyFn(f)) return true;
  if (id === 'eval') {
    const add = f?.conf?.add;
    if (!Array.isArray(add) || add.length === 0) return true;
    return add.every((a: any) => {
      const name = a?.name;
      return name === 'log_time' || (typeof name === 'string' && name.startsWith('__'));
    });
  }
  return false;
}

export function splitPipelineFunctions(functions: any[]): SplitPipeline {
  const extraction: any[] = [];
  const optimization: any[] = [];
  const mapping: any[] = [];

  let i = 0;
  while (i < functions.length && isExtFn(functions[i])) {
    extraction.push(functions[i++]);
  }

  while (i < functions.length) {
    const f = functions[i++];
    if (isOptFn(f)) optimization.push(f);
    else mapping.push(f);
  }

  return { extraction, optimization, mapping };
}

/** Always extraction → mapping → optimization (never opt in the middle). */
export function assemblePipelineFunctions(split: SplitPipeline): any[] {
  return [...split.extraction, ...split.mapping, ...split.optimization];
}

export function splicePipelineStage(baseline: any[], stage: PipelineStageId, next: any[]): any[] {
  const split = splitPipelineFunctions(baseline);
  if (stage === 'extraction') {
    // A replacement parser must not drop the raw copy: later stages (raw_data,
    // NG-SIEM restore) read it. It stays first, before any parser rewrites _raw.
    const rawCopies = next.some(isRawCopyFn) ? [] : split.extraction.filter(isRawCopyFn);
    return assemblePipelineFunctions({
      extraction: [...rawCopies, ...next],
      mapping: withoutOutputCompaction(split.mapping),
      optimization: split.optimization,
    });
  }
  if (stage === 'mapping') {
    // Drop stale compact from both the new mapping and leftover opt keep/serialize;
    // keep noise drops so they still run after mapping, and the destination-
    // metadata contract (a destination requirement, not a mapping choice).
    const drops = split.optimization.filter(f => f?.id === 'drop' || isDestinationMetadataFunction(f));
    return assemblePipelineFunctions({
      extraction: split.extraction,
      mapping: withoutOutputCompaction(next),
      optimization: drops,
    });
  }
  // optimization: always at the end, after a clean mapping (no mid-map serialize).
  // A candidate that doesn't carry the destination-metadata contract keeps the
  // baseline's — re-optimizing must never strip Splunk host/source/sourcetype.
  const contract = next.some(isDestinationMetadataFunction) ? [] : split.optimization.filter(isDestinationMetadataFunction);
  return assemblePipelineFunctions({
    extraction: split.extraction,
    mapping: withoutOutputCompaction(split.mapping),
    optimization: [...contract, ...next],
  });
}

export function inferFromPipelineId(pipelineId: string): { sourcetype: string; destFormat: string } | null {
  const m = pipelineId.match(/^(.+)_to_(.+)$/);
  if (!m) return null;
  const destSuffix = m[2];
  // getPipelineId replaces `#` with `_` (not a valid pipeline-id char). Restore
  // the concrete schema for ASIM (`asim#authentication`) and CIM (`cim#network`)
  // so mapping/preview use the right golden, not a bare family name.
  let destFormat = destSuffix;
  if (destSuffix.startsWith('asim_')) destFormat = `asim#${destSuffix.slice('asim_'.length)}`;
  else if (destSuffix.startsWith('cim_')) destFormat = `cim#${destSuffix.slice('cim_'.length)}`;
  else if (destSuffix.startsWith('ocsf_')) destFormat = `ocsf#${destSuffix.slice('ocsf_'.length)}`;
  // NG SIEM no longer has an OCSF class: a legacy `nextgen_<class>` pipeline is `nextgen`.
  else if (destSuffix.startsWith('nextgen_')) destFormat = 'nextgen';
  return { sourcetype: m[1], destFormat };
}
