/**
 * Serializable, run-mode-neutral build diagnostics.
 *
 * The recorder deliberately owns no storage or transport. A staged build carries
 * the trace in its result/checkpoint; the UI may show or download it. Keeping the
 * trace as plain data also lets Background Functions checkpoint it in App KV.
 */

import { functionComposition } from './function-composition';

export type BuildTraceStage = 'build' | 'sample' | 'recognition' | 'extraction' | 'mapping' | 'optimization' | 'finalize';
export type BuildTraceEventKind = 'info' | 'candidate' | 'decision' | 'score' | 'golden' | 'warning' | 'error';

export interface BuildTraceEvent {
  at: string;
  stage: BuildTraceStage;
  kind: BuildTraceEventKind;
  message: string;
  detail?: unknown;
}

export interface BuildTraceStageResult {
  stage: 'extraction' | 'mapping' | 'optimization';
  source: string;
  score: number | null;
  band: string;
  reasons: string[];
  stats?: unknown;
  outputPreview: unknown[];
  recordedAt: string;
}

export interface BuildTrace {
  schemaVersion: 1;
  traceId: string;
  status: 'running' | 'complete' | 'error';
  startedAt: string;
  finishedAt?: string;
  buildNumber: number | null;
  context: {
    sourcetype: string;
    requestedDestFormat: string;
    destFormat: string;
    workerGroup: string;
    packId: string;
    pipelineId: string;
    origin: string;
    mode: string;
  };
  sample: {
    name: string;
    tier?: string;
    reason?: string;
    sourceMode?: string;
    sanitised?: boolean;
    eventCount: number;
    providedEventCount?: number;
    bytes: number;
    fingerprint?: unknown;
    content: string;
  };
  recognition?: unknown;
  stages: BuildTraceStageResult[];
  events: BuildTraceEvent[];
  finalFunctions?: unknown[];
  error?: string;
}

export interface BuildTraceInit {
  sourcetype: string;
  requestedDestFormat: string;
  destFormat?: string;
  workerGroup: string;
  packId: string;
  pipelineId: string;
  origin: string;
  mode: string;
  sampleName: string;
  sampleEvents: string;
  sampleProvidedEventCount?: number;
  sampleTier?: string;
  sampleReason?: string;
  sampleSourceMode?: string;
  sampleSanitised?: boolean;
  sampleFingerprint?: unknown;
  recognition?: unknown;
}

export interface TraceableStageResult {
  stage: 'extraction' | 'mapping' | 'optimization';
  source: string;
  score: number | null;
  band: string;
  reasons: string[];
  out?: unknown[];
  stats?: unknown;
}

const clone = <T>(value: T): T => {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
};

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Stages whose sub-part THIS build stored as a golden. Read from the
 * `[<stage>] stored as golden …` line staged-build logs only after a successful
 * saveGoldenPart — a replayed golden or a below-threshold stage logs no such line,
 * so the results screen can say what was really stored instead of assuming it.
 */
export function storedGoldenStages(trace: Pick<BuildTrace, 'events'>): BuildTraceStage[] {
  const stages: BuildTraceStage[] = [];
  for (const e of trace.events || []) {
    const m = e.message.match(/^\[(extraction|mapping|optimization)\] stored as golden\b/);
    if (m && !stages.includes(m[1] as BuildTraceStage)) stages.push(m[1] as BuildTraceStage);
  }
  return stages;
}

/** One results-screen sentence on what the build(s) stored as golden ('' with no traces). */
export function describeStoredGoldens(traces: Pick<BuildTrace, 'events' | 'context'>[]): string {
  if (!traces.length) return '';
  const stored = traces
    .map(t => ({ pipelineId: t.context.pipelineId, stages: storedGoldenStages(t) }))
    .filter(t => t.stages.length);
  if (!stored.length) {
    return 'No new golden sub-parts were stored: every stage either replayed an existing golden or scored below its threshold.';
  }
  const parts = stored.map(t => traces.length > 1 ? `${t.stages.join(' + ')} (${t.pipelineId})` : t.stages.join(' + '));
  return `Stored as new golden sub-parts: ${parts.join('; ')}.`;
}

function stageFromMessage(message: string): BuildTraceStage {
  const match = message.match(/^\[(extraction|mapping|optimization|schematizer)\]/);
  if (!match) return 'build';
  return match[1] === 'schematizer' ? 'mapping' : match[1] as BuildTraceStage;
}

function kindFromMessage(message: string): BuildTraceEventKind {
  const lower = message.toLowerCase();
  if (lower.includes('failed') || lower.includes('✗') || lower.includes('error')) return 'error';
  if (lower.includes('⚠') || lower.includes('warning')) return 'warning';
  if (lower.includes('trying ') || lower.includes('delegating ')) return 'candidate';
  if (lower.includes('score ')) return 'score';
  if (lower.includes('golden') || lower.includes('stored') || lower.includes('shared')) return 'golden';
  if (lower.includes('skipping ') || lower.includes('rejected') || lower.includes('accepted') || lower.includes('reused ')) return 'decision';
  return 'info';
}

export class TraceRecorder {
  private trace: BuildTrace;
  private readonly now: () => Date;

  constructor(init: BuildTraceInit, existing?: BuildTrace, now: () => Date = () => new Date()) {
    this.now = now;
    if (existing) {
      this.trace = clone(existing);
      this.trace.status = 'running';
      this.trace.finishedAt = undefined;
      return;
    }
    const startedAt = this.now().toISOString();
    const events = init.sampleEvents.trim().split('\n').filter(Boolean);
    this.trace = {
      schemaVersion: 1,
      traceId: `${init.packId}/${init.pipelineId}/${startedAt}`,
      status: 'running',
      startedAt,
      buildNumber: typeof BUILD_NUMBER === 'number' ? BUILD_NUMBER : null,
      context: {
        sourcetype: init.sourcetype,
        requestedDestFormat: init.requestedDestFormat,
        destFormat: init.destFormat ?? init.requestedDestFormat,
        workerGroup: init.workerGroup,
        packId: init.packId,
        pipelineId: init.pipelineId,
        origin: init.origin,
        mode: init.mode,
      },
      sample: {
        name: init.sampleName,
        tier: init.sampleTier,
        reason: init.sampleReason,
        sourceMode: init.sampleSourceMode,
        sanitised: init.sampleSanitised,
        eventCount: events.length,
        providedEventCount: init.sampleProvidedEventCount,
        bytes: byteLength(init.sampleEvents),
        fingerprint: clone(init.sampleFingerprint),
        content: init.sampleEvents,
      },
      recognition: clone(init.recognition),
      stages: [],
      events: [],
    };
    const provided = init.sampleProvidedEventCount ?? events.length;
    this.event('sample', 'info', `Using ${events.length}${provided > events.length ? ` of ${provided}` : ''} sample event${provided === 1 ? '' : 's'} from ${init.sampleName}.`, {
      tier: init.sampleTier,
      reason: init.sampleReason,
      sourceMode: init.sampleSourceMode,
      sanitised: init.sampleSanitised,
    });
  }

  setDestination(destFormat: string): void {
    const requested = this.trace.context.requestedDestFormat;
    this.trace.context.destFormat = destFormat;
    this.event('recognition', 'decision',
      requested === destFormat
        ? `Destination format resolved as ${destFormat}.`
        : `Destination format concretized from ${requested} to ${destFormat}.`);
  }

  event(stage: BuildTraceStage, kind: BuildTraceEventKind, message: string, detail?: unknown): void {
    this.trace.events.push({
      at: this.now().toISOString(),
      stage,
      kind,
      message,
      ...(detail === undefined ? {} : { detail: clone(detail) }),
    });
  }

  log(message: string): void {
    this.event(stageFromMessage(message), kindFromMessage(message), message);
  }

  recordStage(result: TraceableStageResult): void {
    const stage: BuildTraceStageResult = {
      stage: result.stage,
      source: result.source,
      score: result.score,
      band: result.band,
      reasons: clone(result.reasons),
      stats: clone(result.stats),
      outputPreview: clone((result.out ?? []).slice(0, 3)),
      recordedAt: this.now().toISOString(),
    };
    const index = this.trace.stages.findIndex(entry => entry.stage === stage.stage);
    if (index >= 0) this.trace.stages[index] = stage;
    else this.trace.stages.push(stage);
    this.event(stage.stage, 'score', `${stage.stage} selected ${stage.source}; score ${stage.score ?? 'N/A'} (${stage.band}).`);
  }

  complete(finalFunctions: unknown[]): void {
    this.trace.status = 'complete';
    this.trace.finishedAt = this.now().toISOString();
    this.trace.finalFunctions = clone(finalFunctions);
    this.event('finalize', 'info', `Build completed with ${finalFunctions.length} pipeline functions.`);
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.trace.status = 'error';
    this.trace.finishedAt = this.now().toISOString();
    this.trace.error = message;
    this.event('finalize', 'error', message);
  }

  snapshot(): BuildTrace {
    return clone(this.trace);
  }
}

export function buildTraceJson(trace: BuildTrace | BuildTrace[]): string {
  return `${JSON.stringify(trace, null, 2)}\n`;
}

const TRACE_SUMMARY_MAX_EVENTS = 60;
const TRACE_SUMMARY_MAX_MESSAGE_LEN = 220;
const TRACE_SUMMARY_SAMPLE_PREVIEW_LINES = 4;

function summarizeFunctionCounts(fns: unknown[] | undefined): string {
  if (!fns || fns.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const fn of fns) {
    const id = (fn && typeof fn === 'object' && 'id' in fn) ? String((fn as { id?: unknown }).id) : 'unknown';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return `${fns.length} total — ${[...counts.entries()].map(([id, n]) => `${id} x${n}`).join(', ')}`;
}

// The efficiency facts an expert reviewer checks first — more than one Parser or
// regex_extract, and extractors that run on every event. Stated outright so the
// model does not have to infer them from the counts.
function summarizeFunctionEfficiency(fns: unknown[] | undefined): string | null {
  if (!fns || fns.length === 0) return null;
  const c = functionComposition(fns);
  const flags: string[] = [];
  if (c.multiParser) flags.push(`${c.serde} Parser (serde) functions`);
  if (c.multiRegex) flags.push(`${c.regexExtract} regex_extract functions`);
  if (c.code > 0) flags.push(`${c.code} code function${c.code === 1 ? '' : 's'}`);
  if (c.ungatedExtractors > 1) flags.push(`${c.ungatedExtractors} extractors with no filter (each runs on every event)`);
  return flags.length ? flags.join('; ') : 'no duplicate parsers or extractors';
}

// Condenses one trace into plain text sized for an AI prompt. Full traces carry
// entire sample bodies, per-candidate output previews and complete function
// configs — fine for a human reading the JSON download, too large (and too
// noisy) to hand to a model that only needs to reason about WHY quality is
// low. Only counts/ids survive for the final functions; everything else is
// truncated rather than dropped, so the model still sees the real shape.
function summarizeOneTrace(trace: BuildTrace): string {
  const lines: string[] = [];
  lines.push(`Pipeline: ${trace.context.pipelineId}  (status: ${trace.status})`);
  lines.push(`Source: ${trace.context.sourcetype} -> Destination: ${trace.context.destFormat}${trace.context.requestedDestFormat !== trace.context.destFormat ? ` (requested: ${trace.context.requestedDestFormat})` : ''}`);
  lines.push(`Worker group: ${trace.context.workerGroup}  Pack: ${trace.context.packId}  Origin: ${trace.context.origin}  Mode: ${trace.context.mode}`);
  lines.push(`Sample: ${trace.sample.name} (${trace.sample.eventCount} event${trace.sample.eventCount === 1 ? '' : 's'}${trace.sample.tier ? `, tier=${trace.sample.tier}` : ''}${trace.sample.reason ? `, reason=${trace.sample.reason}` : ''}${trace.sample.sanitised ? ', sanitised' : ''})`);
  const previewLines = trace.sample.content.trim().split('\n').filter(Boolean).slice(0, TRACE_SUMMARY_SAMPLE_PREVIEW_LINES);
  if (previewLines.length > 0) {
    lines.push('Sample preview:');
    for (const l of previewLines) lines.push(`  ${l.slice(0, TRACE_SUMMARY_MAX_MESSAGE_LEN)}`);
  }
  if (trace.stages.length > 0) {
    lines.push('Stages:');
    for (const s of trace.stages) {
      lines.push(`  - ${s.stage}: source=${s.source} score=${s.score ?? 'N/A'} band=${s.band}${s.reasons.length ? ` reasons=[${s.reasons.join('; ')}]` : ''}`);
    }
  }
  const events = trace.events.slice(-TRACE_SUMMARY_MAX_EVENTS);
  if (events.length > 0) {
    lines.push(`Key events (last ${events.length}${trace.events.length > events.length ? ` of ${trace.events.length}` : ''}):`);
    for (const e of events) lines.push(`  [${e.stage}/${e.kind}] ${e.message.slice(0, TRACE_SUMMARY_MAX_MESSAGE_LEN)}`);
  }
  lines.push(`Final pipeline functions: ${summarizeFunctionCounts(trace.finalFunctions)}`);
  const efficiency = summarizeFunctionEfficiency(trace.finalFunctions);
  if (efficiency) lines.push(`Function efficiency: ${efficiency}`);
  if (trace.error) lines.push(`Error: ${trace.error}`);
  return lines.join('\n');
}

export function summarizeBuildTraceForAi(trace: BuildTrace | BuildTrace[]): string {
  const traces = Array.isArray(trace) ? trace : [trace];
  return traces.map(summarizeOneTrace).join('\n\n=====\n\n');
}
