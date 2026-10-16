// Windows Event XML: one shared parse front-end, one canonical per CHANNEL.
//
// Every Windows channel serialises to the same XML ENVELOPE, so the parse
// front-end (parseWinEvent → flatten → rename) is genuinely shared. The EventData
// inside is NOT shared: each channel writes entirely different `Data Name`
// attributes. Five channels used to canonicalize onto `windows_security` and
// inherit its alias set (TargetUserName/IpAddress/LogonType) plus its
// `authentication` data class — so a DNS query or a Defender detection was
// deterministically mapped against the golden AUTHENTICATION spec. It failed
// SILENTLY (the golden path never errors): extraction healthy, mapping ~0 — the
// batch-446 signature.
//
// These tests hold the split in place: the shared shape, the per-channel field
// reads, the per-channel data class, and — the load-bearing one — that no
// non-Security channel reads a Security-only field name.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  canonicalizeSourcetype,
  getParserFieldNames,
  getParserForSourcetype,
  isWindowsCodeFamily,
  lintMappingVacuity,
  recommendDestFormats,
  sampleMatchesSourceExpectation,
} from '../src/pack-builder.ts';
import { eventsToLines } from '../src/sample-library.ts';
import { handleReferenceSample } from '../scripts/reference-api.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(new URL(p, new URL('../', import.meta.url)), 'utf8');

const FRONT_END_IDS = ['eval', 'flatten', 'rename'];

// Field names only the Security channel's EventData carries. A DNS-Client or
// Defender parser that reads these is reading fields its events never contain.
const SECURITY_ONLY_FIELDS = [
  'TargetUserName',
  'SubjectUserName',
  'TargetDomainName',
  'SubjectDomainName',
  'IpAddress',
  'IpPort',
  'LogonType',
  'TargetLogonId',
  'AuthenticationPackageName',
  'WorkstationName',
];

// Every Windows channel we build a dedicated parser for.
const CHANNELS = [
  { st: 'windows_security', dataClass: 'authentication', stripSpaces: false, reads: ['TargetUserName', 'IpAddress', 'LogonType'] },
  { st: 'windows_sysmon', dataClass: 'endpoint', stripSpaces: false, reads: ['Image', 'CommandLine', 'ParentImage'] },
  { st: 'windows_dns_client', dataClass: 'dns', stripSpaces: false, reads: ['QueryName', 'QueryType', 'QueryResults', 'QueryStatus', 'ServerList'] },
  { st: 'windows_defender', dataClass: 'endpoint', stripSpaces: true, reads: ['ThreatName', 'ActionName', 'CategoryName', 'SeverityName'] },
  { st: 'windows_system', dataClass: 'endpoint', stripSpaces: false, reads: ['ServiceName', 'ImagePath', 'AccountName'] },
  { st: 'windows_application', dataClass: 'generic', stripSpaces: false, reads: ['Data', 'Provider_Name'] },
];

const parserOf = st => getParserForSourcetype(st, true);
// windows_system / windows_application also read Edge JSON and classic text.
// The XML front-end is the functions gated on `__win_xml`; every other channel
// is XML-only, so the whole parser is the front-end.
const xmlBranch = fns => (fns.some(fn => fn.filter === '__win_xml') ? fns.filter(fn => fn.filter === '__win_xml') : fns);
// The legacy per-channel alias eval (`.conf.add`) is still the LAST `eval` in
// the branch — windows_security/sysmon/dns_client/defender/system/powershell
// now append one more function after it (the shared OCSF dispatch `code`
// function, unfiltered — see windowsOcsfDispatchFn), so "last function overall"
// is no longer always the alias. Find the last function that still HAS
// `.conf.add` instead of indexing from the end.
const aliasStep = fns => [...xmlBranch(fns)].reverse().find(fn => fn.id === 'eval' && fn.conf && Array.isArray(fn.conf.add));
const aliasAdds = st => aliasStep(parserOf(st)).conf.add;
const aliasSource = st => aliasAdds(st).map(a => a.value).join(' ');
// Channels where the shared Windows→OCSF class dispatcher is wired in.
const OCSF_DISPATCH_CHANNELS = new Set(['windows_security', 'windows_sysmon', 'windows_powershell',
  'windows_dns_client', 'windows_defender', 'windows_system']);
const dispatchFn = st => parserOf(st).find(fn => fn.id === 'code');

for (const channel of CHANNELS) {
  const { st } = channel;

  test(`${st} uses the native Windows XML parser with or without Code permission`, () => {
    const withCode = getParserForSourcetype(st, true);
    const withoutCode = getParserForSourcetype(st, false);

    assert.deepEqual(withCode, withoutCode);
    const xml = xmlBranch(withCode);
    // A second wire (classic text, Edge JSON) may add a regex_extract. The XML
    // branch itself stays the native parser: no regex fallback. It DOES now
    // carry a `code` function for the 6 OCSF-dispatch channels — the shared
    // Windows→OCSF class dispatcher appended after the legacy alias eval (it
    // must live in extraction, not mapping — validateMappingStage rejects any
    // code/regex_extract/serde/parser function there).
    assert.equal(xml.some(fn => fn.id === 'regex_extract'), false,
      'the native parseWinEvent front-end makes a regex fallback unnecessary');
    const codeCount = xml.filter(fn => fn.id === 'code').length;
    // windows_system's dispatch runs OUTSIDE the __win_xml-gated subset
    // (xmlBranch filters it out), so it is 0 here even though the channel IS
    // dispatch-enabled — see the dedicated 'windows_system OCSF dispatch
    // function is wired in (outside the __win_xml gate)' test below.
    const expectCodeInBranch = OCSF_DISPATCH_CHANNELS.has(st) && st !== 'windows_system';
    assert.equal(codeCount, expectCodeInBranch ? 1 : 0,
      `${st}: expected ${expectCodeInBranch ? 'exactly one' : 'no'} code function in the XML branch`);

    // Shared front-end: parse+compact eval, flatten, path-prefix rename, then an
    // optional space-stripping rename, then exactly one channel alias eval,
    // then (for dispatch-enabled channels) the shared OCSF dispatch code fn.
    const expectedIds = [...FRONT_END_IDS, ...(channel.stripSpaces ? ['rename'] : []), 'eval',
      ...(expectCodeInBranch ? ['code'] : [])];
    assert.deepEqual(xml.map(fn => fn.id), expectedIds);

    const parseValues = xml[0].conf.add.map(entry => entry.value);
    assert.equal(parseValues[0], "_raw.replace(/[{}\\t]/gm,'').replace(/[\\n\\r]+/gm,',')");
    assert.equal(parseValues[1], "C.Text.parseWinEvent(_raw,['0x0','0','-'])");
    assert.deepEqual(xml[1].conf, {
      fields: ['_raw'],
      prefix: '',
      depth: 5,
      delimiter: '_',
    });
    assert.equal(xml[2].conf.renameExpr, "name.replace(/_raw_Event_\\w+_/,'')");
  });

  test(`${st} emits the canonical envelope fields every golden spec reads`, () => {
    const adds = aliasAdds(st);
    const byName = new Map(adds.map(a => [a.name, a.value]));

    // `log_time` is THE canonical time field (Hard Rule 8) — the golden time
    // assembly reads nothing else, so a channel that skips it ships a pipeline
    // where every event shares one static `_time`.
    assert.ok(byName.has('log_time'), `${st} must alias log_time`);
    assert.match(byName.get('log_time'), /SystemTime/);
    assert.equal(byName.get('host'), 'Computer || undefined');
    assert.equal(byName.get('event_code'), 'EventID || undefined');

    const declared = getParserFieldNames(st);
    for (const required of ['log_time', 'host', 'event_code']) {
      assert.ok(declared.includes(required), `${st} must declare ${required}`);
    }
    // Rule 14 / the contract lint: a declared field must actually be produced.
    for (const { name } of adds) {
      assert.ok(declared.includes(name), `${st} produces ${name} but does not declare it`);
    }
  });

  test(`${st} reads its OWN channel's EventData names`, () => {
    const src = aliasSource(st);
    for (const field of channel.reads) {
      assert.match(src, new RegExp(`\\b${field}\\b`),
        `${st} must read ${field} — it is what this channel's EventData actually carries`);
    }
  });

  test(`${st} field names are all valid Cribl accessor paths`, () => {
    // A space (Defender's `Threat Name`) or a hyphen in a field name throws at
    // eval-init — the same failure class as the hyphenated SAP serde keys.
    for (const { name } of aliasAdds(st)) {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/,
        `${st}: "${name}" is not a valid accessor path`);
    }
    for (const name of getParserFieldNames(st)) {
      assert.doesNotMatch(name, /[\s-]/, `${st}: declared field "${name}" is not a valid accessor path`);
    }
  });

  test(`${st} carries the data class its destination selection depends on`, () => {
    // resolveGoldenFormat is data-class driven: a wrong class silently picks the
    // wrong golden spec, which is exactly how DNS events got the Authentication
    // spec. recommendDestFormats is the public read of that class.
    assert.equal(recommendDestFormats(st).dataClass, channel.dataClass);
  });

  test(`${st} mapping is not vacuous for the schema destinations`, () => {
    for (const fmt of ['cim', 'ecs', 'ocsf']) {
      const findings = lintMappingVacuity(st, fmt) || [];
      const errors = findings.filter(f => f.severity === 'error');
      assert.deepEqual(errors, [],
        `${st}→${fmt} produces fields the spec never reads: ${JSON.stringify(errors)}`);
    }
  });
}

test('the shared Windows->OCSF dispatcher is wired into exactly the 6 covered channels, not windows_application', () => {
  for (const { st } of CHANNELS) {
    const fn = dispatchFn(st);
    if (OCSF_DISPATCH_CHANNELS.has(st)) {
      assert.ok(fn, `${st} must have the shared OCSF dispatch code function`);
      assert.equal(fn.filter, undefined, `${st}'s dispatch function must run unfiltered (both wire forms converge before it)`);
      assert.match(fn.conf.code, /__ocsf_class_uid/, `${st}'s dispatch function must set __ocsf_class_uid`);
      assert.match(fn.conf.code, /__ocsf_unmapped_json/, `${st}'s dispatch function must carry everything else into __ocsf_unmapped_json`);
    } else {
      assert.equal(fn, undefined, `${st} must NOT get the OCSF dispatcher (windows_application has no Simon-covered class)`);
    }
  }
});

test('windows_system OCSF dispatch runs OUTSIDE the __win_xml gate (both wire forms reach it)', () => {
  const fns = parserOf('windows_system');
  const codeFns = fns.filter(fn => fn.id === 'code');
  assert.equal(codeFns.length, 1, 'windows_system must have exactly one code function');
  assert.equal(codeFns[0].filter, undefined, 'the dispatch function must not be gated on __win_xml — Classic/Edge-JSON events must reach it too');
  // It must be the LAST function overall (runs after both wire forms' aliasing).
  assert.equal(fns[fns.length - 1], codeFns[0]);
});

test('every OCSF-dispatch channel declares the full __ocsf_* field vocabulary the dispatcher can emit', () => {
  for (const st of OCSF_DISPATCH_CHANNELS) {
    const declared = new Set(getParserFieldNames(st));
    assert.ok(declared.has('__ocsf_class_uid'), `${st} must declare __ocsf_class_uid`);
    assert.ok(declared.has('__ocsf_unmapped_json'), `${st} must declare __ocsf_unmapped_json`);
    assert.ok(declared.has('__ocsf_user_name'), `${st} must declare __ocsf_user_name`);
  }
});

test('Microsoft Defender strips the spaces out of its EventData names', () => {
  // Defender writes `<Data Name="Threat Name">`; flatten keeps the space, and a
  // field with a space in its name cannot be read by any eval.
  const fns = parserOf('windows_defender');
  const strip = fns[3];
  assert.equal(strip.id, 'rename');
  assert.equal(strip.conf.renameExpr, "name.replace(/ /g,'')");
  // The alias step must therefore read the SPACE-STRIPPED names.
  assert.match(aliasSource('windows_defender'), /\bThreatName\b/);
  assert.doesNotMatch(aliasSource('windows_defender'), /Threat Name/);
});

test('no non-Security channel reads a Security-only EventData field', () => {
  // THE regression guard. Folding a channel back onto windows_security (or
  // copy-pasting its alias block) reintroduces the silent mapping-0 bug.
  for (const { st } of CHANNELS.filter(c => c.st !== 'windows_security')) {
    const src = aliasSource(st);
    for (const field of SECURITY_ONLY_FIELDS) {
      assert.doesNotMatch(src, new RegExp(`\\b${field}\\b`),
        `${st} reads Security-only field ${field} — its events never contain it`);
    }
  }
});

test('every real-world channel spelling canonicalizes to its own parser', () => {
  const expected = {
    'XmlWinEventLog:Security': 'windows_security',
    'WinEventLog:Security': 'windows_security',
    'security_wineventlog': 'windows_security',
    'XmlWinEventLog:System': 'windows_system',
    'WinEventLog:System': 'windows_system',
    'system_wineventlog': 'windows_system',
    'XmlWinEventLog:Application': 'windows_application',
    'WinEventLog:Application': 'windows_application',
    'application_wineventlog': 'windows_application',
    'XmlWinEventLog:Microsoft-Windows-DNS-Client/Operational': 'windows_dns_client',
    'WinEventLog:Microsoft-Windows-DNS-Client/Operational': 'windows_dns_client',
    'XmlWinEventLog:Microsoft-Windows-Windows Defender/Operational': 'windows_defender',
    'WinEventLog:Microsoft-Windows-Windows Defender/Operational': 'windows_defender',
    'XmlWinEventLog:Microsoft-Windows-Sysmon/Operational': 'windows_sysmon',
    // NTLM genuinely IS an authentication channel (UserName/DomainName/
    // WorkstationName/LogonType), so windows_security is the RIGHT target for it —
    // both its alias set and the golden Authentication spec already fit.
    'XmlWinEventLog:Microsoft-Windows-NTLM/Operational': 'windows_security',
  };
  for (const [raw, canonical] of Object.entries(expected)) {
    assert.equal(canonicalizeSourcetype(raw), canonical, `${raw} must canonicalize to ${canonical}`);
  }
});

test('each channel canonical has a golden source expectation', () => {
  // Rule 14: without a GOLDEN_SOURCE_EXPECTATIONS entry, goldenPathMatchesSample
  // cannot verify format compatibility and a wrong-format sample takes the golden
  // path anyway.
  // GOLDEN_SOURCE_EXPECTATIONS moved to the lean source-recognition module
  // (Rule 25 sanitizer split); pack-builder re-exports the recognition surface.
  const src = read('src/source-recognition.ts');
  // Bound the search to the object LITERAL. An unbounded slice matches the parser
  // switch further down the file and passes for a sourcetype that has no
  // expectation at all — which is how the missing windows_sysmon entry hid.
  const start = src.indexOf('const GOLDEN_SOURCE_EXPECTATIONS');
  assert.ok(start > 0, 'GOLDEN_SOURCE_EXPECTATIONS must be a top-level const');
  const expectations = src.slice(start, src.indexOf('\n};', start));
  for (const { st } of CHANNELS) {
    assert.match(expectations, new RegExp(`\\n  ${st}: \\{`),
      `${st} needs a GOLDEN_SOURCE_EXPECTATIONS entry — without one the guard returns 'unknown' and any sample takes the golden path`);
  }
});

// --- Sample routing: the channel split must not strand a canonical ---
// resolveWindowsChannel is a RAW-string router, but the build path canonicalizes
// BEFORE it asks for a sample. A canonical that no longer matched /wineventlog/
// would get no sample at all — the split's most likely silent failure.

// Async because the resolver's harvested tier reads the samples pool. Under
// `node --test` that transport is cache-only, so this still never touches the network.
async function referenceSample(sourcetype) {
  let body = '';
  const req = { url: `/?sourcetype=${encodeURIComponent(sourcetype)}`, headers: { host: 'localhost' } };
  await handleReferenceSample(req, { statusCode: 200, setHeader() {}, end(chunk = '') { body += chunk; } });
  return JSON.parse(body);
}

test('standalone mode serves a channel-appropriate XML sample for every canonical', async () => {
  const marker = {
    windows_security: /EventID>46\d\d</,
    windows_system: /Service Control Manager|Kernel-Power|EventLog/,
    windows_application: /Application Error|MsiInstaller|\.NET Runtime|Windows Error Reporting/,
    windows_dns_client: /DNS-Client/,
    windows_defender: /Windows Defender/,
    windows_sysmon: /Sysmon/,
  };
  for (const { st } of CHANNELS) {
    const res = await referenceSample(st);
    assert.equal(res.available, true, `${st} must resolve a sample in standalone mode`);
    // `config/sample-library/` stores Cribl EVENT objects (`{"_raw": "<Event …>"}`),
    // so read them the way the app does — `eventsToLines`, never JSON.stringify.
    const text = eventsToLines(res.events).join('\n');
    assert.match(text, /<Event\s|<Event>/, `${st} sample must be Windows Event XML`);
    assert.match(text, marker[st], `${st} sample must carry ${st} content, not another channel's`);
    // The whole point of the sample layer: the parser must recognise it.
    assert.notEqual(sampleMatchesSourceExpectation(st, text), 'mismatch',
      `${st}'s own reference sample must satisfy its golden source expectation`);
  }
});

test('a classic key=value Windows sample is admitted, and a non-Windows line is not', () => {
  // The parser now reads classic text on its own branch, so the guard admits it.
  // `wire` stays xml: a classic build files under `@kvp` and does not replay the
  // XML golden. A line that is none of the three wires is still a mismatch.
  const classic = [
    '01/13/2026 09:14:22 AM',
    'LogName=System',
    'SourceName=Service Control Manager',
    'EventCode=7045',
    'EventType=4',
    'Type=Information',
    'ComputerName=host.acme.com',
  ].join('\n');
  assert.equal(sampleMatchesSourceExpectation('windows_system', classic), 'match');
  assert.equal(sampleMatchesSourceExpectation('windows_system', '<134>May  6 17:24:01 host01 sshd[1]: Accepted publickey'), 'mismatch');
});

test('both run modes route the channel canonicals identically', () => {
  // Hard Rule 18: bundled-data.ts (iframe) and reference-api.mjs (standalone)
  // hand-mirror resolveWindowsChannel. Compare the routing lines directly — a
  // one-sided edit is how the alias table drifted before it moved to shared JSON.
  const routes = file => {
    const src = read(file);
    const body = src.slice(src.indexOf('resolveWindowsChannel'), src.indexOf('resolveLinuxFamily'));
    return body
      .split('\n')
      .filter(l => /^\s*(if|return|\?|:|const canonicalChannel|const xml)\b/.test(l) || /^\s*[?:]\s*\{/.test(l))
      .filter(l => !l.trim().startsWith('//'))
      .map(l => l.trim().replace(/^const canonicalChannel/, 'canonicalChannel'));
  };
  const standalone = routes('scripts/reference-api.mjs');
  const iframe = routes('src/bundled-data.ts');
  assert.deepEqual(iframe, standalone, 'resolveWindowsChannel must be identical in both run modes');
  // And it must actually mention every canonical, or the canonical gets no sample.
  for (const file of ['scripts/reference-api.mjs', 'src/bundled-data.ts']) {
    const src = read(file);
    assert.match(src, /\^windows_\(security\|system\|application\|defender\|dns_client\)\$/,
      `${file} must route the per-channel canonicals, not only the raw channel names`);
    for (const key of ['windows_xml_system', 'windows_xml_application', 'windows_xml_dns_client', 'windows_xml_defender', 'windows_xml_security']) {
      assert.ok(src.includes(key), `${file} must serve ${key}`);
    }
  }
});

// --- Tier B: XmlWinEventLog + PowerShell always allow a code function ----------
// Standing rule (2026-08-31): "for this xmlwineventlog, we should always allow a
// code function, as these windows events are hard to do, same as powershell."

test('isWindowsCodeFamily covers every Windows XML channel + PowerShell', () => {
  // All seven canonicals, plus the real-world spellings, must be code-allowed.
  for (const st of ['windows_security', 'windows_sysmon', 'windows_powershell',
    'windows_dns_client', 'windows_defender', 'windows_system', 'windows_application']) {
    assert.ok(isWindowsCodeFamily(st), `${st} must be a code-allowed Windows family`);
  }
  for (const raw of ['XmlWinEventLog:Security', 'WinEventLog:System',
    'XmlWinEventLog:Microsoft-Windows-Sysmon/Operational',
    'XmlWinEventLog:Microsoft-Windows-PowerShell/Operational']) {
    assert.ok(isWindowsCodeFamily(raw), `${raw} must resolve to a code-allowed family`);
  }
});

test('isWindowsCodeFamily does NOT force code on for non-Windows sources', () => {
  for (const st of ['cisco_asa', 'fortinet_fortigate', 'aws_vpc_flow', 'corelight_conn', '']) {
    assert.ok(!isWindowsCodeFamily(st), `${st} must keep the no-code default`);
  }
});

test('buildStagedPipeline forces allowCode ON for the Windows family at the choke point', () => {
  // The batch call site passes NO allowCode (defaults false), so the guarantee
  // must live inside buildStagedPipeline where every flow converges — not at the
  // per-flow call sites. That is staged-build.ts, not App.tsx: asserting against
  // a concatenation of both would not notice the choke point moving back.
  const src = read('src/staged-build.ts');
  assert.match(src, /const allowCode = \(opts\.allowCode \?\? false\) \|\| isWindowsCodeFamily\(sourcetype\)/,
    'allowCode must be OR-forced by isWindowsCodeFamily inside buildStagedPipeline');
});

void root;
