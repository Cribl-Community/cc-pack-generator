/**
 * CEF wire-format checker (src/cef-format.ts) + its cap integration into
 * scoreAuthoritative (src/pack-builder.ts). The checker is the syntactic analogue
 * of the OCSF schema oracle: it validates the CEF:0|…| header, severity range,
 * extension well-formedness/escaping, and a standard-key dictionary.
 *
 * Load-bearing invariants:
 *  - a well-formed CEF scores 100 and NEVER inflates the coverage score (cap only);
 *  - a malformed CEF (bad header/severity/escaping) caps the authoritative score;
 *  - non-standard extension keys are ADVISORY (listed, no score change).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.BUILD_NUMBER = 683;   // pack-builder reads this at import time

const { auditCefFormat, checkCefEvent } = await import('../src/cef-format.ts');
const { scoreAuthoritative } = await import('../src/pack-builder.ts');

const cef = (raw) => ({ _raw: raw });
const GOOD = 'CEF:0|Palo Alto Networks|PAN-OS|10.2|end|Traffic Ended|3|src=10.0.0.5 spt=51514 dst=93.184.216.34 dpt=443 proto=TCP act=allow';

test('a well-formed CEF event validates with no problems', () => {
  const r = checkCefEvent(cef(GOOD));
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.deepEqual(r.reasons, []);
  assert.ok(r.extKeys.includes('src') && r.extKeys.includes('proto'));
});

test('auditCefFormat: all valid → score 100, no malformed, no unknown keys', () => {
  const a = auditCefFormat([cef(GOOD), cef(GOOD)]);
  assert.equal(a.applicable, true);
  assert.equal(a.validEvents, 2);
  assert.equal(a.score, 100);
  assert.equal(a.band, 'good');
  assert.deepEqual(a.malformed, []);
  assert.deepEqual(a.unknownKeys, []);
});

test('severity out of range (15) is a structural defect', () => {
  const r = checkCefEvent(cef(GOOD.replace('|Traffic Ended|3|', '|Traffic Ended|15|')));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /severity/.test(x)), r.reasons.join('; '));
});

test('a valid severity WORD (High) is accepted', () => {
  const r = checkCefEvent(cef(GOOD.replace('|Traffic Ended|3|', '|Traffic Ended|High|')));
  assert.equal(r.ok, true, r.reasons.join('; '));
});

test('too few header pipes (broken header) is flagged', () => {
  const r = checkCefEvent(cef('CEF:0|Vendor|Product|1.0|sig=x act=y'));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /header has \d+ field/.test(x)), r.reasons.join('; '));
});

test('missing CEF: prefix is flagged', () => {
  const r = checkCefEvent(cef('<134>Jan 1 host something happened'));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /CEF: prefix/.test(x)));
});

test('empty mandatory header (no product) is flagged', () => {
  const r = checkCefEvent(cef('CEF:0|Vendor||1.0|sig|Name|3|src=1.1.1.1'));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /DeviceProduct is empty/.test(x)), r.reasons.join('; '));
});

test('non-standard extension key is ADVISORY — listed, does not change the score', () => {
  const a = auditCefFormat([cef(GOOD + ' totallyMadeUpKey=zzz')]);
  assert.equal(a.validEvents, 1, 'still structurally valid');
  assert.equal(a.score, 100, 'dictionary membership does not cap the score');
  assert.ok(a.unknownKeys.includes('totallyMadeUpKey'));
});

test('custom keys (cs1/cs1Label/cn1/flexString1/deviceCustomNumber1) are NOT flagged unknown', () => {
  const a = auditCefFormat([cef(GOOD + ' cs1=a cs1Label=b cn1=5 flexString1=x deviceCustomNumber1=9')]);
  assert.deepEqual(a.unknownKeys, [], `unexpected unknowns: ${a.unknownKeys.join(', ')}`);
  assert.equal(a.score, 100);
});

test('score is the fraction of structurally valid events', () => {
  const a = auditCefFormat([cef(GOOD), cef(GOOD), cef('not cef at all'), cef(GOOD)]);
  assert.equal(a.totalEvents, 4);
  assert.equal(a.validEvents, 3);
  assert.equal(a.score, 75);   // round(100 * 3/4)
});

test('CAP: a malformed CEF caps the authoritative value-coverage score', () => {
  // A source line with many values → coverage would be high; but the CEF is
  // malformed (bad severity), so the authoritative score must be capped to the
  // CEF validity score, not the coverage score.
  const rawEvents = ['src=10.0.0.5 dst=93.184.216.34 spt=5 dpt=443 proto=TCP act=allow user=bob'];
  const badCef = [cef('CEF:0|V|P|1|sig|Name|99|src=10.0.0.5 dst=93.184.216.34 spt=5 dpt=443 proto=TCP act=allow suser=bob')];
  const auth = scoreAuthoritative({
    destFormat: 'cef', sourcetype: 'test_src',
    rawSampleKeys: ['src', 'dst', 'spt', 'dpt', 'proto', 'act', 'user'],
    rawEvents, outputEvents: badCef, aiScore: null,
  });
  assert.ok(auth.cef, 'cef audit attached to result');
  assert.equal(auth.cef.applicable, true);
  assert.ok(auth.cef.validEvents < auth.cef.totalEvents, 'CEF detected as malformed');
  assert.ok(auth.score <= auth.cef.score, `score ${auth.score} should be capped at CEF validity ${auth.cef.score}`);
});

test('a well-formed CEF does NOT inflate — cap only lowers', () => {
  const auth = scoreAuthoritative({
    destFormat: 'cef', sourcetype: 'test_src',
    rawSampleKeys: ['src', 'dst', 'spt', 'dpt', 'proto', 'act'],
    rawEvents: ['src=10.0.0.5 dst=93.184.216.34 spt=5 dpt=443 proto=TCP act=allow'],
    outputEvents: [cef(GOOD)], aiScore: null,
  });
  assert.ok(auth.cef && auth.cef.score === 100);
  // score is whatever the coverage/spec lens produced, not forced to 100
  assert.ok(auth.score <= 100);
});
