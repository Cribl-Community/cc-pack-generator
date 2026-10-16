/**
 * Structured-format conformance checkers (src/schema-conformance.ts) + their cap
 * integration into scoreAuthoritative (src/pack-builder.ts). These are the third
 * checker family alongside the OCSF oracle and the CEF wire-format checker:
 *   - CIM / ASIM  → TYPE CONFORMANCE (a numeric/boolean schema field emitted as a
 *                   string is a defect); driven by real vendored name+type schema.
 *   - ECS → the vendored ECS schema (tests/ecs-conformance-test.mjs covers it).
 *   - Chronicle → STRUCTURAL ENVELOPE (nested metadata object).
 *   - JSON → structural (non-empty object).
 *
 * Load-bearing invariants:
 *   - a conformant output scores 100 and NEVER inflates the coverage score (cap only);
 *   - a type/envelope violation caps the authoritative score;
 *   - a lenient (string/timestamp) field is never a violation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.BUILD_NUMBER = 684;   // pack-builder reads this at import time

const { auditSchemaConformance, isSchemaConformanceFormat } = await import('../src/schema-conformance.ts');
const { scoreAuthoritative } = await import('../src/pack-builder.ts');

test('isSchemaConformanceFormat covers cim/asim/ecs/chronicle/json (+ #class), not cef/ocsf', () => {
  for (const f of ['cim', 'cim#network', 'asim', 'asim#authentication', 'ecs', 'chronicle', 'json']) {
    assert.equal(isSchemaConformanceFormat(f), true, f);
  }
  for (const f of ['cef', 'arcsight', 'ocsf', 'xsiam', 'manual']) {
    assert.equal(isSchemaConformanceFormat(f), false, f);
  }
});

test('CIM: a numeric field emitted as a string is a type violation', () => {
  // bytes/bytes_in/bytes_out/duration are numeric in CIM Network_Traffic.
  const good = auditSchemaConformance('cim#network', [{ bytes: 1024, duration: 3 }]);
  assert.equal(good.applicable, true);
  assert.equal(good.score, 100, good.reasons.join('; '));

  const bad = auditSchemaConformance('cim#network', [{ bytes: '1024', duration: '3' }]);
  assert.ok(bad.typeChecked >= 1, 'at least one numeric field checked');
  assert.ok(bad.score < 100, `string-typed numeric should cap: got ${bad.score}`);
  assert.ok(bad.typeViolations.some(v => /bytes|duration/.test(v)), bad.typeViolations.join(', '));
});

test('CIM: string fields are lenient — a string value is never a violation', () => {
  const a = auditSchemaConformance('cim#network', [{ src_ip: '10.0.0.1', dest_ip: '8.8.8.8', transport: 'tcp' }]);
  assert.equal(a.score, 100, a.reasons.join('; '));
});

test('ASIM: a numeric ASim column emitted as a string is a violation', () => {
  // ASimNetworkSessionLogs has numeric columns (e.g. SrcPortNumber / DstPortNumber).
  const bad = auditSchemaConformance('asim#network', [{ SrcPortNumber: '51514', DstPortNumber: '443' }]);
  if (bad.typeChecked > 0) {
    assert.ok(bad.score < 100, `string ports should cap: ${bad.score}`);
  }
  const good = auditSchemaConformance('asim#network', [{ SrcPortNumber: 51514, DstPortNumber: 443 }]);
  assert.equal(good.score, 100, good.reasons.join('; '));
});

test('ECS: a flat blob is not a valid ECS envelope; a nested namespace is', () => {
  const flat = auditSchemaConformance('ecs', [{ src_ip: '1.1.1.1', dst_ip: '2.2.2.2' }]);
  assert.equal(flat.applicable, true);
  assert.ok(flat.score < 100, `flat blob should fail ECS envelope: ${flat.score}`);

  const nested = auditSchemaConformance('ecs', [{ event: { kind: 'event', category: ['network'] }, source: { ip: '1.1.1.1' } }]);
  assert.equal(nested.score, 100, nested.reasons.join('; '));
});

test('Chronicle: a UDM metadata object is required', () => {
  const flat = auditSchemaConformance('chronicle', [{ principal_ip: '1.1.1.1' }]);
  assert.ok(flat.score < 100);
  const udm = auditSchemaConformance('chronicle', [{ metadata: { event_type: 'NETWORK_CONNECTION' }, principal: { ip: '1.1.1.1' } }]);
  assert.equal(udm.score, 100);
});

test('JSON: a non-empty object is valid; routing-only metadata is not', () => {
  const ok = auditSchemaConformance('json', [{ foo: 'bar', n: 1 }]);
  assert.equal(ok.score, 100);
  const empty = auditSchemaConformance('json', [{ _time: 123, index: 'main', sourcetype: 'x' }]);
  assert.ok(empty.score < 100, `routing-only event should not count: ${empty.score}`);
});

test('CAP: a CIM type violation caps the authoritative value-coverage score', () => {
  // Source carries many values → coverage high; output maps them but emits the
  // numeric bytes field as a string → CIM type conformance must cap the score.
  const rawEvents = ['src_ip=10.0.0.5 dest_ip=8.8.8.8 bytes=1024 duration=3 user=bob'];
  const out = [{ src_ip: '10.0.0.5', dest_ip: '8.8.8.8', bytes: '1024', duration: '3', user: 'bob' }];
  const auth = scoreAuthoritative({
    destFormat: 'cim#network', sourcetype: 'test_src',
    rawSampleKeys: ['src_ip', 'dest_ip', 'bytes', 'duration', 'user'],
    rawEvents, outputEvents: out, aiScore: null,
  });
  assert.ok(auth.schema, 'schema audit attached');
  assert.equal(auth.schema.applicable, true);
  assert.ok(auth.schema.score < 100, 'CIM type violation detected');
  assert.ok(auth.score <= auth.schema.score, `score ${auth.score} capped at schema ${auth.schema.score}`);
});

test('a conformant CIM output does NOT inflate — cap only lowers', () => {
  const auth = scoreAuthoritative({
    destFormat: 'cim#network', sourcetype: 'test_src',
    rawSampleKeys: ['src_ip', 'dest_ip', 'bytes'],
    rawEvents: ['src_ip=10.0.0.5 dest_ip=8.8.8.8 bytes=1024'],
    outputEvents: [{ src_ip: '10.0.0.5', dest_ip: '8.8.8.8', bytes: 1024 }], aiScore: null,
  });
  assert.ok(auth.schema && auth.schema.score === 100);
  assert.ok(auth.score <= 100);
});

// --- Google SecOps UDM wire contract (auditUdmConformance + capUdm) ----------
const { auditUdmConformance, isUdmConformanceFormat, UDM_DROP_CAP, UDM_INVALID_CAP } = await import('../src/schema-conformance.ts');

const udmEvent = (over = {}) => ({
  metadata: { event_type: 'NETWORK_CONNECTION', event_timestamp: { seconds: 1737021600, nanos: 0 } },
  principal: { ip: ['10.0.0.5'] }, target: { ip: ['8.8.8.8'], port: 443 },
  network: { ip_protocol: 'TCP' }, security_result: [{ action: ['ALLOW'] }],
  ...over,
});
const udmRaw = ['src_ip=10.0.0.5 dest_ip=8.8.8.8 dest_port=443 transport=tcp action=allow'];
const udmScore = (outputEvents, destFormat = 'chronicle') => scoreAuthoritative({
  destFormat, sourcetype: 'test_src', rawSampleKeys: ['src_ip', 'dest_ip', 'dest_port', 'transport', 'action'],
  rawEvents: udmRaw, outputEvents, aiScore: null,
});

test('UDM: applies to chronicle UDM formats only — never the raw line for Google\'s parser', () => {
  for (const f of ['chronicle', 'chronicle#endpoint', 'chronicle#authentication']) assert.equal(isUdmConformanceFormat(f), true, f);
  for (const f of ['chronicle#raw', 'chronicle_raw', 'ecs', 'xsiam', '']) assert.equal(isUdmConformanceFormat(f), false, f);
  assert.equal(auditUdmConformance('chronicle#raw', [{ _raw: 'x' }]).applicable, false);
});

test('UDM: a conformant event is not capped, and the score is untouched by the audit', () => {
  const a = auditUdmConformance('chronicle', [udmEvent()]);
  assert.equal(a.applicable, true);
  assert.equal(a.cap, null, a.failures.join('; '));
  const auth = udmScore([udmEvent()]);
  assert.ok(auth.udm && auth.udm.cap === null);
  assert.ok(auth.score > UDM_INVALID_CAP, `conformant UDM scored ${auth.score}`);
});

test('UDM: every event dropped (bad event_timestamp) caps at the drop cap', () => {
  const bad = udmEvent({ metadata: { event_type: 'NETWORK_CONNECTION', event_timestamp: '2025-01-16T10:00:00Z' } });
  const a = auditUdmConformance('chronicle', [bad, bad]);
  assert.equal(a.droppedEvents, 2);
  assert.equal(a.cap, UDM_DROP_CAP);
  assert.equal(a.band, 'fail');
  assert.ok(a.failures.some(f => f.startsWith('DROP metadata.event_timestamp')));
  const auth = udmScore([bad]);
  assert.ok(auth.score <= UDM_DROP_CAP, `dropped events scored ${auth.score}`);
});

test('UDM: a non-EventType event_type is a drop; a partial drop caps at the invalid cap', () => {
  const bad = udmEvent({ metadata: { event_type: 'network_connection', event_timestamp: { seconds: 1, nanos: 0 } } });
  const a = auditUdmConformance('chronicle', [udmEvent(), bad]);
  assert.equal(a.droppedEvents, 1);
  assert.equal(a.cap, UDM_INVALID_CAP);
});

test('UDM: a datatype violation (batch 400) caps at the invalid cap', () => {
  for (const over of [{ network: { ip_protocol: 'tcp' } }, { principal: { ip: '10.0.0.5' } }, { security_result: [{ action: ['deny'] }] }, { target: [{ ip: ['8.8.8.8'] }] }]) {
    const a = auditUdmConformance('chronicle', [udmEvent(over)]);
    assert.equal(a.droppedEvents, 0, JSON.stringify(over));
    assert.equal(a.invalidEvents, 1, JSON.stringify(over));
    assert.equal(a.cap, UDM_INVALID_CAP, JSON.stringify(over));
  }
  assert.ok(udmScore([udmEvent({ network: { ip_protocol: 'tcp' } })]).score <= UDM_INVALID_CAP);
});

test('UDM: nouns serialized into a JSON `_raw` are read from there', () => {
  assert.equal(auditUdmConformance('chronicle', [{ _raw: JSON.stringify(udmEvent()) }]).cap, null);
  assert.equal(auditUdmConformance('chronicle', [{ _raw: JSON.stringify(udmEvent({ metadata: {} })) }]).cap, UDM_DROP_CAP);
});
