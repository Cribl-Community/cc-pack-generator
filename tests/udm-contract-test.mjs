// Google SecOps (Chronicle) UDM contract.
//
// The Cribl Google SecOps destination keeps only the UDM nouns and DROPS any event
// whose metadata.event_type is not a UDM EventType or whose metadata.event_timestamp
// is not {seconds:number, nanos:number} — the Test tab still reports success. A
// datatype mismatch (scalar for a repeated field, a value outside an enum, a number
// for a string field) fails the whole batch with HTTP 400. Every chronicle pipeline
// (golden spec, static fallback, OCSF post-process) is emulated and checked against
// config/udm-contract.json.

import { strict as assert } from 'node:assert';
import test from 'node:test';

process.env.SAMPLES_POOL_OFFLINE = '1';
globalThis.BUILD_NUMBER = 0;
const { buildPack, getMappingFunctions, isSafeEvalExpression } = await import('../src/pack-builder.ts');
const { buildPostProcessFunctions, postProcessSampleEvents } = await import('../src/postprocess-builder.ts');
const { emulatePipeline, SEEDED_TIME_SEC } = await import('../scripts/build-source-ocsf-samples.mjs');
const { resolveReferenceSample } = await import('../scripts/reference-api.mjs');
const C = (await import('../config/udm-contract.json', { with: { type: 'json' } })).default;
C.enums = Object.fromEntries(Object.entries(C.enums).map(([k, v]) => [k.split('.').pop(), v]));

// The ONE contract implementation — the live scorer's cap (auditUdmConformance) uses it too.
const { udmEventErrors } = await import('../src/schema-conformance.ts');
const udmErrors = ev => { const e = udmEventErrors(ev); return [...e.drop, ...e.invalid]; };

// A bare `{}` parent-init is the static mappings' established idiom (see the OCSF
// static mapping); isSafeEvalExpression's root-object rule targets AI literals.
function unsafeExpressions(fns) {
  const bad = [];
  for (const f of fns) for (const a of f.conf?.add || []) if (String(a.value).trim() !== '{}' && !isSafeEvalExpression(String(a.value))) bad.push(`${a.name} = ${a.value}`);
  return bad;
}

const FORMATS = ['chronicle', 'chronicle#authentication', 'chronicle#endpoint'];
// zscaler_web: its sample's timestamp is a bare leading date the KV parser never reads,
// so _time stays the processing time — a parser gap, not a UDM one.
const SOURCES = [['fortinet_fortigate', true], ['palo_alto_traffic', true], ['okta_system', true], ['linux_secure', true], ['zscaler_web', false]];

for (const [st, hasTime] of SOURCES) {
  for (const fmt of FORMATS) {
    test(`${st} → ${fmt}: every event satisfies the UDM contract`, async () => {
      const ref = await resolveReferenceSample(st, '');
      const lines = (ref?.events || []).slice(0, 4).map(e => typeof e === 'string' ? e : (e._raw ?? JSON.stringify(e)));
      assert.ok(lines.length > 0, `no reference sample for ${st}`);
      const state = { packName: `t_${st}`, displayName: st, sourceMode: 'reference', sampleEvents: lines.join('\n'),
        destFormat: fmt, destFormats: [fmt], manualFormat: '', routeFilter: '', workerGroup: 'default' };
      const fns = buildPack(state, st, {}, true).pipelineConf.functions;
      assert.deepEqual(unsafeExpressions(fns), []);
      const out = emulatePipeline(fns, lines).events;
      assert.ok(out.length > 0);
      for (const ev of out) {
        assert.deepEqual(udmErrors(ev), [], JSON.stringify(ev).slice(0, 400));
        const ts = ev.metadata.event_timestamp;
        assert.equal(ts.seconds, Math.floor(Number(ev._time)));
        if (hasTime) assert.notEqual(ts.seconds, SEEDED_TIME_SEC, 'event_timestamp is the processing time');
        for (const k of Object.keys(ev)) assert.ok(C.destination.nouns.includes(k) || ['_time', 'host', 'source', 'sourcetype', 'index'].includes(k), `stray top-level ${k}`);
      }
    });
  }
}

test('okta → chronicle: the source `target` array is cleared, not merged into UDM target', async () => {
  const ref = await resolveReferenceSample('okta_system', '');
  const lines = ref.events.slice(0, 4).map(e => typeof e === 'string' ? e : (e._raw ?? JSON.stringify(e)));
  const state = { packName: 't', displayName: 'okta', sourceMode: 'reference', sampleEvents: lines.join('\n'),
    destFormat: 'chronicle', destFormats: ['chronicle'], manualFormat: '', routeFilter: '', workerGroup: 'default' };
  for (const ev of emulatePipeline(buildPack(state, 'okta_system', {}, true).pipelineConf.functions, lines).events)
    assert.ok(!Array.isArray(ev.target), 'target is an array');
});

for (const fmt of FORMATS) {
  test(`OCSF post-process → ${fmt}: UDM contract`, () => {
    const fns = buildPostProcessFunctions('ocsf', fmt, { sourceSourcetype: 'fortinet_fortigate' });
    assert.deepEqual(unsafeExpressions(fns), []);
    const lines = postProcessSampleEvents('ocsf').split('\n').filter(Boolean).slice(0, 3);
    const out = emulatePipeline(fns, lines, {}).events;
    assert.ok(out.length > 0);
    for (const ev of out) assert.deepEqual(udmErrors(ev), [], JSON.stringify(ev).slice(0, 400));
  });
}

test('OCSF post-process → chronicle#authentication: action comes from status, not activity_name', () => {
  const fns = buildPostProcessFunctions('ocsf', 'chronicle#authentication', {});
  const lines = postProcessSampleEvents('ocsf').split('\n').filter(Boolean);
  const auth = lines.filter(l => JSON.parse(l).class_uid === 3002);
  assert.ok(auth.length > 0);
  for (const ev of emulatePipeline(fns, auth, {}).events) {
    const want = /fail/i.test(JSON.parse(auth[0]).status) ? 'BLOCK' : 'ALLOW';
    if (auth.length === 1) assert.deepEqual(ev.security_result[0].action, [want]);
    else assert.notDeepEqual(ev.security_result[0].action, ['UNKNOWN_ACTION']);
  }
});

test('static chronicle fallback (no golden) satisfies the UDM contract', () => {
  const canonical = { src_ip: '10.0.0.5', dest_ip: '10.0.0.9', src_port: 51000, dest_port: 443, transport: 'tcp',
    protocol: 'https', action: 'deny', user: 'alice', log_time: '2025-01-16T10:00:00Z' };
  const parse = { id: 'serde', conf: { mode: 'extract', type: 'json', srcField: '_raw' } };
  for (const st of ['fortinet_fortigate', 'windows_security', 'unknown_vendor_xyz']) {
    const fns = getMappingFunctions(st, 'chronicle');
    assert.ok(fns.length > 0, st);
    assert.deepEqual(unsafeExpressions(fns), [], st);
    const out = emulatePipeline([parse, ...fns], [JSON.stringify(canonical)]).events;
    for (const ev of out) {
      const ts = ev.metadata?.event_timestamp;
      assert.ok(ts && typeof ts.seconds === 'number' && typeof ts.nanos === 'number', `${st}: ${JSON.stringify(ev.metadata)}`);
      if (ev.network?.ip_protocol != null) assert.ok(C.enums.IpProtocol.includes(ev.network.ip_protocol), `${st}: ${ev.network.ip_protocol}`);
      for (const sr of [].concat(ev.security_result || []))
        for (const a of [].concat(sr.action ?? [])) assert.ok(C.enums.Action.includes(a), `${st}: ${a}`);
      if (ev.principal?.ip != null) assert.ok(Array.isArray(ev.principal.ip), `${st}: principal.ip scalar`);
    }
  }
});
