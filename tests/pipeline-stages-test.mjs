import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  splitPipelineFunctions, splicePipelineStage, assemblePipelineFunctions, inferFromPipelineId,
  withoutOutputCompaction, validateExtractionStage, validateMappingInputs, averageStageScores,
  resolveDetectedSourcetype, shouldAcceptCombinedCandidate, canScoreOptimization,
} from '../src/pipeline-stages.ts';

const ext = [{ id: 'regex_extract', conf: { regex: '/x/' } }, { id: 'serde', conf: { mode: 'extract', type: 'kvp' } }];
const opt = [{ id: 'drop', conf: { filter: 'false' } }];
const map = [{ id: 'eval', conf: { add: [{ name: 'src_ip', value: 'src_ip' }] } }];

test('assemble order is extraction → mapping → optimization', () => {
  const all = assemblePipelineFunctions({ extraction: ext, mapping: map, optimization: opt });
  assert.deepEqual(all.map(f => f.id), ['regex_extract', 'serde', 'eval', 'drop']);
});

test('assembling from checkpointed stage functions is deterministic', () => {
  // A resumed staged build re-assembles the final pipeline from the three
  // CHECKPOINTED stage function lists rather than from the optimization stage's
  // in-memory result. That is only safe because assembly is a pure concatenation
  // in a fixed order: two assemblies of the same checkpoint must be identical,
  // or a resumed finalize would deploy a pipeline nothing ever scored.
  const once = assemblePipelineFunctions({ extraction: ext, mapping: map, optimization: opt });
  const twice = assemblePipelineFunctions({ extraction: ext, mapping: map, optimization: opt });
  assert.deepEqual(once, twice);
  assert.deepEqual(once, [...ext, ...map, ...opt]);
  // And it must not mutate the checkpointed lists it was handed.
  assert.equal(ext.length, 2);
  assert.equal(map.length, 1);
  assert.equal(opt.length, 1);
});

test('split recovers the three stages from a pack-generator-shaped conf', () => {
  const split = splitPipelineFunctions([...ext, ...map, ...opt]);
  assert.equal(split.extraction.length, 2);
  assert.equal(split.optimization.length, 1);
  assert.equal(split.mapping.length, 1);
});

test('splice replaces only the ticked stage', () => {
  const baseline = assemblePipelineFunctions({ extraction: ext, mapping: map, optimization: opt });
  const newMap = [{ id: 'eval', conf: { add: [{ name: 'dest_ip', value: 'dest_ip' }] } }];
  const next = splicePipelineStage(baseline, 'mapping', newMap);
  const split = splitPipelineFunctions(next);
  assert.deepEqual(split.extraction, ext);
  assert.deepEqual(split.optimization, opt);
  assert.deepEqual(split.mapping, newMap);
});

test('splice mapping drops stale compact and keeps drops after mapping', () => {
  const noise = { id: 'drop', conf: { filter: 'false' } };
  const compact = {
    id: 'eval',
    conf: {
      add: [{ name: 'sourcetype', value: "'cisco:asa'" }],
      keep: ['_time', 'sourcetype', 'src_ip'],
    },
  };
  const baseline = [...ext, ...map, noise, compact];
  const newMap = [{ id: 'eval', conf: { add: [{ name: 'dest_ip', value: 'src_ip' }] } }];

  const next = splicePipelineStage(baseline, 'mapping', newMap);
  const split = splitPipelineFunctions(next);

  assert.deepEqual(split.extraction, ext);
  assert.deepEqual(split.optimization, [noise]);
  assert.deepEqual(split.mapping, newMap);
  assert.deepEqual(next, [...ext, ...newMap, noise]);
});

test('splice optimization always appends after mapping (never mid-pipeline)', () => {
  const midCompact = {
    id: 'serialize',
    conf: { type: 'json', dstField: '_raw', fields: ['*'] },
  };
  // Broken live order: ext → map → compact → more map
  const lateMap = { id: 'eval', conf: { add: [{ name: 'src', value: 'src_ip' }] } };
  const baseline = [...ext, ...map, midCompact, lateMap];
  const newOpt = [
    { id: 'drop', conf: { filter: 'false' } },
    { id: 'serialize', conf: { type: 'json', dstField: '_raw', fields: ['!_raw', '*'] } },
    { id: 'eval', conf: { remove: ['*'], keep: ['_raw', '_time'] } },
  ];
  const next = splicePipelineStage(baseline, 'optimization', newOpt);
  // Mid serialize stripped from mapping; both map evals kept; opt at end.
  assert.deepEqual(next.map(f => f.id), ['regex_extract', 'serde', 'eval', 'eval', 'drop', 'serialize', 'eval']);
  const firstOpt = next.findIndex(f => f.id === 'drop');
  const lastMap = next.map(f => f.conf?.add?.[0]?.name).lastIndexOf?.('src')
    ?? next.findIndex(f => f.conf?.add?.[0]?.name === 'src');
  assert.ok(firstOpt > lastMap, 'optimization must start after all mapping');
});

test('withoutOutputCompaction strips nested-_raw serialize stages', () => {
  const fns = [
    ...map,
    { id: 'serialize', conf: { type: 'json', dstField: '_raw', fields: ['*'] } },
  ];
  assert.deepEqual(withoutOutputCompaction(fns), map);
});

test('extraction contract accepts parser functions and canonical aliases', () => {
  const parser = [
    { id: 'serde', conf: { mode: 'extract', type: 'json', srcField: '_raw' } },
    {
      id: 'eval',
      conf: {
        add: [
          { name: 'src_ip', value: 'clientip || srcip' },
          { name: 'dest_ip', value: 'serverip || dstip' },
        ],
      },
    },
  ];

  assert.deepEqual(validateExtractionStage(parser), { valid: true, reasons: [] });
});

test('extraction contract quarantines a combined OCSF schematizer pipeline', () => {
  const combined = [
    { id: 'serde', conf: { mode: 'extract', type: 'json', srcField: '_raw' } },
    {
      id: 'eval',
      description: 'Map parsed Zscaler fields to OCSF HTTP Activity',
      conf: {
        add: [
          { name: 'category_uid', value: '4' },
          { name: 'class_uid', value: '4002' },
          { name: 'http_request', value: '{ url: url }' },
          { name: 'src_endpoint', value: '{ ip: clientip }' },
        ],
        remove: ['_raw', 'parsed'],
      },
    },
  ];

  const result = validateExtractionStage(combined);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(reason => reason.includes('destination schema field')));
  assert.ok(result.reasons.some(reason => reason.includes('removes _raw')));
});

test('extraction contract rejects output compaction and destination-specific field names', () => {
  const result = validateExtractionStage([
    {
      id: 'eval',
      conf: {
        add: [
          { name: 'DeviceVendor', value: "'Zscaler'" },
          { name: 'ecs.version', value: "'8.11.0'" },
          { name: 'principal.ip', value: 'clientip' },
          { name: 'src_endpoint.ip', value: 'clientip' },
        ],
      },
    },
    { id: 'serialize', conf: { type: 'json', dstField: '_raw', fields: ['*'] } },
  ]);

  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(reason => reason.includes('DeviceVendor')));
  assert.ok(result.reasons.some(reason => reason.includes('ecs.version')));
  assert.ok(result.reasons.some(reason => reason.includes('principal.ip')));
  assert.ok(result.reasons.some(reason => reason.includes('src_endpoint.ip')));
  assert.ok(result.reasons.some(reason => reason.includes('serializes output')));
});

test('mapping input contract accepts references to populated extraction fields', () => {
  const result = validateMappingInputs(
    [{ id: 'eval', conf: { add: [{ name: 'SourceIP', value: 'src_ip || client_ip' }] } }],
    [{ src_ip: '10.20.30.40', dest_ip: '' }],
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.populatedFields, ['src_ip']);
  assert.deepEqual(result.matchedFields, ['src_ip']);
});

test('mapping input contract rejects a stale map with zero populated-field overlap', () => {
  const result = validateMappingInputs(
    [{
      id: 'eval',
      conf: {
        add: [
          { name: 'SourceIP', value: 'src_endpoint.ip' },
          { name: 'DeviceVendor', value: "'Zscaler'" },
        ],
      },
    }],
    [{ src_ip: '10.20.30.40', dest_ip: '203.0.113.40' }],
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.matchedFields, []);
  assert.match(result.reason, /reads none of 2 populated extraction fields/);
});

test('mapping input contract considers populated values across every extraction event', () => {
  const result = validateMappingInputs(
    [{ id: 'eval', conf: { add: [{ name: 'DestinationIP', value: 'dest_ip' }] } }],
    [{ src_ip: '10.20.30.40', dest_ip: '' }, { dest_ip: '203.0.113.40' }],
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.matchedFields, ['dest_ip']);
});

test('overall stage score is the average of extraction and mapping', () => {
  assert.equal(averageStageScores(97, 88), 93);
  assert.equal(averageStageScores(97, null), 97);
  assert.equal(averageStageScores(null, null), null);
});

test('combined candidates must pass both independent stage thresholds', () => {
  assert.equal(shouldAcceptCombinedCandidate(8, 6, 80, 80), false);
  assert.equal(shouldAcceptCombinedCandidate(100, 85, 80, 80), true);
  assert.equal(shouldAcceptCombinedCandidate(null, 90, 80, 80), false);
  assert.equal(shouldAcceptCombinedCandidate(100, null, 80, 80), false);
});

test('optimization quality is blocked until both upstream stages pass', () => {
  assert.equal(canScoreOptimization(8, 6, 80, 80), false);
  assert.equal(canScoreOptimization(100, 85, 80, 80), true);
  assert.equal(canScoreOptimization(100, null, 80, 80), false);
});

test('detection suggests but never overwrites an explicit sourcetype', () => {
  assert.deepEqual(
    resolveDetectedSourcetype('zscaler_web', 'palo_alto_traffic', true),
    { selected: 'zscaler_web', adopt: false },
  );
  assert.deepEqual(
    resolveDetectedSourcetype('', 'palo_alto_traffic', false),
    { selected: 'palo_alto_traffic', adopt: true },
  );
  assert.deepEqual(
    resolveDetectedSourcetype('old_auto_guess', 'palo_alto_traffic', false),
    { selected: 'palo_alto_traffic', adopt: true },
  );
});

test('inferFromPipelineId parses sourcetype_to_dest', () => {
  assert.deepEqual(inferFromPipelineId('cisco_asa_to_cim'), { sourcetype: 'cisco_asa', destFormat: 'cim' });
  assert.deepEqual(inferFromPipelineId('okta_to_asim_authentication'), { sourcetype: 'okta', destFormat: 'asim#authentication' });
  assert.deepEqual(inferFromPipelineId('palo_to_cim_network'), { sourcetype: 'palo', destFormat: 'cim#network' });
  assert.deepEqual(inferFromPipelineId('sysmon_to_ocsf_endpoint'), { sourcetype: 'sysmon', destFormat: 'ocsf#endpoint' });
  assert.deepEqual(inferFromPipelineId('zscaler_to_commonsecuritylog'), { sourcetype: 'zscaler', destFormat: 'commonsecuritylog' });
  assert.equal(inferFromPipelineId('not-a-pipeline'), null);
});
