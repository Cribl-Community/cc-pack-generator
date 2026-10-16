import type { QualitySettings } from './ai-client';
import type { RepairQualityResult } from './api';

export interface DeployedPipelineRef {
  pipelineId: string;
  destFormat: string;
  sourcetype: string;
  packId: string;
  workerGroup: string;
  sampleName: string;
}

type RepairQualityArgs = Parameters<typeof import('./api').repairQuality>[0];
type PipelineScoreEvent = Parameters<typeof import('./api').logPipelineScore>[0];

export interface QualityFlowContext {
  golden: boolean;
  /** Where the deployed sample came from (wizard SourceMode / batch tier) — golden evidence needs it. */
  sampleTier?: string;
  sourceMode?: string;
  startTime: number;
  log: (message: string) => void;
  repairQuality: (args: RepairQualityArgs) => Promise<RepairQualityResult | null>;
  logScore: (event: PipelineScoreEvent) => void | Promise<void> | Promise<{ ok: boolean; reason?: string }>;
  loadSettings: () => Pick<QualitySettings, 'normalModel' | 'repairModel'>;
  nowSeconds?: () => number;
}

/**
 * May a batch run make its single worker-group commit?
 *
 * The batch deploys everything ONCE at the end, so that commit is shared: if any
 * row left an unverified repair candidate behind (a repair whose rollback also
 * failed), committing would make it live along with all the good packs. It is
 * refused for the whole run — the good packs stay PATCHed and can simply be
 * re-run, while a deployed candidate cannot be un-deployed from here.
 *
 * A run with nothing to commit but something stranded still reports: silence
 * would look like a clean run that had no work to do.
 */
export function resolveBatchCommit(input: { needsCommit: boolean; unresolved: string[] }):
{ commit: boolean; error: string | null } {
  if (input.unresolved.length) {
    return {
      commit: false,
      error: `Commit+deploy REFUSED — ${input.unresolved.length} pipeline(s) may be holding an unverified repair `
        + `candidate: ${input.unresolved.join(', ')}. Nothing was committed, so nothing from this run is live on the `
        + 'worker group. Manual recovery required: inspect those pipelines in Cribl, restore or rebuild them, then '
        + 'deploy the group yourself.',
    };
  }
  return { commit: input.needsCommit, error: null };
}

/**
 * What a batch's Improve (conflict Repair) row owes the run.
 *
 * The row defers its commit (`deferCommit: true`) because a commit is per
 * WORKER GROUP, not per pipeline: a row committing for itself would deploy
 * every other row's work too, including a candidate another row stranded. So
 * the row only reports, and the single guarded commit at the end decides.
 *
 * Only a REPAIR flow touched the configuration — a repair round, or the
 * best-conf write that ends one. A normal flow just scored and a scorecard is
 * read-only, so neither may invent a deployment for a run that has nothing
 * else to ship.
 */
export function resolveConflictRepair(result: Pick<RepairQualityResult, 'flow' | 'unresolved'> | null):
{ unresolved: boolean; needsCommit: boolean } {
  if (result?.unresolved) return { unresolved: true, needsCommit: false };
  return { unresolved: false, needsCommit: result?.flow === 'repair' };
}

// Score the live pipeline, allow repair-core to apply best-wins repair/golden
// behavior, then emit exactly one Lake completion event.
export async function runPostDeployQuality(
  pipeline: DeployedPipelineRef,
  context: QualityFlowContext,
  // NULL = the pipeline was deployed but never measured (Hard Rule 32).
): Promise<number | null> {
  const nowSeconds = context.nowSeconds || (() => Math.floor(Date.now() / 1000));
  context.log(`Scoring ${pipeline.pipelineId} via preview${context.golden ? ' (golden — verifying)' : ''}…`);
  const result = await context.repairQuality({
    workerGroup: pipeline.workerGroup,
    packId: pipeline.packId,
    pipelineId: pipeline.pipelineId,
    sourcetype: pipeline.sourcetype,
    destFormat: pipeline.destFormat,
    sampleName: pipeline.sampleName,
    deferCommit: true,
    sampleTier: context.sampleTier,
    sourceMode: context.sourceMode,
    onProgress: message => context.log(`  ${message}`),
  });

  // An UNRESOLVED rollback is the one outcome that must not return normally.
  //
  // The caller's next statement is its single commit+deploy, and that commit is
  // what would make an unverified candidate LIVE — the one state the app cannot
  // undo. Refusing here is what keeps the candidate merely PATCHed (invisible to
  // the workers) and therefore recoverable by hand. The run is reported first,
  // honestly: an error with NULL scores, never a completion carrying a number
  // for a pipeline nobody can identify (Hard Rule 32).
  if (result?.unresolved) {
    const reason = result.error || 'the best configuration could not be restored';
    context.log(`✗ ${pipeline.pipelineId} — ${reason}.`);
    context.log('  NOT committing: the live pipeline may be holding an unverified repair candidate. '
      + 'Manual recovery required — inspect the pipeline in Cribl and restore or re-deploy it before committing this group.');
    // AWAITED, unlike the best-effort logs below: the throw unwinds this call
    // stack, and a `void` promise in flight is simply abandoned — losing the one
    // event that tells an operator this pipeline needs hands. A log that fails
    // still changes nothing about the refusal.
    try {
      await context.logScore({
        sourcetype: pipeline.sourcetype,
        pack_id: pipeline.packId,
        pipeline_id: pipeline.pipelineId,
        dest_format: pipeline.destFormat,
        score: null,
        sample_name: pipeline.sampleName,
        model_used: context.loadSettings().repairModel,
        tokens_input: 0,
        tokens_output: 0,
        worker_group: pipeline.workerGroup,
        is_golden_path: context.golden,
        generation_mode: 'repair',
        findings_count: 0,
        status: 'error',
        deploy_message: `Not deployed — ${reason}. Manual recovery required.`,
        flow: result.flow,
        trial_scores: result.trialScores,
        first_score: result.startScore,
        final_score: null,
        deployment_score: null,
        stored_value: null,
        start_time: context.startTime,
        end_time: nowSeconds(),
      });
    } catch { /* reporting is best-effort; refusing is not */ }
    throw new Error(`${pipeline.pipelineId}: ${reason}. Nothing was committed — the live pipeline may be holding an `
      + 'unverified repair candidate and needs manual recovery.');
  }


  // Two different ways to end up with no number, and neither is a zero: the
  // flow could not run at all, or it ran and could not measure anything. Both
  // are `skipped` with NULL scores (Hard Rule 32) — a 0 is indistinguishable
  // from a pipeline that genuinely extracts nothing, and `success` counts an
  // unmeasured pipeline in the dashboard's Success %.
  //
  // An ERROR is not one of those ways. A repair that broke and then rolled back
  // successfully leaves the pipeline at a configuration that really was
  // measured; calling that unscored throws away a real measurement, which is
  // Rule 32 in the other direction. It is reported below with its true scores
  // and an honest `error` status.
  const unscored = !result || result.finalScore == null;
  if (unscored) {
    const reason = result?.error || 'live scoring unavailable';
    context.log(`Not scored for ${pipeline.pipelineId} — ${reason}. Logging the deploy only.`);
    void context.logScore({
      sourcetype: pipeline.sourcetype,
      pack_id: pipeline.packId,
      pipeline_id: pipeline.pipelineId,
      dest_format: pipeline.destFormat,
      score: null,
      sample_name: pipeline.sampleName,
      model_used: context.loadSettings().normalModel,
      tokens_input: 0,
      tokens_output: 0,
      worker_group: pipeline.workerGroup,
      is_golden_path: false,
      generation_mode: 'ai',
      findings_count: 0,
      status: 'skipped',
      deploy_message: `Deployed — not scored (${reason})`,
      flow: 'normal',
      trial_scores: [],
      first_score: null,
      final_score: null,
      deployment_score: null,
      stored_value: null,
      start_time: context.startTime,
      end_time: nowSeconds(),
    });
    // The RETURN value is a measurement too: a 0 here is the same lie one layer
    // up, where the caller writes it onto a batch row.
    return null;
  }

  const storedNote = result.stored ? `, stored ${result.storedValue}` : '';
  // The flow measured the pipeline AND failed. Both halves get reported: the
  // score is the configuration the pipeline was actually left at, and the
  // status says the run did not finish the way it meant to.
  const failed = !!result.error;
  const allScores = [result.startScore, ...(result.trialScores || [])];
  const deploymentScore = result.stored && result.storedValue != null
    ? result.storedValue
    : result.finalScore;
  const trialColumns: Record<`score_${number}`, number | null> = {};
  allScores.forEach((score, index) => {
    trialColumns[`score_${index + 1}`] = score;
  });
  const settings = context.loadSettings();

  void context.logScore({
    sourcetype: pipeline.sourcetype,
    pack_id: pipeline.packId,
    pipeline_id: pipeline.pipelineId,
    dest_format: pipeline.destFormat,
    score: deploymentScore,
    sample_name: pipeline.sampleName,
    model_used: result.flow === 'repair' ? settings.repairModel : settings.normalModel,
    tokens_input: 0,
    tokens_output: 0,
    worker_group: pipeline.workerGroup,
    is_golden_path: context.golden,
    generation_mode: result.flow === 'repair' ? 'repair' : (context.golden ? 'golden' : 'ai'),
    findings_count: 0,
    status: failed ? 'error' : (result.flow === 'repair' ? 'repaired' : 'success'),
    deploy_message: failed
      ? `Failed — ${result.error}. Left at deployment score ${deploymentScore}${storedNote}`
      : `Completed — ${result.flow} flow, deployment score ${deploymentScore}${storedNote}`,
    flow: result.flow,
    trial_scores: result.trialScores,
    ...trialColumns,
    first_score: result.startScore,
    final_score: result.finalScore,
    deployment_score: deploymentScore,
    stored_value: result.stored ? result.storedValue : null,
    start_time: context.startTime,
    end_time: nowSeconds(),
  });
  context.log(failed
    ? `⚠ ${pipeline.pipelineId} — ${result.error}. Left at deployment score ${deploymentScore}${storedNote}.`
    : `✓ Completed ${pipeline.pipelineId} — ${result.flow} flow, deployment score ${deploymentScore}${storedNote} on ${pipeline.workerGroup}/${pipeline.packId}.`);
  return deploymentScore;
}
