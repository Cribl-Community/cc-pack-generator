// Sentinel native-table destinations shipped the wrong event shape and a fake 0
// (build 456). Found on pack `aaaaa` in seLab: aws_vpc_flow → AWSVPCFlow + CIM.
//
// Four independent defects, one deployed pipeline:
//   1. The DCR shaping step existed in getCompactOutputFunctions but the 3-stage
//      builder's gate only let non-schema formats and CIM reach it, so the pack
//      shipped the original text `_raw` plus ~25 vendor/canonical intermediates
//      alongside the 15 table columns. A DCR drops/rejects unknown columns.
//   2. That shaping step removed `_*`, which takes `_time` with it.
//   3. No spec matched a Sentinel table, so the mapping stage was NOT MEASURABLE —
//      and the builder published "not measurable" as a hard 0, which also became
//      the pack's deployment score.
//   4. The `_time`-from-`log_time` assignment ran AFTER the mapping chunks, so
//      `TimeGenerated` (which reads `_time`) got the ingest time: the deployed pack
//      stamped 11:45:28 on a flow that started 11:42:44.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  getCompactOutputFunctions,
  scoreSentinelTableCoverage,
  buildAiMappingFunctions,
  isSentinelFamilyFormat,
  SENTINEL_TIME_GENERATED_EXPR,
} from '../src/pack-builder.ts';
import { resolveSentinelTable } from '../src/sentinel-knowledge.ts';

const timeGeneratedFn = fns => fns.find(f => (f.conf?.add || []).some(a => a.name === 'TimeGenerated'));
const timeGeneratedExpr = fns => timeGeneratedFn(fns)?.conf.add.find(a => a.name === 'TimeGenerated').value;

const read = p => readFileSync(new URL(p, new URL('../', import.meta.url)), 'utf8');

// The real deployed sample lines and the real deployed mapping output, verbatim
// from pack `aaaaa` (only two events kept).
const RAW = [
  '2 653974103901 eni-45da0770 209.109.101.143 10.205.34.177 57429 3389 17 99 422117 1786621364 1786621507 ACCEPT OK',
  '2 674408302279 eni-2b24da7b 133.202.9.149 10.70.160.36 56624 80 17 30 22587 1786621379 1786621507 ACCEPT OK',
];

const mappedEvent = (raw, acct, eni, src, dst, sp, dp, pkts, bytes, start, end) => ({
  // untouched original raw + the extraction stage's vendor/canonical fields …
  _raw: raw, _time: Number(start), version: '2', account_id: acct, interface_id: eni,
  src_ip: src, dest_ip: dst, src_port: sp, dest_port: dp, ip_protocol: '17', packets: pkts,
  bytes, start, end, action: 'allowed', log_status: 'OK', log_time: Number(start),
  duration: 143, transport: 'udp', protocol: 'udp', bytes_out: bytes, packets_out: pkts,
  dev_id: eni, vendor: 'AWS', product: 'VPC Flow Logs', vendor_product: 'AWS VPC Flow Logs',
  // … and the Sentinel columns on top of them.
  event_type: 'AWSVPCFlow', Version: 2, AccountId: acct, InterfaceId: eni, SrcAddr: src,
  DstAddr: dst, SrcPort: sp, DstPort: dp, Protocol: 17, Packets: pkts, Bytes: bytes,
  Start: new Date(Number(start) * 1000).toISOString(), End: new Date(Number(end) * 1000).toISOString(),
  Action: 'allowed', LogStatus: 'OK', TimeGenerated: new Date(Number(end) * 1000).toISOString(),
  sourcetype: 'aws_vpc_flow',
});

const MAPPED = [
  mappedEvent(RAW[0], '653974103901', 'eni-45da0770', '209.109.101.143', '10.205.34.177', 57429, 3389, 99, 422117, '1786621364', '1786621507'),
  mappedEvent(RAW[1], '674408302279', 'eni-2b24da7b', '133.202.9.149', '10.70.160.36', 56624, 80, 30, 22587, '1786621379', '1786621507'),
];

// Apply an eval keep/remove step the way Cribl would.
const applyShaping = (fns, events) => {
  const keep = new Set((fns[0]?.conf?.keep || []));
  return events.map(e => Object.fromEntries(Object.entries(e).filter(([k]) => keep.has(k))));
};

test('a Sentinel native table gets a DCR shaping step', () => {
  const fns = getCompactOutputFunctions('aws_vpc_flow', 'AWSVPCFlow', true, Object.keys(MAPPED[0]));
  assert.ok(fns.length >= 1, 'no shaping step emitted for a Sentinel table');
  const shape = fns[0];
  assert.equal(shape.id, 'eval');
  assert.deepEqual(shape.conf.remove, ['*', '__*', '_*', 'cribl_*']);
  const table = resolveSentinelTable('AWSVPCFlow');
  for (const col of table.table.columns.map(c => c.name)) {
    assert.ok(shape.conf.keep.includes(col), `table column ${col} is not kept`);
  }
});

test('the shaping step keeps _time — `_*` would otherwise delete it', () => {
  // A Sentinel event with no _time has lost its event time in Cribl entirely.
  const fns = getCompactOutputFunctions('aws_vpc_flow', 'AWSVPCFlow', true, []);
  assert.ok(fns[0].conf.keep.includes('_time'), '_time must be kept back from the `_*` removal');
  const shaped = applyShaping(fns, MAPPED);
  assert.equal(shaped[0]._time, 1786621364);
});

test('shaping leaves the table columns and drops every intermediate', () => {
  const fns = getCompactOutputFunctions('aws_vpc_flow', 'AWSVPCFlow', true, Object.keys(MAPPED[0]));
  const shaped = applyShaping(fns, MAPPED);
  // The columns survive …
  for (const col of ['Version', 'AccountId', 'SrcAddr', 'DstPort', 'Protocol', 'Bytes', 'Action', 'TimeGenerated']) {
    assert.ok(col in shaped[0], `${col} must reach the DCR`);
  }
  // … and none of the vendor/canonical intermediates do. These are exactly the
  // fields the DCR would reject or silently drop.
  for (const leak of ['_raw', 'src_ip', 'dest_ip', 'ip_protocol', 'log_time', 'transport', 'bytes_out', 'dev_id', 'vendor', 'product', 'vendor_product', 'event_type', 'duration']) {
    assert.ok(!(leak in shaped[0]), `${leak} leaked into the Sentinel payload`);
  }
});

test('CommonSecurityLog still shapes the way it always did', () => {
  // The gate change must not alter the format that already worked.
  const fns = getCompactOutputFunctions('cisco_asa', 'commonsecuritylog', true, []);
  assert.ok(fns.length >= 1);
  assert.ok(fns[0].conf.keep.includes('DeviceVendor'));
  assert.ok(fns[0].conf.keep.includes('_time'));
});

// --- mapping is measurable -----------------------------------------------------

test('a Sentinel table mapping is scorable at all', () => {
  // This is the "M 0" fix: the stage used to have no lens and came back
  // unmeasurable, which the builder then published as a failure.
  const s = scoreSentinelTableCoverage('AWSVPCFlow', MAPPED, RAW);
  assert.ok(s, 'no result for a known Sentinel table');
  assert.equal(s.supported, true, 'mapping must be measurable');
  assert.equal(s.table, 'AWSVPCFlow');
  assert.ok(s.score > 60, `expected a real score for a correct mapping, got ${s.score}`);
  assert.ok(s.columnsPopulated >= 14, `expected the mapped columns to be counted, got ${s.columnsPopulated}`);
});

test('only values that land in a real table column count', () => {
  // The whole point of the projection: a pipeline can populate 30 fields, but if
  // they are not table columns the DCR never sees them.
  const intermediatesOnly = MAPPED.map(e => {
    const out = {};
    for (const [k, v] of Object.entries(e)) if (!/^[A-Z]/.test(k)) out[k] = v;
    return out;
  });
  const s = scoreSentinelTableCoverage('AWSVPCFlow', intermediatesOnly, RAW);
  assert.equal(s.columnsPopulated, 0, 'no table column was populated');
  assert.equal(s.score, 0, 'values sitting in non-column fields must earn nothing');
});

test('the score cannot self-select its way to 100', () => {
  // A single constant column must not read as a complete mapping — the
  // denominator is the SAMPLE's values, never the fields we chose to fill.
  const oneConstant = MAPPED.map(() => ({ SourceSystem: 'AWS' }));
  const s = scoreSentinelTableCoverage('AWSVPCFlow', oneConstant, RAW);
  assert.ok(s.score < 20, `a one-constant mapping scored ${s.score}`);
});

test('empty values do not count as populated columns', () => {
  const blank = MAPPED.map(() => ({ SrcAddr: '', DstAddr: null, AccountId: undefined }));
  const s = scoreSentinelTableCoverage('AWSVPCFlow', blank, RAW);
  assert.equal(s.columnsPopulated, 0);
});

test('a non-Sentinel destination returns null, not a score', () => {
  // Otherwise this lens would shadow the CIM/OCSF spec scorers.
  for (const fmt of ['cim', 'ocsf', 'ecs', 'json', '']) {
    assert.equal(scoreSentinelTableCoverage(fmt, MAPPED, RAW), null, `${fmt} must not resolve to a Sentinel table`);
  }
});

// --- _time ordering ------------------------------------------------------------

test('_time is set BEFORE the mapping chunks so schema time columns read event time', () => {
  const fns = buildAiMappingFunctions(
    {
      mappings: [
        // Exactly what the deployed pack did: derive the destination's time column
        // from _time.
        { destField: 'TimeGenerated', expression: "_time ? new Date(Number(_time)*1000).toISOString() : ''" },
        { destField: 'SrcAddr', expression: 'src_ip' },
      ],
      classInfo: null,
    },
    'aws_vpc_flow', 'AWSVPCFlow', 'aws_vpc_flow',
  );
  const timeIdx = fns.findIndex(f => (f.conf?.add || []).some(a => a.name === '_time'));
  const mapIdx = fns.findIndex(f => (f.conf?.add || []).some(a => a.name === 'TimeGenerated'));
  assert.ok(timeIdx >= 0, 'the _time assignment must still be emitted');
  assert.ok(mapIdx >= 0, 'the mapping chunk must still be emitted');
  assert.ok(timeIdx < mapIdx,
    `_time is set at ${timeIdx} but read by the mapping at ${mapIdx} — the mapping sees ingest time`);
  // And it must still read log_time (Hard Rule 8), not invent its own source.
  const expr = fns[timeIdx].conf.add.find(a => a.name === '_time').value;
  assert.match(expr, /log_time/);
});

test('the source-native sourcetype is still emitted after the mapping', () => {
  // It was in the same block as the moved _time assignment; moving one must not
  // take the other with it.
  const fns = buildAiMappingFunctions(
    { mappings: [{ destField: 'SrcAddr', expression: 'src_ip' }], classInfo: null },
    'aws_vpc_flow', 'AWSVPCFlow', 'aws:vpcflow',
  );
  const st = fns.find(f => (f.conf?.add || []).some(a => a.name === 'sourcetype'));
  assert.ok(st, 'sourcetype assignment lost');
  assert.equal(st.conf.add.find(a => a.name === 'sourcetype').value, "'aws:vpcflow'");
});

// --- builder wiring ------------------------------------------------------------
// These read src/staged-build.ts, where the 3-stage builder has lived since
// build 712. Not a concatenation with App.tsx: the point of a source-scoped
// assertion is to pin WHERE the logic lives, and a concat is satisfied by a
// browser-only copy just as happily as by the one shared builder.

test('the 3-stage builder routes Sentinel tables to the shaping step', () => {
  // The shaping step existed and was correct; the gate simply never called it for
  // a schema format other than CIM.
  const src = read('src/staged-build.ts');
  assert.match(src, /const isSentinelTableDest = !!resolveSentinelTable\(destFormat\)/,
    'computeCompact must recognise a Sentinel table destination');
  assert.match(src, /const shapingIsStructural = isCimMandatory \|\| isSentinelTableDest/);
  assert.doesNotMatch(src, /\(!isSchema \|\| destFormat === 'cim'\)/,
    'the old CIM-only shaping gate is back — Sentinel packs will ship unshaped');
});

test('"not measurable" is reported as such, never as 0', () => {
  // scoreStage already returned null for an unmeasurable stage (the comment above
  // it says NOT MEASURABLE ≠ FAILED) — and then both candidate loops flattened it
  // with `?? 0`, which is how a Sentinel pack reported M 0 and logged a
  // deployment score of 0.
  const src = read('src/staged-build.ts');
  assert.match(src, /score: s\.score \?\? 0, scoreRaw: s\.score/g,
    'candidates must keep the unflattened score for reporting');
  assert.match(src, /\{ score: best1\.scoreRaw,/, 'extraction must report scoreRaw');
  assert.match(src, /s2 = \{ score: best2!\.scoreRaw,/, 'mapping must report scoreRaw');
  assert.match(src, /s1 = \{ score: scored\.scoreRaw,/, 'the extraction retry must report scoreRaw too');
  assert.doesNotMatch(src, /\{ score: best1\.score,/, 'extraction is reporting the ranking score again');
  assert.doesNotMatch(src, /s2 = \{ score: best2!\.score,/, 'mapping is reporting the ranking score again');
});

test('the mapping scorer falls back to the Sentinel lens', () => {
  const src = read('src/staged-build.ts');
  assert.match(src, /const sent = scoreSentinelTableCoverage\(destFormat, outputEvents, extractedLines\)/);
  // It must come AFTER the golden and canonical-spec lenses, so CommonSecurityLog
  // keeps using its golden spec.
  const sentIdx = src.indexOf('scoreSentinelTableCoverage(destFormat, outputEvents, extractedLines)');
  const goldenIdx = src.indexOf('const golden = scoreGoldenSpecCoverage(');
  assert.ok(goldenIdx > 0 && goldenIdx < sentIdx, 'the Sentinel lens must not shadow the golden spec lens');
});

// --- P0a: forced TimeGenerated on the AI path ---------------------------------

test('isSentinelFamilyFormat covers every Log Analytics table, not CIM/OCSF/CEF', () => {
  for (const f of ['sentinel', 'commonsecuritylog', 'asim', 'asim#authentication', 'asim#dns'])
    assert.ok(isSentinelFamilyFormat(f), `${f} should be Sentinel-family`);
  for (const f of ['cim', 'cim#authentication', 'ocsf', 'ecs', 'cef', 'json', ''])
    assert.ok(!isSentinelFamilyFormat(f), `${f} must NOT be Sentinel-family`);
});

test('TimeGenerated is FORCED for a Sentinel pack even when the AI omits it', () => {
  // The reported defect: many Sentinel packs had no TimeGenerated because the AI
  // mapping simply never emitted it.
  const fns = buildAiMappingFunctions(
    { mappings: [{ destField: 'SrcIpAddr', expression: 'src_ip' }], classInfo: null },
    'cisco_asa', 'sentinel', 'cisco:asa',
  );
  assert.ok(timeGeneratedFn(fns), 'TimeGenerated must be forced even when the AI omitted it');
  assert.equal(timeGeneratedExpr(fns), SENTINEL_TIME_GENERATED_EXPR,
    'the forced TimeGenerated must use the shared robust golden expression');
});

test('the forced TimeGenerated WINS over a fragile AI-supplied one (runs last)', () => {
  const fns = buildAiMappingFunctions(
    {
      mappings: [
        { destField: 'TimeGenerated', expression: "_time ? new Date(_time*1000).toISOString() : ''" },
        { destField: 'SrcIpAddr', expression: 'src_ip' },
      ],
      classInfo: null,
    },
    'cisco_asa', 'commonsecuritylog', 'cisco:asa',
  );
  // The AI chunk sets TimeGenerated first; the forced eval must come AFTER it so
  // the deterministic value is the one that survives.
  const aiIdx = fns.findIndex(f => (f.conf?.add || []).some(a => a.name === 'TimeGenerated' && a.value !== SENTINEL_TIME_GENERATED_EXPR));
  const forcedIdx = fns.findIndex(f => (f.conf?.add || []).some(a => a.name === 'TimeGenerated' && a.value === SENTINEL_TIME_GENERATED_EXPR));
  assert.ok(forcedIdx >= 0, 'the forced TimeGenerated must be present');
  assert.ok(aiIdx >= 0 && aiIdx < forcedIdx, 'the forced TimeGenerated must run after the AI one');
});

test('TimeGenerated is NOT injected for a non-Sentinel schema (CIM/OCSF)', () => {
  for (const dest of ['cim', 'ocsf', 'ecs']) {
    const fns = buildAiMappingFunctions(
      { mappings: [{ destField: 'src', expression: 'src_ip' }], classInfo: null },
      'cisco_asa', dest, 'cisco:asa',
    );
    assert.ok(!timeGeneratedFn(fns), `${dest} must not get a Sentinel TimeGenerated column`);
  }
});

// --- P1a: reject synthetic message concatenation ------------------------------

test('a synthetic `message` built from 2+ source fields is dropped', () => {
  const fns = buildAiMappingFunctions(
    {
      mappings: [
        { destField: 'message', expression: "src_ip + ':' + src_port + ' -> ' + dest_ip" },
        { destField: 'SrcIpAddr', expression: 'src_ip' },
      ],
      classInfo: null,
    },
    'cisco_asa', 'asim#network', 'cisco:asa',
  );
  const emitsMessage = fns.some(f => (f.conf?.add || []).some(a => a.name === 'message'));
  assert.ok(!emitsMessage, 'a multi-field message concat must be dropped');
  const emitsSrc = fns.some(f => (f.conf?.add || []).some(a => a.name === 'SrcIpAddr'));
  assert.ok(emitsSrc, 'the legitimate dedicated field must survive');
});

test('a single-field message (or field||fallback) is kept', () => {
  const fns = buildAiMappingFunctions(
    {
      mappings: [
        { destField: 'message', expression: "msg || raw_message" },
        { destField: 'Message', expression: "event_description + ' (details)'" },
      ],
      classInfo: null,
    },
    'cisco_asa', 'asim#network', 'cisco:asa',
  );
  const msg = fns.some(f => (f.conf?.add || []).some(a => a.name === 'message'));
  const Msg = fns.some(f => (f.conf?.add || []).some(a => a.name === 'Message'));
  assert.ok(msg, 'a `field || fallback` message is a single-source value — keep it');
  assert.ok(Msg, 'a `field + literal` message is not a multi-field concat — keep it');
});

// --- P1b: shape-guard IP columns ----------------------------------------------

test('an IP column is wrapped so a URL/hostname cannot land in it', () => {
  const fns = buildAiMappingFunctions(
    { mappings: [{ destField: 'DestinationIP', expression: 'url || dest_ip' }], classInfo: null },
    'cisco_asa', 'commonsecuritylog', 'cisco:asa',
  );
  const add = fns.flatMap(f => f.conf?.add || []).find(a => a.name === 'DestinationIP');
  assert.ok(add, 'DestinationIP must still be emitted');
  assert.match(add.value, /\.test\(String\(/, 'the IP column must be shape-guarded');
  assert.match(add.value, /\?\s*\(url \|\| dest_ip\)\s*:\s*undefined/, 'a non-IP value must resolve to undefined');
});

test('a non-IP column is left untouched (no guard wrapper)', () => {
  const fns = buildAiMappingFunctions(
    { mappings: [{ destField: 'DestinationHostName', expression: 'dest_host' }], classInfo: null },
    'cisco_asa', 'commonsecuritylog', 'cisco:asa',
  );
  const add = fns.flatMap(f => f.conf?.add || []).find(a => a.name === 'DestinationHostName');
  assert.equal(add.value, 'dest_host', 'a hostname column must not be IP-guarded');
});
