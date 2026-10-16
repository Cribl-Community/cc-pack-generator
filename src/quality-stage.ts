/**
 * The quality state machine: score a LIVE pipeline, repair it a round at a
 * time, and keep the best configuration that was actually measured.
 *
 * PURE by construction. Scoring, loading the live conf, asking AI for a repair,
 * rolling a conf back and storing a golden all arrive as injected operations
 * (`QualityOperations`), so this module holds only the policy — and the same
 * policy drives every caller: the foreground wizard, the iframe orchestrator
 * and the background Backend Function. There is no AI, no network and no
 * Node/React import here.
 *
 * Why a STATE MACHINE and not a loop: a Backend Function is bounded (120s) and
 * a repair round costs one AI call plus two live previews. So each transition
 * is one durable step — score, propose, re-score, finalize — and the caller
 * persists the `QualityArtifact` between them. A foreground caller simply runs
 * the transitions back to back; a background caller runs one per tick. Neither
 * forks the policy.
 *
 * The invariants it exists to keep:
 *
 * - **Scorecard is read-only, always.** It scores and stops. No AI repair, no
 *   PATCH, no golden store, at any score. (The old foreground mechanism asked
 *   for `qualityThreshold: 101` — a number no pipeline can reach — which every
 *   implementation of "repair when below the threshold" correctly read as
 *   "repair this", so a request to MEASURE a pack rewrote it.)
 * - **Best-score-wins is real.** The conf behind the best measured score is
 *   captured, and a regression is PATCHed back to it — the exact functions, not
 *   merely "leave it alone". Trial scores keep the regression; the DEPLOYMENT
 *   score is the best one.
 * - **A measurement that failed is never a zero** (Hard Rule 32). An unscorable
 *   pipeline ends the row as `error` with NULL scores; a failed repair round
 *   records a `null` trial.
 * - **Nothing here commits or deploys.** Repairs PATCH with deferred deploy; the
 *   caller performs exactly one commit afterwards, and only if something changed.
 */
import { isStageAbortError } from './ai-budget';
import type { AuthoritativeScoreResult } from './pack-builder';
import { rawFidelityIssues } from './raw-fidelity';

/** Below this, a round that improved the score is worth trying again. */
export const QUALITY_RETRY_FLOOR = 70;
/** The most repair rounds one pipeline may cost. */
export const QUALITY_MAX_ROUNDS = 5;
/** Repair below it, store a golden at or above it. */
export const DEFAULT_QUALITY_THRESHOLD = 80;

/**
 * How many rounds a pipeline earns, from its FIRST score alone: a badly broken
 * pipeline is worth grinding on, a nearly-good one gets one attempt.
 * `scripts/repair-core.mjs` re-exports this so the skill runner and the app can
 * never drift onto two retry policies.
 */
export function repairRoundLimit(firstScore: number): number {
  return firstScore < QUALITY_RETRY_FLOOR ? QUALITY_MAX_ROUNDS : 1;
}

/**
 * After a re-score: is another round justified? Three reasons to stop, and each
 * one is a different kind of "no more value here" —
 * the threshold is met, the budget is spent, or the last round taught us that
 * this pipeline is not moving (no improvement, or an improvement that already
 * cleared the retry floor).
 */
export function shouldRunAnotherRound(state: {
  rounds: number;
  firstScore: number;
  bestScore: number;
  improved: boolean;
  threshold: number;
}): boolean {
  if (state.bestScore >= state.threshold) return false;
  if (state.rounds >= repairRoundLimit(state.firstScore)) return false;
  return state.improved && state.bestScore < QUALITY_RETRY_FLOOR;
}

export type QualityAction = 'repair' | 'scorecard';
export type QualityPhase = 'repair-score' | 'repair-round' | 'repair-rescore' | 'repair-finalize';

/** Where a quality row always starts. */
export const FIRST_QUALITY_PHASE: QualityPhase = 'repair-score';

const QUALITY_PHASES: QualityPhase[] = ['repair-score', 'repair-round', 'repair-rescore', 'repair-finalize'];

export function isQualityPhase(phase: unknown): phase is QualityPhase {
  return typeof phase === 'string' && (QUALITY_PHASES as string[]).includes(phase);
}

/** The live pipeline a quality row measures, and the sample it measures it with. */
export interface QualityPipelineRef {
  workerGroup: string;
  packId: string;
  pipelineId: string;
  sourcetype: string;
  destFormat: string;
  /** One sample per sourcetype (Hard Rule 27) — `<sourcetype>_sample.log`. */
  sampleName: string;
  /**
   * The exact pre-flight sample text, when the caller holds one (a background
   * row carries it on its artifact). The score operation uses it as the raw
   * side of value coverage rather than re-reading whatever the pack happens to
   * contain.
   */
  sampleEvents?: string;
  /**
   * Where the sample came from, when the caller knows (batch `sampleTier`, wizard
   * `SourceMode`). Golden evidence needs it (src/golden-evidence.ts); a sample whose
   * provenance nobody knows makes evidence the store refuses.
   */
  sampleTier?: string;
  sourceMode?: string;
}

/** One authoritative measurement of a live pipeline. AI findings are advisory. */
export interface QualityScore {
  /** NULL means UNMEASURED. Never substitute 0 (Hard Rule 32). */
  score: number | null;
  /** A deterministic measurement, as opposed to an AI estimate. */
  real: boolean;
  band?: string;
  scoreSource?: string;
  error?: string;
  report?: unknown;
  findings?: unknown[];
  missingFields?: string[];
  emptyFields?: string[];
  lessons?: string[];
}

/** A pipeline configuration document, opaque to this module. */
export interface QualityConf {
  functions?: unknown[];
  [key: string]: unknown;
}

/**
 * Everything the machine carries between transitions. JSON-safe by
 * construction: a background row persists it into its App KV artifact between
 * every phase, and the browser keeps it in memory.
 */
export interface QualityArtifact {
  action: QualityAction;
  /** The live score before anything was changed. */
  firstScore: number | null;
  /** The best score MEASURED so far — the one that decides deployment. */
  bestScore: number | null;
  /** The most recent score, including a regression. */
  currentScore: number | null;
  /** The exact conf behind `bestScore`, for the rollback. */
  bestConf: QualityConf | null;
  /** Is the LIVE pipeline currently that conf? False between a patch and its verdict. */
  liveIsBest: boolean;
  report: unknown | null;
  findings: unknown[];
  lessons: string[];
  missingFields: string[];
  emptyFields: string[];
  rounds: number;
  /** One entry per round; `null` where the round could not be measured. */
  trialScores: (number | null)[];
  /** A repair PATCHed live config, so the run owes exactly one commit. */
  changed: boolean;
  real: boolean;
  stored: boolean;
  storedValue: number | null;
  error?: string;
  /**
   * The row is being wound DOWN rather than worked on: a hard error, a second
   * timeout or a Stop reached it while a repair candidate was live. Durable on
   * purpose — the rollback it owes has to survive the invocation that failed.
   * Finalize restores the best conf, stores nothing, and ends the row in error.
   */
  recovery?: { reason: string } | null;
}

export function initialQualityArtifact(action: QualityAction): QualityArtifact {
  return {
    action,
    firstScore: null,
    bestScore: null,
    currentScore: null,
    bestConf: null,
    liveIsBest: true,
    report: null,
    findings: [],
    lessons: [],
    missingFields: [],
    emptyFields: [],
    rounds: 0,
    trialScores: [],
    changed: false,
    real: false,
    stored: false,
    storedValue: null,
    recovery: null,
  };
}

/**
 * Does the LIVE pipeline still hold a candidate nobody verified?
 *
 * The one question a caller has to ask before it ends a row, commits, or
 * deploys. It is answered from the durable artifact alone, because the
 * invocation that patched the candidate is usually gone by then.
 */
export function qualityNeedsRollback(artifact: QualityArtifact): boolean {
  return artifact.action === 'repair' && !artifact.liveIsBest && !!artifact.bestConf;
}

/**
 * Mark a row as winding down: whatever happens next must restore the best conf
 * and store nothing. Pure — the restore itself is finalize's job.
 */
export function beginQualityRecovery(artifact: QualityArtifact, reason: string): QualityArtifact {
  return { ...artifact, recovery: { reason }, error: artifact.error || reason };
}

/**
 * Could this phase leave a candidate live if it never reports back?
 *
 * Asked BEFORE a transition runs, by every caller that has to survive the
 * transition not returning: the runner writes the pessimistic answer to KV, the
 * browser keeps it in memory. `repair-finalize` is in the list only when a
 * rollback is already owed — its other write is the golden store, which cannot
 * strand a candidate, and pre-marking a normal finalize would invent one.
 */
export function phaseMayPatchConfig(phase: QualityPhase, artifact: QualityArtifact): boolean {
  if (artifact.action !== 'repair') return false;
  if (phase === 'repair-round' || phase === 'repair-rescore') return true;
  return qualityNeedsRollback(artifact);
}

/**
 * Wrap the operations so the stage's abort signal is checked around every one
 * of them — before, so a stage that is out of invocation starts nothing, and
 * after, so a result that arrived too late cannot be acted on (the deadline
 * routinely fires while a preview or an AI call is in flight).
 *
 * The guard lives here, with the policy, rather than in each operation: the
 * rule is "no side effect after the abort", and an operation added later must
 * inherit it without anybody remembering to.
 */
export function guardQualityOperations(
  ops: QualityOperations,
  assertLive: (where: string) => void,
): QualityOperations {
  const around = async <T>(where: string, run: () => Promise<T>): Promise<T> => {
    assertLive(where);
    const value = await run();
    assertLive(`acting on the result of ${where}`);
    return value;
  };
  return {
    score: ref => around('scoring the live pipeline', () => ops.score(ref)),
    loadConf: ref => around('reading the live pipeline config', () => ops.loadConf(ref)),
    proposeRepair: (ref, input) => around('the AI repair proposal', () => ops.proposeRepair(ref, input)),
    patchConf: (ref, conf) => around('the pipeline PATCH', () => ops.patchConf(ref, conf)),
    saveGolden: (ref, input) => around('the golden store', () => ops.saveGolden(ref, input)),
  };
}

/** The terminal report one quality row produces. */
export interface QualityResult {
  pipelineId: string;
  action: QualityAction;
  flow: 'normal' | 'repair';
  firstScore: number | null;
  finalScore: number | null;
  /** What the pipeline is actually left at — the value to report and log. */
  deploymentScore: number | null;
  trialScores: (number | null)[];
  rounds: number;
  real: boolean;
  stored: boolean;
  storedValue: number | null;
  changed: boolean;
  error?: string;
  report?: unknown;
}

/**
 * The five effects the machine is allowed to have. Everything network-, AI- or
 * Cribl-shaped lives behind one of them.
 */
export interface QualityOperations {
  /** Preview the LIVE pipeline and score its output authoritatively. */
  score(ref: QualityPipelineRef): Promise<QualityScore>;
  /** Read the live pipeline conf — the best-wins baseline. */
  loadConf(ref: QualityPipelineRef): Promise<QualityConf | null>;
  /** ONE AI repair proposal, PATCHed with deferred deploy. Never commits. */
  proposeRepair(ref: QualityPipelineRef, input: {
    findings: unknown[];
    lessons: string[];
    missingFields: string[];
    emptyFields: string[];
  }): Promise<{ ok: boolean; error?: string }>;
  /** PATCH an exact conf back onto the live pipeline. Never commits. */
  patchConf(ref: QualityPipelineRef, conf: QualityConf): Promise<void>;
  /** Store the verified functions as golden knowledge. */
  saveGolden(ref: QualityPipelineRef, input: {
    functions: unknown[];
    score: number;
    report: unknown;
  }): Promise<void>;
}

export interface QualityTransitionResult {
  artifact: QualityArtifact;
  /** NULL = terminal; `result` is then set. */
  nextPhase: QualityPhase | null;
  status: 'running' | 'success' | 'error';
  message: string;
  result?: QualityResult;
}

export interface QualityStageInput {
  ref: QualityPipelineRef;
  artifact: QualityArtifact;
  ops: QualityOperations;
  threshold?: number;
  log?: (message: string) => void;
}

const deploymentScoreOf = (artifact: QualityArtifact): number | null =>
  (artifact.stored && artifact.storedValue != null ? artifact.storedValue : artifact.bestScore);

export function qualityResult(ref: QualityPipelineRef, artifact: QualityArtifact): QualityResult {
  return {
    pipelineId: ref.pipelineId,
    action: artifact.action,
    // A scorecard is always `normal`: it never repaired anything.
    flow: artifact.rounds > 0 ? 'repair' : 'normal',
    firstScore: artifact.firstScore,
    finalScore: artifact.bestScore,
    deploymentScore: deploymentScoreOf(artifact),
    trialScores: artifact.trialScores,
    rounds: artifact.rounds,
    real: artifact.real,
    stored: artifact.stored,
    storedValue: artifact.storedValue,
    changed: artifact.changed,
    ...(artifact.error ? { error: artifact.error } : {}),
    report: artifact.report,
  };
}

/** Fold one measurement into the artifact, without deciding anything. */
function withScore(artifact: QualityArtifact, scored: QualityScore): QualityArtifact {
  return {
    ...artifact,
    report: scored.report ?? artifact.report,
    findings: scored.findings ?? artifact.findings,
    lessons: scored.lessons ?? artifact.lessons,
    missingFields: scored.missingFields ?? artifact.missingFields,
    emptyFields: scored.emptyFields ?? artifact.emptyFields,
  };
}

const unmeasured = (scored: QualityScore): boolean =>
  !!scored.error || scored.score == null || Number.isNaN(scored.score);

/**
 * A measurement that THREW is a measurement that failed — the same thing as one
 * that produced no number, and not a reason to abandon the row mid-repair.
 * Catching it here is what lets `repair-rescore` still roll back to the best
 * conf; letting it propagate would leave an unverified candidate live.
 */
async function measure(ops: QualityOperations, ref: QualityPipelineRef): Promise<QualityScore> {
  try {
    return await ops.score(ref);
  } catch (error) {
    // Except for the one error that is not about the pipeline at all: the stage
    // ran out of invocation. Treating that as "unmeasurable" would burn the
    // row's budget and walk on into work the runner has already written off.
    if (isStageAbortError(error instanceof Error ? error.message : error)) throw error;
    return { score: null, real: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Score the live pipeline and stop. THE read-only operation, used both by the
 * Scorecard action and by the first transition of a Repair.
 *
 * It performs exactly one effect — `ops.score` — and can therefore be handed
 * operations whose write functions throw.
 */
export async function runScorecardStage(input: QualityStageInput): Promise<QualityArtifact> {
  const { ref, ops, log } = input;
  const scored = await measure(ops, ref);
  if (unmeasured(scored)) {
    return {
      ...withScore(input.artifact, scored),
      firstScore: null,
      bestScore: null,
      currentScore: null,
      real: false,
      error: scored.error || 'The pipeline could not be scored — its live preview produced no measurable output.',
    };
  }
  const score = scored.score as number;
  log?.(`Scored ${ref.pipelineId}: ${score}/100${scored.real ? '' : ' (estimate)'}`);
  return {
    ...withScore(input.artifact, scored),
    firstScore: score,
    bestScore: score,
    currentScore: score,
    real: scored.real,
  };
}

/**
 * ONE AI repair proposal, PATCHed with deferred deploy.
 *
 * The round is counted BEFORE the proposal so a proposal that fails still costs
 * its attempt — otherwise a provider that keeps failing loops forever.
 */
export async function runOneRepairRound(input: QualityStageInput): Promise<QualityTransitionResult> {
  const { ref, ops, log } = input;
  let artifact = { ...input.artifact, rounds: input.artifact.rounds + 1 };

  // A previous round patched a candidate and never reached its verdict (its
  // invocation timed out and the row was retried). Repairing ON TOP of an
  // unverified candidate asks the model to fix a pipeline nobody measured, and
  // loses the best conf for good — so put it back first.
  if (qualityNeedsRollback(input.artifact)) {
    log?.(`Restoring the best configuration on ${ref.pipelineId} before retrying the round…`);
    await ops.patchConf(ref, input.artifact.bestConf as QualityConf);
    artifact = { ...artifact, liveIsBest: true };
  }

  log?.(`Repair round ${artifact.rounds} on ${ref.pipelineId} (best ${artifact.bestScore ?? 'n/a'})…`);

  let outcome: { ok: boolean; error?: string; threw?: boolean };
  try {
    outcome = await ops.proposeRepair(ref, {
      findings: artifact.findings,
      lessons: artifact.lessons,
      missingFields: artifact.missingFields,
      emptyFields: artifact.emptyFields,
    });
  } catch (error) {
    // Same exception as `measure`: an aborted stage unwinds, it does not spend
    // a round.
    if (isStageAbortError(error instanceof Error ? error.message : error)) throw error;
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error), threw: true };
  }

  if (!outcome.ok) {
    // A proposal that REPORTED failure wrote nothing, so there is nothing to
    // deploy and nothing to roll back. A proposal that THREW is a different
    // fact: the AI call and the PATCH are one operation, so the PATCH may have
    // landed before whatever went wrong — the live pipeline is then an
    // unverified candidate, and finalize has to put the best conf back.
    return {
      artifact: {
        ...artifact,
        trialScores: [...artifact.trialScores, null],
        ...(outcome.threw ? { liveIsBest: false } : {}),
      },
      nextPhase: 'repair-finalize',
      status: 'running',
      message: `Repair round ${artifact.rounds} produced no change (${outcome.error || 'no functions returned'}).`,
    };
  }

  return {
    // `liveIsBest: false` is the durable record that the live pipeline is now
    // an UNVERIFIED candidate. If this row never reaches its re-score, finalize
    // still restores the best conf.
    artifact: { ...artifact, changed: true, liveIsBest: false },
    nextPhase: 'repair-rescore',
    status: 'running',
    message: `Repair round ${artifact.rounds} patched ${ref.pipelineId} — re-scoring next.`,
  };
}

/**
 * Score the candidate the last round patched in, and either adopt it or put the
 * best conf back.
 */
async function runRepairRescore(input: QualityStageInput): Promise<QualityTransitionResult> {
  const { ref, ops, log } = input;
  const threshold = input.threshold ?? DEFAULT_QUALITY_THRESHOLD;
  const scored = await measure(ops, ref);
  const bestScore = input.artifact.bestScore ?? 0;

  const rollback = async (artifact: QualityArtifact): Promise<QualityArtifact> => {
    if (!artifact.bestConf) return { ...artifact, liveIsBest: true };
    await ops.patchConf(ref, artifact.bestConf);
    return { ...artifact, liveIsBest: true };
  };

  if (unmeasured(scored)) {
    // The candidate could not be measured, so it cannot be shown to be better.
    // Put the best conf back rather than leaving an unproven one live.
    const artifact = await rollback({
      ...input.artifact,
      trialScores: [...input.artifact.trialScores, null],
    });
    return {
      artifact,
      nextPhase: 'repair-finalize',
      status: 'running',
      message: `Round ${artifact.rounds} could not be scored (${scored.error || 'no measurable output'}) — restored the best configuration.`,
    };
  }

  const score = scored.score as number;
  const improved = score > bestScore;
  log?.(`Round ${input.artifact.rounds} → ${score}/100 (best ${bestScore}).`);

  let artifact: QualityArtifact = {
    ...input.artifact,
    currentScore: score,
    trialScores: [...input.artifact.trialScores, score],
  };

  if (improved) {
    artifact = {
      ...withScore(artifact, scored),
      bestScore: score,
      real: scored.real,
      bestConf: (await ops.loadConf(ref)) ?? artifact.bestConf,
      liveIsBest: true,
    };
  } else {
    artifact = await rollback(artifact);
  }

  const another = shouldRunAnotherRound({
    rounds: artifact.rounds,
    firstScore: artifact.firstScore ?? 0,
    bestScore: artifact.bestScore ?? 0,
    improved,
    threshold,
  });
  return {
    artifact,
    nextPhase: another ? 'repair-round' : 'repair-finalize',
    status: 'running',
    message: improved
      ? `Round ${artifact.rounds} improved the score to ${score}/100.`
      : `Round ${artifact.rounds} scored ${score}/100 — keeping the best ${artifact.bestScore}/100.`,
  };
}

/**
 * Leave the pipeline at its best measured configuration, store that knowledge
 * if it earned it, and report.
 */
export async function finalizeRepairStage(input: QualityStageInput): Promise<QualityTransitionResult> {
  const { ref, ops, log } = input;
  const threshold = input.threshold ?? DEFAULT_QUALITY_THRESHOLD;
  let artifact = input.artifact;

  // Best-conf-wins, enforced rather than assumed: a round that patched a
  // candidate and never reached its verdict leaves `liveIsBest: false`.
  if (qualityNeedsRollback(artifact)) {
    await ops.patchConf(ref, artifact.bestConf as QualityConf);
    artifact = { ...artifact, liveIsBest: true, changed: true };
  }

  // A row that is winding down (hard error, second timeout, Stop) came here for
  // the rollback above and nothing else. Its best conf was never re-verified in
  // this run, so it does not get to write knowledge either.
  if (artifact.recovery) {
    const reason = artifact.recovery.reason;
    log?.(`${ref.pipelineId} — restored the best configuration after: ${reason}`);
    const recovered = { ...artifact, error: artifact.error || reason };
    return {
      artifact: recovered,
      nextPhase: null,
      status: 'error',
      message: `${ref.pipelineId} — ${reason}. Restored the best measured configuration.`,
      result: qualityResult(ref, recovered),
    };
  }

  const functions = artifact.bestConf?.functions;
  if (artifact.real && artifact.bestScore != null && artifact.bestScore >= threshold
      && Array.isArray(functions) && functions.length > 0) {
    try {
      await ops.saveGolden(ref, { functions, score: artifact.bestScore, report: artifact.report });
      artifact = { ...artifact, stored: true, storedValue: artifact.bestScore };
      log?.(`Stored ${ref.sourcetype}::${ref.destFormat} to golden (${artifact.bestScore}/100).`);
    } catch (error) {
      // Knowledge is a by-product; a store that fails must not fail the row.
      log?.(`Golden store skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const result = qualityResult(ref, artifact);
  return {
    artifact,
    nextPhase: null,
    status: 'success',
    message: `${ref.pipelineId} — ${result.flow} flow, deployment score ${result.deploymentScore ?? 'unscored'}`
      + `${result.stored ? ` (stored ${result.storedValue})` : ''}.`,
    result,
  };
}

/**
 * One durable transition. The caller persists the returned artifact and, if
 * `nextPhase` is set, calls again with it.
 */
export async function runQualityTransition(input: QualityStageInput & {
  phase: QualityPhase;
  action: QualityAction;
}): Promise<QualityTransitionResult> {
  const { phase, action, ref, ops } = input;
  const threshold = input.threshold ?? DEFAULT_QUALITY_THRESHOLD;
  const stage = { ref, ops, threshold, log: input.log, artifact: input.artifact };

  // The two pieces of state that decide whether anything may be WRITTEN are
  // checked before any operation runs, on every transition — not only on the
  // path a correct caller takes.
  //
  // A phase is durable: it comes back from KV, from a resumed run, from a
  // runner that mis-planned. "A scorecard only ever reaches repair-score" was
  // true of the happy path and therefore not a guarantee, while "a scorecard
  // never writes" has to hold everywhere. And an artifact whose action
  // disagrees with the requested one means one of the two is stale — guessing
  // which could repair a pack somebody asked only to measure.
  const corrupt = (reason: string): QualityTransitionResult => {
    // Refusing to run is not the whole job: whatever wrote this state may have
    // left a candidate live, and ending here would strand it for the run's
    // commit to deploy. A REPAIR is therefore pointed at the one phase that
    // puts the best conf back. A scorecard is not — read-only is read-only,
    // including when the state is wrong, so its caller must block the deploy
    // instead of writing on its behalf.
    if (action === 'repair' && qualityNeedsRollback(input.artifact)) {
      const artifact = input.artifact.recovery
        ? input.artifact
        : beginQualityRecovery(input.artifact, reason);
      return {
        artifact,
        nextPhase: 'repair-finalize',
        status: 'running',
        message: `${reason} Restoring the best measured configuration.`,
      };
    }
    const artifact = { ...input.artifact, error: input.artifact.error || reason };
    return { artifact, nextPhase: null, status: 'error', message: reason, result: qualityResult(ref, artifact) };
  };
  if (input.artifact.action !== action) {
    return corrupt(`This row asks for a ${action} but its saved quality state is a ${input.artifact.action} — nothing was run.`);
  }
  if (action === 'scorecard' && phase !== 'repair-score') {
    return corrupt(`A scorecard is read-only and has no ${phase} step — nothing was run.`);
  }
  // A row that is winding down has exactly one step left. Re-entering it at a
  // working phase (a resumed run, a stale row copy) would start new work on a
  // pipeline the run has already given up on — and lose the rollback it owes.
  if (input.artifact.recovery && phase !== 'repair-finalize') {
    return corrupt(`This ${action} row is winding down (${input.artifact.recovery.reason}) and has no ${phase} step — nothing new was run.`);
  }

  if (phase === 'repair-score') {
    const scored = await runScorecardStage(stage);
    if (scored.error) {
      // Hard Rule 32: unmeasured is an ERROR with null scores, never a zero
      // that reads as "this pipeline extracts nothing".
      return {
        artifact: scored,
        nextPhase: null,
        status: 'error',
        message: scored.error,
        result: qualityResult(ref, scored),
      };
    }
    if (action === 'scorecard') {
      // Terminal, immediately, at ANY score. A scorecard writes nothing.
      return {
        artifact: scored,
        nextPhase: null,
        status: 'success',
        message: `${ref.pipelineId} scored ${scored.bestScore}/100 — read-only, nothing changed.`,
        result: qualityResult(ref, scored),
      };
    }
    // Repair: capture the baseline the rollback restores BEFORE anything is
    // patched. Without it, a regression has nothing to be rolled back to.
    const bestConf = await ops.loadConf(ref);
    const artifact: QualityArtifact = { ...scored, bestConf: bestConf ?? null, liveIsBest: true };
    const belowThreshold = (artifact.bestScore ?? 0) < threshold;
    return {
      artifact,
      nextPhase: belowThreshold ? 'repair-round' : 'repair-finalize',
      status: 'running',
      message: belowThreshold
        ? `Scored ${artifact.bestScore}/100 — below ${threshold}, starting repair.`
        : `Scored ${artifact.bestScore}/100 — at or above ${threshold}, no repair needed.`,
    };
  }

  if (phase === 'repair-round') return runOneRepairRound(stage);
  if (phase === 'repair-rescore') return runRepairRescore(stage);
  return finalizeRepairStage(stage);
}

/** What one uninterrupted drive of a quality row produced. */
export interface QualityDriveResult {
  artifact: QualityArtifact;
  result: QualityResult | null;
  /**
   * The live pipeline may still be holding a candidate nobody verified, and the
   * rollback that would have removed it failed too. NOTHING may be committed or
   * deployed in this state: an un-deployed candidate is recoverable, a deployed
   * one is not.
   */
  unresolved?: { reason: string };
}

/**
 * Drive a quality row from its first phase to a terminal one, in a caller that
 * is NOT bounded by an invocation (the browser).
 *
 * The background runner spreads the same transitions over ticks and persists
 * the artifact between them; this runs them back to back. What it must not do
 * is differ in SAFETY: a transition that throws leaves the live pipeline
 * holding whatever the phase had written by then, so the artifact is marked
 * pessimistically BEFORE each write-capable phase (it is the only record there
 * is here) and the failure is wound down through `repair-finalize`, which puts
 * the exact best conf back.
 */
export async function driveQualityToCompletion(input: {
  ref: QualityPipelineRef;
  ops: QualityOperations;
  action?: QualityAction;
  threshold?: number;
  log?: (message: string) => void;
}): Promise<QualityDriveResult> {
  const { ref, ops, threshold, log } = input;
  const action = input.action ?? 'repair';
  let artifact = initialQualityArtifact(action);
  let phase: QualityPhase | null = FIRST_QUALITY_PHASE;
  let result: QualityResult | null = null;

  while (phase) {
    // What the NEXT step has to assume if this one never answers. The engine
    // itself is still handed the truth, so it does not restore a conf that was
    // never replaced.
    const pessimistic = phaseMayPatchConfig(phase, artifact) && artifact.bestConf
      ? { ...artifact, liveIsBest: false }
      : artifact;
    let transition: QualityTransitionResult;
    try {
      transition = await runQualityTransition({ phase, action, ref, artifact, ops, threshold, log });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return windDownQuality({ ref, ops, action, threshold, log, artifact: pessimistic, reason });
    }
    artifact = transition.artifact;
    result = transition.result ?? null;
    log?.(transition.message);
    phase = transition.nextPhase;
  }
  return { artifact, result };
}

/**
 * Put the best measured configuration back after a failure, and report the
 * failure. Runs the ORDINARY finalize transition (marked as a recovery, so it
 * restores and stores nothing) rather than a second, failure-only code path.
 */
async function windDownQuality(input: {
  ref: QualityPipelineRef;
  ops: QualityOperations;
  action: QualityAction;
  artifact: QualityArtifact;
  reason: string;
  threshold?: number;
  log?: (message: string) => void;
}): Promise<QualityDriveResult> {
  const { ref, ops, action, threshold, log, reason } = input;
  const recovering = beginQualityRecovery(input.artifact, reason);
  log?.(`${ref.pipelineId} — ${reason}. Restoring the best measured configuration…`);
  try {
    const transition = await runQualityTransition({
      phase: 'repair-finalize', action, ref, artifact: recovering, ops, threshold, log,
    });
    return {
      artifact: transition.artifact,
      result: transition.result ?? qualityResult(ref, transition.artifact),
    };
  } catch (error) {
    // Both the work and the undo failed. The live pipeline is whatever the
    // failed phase left there, and the caller has to be told in the one way it
    // cannot ignore.
    const combined = `${reason} — and the best configuration could not be restored: `
      + `${error instanceof Error ? error.message : String(error)}`;
    const artifact = { ...recovering, error: combined };
    return { artifact, result: qualityResult(ref, artifact), unresolved: { reason: combined } };
  }
}

/**
 * Turn an authoritative score into REPAIR GUIDANCE.
 *
 * Every entry is `pointImpact: 0` — advisory by construction. Rule 12 makes
 * value coverage the score; these exist only to tell the repair prompt WHAT to
 * fix, in the order that matters: the caps first (a wrong OCSF class or a
 * malformed CEF header ceilings the score no matter what else is right), then
 * the fields with source data that never arrived, then the individual sample
 * values that were lost, then whatever the AI noticed.
 */
export function repairGuidanceFindings(
  auth: AuthoritativeScoreResult,
  aiFindings: unknown[] = [],
): { severity: string; field: string; issue: string; pointImpact: number }[] {
  const finding = (severity: string, field: string, issue: string) => ({ severity, field, issue, pointImpact: 0 });
  const out: { severity: string; field: string; issue: string; pointImpact: number }[] = [];

  if (auth.ocsf?.applicable && !auth.ocsf.complete) {
    out.push(finding('high', 'class_uid',
      `Output is not a valid OCSF envelope — missing ${auth.ocsf.missing.join(' and ')}. `
      + 'Emit nested OCSF objects (src_endpoint, dst_endpoint, actor.user, device, connection_info/traffic) '
      + 'created parent-first, plus class_uid/category_uid/type_uid/severity_id and metadata.product.'));
  }
  if (auth.ocsfClass?.applicable && !auth.ocsfClass.match) {
    out.push(finding('high', 'class_uid',
      `Output is mapped to the WRONG OCSF class — this source's data maps to ${auth.ocsfClass.expectedClass} `
      + `(class_uid ${auth.ocsfClass.expectedUid}), but the output emits class_uid `
      + `${auth.ocsfClass.emitted.join('/') || '(none)'}. Re-map the events to the ${auth.ocsfClass.expectedClass} class.`));
  }
  if (auth.ocsfSchema?.supported && auth.ocsfSchema.score < 100) {
    out.push(finding('high', 'class_uid',
      auth.ocsfSchema.reasons[0]
      || `Output does not conform to the OCSF ${auth.ocsfSchema.detectedClass || ''} schema.`));
  }
  if (auth.cef?.applicable && auth.cef.validEvents < auth.cef.totalEvents) {
    out.push(finding('high', '_raw',
      `Output is not valid CEF — ${auth.cef.malformed.slice(0, 4).join('; ')}. `
      + 'Emit CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|ext with severity 0–10 and well-formed key=value extension.'));
  }
  if (auth.cef?.unknownKeys.length) {
    out.push(finding('low', '_raw',
      `${auth.cef.unknownKeys.length} CEF extension key(s) are not standard/custom: `
      + `${auth.cef.unknownKeys.slice(0, 8).join(', ')} — map to a CEF dictionary key or a labelled custom field (csN/cnN).`));
  }
  if (auth.schema?.applicable && auth.schema.score < 100) {
    out.push(finding('high', auth.schema.typeViolations[0]?.split(' ')[0] || '_raw',
      auth.schema.reasons[0] || `Output does not conform to ${auth.schema.format.toUpperCase()} (${auth.schema.target}).`));
  }
  // Advisory half (ECS): things Elasticsearch accepts but ECS discourages — likely
  // typos under an ECS namespace, numeric strings, missing ecs.version. Never capped.
  for (const a of (auth.schema?.applicable ? auth.schema.advisories || [] : []).slice(0, 4)) {
    out.push(finding('low', (a.match(/\b[a-z_]+(?:\.[a-z_]+)+\b/) || ['_raw'])[0], a));
  }
  // XSIAM's OWN parsing rule refuses this wire shape, so the tenant either drops
  // the event or stores it unparsed (Hard Rule 34). The fix is always the wire
  // shape, never a field mapping — quote the rule so the model repairs the right
  // thing. Both engines read this from here; the backend used to keep its own copy.
  if (auth.xsiamParse?.applicable && auth.xsiamParse.cap != null) {
    out.push(finding('high', '_raw',
      `${auth.xsiamParse.reasons[0] || `XSIAM dataset ${auth.xsiamParse.dataset} will not parse this output.`} `
      + `${auth.xsiamParse.failures.slice(0, 3).join('; ')}`.trim()));
  }
  // Advisory half: the INPUT's wire format never carried a key the rule reads —
  // usually the wrong sample format for this dataset, which no repair can fix.
  if (auth.xsiamParse?.applicable && auth.xsiamParse.keysAbsentFromInput.length) {
    out.push(finding('medium', auth.xsiamParse.keysAbsentFromInput[0],
      `XSIAM's parsing rule for ${auth.xsiamParse.dataset} reads ${auth.xsiamParse.keysAbsentFromInput.join(', ')}, `
      + "which this sample's wire format does not carry — check the sample is the format this dataset expects."));
  }
  // Google SecOps UDM wire contract: dropped events (bad event_type/event_timestamp)
  // vanish behind a green Test tab; a datatype mismatch 400s the whole batch.
  if (auth.udm?.applicable && auth.udm.cap != null) {
    out.push(finding('high', auth.udm.droppedEvents ? 'metadata' : '_raw',
      `${auth.udm.reasons.join(' ')} ${auth.udm.failures.slice(0, 4).join('; ')}`.trim()));
  }
  if (auth.golden?.supported) {
    for (const field of auth.golden.missing || []) {
      out.push(finding('medium', field, `OCSF field "${field}" is defined for this class but empty in the output`));
    }
  }
  if (auth.scoreSource === 'spec-validation' && auth.spec?.supported) {
    for (const field of auth.spec.missingFields || []) {
      out.push(finding('medium', field, `CIM/spec field "${field}" has source data but is empty in the output`));
    }
  }
  // The fields the spec lens itself reported on, so the model's version of the
  // same complaint is dropped below rather than said twice. They are read off
  // the audit the SCORE was computed from — the backend used to re-run the lens
  // once per AI finding, with its own looser key list.
  const specFields = new Set<string>();
  if (auth.spec?.supported) {
    for (const f of auth.spec.findings || []) {
      specFields.add(f.field);
      out.push({ ...f, pointImpact: 0 });
    }
  }
  for (const issue of rawFidelityIssues(auth.rawFidelity)) out.push(finding('high', '_raw', issue));
  if (auth.scoreSource === 'value-coverage' && auth.coverage?.supported) {
    for (const value of (auth.coverage.lostValues || []).slice(0, 12)) {
      out.push(finding('medium', '_value', `sample value "${value}" was not extracted/mapped into the output`));
    }
  }
  for (const f of aiFindings) {
    const field = (f as { field?: string }).field;
    if (field && specFields.has(field)) continue;
    out.push({ ...(f as Record<string, unknown>), pointImpact: 0 } as typeof out[number]);
  }
  return out;
}
