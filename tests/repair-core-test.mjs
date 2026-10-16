import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleRepairQuality, MAX_RETRIES, repairRoundLimit, RETRY_FLOOR, runQualityFlow } from '../scripts/repair-core.mjs';

const EV = {
  worker_group: 'wg-main',
  pack_id: 'pack-a',
  pipeline_id: 'pipe-a',
  sourcetype: 'vendor:events',
  dest_format: 'cim',
  sample_name: 'sample.log',
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function scoreReport({ score, real = true, lessons = [] }) {
  if (!real) {
    return {
      outputSample: [{}],
      sampleRaw: [],
      sampleKeys: [],
      score,
      findings: [],
      lessons,
      outputCount: 1,
      inputCount: 1,
    };
  }

  const source = {};
  const output = {};
  for (let i = 0; i < 100; i++) {
    const key = `field_${String(i).padStart(3, '0')}`;
    const value = `fixture-value-${String(i).padStart(3, '0')}`;
    source[key] = value;
    if (i < score) output[key] = value;
  }
  return {
    outputSample: [output],
    sampleRaw: [JSON.stringify(source)],
    sampleKeys: Object.keys(source),
    findings: [],
    lessons,
    outputCount: 1,
    inputCount: 1,
  };
}

function harness(scores, { repairConfs = [], publishResult = { published: true }, publishError = null } = {}) {
  let liveConf = { functions: [{ id: 'initial' }] };
  let scoreIndex = 0;
  let repairIndex = 0;
  const calls = {
    validate: [],
    repair: [],
    save: [],
    publish: [],
    getConf: [],
    putConf: [],
    commitDeploy: [],
    lessons: [],
  };

  const deps = {
    getToken: async () => 'test-token',
    handleValidatePipeline: async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      calls.validate.push(parsed);
      const current = scores[Math.min(scoreIndex++, scores.length - 1)];
      res.end(JSON.stringify(scoreReport(current)));
    },
    handleRepairPipeline: async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.repair.push(JSON.parse(body));
      const next = repairConfs[repairIndex] || { functions: [{ id: `repair-${repairIndex + 1}` }] };
      repairIndex++;
      liveConf = clone(next);
      res.end(JSON.stringify({ repaired: true }));
    },
    getConf: async (token, ev) => {
      calls.getConf.push({ token, ev: clone(ev) });
      return clone(liveConf);
    },
    putConf: async (token, ev, conf) => {
      calls.putConf.push({ token, ev: clone(ev), conf: clone(conf) });
      liveConf = clone(conf);
    },
    saveGoldenPipeline: (...args) => calls.save.push(clone(args)),
    recordLessons: (...args) => calls.lessons.push(clone(args)),
    publishGoldenDirect: async (args) => {
      calls.publish.push(clone(args));
      if (publishError) throw publishError;
      return publishResult;
    },
    commitDeploy: async (...args) => {
      calls.commitDeploy.push(args);
      return 'commit-1';
    },
  };

  return { deps, calls, liveConf: () => clone(liveConf) };
}

function assertAllScoringIsDeterministic(calls) {
  assert.ok(calls.validate.length > 0);
  for (const body of calls.validate) {
    assert.equal(body.includeAi, false, 'every scoring validation must disable AI');
    assert.equal(body.pipelineId, EV.pipeline_id);
  }
}

test('a real initial score at threshold saves golden without repair', async () => {
  const h = harness([{ score: 90 }]);

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.deepEqual(result, {
    pipeline: EV.pipeline_id,
    tag: 'pack-a/pipe-a (cim)',
    ev: EV,
    flow: 'normal',
    startScore: 90,
    finalScore: 90,
    trialScores: [],
    real: true,
    stored: true,
    storedValue: 90,
    rounds: 0,
    needsDeploy: false,
  });
  assert.equal(h.calls.repair.length, 0);
  assert.deepEqual(h.calls.save[0].slice(0, 4), [EV.sourcetype, EV.dest_format, [{ id: 'initial' }], 90]);
  assert.equal(h.calls.putConf.length, 0);
  assertAllScoringIsDeterministic(h.calls);
});

test('a 50 to 82 repair keeps its conf, saves it, and reports one trial', async () => {
  const repaired = { functions: [{ id: 'score-82' }], description: 'best' };
  const h = harness([{ score: 50 }, { score: 82 }], { repairConfs: [repaired] });

  const result = await runQualityFlow(EV, { qualityThreshold: 80, repairModel: 'repair-model' }, h.deps);

  assert.equal(result.flow, 'repair');
  assert.equal(result.startScore, 50);
  assert.equal(result.finalScore, 82);
  assert.deepEqual(result.trialScores, [82]);
  assert.equal(result.rounds, 1);
  assert.equal(result.stored, true);
  assert.equal(result.storedValue, 82);
  assert.equal(result.needsDeploy, true);
  const expectedFindings = Array.from({ length: 12 }, (_, i) => ({
    severity: 'medium',
    field: '_value',
    issue: `sample value "fixture-value-${String(i + 50).padStart(3, '0')}" was not extracted/mapped into the output`,
    pointImpact: 0,
  }));
  assert.deepEqual(h.calls.repair[0], {
    workerGroup: EV.worker_group,
    packId: EV.pack_id,
    pipelineId: EV.pipeline_id,
    sourcetype: EV.sourcetype,
    destFormat: EV.dest_format,
    sampleName: EV.sample_name,
    findings: expectedFindings,
    lessons: [],
    missingFields: [],
    emptyFields: [],
    deferDeploy: true,
    model: 'repair-model',
  });
  assert.deepEqual(h.calls.putConf[0].conf, repaired);
  assert.deepEqual(h.liveConf(), repaired);
  assert.deepEqual(h.calls.save[0][2], repaired.functions);
  assert.equal(h.calls.commitDeploy.length, 0, 'runQualityFlow must leave commit/deploy to its caller');
  assertAllScoringIsDeterministic(h.calls);
});

test('a regressing repair restores the initial best conf and is not stored', async () => {
  const regression = { functions: [{ id: 'score-35' }] };
  const h = harness([{ score: 40 }, { score: 35 }], { repairConfs: [regression] });

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.equal(result.flow, 'repair');
  assert.equal(result.startScore, 40);
  assert.equal(result.finalScore, 40);
  assert.deepEqual(result.trialScores, [35]);
  assert.equal(result.real, true);
  assert.equal(result.stored, false);
  assert.equal(result.storedValue, null);
  assert.equal(result.rounds, 1);
  assert.equal(result.needsDeploy, false);
  assert.deepEqual(h.calls.putConf[0].conf, { functions: [{ id: 'initial' }] });
  assert.deepEqual(h.liveConf(), { functions: [{ id: 'initial' }] });
  assert.equal(h.calls.save.length, 0);
  assertAllScoringIsDeterministic(h.calls);
});

test('scores below the retry floor stop after MAX_RETRIES and restore the best attempt', async () => {
  const repairConfs = Array.from({ length: MAX_RETRIES }, (_, i) => ({ functions: [{ id: `round-${i + 1}` }] }));
  const h = harness(
    [{ score: 10 }, { score: 20 }, { score: 30 }, { score: 40 }, { score: 50 }, { score: 60 }],
    { repairConfs },
  );

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.equal(result.rounds, MAX_RETRIES);
  assert.equal(h.calls.repair.length, MAX_RETRIES);
  assert.deepEqual(result.trialScores, [20, 30, 40, 50, 60]);
  assert.equal(result.finalScore, 60);
  assert.equal(result.stored, false);
  assert.equal(result.needsDeploy, true);
  assert.deepEqual(h.calls.putConf.at(-1).conf, repairConfs.at(-1));
  assert.deepEqual(h.liveConf(), repairConfs.at(-1));
  assertAllScoringIsDeterministic(h.calls);
});

test('a score between retry floor and threshold gets only one repair round', async () => {
  const repaired = { functions: [{ id: 'score-76' }] };
  const h = harness([{ score: 75 }, { score: 76 }, { score: 99 }], { repairConfs: [repaired] });

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.equal(result.rounds, 1);
  assert.deepEqual(result.trialScores, [76]);
  assert.equal(result.finalScore, 76);
  assert.equal(h.calls.validate.length, 2);
  assert.equal(h.calls.repair.length, 1);
  assert.deepEqual(h.calls.putConf[0].conf, repaired);
  assertAllScoringIsDeterministic(h.calls);
});

test('a score exactly at RETRY_FLOOR gets only one repair round', async () => {
  assert.equal(RETRY_FLOOR, 70);
  assert.equal(repairRoundLimit(RETRY_FLOOR - 1), MAX_RETRIES);
  assert.equal(repairRoundLimit(RETRY_FLOOR), 1, 'the retry policy boundary is strictly less than RETRY_FLOOR');
  const repaired = { functions: [{ id: 'score-71' }] };
  const h = harness([{ score: RETRY_FLOOR }, { score: 71 }, { score: 99 }], { repairConfs: [repaired] });

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.equal(result.rounds, 1, 'RETRY_FLOOR itself must not enter the below-floor retry loop');
  assert.deepEqual(result.trialScores, [71]);
  assert.equal(result.finalScore, 71);
  assert.equal(h.calls.validate.length, 2);
  assert.equal(h.calls.repair.length, 1);
  assert.deepEqual(h.calls.putConf[0].conf, repaired);
});

test('a rollback that cannot be written is UNRESOLVED — no deploy, no golden, no score', async () => {
  // The repair regressed, and putting the best conf back FAILED. The live
  // pipeline is now holding a candidate nobody verified, so this run may not
  // ask its caller to commit — a committed candidate is not recoverable.
  const h = harness([{ score: 40 }, { score: 20 }]);
  h.deps.putConf = async () => { throw new Error('the leader rejected the PATCH'); };

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.equal(result.unresolved, true);
  assert.equal(result.needsDeploy, false, 'a caller must not commit an unverified candidate');
  assert.equal(result.finalScore, null, 'nobody knows what the pipeline is running — there is no score for it');
  assert.equal(result.startScore, 40, 'what WAS measured is still reported');
  assert.equal(result.stored, false);
  assert.equal(h.calls.save.length, 0, 'knowledge is not written from a pipeline left in an unknown state');
  assert.match(result.error, /rejected the PATCH/);
});

test('a rollback that succeeds is resolved and still asks for its one deploy', async () => {
  const h = harness([{ score: 40 }, { score: 20 }]);

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.equal(result.unresolved, undefined, 'the best conf is live — nothing is unresolved');
  assert.equal(result.finalScore, 40);
  assert.deepEqual(h.calls.putConf.at(-1).conf, { functions: [{ id: 'initial' }] });
});

test('a backend repair-quality failure reports NULL scores, never a fake 0', async () => {
  const source = await readFile(new URL('../scripts/repair-core.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('export async function handleRepairQuality'));

  // The handler's own catch used to answer `startScore: 0, finalScore: 0` — a
  // deploy that was never measured, reported as a pipeline that extracts
  // nothing (Hard Rule 32).
  assert.doesNotMatch(handler, /startScore: 0/);
  assert.doesNotMatch(handler, /finalScore: 0/);
  assert.match(handler, /startScore: null, finalScore: null/);
});

test('an AI estimate is UNSCORED here too — never a score, never saved or published', async () => {
  // The validator still returns its advisory number; the backend scorer used to
  // hand it to `scoreAuthoritative` as a fallback, so a pipeline no deterministic
  // lens could measure came back carrying a confident 95 (Rule 12: AI is
  // advisory, in every run mode).
  const h = harness([{ score: 95, real: false }]);

  const result = await runQualityFlow(EV, {
    qualityThreshold: 80,
    share: { enabled: true, repo: 'org/goldens', branch: 'shared', token: 'token' },
  }, h.deps);

  assert.equal(result.finalScore, null);
  assert.equal(result.startScore, null);
  assert.equal(result.real, false);
  assert.ok(result.error, 'unmeasured says so, rather than reporting the estimate');
  assert.equal(result.stored, false);
  assert.equal(result.storedValue, null);
  assert.equal(h.calls.save.length, 0);
  assert.equal(h.calls.publish.length, 0);
  assertAllScoringIsDeterministic(h.calls);
});

test('a measurement that found nothing missing does not inherit the AI\'s list', async () => {
  const h = harness([{ score: 40 }]);
  h.deps.handleValidatePipeline = async (req, res) => {
    for await (const chunk of req) void chunk;
    res.end(JSON.stringify({
      // No deterministic lens reports fields for `json`, so the measured lists
      // are genuinely EMPTY — and a `length ?` fallback quietly replaced them
      // with the model's, sending repair after fields nothing had measured.
      outputSample: [{ src_ip: '10.11.12.13' }],
      sampleRaw: ['{"src_ip":"10.11.12.13","user":"alice@example.test","action":"blocked-by-policy"}'],
      sampleKeys: ['src_ip', 'user', 'action'],
      findings: [], lessons: [], inputCount: 1, outputCount: 1,
      missingFields: ['imagined_by_the_model'], emptyFields: ['also_imagined'],
    }));
  };

  await runQualityFlow({ ...EV, dest_format: 'json' }, { qualityThreshold: 80 }, h.deps);

  assert.equal(h.calls.repair.length, 1, 'the run did reach a repair round');
  assert.deepEqual(h.calls.repair[0].missingFields, []);
  assert.deepEqual(h.calls.repair[0].emptyFields, []);
});

test('both transports measure from the same inputs — raw events, output events, no estimate', async () => {
  const backend = await readFile(new URL('../scripts/repair-core.mjs', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');

  // The two scorers differ in ONE thing only: how they obtain the preview. What
  // they hand the shared measurement has to be identical, or the same pipeline
  // scores differently depending on where it was scored from.
  for (const [name, source] of [['repair-core.mjs', backend], ['api.ts', browser]]) {
    const call = source.slice(source.indexOf('measureAuthoritative({'));
    const args = call.slice(0, call.indexOf('});') + 1);
    assert.doesNotMatch(args, /aiScore/, `${name} must not hand an estimate to the measurement`);
    assert.match(args, /rawEvents/, `${name} passes the raw sample events`);
    assert.match(args, /outputEvents/, `${name} passes the live output events`);
    assert.doesNotMatch(args, /rawSampleKeys|sampleKeys/, `${name} must not supply its own idea of the keys`);
  }
});

test('sharing asks the publisher for the stored key — the publisher, not the caller, sets the bar', async () => {
  const h = harness([{ score: 80 }]);
  const share = {
    enabled: true,
    repo: 'org/goldens',
    branch: 'shared-goldens',
    token: 'secret',
    author: 'author@example.test',
    build: 552,
  };

  const result = await runQualityFlow(EV, { qualityThreshold: 80, share }, h.deps);

  assert.equal(result.stored, true);
  assert.equal(h.calls.publish.length, 1);
  // `vendor:events` declares no native format and its fixture events are JSON,
  // so the golden is filed under its wire-format variant (src/golden-variant.ts),
  // the same key the local save used.
  assert.equal(h.calls.save[0][6], 'json');
  // The save carries EVIDENCE (golden-trust R1). This engine never saw the sample
  // resolve and the caller sent no provenance, so the tier and the AI-line count
  // are UNKNOWN — the shape the store refuses — never a guessed clean value.
  const evidence = h.calls.save[0][7];
  assert.equal(evidence.score, 80);
  assert.equal(evidence.real, true);
  assert.equal(evidence.scoreSource, 'value-coverage');
  assert.ok(evidence.sampleEventCount > 0);
  assert.equal(evidence.sampleTier, undefined);
  assert.equal(evidence.syntheticCount, null);
  // No score, function list or threshold travels: the publisher reads its own
  // stored record and applies POOL_MIN_SCORE + corroborated standing (R2/R6).
  assert.deepEqual(h.calls.publish[0], {
    repo: share.repo,
    branch: share.branch,
    token: share.token,
    key: `${EV.sourcetype}@json::${EV.dest_format}`,
    author: share.author,
    build: share.build,
  });
});

test('provenance the browser sent reaches the evidence; a refused save is not reported as stored', async () => {
  const h = harness([{ score: 90 }]);
  h.deps.saveGoldenPipeline = (...args) => { h.calls.save.push(clone(args)); return { action: 'refuse', reasons: ['sampleTier must be one of …'] }; };
  const logs = [];
  const result = await runQualityFlow({ ...EV, sample_store_tier: 'vendor', synthetic_count: 2 }, {
    qualityThreshold: 80, share: { enabled: true, repo: 'org/goldens', branch: 'shared', token: 'secret' }, log: e => logs.push(e),
  }, h.deps);
  const evidence = h.calls.save[0][7];
  assert.equal(evidence.sampleTier, 'vendor');
  assert.equal(evidence.syntheticCount, 2);
  assert.equal(result.stored, false, 'a refused write is not knowledge');
  assert.equal(result.storedValue, null);
  assert.equal(h.calls.publish.length, 0, 'nothing refused locally is offered to the pool');
  assert.ok(logs.some(e => e.phase === 'store-skip' && /refused/.test(e.reason)));
});

test('a sharing failure remains best-effort after a successful local save', async () => {
  const h = harness([{ score: 90 }], { publishError: new Error('GitHub unavailable') });
  const logs = [];

  const result = await runQualityFlow(EV, {
    qualityThreshold: 80,
    share: { enabled: true, repo: 'org/goldens', branch: 'shared', token: 'secret' },
    log: (entry) => logs.push(entry),
  }, h.deps);

  assert.equal(result.stored, true);
  assert.equal(result.storedValue, 90);
  assert.equal(h.calls.save.length, 1);
  assert.equal(h.calls.publish.length, 1);
  assert.ok(logs.some((entry) => entry.phase === 'knowledge-error' && entry.error === 'GitHub unavailable'));
});

function handlerRequest(body) {
  const req = Readable.from([JSON.stringify(body)]);
  const lines = [];
  const res = {
    statusCode: 0,
    setHeader() {},
    write(chunk) { lines.push(chunk); },
    end(chunk) { if (chunk) lines.push(chunk); },
  };
  return { req, res, lines };
}

test('deferCommit leaves a repaired flow uncommitted for the batch caller', async () => {
  const h = harness([{ score: 90 }]);
  const flowCalls = [];
  const serverToken = 'server-only-golden-token';
  const io = handlerRequest({
    workerGroup: EV.worker_group,
    packId: EV.pack_id,
    pipelineId: EV.pipeline_id,
    sourcetype: EV.sourcetype,
    destFormat: EV.dest_format,
    sampleName: EV.sample_name,
    qualityThreshold: 83,
    repairModel: 'repair-model',
    shareGoldens: true,
    goldenRepo: 'org/shared-goldens',
    goldenToken: 'untrusted-client-token',
    deferCommit: true,
  });

  await handleRepairQuality(io.req, io.res, {
    runQualityFlow: async (...args) => {
      flowCalls.push(args);
      return { pipeline: EV.pipeline_id, needsDeploy: true };
    },
    getToken: h.deps.getToken,
    commitDeploy: h.deps.commitDeploy,
    getGoldenToken: () => serverToken,
  });

  assert.equal(flowCalls.length, 1);
  assert.deepEqual(flowCalls[0][0], EV);
  const opts = flowCalls[0][1];
  assert.equal(opts.qualityThreshold, 83);
  assert.equal(opts.repairModel, 'repair-model');
  assert.equal(typeof opts.log, 'function');
  const { author, build, ...share } = opts.share;
  assert.equal(typeof author, 'string');
  assert.ok(Number.isInteger(build) && build > 0, 'the build that admitted a golden is recorded with it');
  assert.deepEqual(share, {
    enabled: true,
    repo: 'org/shared-goldens',
    branch: 'shared-goldens',
    token: serverToken,
  });
  assert.equal(Object.hasOwn(opts, 'deferCommit'), false, 'deferCommit belongs to the handler, not runQualityFlow');
  assert.equal(h.calls.commitDeploy.length, 0);
  assert.deepEqual(JSON.parse(io.lines.at(-1)).result, { pipeline: EV.pipeline_id, needsDeploy: true });
  assert.equal(io.lines.join('').includes(serverToken), false, 'server credentials must not be exposed in NDJSON');
  assert.equal(io.lines.join('').includes('untrusted-client-token'), false, 'request credentials must not be reflected');
});

test('non-deferred repaired flow commits and deploys exactly once', async () => {
  const h = harness([{ score: 90 }]);
  const io = handlerRequest({
    workerGroup: EV.worker_group,
    packId: EV.pack_id,
    pipelineId: EV.pipeline_id,
    sourcetype: EV.sourcetype,
    destFormat: EV.dest_format,
    sampleName: EV.sample_name,
    deferCommit: false,
  });

  await handleRepairQuality(io.req, io.res, {
    runQualityFlow: async () => ({ pipeline: EV.pipeline_id, needsDeploy: true }),
    getToken: h.deps.getToken,
    commitDeploy: h.deps.commitDeploy,
    getGoldenToken: () => 'server-only-golden-token',
  });

  assert.deepEqual(h.calls.commitDeploy, [[
    'test-token',
    EV.worker_group,
    `quality-repair ${EV.pipeline_id} in ${EV.pack_id}`,
  ]]);
  assert.ok(io.lines.some((line) => line.includes('"phase":"deployed"') && line.includes('"commit":"commit-1"')));
});

// --- Hard Rule 32: a measurement that failed is not a zero -------------------

test('a preview that failed leaves the run UNSCORED — null scores and an error, never 0', async () => {
  const h = harness([{ score: 90 }]);
  h.deps.handleValidatePipeline = async (req, res) => {
    for await (const chunk of req) void chunk;
    res.end(JSON.stringify({ error: 'the leader rejected the preview' }));
  };

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  // A 0 here is indistinguishable from a pipeline that genuinely extracts
  // nothing, and it is what the dashboard would then average in.
  assert.equal(result.startScore, null);
  assert.equal(result.finalScore, null);
  assert.equal(result.real, false);
  assert.match(result.error, /rejected the preview/);
  assert.equal(result.stored, false);
  assert.equal(result.needsDeploy, false);
  assert.equal(h.calls.repair.length, 0, 'an unmeasured pipeline is not a pipeline to repair');
});

test('a pipeline that drops every event keeps its GENUINE zero, after the shared retries', async () => {
  const waited = [];
  const h = harness([{ score: 0 }]);
  let validations = 0;
  h.deps.sleep = async (ms) => { waited.push(ms); };
  h.deps.handleValidatePipeline = async (req, res) => {
    for await (const chunk of req) void chunk;
    validations++;
    res.end(JSON.stringify({
      outputSample: [], sampleRaw: ['{"src_ip":"10.0.0.1","dest_ip":"10.0.0.2"}'],
      sampleKeys: ['src_ip', 'dest_ip'], findings: [], lessons: [], inputCount: 1, outputCount: 0,
    }));
  };
  h.deps.handleRepairPipeline = async (req, res) => {
    for await (const chunk of req) void chunk;
    res.end(JSON.stringify({ error: 'no repair available in this fixture' }));
  };

  const result = await runQualityFlow(EV, { qualityThreshold: 80 }, h.deps);

  assert.equal(result.startScore, 0, 'dropping every event IS a zero — SOC noise filters do it deliberately');
  assert.equal(result.error, undefined);
  assert.equal(validations, 4, 'one preview plus the three false-zero retries');
  assert.deepEqual(waited, [400, 900, 1600], 'the backoff is injectable, so the suite does not sit through it');
});

test('the backend scorer is the SHARED measurement, not a third approximation', async () => {
  const source = await readFile(new URL('../scripts/repair-core.mjs', import.meta.url), 'utf8');

  // Three implementations of "score a live pipeline" disagreed about which raw
  // keys the spec lens sees and about when a number is real. There is one now.
  assert.match(source, /from '\.\.\/src\/quality-measure\.ts'/);
  assert.match(source, /measureAuthoritative\(/);
  assert.match(source, /previewWithZeroOutputRetry\(/);
  assert.doesNotMatch(source, /const ZERO_OUTPUT_RETRIES\s*=/, 'the retry budget lives in the shared module');
  assert.doesNotMatch(
    source, /function measuredSpecFields/,
    'the spec lens runs once, inside the measurement — not once per AI finding, with different keys',
  );
  assert.doesNotMatch(
    source, /was not extracted\/mapped into the output/,
    'the repair guidance is built once, by repairGuidanceFindings',
  );
});

test('repair lessons are kept only when the repair they informed improved a real score', async () => {
  // Round 1 regresses (rolled back), so the lessons that steered it teach nothing.
  const regress = harness([{ score: 40, lessons: ['use serde for kvp'] }, { score: 30 }]);
  await runQualityFlow(EV, { qualityThreshold: 80 }, regress.deps);
  assert.equal(regress.calls.repair.length, 1);
  assert.deepEqual(regress.calls.lessons, [], 'a repair that did not help leaves no lesson behind');

  // Round 1 improves: the lessons of the validation that triggered it are kept,
  // with the outcome that earned them.
  const helped = harness([{ score: 40, lessons: ['use serde for kvp'] }, { score: 90 }]);
  await runQualityFlow(EV, { qualityThreshold: 80 }, helped.deps);
  assert.equal(helped.calls.lessons.length, 1);
  const [st, fmt, lessons, outcome] = helped.calls.lessons[0];
  assert.equal(st, EV.sourcetype);
  assert.equal(fmt, EV.dest_format);
  assert.deepEqual(lessons, ['use serde for kvp']);
  assert.equal(outcome.before, 40);
  assert.equal(outcome.after, 90);

  // A dry run never writes knowledge of any kind.
  const dry = harness([{ score: 40, lessons: ['x'] }, { score: 90 }]);
  await runQualityFlow(EV, { qualityThreshold: 80, dryRun: true }, dry.deps);
  assert.deepEqual(dry.calls.lessons, []);
});
