// SCORER PROPERTY TEST — the systemic guard for value-coverage scoring.
//
// Why this file exists: pack `aa` (f5_bigip) reported extraction 0 on all six
// destinations while its pipelines were, in fact, correct. The cause was not the
// pipeline but the SCORER: `collectSampleValues` mis-read the syslog priority
// prefix `<134>` as XML markup, took the XML branch, found no element text and no
// attribute values, and returned ZERO values. `scoreValueCoverage` then reported
// `supported:false, score:0` — an unmeasurable stage rendered as a hard failure.
//
// It affected 59 of the 632 bundled samples (every PRI-prefixed source: Cisco
// ASA, all PAN variants, FortiGate, F5, Meraki, Zscaler, CEF/LEEF over syslog,
// ESXi/NSX…) and, on MIXED samples, silently shrank the denominator to the
// non-PRI lines instead — which distorts scores UPWARD and looks legitimate
// (cisco_asa_all was graded on 10 of its 46 values, and would score ~100 for
// handling one line well and seven badly).
//
// The properties under test are the ones that make the class of bug impossible:
//   1. No sample may yield an EMPTY denominator — that's the fake 0.
//   2. Most lines of a sample must contribute values — that's the fake high score.
// Both are exact, hold for future sourcetypes with no new cases, and turn "find
// out six months later on a customer pack" into a red CI run.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { classifyRawLine, scoreValueCoverage, explainValueCoverageGaps, scoreSchemaMappingFromExtraction, shapeMappedEventForDisplay, validateOutputAgainstSpec, scoreAuthoritative } from '../src/pack-builder.ts';

const root = new URL('../', import.meta.url);
const libDir = new URL('config/sample-library/', root);

// Samples that legitimately carry no mappable values at all. Keep this list
// SHORT and justified — it is the only escape hatch, and a new entry means
// someone added a sample with no data in it.
const NO_VALUE_SAMPLES = new Set([
  // A one-line placeholder ("Masking Example") — a title, not an event.
  'masking_example/Masking_Example.json',
]);

// A probe output that deliberately contains none of the sample's values. We are
// asserting on the DENOMINATOR (`totalValues`), not on the score, so the output
// only has to be well-formed.
const PROBE_OUTPUT = [{ probe: 'no-sample-values-here' }];

function loadSamples() {
  const out = [];
  for (const dir of readdirSync(libDir)) {
    const dirUrl = new URL(`${dir}/`, libDir);
    let entries;
    try {
      if (!statSync(dirUrl).isDirectory()) continue;
      entries = readdirSync(dirUrl);
    } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      let parsed;
      try { parsed = JSON.parse(readFileSync(new URL(file, dirUrl), 'utf8')); } catch { continue; }
      const events = Array.isArray(parsed) ? parsed : (parsed.events || parsed.samples || []);
      // Keep a non-string `_raw` as-is: a few samples store already-parsed XML as
      // an object, and stringifying it here would hide whether the scorer copes.
      const lines = events
        .map(e => (e && typeof e === 'object' && '_raw' in e ? e._raw : e))
        .filter(l => (typeof l === 'string' ? l.trim() : l != null))
        .slice(0, 8);
      if (lines.length) out.push({ name: `${dir}/${file}`, lines });
    }
  }
  return out;
}

const samples = loadSamples();

test('the sample library is present and non-trivial', () => {
  assert.ok(samples.length >= 500, `expected >=500 library samples, found ${samples.length}`);
});

test('no sample yields an EMPTY denominator (the fake 0)', () => {
  const empty = samples
    .filter(s => !NO_VALUE_SAMPLES.has(s.name))
    .filter(s => scoreValueCoverage(s.lines, PROBE_OUTPUT, true).totalValues === 0)
    .map(s => s.name);
  assert.deepEqual(empty, [], 'an empty denominator makes the stage unscorable, which is reported as a hard 0:\n  ' + empty.join('\n  '));
});

test('no sample is scored against a FRACTION of its lines (the fake high score)', () => {
  // Individual valueless lines are legitimate (a CSV header row, a bare `}` from a
  // pretty-printed JSON sample, an empty `result_count:0` response). A sample
  // where MOST lines contribute nothing is the shrunken-denominator pathology.
  const bad = [];
  for (const s of samples) {
    if (NO_VALUE_SAMPLES.has(s.name)) continue;
    const live = s.lines.filter(l => scoreValueCoverage([l], PROBE_OUTPUT, true).totalValues > 0).length;
    if (live * 2 < s.lines.length) bad.push(`${s.name}: only ${live}/${s.lines.length} lines contribute any value`);
  }
  assert.deepEqual(bad, [], 'these samples are graded on a fraction of their own data:\n  ' + bad.join('\n  '));
});

// --- classifyRawLine: the ONE format detector -------------------------------
// Mutation guards. Revert the digit rule or the envelope strip and each fails.

test('a syslog priority prefix is envelope, not XML', () => {
  const line = '<134>Jan 15 08:23:41 bigip-lb01 notice tmm1[12345]: 01260013:5: SSL Handshake failed for TCP 10.20.30.15:8443';
  const c = classifyRawLine(line);
  assert.equal(c.format, 'unstructured', 'a PRI-prefixed syslog line must not be classified as XML');
  assert.ok(!c.body.startsWith('<134>'), 'the priority prefix must be stripped from the body');
});

test('real XML is still classified as XML', () => {
  const c = classifyRawLine("<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>4624</EventID></System></Event>");
  assert.equal(c.format, 'xml');
});

test('the priority prefix does not hide a wrapped payload', () => {
  assert.equal(classifyRawLine('<134>{"src_ip":"10.1.1.1","action":"allow"}').format, 'json');
  assert.equal(classifyRawLine('<134>date=2024-01-15 devname=fw1 srcip=10.1.1.1').format, 'kvp');
  assert.equal(classifyRawLine('<134>CEF:0|F5|BIGIP|1.0|100|Denied|5|src=10.1.1.1 dst=10.2.2.2').format, 'kvp');
});

test('a PRI-only syslog line produces a real denominator', () => {
  const lines = ['<134>Jan 15 08:23:41 bigip-lb01 notice tmm1[12345]: 01260013:5: SSL Handshake failed for TCP 10.20.30.15:8443 -> 10.20.30.99'];
  const r = scoreValueCoverage(lines, PROBE_OUTPUT, true);
  assert.equal(r.supported, true);
  assert.ok(r.totalValues >= 5, `expected a real denominator, got ${r.totalValues}`);
});

test('a branch that harvests nothing falls back to atoms', () => {
  // Two trivial kv pairs (`u=0 p=1`) made the kvp branch claim this line; both
  // values were then dropped as small-integer noise, leaving it valueless.
  const lines = ['<134>Feb 18 09:37:41 sw01 swlogd: bcmd esm info(5) phy_nlp_enable_set: u=0 p=1 enable:1 phyPresent:YES'];
  assert.equal(classifyRawLine(lines[0]).format, 'kvp', 'still classified kvp — the fallback is what saves it');
  assert.ok(scoreValueCoverage(lines, PROBE_OUTPUT, true).totalValues > 0, 'a kvp line that harvests nothing must fall back to the atom harvester');
});

test('an already-parsed object _raw is walked, not stringified', () => {
  const ev = [{ Event: { System: { EventID: '4624', Computer: 'dc01.corp.local' } } }];
  assert.ok(scoreValueCoverage(ev, PROBE_OUTPUT, true).totalValues > 0, 'an object _raw must not collapse to "[object Object]"');
});

// --- spec lens: the SAME denominator rule, generalized -----------------------
// Pack `aaa` scored 0 on three working f5_bigip pipelines because the spec lens
// found exactly ONE checkable field and reported 0/1. A denominator of 1 is not a
// measurement, it's a coin flip. These assert the floor holds for the OTHER lens
// too, so the class of bug can't reappear in whichever lens is consulted next.

// The f5_bigip AUDIT line is the real-world case: of the field names tokenizable
// out of it, only `user` maps to a CIM/CEF/CSL spec field.
const ONE_KEY_SAMPLE = [
  'Apr 14 16:20:59 bigip01.local notice tmsh[7354]: 01420002:5: AUDIT - pid=7354 user=root folder=/ module=(tmos)# status=[Command OK] cmd_data=list cm device recursive',
];
const METADATA_ONLY_OUTPUT = [{ _raw: 'CEF:0|f5|Security|1.0|event|msg|1|dvchost=bigip01.local', _time: 1776183659, host: 'bigip01.local' }];

test('the spec lens refuses to score on a denominator below the floor', () => {
  for (const fmt of ['cef', 'cim', 'commonsecuritylog']) {
    const r = validateOutputAgainstSpec(fmt, METADATA_ONLY_OUTPUT, ['user'], 'f5_bigip', ONE_KEY_SAMPLE.join('\n'));
    if (r.checkedFields >= 4) continue; // richer than the pathology — not this test's case
    assert.equal(r.supported, false,
      `${fmt}: checked=${r.checkedFields} is too few to form a ratio, so the spec lens must report not-measurable instead of ${r.score}`);
  }
});

test('a tiny spec denominator never outvotes a real coverage measurement', () => {
  // The precedence bug: spec 0/1 → 0 was returned in preference to a coverage
  // measurement with a denominator in the dozens.
  const auth = scoreAuthoritative({
    destFormat: 'cef',
    sourcetype: 'f5_bigip',
    rawSampleKeys: ['user'],
    rawEvents: ONE_KEY_SAMPLE,
    outputEvents: METADATA_ONLY_OUTPUT,
    aiScore: null,
  });
  assert.notEqual(auth.scoreSource, 'spec-validation',
    'a below-floor spec denominator must not be the authoritative score source');
  assert.ok(auth.coverage == null || auth.coverage.totalValues > 1,
    'the lens that wins should be the one with a real denominator');
});

test('extraction that lands nothing in named fields still scores 0', () => {
  // The inverse guard: the fix must not make a raw-passthrough pipeline pass.
  const lines = ['<134>Jan 15 08:23:41 bigip-lb01 notice tmm1[12345]: 01260013:5: pool /Common/web_pool member 10.20.30.15:8443'];
  const r = scoreValueCoverage(lines, [{ _raw: lines[0] }], true);
  assert.equal(r.supported, true, 'the sample is measurable — only the extraction is empty');
  assert.equal(r.score, 0, 'values sitting in an untransformed _raw must not count as extracted');
});

// Field-attributed gaps: UI must show field=value for keep-list drops, not a
// raw token soup like "pa-220, 2018, vsys1, ethernet1…".
test('explainValueCoverageGaps attributes dropped fields vs never-extracted values', () => {
  const raw = [
    'Jan 1 00:00:00 host serial=012801096514 vsys=vsys1 src=10.1.1.1 dst=10.2.2.2 dport=443 action=allow orphan=never_extracted_abc',
  ];
  const extracted = [{
    serial_number: '012801096514',
    virtual_system: 'vsys1',
    src_ip: '10.1.1.1',
    dest_ip: '10.2.2.2',
    dest_port: 443,
    action: 'allow',
  }];
  // CIM-like keep: only the network core made it; vendor columns dropped.
  const final = [{
    src_ip: '10.1.1.1',
    dest_ip: '10.2.2.2',
    dest_port: 443,
    action: 'allow',
  }];
  const gaps = explainValueCoverageGaps(raw, extracted, final);
  assert.ok(gaps.droppedFields.includes('serial_number'), `serial_number should be dropped: ${gaps.droppedFields}`);
  assert.ok(gaps.droppedFields.includes('virtual_system'), `virtual_system should be dropped: ${gaps.droppedFields}`);
  assert.ok(gaps.notMapped.some(g => g.field === 'serial_number' && g.value.includes('012801096514')),
    `notMapped should show serial_number=value, got ${JSON.stringify(gaps.notMapped)}`);
  assert.ok(gaps.notMapped.some(g => g.field === 'virtual_system'),
    `notMapped should include virtual_system`);
  assert.ok(!gaps.droppedFields.includes('src_ip'), 'kept src_ip must not appear as dropped');
  assert.ok(gaps.notExtracted.some(g => g.value.includes('never_extracted_abc')),
    `orphan sample value should be notExtracted: ${JSON.stringify(gaps.notExtracted)}`);
});

test('scoreSchemaMappingFromExtraction scores CIM fields only — not leftover vendor fields', () => {
  const extracted = [{
    source__ip: '192.168.15.207',
    destination__ip: '175.16.199.1',
    source__port: '55113',
    destination__port: '443',
    network__transport: 'tcp',
    event__outcome: 'allow',
    observer__serial_number: '012801096514',
    panw__panos__virtual_system: 'vsys1',
  }];
  // Broken Copilot→CIM mapping: only action/transport filled; IPs never became src/dest.
  const mappedBroken = [{
    action: 'allowed',
    transport: 'tcp',
    protocol: 'tcp',
    app: 'tcp',
    source__ip: '192.168.15.207', // still present as vendor leftover — must NOT inflate mapping
    destination__ip: '175.16.199.1',
  }];
  const broken = scoreSchemaMappingFromExtraction('cim', extracted, mappedBroken, 'palo_alto_traffic');
  assert.equal(broken.supported, true);
  assert.ok(broken.score < 50, `broken CIM mapping must score low, got ${broken.score}`);
  assert.ok(broken.emptyFields.includes('src'), `src should be empty: ${broken.emptyFields}`);
  assert.ok(broken.emptyFields.includes('dest'), `dest should be empty: ${broken.emptyFields}`);
  assert.ok(broken.populatedFields.includes('action') || broken.populatedFields.includes('transport'),
    `action/transport should count as filled: ${broken.populatedFields}`);

  const mappedGood = [{
    src: '192.168.15.207',
    dest: '175.16.199.1',
    src_port: 55113,
    dest_port: 443,
    transport: 'tcp',
    action: 'allowed',
    app: 'apple-maps',
    bytes_in: 5976,
    bytes_out: 1758,
  }];
  const good = scoreSchemaMappingFromExtraction('cim', extracted, mappedGood, 'palo_alto_traffic');
  assert.ok(good.score > broken.score, `good mapping ${good.score} should beat broken ${broken.score}`);
  assert.ok(good.populatedFields.includes('src') && good.populatedFields.includes('dest'));
});

test('shapeMappedEventForDisplay keeps CIM fields and drops vendor leftovers + nested _raw', () => {
  const messy = {
    _time: 1,
    sourcetype: 'pan:traffic',
    source__ip: '192.168.15.207',
    destination__ip: '175.16.199.1',
    panw__panos__csv_payload: '1,2018,...huge...',
    action: 'allowed',
    transport: 'tcp',
    _raw: JSON.stringify({
      action: 'allowed',
      transport: 'tcp',
      app: 'tcp',
      source__ip: '192.168.15.207',
      panw__panos__virtual_system: 'vsys1',
    }),
  };
  const shown = shapeMappedEventForDisplay('cim', messy, 'palo_alto_traffic');
  assert.equal(shown._raw, undefined, '_raw must not appear after mapping display cleanup');
  assert.equal(shown.source__ip, undefined, 'vendor extract fields must not appear in mapping panel');
  assert.equal(shown.panw__panos__csv_payload, undefined);
  assert.equal(shown.action, 'allowed');
  assert.equal(shown.transport, 'tcp');
  assert.ok(shown.sourcetype === 'pan:traffic' || shown._time === 1);
});

// --- P2: fail-closed on a degenerate schema mapping ---------------------------
// A schema destination whose final mapping carries only the envelope
// (sourcetype/_time/TimeGenerated) is a serde-only pack that looks built but
// only re-serializes _raw (the deployed CiscoPrime_OCSF). buildStagedPipeline
// must THROW so the batch marks the row failed instead of storing a fake score.
test('buildStagedPipeline fails closed on an empty schema mapping', () => {
  const src = readFileSync(new URL('../src/staged-build.ts', import.meta.url), 'utf8');
  assert.match(src, /const producedRealMapping = mappingFns\.some/,
    'the empty-mapping guard must inspect the final mapping functions');
  assert.match(src, /ENVELOPE_ONLY[\s\S]{0,120}TimeGenerated/,
    'the envelope-only set must exclude TimeGenerated (a forced Sentinel column, not a real mapping)');
  assert.match(src, /if \(!producedRealMapping\) \{[\s\S]{0,200}throw new Error\(`Mapping failed:/,
    'a degenerate schema mapping must throw, not ship');
});

// --- Tier D: sparse-denominator confidence flag -------------------------------
// A genuinely sparse source (a handful of meaningful values) is not the same as a
// broken one, and the score on a tiny denominator is granular: one miss on 3
// values is a 33-point swing. The flag makes that measurable WITHOUT inflating
// the number — full coverage of a sparse source is already 100, and a real miss
// keeps its honest low score.

test('a tiny denominator is flagged sparse (low-confidence) but scored honestly', () => {
  const raw = ['user=admin ip=10.0.0.1'];
  const out = [{ user_name: 'admin', src_ip: '10.0.0.1' }];
  const r = scoreValueCoverage(raw, out, true);
  assert.equal(r.supported, true, 'a measurable sparse source is still supported');
  assert.ok(r.totalValues < 4, `expected a sparse denominator, got ${r.totalValues}`);
  assert.equal(r.sparse, true, 'a sub-floor denominator must be flagged sparse');
  assert.equal(r.score, 100, 'full coverage of a sparse source is an honest 100 — never inflated past it, never penalized');
});

test('the sparse flag never inflates a real miss to a pass', () => {
  const raw = ['user=admin ip=10.0.0.1 port=54321'];
  const out = [{ user_name: 'admin', src_ip: '10.0.0.1' }];   // the port was dropped
  const r = scoreValueCoverage(raw, out, true);
  assert.equal(r.sparse, true, 'still a sub-floor denominator');
  assert.ok(r.score < 100, `a dropped value must cost points even on a sparse source, got ${r.score}`);
  assert.ok(r.lostValues.includes('54321'), 'the dropped port is a genuine lost value, not hidden by the flag');
});

test('a healthy denominator is NOT flagged sparse', () => {
  const raw = ['user=admin ip=10.0.0.1 port=54321 host=web01srv action=blocked session=abc123def456'];
  const out = [{ user_name: 'admin', src_ip: '10.0.0.1', dest_port: '54321', host: 'web01srv', action: 'blocked', session_id: 'abc123def456' }];
  const r = scoreValueCoverage(raw, out, true);
  assert.ok(r.totalValues >= 4, `expected a rich denominator, got ${r.totalValues}`);
  assert.equal(r.sparse, false, 'a healthy denominator must not be flagged sparse');
});

test('an unmeasurable stage reports sparse:false, not sparse:true', () => {
  // The `fail` path (empty denominator) is unmeasurable, not "sparse" — a caller
  // must fall back, not read it as a low-confidence coverage number.
  const r = scoreValueCoverage([], [], true);
  assert.equal(r.supported, false);
  assert.equal(r.sparse, false);
});
