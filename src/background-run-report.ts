import type { BackgroundRowArtifact } from './background-batch';
import type { ExpStageResult, StagedStageResult } from './staged-build';

/**
 * Reconstruct the foreground's per-stage `ExpStageResult[]` from a background
 * row's persisted build artifact, so the SAME `buildReportFormatVM` that shapes
 * the single-pack scoring report can shape a background row's — no second report
 * builder, no new persisted data.
 *
 * The mapping mirrors the foreground `onStage` handler (App.tsx): it turns each
 * `StagedBuildArtifact` stage into the `debug` bag the report reads. A row may
 * hold only an extraction (it stopped early or was skipped) — every stage is
 * optional and a caller renders whatever is present.
 */
export function stagesFromArtifact(artifact: BackgroundRowArtifact | null | undefined): ExpStageResult[] {
  return artifact?.build ? stagesFromBuild(artifact.build, artifact.sampleEvents) : [];
}

/** The fields of a built stage the report reads — a StagedStageResult or an artifact stage. */
type ReportStageInput = Pick<StagedStageResult, 'score' | 'band' | 'source' | 'reasons' | 'out'>
  & Partial<Pick<StagedStageResult, 'detail' | 'stats' | 'appliedOptimizations'>>;

/**
 * The same reconstruction for a row built in THIS tab: `buildStagedPipeline`
 * returns its stages as `StagedStageResult[]`, the shape the artifact stores.
 * The foreground end screens use it for the whole-run "View scoring report".
 */
export function stagesFromBuilt(built: readonly StagedStageResult[], sampleEvents?: string): ExpStageResult[] {
  const at = (id: StagedStageResult['stage']) => built.find(s => s.stage === id);
  return stagesFromBuild({ extraction: at('extraction'), mapping: at('mapping'), optimization: at('optimization') }, sampleEvents);
}

function stagesFromBuild(
  build: { extraction?: ReportStageInput; mapping?: ReportStageInput; optimization?: ReportStageInput },
  sampleEvents?: string,
): ExpStageResult[] {
  const stages: ExpStageResult[] = [];
  const firstRaw = (sampleEvents || '').trim().split('\n').filter(Boolean)[0];

  const fieldsOf = (ev: unknown): Record<string, any> =>
    ev && typeof ev === 'object' && !Array.isArray(ev)
      ? Object.fromEntries(Object.entries(ev as Record<string, unknown>).filter(([k]) => k !== '_raw'))
      : {};

  const ex = build.extraction;
  if (ex) {
    const out0 = ex.out?.[0];
    stages.push({
      stage: 'extraction',
      status: 'done',
      score: ex.score,
      band: ex.band,
      source: ex.source,
      reasons: ex.reasons || [],
      debug: { outputEvent: out0, sampleRaw: firstRaw, extractedFields: fieldsOf(out0) },
    });
  }

  const mp = build.mapping;
  if (mp) {
    stages.push({
      stage: 'mapping',
      status: mp.score === null ? 'skipped' : 'done',
      score: mp.score,
      band: mp.band,
      source: mp.source,
      reasons: mp.reasons || [],
      debug: {
        outputEvent: mp.out?.[0],
        stats: mp.stats,
        mappings: mp.detail,
        schemaFieldCount: (mp.detail || []).length,
      },
    });
  }

  const op = build.optimization;
  if (op) {
    stages.push({
      stage: 'optimization',
      status: 'done',
      score: op.score,
      band: op.band,
      source: op.source,
      reasons: op.reasons || [],
      debug: { outputEvent: op.out?.[0], stats: op.stats, appliedOptimizations: op.appliedOptimizations },
    });
  }

  return stages;
}

/** One built row of a run in this tab, as the whole-run report needs it. */
export interface ForegroundReportRow {
  packName: string;
  sourcetype: string;
  destFormat: string;
  pipelineId: string;
  stages: ExpStageResult[];
}

/**
 * Rows grouped into report packs in first-seen (CSV) order. A row without
 * stages (failed, skipped, or restored from a checkpoint) is left out.
 */
export function groupForegroundReportRows(rows: readonly ForegroundReportRow[]): { packId: string; sourcetype: string; rows: ForegroundReportRow[] }[] {
  const order: string[] = [];
  const byPack = new Map<string, { packId: string; sourcetype: string; rows: ForegroundReportRow[] }>();
  for (const r of rows) {
    if (r.stages.length === 0) continue;
    const id = r.packName || r.pipelineId || 'pack';
    if (!byPack.has(id)) { order.push(id); byPack.set(id, { packId: id, sourcetype: r.sourcetype, rows: [] }); }
    byPack.get(id)!.rows.push(r);
  }
  return order.map(id => byPack.get(id)!);
}

/** Whether the foreground end screens can offer the whole-run report, and why not. */
export function foregroundReportAvailability(
  rows: readonly ForegroundReportRow[], running: boolean,
  tally: { built?: number; skipped?: number; failed?: number } = {},
): { ok: boolean; reason: string } {
  if (rows.some(r => r.stages.length > 0)) return { ok: true, reason: '' };
  if (running) return { ok: false, reason: 'Available as soon as the first row has built.' };
  // Say WHY there is nothing to score — a run of skips and failures builds no
  // pipeline, and a greyed button with only a tooltip read as broken.
  const parts = [
    tally.skipped ? `${tally.skipped} skipped` : '',
    tally.failed ? `${tally.failed} failed` : '',
  ].filter(Boolean);
  if (!tally.built && parts.length) return { ok: false, reason: `No scoring report: no pipeline was built in this run (${parts.join(', ')}).` };
  return { ok: false, reason: 'No scoring report: the rows of this run were not built in this tab (restored from a checkpoint).' };
}
