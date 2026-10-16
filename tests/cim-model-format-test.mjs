/**
 * Splunk CIM per-model golden formats — concretize bare `cim` to the right
 * data model (Network Traffic / Authentication / Email / …) and keep field
 * lists aligned with config/cim-data-models.json (CIM 5.3).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildGoldenFormatMapping,
  cimFormatKeyForModel,
  concretizeCimFormat,
  getCompactOutputFunctions,
  hasGoldenFormatPath,
  isCimFormat,
  unmappedSourceFields,
  validateOutputAgainstSpec,
} from '../src/pack-builder.ts';
import { cimModelFields, cimModelPickerOptions, cimModelSuggestions } from '../src/cim-knowledge.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(join(ROOT, 'config/golden-formats.json'), 'utf8'));

test('isCimFormat recognizes bare and concrete keys', () => {
  assert.equal(isCimFormat('cim'), true);
  assert.equal(isCimFormat('cim#network'), true);
  assert.equal(isCimFormat('cim#authentication'), true);
  assert.equal(isCimFormat('ocsf'), false);
});

test('concretizeCimFormat picks data-class model from sourcetype', () => {
  assert.equal(concretizeCimFormat('cim', 'palo_alto_traffic'), 'cim#network');
  assert.equal(concretizeCimFormat('cim', 'windows_security'), 'cim#authentication');
  assert.equal(concretizeCimFormat('cim', 'cisco_esa'), 'cim#email');
  assert.equal(concretizeCimFormat('cim', 'zscaler_web'), 'cim#web_proxy');
  assert.equal(concretizeCimFormat('cim', 'infoblox_dns'), 'cim#dns');
  assert.equal(concretizeCimFormat('cim', 'linux_audit'), 'cim#endpoint');
  assert.equal(concretizeCimFormat('cim', 'aws_cloudtrail'), 'cim#change');
});

test('explicit cimModel wins over sourcetype data class', () => {
  assert.equal(
    concretizeCimFormat('cim', 'palo_alto_traffic', undefined, 'Intrusion_Detection'),
    'cim#intrusion_detection',
  );
  assert.equal(
    concretizeCimFormat('cim', 'palo_alto_traffic', undefined, 'Network Traffic'),
    'cim#network',
  );
});

test('explicit cim#x is left alone', () => {
  assert.equal(concretizeCimFormat('cim#email', 'cisco_asa'), 'cim#email');
});

test('cimFormatKeyForModel covers every golden-backed model', () => {
  for (const model of [
    'Network_Traffic', 'Authentication', 'Email', 'Web', 'Network_Resolution',
    'Endpoint', 'Change', 'Intrusion_Detection', 'Malware', 'Network_Sessions',
    'Data_Access', 'DLP', 'Vulnerabilities', 'Alerts',
  ]) {
    const key = cimFormatKeyForModel(model);
    assert.ok(key, model);
    assert.ok(golden.formats[key] || golden.formats[key]?.aliasOf, `missing golden ${key}`);
  }
});

test('each CIM golden map only uses fields from its Splunk model (plus vendor_action/rule_id)', () => {
  const allowExtra = {
    'cim#network': new Set(['vendor_action', 'rule_id']),
  };
  const modelFor = {
    'cim#network': 'Network_Traffic',
    'cim#authentication': 'Authentication',
    'cim#email': 'Email',
    'cim#web_proxy': 'Web',
    'cim#dns': 'Network_Resolution',
    'cim#endpoint': 'Endpoint',
    'cim#change': 'Change',
    'cim#intrusion_detection': 'Intrusion_Detection',
    'cim#malware': 'Malware',
    'cim#network_sessions': 'Network_Sessions',
    'cim#data_access': 'Data_Access',
    'cim#dlp': 'DLP',
    'cim#vulnerabilities': 'Vulnerabilities',
    'cim#alerts': 'Alerts',
  };
  for (const [key, model] of Object.entries(modelFor)) {
    const allowed = new Set(cimModelFields(model).map(f => f.name));
    for (const x of allowExtra[key] || []) allowed.add(x);
    const spec = golden.formats[key];
    assert.ok(spec?.canonicalMap?.length, key);
    for (const m of spec.canonicalMap) {
      assert.ok(allowed.has(m.dest), `${key} dest ${m.dest} not in ${model}`);
    }
  }
});

test('Network Traffic map includes required CIM traffic fields', () => {
  const dests = new Set(golden.formats['cim#network'].canonicalMap.map(m => m.dest));
  for (const f of ['action', 'app', 'bytes', 'bytes_in', 'bytes_out', 'dest', 'dest_port',
    'dvc', 'packets', 'rule', 'src', 'src_port', 'transport', 'user', 'vendor_product',
    'src_ip', 'dest_ip', 'flow_id', 'src_interface', 'dest_interface']) {
    assert.ok(dests.has(f), `missing ${f}`);
  }
});

test('hasGoldenFormatPath works for concretized CIM keys', () => {
  assert.equal(hasGoldenFormatPath('palo_alto_traffic', 'cim'), true);
  assert.equal(hasGoldenFormatPath('palo_alto_traffic', 'cim#network'), true);
  assert.equal(hasGoldenFormatPath('cisco_esa', 'cim#email'), true);
  assert.equal(hasGoldenFormatPath('windows_security', 'cim#authentication'), true);
});

test('buildGoldenFormatMapping for network CIM serializes to _raw', () => {
  const fns = buildGoldenFormatMapping('palo_alto_traffic', 'cim#network');
  assert.ok(fns.some(f => f.id === 'serialize' && f.conf?.dstField === '_raw'));
  const adds = fns.flatMap(f => f.conf?.add || []).map(a => a.name);
  assert.ok(adds.includes('src') || adds.includes('dest') || adds.includes('action'));
});

// --- "Keep unmapped source fields in _raw" passthrough (both mapping paths) ---

test('unmappedSourceFields subtracts consumed, metadata, and Cribl internals', () => {
  const out = unmappedSourceFields(
    ['zzz_a', 'zzz_b', 'src', '_raw', '__ctrl', 'cribl_pipe', 'gfsrc_tmp_x', 'zzz_a'],
    ['src'],
  );
  // 'src' consumed; '_raw' metadata; '__ctrl'/'cribl_pipe' internal; gfsrc_tmp_* snapshot;
  // duplicate 'zzz_a' de-duped.
  assert.deepEqual(out.sort(), ['zzz_a', 'zzz_b']);
});

// Locate the golden path's "Keep only <label> fields + routing" allowlist (the
// step that decides what survives into the rebuilt _raw), and the AI-path
// pre-serialize allowlist, by their remove:['*']+keep shape.
const keepStepFor = (fns) => fns.find(f => f.id === 'eval'
  && Array.isArray(f.conf?.remove) && f.conf.remove.includes('*')
  && Array.isArray(f.conf?.keep) && f.conf.keep.includes('src'));

test('GOLDEN CIM path: unmapped source fields are kept when the toggle is on', () => {
  // dst_ip is a canonical INPUT the cim#network map consumes (→ dest_ip) but is
  // not itself a dest field; zzz_custom* have no mapping at all.
  const extracted = ['dst_ip', 'zzz_custom1', 'zzz_custom2'];
  const on = buildGoldenFormatMapping('palo_alto_traffic', 'cim#network', undefined, '', extracted, true);
  const keep = keepStepFor(on)?.conf.keep || [];
  assert.ok(keep.includes('zzz_custom1') && keep.includes('zzz_custom2'), 'unmapped fields must be kept');
  // dst_ip is consumed by the mapping → NOT re-kept as unmapped source data.
  assert.ok(!keep.includes('dst_ip'), 'consumed inputs must not leak');
});

test('GOLDEN CIM path: unmapped source fields are dropped when the toggle is off', () => {
  const extracted = ['dst_ip', 'zzz_custom1'];
  const off = buildGoldenFormatMapping('palo_alto_traffic', 'cim#network', undefined, '', extracted, false);
  const keep = keepStepFor(off)?.conf.keep || [];
  assert.ok(!keep.includes('zzz_custom1'), 'off → no passthrough');
});

// The pre-serialize step (immediately before the json serialize→_raw) decides
// what survives into the rebuilt _raw.
const preSerializeStep = (fns) => {
  const serIdx = fns.findIndex(f => f.id === 'serialize' && f.conf?.dstField === '_raw');
  return serIdx > 0 ? fns[serIdx - 1] : null;
};

test('AI/static CIM path: keepUnmapped=true → denylist keeps ALL extracted fields (incl. dynamic serde)', () => {
  // keepUnmapped ON: a DENYLIST (strip _raw + internals, keep everything else).
  // This is the only shape that preserves fields whose names aren't known at
  // build time (dynamic kvp/json/csv serde, regex_extract) — an allowlist can't.
  const on = getCompactOutputFunctions('palo_alto_traffic', 'cim#network', true, ['src', 'dest'], true);
  const pre = preSerializeStep(on);
  assert.ok(pre, 'a pre-serialize step exists');
  assert.ok(Array.isArray(pre.conf.remove) && pre.conf.remove.includes('_raw'), 'denylist strips original _raw');
  assert.ok(!pre.conf.remove.includes('*'), 'denylist must NOT remove:[*] — every extracted field survives into _raw');
  assert.ok(!pre.conf.keep, 'denylist has no allowlist keep');

  // keepUnmapped OFF: an ALLOWLIST compacts _raw to just the mapped CIM model.
  const off = getCompactOutputFunctions('palo_alto_traffic', 'cim#network', true, ['src', 'dest'], false);
  const offKeep = keepStepFor(off)?.conf.keep || [];
  assert.ok(offKeep.includes('src') && offKeep.includes('dest'), 'mapped CIM fields kept');
  assert.ok(offKeep.includes('*') === false, 'allowlist, not wildcard');
});

test('spec-validation reads CIM fields back out of serialized _raw (flat CIM shape)', () => {
  // The correct CIM output nests every mapped field inside the rebuilt `_raw`
  // JSON and strips the top level (Splunk HEC shape). The spec lens MUST read
  // the mapped fields back out of `_raw`, else every correct CIM pipeline scores
  // 0 (golden AND AI) — the a-zscaler-web bug. Build the shape the pipeline emits
  // (fields only in _raw) for palo_alto_traffic → cim#network and assert a score.
  const rawSampleKeys = ['src_ip', 'dst_ip', 'src_port', 'dest_port', 'action', 'app', 'bytes_in', 'bytes_out'];
  const nested = { src: '10.0.0.1', dest: '10.0.0.2', src_port: 1234, dest_port: 443, action: 'allowed', app: 'web-browsing', bytes_in: 100, bytes_out: 200 };
  const outputEvents = [{ _raw: JSON.stringify(nested), _time: 1700000000, sourcetype: 'pan:traffic' }];
  const res = validateOutputAgainstSpec('cim#network', outputEvents, rawSampleKeys, 'palo_alto_traffic');
  assert.ok(res.supported, 'CIM spec lens is supported');
  assert.ok(res.populatedFields > 0, `fields in _raw must count as populated (got ${res.populatedFields}/${res.checkedFields})`);
  assert.ok(res.score >= 60, `nested-in-_raw CIM output must score, not 0 (got ${res.score})`);

  // Gate: a NON-serializeRaw destination must NOT read fields back out of a raw
  // that happens to be JSON — the original source log is not the mapped output.
  // A plain-JSON _raw with the SAME field names, but for OCSF (dropRaw, no
  // serializeRaw), must not be credited from _raw.
  const flat = [{ _raw: JSON.stringify(nested), _time: 1700000000 }];
  const ocsf = validateOutputAgainstSpec('ocsf', flat, rawSampleKeys, 'palo_alto_traffic');
  // OCSF is a nested golden-spec lens (may be supported:false here) — the point is
  // it must not inherit CIM's _raw-read. If supported, populated must be 0.
  if (ocsf.supported) assert.equal(ocsf.populatedFields, 0, 'OCSF must not read fields from a source-shaped _raw');
});

test('cimModelSuggestions: linux_audit / auditd → Endpoint, not Change', () => {
  assert.equal(cimModelSuggestions('linux_audit')[0], 'Endpoint');
  assert.equal(cimModelSuggestions('auditd')[0], 'Endpoint');
  // Cloud audit trails still land on Change — the bare "audit" keyword alone
  // must not steal linux_audit, but cloudtrail must keep working.
  assert.equal(cimModelSuggestions('aws_cloudtrail')[0], 'Change');
});

test('cimModelSuggestions: ldap → Authentication; vpc flow → Network', () => {
  assert.equal(cimModelSuggestions('corelight_ldap')[0], 'Authentication');
  assert.equal(cimModelSuggestions('aws_vpc_v5')[0], 'Network_Traffic');
});
test('cimModelPickerOptions lists suggestions first then remaining golden models', () => {
  const opts = cimModelPickerOptions('palo_alto_traffic');
  const suggested = cimModelSuggestions('palo_alto_traffic');
  assert.equal(opts[0], suggested[0]);
  assert.ok(opts.includes('Network_Traffic'));
  assert.ok(opts.includes('Email'));
  assert.ok(opts.length >= 14);
});

test('corelight ldap/http beat the /^corelight_/ network catch-all', () => {
  assert.equal(concretizeCimFormat('cim', 'corelight_ldap'), 'cim#authentication');
  assert.equal(concretizeCimFormat('cim', 'corelight_ldap_search'), 'cim#authentication');
  assert.equal(concretizeCimFormat('cim', 'corelight_http'), 'cim#web_proxy');
  assert.equal(concretizeCimFormat('cim', 'corelight_conn'), 'cim#network');
});
