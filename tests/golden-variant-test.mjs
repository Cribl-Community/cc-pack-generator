// Golden variants — the wire-format dimension of the golden store
// (src/golden-variant.ts). One source can ship several wire formats (FortiGate:
// key=value or CEF; Zscaler NSS: key=value, JSON or CEF), and a golden learned
// from one format extracts nothing from another, so a key's sourcetype segment
// carries the format whenever it is not the source's own. These are the pure
// rules every store (iframe localStorage + bundled, standalone file store, the
// public pool) resolves through. Nothing here touches config/golden-pipelines.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  goldenBaseSourcetype,
  goldenLookupSourcetypes,
  goldenRecordServesFormat,
  goldenVariantSourcetype,
  goldenWireFormatForSample,
  resolveGoldenVariant,
  resolveGoldenVariantAsync,
  splitGoldenVariant,
} from '../src/golden-variant.ts';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const FORTIGATE_KVP = [
  'date=2025-01-12 time=14:35:02 devname="fw01" devid="FG100F" logid="0000000013" type="traffic" subtype="forward" srcip=10.1.1.15 dstip=8.8.8.8 action="accept"',
  'date=2025-01-12 time=14:35:03 devname="fw01" devid="FG100F" logid="0000000013" type="traffic" subtype="forward" srcip=10.1.1.16 dstip=1.1.1.1 action="deny"',
];
const FORTIGATE_CEF = [
  '<189>Jan 12 14:35:02 fw01 CEF:0|Fortinet|Fortigate|v7.0.7|00020|traffic:forward accept|3|FTNTFGTeventtime=1736692502123456789 src=10.1.1.15 dst=8.8.8.8 act=accept',
  '<189>Jan 12 14:35:03 fw01 CEF:0|Fortinet|Fortigate|v7.0.7|00020|traffic:forward deny|3|FTNTFGTeventtime=1736692503123456789 src=10.1.1.16 dst=1.1.1.1 act=deny',
];

test('splitGoldenVariant only recognises a suffix that names a wire format', () => {
  assert.deepEqual(splitGoldenVariant('fortinet_fortigate@cef'), { base: 'fortinet_fortigate', wire: 'cef' });
  assert.deepEqual(splitGoldenVariant('fortinet_fortigate'), { base: 'fortinet_fortigate', wire: null });
  // An `@` that is not a wire-format suffix is part of the sourcetype.
  assert.deepEqual(splitGoldenVariant('team@acme'), { base: 'team@acme', wire: null });
  assert.deepEqual(splitGoldenVariant('@cef'), { base: '@cef', wire: null });
  assert.equal(goldenBaseSourcetype('zscaler_web@json'), 'zscaler_web');
  assert.equal(goldenBaseSourcetype(''), '');
});

test('a declared source keeps its native format on the plain key and files every other format under a variant', () => {
  // FortiGate's native format is key=value: the existing corpus stays where it is.
  assert.equal(goldenVariantSourcetype('fortinet_fortigate', 'kvp'), 'fortinet_fortigate');
  assert.equal(goldenVariantSourcetype('fortinet_fortigate', 'cef'), 'fortinet_fortigate@cef');
  // Windows Security is XML-native.
  assert.equal(goldenVariantSourcetype('windows_security', 'xml'), 'windows_security');
  assert.equal(goldenVariantSourcetype('windows_security', 'text'), 'windows_security@text');
  // Free-text sources: syslog text AND columns are the same (regex) family.
  assert.equal(goldenVariantSourcetype('cisco_asa', 'text'), 'cisco_asa');
  assert.equal(goldenVariantSourcetype('palo_alto_traffic', 'csv'), 'palo_alto_traffic');
  // The generic CEF source is CEF-native.
  assert.equal(goldenVariantSourcetype('cef', 'cef'), 'cef');
  assert.equal(goldenVariantSourcetype('aws_cloudtrail', 'json'), 'aws_cloudtrail');
});

test('an unknown wire format is never guessed — it is the plain key, exactly as before variants', () => {
  assert.equal(goldenVariantSourcetype('fortinet_fortigate', null), 'fortinet_fortigate');
  assert.equal(goldenVariantSourcetype('fortinet_fortigate', undefined), 'fortinet_fortigate');
  assert.equal(goldenVariantSourcetype('fortinet_fortigate', 'not-a-format'), 'fortinet_fortigate');
  assert.deepEqual(goldenLookupSourcetypes('fortinet_fortigate', null), ['fortinet_fortigate']);
  assert.deepEqual(goldenLookupSourcetypes('acme_custom', undefined), ['acme_custom']);
});

test('goldenVariantSourcetype is idempotent and a variant sourcetype carries its own suffix', () => {
  assert.equal(goldenVariantSourcetype('fortinet_fortigate@cef'), 'fortinet_fortigate@cef');
  assert.equal(goldenVariantSourcetype('fortinet_fortigate@cef', 'cef'), 'fortinet_fortigate@cef');
  // An explicit wire wins over the suffix; a native one collapses to the plain key.
  assert.equal(goldenVariantSourcetype('fortinet_fortigate@cef', 'kvp'), 'fortinet_fortigate');
  assert.equal(goldenVariantSourcetype(goldenVariantSourcetype('acme_custom', 'json'), 'json'), 'acme_custom@json');
});

test('a declared source looks up a non-native format on its variant ONLY — never the native golden', () => {
  assert.deepEqual(goldenLookupSourcetypes('fortinet_fortigate', 'kvp'), ['fortinet_fortigate']);
  assert.deepEqual(goldenLookupSourcetypes('fortinet_fortigate', 'cef'), ['fortinet_fortigate@cef']);
  assert.deepEqual(goldenLookupSourcetypes('zscaler_web', 'json'), ['zscaler_web@json']);
  assert.deepEqual(goldenLookupSourcetypes('fortinet_fortigate@cef', 'kvp'), ['fortinet_fortigate@cef']);
});

test('an undeclared source always saves under its variant and falls back to the legacy plain key on lookup', () => {
  assert.equal(goldenVariantSourcetype('acme_custom', 'json'), 'acme_custom@json');
  assert.equal(goldenVariantSourcetype('acme_custom', 'kvp'), 'acme_custom@kvp');
  assert.deepEqual(goldenLookupSourcetypes('acme_custom', 'json'), ['acme_custom@json', 'acme_custom']);
});

test('goldenRecordServesFormat: a record that states its format serves exactly the formats sharing its key', () => {
  assert.equal(goldenRecordServesFormat(null, 'fortinet_fortigate', 'kvp'), false);
  assert.equal(goldenRecordServesFormat({ wireFormat: 'cef' }, 'fortinet_fortigate@cef', 'cef'), true);
  assert.equal(goldenRecordServesFormat({ wireFormat: 'cef' }, 'fortinet_fortigate@cef', 'kvp'), false);
  assert.equal(goldenRecordServesFormat({ wireFormat: 'kvp' }, 'fortinet_fortigate', 'cef'), false);
  // text and csv share cisco_asa's plain key.
  assert.equal(goldenRecordServesFormat({ wireFormat: 'text' }, 'cisco_asa', 'csv'), true);
  // No wanted format → the pre-variant behaviour: serve.
  assert.equal(goldenRecordServesFormat({ wireFormat: 'cef' }, 'fortinet_fortigate@cef', null), true);
});

test('goldenRecordServesFormat: a legacy record is refused only when its trusted fingerprint contradicts the request', () => {
  const legacy = (format) => ({ recipe: { fingerprint: { format } } });
  // cef/json fingerprint classes need 60% of real lines — trusted.
  assert.equal(goldenRecordServesFormat(legacy('cef'), 'acme_custom', 'json'), false);
  assert.equal(goldenRecordServesFormat(legacy('cef'), 'acme_custom', 'cef'), true);
  assert.equal(goldenRecordServesFormat(legacy('json'), 'acme_custom', 'kvp'), false);
  // kvp/unstructured misfile (Check Point's pipe pairs fingerprint as unstructured) — not trusted.
  assert.equal(goldenRecordServesFormat(legacy('unstructured'), 'acme_custom', 'kvp'), true);
  assert.equal(goldenRecordServesFormat(legacy('kvp'), 'acme_custom', 'json'), true);
  // No fingerprint at all → serves, as it did before variants.
  assert.equal(goldenRecordServesFormat({}, 'acme_custom', 'json'), true);
  assert.equal(goldenRecordServesFormat({ recipe: null }, 'acme_custom', 'json'), true);
});

function mapReader(store, rest = 'cim') {
  const reads = [];
  return {
    reads,
    read: (segment) => { reads.push(segment); return store.get(`${segment}::${rest}`) || null; },
  };
}

test('resolveGoldenVariant: FortiGate CEF and key=value builds resolve to separate goldens', () => {
  const kvpGolden = { functions: ['kvp'], score: 95 };
  const cefGolden = { functions: ['cef'], score: 90, wireFormat: 'cef' };
  const store = new Map([
    ['fortinet_fortigate::cim', kvpGolden],
    ['fortinet_fortigate@cef::cim', cefGolden],
  ]);
  assert.equal(resolveGoldenVariant('fortinet_fortigate', 'kvp', mapReader(store).read), kvpGolden);
  assert.equal(resolveGoldenVariant('fortinet_fortigate', 'cef', mapReader(store).read), cefGolden);
  // The exact-key legacy lookup is unchanged.
  assert.equal(resolveGoldenVariant('fortinet_fortigate', undefined, mapReader(store).read), kvpGolden);
});

test('resolveGoldenVariant: a FortiGate CEF build with only a key=value golden stored finds NOTHING (builds fresh)', () => {
  const store = new Map([['fortinet_fortigate::cim', { functions: ['kvp'], score: 95 }]]);
  const r = mapReader(store);
  assert.equal(resolveGoldenVariant('fortinet_fortigate', 'cef', r.read), null);
  assert.deepEqual(r.reads, ['fortinet_fortigate@cef'], 'the native golden is never consulted for a non-native format');
});

test('resolveGoldenVariant: an undeclared source prefers its variant, then a legacy golden that does not contradict the format', () => {
  const legacyJson = { functions: ['legacy'], score: 88, recipe: { fingerprint: { format: 'json' } } };
  const legacyCef = { functions: ['legacy'], score: 88, recipe: { fingerprint: { format: 'cef' } } };
  const variant = { functions: ['variant'], score: 91, wireFormat: 'json' };

  assert.equal(resolveGoldenVariant('acme_custom', 'json', mapReader(new Map([
    ['acme_custom@json::cim', variant], ['acme_custom::cim', legacyJson],
  ])).read), variant);
  assert.equal(resolveGoldenVariant('acme_custom', 'json', mapReader(new Map([
    ['acme_custom::cim', legacyJson],
  ])).read), legacyJson);
  assert.equal(resolveGoldenVariant('acme_custom', 'json', mapReader(new Map([
    ['acme_custom::cim', legacyCef],
  ])).read), null, 'a legacy golden built from CEF must not serve a JSON sample');
});

test('resolveGoldenVariantAsync resolves exactly like the sync reader', async () => {
  const cefGolden = { functions: ['cef'], score: 90, wireFormat: 'cef' };
  const store = new Map([['fortinet_fortigate@cef::__extraction__', cefGolden]]);
  const { read } = mapReader(store, '__extraction__');
  assert.equal(await resolveGoldenVariantAsync('fortinet_fortigate', 'cef', async (s) => read(s)), cefGolden);
  assert.equal(await resolveGoldenVariantAsync('fortinet_fortigate', 'kvp', async (s) => read(s)), null);
});

test('goldenWireFormatForSample: the build sample decides the variant; mixed or empty is unknown', () => {
  assert.equal(goldenWireFormatForSample(FORTIGATE_KVP), 'kvp');
  assert.equal(goldenWireFormatForSample(FORTIGATE_CEF), 'cef');
  assert.equal(goldenWireFormatForSample(FORTIGATE_CEF.join('\n')), 'cef');
  // Preview events ({_raw}) as a validator report carries them.
  assert.equal(goldenWireFormatForSample(FORTIGATE_CEF.map(_raw => ({ _raw }))), 'cef');
  // A half-and-half feed is filed under neither variant.
  assert.equal(goldenWireFormatForSample([FORTIGATE_KVP[0], FORTIGATE_CEF[0]]), null);
  assert.equal(goldenWireFormatForSample([]), null);
  assert.equal(goldenWireFormatForSample(null), null);
  assert.equal(goldenWireFormatForSample(''), null);
  // Syslog-framed free text and bare free text are the same parser family.
  assert.equal(goldenWireFormatForSample([
    '<166>Jan 12 14:35:02 asa01 %ASA-6-302013: Built outbound TCP connection 1 for outside:8.8.8.8/443',
    '<166>Jan 12 14:35:03 asa01 %ASA-6-302014: Teardown TCP connection 1 for outside:8.8.8.8/443',
  ]), 'text');
  // The end-to-end key a FortiGate CEF build files under.
  assert.equal(goldenVariantSourcetype('fortinet_fortigate', goldenWireFormatForSample(FORTIGATE_CEF)), 'fortinet_fortigate@cef');
  assert.equal(goldenVariantSourcetype('fortinet_fortigate', goldenWireFormatForSample(FORTIGATE_KVP)), 'fortinet_fortigate');
});

test('every golden store resolves through the variant rule, and every build path passes the sample wire format', () => {
  // Client store (iframe + direct) and standalone file store.
  const api = read('src/api.ts');
  assert.match(api, /goldenVariantSourcetype\(sourcetype, wireFormat\)/, 'iframe save files under the variant key');
  const bundled = read('src/bundled-goldens.ts');
  assert.match(bundled, /resolveGoldenVariant(Async)?\(/, 'iframe/bundled read resolves through the variant rule');
  const fileStore = read('scripts/schema-validator.mjs');
  assert.match(fileStore, /resolveGoldenVariant(Async)?\(/, 'standalone read resolves through the variant rule');
  assert.match(fileStore, /goldenVariantSourcetype\(/, 'standalone save files under the variant key');
  // Build paths.
  const staged = read('src/staged-build.ts');
  assert.match(staged, /const sampleWire = goldenWireFormatForSample\(sampleEvents\)/);
  assert.ok((staged.match(/sampleFp, sampleWire\)/g) || []).length >= 2, 'both stage-part saves carry the wire format');
  assert.match(read('src/pack-orchestrator.ts'), /getGoldenPipeline\(sourcetype, destFormat, goldenWireFormatForSample\(/);
  assert.match(read('src/App.tsx'), /const currentWire = goldenWireFormatForSample\(state\.sampleEvents\)/);
  // The repair path keys the golden it stores the same way.
  assert.match(read('scripts/repair-core.mjs'), /goldenVariantSourcetype\(/);
});
