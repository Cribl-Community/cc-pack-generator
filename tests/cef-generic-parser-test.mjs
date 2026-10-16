// Generic, vendor-agnostic ArcSight/Micro Focus CEF (Common Event Format) source
// parser. Unlike every other sourcetype in source-recognition.ts, `cef` has no
// single vendor's field dictionary to hand-tune against — the published CEF Key
// Dictionary itself is the contract (header + src/dst/spt/dpt/act/proto/app/cat/
// in/out/rt/cs1-6+Label/cn1-3+Label/...). Used for any device that ships CEF with
// no more specific vendor parser (FortiGate/Zscaler/Check Point keep their own
// richer parsers even when they happen to emit CEF).
//
// The shared `extractFieldValues` emulator (src/sample-library.ts) only resolves
// simple `a || b || undefined` eval chains — never ternaries or the `name: ''`
// side-effect pattern the cs*/cn* Label-aliasing step uses — so it can't
// exercise log_time or the custom-field aliasing. `runPipeline` below is a small,
// faithful interpreter (regex_extract / serde kvp / eval, incl. an empty-name
// add's side effect) that runs functions exactly the way Cribl's own eval does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canonicalizeSourcetype,
  getParserFieldNames,
  getParserForSourcetype,
  getSupportedSourcetypeCatalog,
  recommendDestFormats,
  sampleMatchesSourceExpectation,
} from '../src/pack-builder.ts';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const REAL_CEF_LINE =
  '<134>Jan 12 14:35:02 fw01.acme.local CEF:0|Acme Networks|NextGen Firewall|9.2.1|100|Traffic Allowed|5|' +
  'rt=1736692502000 src=10.1.1.15 spt=52341 dst=8.8.8.8 dpt=443 proto=TCP act=allow app=https in=2048 out=10240 ' +
  'suser=jdoe sourceTranslatedAddress=203.0.113.10 sourceTranslatedPort=41022 cs1Label=Rule cs1=allow-web-outbound ' +
  'cn1Label=RuleId cn1=42';

function parseRegexLiteral(s) {
  const m = String(s).match(/^\/(.*)\/([a-z]*)$/s);
  return new RegExp(m[1], m[2]);
}

const JS_RESERVED = new Set([
  'true', 'false', 'null', 'undefined', 'typeof', 'new', 'in', 'of', 'this',
  'String', 'Number', 'Boolean', 'Date', 'Math', 'RegExp', 'Object', 'Array',
  '__e', // already an explicit param — must not be redeclared via the names list
]);

/**
 * On real Cribl, reading a field that was never set on the event evaluates to
 * `undefined` — it never throws, which is why the whole codebase reads bare
 * unset identifiers like `action || rule_action || undefined` freely. A plain
 * `with(event){...}` doesn't reproduce that: a genuinely UNDECLARED identifier
 * still throws a ReferenceError even inside `with`. So every bare identifier in
 * the expression (skipping dotted property access and string literals) is
 * declared as a real function parameter, defaulted to `undefined` when the
 * event doesn't have it — that's what makes an unset-field read behave exactly
 * like Cribl's, in both filters and eval values.
 */
function evalExpr(event, expr) {
  const stripped = expr.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const names = [...new Set((stripped.match(/(?<![.$\w])[A-Za-z_$][\w$]*/g) || []))]
    .filter((n) => !JS_RESERVED.has(n));
  const fn = new Function('__e', ...names, `return (${expr});`);
  return fn(event, ...names.map((n) => event[n]));
}

/** Runs regex_extract / serde(kvp) / eval functions the way Cribl's own eval does. */
function runPipeline(fns, rawLine) {
  const event = { _raw: rawLine };
  for (const fn of fns) {
    if (fn.filter) {
      let ok;
      try { ok = evalExpr(event, fn.filter); } catch { ok = false; }
      if (!ok) continue;
    }
    if (fn.id === 'regex_extract') {
      const re = parseRegexLiteral(fn.conf.regex);
      const m = re.exec(event[fn.conf.source] ?? '');
      if (m?.groups) Object.assign(event, m.groups);
    } else if (fn.id === 'serde' && fn.conf.type === 'kvp') {
      const q = fn.conf.quoteChar || '"';
      const re = new RegExp(`([\\w.-]+)=(${q}[^${q}]*${q}|[^\\s]*)`, 'g');
      let m;
      const src = String(event[fn.conf.srcField] ?? '');
      while ((m = re.exec(src)) !== null) {
        if (!m[1]) continue;
        const raw = m[2];
        event[m[1]] = raw.length >= 2 && raw[0] === q && raw[raw.length - 1] === q ? raw.slice(1, -1) : raw;
      }
    } else if (fn.id === 'eval') {
      for (const entry of fn.conf.add || []) {
        let v;
        try { v = evalExpr(event, entry.value); } catch { continue; }
        if (entry.name) event[entry.name] = v;
      }
      for (const rm of fn.conf.remove || []) delete event[rm];
    }
  }
  return event;
}

test('generic + vendor spellings all canonicalize to cef', () => {
  for (const spelling of ['cef', 'CEF', 'generic_cef', 'arcsight_cef', 'ArcSight_CEF', 'common_event_format', 'micro_focus_cef', 'hpe_arcsight']) {
    assert.equal(canonicalizeSourcetype(spelling), 'cef', `"${spelling}" should canonicalize to cef`);
  }
});

test("checkpoint_cef stays on Check Point's own richer parser, not the generic one", () => {
  assert.equal(canonicalizeSourcetype('checkpoint_cef'), 'checkpoint_firewall');
});

test('checkpoint_firewall extracts a real Check Point CEF export via the shared CEF branch', () => {
  const line = 'CEF:0|Check Point|VPN-1 & FireWall-1|R81|Accept|Log|3|rt=1736692502000 src=10.1.1.15 dst=8.8.8.8 proto=6 act=Accept';
  assert.equal(sampleMatchesSourceExpectation('checkpoint_firewall', line), 'match',
    'a genuine CEF header must not be rejected by the KVP key-overlap check tuned for loguid/origin/conn_direction');
  const fns = getParserForSourcetype('checkpoint_firewall', false);
  const event = runPipeline(fns, line);
  assert.equal(event.src_ip, '10.1.1.15');
  assert.equal(event.dest_ip, '8.8.8.8');
  assert.equal(event.action, 'Accept');
  assert.equal(event.vendor_product, 'Check Point VPN-1 & FireWall-1', 'CEF-derived vendor/product, not the hardcoded legacy string');
  assert.equal(event.log_time, '1736692502000');
});

test("checkpoint_firewall's own legacy KVP dialect still works and is not shadowed by the CEF branch", () => {
  const line = '<134>1 2025-01-12T14:35:00Z fw01 CheckPoint 1234 - - action="Accept" src="10.1.1.5" dst="8.8.8.8" proto="tcp" service="443" loguid="{0x1,0x2,0x3,0x4}" rule_name="Allow-Web" conn_direction="Outbound" origin="10.1.1.1"';
  assert.equal(sampleMatchesSourceExpectation('checkpoint_firewall', line), 'match');
  const fns = getParserForSourcetype('checkpoint_firewall', false);
  const event = runPipeline(fns, line);
  assert.equal(event.signature_id, undefined, 'no CEF header present — the CEF branch must be a no-op');
  assert.equal(event.src_ip, '10.1.1.5');
  assert.equal(event.dest_ip, '8.8.8.8');
  assert.equal(event.action, 'Accept');
  assert.equal(event.vendor_product, 'Check Point Software Firewall', 'legacy path keeps its own hardcoded vendor/product');
});

test('cef is a golden-buildable catalog entry with the network data class', () => {
  const entry = getSupportedSourcetypeCatalog().find((c) => c.name === 'cef');
  assert.ok(entry, 'cef must appear in the supported sourcetype catalog');
  assert.equal(entry.golden, true, 'cef should be flagged golden (parser + real spec)');
  const rec = recommendDestFormats('cef');
  assert.equal(rec.dataClass, 'network');
  assert.ok(rec.formats.includes('ocsf') && rec.formats.includes('cim') && rec.formats.includes('cef'));
});

test('a real CEF line matches the golden expectation', () => {
  assert.equal(sampleMatchesSourceExpectation('cef', REAL_CEF_LINE), 'match');
});

test('a line with no CEF header and no signature_id extracts nothing (never fabricates fields)', () => {
  const fns = getParserForSourcetype('cef', false);
  const event = runPipeline(fns, 'Jan 12 14:35:02 host sshd[123]: Failed password for root from 1.2.3.4 port 4444 ssh2');
  assert.equal(event.signature_id, undefined);
  assert.equal(event.src_ip, undefined);
  assert.equal(event.action, undefined);
});

test('getParserFieldNames never declares a bare reserved-word field (in/out)', () => {
  const fields = getParserFieldNames('cef');
  assert.ok(!fields.includes('in'), 'bare "in" is a JS reserved word and unsafe to declare');
  assert.ok(!fields.includes('out'), 'bare "out" is a JS reserved word and unsafe to declare');
  assert.ok(fields.includes('bytes_in') && fields.includes('bytes_out'), 'the canonical alias must still be declared');
});

test('the parser extracts the full canonical model from a real CEF line', () => {
  const fns = getParserForSourcetype('cef', false);
  const event = runPipeline(fns, REAL_CEF_LINE);
  // Header
  assert.equal(event.device_vendor, 'Acme Networks');
  assert.equal(event.device_product, 'NextGen Firewall');
  assert.equal(event.signature_id, '100');
  assert.equal(event.name, 'Traffic Allowed');
  // Extension → canonical network 5-tuple (Rule 10: dest_ip/dest_port names, not dst/dpt)
  assert.equal(event.src_ip, '10.1.1.15');
  assert.equal(event.src_port, 52341);
  assert.equal(event.dest_ip, '8.8.8.8');
  assert.equal(event.dest_port, 443);
  assert.equal(event.action, 'allow');
  assert.equal(event.transport, 'TCP');
  assert.equal(event.protocol, 'https');
  assert.equal(event.bytes_in, 1024 * 2);
  assert.equal(event.bytes_out, 1024 * 10);
  assert.equal(event.src_user, 'jdoe');
  assert.equal(event.src_translated_ip, '203.0.113.10');
  assert.equal(event.vendor_product, 'Acme Networks NextGen Firewall');
  // Syslog envelope
  assert.equal(event.device_host, 'fw01.acme.local');
  assert.equal(event.host, 'fw01.acme.local');
  // Numeric CEF severity passes through as a number
  assert.equal(event.severity, 5);
  // rt (Device Receipt Time) is CEF's own canonical timestamp field
  assert.equal(event.log_time, '1736692502000');
});

test('textual CEF severity (Unknown/Low/Medium/High/Very-High) maps to a 0-10 number', () => {
  const fns = getParserForSourcetype('cef', false);
  const cases = [['Very-High', 10], ['High', 8], ['Medium', 5], ['Low', 2], ['Unknown', 0]];
  for (const [text, expected] of cases) {
    const line = `CEF:0|V|P|1.0|1|Event|${text}|act=x`;
    const event = runPipeline(fns, line);
    assert.equal(event.severity, expected, `severity "${text}" should map to ${expected}`);
  }
});

test('vendor custom fields (cs1/cn1) are aliased to their supplied Label', () => {
  const fns = getParserForSourcetype('cef', false);
  const event = runPipeline(fns, REAL_CEF_LINE);
  assert.equal(event.Rule, 'allow-web-outbound', 'cs1 should be aliased to its cs1Label name');
  assert.equal(event.RuleId, 42, 'cn1 should be aliased to its cn1Label name and coerced numeric');
});

test('every bundled CEF fallback sample is recognized as CEF and extracts real fields', () => {
  const src = read('scripts/reference-api.mjs');
  const m = src.match(/\bcef:\s*\[([\s\S]*?)\n {2}\],/);
  assert.ok(m, 'expected a `cef:` entry in FALLBACK_SAMPLES (scripts/reference-api.mjs)');
  const lines = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((mm) => mm[1]);
  assert.ok(lines.length >= 5, 'expect at least 5 curated CEF fallback samples');
  const fns = getParserForSourcetype('cef', false);
  for (const line of lines) {
    assert.equal(sampleMatchesSourceExpectation('cef', line), 'match', `fallback sample should match: ${line.slice(0, 60)}...`);
    const event = runPipeline(fns, line);
    assert.ok(event.signature_id !== undefined, `fallback sample should parse a CEF header: ${line.slice(0, 60)}...`);
    const fieldCount = Object.keys(event).filter((k) => !k.startsWith('_') && !k.startsWith('__')).length;
    assert.ok(fieldCount >= 6, `fallback sample should extract several fields: ${line.slice(0, 60)}...`);
  }
});

test('the standalone and iframe fallback-sample stores carry the SAME cef samples', () => {
  const refapi = read('scripts/reference-api.mjs');
  const bundled = read('src/bundled-data.ts');
  const grab = (src) => {
    const m = src.match(/cef:\s*\[([\s\S]*?)\n( {2,4})\],/);
    assert.ok(m, 'both stores must declare a cef fallback array');
    return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((mm) => mm[1]);
  };
  assert.deepEqual(grab(refapi), grab(bundled), 'standalone (reference-api.mjs) and iframe (bundled-data.ts) cef samples must be identical (Hard Rule 18)');
});

const CHECKPOINT_CEF_PREFIX =
  'CEF:0|Check Point|VPN-1 & FireWall-1|Check Point|Log|https|Unknown|act=Accept deviceDirection=0 rt=1653680308000 shost=100.100.10.10 spt=16998 dpt=53 cs2Label=Rule Name cs2=1.221_.. layer_name=Network layer_uuid=f74ca46a-7911-4c4c-9721-3d218078961c match_id=221 parent_rule=0 rule_action=Accept ifname=wrp64 logid=0 loguid={0x629128b4,0x2e0,0xbdfcf486,0x35d8eba3} origin=100.100.10.10 originsicname=CN=abc-d';

test('a line that starts with CEF: never loses to a vendor datatype regex guess', async () => {
  const { matchDatatypeParserBySample, sampleStartsWithCef } = await import('../src/pack-builder.ts');
  assert.equal(sampleStartsWithCef(CHECKPOINT_CEF_PREFIX), true);
  const match = matchDatatypeParserBySample(CHECKPOINT_CEF_PREFIX);
  assert.ok(match, 'prefix CEF must match a parser');
  assert.equal(match.parserKey, 'cef', `must not guess a vendor parser, got ${match.parserKey}`);
  assert.equal(match.runnersUp.length, 0, 'no vendor runners-up when the line itself is CEF');
});

test('format first: the CEF header names the source only where that vendor parser reads CEF', async () => {
  const { recogniseSampleLocally } = await import('../src/sanitised-sample-workflow.ts');
  // Check Point: its parser runs the shared CEF branch first, so the header's
  // vendor is adopted — READ from the header, not guessed from extension keys.
  const cp = recogniseSampleLocally(CHECKPOINT_CEF_PREFIX);
  assert.equal(cp.sourcetype, 'checkpoint_firewall');
  assert.deepEqual(cp.alternatives || [], []);
  // Any vendor without a CEF-first-class parser stays on generic cef, framed or not.
  for (const line of [
    'CEF:0|Acme Networks|NextGen Firewall|9.2.1|100|Traffic Allowed|5|src=10.1.1.15 dst=8.8.8.8 act=allow',
    REAL_CEF_LINE,
  ]) {
    assert.equal(recogniseSampleLocally(line).sourcetype, 'cef', line.slice(0, 60));
  }
});

test('syslog-framed CEF is not prefix-locked so a vendor envelope can still win', async () => {
  const { sampleStartsWithCef } = await import('../src/pack-builder.ts');
  assert.equal(sampleStartsWithCef(REAL_CEF_LINE), false,
    '`<pri>timestamp host CEF:0|…` does not start with CEF');
  assert.equal(sampleStartsWithCef('Jan 12 14:35:02 fw01 CEF:0|Acme|FW|1|1|x|3|src=1.1.1.1'), false);
});

test('native vendor KVP that is not CEF is not forced to cef', async () => {
  const { matchDatatypeParserBySample, sampleStartsWithCef } = await import('../src/pack-builder.ts');
  const kvp = 'date=2026-08-19 time=09:14:02 devname="fgt-ams-edge-02" devid="FGTxxx" srcip=10.1.1.1 dstip=8.8.8.8 action=accept proto=6';
  assert.equal(sampleStartsWithCef(kvp), false);
  const match = matchDatatypeParserBySample(kvp);
  assert.ok(!match || match.parserKey !== 'cef', `native FortiGate KVP must not lock to cef, got ${match?.parserKey}`);
});

test('the vendor comes from the CEF header, never from the sourcetype name', async () => {
  const { buildGoldenFormatMapping, buildOcsfEnvelope, getMappingFunctions, getParserForSourcetype: parserFor } =
    await import('../src/pack-builder.ts');
  const parse = parserFor('cef', false);
  const parsed = runPipeline(parse, CHECKPOINT_CEF_PREFIX);
  assert.equal(parsed.vendor, 'Check Point', 'the parser reads Device Vendor out of the header');

  // Every mapping path: the constant guessed from the sourcetype name ("cef") must be gone.
  for (const fmt of ['cim', 'cef', 'ocsf']) {
    const out = runPipeline([...parse, ...buildGoldenFormatMapping('cef', fmt)], CHECKPOINT_CEF_PREFIX);
    const seen = fmt === 'cef' ? String(out._raw) : JSON.stringify(out);
    assert.ok(!/\bcef\|Security\b|"vendor":"cef"/.test(seen), `${fmt} still carries the sourcetype-name vendor: ${seen.slice(0, 120)}`);
  }
  const cefRaw = runPipeline([...parse, ...buildGoldenFormatMapping('cef', 'cef')], CHECKPOINT_CEF_PREFIX)._raw;
  assert.ok(String(cefRaw).startsWith('CEF:0|Check Point|VPN-1 & FireWall-1|Check Point|'),
    `header must re-emit the parsed Device Vendor|Product|Version, got ${String(cefRaw).slice(0, 80)}`);

  const ocsf = runPipeline([...parse, ...buildOcsfEnvelope('cef', 'network')], CHECKPOINT_CEF_PREFIX);
  assert.equal(ocsf['metadata.product.vendor_name'], 'Check Point');
  assert.equal(ocsf['metadata.product.name'], 'VPN-1 & FireWall-1');

  const legacy = runPipeline([...parse, ...getMappingFunctions('cef', 'cef')], CHECKPOINT_CEF_PREFIX);
  assert.match(String(legacy._raw), /CEF:0\|Check Point\|VPN-1 & FireWall-1\|/, 'the legacy static CEF mapping too');
});

test('a curated vendor keeps its constant, and a headerless line falls back to Unknown', async () => {
  const { buildGoldenFormatMapping, cefHeaderCarriesVendor, getParserForSourcetype: parserFor } =
    await import('../src/pack-builder.ts');
  // Curated sources are unchanged — the constant is deliberate, not a guess.
  for (const st of ['cisco_asa', 'fortinet_fortigate', 'zscaler_web', 'checkpoint_firewall']) {
    assert.equal(cefHeaderCarriesVendor(st), false, `${st} is curated and must keep its constant`);
  }
  const asaVendor = buildGoldenFormatMapping('cisco_asa', 'cef')[0].conf.add;
  assert.deepEqual(asaVendor, [
    { name: 'vendor', value: "'Cisco'" },
    { name: 'product', value: "'ASA'" },
    { name: 'version', value: "'9.x'" },
  ]);

  // No CEF header means no Device Vendor to read — say Unknown, not "cef".
  const out = runPipeline(
    [...parserFor('cef', false), ...buildGoldenFormatMapping('cef', 'cef')],
    'Jan 12 14:35:02 host sshd[123]: Failed password for root from 1.2.3.4',
  );
  assert.match(String(out._raw), /^CEF:0\|Unknown\|Unknown\|/, `got ${String(out._raw).slice(0, 60)}`);
});

test('no STORED cef golden hardcodes a vendor — a stored mapping is replayed verbatim', () => {
  // A golden is deployed exactly as stored, so a builder fix cannot reach one.
  // `cef::ocsf#network::__mapping__` froze `vendor: 'cef'` and threw away the
  // device_vendor its own extraction sibling had just read off the header.
  const store = JSON.parse(read('config/golden-pipelines.json')).pipelines;
  const cefKeys = Object.keys(store).filter((k) => k.split('::')[0] === 'cef');
  assert.ok(cefKeys.length > 0, 'the cef goldens must still be in the store');
  for (const key of cefKeys) {
    for (const fn of store[key].functions || []) {
      for (const add of (fn.conf && fn.conf.add) || []) {
        if (!/^(vendor|product)$/.test(add.name)) continue;
        assert.match(String(add.value), /device_(vendor|product)/,
          `${key} → ${add.name} must read the CEF header, got ${add.value}`);
      }
    }
  }
});

test('wizard detectSourcetype and both AI detectors answer CEF from its header before any model call', () => {
  const app = read('src/App.tsx');
  const fn = app.slice(app.indexOf('const detectSourcetype = async'));
  const body = fn.slice(0, fn.indexOf('\n  const handleSelectSourcetype'));
  const cefAt = body.indexOf('recognizeCefSource(events)');
  const localAt = body.indexOf('matchDatatypeParserBySample');
  const aiAt = body.indexOf('detectSourcetypeApi');
  assert.ok(cefAt > 0, 'detectSourcetype consults recognizeCefSource');
  assert.ok(cefAt < localAt, 'CEF (format first) runs before datatype matching');
  assert.ok(cefAt < aiAt, 'CEF (format first) runs before the AI detector');

  for (const [file, marker] of [
    ['scripts/ai-validate.mjs', 'export async function handleDetectSourcetype'],
    ['src/ai-client.ts', 'export async function aiDetectSourcetype'],
  ]) {
    const src = read(file);
    const start = src.indexOf(marker);
    assert.ok(start > 0, `${file} still exports the detector`);
    const slice = src.slice(start, start + 2500);
    assert.match(slice, /sourcetype:\s*cefSource\.sourcetype/, `${file} answers CEF from the header without invoking the model`);
    const invokeAt = slice.search(/invokeModel\(|invokeAi\(/);
    const cefReturnAt = slice.indexOf('recognizeCefSource(');
    assert.ok(cefReturnAt > 0, `${file} consults recognizeCefSource`);
    assert.ok(invokeAt < 0 || cefReturnAt < invokeAt, `${file} must answer CEF BEFORE the model call`);
  }
});
