/**
 * Shared post-deploy quality + repair core.
 *
 * Used by BOTH:
 *   - the /pack-quality-check skill runner (scripts/quality-check.mjs), and
 *   - the app's post-deploy flow (POST /api/pack-generator/repair-quality),
 *     invoked by the interactive + batch generators after each pipeline deploys.
 *
 * For ONE live (already-deployed) pipeline:
 *   1. Score it with a REAL deterministic number, through the ONE shared
 *      measurement (src/quality-measure.ts) over live preview output. A source
 *      no deterministic lens supports is UNSCORED — the AI's estimate is
 *      advisory in every run mode (Hard Rules 12 + 32), never a fallback.
 *   2. If score < qualityThreshold → REPAIR flow: PATCH live (deferDeploy) →
 *      preview → re-score, best-conf-wins, retry up to MAX_RETRIES while under
 *      RETRY_FLOOR. Rolls the live pipeline back to the best conf seen.
 *   3. Store to golden when the final score is >= qualityThreshold AND real.
 *
 * Does NOT commit/deploy — repairs PATCH with deferDeploy; the caller performs
 * one commit+deploy per worker group afterwards. Does NOT log the Lake event —
 * the caller owns the single completion event so it can add flow/timing fields.
 */
import { Readable } from 'node:stream';
import { CRIBL_ORG, getToken, env } from './cribl-auth.mjs';
import { readFileSync } from 'node:fs';
import { handleValidatePipeline, handleRepairPipeline, saveGoldenPipeline, recordRepairLessons } from './schema-validator.mjs';
import { buildGoldenEvidence } from '../src/golden-evidence.ts';
import { measureAuthoritative, previewWithZeroOutputRetry } from '../src/quality-measure.ts';
import { QUALITY_MAX_ROUNDS, QUALITY_RETRY_FLOOR, repairRoundLimit } from '../src/quality-stage.ts';
import { publishGoldenDirect } from './golden-github.mjs';
import { goldenVariantSourcetype, goldenWireFormatForSample } from '../src/golden-variant.ts';
import { CRIBL_USER_EMAIL } from './cribl-auth.mjs';

// Stamped on golden evidence and pool docs so a bad golden can be traced to the
// build that admitted it.
const BUILD = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).buildNumber || 0; } catch { return 0; }
})();

// The retry policy is defined ONCE, in src/quality-stage.ts, and re-exported
// here: this engine and the durable background state machine must never drift
// onto two different ideas of how many rounds a pipeline is worth.
export const RETRY_FLOOR = QUALITY_RETRY_FLOOR;   // below this, keep retrying rounds
export const MAX_RETRIES = QUALITY_MAX_ROUNDS;    // max repair rounds while under RETRY_FLOOR
export { repairRoundLimit };

const base = () => CRIBL_ORG.replace(/\/+$/, '');

async function api(token, path, method = 'GET', body) {
  const r = await fetch(`${base()}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* other */ }
  return { ok: r.ok, status: r.status, json, text };
}

function mockReq(body) { return Readable.from([JSON.stringify(body)]); }
function mockRes() { return { statusCode: 0, _b: '', setHeader() {}, end(s) { this._b = s; } }; }

// AUTHORITATIVE score = VALUE COVERAGE: of the meaningful values the sample
// carries, how many were correctly extracted AND mapped into the output.
// Source-relative, deterministic, spec-free — a value absent from the sample
// can't hurt (100% still reachable); an extracted-then-dropped or unextracted
// value is the real penalty. Added/enrichment/transformed fields (_time,
// severity, class_uid, protocol decode) are output-only, excluded, and remain.
// The AI's judgment is ADVISORY only: its findings feed the repair prompt to
// pinpoint fixes, but never set the score. (This replaces AI-authoritative
// scoring, which unfairly tanked correct golden pipelines.)
// The false-zero retry, the raw-key extraction and the real/unmeasured rule all
// live in src/quality-measure.ts — the one measurement this engine and the
// browser scorer share. What stays here is the TRANSPORT: this one previews
// through the validator handler, the browser one through the platform API.

async function validatePipelineReport(ev, deps) {
  const res = mockRes();
  await deps.handleValidatePipeline(mockReq({
    workerGroup: ev.worker_group, packId: ev.pack_id, pipelineId: ev.pipeline_id,
    sourcetype: ev.sourcetype, destFormat: ev.dest_format, sampleName: ev.sample_name,
    includeAi: false,
  }), res);
  return JSON.parse(res._b);
}

async function scorePipeline(ev, deps = defaultDeps) {
  const report = await previewWithZeroOutputRetry(
    async () => {
      const r = await validatePipelineReport(ev, deps);
      return {
        ...r,
        rawEvents: r.sampleRaw || [],
        outputEvents: r.outputSample || [],
        inputCount: r.inputCount ?? (r.sampleRaw || []).length,
        outputCount: r.outputCount ?? (r.outputSample || []).length,
      };
    },
    { sleep: deps.sleep },
  );

  // ONE measurement, shared with the browser scorer (src/quality-measure.ts):
  // the same raw-key extraction, the same real/unmeasured rule and the same
  // repair guidance. A failed preview is UNSCORED — null, never 0 (Rule 32).
  const measured = measureAuthoritative({
    destFormat: ev.dest_format,
    sourcetype: ev.sourcetype,
    rawEvents: report.rawEvents,
    outputEvents: report.outputEvents,
    // The validator's own findings are advisory context for the repair prompt.
    // Its SCORE is not passed at all: Rule 12 makes the AI advisory in every run
    // mode, and this path used to hand it in as a fallback — so a pipeline no
    // deterministic lens could measure came back carrying a confident number.
    aiFindings: report.findings || [],
    error: report.error,
  });
  if (measured.error) return { score: null, real: false, error: measured.error, report };

  // Reported for the caller's progress log only. The SCORE, the band and the
  // repair guidance all arrive from the shared measurement; this engine must
  // never re-derive them (tests/repair-core-test.mjs). Every lens is OPTIONAL —
  // `auth.spec` is null on the value-coverage branch, which is the common one,
  // so an unguarded `det.supported` here threw a TypeError on every pipeline.
  const auth = measured.auth;
  const golden = auth?.golden;
  const cov = auth?.coverage;
  const det = auth?.spec;

  return {
    score: measured.score,                 // AUTHORITATIVE: golden-spec / spec-validation / value coverage
    real: measured.real,
    band: measured.band,
    scoreSource: measured.scoreSource,
    coverage: cov?.supported ? { covered: cov.coveredValues, total: cov.totalValues, lost: cov.lostValues } : null,
    goldenCoverage: golden?.supported ? { populated: golden.populated, expected: golden.expected, missing: golden.missing } : null,
    specCoverage: det?.supported && measured.scoreSource === 'spec-validation'
      ? { populated: det.populatedFields, expected: det.checkedFields, missing: det.missingFields } : null,
    aiScore: report.score ?? null,         // advisory
    deterministicScore: det?.supported ? det.score : null, // advisory
    findings: measured.findings,
    // `??`, never `length ?`: a measured EMPTY list means the lens looked and
    // found nothing missing, and must not be replaced by the AI's list.
    missingFields: measured.missingFields ?? report.missingFields ?? [],
    emptyFields: measured.emptyFields ?? report.emptyFields ?? [],
    lessons: report.lessons || [], report,
  };
}

// One repair round: PATCH the pipeline (deferDeploy), do not commit/deploy.
// repairModel (optional) selects the AI model for the repair-flow.
async function repairRound(ev, scored, repairModel, deps = defaultDeps) {
  const findings = [...(scored.findings || [])].sort((a, b) => (b.pointImpact || 0) - (a.pointImpact || 0));
  const res = mockRes();
  await deps.handleRepairPipeline(mockReq({
    workerGroup: ev.worker_group, packId: ev.pack_id, pipelineId: ev.pipeline_id,
    sourcetype: ev.sourcetype, destFormat: ev.dest_format, sampleName: ev.sample_name,
    findings, lessons: scored.lessons,
    missingFields: scored.missingFields, emptyFields: scored.emptyFields,
    deferDeploy: true, model: repairModel,
  }), res);
  return JSON.parse(res._b);
}

async function getConf(token, ev) {
  const r = await api(token, `/m/${ev.worker_group}/p/${ev.pack_id}/pipelines/${ev.pipeline_id}`);
  return r.json?.items?.[0]?.conf || r.json?.conf || null;
}
async function putConf(token, ev, conf) {
  await api(token, `/m/${ev.worker_group}/p/${ev.pack_id}/pipelines/${ev.pipeline_id}`, 'PATCH', { id: ev.pipeline_id, conf });
}

/**
 * Run the quality + repair flow for one live pipeline.
 *
 * @param {object} ev  pipeline descriptor: {worker_group, pack_id, pipeline_id, sourcetype, dest_format, sample_name}
 * @param {object} opts {qualityThreshold=80, repairModel, dryRun=false, log}
 * @returns {object} result summary (see fields below)
 */
export async function runQualityFlow(ev, opts = {}, deps = defaultDeps) {
  const qualityThreshold = Number(opts.qualityThreshold) || 80;
  const repairModel = opts.repairModel;
  const dryRun = !!opts.dryRun;
  const log = opts.log || (() => {});
  const token = await deps.getToken();
  const tag = `${ev.pack_id}/${ev.pipeline_id} (${ev.dest_format})`;

  // STEP 1 — real score of the just-published pipeline
  const first = await scorePipeline(ev, deps);
  log({ phase: 'score', pipeline: ev.pipeline_id, tag, score: first.score, real: first.real, source: first.scoreSource,
    outputCount: first.report?.outputCount ?? null, inputCount: first.report?.inputCount ?? null });
  if (first.error) {
    log({ phase: 'score-error', pipeline: ev.pipeline_id, error: first.error });
    // UNSCORED, not zero (Hard Rule 32): a 0 here is indistinguishable from a
    // pipeline that genuinely extracts nothing, and it is what the dashboard
    // would then average in. Callers report this as skipped.
    return {
      pipeline: ev.pipeline_id, tag, ev, flow: 'normal', error: first.error,
      startScore: null, finalScore: null, trialScores: [], real: false,
      stored: false, storedValue: null, rounds: 0, needsDeploy: false,
    };
  }
  if (first.score === 0 && !first.error) {
    log({ phase: 'score-zero-diag', pipeline: ev.pipeline_id, real: first.real, scoreSource: first.scoreSource,
      coverageSupported: first.coverage != null, goldenSupported: first.goldenCoverage != null,
      aiScore: first.aiScore, outputCount: first.report?.outputCount ?? 0, inputCount: first.report?.inputCount ?? 0 });
  }

  let bestScore = first.score;
  let bestReal = first.real;
  let bestConf = await deps.getConf(token, ev);
  let bestScored = first;   // the scored result (findings/report) behind bestScore
  let repaired = false;
  let unresolved = null;   // set when the best conf could NOT be written back
  let flow = 'normal';
  let rounds = 0;
  const trialScores = [];

  // STEP 2 — repair flow when below the single quality threshold
  if (first.score < qualityThreshold && !dryRun) {
    flow = 'repair';
    let scored = first;
    const maxRounds = repairRoundLimit(first.score);
    while (rounds < maxRounds && bestScore < qualityThreshold) {
      rounds++;
      log({ phase: 'repair', pipeline: ev.pipeline_id, tag, round: rounds, from: scored.score });
      const rr = await repairRound(ev, scored, repairModel, deps);
      if (rr.error) {
        log({ phase: 'repair-error', pipeline: ev.pipeline_id, round: rounds, error: rr.error });
        trialScores.push(null);
        break;
      }
      const after = await scorePipeline(ev, deps);
      trialScores.push(after.score);
      log({ phase: 'repair-scored', pipeline: ev.pipeline_id, tag, round: rounds, score: after.score, real: after.real });
      if (after.score > bestScore) {
        // Credit assignment: a lesson is kept only when the repair it informed
        // actually improved a REAL score. They used to be written before the
        // repair ran, whatever it did — so a repair that regressed and was rolled
        // back still taught every future mapping prompt its advice.
        if (after.real && first.real && !dryRun) {
          try { deps.recordLessons(ev.sourcetype, ev.dest_format, scored.lessons, { before: scored.score, after: after.score, build: BUILD }); } catch { /* best effort */ }
        }
        bestScore = after.score; bestReal = after.real; repaired = true;
        bestConf = await deps.getConf(token, ev);
        bestScored = after;
        scored = after;
        if (after.score < RETRY_FLOOR) continue;
        break;
      } else {
        log({ phase: 'no-improvement', pipeline: ev.pipeline_id, round: rounds, best: bestScore });
        break;
      }
    }
    // best-conf-wins: make sure the live (PATCHed) conf is the best one seen.
    //
    // If that write FAILS, the live pipeline is holding a candidate nobody
    // verified. The run cannot fix it and must not hide it: it stores no
    // knowledge, claims no deployment score and — through `needsDeploy: false`
    // plus the `unresolved` flag the caller reads — asks for no commit. Same
    // guarantee the browser engine gives (`driveQualityToCompletion`).
    if (bestConf) {
      try {
        await deps.putConf(token, ev, bestConf);
      } catch (e) {
        unresolved = `the best configuration could not be restored on ${ev.pipeline_id}: ${e.message}`;
        log({ phase: 'rollback-failed', pipeline: ev.pipeline_id, error: e.message });
      }
    }
  } else if (first.score >= qualityThreshold) {
    log({ phase: 'ok', pipeline: ev.pipeline_id, tag, score: first.score, message: 'at/above threshold — no repair' });
  }

  // STEP 3 — store to golden when final score is real AND >= threshold
  // Store to golden ONLY when the authoritative (scorecard/AI) score >= threshold.
  // No golden image is ever kept for a pipeline scoring below the threshold.
  let stored = false;
  let storedValue = null;
  if (!dryRun && !unresolved && bestReal && bestScore >= qualityThreshold && bestConf?.functions) {
    try {
      // The golden is filed under the sample's wire format (src/golden-variant.ts):
      // the caller's, else read off the events this pipeline was just scored on.
      const rawEvents = bestScored?.report?.rawEvents || first.report?.rawEvents || [];
      const wireFormat = ev.wire_format || goldenWireFormatForSample(rawEvents) || null;
      const goldenKey = `${goldenVariantSourcetype(ev.sourcetype, wireFormat)}::${ev.dest_format}`;
      // Evidence (golden-trust R1). This engine never saw the sample resolve, so
      // its provenance is what the caller sent — the browser's registry — or
      // unknown, which the store refuses rather than guesses (useRegistry:false).
      const evidence = buildGoldenEvidence({
        score: bestScore, real: bestReal, scoreSource: bestScored?.scoreSource || 'value-coverage', band: bestScored?.band,
        sampleEvents: rawEvents, sampleTier: ev.sample_store_tier ?? ev.sample_tier ?? null,
        syntheticCount: typeof ev.synthetic_count === 'number' ? ev.synthetic_count
          : (typeof ev.sample_synthetic_count === 'number' ? ev.sample_synthetic_count : null),
        useRegistry: false, build: BUILD,
      });
      const plan = deps.saveGoldenPipeline(ev.sourcetype, ev.dest_format, bestConf.functions, bestScore, null, bestScored?.report || null, wireFormat, evidence) || { action: 'create', reasons: [] };
      if (plan.action === 'refuse') {
        log({ phase: 'store-skip', pipeline: ev.pipeline_id, reason: `golden refused: ${(plan.reasons || []).join('; ')}` });
      } else {
        stored = plan.action !== 'keep'; storedValue = stored ? bestScore : null;
        log({ phase: stored ? 'knowledge-saved' : 'store-skip', pipeline: ev.pipeline_id, key: goldenKey, score: bestScore,
          ...(stored ? {} : { reason: (plan.reasons || []).join('; ') || 'kept the stored golden' }) });
      }

      // STEP 3b — publish to the SHARED pool when sharing is on. The publisher
      // reads THIS install's stored record and applies the pool's own rules
      // (golden-trust R2/R6: evidence + corroborated standing + the code-constant
      // bar), so nothing the caller passes can lower that bar.
      const share = opts.share;
      if (stored && share?.enabled && share.repo && share.token) {
        const pub = await deps.publishGoldenDirect({
          repo: share.repo, branch: share.branch, token: share.token,
          key: goldenKey, author: share.author, build: share.build || BUILD,
        });
        if (pub.published) log({ phase: 'golden-published', pipeline: ev.pipeline_id, key: goldenKey, score: bestScore });
        else log({ phase: 'golden-publish-skip', pipeline: ev.pipeline_id, reason: pub.reason || pub.error || 'unknown' });
      }
    } catch (e) {
      log({ phase: 'knowledge-error', pipeline: ev.pipeline_id, error: e.message });
    }
  } else if (!dryRun && bestScore < qualityThreshold) {
    log({ phase: 'store-skip', pipeline: ev.pipeline_id, reason: `score ${bestScore} < threshold ${qualityThreshold}` });
  }

  return {
    pipeline: ev.pipeline_id, tag, ev, flow,
    startScore: first.score,
    // No deployment score for a pipeline nobody can identify: the best conf is
    // NOT what is live (Hard Rule 32 — better unscored than wrongly scored).
    finalScore: unresolved ? null : bestScore,
    trialScores,
    real: bestReal, stored, storedValue, rounds,
    // caller commits+deploys the group if any repair PATCHed — never while an
    // unverified candidate is live
    needsDeploy: repaired && !unresolved,
    ...(unresolved ? { unresolved: true, error: unresolved } : {}),
  };
}

// Commit + deploy one worker group (after a repair PATCHed the live pipeline).
async function commitDeploy(token, workerGroup, message) {
  const commit = await api(token, `/version/commit`, 'POST', { message, group: workerGroup });
  const commitId = commit.json?.items?.[0]?.commit;
  if (commitId) await api(token, `/master/groups/${workerGroup}/deploy`, 'PATCH', { version: commitId });
  return commitId || null;
}

export const defaultDeps = {
  getToken,
  // Injected so a test can exercise the false-zero retry without sitting
  // through its (deliberately real) 2.9s of backoff.
  sleep: undefined,
  handleValidatePipeline,
  handleRepairPipeline,
  getConf,
  putConf,
  saveGoldenPipeline,
  publishGoldenDirect,
  recordLessons: recordRepairLessons,
};

const defaultHandlerDeps = {
  runQualityFlow,
  getToken,
  commitDeploy,
  getGoldenToken: () => env('GOLDEN_READ_TOKEN') || env('GITHUB_TOKEN'),
};

// Dev-server HTTP handler: POST /api/pack-generator/repair-quality
// Streams NDJSON progress lines ({message} / phase objects), then a final
// {result:{...}} line. The app calls this after each pipeline deploys.
export async function handleRepairQuality(req, res, deps = defaultHandlerDeps) {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch { /* ignore */ } };
  try {
    const { workerGroup, packId, pipelineId, sourcetype, destFormat, sampleName, qualityThreshold, repairModel,
      shareGoldens, goldenRepo, goldenBranch, deferCommit, dryRun, wireFormat, sampleTier, syntheticCount } = JSON.parse(body || '{}');
    const ev = { worker_group: workerGroup, pack_id: packId, pipeline_id: pipelineId, sourcetype, dest_format: destFormat, sample_name: sampleName,
      ...(wireFormat ? { wire_format: wireFormat } : {}),
      // Sample provenance from the browser's registry (src/sample-provenance.ts):
      // this process cannot see where the sample came from.
      ...(sampleTier ? { sample_store_tier: sampleTier } : {}),
      ...(typeof syntheticCount === 'number' ? { synthetic_count: syntheticCount } : {}) };
    const result = await deps.runQualityFlow(ev, {
      // Score-only (the Scorecard action): no repair round, no PATCH, no golden
      // store, at any score. Never a threshold nothing can reach.
      qualityThreshold, repairModel, dryRun: !!dryRun,
      share: { enabled: !!shareGoldens, repo: goldenRepo, branch: goldenBranch || 'shared-goldens', token: deps.getGoldenToken(), author: CRIBL_USER_EMAIL, build: BUILD },
      log: (o) => emit({ message: phaseMessage(o), phase: o }),
    });
    // If a repair PATCHed the live pipeline, commit + deploy the group now —
    // UNLESS the caller set deferCommit (the caller will commit+deploy once at the end).
    if (result.needsDeploy && !deferCommit) {
      const token = await deps.getToken();
      const commit = await deps.commitDeploy(token, workerGroup, `quality-repair ${pipelineId} in ${packId}`);
      emit({ message: `Deployed repaired pipeline (${commit || 'no-op'})`, phase: { phase: 'deployed', commit } });
    }
    emit({ result });
  } catch (err) {
    // NULL, not 0: this run never measured the pipeline, and a 0 reads as
    // "it extracts nothing" everywhere downstream (Hard Rule 32).
    emit({ result: { error: err.message || 'repair-quality failed', flow: 'normal', startScore: null, finalScore: null, trialScores: [], real: false, stored: false, storedValue: null, rounds: 0 } });
  }
  res.end();
}

// Human-readable one-liner per progress phase (for the app's deploy log).
function phaseMessage(o) {
  switch (o.phase) {
    case 'score': return `Scoring… ${o.score}/100${o.real ? '' : ' (estimate)'}`;
    case 'repair': return `Repair try ${o.round} (last score ${o.from})…`;
    case 'repair-scored': return `Repair try ${o.round} → ${o.score}/100`;
    case 'repair-error': return `Repair try ${o.round} failed (${o.error?.slice?.(0, 60) || 'error'})`;
    case 'no-improvement': return `No improvement — keeping best ${o.best}/100`;
    case 'knowledge-saved': return `Stored to golden (${o.score}/100)`;
    case 'store-skip': return `Not stored (${o.reason})`;
    case 'ok': return `Score ${o.score}/100 — at/above threshold`;
    case 'score-error': return `Scoring failed: ${o.error}`;
    default: return o.phase || '';
  }
}
