/**
 * The background run, projected for an operator.
 *
 * A background batch is ONE durable document that a Backend Function rewrites
 * on every stage, read back by a browser that may have been closed for an hour.
 * So the screen is a projection of that document and nothing else — no local
 * cache, no derived counters kept alongside it, nothing that can disagree with
 * KV. This module is that projection: pure, clock-injected, no React, no
 * network, no App APIs, so every decision below is a value a test can hold.
 *
 * Two rules run through all of it, both Hard Rule 32:
 *   1. A read that failed must never look like a result — "could not ask" is
 *      its own state, distinct from "still running" and from "finished".
 *   2. A score that was never measured is NULL and reads `N/A`. A zero is a
 *      real measurement (every event dropped) and must survive as one.
 */
import type {
  BackgroundBatchCheckpoint,
  BackgroundBatchRow,
  BackgroundConflictAction,
  BackgroundPhase,
  BackgroundRowArtifact,
} from './background-batch';
import {
  backgroundRunPresentation,
  orderedBackgroundRows,
  reconcileBackgroundPoll,
  type BackgroundPollOutcome,
} from './background-batch-runtime';

/** The manifest is gone, and something was there a moment ago. */
export const BACKGROUND_RUN_MISSING =
  'This run is no longer recorded on Cribl — it cannot be read or resumed. '
  + 'Dismiss it to clear the run and start another.';

/** The durable cleanup a Dismiss asks for did not happen. */
export const BACKGROUND_DISMISS_FAILED =
  'This run is still recorded on Cribl — the cleanup did not complete, so it has been left on screen. '
  + 'Try Dismiss again in a moment.';

/** The manifest arrived and cannot be used, and asking again will not change that. */
export const BACKGROUND_RUN_UNREADABLE =
  'This run cannot be read, and repeating the read will not change that. '
  + 'It can no longer be followed or stopped from here — clean it up to release the run and start another.';

export type BackgroundReadStatus =
  /** The manifest was read. */
  | 'ok'
  /** The read threw transiently; the last good manifest is still on screen. */
  | 'unavailable'
  /**
   * The read threw for a reason repeating it cannot fix — a corrupt document,
   * a refused request. The run can never be followed or stopped again, so
   * cleanup is the only move left.
   */
  | 'unreadable'
  /** The read succeeded and found nothing, after a run that was there. */
  | 'missing'
  /** Nothing known, nothing found — the ordinary "no run exists". */
  | 'none';

export interface BackgroundReadState {
  status: BackgroundReadStatus;
  message: string;
  /**
   * The run the failed read was about, when the checkpoint cannot say. A
   * corrupt manifest found at mount leaves no checkpoint at all, and cleanup
   * still has to know what to delete.
   */
  runId?: string;
}

export const BACKGROUND_READ_OK: BackgroundReadState = { status: 'ok', message: '' };

/**
 * Fold one mount / poll / Stop-reload result into the checkpoint to show and a
 * NAMED read state.
 *
 * Retention is delegated to `reconcileBackgroundPoll` so there is exactly one
 * implementation of "keep the last good manifest" — the screen and the poll
 * disagreeing about that is how a run that is still ticking gets reported as
 * gone. What this adds is the distinction that reconciliation flattened into a
 * string, in three parts:
 *   - a read that threw TRANSIENTLY may well succeed on the next tick, so the
 *     run stays as it was and keeps Stop;
 *   - a read that threw PERMANENTLY (corruption, a refusal) will fail the same
 *     way forever, so the run can never be followed or stopped again and
 *     cleanup is all that is left;
 *   - a read that SUCCEEDED and found nothing means the document is gone.
 * The permanent flag is opt-in: every caller that does not classify its error
 * gets the transient reading, which is the one that offers no delete.
 */
export function foldBackgroundRead(
  previous: BackgroundBatchCheckpoint | null,
  outcome: BackgroundPollOutcome,
): { checkpoint: BackgroundBatchCheckpoint | null; read: BackgroundReadState } {
  const { checkpoint } = reconcileBackgroundPoll(previous, outcome);
  if (!outcome.ok) {
    if (outcome.permanent) {
      return {
        checkpoint,
        read: {
          status: 'unreadable',
          message: `${BACKGROUND_RUN_UNREADABLE} (${outcome.error})`,
          ...(outcome.runId ? { runId: outcome.runId } : {}),
        },
      };
    }
    return {
      checkpoint,
      read: {
        status: 'unavailable',
        message: `The background run could not be read just now: ${outcome.error}`,
        ...(outcome.runId ? { runId: outcome.runId } : {}),
      },
    };
  }
  if (outcome.checkpoint) return { checkpoint, read: BACKGROUND_READ_OK };
  if (previous) return { checkpoint, read: { status: 'missing', message: BACKGROUND_RUN_MISSING } };
  return { checkpoint, read: { status: 'none', message: '' } };
}

/** An unmeasured score is `N/A`; a measured zero is a zero (Hard Rule 32). */
export function formatScore(value: number | null | undefined): string {
  return value == null ? 'N/A' : String(value);
}

// --- phases ------------------------------------------------------------------

/**
 * Every durable phase, in the operator's words. The phase names are the
 * runner's vocabulary; printing them raw asks the reader to learn a state
 * machine to find out what their batch is doing.
 */
const PHASE_LABELS: Record<BackgroundPhase, string> = {
  queued: 'Queued',
  sample: 'Sample created and verified',
  extraction: 'Extracting fields',
  mapping: 'Mapping to the destination schema',
  optimization: 'Optimizing',
  finalize: 'Publishing',
  'repair-score': 'Scoring the live pipeline',
  'repair-round': 'Proposing a repair',
  'repair-rescore': 'Re-scoring the repair',
  'repair-finalize': 'Restoring the best configuration',
  success: 'Done',
  error: 'Failed',
  skipped: 'Skipped',
};

const ACTION_LABELS: Record<BackgroundConflictAction, string> = {
  overwrite: 'Build',
  skip: 'Skip',
  repair: 'Repair',
  scorecard: 'Scorecard (read-only)',
};

const TERMINAL_PHASES = new Set<BackgroundPhase>(['success', 'error', 'skipped']);

export type BackgroundRowState = 'queued' | 'running' | 'success' | 'error' | 'skipped';

function rowState(phase: BackgroundPhase): BackgroundRowState {
  if (phase === 'success' || phase === 'error' || phase === 'skipped') return phase;
  return phase === 'queued' ? 'queued' : 'running';
}

// --- the stage rail ----------------------------------------------------------

export type RailStepState = 'done' | 'active' | 'failed' | 'pending' | 'skipped';

export interface BackgroundRailStep {
  key: string;
  label: string;
  state: RailStepState;
}

interface RailSpec {
  key: string;
  label: string;
  /** The phase that IS this step, when one is. */
  phase?: BackgroundPhase;
  /** Durable proof this step finished, for a row whose phase is now `error`. */
  done: (row: BackgroundBatchRow) => boolean;
  /**
   * Already satisfied before the runner touches the row, so it reads as done
   * on a row that is still queued. Declared per step rather than recognised by
   * which rail array this is: the reason is a property of the STEP (the sample
   * was resolved in the foreground pre-flight), and an identity check silently
   * stops being true the moment another rail gains a pre-satisfied step. Per
   * ROW too: a `needsSample` row's sample is still to be created.
   */
  preStarted?: (row: BackgroundBatchRow) => boolean;
}

const BUILD_RAIL: RailSpec[] = [
  // Resolved in the foreground pre-flight for most rows; a `needsSample` row
  // creates it as its first background stage, and only then is it done.
  {
    key: 'sample',
    label: 'Sample ready',
    phase: 'sample',
    done: r => !r.needsSample || !!r.sampleCreated,
    preStarted: r => !r.needsSample,
  },
  { key: 'extraction', label: 'Extract', phase: 'extraction', done: r => r.scores?.extraction != null },
  { key: 'mapping', label: 'Map', phase: 'mapping', done: r => r.scores?.mapping != null },
  { key: 'optimization', label: 'Shape output', phase: 'optimization', done: r => r.scores?.optimization != null },
  { key: 'publish', label: 'Publish', phase: 'finalize', done: () => false },
];

const REPAIR_RAIL: RailSpec[] = [
  { key: 'repair-score', label: 'Score', phase: 'repair-score', done: r => r.quality?.firstScore != null },
  { key: 'repair-round', label: 'Repair', phase: 'repair-round', done: r => (r.quality?.rounds ?? 0) > 0 },
  { key: 'repair-rescore', label: 'Re-score', phase: 'repair-rescore', done: r => (r.quality?.trialScores?.length ?? 0) > 0 },
  { key: 'repair-finalize', label: 'Finalize', phase: 'repair-finalize', done: () => false },
];

const SCORECARD_RAIL: RailSpec[] = [
  // A Scorecard measures and stops. Offering it a repair rail would advertise
  // writes the action is not allowed to make.
  { key: 'repair-score', label: 'Score', phase: 'repair-score', done: r => r.quality?.firstScore != null },
];

function railSpecFor(row: BackgroundBatchRow): RailSpec[] {
  if (row.action === 'scorecard') return SCORECARD_RAIL;
  if (row.action === 'repair') return REPAIR_RAIL;
  return BUILD_RAIL;
}

/**
 * The rail for one row.
 *
 * A failed row is the interesting case: `phase` has become `error`, so it no
 * longer says WHERE the row stopped. The stage scores and the quality block do,
 * and they are durable — so the rail is built from what the row actually
 * recorded rather than from a guess, and "it got through mapping and died in
 * optimization" is readable at a glance.
 */
function buildRail(row: BackgroundBatchRow): BackgroundRailStep[] {
  const spec = railSpecFor(row);
  const render = (state: (s: RailSpec, i: number) => RailStepState): BackgroundRailStep[] =>
    spec.map((s, i) => ({ key: s.key, label: s.label, state: state(s, i) }));

  if (row.phase === 'skipped') return render(() => 'skipped');
  if (row.phase === 'success') return render(() => 'done');
  if (row.phase === 'error') {
    const firstUnfinished = spec.findIndex(s => !s.done(row));
    return render((_s, i) => (i < firstUnfinished || firstUnfinished < 0 ? 'done' : i === firstUnfinished ? 'failed' : 'pending'));
  }
  if (row.phase === 'queued') {
    // Queued means whatever the pre-flight already did is in place and a tick
    // has not picked the row up.
    return render(s => (s.preStarted?.(row) ? 'done' : 'pending'));
  }
  const activeIdx = spec.findIndex(s => s.phase === row.phase);
  return render((_s, i) => (activeIdx < 0 ? 'pending' : i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending'));
}

/**
 * 1-based position of the step the row is at — the active one, else how far it got.
 *
 * Read out as "Stage N of M", so a row that has work ahead of it is at least at
 * stage 1: a queued repair row has nothing done yet, and the raw count of
 * finished steps announced a perfectly healthy row as being at a stage that
 * does not exist. Only a skipped row is at no stage at all, and it renders an
 * outcome rather than a rail.
 */
function railPositionOf(rail: BackgroundRailStep[], terminal: boolean): number {
  const active = rail.findIndex(s => s.state === 'active' || s.state === 'failed');
  if (active >= 0) return active + 1;
  const done = rail.filter(s => s.state === 'done').length;
  return terminal ? done : Math.max(1, done);
}

// --- rows --------------------------------------------------------------------

export interface BackgroundRowScores {
  extraction: number | null;
  mapping: number | null;
  optimization: number | null;
  /** The STORED `(extraction + mapping) / 2`. Never re-derived here. */
  overall: number | null;
}

export interface BackgroundRowQualityView {
  action: 'repair' | 'scorecard';
  flow: 'normal' | 'repair';
  firstScore: number | null;
  finalScore: number | null;
  deploymentScore: number | null;
  trialScores: (number | null)[];
  rounds: number;
  stored: boolean;
  storedValue: number | null;
  changed: boolean;
  /** Why the row ended badly, when it did. */
  error: string;
}

export interface BackgroundRowView {
  rowId: string;
  /**
   * The run-scoped artifact key holding this row's unbounded detail — the
   * scorecard fetch target. On the manifest so the UI never has to reconstruct
   * a key the runner owns.
   */
  artifactKey: string;
  /** 1-based, over the whole ordered ledger — never restarts per group. */
  position: number;
  group: BackgroundBatchRow['resultGroup'];
  packName: string;
  pipelineId: string;
  sourcetype: string;
  /** The source as the CSV named it (`cisco:ftd`) — `sourcetype` is the
   *  canonical parser key, which several sources share (FTD → cisco_asa). */
  declaredSourcetype: string;
  destFormat: string;
  action: BackgroundConflictAction;
  actionLabel: string;
  phase: BackgroundPhase;
  phaseLabel: string;
  state: BackgroundRowState;
  terminal: boolean;
  rail: BackgroundRailStep[];
  railPosition: number;
  railTotal: number;
  attempt: number;
  attemptLabel: string;
  message: string;
  scores: BackgroundRowScores;
  quality: BackgroundRowQualityView | null;
}

/**
 * A group this build does not know about.
 *
 * The manifest is durable and outlives the build that wrote it, so a run
 * started by a later version can be read by this one. Filtering an unrecognised
 * group out while still counting its rows made the report contradict itself —
 * a ledger of four rows totalling five, about work somebody's packs depend on.
 */
export const BACKGROUND_OTHER_GROUP = 'other';

export type BackgroundRowGroupId = BackgroundBatchRow['resultGroup'] | typeof BACKGROUND_OTHER_GROUP;

export interface BackgroundRowGroupView {
  id: BackgroundRowGroupId;
  title: string;
  description: string;
  rows: BackgroundRowView[];
}

const GROUP_TITLES: Record<BackgroundRowGroupId, { title: string; description: string }> = {
  build: { title: 'Builds and skips', description: 'Rows that generate pack configuration, in CSV order.' },
  quality: {
    title: 'Repair and scorecard',
    description: 'Rows that inspect a live pipeline. They run after every build row is finished and deployed.',
  },
  other: {
    title: 'Other rows',
    description:
      'Rows this version of the app does not recognise — they were recorded by a newer one. '
      + 'They are listed so the report accounts for every row in the run.',
  },
};

/**
 * Which group a row is REPORTED under, which is not always the one it names —
 * the value comes off a durable document a newer build may have written.
 */
function groupIdOf(row: BackgroundBatchRow): BackgroundRowGroupId {
  const named: string = row.resultGroup;
  return named === 'build' || named === 'quality' ? named : BACKGROUND_OTHER_GROUP;
}

function attemptLabelFor(attempt: number): string {
  if (attempt <= 0) return '';
  return attempt === 1 ? 'retried once' : `retried ${attempt} times`;
}

function scoresOf(row: BackgroundBatchRow): BackgroundRowScores {
  const s = row.scores;
  return {
    extraction: s?.extraction ?? null,
    mapping: s?.mapping ?? null,
    optimization: s?.optimization ?? null,
    overall: s?.overall ?? null,
  };
}

function qualityOf(row: BackgroundBatchRow): BackgroundRowQualityView | null {
  if (!row.quality) return null;
  return {
    ...row.quality,
    firstScore: row.quality.firstScore ?? null,
    finalScore: row.quality.finalScore ?? null,
    deploymentScore: row.quality.deploymentScore ?? null,
    storedValue: row.quality.storedValue ?? null,
    trialScores: row.quality.trialScores ?? [],
    error: row.phase === 'error' ? (row.message || 'This row ended in an error.') : '',
  };
}

// --- the per-row scorecard (fetched on expand, projected here) ---------------

/** One AI/validation finding, normalized from the artifact's opaque shape. */
export interface BackgroundScorecardFinding {
  severity: string;
  field: string;
  issue: string;
}

/** Why one build stage scored what it did — the reasons the card shows. */
export interface BackgroundScorecardStage {
  key: 'extraction' | 'mapping' | 'optimization';
  label: string;
  score: number | null;
  band: string;
  reasons: string[];
}

export interface BackgroundRowScorecard {
  /** Per-stage "why this score", from the build artifact (build rows). */
  stages: BackgroundScorecardStage[];
  /** Validation findings, from the quality artifact (repair/scorecard rows). */
  findings: BackgroundScorecardFinding[];
  missingFields: string[];
  emptyFields: string[];
  /**
   * Loaded, but there is nothing to show yet — a still-running row whose first
   * stage has not checkpointed. Distinct from a fetch that could not read.
   */
  empty: boolean;
}

const SCORECARD_STAGE_LABELS: Record<BackgroundScorecardStage['key'], string> = {
  extraction: 'Extract',
  mapping: 'Map',
  optimization: 'Shape output',
};

/** A finding is stored opaque; keep only the three fields the card renders. */
function toScorecardFinding(raw: unknown): BackgroundScorecardFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const field = str(o.field ?? o.name);
  const issue = str(o.issue ?? o.message ?? o.detail);
  if (!field && !issue) return null;
  return { severity: str(o.severity) || 'info', field, issue };
}

/**
 * Project a loaded row artifact into the scorecard the UI renders.
 *
 * Pure, like the rest of this module: the fetch and the React live in App.tsx,
 * the shaping is here where a test can hold it. A build row contributes its
 * per-stage reasons, a repair/scorecard row its findings and field lists — a
 * row may legitimately have neither yet, which is `empty`, not an error.
 */
export function buildBackgroundRowScorecard(artifact: BackgroundRowArtifact | null | undefined): BackgroundRowScorecard {
  const build = artifact?.build;
  const stages = (['extraction', 'mapping', 'optimization'] as const)
    .map((key): BackgroundScorecardStage | null => {
      const s = build?.[key];
      if (!s) return null;
      return {
        key,
        label: SCORECARD_STAGE_LABELS[key],
        score: s.score ?? null,
        band: (s.band as string) ?? 'na',
        reasons: Array.isArray(s.reasons) ? s.reasons : [],
      };
    })
    .filter((s): s is BackgroundScorecardStage => s !== null);

  const q = artifact?.quality;
  const findings = Array.isArray(q?.findings)
    ? q.findings.map(toScorecardFinding).filter((f): f is BackgroundScorecardFinding => f !== null)
    : [];
  const missingFields = Array.isArray(q?.missingFields) ? q.missingFields : [];
  const emptyFields = Array.isArray(q?.emptyFields) ? q.emptyFields : [];

  return {
    stages,
    findings,
    missingFields,
    emptyFields,
    empty: stages.length === 0 && findings.length === 0 && missingFields.length === 0 && emptyFields.length === 0,
  };
}

function viewRow(row: BackgroundBatchRow, position: number): BackgroundRowView {
  const rail = buildRail(row);
  const terminal = TERMINAL_PHASES.has(row.phase);
  return {
    rowId: row.rowId,
    artifactKey: row.artifactKey,
    position,
    group: row.resultGroup,
    packName: row.packName,
    pipelineId: row.pipelineId,
    sourcetype: row.sourcetype,
    declaredSourcetype: row.outputSourcetype || row.sourcetype,
    destFormat: row.destFormat,
    action: row.action,
    actionLabel: ACTION_LABELS[row.action] ?? row.action,
    phase: row.phase,
    phaseLabel: PHASE_LABELS[row.phase] ?? 'Unknown state',
    state: rowState(row.phase),
    terminal,
    rail,
    railPosition: railPositionOf(rail, terminal),
    railTotal: rail.length,
    attempt: row.attempt,
    attemptLabel: attemptLabelFor(row.attempt),
    message: row.message || '',
    scores: scoresOf(row),
    quality: qualityOf(row),
  };
}

// --- run level ---------------------------------------------------------------

export type BackgroundDeployState = NonNullable<BackgroundBatchCheckpoint['qualityDeployStatus']>;

const DEPLOY_LABELS: Record<BackgroundDeployState, string> = {
  'not-needed': 'Not needed',
  pending: 'Pending',
  deployed: 'Deployed',
  failed: 'Failed',
  // A refusal, not a retry: a candidate nobody could measure is live and the
  // best configuration could not be put back, so deploying would ship exactly
  // what best-score-wins exists to prevent.
  blocked: 'Blocked — needs a look',
};

export interface BackgroundDeploymentView {
  state: BackgroundDeployState;
  label: string;
}

export interface BackgroundRunCounts {
  total: number;
  settled: number;
  succeeded: number;
  failed: number;
  skipped: number;
  running: number;
  queued: number;
}

export interface BackgroundRunView {
  runId: string;
  workerGroup: string;
  /**
   * The run's durable status, or one of the two states that are facts about
   * the READ rather than about the run: its document is gone, or its document
   * cannot be used.
   */
  status: BackgroundBatchCheckpoint['status'] | 'missing' | 'unreadable' | 'none';
  statusLabel: string;
  statusDetail: string;
  active: boolean;
  stoppable: boolean;
  /** What the Stop control should say — including why it is not available. */
  stopLabel: string;
  /**
   * Kill is offered for as long as the run is live — above all while it is
   * `stopping`, which is exactly when Stop has nothing left to offer.
   */
  killable: boolean;
  dismissible: boolean;
  /** Terminal and readable — the screen is a final report, not progress. */
  final: boolean;
  /** The run's own fault message, when it has one. */
  message: string;
  read: BackgroundReadState;
  updatedAt: number;
  lastUpdateMs: number;
  lastUpdateLabel: string;
  schedule: { id: string; label: string };
  deployment: BackgroundDeploymentView;
  /** The SECOND deploy, owed only by a Repair that changed live config. */
  repairDeployment: BackgroundDeploymentView | null;
  counts: BackgroundRunCounts;
  /** Rows settled as a percentage. `null` when there is nothing to measure. */
  progressPct: number | null;
  progressLabel: string;
  groups: BackgroundRowGroupView[];
}

const MISSING_STATUS_LABEL = 'Run not found';
const UNREADABLE_STATUS_LABEL = 'Run cannot be read';

/** Stop has been asked for, or cannot be asked for yet — either way, not a second Stop. */
export const BACKGROUND_STOPPING_LABEL = 'Stopping — rows already in flight will finish';
const STOP_UNREADABLE_LABEL = 'Stop unavailable — this run cannot be read';

const STATUS_DETAIL: Record<BackgroundBatchCheckpoint['status'], string> = {
  starting: 'The run is being handed to Cribl.',
  running: "This runs on Cribl's side — you can close this tab and reopen the app any time.",
  committing: 'Every row is finished; the worker group is being committed and deployed.',
  stopping: 'Stop has been asked for. Rows already in flight finish, and nothing new starts.',
  'awaiting-quality': 'This run is parked and will not continue on its own.',
  done: 'The run finished. Nothing else will change.',
  error: 'The run ended early. Nothing else will change.',
};

function ageLabel(ms: number): string {
  if (ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 90) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  return `${Math.round(m / 60)} hours ago`;
}

function countRows(rows: BackgroundBatchRow[]): BackgroundRunCounts {
  const counts: BackgroundRunCounts = {
    total: rows.length, settled: 0, succeeded: 0, failed: 0, skipped: 0, running: 0, queued: 0,
  };
  for (const r of rows) {
    const state = rowState(r.phase);
    if (state === 'success') counts.succeeded++;
    else if (state === 'error') counts.failed++;
    else if (state === 'skipped') counts.skipped++;
    else if (state === 'running') counts.running++;
    else counts.queued++;
  }
  counts.settled = counts.succeeded + counts.failed + counts.skipped;
  return counts;
}

function deploymentView(state: BackgroundDeployState | undefined): BackgroundDeploymentView | null {
  if (!state) return null;
  return { state, label: DEPLOY_LABELS[state] ?? state };
}

const EMPTY_COUNTS: BackgroundRunCounts = {
  total: 0, settled: 0, succeeded: 0, failed: 0, skipped: 0, running: 0, queued: 0,
};

/** Rows settled as a percentage — only a run with nothing left may read 100. */
function progressPctOf(counts: BackgroundRunCounts): number {
  if (counts.settled >= counts.total) return 100;
  return Math.min(99, Math.round((counts.settled / counts.total) * 100));
}

/**
 * The whole screen, as one value.
 *
 * `read` is deliberately a parameter rather than something inferred from the
 * checkpoint: "the manifest is gone" is a fact about the READ, and the last
 * good manifest is still the best thing to show while saying so.
 */
/**
 * Whether the whole-run scoring report can be built yet, and if not, why. The
 * report reads one artifact per built row, so it needs at least one row in
 * the build group that has one. The UI shows the button either way and
 * uses `reason` as the disabled explanation, so the report is never missing
 * without a word.
 */
export function backgroundReportAvailability(run: Pick<BackgroundRunView, 'runId' | 'groups' | 'counts'>): { ok: boolean; rows: number; reason: string } {
  if (!run.runId) return { ok: false, rows: 0, reason: 'No background run is recorded for this session.' };
  const rows = run.groups.flatMap(g => g.rows).filter(r => r.group === 'build' && r.artifactKey).length;
  if (rows > 0) return { ok: true, rows, reason: '' };
  const buildRows = run.groups.filter(g => g.id === 'build').reduce((n, g) => n + g.rows.length, 0);
  if (buildRows === 0) return { ok: false, rows: 0, reason: 'This run has no build rows. Repair and Scorecard rows show their scorecard in the table.' };
  return { ok: false, rows: 0, reason: 'Available as soon as the first row has built.' };
}

export function buildBackgroundRunView(
  cp: BackgroundBatchCheckpoint | null | undefined,
  opts: { now?: number; read?: BackgroundReadState } = {},
): BackgroundRunView {
  const now = opts.now ?? Date.now();
  const read = opts.read ?? (cp ? BACKGROUND_READ_OK : { status: 'none', message: '' });
  const missing = read.status === 'missing';
  // Two different documents, one operator move. `missing` means the manifest is
  // gone; `unreadable` means it is there and will never be usable. Neither can
  // be followed or stopped, and both are released only by an explicit cleanup —
  // which is why the affordances below treat them alike while the wording does
  // not (an operator who is told a run "was not found" will go looking for it).
  const unreadable = read.status === 'unreadable';
  const dead = missing || unreadable;
  const presentation = backgroundRunPresentation(cp);
  const rows = orderedBackgroundRows(cp?.rows ?? []);
  const counts = cp ? countRows(rows) : EMPTY_COUNTS;

  const groups: BackgroundRowGroupView[] = (['build', 'quality', BACKGROUND_OTHER_GROUP] as const)
    .map(id => ({
      id: id as BackgroundRowGroupId,
      ...GROUP_TITLES[id],
      rows: [] as BackgroundRowView[],
    }))
    .filter(g => rows.some(r => groupIdOf(r) === g.id));
  rows.forEach((r, i) => {
    const target = groups.find(g => g.id === groupIdOf(r));
    target?.rows.push(viewRow(r, i + 1));
  });

  // A run whose document is gone is neither working nor finished. Presenting it
  // as either is the exact failure Hard Rule 32 names: it would send the
  // operator off to wait for a tick that can never happen, or tell them work
  // completed that nobody can account for.
  const active = !!cp && presentation.active && !dead;
  const stoppable = !!cp && presentation.stoppable && !dead;
  const lastUpdateMs = cp ? Math.max(0, now - cp.updatedAt) : 0;

  return {
    // A corrupt manifest read at mount leaves no checkpoint at all, so the id
    // the READ carried is the only thing cleanup has to work with.
    runId: cp?.runId ?? read.runId ?? '',
    workerGroup: cp?.workerGroup ?? '',
    status: unreadable ? 'unreadable' : missing ? 'missing' : (cp?.status ?? 'none'),
    statusLabel: unreadable
      ? UNREADABLE_STATUS_LABEL
      : missing ? MISSING_STATUS_LABEL : (presentation.label || 'No background run'),
    statusDetail: unreadable
      ? BACKGROUND_RUN_UNREADABLE
      : missing ? BACKGROUND_RUN_MISSING : (cp ? STATUS_DETAIL[cp.status] ?? '' : ''),
    active,
    stoppable,
    stopLabel: stoppable ? 'Stop' : unreadable ? STOP_UNREADABLE_LABEL : BACKGROUND_STOPPING_LABEL,
    killable: active,
    // An unreadable run is dismissible on the strength of the READ, with or
    // without a manifest — that is the whole point of the state.
    dismissible: unreadable
      ? !!(cp || read.runId)
      : !!cp && (missing || presentation.dismissible),
    final: !!cp && !dead && (cp.status === 'done' || cp.status === 'error'),
    message: cp?.message || '',
    read,
    updatedAt: cp?.updatedAt ?? 0,
    lastUpdateMs,
    lastUpdateLabel: cp ? ageLabel(lastUpdateMs) : '',
    schedule: {
      id: cp?.scheduleId ?? '',
      label: cp?.scheduleId ? `Scheduled as ${cp.scheduleId}` : 'No schedule recorded',
    },
    deployment: deploymentView(cp?.deployStatus) ?? { state: 'not-needed', label: DEPLOY_LABELS['not-needed'] },
    repairDeployment: deploymentView(cp?.qualityDeployStatus),
    counts,
    // Capped below 100 until every row has settled: 199 of 200 rounds to 100,
    // and a full bar next to "199 of 200 rows settled" tells the operator the
    // run is finished while it is still working — the same lie as a full bar on
    // a parked run, arrived at by arithmetic instead of by status.
    progressPct: counts.total > 0 ? progressPctOf(counts) : null,
    progressLabel: counts.total > 0
      ? `${counts.settled} of ${counts.total} rows settled`
      : 'No rows to report',
    groups,
  };
}
