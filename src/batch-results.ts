/**
 * One flat record per batch row, for the "Download results" export.
 *
 * A batch run is reviewed after the fact: which rows scored low, which sample
 * tier fed them, what wire format that sample really was, and whether the
 * pipeline that shipped runs more parsers than it needs. The on-screen table
 * shows scores; this record joins them with the build trace so the same
 * questions can be answered in a spreadsheet, or handed to an AI with the
 * expert's function-usage feedback.
 *
 * Pure: the caller passes the row result and its trace (when the build got far
 * enough to publish one). Nothing is fetched.
 */
import type { BuildTrace } from './build-trace';
import { functionComposition, functionCompositionTelemetry } from './function-composition';
import { describeSampleFormat } from './sample-format';

type StageName = 'extraction' | 'mapping' | 'optimization';
const STAGES: readonly StageName[] = ['extraction', 'mapping', 'optimization'];

/** The subset of the App's `BatchResult` the record reads. */
export interface BatchResultInput {
  row: {
    sourcetype: string;
    outputSourcetype?: string;
    pack_name: string;
    pipeline_name: string;
    dest_format: string;
    route_name?: string;
    filter?: string;
  };
  status: string;
  message?: string;
  score?: number | null;
  stageScores?: Partial<Record<StageName, number | null>>;
  stageReport?: { stage: string; source: string; score: number | null; reasons: string[] }[];
  sampleTier?: string;
  sampleReason?: string;
  timings?: { prepareMs?: number; buildMs?: number; deployMs?: number; totalMs?: number };
  repairedAfterBuild?: boolean;
}

type Cell = string | number | boolean | null;

/**
 * Column order of the CSV. Kept as one list so the header and every row can
 * never disagree, and so a new column is added in one place.
 */
export const BATCH_RESULT_COLUMNS = [
  'row',
  'sourcetype', 'sourcetype_resolved', 'pack_name', 'pipeline_name',
  'dest_format', 'dest_format_resolved', 'route_name', 'filter',
  'status', 'message',
  'score', 'extraction_score', 'mapping_score', 'optimization_score',
  'extraction_source', 'mapping_source', 'optimization_source',
  'extraction_reasons', 'mapping_reasons', 'optimization_reasons',
  'sample_tier', 'sample_reason', 'sample_name', 'sample_events', 'sample_provided_events',
  'sample_wire', 'sample_wire_label', 'sample_wire_agreement', 'sample_mixed',
  'function_total', 'function_types', 'regex_extract_count', 'serde_count', 'code_count',
  'ungated_extractor_count', 'multi_regex', 'multi_parser', 'repaired_after_build',
  'prepare_ms', 'build_ms', 'deploy_ms', 'total_ms',
  'trace_status', 'trace_error', 'trace_id',
] as const;

export type BatchResultRecord = Record<(typeof BATCH_RESULT_COLUMNS)[number], Cell>;

const REASON_SEPARATOR = ' | ';

/**
 * `index` is the 0-based row position; the record carries it 1-based, matching
 * the "Row N" the batch screen shows.
 */
export function batchResultRecord(result: BatchResultInput, trace: BuildTrace | undefined, index: number): BatchResultRecord {
  const stageOf = (stage: StageName) => {
    const traced = trace?.stages.find(s => s.stage === stage);
    const reported = result.stageReport?.find(s => s.stage === stage);
    const live = result.stageScores?.[stage];
    return {
      score: live !== undefined ? live : (traced?.score ?? reported?.score ?? null),
      source: traced?.source ?? reported?.source ?? null,
      reasons: (traced?.reasons ?? reported?.reasons ?? []).join(REASON_SEPARATOR) || null,
    };
  };
  const [extraction, mapping, optimization] = STAGES.map(stageOf);

  const sampleText = trace?.sample.content ?? '';
  const wire = sampleText.trim() ? describeSampleFormat(sampleText) : null;
  // Only a finished build has final functions; a row that failed mid-build has
  // no pipeline to judge, and an empty count would read as "efficient".
  const composition = trace?.finalFunctions ? functionCompositionTelemetry(functionComposition(trace.finalFunctions)) : null;

  return {
    row: index + 1,
    sourcetype: result.row.outputSourcetype || result.row.sourcetype,
    sourcetype_resolved: trace?.context.sourcetype ?? result.row.sourcetype,
    pack_name: result.row.pack_name,
    pipeline_name: result.row.pipeline_name,
    dest_format: result.row.dest_format,
    dest_format_resolved: trace?.context.destFormat ?? null,
    route_name: result.row.route_name ?? null,
    filter: result.row.filter ?? null,
    status: result.status,
    message: result.message ?? null,
    score: result.score ?? null,
    extraction_score: extraction.score,
    mapping_score: mapping.score,
    optimization_score: optimization.score,
    extraction_source: extraction.source,
    mapping_source: mapping.source,
    optimization_source: optimization.source,
    extraction_reasons: extraction.reasons,
    mapping_reasons: mapping.reasons,
    optimization_reasons: optimization.reasons,
    sample_tier: result.sampleTier ?? trace?.sample.tier ?? null,
    sample_reason: result.sampleReason ?? trace?.sample.reason ?? null,
    sample_name: trace?.sample.name ?? null,
    sample_events: trace ? trace.sample.eventCount : null,
    sample_provided_events: trace?.sample.providedEventCount ?? null,
    sample_wire: wire ? wire.id : null,
    sample_wire_label: wire ? wire.label : null,
    sample_wire_agreement: wire ? Math.round(wire.agreement * 100) : null,
    sample_mixed: wire ? wire.mixed : null,
    function_total: composition?.function_total ?? null,
    function_types: composition?.function_types ?? null,
    regex_extract_count: composition?.regex_extract_count ?? null,
    serde_count: composition?.serde_count ?? null,
    code_count: composition?.code_count ?? null,
    ungated_extractor_count: composition?.ungated_extractor_count ?? null,
    multi_regex: composition?.multi_regex ?? null,
    multi_parser: composition?.multi_parser ?? null,
    // The function_* columns describe the pipeline as BUILT; true here means
    // Improve repaired the live pipeline since, so they may no longer match it.
    repaired_after_build: result.repairedAfterBuild ?? false,
    prepare_ms: result.timings?.prepareMs ?? null,
    build_ms: result.timings?.buildMs ?? null,
    deploy_ms: result.timings?.deployMs ?? null,
    total_ms: result.timings?.totalMs ?? null,
    trace_status: trace?.status ?? null,
    trace_error: trace?.error ?? null,
    trace_id: trace?.traceId ?? null,
  };
}

/** RFC 4180: quote a cell holding a comma, quote or line break; double inner quotes. */
export function csvCell(value: Cell | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function batchResultsCsv(records: readonly BatchResultRecord[]): string {
  const lines = [BATCH_RESULT_COLUMNS.join(',')];
  for (const record of records) lines.push(BATCH_RESULT_COLUMNS.map(column => csvCell(record[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function batchResultsJson(records: readonly BatchResultRecord[], meta: { workerGroup?: string; buildNumber?: number | null; exportedAt: string }): string {
  return `${JSON.stringify({ ...meta, rows: records }, null, 2)}\n`;
}
