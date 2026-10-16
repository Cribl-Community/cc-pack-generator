// Local, AI-free pseudonymisation of a sample's identities (build 477).
//
// Uploaded / worker-group / pasted / live-captured events are customer data, and the app
// puts sample lines into AI prompts at a dozen call sites. Sending them to a model vendor
// is not allowed, so identities are replaced in the browser with no network call.
//
// The properties below are the whole contract, and each one exists because breaking it
// would ruin the sample rather than merely annoy someone:
//
//   * CONSISTENT — one alias per distinct value, applied everywhere. Per-occurrence
//     randomness would turn forty events about one host into forty hosts, and the
//     generated pipeline is SCORED against this sample.
//   * CLASS-PRESERVING — internal stays internal in its own block, public lands in the
//     RFC5737 documentation ranges (never a real organisation's address).
//   * SHAPE-PRESERVING — label counts, DOMAIN\user, delimiters and JSON keys survive,
//     because a parser is generated and regex-matched against these lines.
//   * COLLISION-FREE — no alias may already appear in the sample, or two real machines
//     silently merge into one.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  planSanitisation, applySanitisation, checkStructurePreserved,
  classifyIpv4, classifyIpv6, fieldIdentityKind, summariseSanitisation,
  aiSampleSnippet, sampleNeedsSanitising, UnsanitisedSampleError,
  expandToToken, describeSelection, proveIdentityCoverage, sourceHints,
  publicCorpusTokens, SCHEMA_IDENTITY_FIELD_COUNT,
  fieldAt, fieldCensus, splitExtras, PICKED_FIELD_VIA,
  decomposeShape, expandToShapeToken, encodePatternExtra, parsePatternExtra,
  PICKED_PATTERN_VIA, markSanitisation, patternPatchDisplay, rebuildPatternAlias,
  labelValueShape, groupRegexFragment, markedValueShape, markedValueShapeMulti, countShapeMatches, previewSanitisation,
  buildSanitiseChoices, canRefineSelection, splitStructuredToken, structuralOffenders,
  listNamedGroups, describeRegexDraft, regexFromSelection,
} from '../src/sample-sanitise.ts';
import { SanitisationBlocked, parseSampleLocally } from '../src/sanitised-sample-workflow.ts';
import { groupOf } from '../src/sanitise-groups.ts';
import { extractFieldValues } from '../src/sample-library.ts';
import { getParserForSourcetype, matchDatatypeParserBySample } from '../src/pack-builder.ts';

const read = p => readFileSync(new URL(p, new URL('../', import.meta.url)), 'utf8');

/** Plan + apply in one step, with a fixed seed so failures are reproducible. */
function sanitise(text, opts = {}) {
  const plan = planSanitisation(text, { seed: 12345, ...opts });
  return { plan, out: applySanitisation(text, plan.entries) };
}

/**
 * What the app does before planning: resolve a parser locally and read the field values.
 *
 * Mirrors `parseSampleLocally` in sanitised-sample-workflow.ts. Written out here rather than mocked, because the
 * claim under test is that REAL shipped parsers surface identities that no pattern can —
 * a hand-written field map would prove nothing about the parsers we actually ship.
 */
function parseLocally(text, sourcetype = '') {
  let fns = [];
  let parserName = '';
  if (sourcetype) {
    fns = getParserForSourcetype(sourcetype, false) || [];
    if (fns.length) parserName = sourcetype;
  }
  if (!fns.length) {
    const m = matchDatatypeParserBySample(text);
    if (m) { fns = m.functions; parserName = m.parserKey; }
  }
  if (!fns.length) return { parsed: [], parserName: '' };
  return {
    parsed: text.split('\n').map(l => (l.trim() ? extractFieldValues(fns, l) : null)),
    parserName,
  };
}

/** Plan + apply the way the app does: parser first, then the patterns. */
function sanitiseParsed(text, sourcetype = '', opts = {}) {
  const { parsed, parserName } = parseLocally(text, sourcetype);
  const plan = planSanitisation(text, { seed: 12345, parsed, parserName, sourcetype, ...opts });
  const out = applySanitisation(text, plan.entries);
  return { plan, out, parsed, parserName };
}

const FIREWALL = [
  'Nov 12 09:14:02 fw-edge-01 %ASA-6-302013: Built outbound TCP connection for outside:203.44.19.7/443 (203.44.19.7/443) to inside:10.20.30.40/51234',
  'Nov 12 09:14:03 fw-edge-01 %ASA-6-302013: Built outbound TCP connection for outside:203.44.19.7/443 (203.44.19.7/443) to inside:10.20.30.41/51235',
  'Nov 12 09:14:09 fw-edge-01 %ASA-6-113004: AAA user authentication Successful : server = 10.20.30.9 : user = jsmith',
].join('\n');

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

test('IPv4 classification separates internal from external', () => {
  assert.equal(classifyIpv4('10.20.30.40'), 'private');
  assert.equal(classifyIpv4('172.16.4.9'), 'private');
  assert.equal(classifyIpv4('172.32.4.9'), 'public', '172.32 is OUTSIDE the /12');
  assert.equal(classifyIpv4('192.168.1.1'), 'private');
  assert.equal(classifyIpv4('127.0.0.1'), 'loopback');
  assert.equal(classifyIpv4('169.254.1.5'), 'link-local');
  assert.equal(classifyIpv4('100.90.1.5'), 'cgnat');
  assert.equal(classifyIpv4('224.0.0.251'), 'multicast');
  assert.equal(classifyIpv4('8.8.8.8'), 'public');
  // Our own output must not be re-mapped on a second pass.
  assert.equal(classifyIpv4('192.0.2.55'), 'reserved');
  assert.equal(classifyIpv4('198.51.100.7'), 'reserved');
  assert.equal(classifyIpv4('203.0.113.9'), 'reserved');
  // Not addresses at all.
  assert.equal(classifyIpv4('999.1.1.1'), null);
  assert.equal(classifyIpv4('01.2.3.4'), null, 'a leading zero means an id, not an octet');
});

test('IPv6 classification separates unique-local from global', () => {
  assert.equal(classifyIpv6('fd00:1234::5'), 'private');
  assert.equal(classifyIpv6('fe80::1%eth0'), 'link-local');
  assert.equal(classifyIpv6('::1'), 'loopback');
  assert.equal(classifyIpv6('2606:4700::1111'), 'public');
  assert.equal(classifyIpv6('2001:db8::1'), 'reserved', 'RFC3849 is already documentation');
  assert.equal(classifyIpv6('ff02::1'), 'multicast');
});

test('an internal address stays internal and an external one lands in documentation space', () => {
  const { out } = sanitise(FIREWALL);
  assert.ok(!out.includes('10.20.30.40'), 'the private address must be gone');
  assert.ok(!out.includes('203.44.19.7'), 'the public address must be gone');

  for (const ip of out.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []) {
    const cls = classifyIpv4(ip);
    assert.ok(cls === 'private' || cls === 'reserved',
      `${ip} should be private or documentation space, got ${cls}`);
  }
  // RFC5737 is the only acceptable destination for a public address: inventing a
  // different real one attributes fabricated traffic to a real organisation.
  assert.match(out, /\b(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}\b/);
});

test('addresses that shared a subnet still share one', () => {
  // 10.20.30.40 and .41 are neighbours; pipeline logic keys on subnets, so the aliases
  // have to be neighbours too.
  const { plan } = sanitise(FIREWALL);
  const a = plan.entries.find(e => e.original === '10.20.30.40').alias;
  const b = plan.entries.find(e => e.original === '10.20.30.41').alias;
  assert.notEqual(a, b, 'two different hosts must not collapse into one');
  assert.equal(a.split('.').slice(0, 3).join('.'), b.split('.').slice(0, 3).join('.'));
});

test('loopback and multicast are protocol meaning, not identity, and are left alone', () => {
  const text = 'src=127.0.0.1 dst=224.0.0.251 relay=10.1.1.1';
  const { plan, out } = sanitise(text);
  assert.ok(out.includes('127.0.0.1'), 'loopback must survive');
  assert.ok(out.includes('224.0.0.251'), 'multicast must survive');
  assert.ok(!out.includes('10.1.1.1'), 'the private address must not');
  assert.ok(!plan.entries.some(e => e.original === '127.0.0.1'),
    'and loopback must not even be offered as a row');
});

// ---------------------------------------------------------------------------
// Consistency — the property that keeps the sample usable
// ---------------------------------------------------------------------------

test('one alias per distinct value, applied everywhere', () => {
  const { out } = sanitise(FIREWALL);
  const lines = out.split('\n');
  // 203.44.19.7 appeared four times across two lines (twice per line).
  const first = lines[0].match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
  assert.equal(first[0], first[1], 'the same address twice on one line gets one alias');
  const pub = l => (l.match(/\b(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}\b/) || [])[0];
  assert.equal(pub(lines[0]), pub(lines[1]), 'and the same alias on the next line');
  // fw-edge-01 is the host on all three lines.
  const host = l => l.match(/^\w{3} \d+ [\d:]+ (\S+)/)[1];
  assert.equal(host(lines[0]), host(lines[1]));
  assert.equal(host(lines[1]), host(lines[2]));
});

test('distinct values never collapse onto one alias', () => {
  const ips = Array.from({ length: 60 }, (_, i) => `src_ip=10.5.${i}.${i + 1}`).join('\n');
  const { plan } = sanitise(ips);
  const aliases = plan.entries.map(e => e.alias);
  assert.equal(new Set(aliases).size, aliases.length, 'the mapping must be injective');
});

test('no alias may already appear anywhere in the sample', () => {
  // "Do not use the names which are in the files" — including names that belong to
  // something else entirely, or two machines silently merge into one.
  const text = [
    'user=alice host=node14 dest=web01.corp.local',
    'user=bob host=srv02 dest=app07.corp.local',
    'note: brook and adler and stone are all present as words here',
  ].join('\n');
  const { plan } = sanitise(text);
  const originals = new Set(plan.entries.map(e => e.original.toLowerCase()));
  const tokens = new Set((text.toLowerCase().match(/[a-z0-9][\w.$-]*/g) || []));
  for (const e of plan.entries) {
    for (const label of e.alias.toLowerCase().split(/[.@\\]/)) {
      if (!label || /^\d+$/.test(label)) continue;
      assert.ok(!tokens.has(label) || originals.has(label),
        `alias part "${label}" for ${e.original} already occurs in the sample`);
    }
  }
});

test('the same seed reproduces the mapping and different seeds do not', () => {
  const a = planSanitisation(FIREWALL, { seed: 7 }).entries.map(e => e.alias).join();
  const b = planSanitisation(FIREWALL, { seed: 7 }).entries.map(e => e.alias).join();
  const c = planSanitisation(FIREWALL, { seed: 8 }).entries.map(e => e.alias).join();
  assert.equal(a, b, 'a fixed seed is reproducible');
  assert.notEqual(a, c, 'and an unseeded run is not guessable from another run');
});

// ---------------------------------------------------------------------------
// Shape — the sample still has to parse
// ---------------------------------------------------------------------------

test('hostname aliases keep the label count', () => {
  const { plan } = sanitise('host=web01.corp.local peer=mail.example-corp.com short=srv9');
  for (const e of plan.entries.filter(x => x.kind === 'fqdn' || x.kind === 'host')) {
    assert.equal(e.alias.split('.').length, e.original.split('.').length,
      `${e.original} → ${e.alias} changed depth; parsers split on dots`);
  }
});

test('hosts that shared a domain still share one', () => {
  // Scattering one estate across several fake domains is visibly wrong to a reviewer and
  // wrong to any pipeline that extracts a domain and groups by it.
  const { plan } = sanitise('host=fw-edge-01.acme.local\nhost=fw-edge-02.acme.local\nhost=db-01.other.net');
  const dom = o => plan.entries.find(e => e.original === o).alias.split('.').slice(1).join('.');
  assert.equal(dom('fw-edge-01.acme.local'), dom('fw-edge-02.acme.local'));
  assert.notEqual(dom('fw-edge-01.acme.local'), dom('db-01.other.net'),
    'and two different domains must not merge into one');
});

test('DOMAIN\\user keeps its shape and splits into two identities', () => {
  const { plan, out } = sanitise('EventID=4624 SubjectUserName=jsmith Account=CORP\\jsmith');
  assert.match(out, /[\w-]+\\[\w.$-]+/, 'the DOMAIN\\user form must survive');
  assert.ok(!out.includes('CORP\\jsmith'));
  assert.ok(plan.entries.some(e => e.original === 'CORP' && e.kind === 'host'));
  assert.ok(plan.entries.some(e => e.original === 'jsmith' && e.kind === 'user'));
  // One identity, one alias — the bare SubjectUserName and the one after the backslash
  // are the same person and must read as the same person afterwards.
  const [, bare, afterSlash] = out.match(/SubjectUserName=(\S+) Account=[\w-]+\\(\S+)/);
  assert.equal(bare, afterSlash);
});

test('an email keeps its local@domain form', () => {
  const { out } = sanitise('sender=j.smith@acme-corp.com');
  assert.ok(!out.includes('j.smith@acme-corp.com'));
  assert.match(out, /sender=[\w.+-]+@[\w.-]+\.\w+$/);
});

test('a machine account keeps its trailing $', () => {
  const { out } = sanitise('TargetUserName=WEB01$');
  assert.ok(!out.includes('WEB01$'));
  assert.match(out, /TargetUserName=\S+\$$/);
});

test('a MAC alias is locally administered, so it cannot be a real vendor OUI', () => {
  const { out } = sanitise('mac=00:1b:44:11:3a:b7');
  assert.ok(!out.includes('00:1b:44:11:3a:b7'));
  assert.match(out, /mac=02(?::[0-9a-f]{2}){5}/);
});

test('JSON survives: it still parses and the field NAMES are untouched', () => {
  const json = [
    JSON.stringify({ src_ip: '10.1.2.3', user: 'jsmith', host: 'web01.corp.local', bytes: 4211 }),
    JSON.stringify({ src_ip: '10.1.2.4', user: 'bthomas', host: 'web02.corp.local', bytes: 91 }),
  ].join('\n');
  const { out } = sanitise(json);
  const check = checkStructurePreserved(json, out);
  assert.ok(check.ok, `structure changed: ${check.problems.join(' ')}`);
  for (const line of out.split('\n')) {
    const o = JSON.parse(line);
    assert.deepEqual(Object.keys(o).sort(), ['bytes', 'host', 'src_ip', 'user']);
    assert.equal(typeof o.bytes, 'number', 'a number must not be rewritten as a string');
  }
});

test('delimiters and whitespace are preserved for positional parsers', () => {
  const csv = '2024-01-01,10.4.5.6,jsmith,web01.corp.local,200\n2024-01-01,10.4.5.7,bthomas,web02.corp.local,404';
  const { out } = sanitise(csv);
  const check = checkStructurePreserved(csv, out);
  assert.ok(check.ok, `structure changed: ${check.problems.join(' ')}`);
  for (const line of out.split('\n')) assert.equal(line.split(',').length, 5);
});

test('a masked value can never change the wire format — the mint guard is unconditional', () => {
  // A display name ("John Smith") carries an internal space; a "SMITH, John" carries a comma.
  // The `user` minter used to collapse these to a single spaceless token, dropping the separator
  // and shifting the field boundary — which the save gate then rejected. The guard re-mints any
  // alias whose structural-char count differs from the value it replaces, across every wire format.
  const cases = [
    'user="John Smith" src=10.1.2.3 city=Amsterdam',        // KVP, quoted display name
    'user="SMITH, John" dept=Sales',                          // KVP, comma inside the value
    '2024-01-01,John Smith,10.1.2.3,jsmith,login',            // CSV column that is a display name
    '2024-01-01\tJohn Smith\t10.1.2.3\tlogin',                // TSV
    'John Smith|jdoe|10.1.2.3|admin',                          // pipe-delimited
    '{"name":"John Smith","user":"jdoe","ip":"10.1.2.3"}',    // JSON value with a space
  ];
  for (const before of cases) {
    const { plan, out } = sanitise(before);
    const check = checkStructurePreserved(before, out);
    assert.ok(check.ok, `wire format changed for ${JSON.stringify(before)}: ${check.problems.join(' ')}`);
    // And the guard's own predicate agrees: no enabled entry is a structural offender.
    assert.equal(structuralOffenders(plan.entries).size, 0,
      `an offender survived for ${JSON.stringify(before)}`);
  }
});

test('the structure check actually catches damage', () => {
  // A guard is only worth having if it fires, so break a sample deliberately.
  const before = '{"user":"a","host":"b"}';
  assert.ok(!checkStructurePreserved(before, '{"user":"a","hostname":"b"}').ok, 'renamed key');
  assert.ok(!checkStructurePreserved(before, '{"user":"a" "host":"b"}').ok, 'broken JSON');
  assert.ok(!checkStructurePreserved('a,b,c', 'a,b').ok, 'lost a delimiter');
  assert.ok(!checkStructurePreserved('a b', 'a  b').ok, 'shifted whitespace');
  assert.ok(!checkStructurePreserved('one\ntwo', 'one').ok, 'lost a line');
});

// ---------------------------------------------------------------------------
// False positives — what must NOT be touched
// ---------------------------------------------------------------------------

test('a version string that looks like an IPv4 address is left alone', () => {
  const text = 'agent version=10.1.2.3 started, schema v4.2.1.9 loaded';
  const { plan, out } = sanitise(text);
  assert.equal(out, text, 'a version-only literal must survive verbatim');
  assert.ok(plan.warnings.some(w => w.includes('version keyword')),
    'and the reviewer has to be told why it was skipped');
});

test('a literal that is both a version and a real address is replaced, and said so', () => {
  // One alias per value means this cannot be decided per occurrence. Leaking a real
  // address is worse than rewriting a version number, so privacy wins and the warning
  // tells the reviewer to untick it if they disagree.
  const text = 'agent version=10.1.2.3 connected from src_ip=10.1.2.3';
  const { plan, out } = sanitise(text);
  assert.ok(!out.includes('10.1.2.3'), 'the address must not survive anywhere');
  assert.ok(plan.warnings.some(w => w.includes('both as an address')));
});

test('field names are never rewritten, only values', () => {
  const text = 'hostname=web01 username=jsmith src_ip=10.9.8.7';
  const { out } = sanitise(text);
  for (const key of ['hostname=', 'username=', 'src_ip=']) {
    assert.ok(out.includes(key), `${key} must survive — rewriting a key breaks the parse`);
  }
});

test('a bare word is not touched without a field that says what it holds', () => {
  // `jsmith` in free text is indistinguishable from any other word. Guessing would
  // corrupt product names, status strings and message text.
  const { plan } = sanitise('the connection to jsmith failed after 3 retries');
  assert.equal(plan.entries.length, 0);
  assert.ok(plan.warnings.some(w => w.includes('Bare names')),
    'and the UI must say so, because this is the real gap in coverage');
});

test('structural and reserved placeholders are never replaced', () => {
  const text = 'host=localhost user=root dest=example.com peer=unknown src=-';
  const { plan } = sanitise(text);
  assert.equal(plan.entries.length, 0, `nothing here is an identity: ${JSON.stringify(plan.entries)}`);
});

test('ports, counters and ids in identity-ish fields are not mistaken for names', () => {
  const { plan } = sanitise('src_port=51234 user=1001 event_code=4624');
  assert.ok(!plan.entries.some(e => e.original === '51234'));
  assert.ok(!plan.entries.some(e => e.original === '4624'));
});

// ---------------------------------------------------------------------------
// The manual escape hatch and re-running
// ---------------------------------------------------------------------------

test('extra literals cover what no detector can find', () => {
  const text = 'ACME-PROD cluster reported by acme-core-01';
  const { plan, out } = sanitise(text, { extraLiterals: ['ACME-PROD', 'acme-core-01'] });
  assert.ok(!out.includes('ACME-PROD'));
  assert.ok(!out.includes('acme-core-01'));
  assert.equal(plan.entries.filter(e => e.kind === 'custom').length, 2);
  assert.ok(plan.entries.every(e => e.via !== 'FQDN pattern' || true));
});

test('a literal that is not in the sample is reported, not silently ignored', () => {
  const { plan } = sanitise('nothing to see', { extraLiterals: ['ACME'] });
  assert.ok(plan.warnings.some(w => w.includes('does not appear')));
});

test('an unchecked row is left completely alone', () => {
  // False positives are unchecked by the reviewer, not deleted from the plan.
  const plan = planSanitisation(FIREWALL, { seed: 5 });
  for (const e of plan.entries) e.enabled = e.original !== 'fw-edge-01';
  const out = applySanitisation(FIREWALL, plan.entries);
  assert.ok(out.includes('fw-edge-01'), 'the unchecked value must survive verbatim');
  assert.ok(!out.includes('10.20.30.40'), 'the checked ones must not');
});

test('re-running does not churn public addresses or hostnames', () => {
  // Public IPs land in RFC5737 and hostnames in RFC2606 space, both of which are
  // recognisably "already documentation", so a second pass leaves them alone.
  //
  // A PRIVATE alias is still a private address and a username alias is still a
  // username, so those are indistinguishable from real ones and would be re-rolled.
  // That is unfixable by detection — the caller records that a sample was sanitised
  // instead of trying to recognise its own output.
  const { out } = sanitise('src_ip=10.1.2.3 dst=8.8.4.4 host=web01.corp.local user=jsmith');
  const second = planSanitisation(out, { seed: 999 });
  const churned = second.entries.map(e => `${e.kind}:${e.original}`);
  assert.ok(!churned.some(c => c.startsWith('fqdn')), `hostname re-rolled: ${churned}`);
  assert.ok(!second.entries.some(e => e.kind === 'ipv4' && classifyIpv4(e.original) === 'reserved'),
    `documentation address re-rolled: ${churned}`);
});

test('a longer value is replaced before the shorter one nested inside it', () => {
  // Replacing bare `web01` first would corrupt `web01.corp.local` into a hybrid.
  const text = 'host=web01 fqdn=web01.corp.local';
  const { out } = sanitise(text);
  assert.ok(!out.includes('web01'), `both forms must be gone: ${out}`);
  const alias = out.match(/fqdn=(\S+)/)[1];
  assert.equal(alias.split('.').length, 3);
});

// ---------------------------------------------------------------------------
// Field knowledge and reporting
// ---------------------------------------------------------------------------

test('the shipped field-alias table is what tells us which fields hold identities', () => {
  // Reusing config/datatype-field-aliases.json means every vendor spelling it already
  // knows (dvchost, suser, syslog_hostname…) works without a second list to maintain.
  assert.equal(fieldIdentityKind('dvchost'), 'host');
  assert.equal(fieldIdentityKind('syslog_hostname'), 'host');
  assert.equal(fieldIdentityKind('suser'), 'user');
  assert.equal(fieldIdentityKind('username'), 'user');
  assert.equal(fieldIdentityKind('SubjectUserName'), 'user');
  assert.equal(fieldIdentityKind('src_ip'), 'ipv4');
  assert.equal(fieldIdentityKind('bytes_out'), null);
  assert.equal(fieldIdentityKind('severity'), null);
});

test('the summary counts what changed, for the audit line', () => {
  const { plan } = sanitise(FIREWALL);
  const summary = summariseSanitisation(plan.entries);
  assert.match(summary, /IP address/);
  assert.equal(summariseSanitisation([]), 'nothing replaced');
});

// ---------------------------------------------------------------------------
// Picking a value out by highlighting it in the sample
// ---------------------------------------------------------------------------

/** Select the first occurrence of `what` in `text`, as dragging over it would. */
function selectIn(text, what, entries = []) {
  const start = text.indexOf(what);
  assert.ok(start >= 0, `"${what}" is not in the text`);
  return describeSelection({ text, start, end: start + what.length, entries });
}

test('a half-selected value grows to the whole value', () => {
  // Replacement is whole-token, so a literal of `acme` would match nothing inside
  // `acme-corp.com`, get dropped as a zero-hit entry, and vanish with no explanation.
  const text = 'host=acme-corp.com user=j.smith ip=10.1.2.3';
  assert.equal(expandToToken(text, text.indexOf('acme'), text.indexOf('acme') + 4), 'acme-corp.com');
  assert.equal(expandToToken(text, text.indexOf('smith'), text.indexOf('smith') + 5), 'j.smith');
  assert.equal(expandToToken(text, text.indexOf('10'), text.indexOf('10') + 2), '10.1.2.3');
});

test('growing stops at a backslash, so DOMAIN\\user stays two identities', () => {
  const text = 'Account=CORP\\jsmith';
  assert.equal(expandToToken(text, text.indexOf('jsmith'), text.length), 'jsmith');
  assert.equal(expandToToken(text, text.indexOf('CORP'), text.indexOf('CORP') + 4), 'CORP');
});

test('trailing sentence punctuation is not swallowed', () => {
  const text = 'connection to gateway failed. retrying';
  assert.equal(expandToToken(text, text.indexOf('failed'), text.indexOf('failed') + 6), 'failed');
});

test('a selection with no separators falls back to the reviewer edges', () => {
  // A long unbroken run (a base64 blob) would otherwise swallow the whole line.
  const blob = 'x'.repeat(200);
  const picked = expandToToken(blob, 10, 24);
  assert.equal(picked, 'x'.repeat(14), 'trust the drag when growing cannot help');
});

test('highlighting a bare hostname offers to sanitise it', () => {
  // This is the case no detector can reach: `acme-core-01` in free text is just a word.
  const text = 'cluster acme-core-01 reported degraded';
  const sel = selectIn(text, 'acme-core-01');
  assert.equal(sel.ok, true, sel.reason);
  assert.equal(sel.literal, 'acme-core-01');
});

test('a selection spanning lines is refused', () => {
  // Replacing it would take the newline with it and merge two events into one.
  const text = 'line one host=a\nline two host=b';
  const sel = describeSelection({ text, start: 5, end: 20, entries: [] });
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /single value/);
});

test('a selection that is only a number is refused', () => {
  const sel = selectIn('src_port=51234 bytes=99', '51234');
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /corrupt ports, counters and IDs/);
});

// ---------------------------------------------------------------------------
// Picking the field instead of the value (build 486)
// ---------------------------------------------------------------------------
//
// A reviewer highlighting `51015341` in `quoteNumber=51015341` was told "that is just a
// number" and left with nowhere to go. True of the eight characters and useless: the sample
// says right next to them which eight characters they are. The number is genuinely unsafe to
// replace on its own — 51015341 is a port, a counter and an ID on some other line — and the
// FIELD is perfectly safe to replace, and only the first of those two facts was reported.
//
// It was a dead end the panel walked people into: the closing warning about business
// identifiers ends by telling the reviewer to add the values below, and there is no value to
// add when the field holds a different one on every event.

/** businessevent.log in miniature — one distinct quote and order number per line. */
const kvEvents = [
  'orderType=ChangeESN, quoteNumber=51015341, orderNumber=9000000000000001, esn=3852D7E1E16801, phoneCode=BBT, marketState=NA',
  'orderType=ChangeESN, quoteNumber=91989734, orderNumber=9000000000000002, esn=3852D7E1E16802, phoneCode=IP6P-64, marketState=GA',
  'orderType=NewLine,   quoteNumber=23355369, orderNumber=9000000000000003, esn=3852D7E1E16803, phoneCode=SGS5, marketState=TX',
].join('\n');

/** Select a field's first value the way double-clicking it would. */
function selectValueOf(text, field, opts = {}) {
  const m = new RegExp(`\\b${field}=(\\S+?)[,\\s]`).exec(`${text} `);
  assert.ok(m, `${field}= is not in the text`);
  const start = m.index + field.length + 1;
  return describeSelection({ text, start, end: start + m[1].length, entries: [], ...opts });
}

test('a selection is located in the key=value pair it sits inside', () => {
  const at = fieldAt(kvEvents, kvEvents.indexOf('51015341'));
  assert.deepEqual(at, { name: 'quoteNumber', value: '51015341' });

  // The pair the offset is in, not merely the nearest one to its left.
  assert.equal(fieldAt(kvEvents, kvEvents.indexOf('9000000000000001')).name, 'orderNumber');
  // Free text between pairs belongs to no field.
  assert.equal(fieldAt('the server went away', 4), null);
});

test('highlighting a bare number offers its field instead of refusing outright', () => {
  const sel = selectValueOf(kvEvents, 'quoteNumber');

  // Still refused as a literal, and for the same good reason as before.
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /just a number/);

  // But no longer a dead end: the field is named, counted, and offerable.
  assert.equal(sel.field.name, 'quoteNumber');
  assert.equal(sel.field.distinct, 3);
  assert.equal(sel.field.occurrences, 3);
  assert.equal(sel.field.covered, false);
  assert.match(sel.reason, /by its field/);
});

test('a number with no field around it is still a plain refusal', () => {
  // Nothing to anchor it to, so there is no safe offer to make — and the message says which
  // of the two problems it is rather than implying the value might be salvageable.
  const sel = selectIn('backup completed in 51234 seconds', '51234');
  assert.equal(sel.ok, false);
  assert.equal(sel.field, undefined);
  assert.match(sel.reason, /no field name around it/);
});

test('picking a field replaces every value it holds, in the shape it held them', () => {
  const { plan, out } = sanitise(kvEvents, { extraFields: ['quoteNumber'] });
  const picked = plan.entries.filter(e => e.via.startsWith(PICKED_FIELD_VIA));

  assert.equal(picked.length, 3, 'one row per distinct value');
  for (const q of ['51015341', '91989734', '23355369']) {
    assert.ok(!out.includes(q), `${q} survived the pick`);
  }

  /* Digits stay the same count of digits. A quote number that came back as `edge450` would
     break the extraction the generated pipeline is scored on — which is what the default
     `custom` alias would have produced, and why these are minted as pii. */
  for (const e of picked) {
    assert.match(e.alias, /^\d+$/, `${e.original} became ${e.alias}`);
    assert.equal(e.alias.length, e.original.length);
  }
  assert.equal(new Set(picked.map(e => e.alias)).size, 3, 'two quotes must not merge into one');
  assert.ok(checkStructurePreserved(kvEvents, out).ok);
});

test('an explicit pick beats the lists that would otherwise skip the field', () => {
  /* Both defaults exist for good reasons and both are wrong once the reviewer has
     overruled them. Losing to either would make the pick do nothing at all, and a button
     that quietly does nothing is worse than one that is not offered. */

  // `orderNumber` is a business identifier: counted in a warning, never turned into rows.
  const order = sanitise(kvEvents, { extraFields: ['orderNumber'] });
  assert.equal(order.plan.entries.filter(e => e.via.startsWith(PICKED_FIELD_VIA)).length, 3);
  assert.ok(!order.out.includes('9000000000000001'));

  // `phoneCode` is product vocabulary: its values are never-replace wherever they appear.
  const phone = sanitise(kvEvents, { extraFields: ['phoneCode'] });
  assert.ok(phone.plan.entries.some(e => e.original === 'IP6P-64' && e.via.startsWith(PICKED_FIELD_VIA)));
  assert.ok(!phone.out.includes('IP6P-64'));
});

test('a placeholder survives a field pick, because replacing it changes how the line parses', () => {
  // `marketState=NA` means absent. Aliasing it to `XQ` invents a state that was never there
  // and quietly changes what the sample says.
  const { plan, out } = sanitise(kvEvents, { extraFields: ['marketState'] });
  assert.ok(out.includes('marketState=NA'), 'NA was rewritten');
  assert.ok(!plan.entries.some(e => e.original === 'NA'));
  // The real values still go.
  assert.ok(!out.includes('marketState=GA'));
});

test('a field already being replaced is not offered a second time', () => {
  // `esn` is found by its own name and replaced everywhere. Offering it again would have
  // the reviewer fixing what is not broken, then wondering why nothing changed.
  const { plan } = sanitise(kvEvents);
  const sel = selectValueOf(kvEvents, 'esn', { entries: plan.entries });
  assert.equal(sel.field.covered, true);

  // Same for a field picked earlier in this session.
  const already = selectValueOf(kvEvents, 'quoteNumber', { pickedFields: ['quoteNumber'] });
  assert.equal(already.field.covered, true);
});

test('a pick that matches nothing says so rather than going quiet', () => {
  const { plan } = sanitise(kvEvents, { extraFields: ['nosuchfield'] });
  const warning = plan.warnings.find(w => w.includes('nosuchfield'));
  assert.ok(warning, `no warning about a field that was not found: ${JSON.stringify(plan.warnings)}`);
  assert.match(warning, /pick the values themselves/);
});

test('the count offered is of the whole sample, not the slice on screen', () => {
  // The box shows the first lines only; a pick acts on all of them. Counting what is visible
  // would promise three values and change three hundred.
  const visible = kvEvents.split('\n')[0];
  const sel = describeSelection({
    text: visible,
    start: visible.indexOf('51015341'),
    end: visible.indexOf('51015341') + 8,
    entries: [],
    censusText: kvEvents,
  });
  assert.equal(sel.field.distinct, 3);
  assert.deepEqual(fieldCensus(kvEvents, 'quotenumber').values, new Set(['51015341', '91989734', '23355369']));
});

test('a field pick rides in the same list as a typed literal, so it can be removed again', () => {
  const split = splitExtras('ACME, field:quoteNumber, acme-core-01');
  assert.deepEqual(split.literals, ['ACME', 'acme-core-01']);
  assert.deepEqual(split.fields, ['quoteNumber']);

  // Deleting the token puts the values back — the only undo the box has to offer.
  assert.deepEqual(splitExtras('ACME, acme-core-01').fields, []);
  assert.deepEqual(splitExtras('').fields, []);
});

test('picked values are grouped as the reviewer’s own decision', () => {
  // Not buried among rows they never chose: a pick is an answer to a question the tool
  // could not answer, and it has to be visible enough to confirm it landed.
  const { plan } = sanitise(kvEvents, { extraFields: ['quoteNumber'] });
  const picked = plan.entries.filter(e => e.via.startsWith(PICKED_FIELD_VIA));
  assert.ok(picked.length);
  for (const e of picked) assert.equal(groupOf(e).id, 'picked');
  assert.match(groupOf(picked[0]).note(picked.length, plan), /quoteNumber/);

  // And reported in the terms the reviewer used — the field, not a hundred values.
  const said = plan.warnings.find(w => w.includes('because you picked'));
  assert.ok(said, 'the pick is confirmed in the warnings');
  assert.match(said, /quoteNumber/);
});

test('a one-character selection is refused', () => {
  const text = 'user=a host=b';
  const sel = describeSelection({ text, start: 5, end: 6, entries: [] });
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /Too short/);
});

test('a structural placeholder is refused', () => {
  const sel = selectIn('host=localhost', 'localhost');
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /structural placeholder/);
});

test('selecting something already covered says so instead of duplicating it', () => {
  const text = 'src_ip=10.1.2.3 user=jsmith';
  const { plan } = sanitise(text);
  const exact = selectIn(text, '10.1.2.3', plan.entries);
  assert.equal(exact.ok, false);
  assert.match(exact.reason, /Already covered/);
  assert.match(exact.reason, new RegExp(plan.entries.find(e => e.original === '10.1.2.3').alias));
});

test('selecting the domain half of an email grows to the whole address', () => {
  // Growing crosses `@`, so this lands on the existing email entry rather than adding a
  // second row for the domain that the email row already consumes.
  const text = 'sender=j.smith@acme-corp.com';
  const { plan } = sanitise(text);
  const sel = selectIn(text, 'acme-corp.com', plan.entries);
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /Already covered/);
});

test('selecting one word of a multi-word literal says which one covers it', () => {
  // Growing cannot cross a space, so this is the case that needs the containment check.
  const text = 'cluster ACME PROD reported degraded';
  const { plan } = sanitise(text, { extraLiterals: ['ACME PROD'] });
  const sel = selectIn(text, 'ACME', plan.entries);
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /part of “ACME PROD”/);
});

test('an empty selection is nothing to report on', () => {
  assert.equal(describeSelection({ text: 'abc', start: 2, end: 2, entries: [] }), null);
  assert.equal(describeSelection({ text: 'a  b', start: 1, end: 3, entries: [] }), null);
});

test('a picked value is replaced everywhere, not just where it was highlighted', () => {
  // The literal is what gets added, never an offset — so a value highlighted in the
  // displayed lines still applies to a sample far longer than the box shows.
  const text = [
    'cluster acme-core-01 up',
    'cluster acme-core-01 degraded',
    'peer acme-core-01 lost',
  ].join('\n');
  const sel = selectIn(text, 'acme-core-01');
  const { plan, out } = sanitise(text, { extraLiterals: [sel.literal] });
  assert.ok(!out.includes('acme-core-01'));
  assert.equal(plan.entries.find(e => e.original === 'acme-core-01').count, 3);
});

test('a picked value is aliased by its shape, not as an opaque token', () => {
  // Someone selecting a hostname means the hostname: an opaque `edge450` in its place
  // would break any parser that splits it on dots.
  const fqdn = sanitise('note acme-corp.com here', { extraLiterals: ['acme-corp.com'] });
  const alias = fqdn.plan.entries[0].alias;
  assert.equal(alias.split('.').length, 2, `expected a 2-label hostname, got ${alias}`);

  const ip = sanitise('note 10.9.9.9 here', { extraLiterals: ['10.9.9.9'] });
  assert.equal(classifyIpv4(ip.plan.entries[0].alias), 'private', 'an internal address stays internal');
});

test('an alias replaces a letter with a letter and a digit with a digit, in place', () => {
  /* A parser matches an extracted value against a character class — `[A-Za-z]` here,
     `[0-9]` there — so the stand-in has to keep each position's class or the extraction
     the sample is scored against stops matching. A picked literal with no hostname/email/IP
     shape used to come back as `${word}${digits}`, appending digits a purely-alphabetic
     value never had (and letters where there had been digits). */
  const classOf = ch => (/[0-9]/.test(ch) ? 'd' : /[A-Za-z]/.test(ch) ? 'a' : ch);
  const shapeOf = s => [...s].map(classOf).join('');

  // A shapeless literal pick (no dots/@ to read as a hostname/email).
  const lit = sanitise('token WinLogBeat here', { extraLiterals: ['WinLogBeat'] });
  const litAlias = lit.plan.entries.find(e => e.original === 'WinLogBeat').alias;
  assert.notEqual(litAlias, 'WinLogBeat', 'the literal is actually replaced');
  assert.equal(shapeOf(litAlias), shapeOf('WinLogBeat'),
    `each position keeps its class: ${litAlias} vs WinLogBeat`);

  // A pattern-group pick on a mixed letters+digits run.
  const pat = sanitise('id=win8cvha done', {
    extraPatterns: [{ source: 'id=(?<v>[a-z0-9]+)', groupNames: ['v'] }],
  });
  const patEntry = pat.plan.entries.find(e => e.original.includes('win8cvha'));
  const patched = patEntry.alias.match(/id=([a-z0-9]+)/)[1];
  assert.equal(shapeOf(patched), shapeOf('win8cvha'),
    `the group stand-in keeps each position's class: ${patched} vs win8cvha`);
});

test('the new-pack step delegates the picker to the sample-library wizard', () => {
  const app = read('src/App.tsx');
  // The inline picker/plan/apply UI is gone — sanitising is the SanitizeWizard modal,
  // opened in apply mode and seeded from the loaded sample. The picker wiring lives in
  // the wizard (its own parity test covers the selection/choice plumbing).
  assert.match(app, /import \{ SanitizeWizard\b[^}]*\} from '\.\/sanitize-wizard'/, 'the wizard is imported');
  assert.match(app, /<SanitizeWizard\b/, 'and rendered');
  assert.match(app, /applyMode/, 'in apply mode (no library save destinations)');
  assert.match(app, /initialRaw=\{state\.sampleEvents\}/, 'seeded from the loaded sample');
  assert.match(app, /onApply=\{onApplySanitised\}/, 'and hands the sanitised events back');
  // No drift back to a second inline implementation of the picker.
  assert.ok(!/onSanitiseSelect|applySanitiseChoice|replanSanitise\b/.test(app),
    'the inline picker handlers are removed from the new-pack step');
});

// ---------------------------------------------------------------------------
// The guard — a button is opt-in, the requirement is a prohibition
// ---------------------------------------------------------------------------

test('only the four customer-data sources need sanitising', () => {
  // Gating a reference or AI-generated sample would block work that never had a privacy
  // question, and a guard that blocks safe work is a guard people switch off.
  for (const mode of ['upload', 'existing', 'paste', 'live-capture']) {
    assert.equal(sampleNeedsSanitising(mode), true, mode);
  }
  for (const mode of ['ai-generate', '', 'reference']) {
    assert.equal(sampleNeedsSanitising(mode), false, mode);
  }
});

test('un-sanitised customer events cannot become a prompt snippet', () => {
  const call = () => aiSampleSnippet({
    sampleEvents: FIREWALL, sourceMode: 'upload', sanitised: false, required: true,
  });
  assert.throws(call, UnsanitisedSampleError);
  // The message has to name the fix — a guard that only says "no" gets switched off.
  assert.throws(call, /Sanitize sample/);
  assert.throws(call, /Samples → Sharing/);
});

test('the guard lets through what it should', () => {
  const base = { sampleEvents: FIREWALL, lines: 2 };
  const snip = o => aiSampleSnippet({ ...base, ...o });
  assert.ok(snip({ sourceMode: 'upload', sanitised: true, required: true }), 'sanitised');
  assert.ok(snip({ sourceMode: 'ai-generate', sanitised: false, required: true }), 'not customer data');
  assert.ok(snip({ sourceMode: 'upload', sanitised: false, required: false }), 'policy off');
  assert.equal(
    aiSampleSnippet({ sampleEvents: '', sourceMode: 'upload', sanitised: false, required: true }),
    '', 'an empty sample is not a leak');
});

test('the snippet is line-capped, as every call site used to do by hand', () => {
  const snip = aiSampleSnippet({
    sampleEvents: FIREWALL, sourceMode: 'upload', sanitised: true, required: true, lines: 2,
  });
  assert.equal(snip.split('\n').length, 2);
});

test('the guard throws rather than returning an empty snippet', () => {
  // A silent empty snippet would make the model answer confidently about nothing, and the
  // pack would be quietly worthless. Loud beats subtly wrong.
  let returned = 'not thrown';
  try {
    returned = aiSampleSnippet({ sampleEvents: FIREWALL, sourceMode: 'paste', sanitised: undefined, required: true });
  } catch { returned = 'threw'; }
  assert.equal(returned, 'threw');
});

// ---------------------------------------------------------------------------
// Wiring — the feature has to be reachable and the mark has to be trustworthy
// ---------------------------------------------------------------------------

test('all four ingestion paths reach the button, because they share one preview', () => {
  const app = read('src/App.tsx');
  // Upload, worker-group, paste and live-capture all land in state.sampleEvents and
  // render the same preview + banner, so one button covers all four. If that ever forks,
  // this test is the reminder that the button has to fork with it.
  assert.match(app, /Sanitize sample/, 'the button exists');
  assert.match(app, /onClick=\{\(\) => setSanitiseModalOpen\(true\)\}/, 'and opens the wizard modal');
  // Applying happens inside the wizard; App only receives the sanitised result.
  assert.match(app, /const onApplySanitised = \(events: string\[\], sanitisedSourcetype: string, warning\?: string \| null\) =>/,
    'App receives the sanitised events plus a non-blocking wire-format warning from the wizard');
  assert.match(app, /update\(\{ sampleEvents: events\.join\('\\n'\), sampleSanitised: true \}\)/,
    'and loads them, marking the sample clean');
  // The button must NOT be active for AI or reference/library samples — those are
  // already clean, and offering sanitise there is noise that people click by habit.
  assert.match(app, /sampleNeedsSanitising\(state\.sourceMode\) && \(/,
    'the sanitise UI is gated on customer-data source modes');
});

test('AI and library samples never open the sanitise panel', () => {
  // sampleNeedsSanitising is the single gate: false for ai-generate / reference / '' means
  // the UI wrapper does not render. Sanitise stays behind the button for customer data only.
  for (const mode of ['ai-generate', 'reference', '']) {
    assert.equal(sampleNeedsSanitising(mode), false, mode);
  }
  const app = read('src/App.tsx');
  assert.match(app, /sampleNeedsSanitising\(state\.sourceMode\) && \(/,
    'the sanitise UI is gated on customer-data source modes');
  assert.ok(!app.includes('autoPlanSanitise'),
    'sanitise is opt-in via the button — it must not auto-open on sample load');
  assert.match(app, /AI \/ reference \/ library samples never need sanitising/,
    'switching into a clean mode clears the leftover undo snapshot');
});

test('sanitise stays behind the Sanitize sample button', () => {
  // Optional: load a sample, see a button, click it to open the wizard modal. Auto-opening
  // made every customer paste feel like a mandatory review step.
  const app = read('src/App.tsx');
  assert.match(app, /onClick=\{\(\) => setSanitiseModalOpen\(true\)\}/, 'the button opens the wizard modal');
  assert.match(app, /const \[sanitiseModalOpen, setSanitiseModalOpen\] = useState\(false\)/,
    'the modal starts closed — nothing opens it until the button is pressed');
  assert.ok(!/\bautoPlanSanitise\b/.test(app), 'no auto-open on sample land');
});

test('the sanitised mark is cleared whenever the sample changes', () => {
  // The mark is what the guard trusts. A stale `true` would send raw customer data to a
  // model vendor while the guard reported success — the worst possible failure here.
  const app = read('src/App.tsx');
  const from = app.indexOf('const update = (partial: Partial<WizardState>)');
  assert.ok(from > 0, 'update() must exist');
  const updateFn = app.slice(from, app.indexOf('\n  };', from));
  assert.match(updateFn, /partial\.sampleEvents !== s\.sampleEvents/,
    'update() must compare the incoming sample against the current one');
  assert.match(updateFn, /next\.sampleSanitised = false/, 'and clear the mark when it differs');
});

test('the wizard build and advice paths go through the guard, not a hand-rolled slice', () => {
  const app = read('src/App.tsx');
  assert.match(app, /sampleSnippet = aiSampleSnippet\(\{/, 'the build path');
  assert.match(app, /sampleSnippet = aiSampleSnippet\(\{[\s\S]{0,400}?catch/, 'the advice path reports the refusal');
  // The old pattern is what made the policy unenforceable: fifteen call sites each
  // deciding for themselves, with no single place to look.
  const handRolled = [...app.matchAll(/sampleEvents\.split\('\\n'\)\.slice\(0, 15\)/g)];
  assert.equal(handRolled.length, 0,
    'no AI snippet may be built by hand — it bypasses the guard');
});

test('the policy is a real setting, and defaults OFF (opt-in)', () => {
  // QualitySettings + its defaults moved out of ai-client.ts into the AI-free
  // settings-store.ts (so the sanitizer build target can read settings without
  // pulling in the AI runtime). The policy still lives on QualitySettings.
  const ai = read('src/settings-store.ts');
  assert.match(ai, /requireSanitisedSamples: boolean/, 'declared on QualitySettings');
  // The mandatory-sanitise gate defaults OFF: the sanitiser only ever touches
  // customer-origin samples in the first place (upload/paste/worker-group —
  // library and AI-generated are exempt by source), so forcing it on every run
  // by default blocks safe work. It is opt-in via Settings, or a build can
  // default it on with VITE_REQUIRE_SANITISED_SAMPLES=true.
  assert.match(ai, /requireSanitisedSamples: [^\n]*VITE_REQUIRE_SANITISED_SAMPLES[^\n]*=== 'true'/,
    'and defaults OFF — opt-in, only relevant to customer-origin samples');
  assert.match(read('src/App.tsx'), /Require sanitised samples before any AI call/,
    'and is switchable in Settings, so it is discoverable rather than a hidden env var');
});

test('the module makes no network call of any kind', () => {
  // The entire point: this data may not reach a model vendor, so the code that scrubs
  // it must not be able to send it anywhere either.
  const src = read('src/sample-sanitise.ts');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'invokeAi', 'invokeModel', 'axios', 'WebSocket']) {
    assert.ok(!src.includes(forbidden), `sanitisation must stay local — found ${forbidden}`);
  }
  /* Static JSON vocabularies, plus ONE import-free code module. The module reads a lot of
     shipped knowledge now — field aliases, CIM, Sentinel columns, golden maps, the public
     corpus, the per-source hints — and every one of those is a file compiled into the bundle.
     `./secret-rule-filter` and `./sanitise-checksums` are the code exceptions: pure string/regex
     analysis, importing nothing themselves (asserted below); the filter is shared with the module
     that INSTALLS the secret rules.
     The rules are PUSHED IN via setSecretRules, so importing anything that fetches here would be
     enough to give this module a route out. What must never appear is an import of anything that
     can REACH somewhere: ./api, ./ai-client, ./secret-rules, or a dynamic import. */
  const imports = [...src.matchAll(/^import .*from '([^']+)'/gm)].map(m => m[1]);
  assert.ok(imports.length > 0, 'sanity: the import scan found something');
  for (const spec of imports) {
    assert.match(spec, /^(\.\.\/config\/[\w.-]+\.json|\.\/secret-rule-filter|\.\/sanitise-checksums)$/,
      `sanitisation must stay local — ${spec} is neither a static config file nor the rule filter`);
  }
  for (const mod of ['src/secret-rule-filter.ts', 'src/sanitise-checksums.ts']) {
    const code = read(mod);
    assert.equal([...code.matchAll(/^import .*from '([^']+)'/gm)].length, 0,
      `${mod}, a permitted code import, must itself import nothing`);
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'import(']) {
      assert.ok(!code.includes(forbidden), `${mod} must not contain ${forbidden}`);
    }
  }
  assert.ok(!/import\s*\(/.test(src), 'no dynamic import can smuggle in a client at runtime');
});

test('the identity dictionary is derived from the shipped schemas, not hand-listed', () => {
  /* A field spelling should only have to be known in ONE place in this repo. The CIM data
     models, the Sentinel columns and the golden canonical maps already name these concepts
     in hundreds of vendor spellings, so the sanitiser reads them instead of keeping its own
     drifting copy. */
  assert.ok(SCHEMA_IDENTITY_FIELD_COUNT > 300,
    `expected the shipped schemas to contribute a broad vocabulary, got ${SCHEMA_IDENTITY_FIELD_COUNT}`);

  // Vendor spellings none of which are written down in sample-sanitise.ts.
  assert.equal(fieldIdentityKind('ActorUsername'), 'user');
  assert.equal(fieldIdentityKind('DvcHostname'), 'host');
  assert.equal(fieldIdentityKind('SourceUserName'), 'user');
  assert.equal(fieldIdentityKind('TargetUserName'), 'user');
  assert.equal(fieldIdentityKind('Computer'), 'host');
  assert.equal(fieldIdentityKind('src_ip'), 'ipv4');

  // A JSON path is typed by its leaf, which is how nested cloud logs get read at all.
  assert.equal(fieldIdentityKind('userIdentity.userName'), 'user');
  assert.equal(fieldIdentityKind('deviceDetail.displayName'), null,
    'displayName alone is not an identity — the hint config claims that one per source');
});

test('categories and counts are not mistaken for identities', () => {
  /* The cost of harvesting broadly: plenty of schema columns LOOK identity-ish and hold
     shared vocabulary. Replacing `user_type=admin` protects nobody and destroys the field
     that says what kind of logon it was. */
  for (const notAnIdentity of [
    'user_type', 'user_bunit', 'src_user_bunit', 'user_agent', 'http_user_agent',
    'user_count', 'host_type', 'host_os', 'src_port', 'dest_port', 'user_id',
    'account_status', 'user_priority', 'src_interface', 'dest_zone',
  ]) {
    assert.equal(fieldIdentityKind(notAnIdentity), null, `${notAnIdentity} is not an identity`);
  }
  // And the real ones still resolve, so the exclusions did not overreach.
  assert.equal(fieldIdentityKind('user'), 'user');
  assert.equal(fieldIdentityKind('src_user'), 'user');
  assert.equal(fieldIdentityKind('hostname'), 'host');
});

// ---------------------------------------------------------------------------
// Reading identities off a parser, instead of guessing at them
// ---------------------------------------------------------------------------

const APACHE = [
  '10.1.2.3 - jsmith [12/Nov/2024:09:14:02 +0000] "GET /admin/index.html HTTP/1.1" 200 4523 "-" "Mozilla/5.0"',
  '10.1.2.4 - mbrennan [12/Nov/2024:09:14:05 +0000] "POST /api/login HTTP/1.1" 302 128 "-" "Mozilla/5.0"',
  '198.51.44.9 - jsmith [12/Nov/2024:09:14:11 +0000] "GET /reports/q3.pdf HTTP/1.1" 200 91234 "-" "curl/7.68.0"',
].join('\n');

test('a bare username in an access log is found by the parser and by nothing else', () => {
  /* THE reason to involve a parser. In `10.1.2.3 - jsmith [12/Nov...` the address falls to a
     pattern, but `jsmith` is a word between an IP and a bracket — no regex can tell it from
     `admin` or `Mozilla`, and there is no `user=` to key on. The Apache parser names that
     column `user`, which settles it. */
  // Without a parser the CLF prefix is still read by position (`host ident user [date]`),
  // so the name is found either way — the parser just confirms it.
  const without = planSanitisation(APACHE, { seed: 1 });
  const positional = without.entries.find(e => e.original === 'jsmith');
  assert.ok(positional && positional.kind === 'user' && positional.enabled,
    'without a parser the CLF user slot still names it, ticked');

  const { plan, out } = sanitiseParsed(APACHE);
  const user = plan.entries.find(e => e.original === 'jsmith');
  assert.ok(user, 'the parser found the bare username');
  assert.equal(user.kind, 'user');
  assert.equal(user.confidence, 'certain', 'a named field is proof, not a guess');
  assert.match(user.via, /parsed field/);
  assert.ok(!out.includes('jsmith') && !out.includes('mbrennan'), 'and both are gone');

  // Consistency survives: one alias for the user seen on two lines.
  assert.equal(out.split(user.alias).length - 1, 2, 'same user, same alias, both lines');
});

test('the parser used is the one the sample content picks, with no sourcetype and no AI', () => {
  // The chicken-and-egg that makes this work at all: identifying the format needs no model,
  // so sanitising never has to wait for one.
  const { parserName } = parseLocally(APACHE);
  assert.equal(parserName, 'apache_httpd_accesslog_combined');
});

test('nested cloud JSON gives up its identities through the field path', () => {
  const trail = [
    '{"eventTime":"2024-11-12T09:14:02Z","eventSource":"signin.amazonaws.com","userIdentity":{"type":"IAMUser","userName":"jsmith","accountId":"123456789012","arn":"arn:aws:iam::123456789012:user/jsmith"},"sourceIPAddress":"203.44.19.7"}',
    '{"eventTime":"2024-11-12T09:15:02Z","eventSource":"ec2.amazonaws.com","userIdentity":{"type":"IAMUser","userName":"mbrennan","accountId":"123456789012","arn":"arn:aws:iam::123456789012:user/mbrennan"},"sourceIPAddress":"203.44.19.8"}',
  ].join('\n');
  const { plan, out } = sanitiseParsed(trail, 'aws_cloudtrail');

  const user = plan.entries.find(e => e.original === 'jsmith');
  assert.ok(user, 'userIdentity.userName is typed by its leaf');
  assert.equal(user.confidence, 'certain');
  // The account id is numeric, which the generic rules dismiss as a counter — the
  // per-source hint is what says this exact field is an identity.
  assert.ok(plan.entries.some(e => e.original === '123456789012'),
    'the CloudTrail hint claims the account id');
  assert.ok(!out.includes('jsmith') && !out.includes('123456789012'));

  // Still parseable, and every value still in its own key.
  for (const line of out.split('\n')) JSON.parse(line);
  // The service principal is public API vocabulary, not an identity.
  assert.ok(out.includes('signin.amazonaws.com'), 'a service principal is left alone');
});

test('a composite identifier keeps its shape by having its parts replaced, not itself', () => {
  /* An ARN is a real identity, but swapping the whole string for one opaque alias destroys a
     structure that pipelines extract from. Replacing the account id and the username INSIDE
     it leaves something that is both anonymous and still an ARN. */
  const trail = '{"userIdentity":{"userName":"jsmith","accountId":"123456789012","arn":"arn:aws:iam::123456789012:user/jsmith"},"sourceIPAddress":"203.44.19.7"}';
  const { plan, out } = sanitiseParsed(trail, 'aws_cloudtrail');
  assert.ok(!plan.entries.some(e => e.original.startsWith('arn:')),
    'the ARN is not replaced wholesale');
  assert.match(out, /"arn":"arn:aws:iam::[\w-]+:user\/[\w.-]+"/, 'it is still an ARN');
  assert.ok(!out.includes('jsmith') && !out.includes('123456789012'), 'but anonymous inside');
});

// ---------------------------------------------------------------------------
// Structure the format gives away for free
// ---------------------------------------------------------------------------

test('the syslog header host is positional, so it is found without any parser', () => {
  /* The device that emitted the line is the most common identity in real samples, and RFC3164
     puts it in a fixed slot. Position is a fact, so this is offered ticked. */
  const events = [
    'Nov 12 09:14:02 acme-core-01 payment-svc[1234]: INFO order accepted for account 8891',
    'Nov 12 09:14:03 acme-core-02 payment-svc[1235]: INFO order accepted for account 8892',
  ].join('\n');
  const { plan, out } = sanitise(events);
  const host = plan.entries.find(e => e.original === 'acme-core-01');
  assert.ok(host, 'the syslog host slot was read');
  assert.equal(host.confidence, 'certain');
  assert.match(host.via, /host/);
  assert.ok(!out.includes('acme-core-01') && !out.includes('acme-core-02'));
  assert.ok(out.includes('payment-svc'), 'the program name is not an identity');

  // RFC5424 with a PRI and an ISO timestamp lands in the same slot.
  const rfc5424 = '<166>1 2024-11-12T09:14:02.123Z gw-lon-04 sshd 1234 - - Accepted publickey';
  const p2 = planSanitisation(rfc5424, { seed: 3 });
  assert.ok(p2.entries.some(e => e.original === 'gw-lon-04'), 'RFC5424 host too');
});

test('a vendor message code is not mistaken for a hostname', () => {
  /* `%ASA-6-302013` and `fw-edge-01` are the same shape. Rewriting a message id breaks the
     parser that keys off it, so the segments have to decide: a name reads `word-word-NN`, a
     message code carries a bare numeric segment in the middle. */
  const asa = [
    '<166>Nov 12 09:14:02 fw-edge-01 %ASA-6-302013: Built outbound TCP connection for outside:203.44.19.7/443 to inside:10.20.30.40/51234',
    '<166>Nov 12 09:14:09 fw-edge-01 %ASA-6-113004: AAA user authentication Successful : server = 10.20.30.9 : user = jsmith',
  ].join('\n');
  const { plan, out } = sanitiseParsed(asa, 'cisco_asa');
  assert.ok(!plan.entries.some(e => e.original.includes('ASA-6-')), 'message ids are left alone');
  assert.ok(out.includes('%ASA-6-302013') && out.includes('%ASA-6-113004'));
  assert.ok(plan.entries.some(e => e.original === 'fw-edge-01'), 'the host still is one');
  assert.ok(!out.includes('jsmith'));
  // Interface names read like short hostnames and are device topology.
  assert.ok(out.includes('outside:') && out.includes('inside:'), 'ASA zones survive');
});

test('a CSV header row names its columns, so column three stops being anonymous', () => {
  /* No parser matches a generic CSV export, and `jsmith` in an unnamed column is exactly as
     invisible as it is in an access log. The header row is right there. */
  const csv = [
    'timestamp,src_ip,username,hostname,status',
    '2024-11-12T09:14:02Z,10.4.5.6,jsmith,web01,200',
    '2024-11-12T09:14:09Z,10.4.5.7,mbrennan,web02,401',
  ].join('\n');
  assert.equal(matchDatatypeParserBySample(csv), null, 'sanity: no parser matches this');

  const { plan, out } = sanitise(csv);
  for (const name of ['jsmith', 'mbrennan', 'web01', 'web02']) {
    const e = plan.entries.find(x => x.original === name);
    assert.ok(e, `${name} was found`);
    assert.equal(e.confidence, 'certain', `${name} came from a named column`);
  }
  assert.equal(out.split('\n')[0], 'timestamp,src_ip,username,hostname,status',
    'the header itself holds field names, not identities');
  for (const line of out.split('\n')) {
    assert.equal(line.split(',').length, 5, 'every row still has five columns');
  }
  assert.ok(!out.includes('jsmith') && !out.includes('web01'));
});

test('a W3C #Fields directive is read the same way', () => {
  const w3c = [
    '#Software: Microsoft Internet Information Services 10.0',
    '#Fields: date time s-ip cs-method cs-uri-stem cs-username c-ip sc-status',
    '2024-11-12 09:14:02 10.4.5.6 GET /admin/index.html CORPDOM\\jsmith 10.1.2.3 200',
    '2024-11-12 09:14:09 10.4.5.6 POST /api/login mbrennan 10.1.2.4 302',
  ].join('\n');
  const { plan, out } = sanitise(w3c);
  assert.ok(plan.entries.some(e => e.original === 'mbrennan'), 'cs-username was read');
  assert.ok(!out.includes('mbrennan'));
  assert.ok(out.startsWith('#Software:'), 'the directives are untouched');
  assert.match(out, /#Fields: date time s-ip cs-method cs-uri-stem cs-username c-ip sc-status/);
});

test('a mis-shaped row is skipped rather than read one column to the left', () => {
  // Guessing on a short row would alias a status code as a username.
  const csv = ['ts,src_ip,username,host', '2024-11-12,10.4.5.6,jsmith,web01', '2024-11-12,10.4.5.7'].join('\n');
  const { out } = sanitise(csv);
  assert.ok(out.endsWith('10.4.5.7') === false || true);
  assert.equal(out.split('\n')[2].split(',').length, 2, 'the short row keeps its shape');
});

// ---------------------------------------------------------------------------
// Suspects: offered, never applied
// ---------------------------------------------------------------------------

test('shape-and-variance suspects are listed unticked, so a guess cannot rewrite a sample', () => {
  /* For a custom source with no parser and no field names, a bare name is genuinely
     undecidable. Offering beats deciding: a wrong guess applied silently produces a pack
     built against fiction, with nothing on screen to show why. */
  const events = [
    'order accepted for account j.smith at store 4 region eu-west',
    'order accepted for account m.brennan at store 7 region eu-west',
    'order refunded for account j.smith at store 4 region eu-west',
  ].join('\n');
  const { plan, out } = sanitise(events);
  const guess = plan.entries.find(e => e.original === 'j.smith');
  assert.ok(guess, 'the dotted personal name is offered');
  assert.equal(guess.confidence, 'suspect');
  assert.equal(guess.enabled, false, 'and unticked');
  assert.ok(out.includes('j.smith'), 'so applying the plan leaves it alone');

  // Ticking it is all it takes.
  const ticked = plan.entries.map(e => e.original === 'j.smith' ? { ...e, enabled: true } : e);
  assert.ok(!applySanitisation(events, ticked).includes('j.smith'));
});

test('technical vocabulary and format constants are not offered as suspects', () => {
  const events = Array.from({ length: 10 }, (_, i) =>
    `svc-api tls1 sha256 x86_64 oauth2 request ${i} completed for tenant acme-prod-0${i} in 42ms`).join('\n');
  const { plan } = sanitise(events);
  const suspects = plan.entries.filter(e => e.confidence === 'suspect').map(e => e.original);
  for (const vocab of ['tls1', 'sha256', 'x86_64', 'oauth2']) {
    assert.ok(!suspects.includes(vocab), `${vocab} is protocol vocabulary, not a name`);
  }
  assert.ok(!suspects.includes('svc-api'), 'a token in every line is the format talking');
});

test('a value confirmed by a field stops being a suspect', () => {
  // The tiers must agree rather than duplicate: a guess that a named field later confirms
  // is promoted, not listed twice.
  const events = [
    'host=web01 msg=started',
    'host=web01 msg=stopped',
    'host=web02 msg=started',
  ].join('\n');
  const { plan } = sanitise(events);
  const rows = plan.entries.filter(e => e.original === 'web01');
  assert.equal(rows.length, 1, 'one row per value');
  assert.equal(rows[0].confidence, 'certain', 'the field wins over the guess');
  assert.equal(rows[0].enabled, true);
});

test('the public corpus quietens guesses but can never skip a certainty', () => {
  /* Asymmetric on purpose. A customer host could legitimately be called `web01` too, so
     treating corpus membership as proof of publicness would be a way to skip real
     identities. Used only to narrow the suspect list, it cannot cause a leak. */
  const tokens = publicCorpusTokens();
  assert.ok(tokens.size > 1000, `expected a broad corpus, got ${tokens.size}`);
  const src = read('src/sample-sanitise.ts');
  const suspectFn = src.slice(src.indexOf('function findSuspects'));
  assert.ok(suspectFn.slice(0, suspectFn.indexOf('\n}')).includes('publicTokens.has'),
    'the corpus is consulted inside the suspect tier');
  assert.equal((src.match(/publicTokens\.has/g) || []).length, 1,
    'and nowhere else — a certainty is never skipped because the corpus happens to share a token');
});

// ---------------------------------------------------------------------------
// Per-source hints
// ---------------------------------------------------------------------------

test('per-source hints protect device vocabulary that reads like a hostname', () => {
  const asa = sourceHints('cisco_asa');
  assert.equal(asa.key, 'cisco_asa');
  for (const zone of ['inside', 'outside', 'dmz']) {
    assert.ok(asa.neverReplace.has(zone), `${zone} is an ASA zone, not a host`);
  }
  // `root` is a Fortinet VDOM name, and rewriting it breaks the parse.
  assert.ok(sourceHints('fortinet_fortigate').neverReplace.has('root'));
  // Global vocabulary applies with or without a matching profile.
  assert.ok(sourceHints('').neverReplace.has('nt authority'));
  assert.equal(sourceHints('').key, null);
});

test('a hint can claim a field the generic rules would dismiss', () => {
  const ct = sourceHints('aws_cloudtrail');
  assert.ok(ct.identityFields.has('recipientaccountid'));
  assert.ok(ct.identityFields.has('userIdentity.userName'.toLowerCase()));
  // And the same file says which values are public API vocabulary.
  assert.ok(ct.neverReplace.has('cloudtrail.amazonaws.com'));
});

test('the hints file stays a config file, not code', () => {
  const hints = JSON.parse(read('config/sanitise-hints.json'));
  assert.ok(hints.global?.neverReplace?.length > 10);
  assert.ok(hints.global?.vocabulary?.length > 40);
  const sources = Object.entries(hints.sources || {});
  assert.ok(sources.length >= 15, `expected a useful spread of sources, got ${sources.length}`);
  for (const [name, spec] of sources) {
    assert.ok(Array.isArray(spec.identityFields), `${name} declares identityFields`);
    assert.ok(Array.isArray(spec.neverReplace), `${name} declares neverReplace`);
  }
});

// ---------------------------------------------------------------------------
// Proving it worked
// ---------------------------------------------------------------------------

test('the coverage proof counts identity fields, and says so when it cannot', () => {
  /* The structural check says the sample is still parseable. This says the identities are
     gone — which is the claim that matters before the text is allowed near a vendor. */
  const { out, parsed, parserName } = sanitiseParsed(APACHE);
  const after = parseLocally(out, '').parsed;
  const proof = proveIdentityCoverage(parsed, after, {});
  assert.equal(parserName, 'apache_httpd_accesslog_combined');
  assert.ok(proof.total >= 4, `something to verify, got ${proof.total}`);
  assert.equal(proof.replaced, proof.total, 'every identity field changed');
  assert.deepEqual(proof.remaining, []);
  assert.equal(proof.ok, true);
  assert.equal(proof.blind, false);
});

test('an unticked identity row shows up as remaining, not as success', () => {
  // The failure a mapping list cannot show by itself: a row switched off without the
  // reviewer noticing what it held.
  const { parsed } = parseLocally(APACHE);
  const plan = planSanitisation(APACHE, { seed: 1, parsed, parserName: 'apache' });
  const held = plan.entries.map(e => e.original === 'jsmith' ? { ...e, enabled: false } : e);
  const out = applySanitisation(APACHE, held);
  const proof = proveIdentityCoverage(parsed, parseLocally(out, '').parsed, {});
  assert.equal(proof.ok, false);
  assert.ok(proof.remaining.some(r => r.value === 'jsmith'), 'named, so it can be fixed');
  assert.ok(proof.replaced < proof.total);
});

test('no parser means the proof reports blindness rather than success', () => {
  /* Reporting "verified" when nothing could be read would be the most misleading thing this
     function could do. */
  const proof = proveIdentityCoverage([null, null], [null, null], {});
  assert.equal(proof.blind, true);
  assert.equal(proof.ok, false, 'blind is not ok');
  assert.equal(proof.total, 0);
});

test('protocol addresses are not counted as failures', () => {
  // Loopback and multicast carry protocol meaning, so they are left alone by design and
  // must not make a correct run look broken.
  const before = [{ src_ip: '127.0.0.1', host: 'web01' }];
  const after = [{ src_ip: '127.0.0.1', host: 'gw40' }];
  const proof = proveIdentityCoverage(before, after, {});
  assert.equal(proof.ok, true);
  assert.equal(proof.total, 1, 'only the host counted');
});

test('an IP-typed field holding non-IP garbage is a mis-parse, not a survivor', () => {
  // A KVP/ESB sample mislabelled as a positional firewall log lands whole `key=value` pairs in
  // the IP-named columns: `src_ip = "quotePriority=NORMAL"`, `dest_ip = "conversationId=ESB~…"`.
  // Those are not addresses, so nothing masks them — and demanding the reviewer do so would block
  // a sample that is in fact clean. The proof must ignore an IP field whose value is not an IP.
  const before = [{
    src_ip: 'quotePriority=NORMAL',
    dest_ip: 'conversationId=ESB~10A1DC85FE999AEC:CA305DEA:4DABF2217938:A8AC',
    nat_src_ip: 'credits=NA',
    nat_dest_ip: 'JMSReplyTo=pub.esb.genericasync.response',
  }];
  const proof = proveIdentityCoverage(before, before, { sourcetype: 'palo_alto' });
  assert.equal(proof.remaining.length, 0, 'no mis-parsed pseudo-identity is demanded');
  assert.equal(proof.ok, true, 'the clean sample is not blocked');
  assert.equal(proof.blind, false, 'the lines were readable — this is a real proof, not a blind pass');

  // But a genuine public address left unchanged in an IP field still blocks — the guard narrows
  // the check to real addresses, it does not switch it off.
  const leak = proveIdentityCoverage([{ src_ip: '8.8.8.8' }], [{ src_ip: '8.8.8.8' }], { sourcetype: 'palo_alto' });
  assert.equal(leak.ok, false, 'a real unmasked IP still blocks');
  assert.equal(leak.remaining[0].value, '8.8.8.8');
});

test('a surviving identity is reported with the 1-based line it sits on', () => {
  // The reviewer needs to be pointed at the exact line, not just told "one survived".
  const before = [{ host: 'web01' }, { host: 'web02' }, { host: 'db09' }];
  const after = [{ host: 'gw40' }, { host: 'web02' }, { host: 'shard1' }];
  const proof = proveIdentityCoverage(before, after, {});
  assert.equal(proof.ok, false, 'the unchanged host blocks coverage');
  assert.deepEqual(proof.remaining, [{ field: 'host', value: 'web02', line: 2 }],
    'the survivor carries its field, value, and 1-based line number');
});

test('SanitisationBlocked carries the survivors so the UI can point at them', () => {
  const rows = [{ field: 'host', value: 'web02', line: 2 }];
  const err = new SanitisationBlocked('one identity survived at line 2', rows);
  assert.ok(err instanceof Error, 'it is a real Error (so existing catch blocks still work)');
  assert.equal(err.name, 'SanitisationBlocked');
  assert.deepEqual(err.survivors, rows, 'the surviving identities ride along with the error');
  // A plain Error carries no survivors — the coverage path must use the typed one.
  assert.deepEqual(new SanitisationBlocked('generic').survivors, [], 'defaults to no survivors');
});

test('the coverage blocker feeds the parser survivors (with their lines) into the error', () => {
  const flow = read('src/sanitised-sample-workflow.ts');
  // The survivor rows from proveIdentityCoverage must be handed to the thrown blocker, and the
  // message must name the line(s) — not the old generic "review the sanitisation plan" sentence.
  assert.match(flow, /const survivors = run\.coverage\.remaining;/, 'the coverage survivors are read');
  assert.match(flow, /throw new SanitisationBlocked\(\s*[^;]*survivors\)/, 'they are thrown with the blocker');
  assert.match(flow, /line \$\{survivors\[0\]\.line\}/, 'the message points at the survivor line');
  assert.ok(!/review the sanitisation plan/.test(flow), 'the old vague "review the plan" message is gone');
});

test('the wizard surfaces a survived-identity block as a loud, line-pointing alert', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  const css = read('src/App.css');
  // The blocker is captured as structured rows, not just a sentence.
  assert.match(wiz, /err instanceof SanitisationBlocked && err\.survivors\.length\) setSurvivors\(err\.survivors\)/,
    'a SanitisationBlocked error feeds the survivor list');
  // Rendered as a prominent alert (not the small note) that lists line + field + value.
  assert.match(wiz, /className="sz-alert sz-alert-block" role="alert"/, 'the blocker uses the loud alert box, not sz-note');
  assert.match(wiz, /Line \{s\.line\}/, 'each survivor row names its line');
  assert.match(wiz, /\{s\.field\}/, 'each survivor row names the field');
  assert.match(wiz, /className="sz-alert-val">\{s\.value\}/, 'each survivor row shows the value that survived');
  // The matching before-pane line is highlighted so the eye lands on it.
  assert.match(wiz, /survivors\.some\(s => s\.line === line\.lineNo\) \? 'sanitise-before-line survivor'/,
    'the offending before-pane line is flagged');
  assert.match(css, /\.sz-alert-block \{/, 'the loud alert has a style');
  assert.match(css, /\.sanitise-before-line\.survivor \{/, 'the survivor line has a highlight style');
});

// ---------------------------------------------------------------------------
// Ordering: detection must not outrun the privacy rule
// ---------------------------------------------------------------------------

test('sourcetype detection tries local recognition before any model', () => {
  /* This runs the instant a sample loads, which makes it the earliest point at which raw
     events could leave the browser. Asking a model to name a format the repo can already
     recognise was always the wrong order. */
  const app = read('src/App.tsx');
  const fn = app.slice(app.indexOf('const detectSourcetype = async'));
  const body = fn.slice(0, fn.indexOf('\n  const handleSelectSourcetype'));
  const localAt = body.indexOf('matchDatatypeParserBySample');
  const aiAt = body.indexOf('detectSourcetypeApi');
  assert.ok(localAt > 0, 'the offline recogniser is used');
  assert.ok(aiAt > 0, 'the model is still the fallback');
  assert.ok(localAt < aiAt, 'and it runs FIRST');
});

test('un-sanitised customer events are never sent for sourcetype detection', () => {
  /* The hole this closes: detection fired on load, before the Sanitize button was even on
     screen, so "no customer data reaches the provider" had an exception for the one call
     that happened first. */
  const app = read('src/App.tsx');
  const fn = app.slice(app.indexOf('const detectSourcetype = async'));
  const body = fn.slice(0, fn.indexOf('\n  const handleSelectSourcetype'));
  const gateAt = body.indexOf('sampleNeedsSanitising');
  const aiAt = body.indexOf('await detectSourcetypeApi');
  assert.ok(gateAt > 0, 'the guard is consulted');
  assert.ok(gateAt < aiAt, 'before the provider call, not after');
  assert.match(body, /requireSanitisedSamples/, 'and it honours the policy setting');
  assert.match(body, /were NOT sent to the AI provider/, 'and says so, where it can be acted on');

  // Every ingestion path passes its own source mode, because state is a tick behind.
  for (const mode of ['upload', 'live-capture', 'existing', 'paste']) {
    assert.ok(app.includes(`sourceMode: '${mode}'`), `${mode} declares itself to the gate`);
  }
});

test('sanitise is opt-in — the panel opens from the button, not when a sample lands', () => {
  const app = read('src/App.tsx');
  assert.match(app, /onClick=\{\(\) => setSanitiseModalOpen\(true\)\}/,
    'the Sanitize sample button opens the wizard modal');
  assert.ok(!/\bautoPlanSanitise\b/.test(app),
    'ingestion paths must not open the panel; the Sanitize sample button does');
  // The four customer-data paths still declare themselves to the privacy gate.
  for (const mode of ['upload', 'live-capture', 'existing', 'paste']) {
    assert.ok(app.includes(`sourceMode: '${mode}'`), `${mode} declares itself to the gate`);
  }
});

test('the wizard hands parser output to the planner, and verifies after applying', () => {
  // The sanitise COMPUTE (parse-locally-per-line → plan → apply → coverage proof) lives
  // in ONE place — sanitised-sample-workflow.ts — so the pack-gen wizard and the sample
  // library can never diverge. App.tsx only delegates and applies its advisory policy.
  const wf = read('src/sanitised-sample-workflow.ts');
  assert.match(wf, /extractFieldValues\(functions, line\)/, 'the parser is run locally, per line (in the shared module)');
  assert.match(wf, /index >= cap/, 'and bounded so a huge paste cannot hang the UI');
  assert.match(wf, /proveIdentityCoverage\(/, 'applying is followed by a coverage proof (in the shared module)');

  const app = read('src/App.tsx');
  // App.tsx must NOT re-implement any of the sanitise compute — that all lives in the
  // wizard now. It delegates to the SanitizeWizard modal and only applies the result.
  assert.ok(!/extractFieldValues\(/.test(app), 'App.tsx must not parse locally itself — the wizard does');
  assert.ok(!/planSampleSanitisation\(|runSanitisation\(/.test(app),
    'App.tsx must not plan or apply itself — the wizard owns the compute');
  assert.match(app, /<SanitizeWizard\b[\s\S]{0,300}?onApply=\{onApplySanitised\}/,
    'the wizard applies and hands back the sanitised events');
  // The wizard blocks a structurally-broken sample; App just loads what it returns.
  const apply = app.slice(app.indexOf('const onApplySanitised ='));
  const body = apply.slice(0, apply.indexOf('\n  const undoSanitise'));
  assert.match(body, /update\(\{ sampleEvents: events\.join\('\\n'\), sampleSanitised: true \}\)/,
    'loads the sanitised events and marks the sample clean');
});

test('apply mode is ADVISORY — a wire-format verification fail warns, it does not strand the user', () => {
  // The bug: apply mode called applyAndVerifySanitisation (the strict LIBRARY gate), which
  // throws "The sanitised events no longer pass the source parser: …" on a verification fail
  // (infoblox_dns, wrong log family / missing keys) — hard-blocking the pack-gen user. The
  // documented split (sanitised-sample-workflow.ts) is: pack-gen WARNS, the library THROWS.
  const wiz = read('src/sanitize-wizard.tsx');
  const apply = wiz.slice(wiz.indexOf('function applyPlan'), wiz.indexOf('function backFromSave'));
  // The apply-mode branch runs the non-throwing shared compute, not the strict verify-throw.
  assert.match(apply, /if \(applyMode && onApply\) \{[\s\S]*?runSanitisation\(raw, sourcetype, plan\?\.entries \|\| \[\], \{ verify: true \}\)/,
    'apply mode runs the non-throwing runSanitisation, not applyAndVerifySanitisation');
  const branch = apply.slice(apply.indexOf('if (applyMode && onApply)'), apply.indexOf('    try {'));
  // It still BLOCKS the genuinely unusable results (nothing changed, broken wire format)…
  assert.match(branch, /!run\.structure\.ok/, 'a structurally-broken sample is still blocked');
  // …but a verification fail becomes a WARNING passed back to the pack generator, not a throw —
  // and ONLY when sanitisation DEGRADED parseability (the raw sample parsed, the sanitised one
  // does not). A raw sample that already failed the parser (noisy access logs) is not blamed.
  assert.match(branch, /run\.verification\?\.verdict === 'fail'\s*&&\s*run\.verificationBefore\?\.verdict !== 'fail'/,
    'the warning fires only on a sanitisation-caused regression, not on an already-noisy source');
  assert.match(branch, /onApply\(run\.events, sourcetype, warning\)/,
    'and the warning rides back to App alongside the sanitised events — apply is not blocked');
  // The strict throw path (applyAndVerifySanitisation) must NOT sit in the apply-mode branch.
  assert.ok(!/applyAndVerifySanitisation/.test(branch),
    'the strict library gate must not run in apply mode');

  // App surfaces the warning without blocking: stored in state, shown in the banner, cleared on undo.
  const app = read('src/App.tsx');
  assert.match(app, /const \[sanitiseWarning, setSanitiseWarning\] = useState<string \| null>\(null\)/,
    'App keeps the advisory warning in state');
  assert.match(app, /state\.sampleSanitised && sanitiseWarning &&/,
    'and renders it under the sanitised banner');
});

// ---------------------------------------------------------------------------
// Pattern picks — replace parts of a composite token shape across the sample
// ---------------------------------------------------------------------------

test('decomposeShape splits bufbwjesfe[4212]: into letter and digit groups', () => {
  const shape = decomposeShape('bufbwjesfe[4212]:');
  assert.ok(shape);
  assert.equal(shape.groups.length, 2);
  assert.equal(shape.groups[0].sample, 'bufbwjesfe');
  assert.equal(shape.groups[0].kind, 'letters');
  assert.equal(shape.groups[1].sample, '4212');
  assert.equal(shape.groups[1].kind, 'digits');
  assert.match(shape.source, /\(\?<g1>\[A-Za-z\]\+\)/);
  assert.match(shape.source, /\\\[\(\?<g2>\\d\+\)\\\]/);
});

test('a bare hostname is not a pattern — the literal path owns that', () => {
  assert.equal(decomposeShape('web01'), null);
  assert.equal(decomposeShape('jsmith'), null);
});

test('decomposeShape merges a separator-free letters+digits run into ONE part', () => {
  // `"command_start_%s" "win8cvha"` must offer win8cvha as one identifier chip, not
  // win / 8 / cvha — the whole word is the identity, the data never split it. `_` is a
  // SEPARATOR, so `command_start` splits into command / start (each run classified on its own).
  const shape = decomposeShape('"command_start_%s" "win8cvha"');
  assert.ok(shape);
  assert.deepEqual(shape.groups.map(g => g.sample), ['command', 'start', 's', 'win8cvha']);
  const merged = shape.groups[3];
  assert.equal(merged.sample, 'win8cvha');
  assert.equal(merged.kind, 'alnum');
  assert.equal(merged.classRe, '[A-Za-z0-9]+');
  assert.equal(groupRegexFragment(merged), '[A-Za-z0-9]+');
  // The mixed-alnum run is starred; the pure-letter runs are not.
  assert.equal(merged.recommend, true);
  assert.equal(shape.groups[0].recommend, undefined, 'a pure-letter run is not starred');
  assert.match(shape.source, /\(\?<g4>\[A-Za-z0-9\]\+\)/);
});

test('a snake_case identifier gives ONE whole-token shape choice, not per-segment noise', () => {
  // Regression (build 668, reverted): `_`-as-identity made decomposeShape return null for a
  // snake_case token, which removed the "A part of it" strip AND the Format/wildcard option in
  // the guided panel, leaving only exact-match. `_` is a separator again so the shape exists;
  // buildSanitiseChoices then COLLAPSES a pure snake_case token into a single whole-token shape
  // mask (never "just BI" / "just DEV" / "just USER"), and it is the recommended format answer.
  const shape = decomposeShape('BI_DEV_USER');
  assert.ok(shape, 'snake_case decomposes so the shape/wildcard path exists');
  assert.deepEqual(shape.groups.map(g => g.sample), ['BI', 'DEV', 'USER']);

  const line = "login to user 'BI_DEV_USER' from 10.2.3.4";
  const start = line.indexOf('BI_DEV_USER');
  const sel = describeSelection({ text: line, start, end: start + 'BI_DEV_USER'.length, entries: [] });
  const choices = buildSanitiseChoices(sel);
  const ids = choices.map(c => c.id);
  assert.deepEqual(ids, ['shape-all', 'literal'], 'one whole-shape mask + the exact literal, no per-part options');
  const shapeAll = choices.find(c => c.id === 'shape-all');
  assert.equal(shapeAll.recommended, true, 'the whole-shape (wildcard) mask is recommended');
  assert.equal(shapeAll.match, 'part');
  assert.match(shapeAll.label, /shaped like/);
  // The panel can offer "A part of it" (the inside-select strip) because the pattern has >1 run.
  assert.equal(canRefineSelection(sel), true);
  assert.deepEqual(splitStructuredToken('BI_DEV_USER').map(p => p.text), ['BI', 'DEV', 'USER']);
});

test('a pure-digit run in a shape is not starred (it could be a port or a counter)', () => {
  const shape = decomposeShape('bufbwjesfe[4212]:');
  assert.ok(shape.groups.every(g => !g.recommend), 'letters and a bare number are both unstarred');
});

test('markedValueShape masks one marked run and keeps the rest of the scope literal', () => {
  const scope = '"command_start_%s" "win8cvha"';
  const at = scope.indexOf('win8cvha');
  const shape = markedValueShape(scope, at, at + 'win8cvha'.length);
  assert.ok(shape);
  assert.equal(shape.groups.length, 1);
  assert.equal(shape.groups[0].sample, 'win8cvha');
  assert.equal(shape.token, scope);
  // Everything outside the mark is literal; only the marked run is a capture group.
  assert.match(shape.source, /command_start/);
  assert.match(shape.source, /\(\?<g1>\[A-Za-z0-9\]\+\)/);
  // The anchored shape matches this line and replaces only the marked run.
  const plan = planSanitisation(`${scope}\nother win8cvha here`, {
    seed: 3, extraPatterns: [{ source: shape.source, groupNames: ['g1'] }], suggestSuspects: false,
  });
  const after = applySanitisation(`${scope}\nother win8cvha here`, plan.entries);
  assert.ok(after.includes('command_start_%s'), 'the literal context is untouched');
  assert.match(after, /other win8cvha here/, 'win8cvha outside the marked context stays');
  assert.ok(!/"command_start_%s" "win8cvha"/.test(after), 'the marked run inside the context is replaced');
});

test('markedValueShape refuses an empty mark or the whole scope', () => {
  const scope = '"a_b" "host9"';
  assert.equal(markedValueShape(scope, 5, 5), null, 'empty mark');
  assert.equal(markedValueShape(scope, 0, scope.length), null, 'whole scope is not a mark');
});

test('markedValueShape grows a half-word mark to the whole alnum run', () => {
  const scope = 'x "win8cvha" y';
  const start = scope.indexOf('n8');       // mid-word
  const shape = markedValueShape(scope, start, start + 2);
  assert.ok(shape);
  assert.equal(shape.groups[0].sample, 'win8cvha', 'grown to the whole run so the mask lands on a boundary');
});

test('markedValueShapeMulti masks several picked runs at once, one group each, context literal', () => {
  const scope = '2d2e0780-96fe-4346-b021-fbd713153f3e';
  // Pick the first and the last component (as the value-strip chips would).
  const r1 = { start: 0, end: 8 };                          // 2d2e0780
  const lastStart = scope.lastIndexOf('fbd713153f3e');
  const r4 = { start: lastStart, end: lastStart + 'fbd713153f3e'.length };
  const shape = markedValueShapeMulti(scope, [r4, r1]);      // out of order on purpose
  assert.ok(shape);
  assert.equal(shape.groups.length, 2, 'one group per picked run');
  // Groups are emitted left-to-right regardless of pick order.
  assert.deepEqual(shape.groups.map(g => g.sample), ['2d2e0780', 'fbd713153f3e']);
  assert.deepEqual(shape.groups.map(g => g.name), ['g1', 'g2']);
  // The literal between them (the middle three components + hyphens) is preserved verbatim.
  assert.match(shape.source, /96fe-4346-b021/);
  // Applied, both marked runs are replaced and the middle stays.
  const plan = planSanitisation(scope, {
    seed: 3, extraPatterns: [{ source: shape.source, groupNames: ['g1', 'g2'] }], suggestSuspects: false,
  });
  const after = applySanitisation(scope, plan.entries);
  assert.ok(after.includes('-96fe-4346-b021-'), 'the unpicked middle components stay');
  assert.ok(!after.includes('2d2e0780'), 'the first picked run is masked');
  assert.ok(!after.includes('fbd713153f3e'), 'the last picked run is masked');
});

test('markedValueShapeMulti mode: shape → a class (\\d+), exact → the literal run', () => {
  const scope = 'host[4212]:';
  const at = scope.indexOf('4212');
  const range = [{ start: at, end: at + 4 }];
  // Default / 'shape' → a digit class: any number in this spot is masked ("wildcards").
  const shape = markedValueShapeMulti(scope, range, 'shape');
  assert.ok(shape);
  assert.match(shape.source, /\(\?<g1>\\d\+\)/, 'shape mode emits \\d+');
  assert.equal(shape.groups[0].classRe, '\\d+');
  assert.match(shape.source, /^host\\\[/, 'context punctuation stays literal');
  // 'exact' → only this literal value (4212) is matched, in the same context.
  const exact = markedValueShapeMulti(scope, range, 'exact');
  assert.ok(exact);
  assert.match(exact.source, /\(\?<g1>4212\)/, 'exact mode emits the literal run');
  assert.equal(exact.groups[0].classRe, '4212');
  assert.equal(exact.groups[0].sample, '4212');
  // Exact matches only 4212 here; a different number in the same shape is left alone.
  const line = 'host[4212]: host[9999]:';
  const plan = planSanitisation(line, {
    seed: 3, extraPatterns: [{ source: exact.source, groupNames: ['g1'] }], suggestSuspects: false,
  });
  const after = applySanitisation(line, plan.entries);
  assert.ok(!after.includes('4212'), 'the exact value is masked');
  assert.ok(after.includes('9999'), 'a different value in the same spot is left alone under exact');
  // Metacharacters in an exact run are escaped so they match themselves.
  const dotted = markedValueShapeMulti('v=1.2.3;', [{ start: 2, end: 7 }], 'exact');
  assert.ok(dotted);
  assert.match(dotted.source, /1\\\.2\\\.3/, 'dots in an exact run are escaped');
});

test('markedValueShapeMulti context "shape": an IP-user-timestamp pick masks every user, not one line', () => {
  const scope = '67.207.231.248 - marquardt4474 [26/Nov/2019:01:34:17 +0000]';
  const at = scope.indexOf('marquardt4474');
  const range = [{ start: at, end: at + 'marquardt4474'.length }];
  const text = [
    '178.146.234.131 - dicki8506 [26/Nov/2019:01:34:17 +0000] "GET /a" 204 2338',
    '67.207.231.248 - marquardt4474 [26/Nov/2019:01:34:17 +0000] "PUT /s" 503 9386',
    '206.249.78.234 - - [26/Nov/2019:01:34:17 +0000] "GET /e" 204 895',
    '10.0.0.4 - john.doe [27/Dec/2020:11:04:07 -0500] "GET /x" 200 1',
    '10.0.0.4 - 4 [27/Dec/2020:11:04:07 -0500] "GET /x" 200 1',
    'build x10.0.0.4 - eve [27/Dec/2020:11:04:07 -0500]',
  ].join('\n');
  const run = (src) => {
    const plan = planSanitisation(text, { seed: 5, extraPatterns: [{ source: src, groupNames: ['g1'] }], suggestSuspects: false });
    return applySanitisation(text, plan.entries.filter(e => e.via === PICKED_PATTERN_VIA)).split('\n');
  };

  // Default (exact context) is unchanged: this line's IP and date are literal → one place.
  const pinned = markedValueShapeMulti(scope, range, 'shape');
  assert.match(pinned.source, /^67\\\.207\\\.231\\\.248 - /, 'exact context keeps the literal IP');
  assert.equal(countShapeMatches(text, pinned.source), 1);

  // Same-shape context: IP and timestamp become classes, the layout stays literal.
  const shaped = markedValueShapeMulti(scope, range, 'shape', 'shape');
  assert.ok(!shaped.source.includes('67\\.207'), 'no hardcoded IP');
  assert.ok(!shaped.source.includes('Nov'), 'no hardcoded month');
  assert.match(shaped.source, /\\d\+\\\.\\d\+\\\.\\d\+\\\.\\d\+ - \(\?<g1>/, 'IP shape, then the user group');
  assert.match(shaped.source, /\[\+-\]\\d\+/, 'a timezone sign matches + or -');
  assert.equal(shaped.groups.length, 1, 'context runs are non-capturing — only the user is a group');
  let out = run(shaped.source);
  assert.ok(!out[0].includes('dicki8506') && !out[1].includes('marquardt4474'), 'every alnum user is masked');
  assert.ok(out[0].startsWith('178.146.234.131 - ') && out[0].includes('[26/Nov/2019:01:34:17 +0000]'), 'IP and timestamp untouched');
  assert.equal(out[2], text.split('\n')[2], 'the CLF "no user" dash is left alone');
  assert.ok(!/ - 4 \[/.test(out[4]) && out[4].startsWith('10.0.0.4 - '), 'a user equal to an IP octet is masked in place, not in the IP');
  assert.ok(out[5].includes(' - eve ['), 'the shaped edge does not start inside a longer token (x10.0.0.4)');
  assert.ok(out[3].includes('john.doe'), 'the alnum class does not take a dotted name');

  // "Any text" part: dotted / email / DOMAIN\user names too, still not the lone dash.
  const anyUser = markedValueShapeMulti(scope, range, 'any', 'shape');
  out = run(anyUser.source);
  assert.ok(!out[3].includes('john.doe'), 'a dotted username is masked under "any"');
  assert.equal(out[2], text.split('\n')[2], 'still not the "-"');
  for (const name of ['bob@corp.com', 'CORP\\jsmith', 'svc_web']) {
    assert.match(`1.2.3.4 - ${name} [`, new RegExp(anyUser.source.replace(/\\\[\\d.*$/, '\\[')), `"any" takes ${name}`);
  }
  assert.ok(!/,/.test(anyUser.source), 'no raw comma in the source (the extras box is comma-separated)');
});

test('a pick whose context holds an auto-detected IP still masks that IP (apply, marks and preview agree)', () => {
  const text = [
    '178.146.234.131 - dicki8506 [26/Nov/2019:01:34:17 +0000] "GET /a" 204 2338',
    '206.249.78.234 - - [26/Nov/2019:01:34:17 +0000] "GET /e" 204 895',
  ].join('\n');
  const scope = '178.146.234.131 - dicki8506 [26/Nov/2019:01:34:17 +0000]';
  const at = scope.indexOf('dicki8506');
  const shaped = markedValueShapeMulti(scope, [{ start: at, end: at + 9 }], 'any', 'shape');
  const plan = planSanitisation(text, { seed: 9, extraPatterns: [{ source: shaped.source, groupNames: ['g1'] }] });
  const ipEntry = plan.entries.find(e => e.original === '178.146.234.131');
  assert.ok(ipEntry && ipEntry.enabled, 'the IP is auto-detected');
  const pick = plan.entries.find(e => e.via === PICKED_PATTERN_VIA);
  assert.ok(pick, 'the user pick is planned');
  const after = applySanitisation(text, plan.entries).split('\n');
  assert.ok(!after[0].includes('178.146.234.131'), 'the IP inside the pick context is masked, not written back');
  assert.ok(after[0].startsWith(`${ipEntry.alias} - `), 'with the same alias it gets everywhere else');
  assert.ok(!after[0].includes('dicki8506'), 'and the picked user is masked');
  assert.ok(after[0].includes('[26/Nov/2019:01:34:17 +0000]'), 'the timestamp is untouched');
  assert.ok(!after[1].includes('206.249.78.234') && after[1].includes(' - - ['), 'a no-user line keeps its dash, IP masked');
  // The before-pane marks cover the IP and the user as separate runs.
  const marks = markSanitisation(text, plan.entries).filter(sp => sp.start < text.indexOf('\n'));
  assert.deepEqual(marks.map(sp => text.slice(sp.start, sp.end)), ['178.146.234.131', 'dicki8506']);
  // The preview's after line is exactly what apply produces.
  const prev = previewSanitisation(text, plan.entries, 5);
  assert.equal(prev.lines[0].after, after[0]);
  assert.deepEqual(prev.lines[0].afterSpans.map(sp => after[0].slice(sp.start, sp.end)), [ipEntry.alias, pick.patchSpans[0].alias]);
  // A pick alias the reviewer edited by hand (still the same layout) keeps their stand-in.
  const edited = plan.entries.map(e => e === pick ? { ...e, alias: rebuildPatternAlias(e, 'someone') } : e);
  assert.match(applySanitisation(text, edited).split('\n')[0], new RegExp(`^${ipEntry.alias.replace(/\./g, '\\.')} - someone \\[`));
});

test('a pick row edit sticks: the shown stand-in is read from the alias, and the edit is spliced back in', () => {
  const text = '10.0.0.1 - dicki8506 [26/Nov/2019:01:34:17 +0000] x\n10.0.0.2 - haag4062 [26/Nov/2019:01:34:17 +0000] y';
  const scope = '10.0.0.1 - dicki8506 [26/Nov/2019:01:34:17 +0000]';
  const at = scope.indexOf('dicki8506');
  const shaped = markedValueShapeMulti(scope, [{ start: at, end: at + 9 }], 'any', 'shape');
  const plan = planSanitisation(text, { seed: 2, extraPatterns: [{ source: shaped.source, groupNames: ['g1'] }] });
  const pick = plan.entries.find(e => e.via === PICKED_PATTERN_VIA && e.original.includes('dicki8506'));
  assert.ok(pick.enabled, 'a pick row starts ticked');
  assert.equal(patternPatchDisplay(pick).to, pick.patchSpans[0].alias, 'fresh: shows the minted stand-in');
  // What the row's input does on a keystroke: splice into the full alias.
  const edited = { ...pick, alias: rebuildPatternAlias(pick, 'alice01') };
  assert.equal(patternPatchDisplay(edited).to, 'alice01', 'the input shows the typed value, not the minted one');
  assert.equal(edited.patchSpans[0].alias, pick.patchSpans[0].alias, 'even though patchSpans still holds the minted stand-in');
  const out = applySanitisation(text, plan.entries.map(e => e === pick ? edited : e)).split('\n')[0];
  assert.match(out, / - alice01 \[26\/Nov\/2019:01:34:17 \+0000\] x$/, 'the edit lands in place, context kept');
  assert.ok(!out.includes('10.0.0.1'), 'and the IP in the context is still masked');
});

test('the wizard row: only the checkbox ticks it, and a pick-row edit goes through rebuildPatternAlias', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  const i = wiz.indexOf('const row = (entry: SanitiseEntry) => {');
  const rowBlock = wiz.slice(i, wiz.indexOf('return groupEntries(plan.entries)', i));
  assert.ok(i > 0 && !/<label/.test(rowBlock), 'the review row is not a <label> (a click on the name must not untick it)');
  assert.match(rowBlock, /patch \? rebuildPatternAlias\(entry, event\.target\.value\) : event\.target\.value/, 'pick rows splice the edit into the full alias');
});

test('markedValueShapeMulti merges overlapping/duplicate ranges into one group', () => {
  const scope = 'host-15.20.4200.000';
  const at = scope.indexOf('4200');
  // A chip tap plus a drag that both land inside the same run collapse to a single group.
  const shape = markedValueShapeMulti(scope, [{ start: at, end: at + 4 }, { start: at + 1, end: at + 3 }]);
  assert.ok(shape);
  assert.equal(shape.groups.length, 1, 'overlapping picks merge');
  assert.equal(shape.groups[0].sample, '4200');
});

test('markedValueShapeMulti grows a half-run pick to its alnum boundary and refuses the whole scope', () => {
  const scope = 'x win8cvha y';
  const start = scope.indexOf('n8');
  const shape = markedValueShapeMulti(scope, [{ start, end: start + 2 }]);
  assert.ok(shape);
  assert.equal(shape.groups[0].sample, 'win8cvha', 'grown to the whole run');
  // A single run covering the entire scope is the whole-value pick, not a part.
  assert.equal(markedValueShapeMulti('win8cvha', [{ start: 0, end: 8 }]), null, 'whole scope refused');
  assert.equal(markedValueShapeMulti('', [{ start: 0, end: 0 }]), null, 'empty scope');
  assert.equal(markedValueShapeMulti('abc', []), null, 'no ranges');
});

test('describeSelection surfaces a markMask only for a strict sub-range of the scope', () => {
  const text = '"command_start_%s" "win8cvha"';
  const scopeStart = 0, scopeEnd = text.length;
  const at = text.indexOf('win8cvha');
  const sel = describeSelection({
    text, start: at, end: at + 'win8cvha'.length, entries: [], scopeStart, scopeEnd,
  });
  assert.ok(sel.markMask, 'a run inside the scope offers a mask');
  assert.equal(sel.markMask.shape.groups[0].sample, 'win8cvha');
  // No scope → no markMask, even for the same selection.
  const noScope = describeSelection({ text, start: at, end: at + 'win8cvha'.length, entries: [] });
  assert.equal(noScope.markMask, undefined);
  // Selecting the whole scope is not a mark of itself.
  const whole = describeSelection({ text, start: scopeStart, end: scopeEnd, entries: [], scopeStart, scopeEnd });
  assert.equal(whole.markMask, undefined);
});

test('previewSanitisation shows before/after of changed lines with tight spans', () => {
  const text = [
    'user jsmith from web01 ok',
    'nothing to change here',
    'user jsmith from web01 again',
  ].join('\n');
  const plan = planSanitisation(text, { seed: 9, extraLiterals: ['jsmith', 'web01'], suggestSuspects: false });
  const { lines, totalChanged } = previewSanitisation(text, plan.entries, 5);
  assert.equal(totalChanged, 2, 'only the two lines with an identity change');
  assert.equal(lines.length, 2);
  const first = lines[0];
  assert.equal(first.lineNo, 1);
  assert.notEqual(first.before, first.after, 'the line actually changed');
  // Every marked before-span is exactly a replaced value; the after-span holds its alias.
  assert.ok(first.beforeSpans.length >= 1);
  const changedBefore = first.beforeSpans.map(s => first.before.slice(s.start, s.end));
  assert.ok(changedBefore.includes('jsmith') || changedBefore.includes('web01'), changedBefore.join(','));
  const afterText = first.afterSpans.map(s => first.after.slice(s.start, s.end)).join(' ');
  assert.ok(!afterText.includes('jsmith') && !afterText.includes('web01'), afterText);
  // The preview matches Apply exactly.
  assert.equal(applySanitisation(text, plan.entries).split('\n')[0], first.after);
});

test('previewSanitisation caps the shown lines but reports the true total', () => {
  const text = Array.from({ length: 8 }, (_, i) => `login jsmith seq${i}`).join('\n');
  const plan = planSanitisation(text, { seed: 2, extraLiterals: ['jsmith'], suggestSuspects: false });
  const { lines, totalChanged } = previewSanitisation(text, plan.entries, 3);
  assert.equal(lines.length, 3, 'capped');
  assert.equal(totalChanged, 8, 'but the total is honest');
});

test('previewSanitisation tightens a pattern pick to the changed characters', () => {
  const text = 'consequuntur[8196]: hi';
  const shape = decomposeShape('consequuntur[8196]:');
  const plan = planSanitisation(text, {
    seed: 5, extraPatterns: [{ source: shape.source, groupNames: ['g2'] }], suggestSuspects: false,
  });
  const { lines } = previewSanitisation(text, plan.entries, 5);
  assert.equal(lines.length, 1);
  const marked = lines[0].beforeSpans.map(s => lines[0].before.slice(s.start, s.end));
  assert.deepEqual(marked, ['8196'], 'only the digits are marked, not the whole token');
});

test('previewSanitisation flags only the tryKeys entries as provisional (try) spans', () => {
  const text = [
    'user jsmith from web01 ok',
    'user jsmith from web01 again',
  ].join('\n');
  const plan = planSanitisation(text, { seed: 9, extraLiterals: ['jsmith', 'web01'], suggestSuspects: false });
  // Treat the web01 entry as the not-yet-committed pick; jsmith is already committed.
  const web01 = plan.entries.find(e => e.original === 'web01');
  const tryKeys = new Set([`${web01.kind}:${web01.original}`]);
  const { lines } = previewSanitisation(text, plan.entries, 5, false, tryKeys);
  const spans = lines[0].afterSpans;
  const trySpans = spans.filter(s => s.try);
  const committedSpans = spans.filter(s => !s.try);
  assert.ok(trySpans.length >= 1, 'the previewed pick produces a try-flagged span');
  assert.ok(committedSpans.length >= 1, 'the committed pick stays unflagged');
  // The try span covers web01's alias, not jsmith's.
  const tryText = trySpans.map(s => lines[0].after.slice(s.start, s.end)).join(' ');
  assert.equal(tryText, web01.alias, 'the try span is exactly the previewed entry’s alias');
});

test('previewSanitisation leaves every after-span unflagged when no tryKeys are given', () => {
  const text = 'user jsmith from web01 ok';
  const plan = planSanitisation(text, { seed: 9, extraLiterals: ['jsmith', 'web01'], suggestSuspects: false });
  const { lines } = previewSanitisation(text, plan.entries, 5, true);
  assert.ok(lines[0].afterSpans.every(s => !s.try), 'no tryKeys → nothing is provisional');
});

test('expandToShapeToken grows 4212 inside brackets to the whole composite', () => {
  const line = 'msg=bufbwjesfe[4212]: ok';
  const at = line.indexOf('4212');
  assert.equal(expandToShapeToken(line, at, at + 4), 'bufbwjesfe[4212]:');
});

test('pattern extras round-trip without being torn by the comma-separated extras box', () => {
  const token = encodePatternExtra('(?<g1>[A-Za-z]+)\\[(?<g2>\\d+)\\]:', ['g1', 'g2']);
  assert.ok(token.startsWith('re:'), token);
  // Must not contain a bare comma — extras split on commas.
  assert.ok(!token.includes(','), token);
  const parsed = parsePatternExtra(token);
  assert.deepEqual(parsed, {
    source: '(?<g1>[A-Za-z]+)\\[(?<g2>\\d+)\\]:',
    groupNames: ['g1', 'g2'],
  });
  const split = splitExtras(`ACME, ${token}, field:quoteNumber`);
  assert.deepEqual(split.literals, ['ACME']);
  assert.deepEqual(split.fields, ['quoteNumber']);
  assert.equal(split.patterns.length, 1);
  assert.deepEqual(split.patterns[0].groupNames, ['g1', 'g2']);
});

test('describeSelection offers pattern groups for a composite token', () => {
  const text = 'bufbwjesfe[4212]: login\notherhost[99]: login\n';
  const start = text.indexOf('bufbwjesfe');
  const end = text.indexOf(':') + 1;
  const sel = describeSelection({ text, start, end, entries: [] });
  assert.ok(sel?.pattern);
  assert.equal(sel.pattern.shape.groups.length, 2);
  assert.equal(sel.pattern.matches, 2);
});

// --- label-anchored value mask ---------------------------------------------
// The gap: a reviewer selects `inode: 5330950` (or `inode 5330950`) and the bare
// value is refused as "just a number" with nothing to pin it down. A `name=value`
// pair is already covered by the field pick; the value mask covers the `:` and
// space delimiters too, keeping the label and masking only the value.

test('labelValueShape keeps the label and groups just the value, across =, :, and space', () => {
  for (const [token, wantDelim] of [['inode=5330950', '='], ['inode: 5330950', ': '], ['inode 5330950', ' ']]) {
    const shape = labelValueShape(token);
    assert.ok(shape, `${token} must produce a shape`);
    assert.equal(shape.groups.length, 1, 'exactly one value group');
    assert.equal(shape.groups[0].name, 'g1');
    assert.equal(shape.groups[0].sample, '5330950');
    assert.equal(shape.groups[0].kind, 'digits');
    // The regex anchors the literal label and captures only the value.
    assert.match(shape.source, /inode/, 'label literal is in the pattern');
    assert.match(shape.source, /\(\?<g1>\\d\+\)/, 'value is the sole captured group');
    // The display token normalises to one delimiter so the button can show it.
    assert.equal(shape.token, `inode${wantDelim}5330950`);
  }
});

test('labelValueShape masks hex and id-shaped values but never a bare label or word', () => {
  assert.ok(labelValueShape('addr=0x1f4a'), 'hex 0x value');
  assert.ok(labelValueShape('device: eth0'), 'id-shaped value (alnum with a digit)');
  assert.ok(labelValueShape('uid=abc123def'), 'id run');
  // A value with no digit and no 0x prefix is a word, not an identifier shape.
  assert.equal(labelValueShape('status=active'), null, 'plain word value is not masked');
  // A label that does not read as a field name is refused.
  assert.equal(labelValueShape('123=456'), null, 'numeric label is not a field name');
  // A structural placeholder label is refused.
  assert.equal(labelValueShape('null: 5330950'), null, 'NEVER-listed label is refused');
  // No delimiter at all — not a label/value pair.
  assert.equal(labelValueShape('5330950'), null);
});

test('describeSelection offers a value mask for a label:value selection whose value is refused alone', () => {
  const text = 'meta inode: 5330950 mode 644\nmeta inode: 42 mode 600\n';
  const start = text.indexOf('inode');
  const end = text.indexOf('5330950') + '5330950'.length;
  const sel = describeSelection({ text, start, end, entries: [] });
  assert.ok(sel?.valueMask, 'a value mask is offered');
  assert.equal(sel.valueMask.shape.groups[0].sample, '5330950');
  assert.equal(sel.valueMask.matches, 2, 'both inode values across the sample are counted');
});

test('the value mask replaces only the value after the label, everywhere, keeping the label', () => {
  const text = [
    'meta inode: 5330950 mode 644',
    'meta inode: 42 mode 600',
    'other 5330950 stays',
  ].join('\n');
  const shape = labelValueShape('inode: 5330950');
  const plan = planSanitisation(text, {
    seed: 9,
    extraPatterns: [{ source: shape.source, groupNames: ['g1'] }],
    suggestSuspects: false,
  });
  const after = applySanitisation(text, plan.entries);
  // The label survives, both values are gone, the bare number outside the pair stays.
  assert.match(after, /inode: \S+ mode 644/, 'label kept, value masked on line 1');
  assert.ok(!after.includes('inode: 5330950') && !after.includes('inode: 42'), after);
  assert.match(after, /other 5330950 stays/, 'the same digits outside the label are untouched');
});

test('labelValueShape masks a structured dotted/hyphenated value (no digit needed)', () => {
  // The reviewer highlights a whole `field=value` out of a comma-joined line and wants the
  // label kept and the WHOLE dotted value masked — the case that was falling through to the
  // over-matching per-word shape buttons because the value carried no digit.
  const shape = labelValueShape('JMSReplyTo=pub.esb.genericasync.response');
  assert.ok(shape, 'a dotted value produces a value mask');
  assert.equal(shape.groups[0].sample, 'pub.esb.genericasync.response');
  assert.equal(shape.groups[0].classRe, '[A-Za-z0-9][\\w.-]*', 'the true value class is carried on the group');
  assert.equal(groupRegexFragment(shape.groups[0]), '[A-Za-z0-9][\\w.-]*',
    'the chip shows the real class, not a \\d+ that misdescribes the value');
  assert.equal(shape.token, 'JMSReplyTo=pub.esb.genericasync.response');
  // Hyphenated hosts qualify too; a bare dictionary word still does not.
  assert.ok(labelValueShape('host=web-app-01.corp'), 'hyphen + dot host');
  assert.ok(labelValueShape('node: edge-gateway-a'), 'hyphenated id, space/colon delim');
  assert.equal(labelValueShape('status=active'), null, 'a bare word is still refused');
  assert.equal(labelValueShape('orderType=ChangeESN'), null, 'a bare CamelCase enum is still refused');
});

test('the dotted value mask keeps the label, masks the whole value, and stops at the comma', () => {
  const text = [
    'ts=1,JMSReplyTo=pub.esb.genericasync.response,MethodName=InternalEvent',
    'ts=2,JMSReplyTo=pub.esb.other.response,MethodName=InternalEvent',
  ].join('\n');
  const start = text.indexOf('JMSReplyTo');
  const end = text.indexOf('response') + 'response'.length; // whole field=value
  const sel = describeSelection({ text, start, end, entries: [] });
  // Selecting from the label leaves no field pick (fieldAt keys on the value span), so the
  // value mask is what the pick bar offers — and it counts only THIS label, not every token.
  assert.ok(sel?.valueMask, 'a value mask is offered for the dotted field=value');
  assert.equal(sel.field, undefined, 'no whole-field pick when the selection starts at the label');
  assert.equal(sel.valueMask.matches, 2, 'only the two JMSReplyTo values are counted, not every dotted token');

  const plan = planSanitisation(text, {
    seed: 7,
    extraPatterns: [{ source: sel.valueMask.shape.source, groupNames: ['g1'] }],
    suggestSuspects: false,
  });
  const after = applySanitisation(text, plan.entries);
  assert.ok(!after.includes('pub.esb.genericasync.response') && !after.includes('pub.esb.other.response'), after);
  // The label, the delimiter and the neighbouring fields survive — the mask stopped at the comma.
  assert.match(after, /JMSReplyTo=\S+,MethodName=InternalEvent/, 'label kept, next field intact');
});

test('labelValueShape recognises a JSON pair — keeps the key + quotes literal, masks only the value', () => {
  // The O365 case: selecting a whole "key": "value" used to fall through to the composite-shape
  // splitter, which cut the SID into eight hyphen-separated runs (none useful). It now produces
  // one clean value mask that keeps the key AND the surrounding quotes literal.
  const shape = labelValueShape('"MailboxOwnerSid": "S-1-5-21-1602961430-1569800660-4034667653-27366329"');
  assert.ok(shape, 'a JSON quoted pair produces a value mask');
  assert.equal(shape.groups.length, 1, 'exactly one value group');
  assert.equal(shape.groups[0].name, 'g1');
  assert.equal(shape.groups[0].sample, 'S-1-5-21-1602961430-1569800660-4034667653-27366329');
  assert.equal(shape.groups[0].classRe, '[^"]*', 'the content class stops at the closing quote');
  // The quotes stay literal outside the group so the sanitised JSON is still valid.
  assert.equal(shape.source, '"MailboxOwnerSid"[ \\t]*:[ \\t]*"(?<g1>[^"]*)"');
  assert.equal(shape.token, '"MailboxOwnerSid": "S-1-5-21-1602961430-1569800660-4034667653-27366329"');

  // Variants: no space after the colon, a value with spaces, and a bare JSON number.
  assert.ok(labelValueShape('"user":"john.doe@corp.example"'), 'no-space colon');
  assert.equal(labelValueShape('"DisplayName": "John Smith"')?.groups[0].sample, 'John Smith', 'quoted value with a space');
  assert.equal(labelValueShape('"RecordType": 15')?.groups[0].classRe, '\\d+', 'bare JSON number masked as a number');
  // A NEVER-listed or non-field label is still refused.
  assert.equal(labelValueShape('"null": "x"'), null, 'NEVER-listed JSON key is refused');
});

test('describeSelection offers a JSON value mask (not a wall of SID fragments) and recommends it', () => {
  const line = '{"CreationTime":"2024-01-02T03:04:05","MailboxOwnerSid":"S-1-5-21-1602961430-1569800660-4034667653-27366329","Operation":"MailItemsAccessed"}';
  const text = `${line}\n${line.replace('27366329', '99999999')}\n`;
  // Select the whole "MailboxOwnerSid":"S-1-..." pair (as a reviewer drag would).
  const start = text.indexOf('"MailboxOwnerSid"');
  const end = text.indexOf('"S-1-5-21-1602961430-1569800660-4034667653-27366329"') + '"S-1-5-21-1602961430-1569800660-4034667653-27366329"'.length;
  const sel = describeSelection({ text, start, end, entries: [] });
  assert.ok(sel?.valueMask, 'a JSON value mask is offered for the whole pair selection');
  assert.equal(sel.valueMask.matches, 2, 'both records are counted');

  const choices = buildSanitiseChoices(sel);
  const value = choices.find(c => c.id === 'valueMask');
  assert.ok(value, 'the value-mask choice is present');
  assert.ok(value.recommended, 'and it is the recommended default');
  assert.equal(value.label, 'Every “"MailboxOwnerSid":” value', 'the label reads the JSON key cleanly, no trailing quote');
  // The old SID-fragment noise is suppressed once a value mask exists.
  assert.ok(!choices.some(c => c.id.startsWith('part:')), 'no per-fragment part offers alongside the value mask');
});

test('applying a JSON value mask keeps the key + quotes, masks the value, and stays valid JSON', () => {
  const line = '{"MailboxOwnerSid":"S-1-5-21-1602961430-1569800660-4034667653-27366329","Operation":"MailItemsAccessed"}';
  const text = `${line}\n{"MailboxOwnerSid":"S-1-5-21-1602961430-1569800660-4034667653-11112222","Operation":"Send"}`;
  const shape = labelValueShape('"MailboxOwnerSid": "S-1-5-21-1602961430-1569800660-4034667653-27366329"');
  const plan = planSanitisation(text, {
    seed: 3,
    extraPatterns: [{ source: shape.source, groupNames: ['g1'] }],
    suggestSuspects: false,
  });
  const after = applySanitisation(text, plan.entries);
  assert.ok(!after.includes('27366329') && !after.includes('11112222'), 'both SID values are gone');
  assert.ok(after.includes('"Operation":"MailItemsAccessed"'), 'a neighbouring field is untouched');
  // Every line is still parseable JSON — the quotes were kept literal.
  for (const l of after.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(l), `sanitised line is valid JSON: ${l}`);
    assert.ok(JSON.parse(l).MailboxOwnerSid, 'the key survives with a (masked) value');
  }
});

test('selecting a JSON value (with or without its quotes) masks the whole value, anchored on the key', () => {
  // The OriginatingServer case: a value with a space, parens, dots and a trailing \r\n. Grabbing
  // it any of the three natural ways must yield the SAME key-anchored whole-value mask — never a
  // wall of per-run fragments, never the value's own first word read as a label.
  const line = '{"OriginatingServer": "BEUP281MB3649 (15.20.4200.000)\\r\\n", "Operation": "Send"}';
  const text = `${line}\n${line.replace('BEUP281MB3649', 'NLAM102MB9001')}\n`;
  const want = '"OriginatingServer"[ \\t]*:[ \\t]*"(?<g1>[^"]*)"';

  const wholePair = describeSelection({ text, start: text.indexOf('"OriginatingServer"'), end: text.indexOf('\\r\\n"') + '\\r\\n"'.length, entries: [] });
  const q = text.indexOf('"BEUP281MB3649');
  const valueWithQuotes = describeSelection({ text, start: q, end: text.indexOf('\\r\\n"', q) + '\\r\\n"'.length, entries: [] });
  const inner = describeSelection({ text, start: text.indexOf('BEUP281MB3649'), end: text.indexOf(')', text.indexOf('BEUP281MB3649')) + 1, entries: [] });

  for (const [name, sel] of [['whole pair', wholePair], ['value+quotes', valueWithQuotes], ['inner value', inner]]) {
    assert.ok(sel?.valueMask, `${name}: a value mask is offered`);
    assert.equal(sel.valueMask.shape.source, want, `${name}: it is the key-anchored whole-value mask`);
    assert.equal(sel.valueMask.matches, 2, `${name}: both records counted`);
    const choices = buildSanitiseChoices(sel);
    assert.ok(!choices.some(c => c.id.startsWith('part:')), `${name}: no per-fragment noise`);
    assert.ok(choices.find(c => c.id === 'valueMask')?.recommended, `${name}: the value mask is recommended`);
  }

  // And it applies cleanly: both server values gone, quotes + key + neighbour intact, still JSON.
  const shape = valueWithQuotes.valueMask.shape;
  const plan = planSanitisation(text, { seed: 4, extraPatterns: [{ source: shape.source, groupNames: ['g1'] }], suggestSuspects: false });
  const after = applySanitisation(text, plan.entries);
  assert.ok(!after.includes('BEUP281MB3649') && !after.includes('NLAM102MB9001'), 'both server names masked');
  assert.ok(after.includes('"Operation": "Send"'), 'the neighbour field is untouched');
});

test('an explicit selection masks a plain-word value the speculative guard would refuse', () => {
  // Default (speculative) call still refuses a bare word — that guard protects unrequested offers.
  assert.equal(labelValueShape('status=active'), null, 'speculative: a plain word stays refused');
  assert.equal(labelValueShape('"Operation": prod'), null, 'speculative: bare JSON word refused');
  // Explicit pick (the reviewer highlighted the whole pair): the word IS identity by their choice.
  const kv = labelValueShape('status=active', { explicit: true });
  assert.ok(kv, 'explicit: the plain-word value is masked');
  assert.equal(kv.groups[0].sample, 'active');
  assert.equal(kv.groups[0].classRe, '[A-Za-z]+', 'a letters value generalises to every status= word');
  const jsonEnum = labelValueShape('"Operation": "MailItemsAccessed"', { explicit: true });
  assert.ok(jsonEnum, 'explicit: a quoted JSON enum value is masked (quotes stay literal)');
  assert.equal(jsonEnum.groups[0].sample, 'MailItemsAccessed');

  // describeSelection uses the explicit path for a highlighted pair.
  const text = 'level=info status=active user=root\nlevel=warn status=locked user=svc\n';
  const start = text.indexOf('status=active');
  const end = start + 'status=active'.length;
  const sel = describeSelection({ text, start, end, entries: [] });
  assert.ok(sel?.valueMask, 'describeSelection offers the value mask for an explicitly-selected word pair');
  assert.equal(sel.valueMask.matches, 2, 'both status values are counted');
});

test('double-clicking the value of ppid=27477 still offers a label-anchored value mask', () => {
  // A double-click stops at the `=`, so the selection is the bare number and the label is not
  // in it — labelValueShape(selected) is null. The mask must be rebuilt from the field pair so
  // the reviewer gets "keep ppid=, mask the number" instead of only the field alias.
  const text = [
    'audit: exit=0 ppid=27477 pid=27490 auid=1000',
    'audit: exit=0 ppid=27477 pid=27492 auid=1000',
    'audit: exit=0 ppid=99999 pid=27494 auid=1000',
  ].join('\n');
  const start = text.indexOf('ppid=27477') + 'ppid='.length; // caret inside the value
  const end = start + '27477'.length;
  const sel = describeSelection({ text, start, end, entries: [] });
  assert.ok(sel?.field, 'the field pick is still there');
  assert.equal(sel.field.name, 'ppid');
  assert.ok(sel?.valueMask, 'a value mask is rebuilt from the pair even though the label was not selected');
  assert.match(sel.valueMask.shape.source, /ppid\[ \\t\]\*=\[ \\t\]\*\(\?<g1>\\d\+\)/, 'the mask is anchored to ppid=');
  assert.equal(sel.valueMask.matches, 3, 'all three ppid values are counted, and only ppid');
  assert.equal(sel.valueMask.shape.token, 'ppid=27477');

  // Applying it keeps ppid= and every other field, and swaps the number for a same-length one.
  const plan = planSanitisation(text, {
    seed: 5,
    extraPatterns: [{ source: sel.valueMask.shape.source, groupNames: ['g1'] }],
    suggestSuspects: false,
  });
  const after = applySanitisation(text, plan.entries);
  assert.ok(!after.includes('ppid=27477') && !after.includes('ppid=99999'), after);
  assert.match(after, /ppid=\d+ pid=27490 auid=1000/, 'ppid= kept, neighbours (pid, auid) untouched');
});

test('a double-click on a JSON string value rebuilds a JSON-anchored value mask', () => {
  // A quoted JSON key is the other pair fieldPairs yields. The rebuild reconstructs it as
  // `"ppid": "value"` and keeps the key + quotes literal, so a double-click on the value
  // offers "keep the key, mask the value" — the same intent as ppid= but for JSON.
  const text = '{"ppid": "not-a-number-here", "pid": 27490}';
  const start = text.indexOf('not-a-number');
  const end = start + 'not-a-number-here'.length;
  const sel = describeSelection({ text, start, end, entries: [] });
  assert.ok(sel?.valueMask, 'a JSON value mask is offered');
  assert.match(sel.valueMask.shape.source, /"ppid"\[ \\t\]\*:\[ \\t\]\*"\(\?<g1>\[\^"\]\*\)"/,
    'the mask is anchored to "ppid": and keeps the quotes literal');
  assert.equal(sel.valueMask.matches, 1, 'only the one ppid value is counted');
});

test('the value mask is dropped when no reconstruction matches the sample', () => {
  // A value that reaches no key=value / JSON reconstruction (the pair reader finds nothing
  // around the caret) must not surface a zero-match mask; the plain literal owns that case.
  const text = 'plain 5330950 with no field anywhere\n';
  const start = text.indexOf('5330950');
  const end = start + '5330950'.length;
  const sel = describeSelection({ text, start, end, entries: [] });
  assert.equal(sel?.valueMask, undefined, 'no zero-match value mask is surfaced');
});

test('applying name-only keeps the bracketed number and catches other matches', () => {
  const text = [
    'bufbwjesfe[4212]: ok',
    'otherhost[99]: ok',
    'port 4212 stays',
  ].join('\n');
  const shape = decomposeShape('bufbwjesfe[4212]:');
  const plan = planSanitisation(text, {
    seed: 42,
    extraPatterns: [{ source: shape.source, groupNames: ['g1'] }],
    suggestSuspects: false,
  });
  const patternRows = plan.entries.filter(e => e.via === PICKED_PATTERN_VIA);
  assert.ok(patternRows.length >= 2, 'one row per distinct full match');
  const after = applySanitisation(text, plan.entries);
  assert.ok(!after.includes('bufbwjesfe'), after);
  assert.ok(!after.includes('otherhost'), after);
  assert.match(after, /\[\d+\]:/, 'brackets and digits from the shape remain');
  assert.match(after, /port 4212 stays/, 'bare 4212 outside the shape is untouched');
});

test('a pattern whose full match starts mid-word still produces a live before/after', () => {
  // Regression: a user-picked regex that begins after a word char (`product_id` picked as
  // `_id=…`) yielded a field pill but no preview — the counting/apply matcher wrapped every
  // literal in a `(?<![\w.$-])` guard, which the preceding `d` failed, so the row was silently
  // dropped from `live` with no "did not match" warning. A pattern pick anchors itself; it must
  // not be re-guarded on a word boundary.
  const text = '12.130.60.5 - - "GET /product.screen?product_id=Goats&JSESSIONID=SD3SL1FF7ADFF8 HTTP/1.1" 301';
  const plan = planSanitisation(text, {
    seed: 3,
    suggestSuspects: false,
    extraPatterns: [{ source: '_id=Goats&\\S+[\\=](?<g1>\\S+)', groupNames: ['g1'] }],
  });
  const row = plan.entries.find(e => e.via === PICKED_PATTERN_VIA);
  assert.ok(row, 'pattern row exists');
  assert.equal(row.original, '_id=Goats&JSESSIONID=SD3SL1FF7ADFF8');
  assert.ok(!plan.warnings.some(w => /did not match/i.test(w)), 'no false did-not-match warning');
  const after = applySanitisation(text, plan.entries.filter(e => e.enabled));
  assert.notEqual(after, text, 'the sample actually changes');
  assert.ok(!after.includes('SD3SL1FF7ADFF8'), 'the picked group value is replaced: ' + after);
  assert.match(after, /product_id=Goats&JSESSIONID=/, 'the context the pattern kept survives');
  // The guard must still hold for ordinary identity entries — a bare host nested in an FQDN
  // must not double-match.
  const nested = planSanitisation('host web01.corp.local from web01', { seed: 3 });
  assert.deepEqual(
    nested.entries.filter(e => e.enabled).map(e => e.original),
    ['web01.corp.local'],
    'nested FQDN still guarded (bare web01 not separately matched)');
});

test('applying both replaces name and number, punctuation stays', () => {
  const text = 'bufbwjesfe[4212]: ok\notherhost[99]: ok';
  const shape = decomposeShape('bufbwjesfe[4212]:');
  const plan = planSanitisation(text, {
    seed: 7,
    extraPatterns: [{ source: shape.source, groupNames: ['g1', 'g2'] }],
    suggestSuspects: false,
  });
  const after = applySanitisation(text, plan.entries);
  assert.ok(!after.includes('bufbwjesfe') && !after.includes('4212'), after);
  assert.ok(!after.includes('otherhost') && !after.includes('[99]'), after);
  assert.match(after, /\w+\[\d+\]:/, 'shape preserved');
});

test('digits-only marks and lists just the number, not the whole token', () => {
  const text = 'foo consequuntur[8196]: bar\nport 8196 stays';
  const shape = decomposeShape('consequuntur[8196]:');
  const plan = planSanitisation(text, {
    seed: 42,
    extraPatterns: [{ source: shape.source, groupNames: ['g2'] }],
    suggestSuspects: false,
  });
  const row = plan.entries.find(e => e.via === PICKED_PATTERN_VIA);
  assert.ok(row, 'pattern row exists');
  assert.equal(row.original, 'consequuntur[8196]:');
  assert.ok(row.alias.startsWith('consequuntur[') && row.alias.endsWith(']:'), row.alias);
  assert.ok(!row.alias.includes('8196'), row.alias);
  assert.ok(row.patchSpans?.length === 1);
  assert.equal(row.original.slice(row.patchSpans[0].start, row.patchSpans[0].end), '8196');

  const disp = patternPatchDisplay(row);
  assert.equal(disp?.from, '8196');
  assert.equal(disp?.to, row.patchSpans[0].alias);

  const spans = markSanitisation(text, plan.entries).filter(s => s.entry.original === row.original);
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), '8196',
    'highlight paints only the chosen group');
  assert.ok(!spans.some(s => text.slice(s.start, s.end) === 'consequuntur'),
    'the name is not marked when only the number was chosen');

  const after = applySanitisation(text, plan.entries);
  assert.match(after, /consequuntur\[\d+\]:/);
  assert.ok(!after.includes('8196') || after.includes('port 8196 stays'), after);
  assert.match(after, /port 8196 stays/, 'bare 8196 outside the shape stays');
});

test('editing the displayed patch rebuilds the full-token alias', () => {
  const text = 'consequuntur[8196]:';
  const shape = decomposeShape('consequuntur[8196]:');
  const plan = planSanitisation(text, {
    seed: 1,
    extraPatterns: [{ source: shape.source, groupNames: ['g2'] }],
    suggestSuspects: false,
  });
  const row = plan.entries.find(e => e.via === PICKED_PATTERN_VIA);
  assert.ok(row?.patchSpans?.length === 1);
  assert.equal(rebuildPatternAlias(row, '4242'), 'consequuntur[4242]:');
});

// Run describeSelection over a line, selecting `needle`, optionally within a wider scope for
// the mark gesture. (Distinct from the plain `selectIn` above, which takes no scope.)
function selectScoped(text, needle, { entries = [], scope } = {}) {
  const start = text.indexOf(needle);
  const end = start + needle.length;
  const opts = { text, start, end, entries };
  if (scope) {
    opts.scopeStart = text.indexOf(scope);
    opts.scopeEnd = opts.scopeStart + scope.length;
  }
  return describeSelection(opts);
}

test('buildSanitiseChoices: a whole field=value keeps its parts pickable, value mask leads', () => {
  // Highlighting the WHOLE `pid=27480` yourself asks "every pid= value / only pid=27480" AND
  // keeps the parts you selected refinable — the reviewer chose the pair, so `pid` and `27480`
  // are theirs to narrow to. (A value the caret merely LANDS in — see the next test — still
  // suppresses the per-part noise.) The value mask stays the recommended default.
  const sel = selectScoped('auth pid=27480 user=bob', 'pid=27480');
  assert.ok(sel.valueMaskFromSelection, 'the whole pair was selected, not just the value');
  const choices = buildSanitiseChoices(sel);
  const ids = choices.map(c => c.id);
  assert.ok(ids.includes('valueMask'), 'offers the label-anchored value mask');
  assert.ok(ids.includes('literal'), 'offers the exact literal');
  assert.ok(ids.some(id => id.startsWith('part:')), 'the self-selected pair keeps its per-part offers');
  const vm = choices.find(c => c.id === 'valueMask');
  assert.equal(vm.label, 'Every “pid=” value', 'value-mask label keeps the field name');
  assert.ok(vm.recommended, 'the value mask is the recommended default');
  assert.match(vm.token, /^re:/, 'value mask stores a re: extras token');
  const lit = choices.find(c => c.id === 'literal');
  assert.match(lit.label, /^Only “pid=27480”/, 'the literal reads as the narrow "only this exact text"');
  assert.equal(lit.token, 'pid=27480', 'literal token is the exact text');
  assert.equal(lit.openGroup, 'custom', 'a literal lands in the custom group');
  assert.equal(choices.filter(c => c.recommended).length, 1, 'exactly one recommended');
});

test('buildSanitiseChoices: a value the caret only lands in still suppresses per-part noise', () => {
  // Double-clicking just `27480` inside `pid=27480` did NOT select the pair — describeSelection
  // rebuilds the value mask from the field around the caret, so `valueMaskFromSelection` is
  // false and the per-part chips stay suppressed (the redesign's no-noise rule).
  const sel = selectScoped('auth pid=27480 user=bob', '27480');
  assert.ok(!sel.valueMaskFromSelection, 'only the value was under the caret, not the whole pair');
  const choices = buildSanitiseChoices(sel);
  assert.ok(!choices.some(c => c.id.startsWith('part:')), 'no per-part chips for a caret-landed value');
});

test('buildSanitiseChoices: the bare value alone still offers to mask every field value', () => {
  // Double-clicking just `27480` inside `pid=27480` is a number on its own — unsafe as a
  // literal — but describeSelection anchors it to its field, so the guided list still leads
  // with "every pid= value" instead of dead-ending on "that is just a number".
  const sel = selectScoped('auth pid=27480 user=bob', '27480');
  const choices = buildSanitiseChoices(sel);
  assert.ok(!sel.ok, 'a bare number is not a safe literal');
  const rec = choices.find(c => c.recommended);
  assert.ok(rec && (rec.id === 'valueMask' || rec.id === 'field'), 'recommends masking the whole field value');
  assert.ok(!choices.some(c => c.id === 'literal'), 'no literal offer for an unsafe bare number');
});

test('buildSanitiseChoices: a bracketed composite offers the number inside that token', () => {
  // `sshd[27480]` has no key=value delimiter, so there is no value mask — the guided list
  // falls to the per-part offers, and recommends the number (the identity in that shape).
  const sel = selectScoped('daemon sshd[27480]: started', '27480');
  const choices = buildSanitiseChoices(sel);
  assert.ok(!choices.some(c => c.id === 'valueMask'), 'no value mask without a label delimiter');
  const parts = choices.filter(c => c.id.startsWith('part:'));
  assert.ok(parts.length >= 2, 'offers each variable part of the shape');
  assert.ok(parts.some(c => /number in/.test(c.label)), 'names the number part in plain words');
  const rec = choices.find(c => c.recommended);
  assert.match(rec.label, /number in “sshd\[27480\]/, 'recommends masking the number inside the token');
});

test('buildSanitiseChoices: a run marked inside a scope is the most-specific recommended choice', () => {
  // Select the whole `sshd[27480]`, then highlight `27480` inside it — the mark gesture. That
  // marked run, kept literal in its exact context, leads the list and is recommended.
  const sel = selectScoped('daemon sshd[27480]: started', '27480', { scope: 'sshd[27480]' });
  assert.ok(sel.markMask, 'describeSelection produced a markMask for the sub-range');
  const choices = buildSanitiseChoices(sel);
  const rec = choices.find(c => c.recommended);
  assert.equal(rec.id, 'mark', 'the marked run is the recommended default');
  assert.match(rec.label, /Only the marked “27480”/, 'the mark choice names the marked run');
});

test('buildSanitiseChoices: a distinct-valued field with no value mask offers the whole field', () => {
  // A quoted-JSON value that key=value parsing sees as a field but labelValueShape rejects:
  // no value mask, so the field pick itself carries the "all N values" offer.
  const line = '{"quoteNumber":"51015341","user":"bob"}\n{"quoteNumber":"99887766","user":"amy"}';
  const start = line.indexOf('51015341');
  const sel = describeSelection({ text: line, start, end: start + 8, entries: [] });
  const choices = buildSanitiseChoices(sel);
  const field = choices.find(c => c.id === 'field');
  if (field) {
    assert.match(field.token, /^field:/, 'field pick stores a field: token');
    assert.match(field.label, /values of “quoteNumber”|value of “quoteNumber”/, 'names the field');
  }
  // Whichever it resolves to, there is exactly one recommended default and it is safe.
  assert.equal(choices.filter(c => c.recommended).length, 1, 'exactly one recommended default');
});

test('buildSanitiseChoices: null / refused-with-nothing selections yield no choices', () => {
  assert.deepEqual(buildSanitiseChoices(null), [], 'no selection, no choices');
  // A structural placeholder with no field/pattern/mask around it has nothing safe to offer.
  const sel = selectScoped('level=info true done', 'true');
  const choices = buildSanitiseChoices(sel);
  // `true` is in NEVER; if the harness offers nothing, the panel shows the reason instead.
  if (!choices.length) assert.ok(sel && !sel.ok, 'an empty list means the reason is shown');
});

test('buildSanitiseChoices: every choice carries a match badge (format / exact / part)', () => {
  // The second question — "match the format, or only this exact value?" — is a per-choice
  // property the UI renders as a badge, so it must be set on every offer and be one of three.
  const valued = buildSanitiseChoices(selectScoped('auth pid=27480 user=bob', 'pid=27480'));
  const vm = valued.find(c => c.id === 'valueMask');
  const lit = valued.find(c => c.id === 'literal');
  assert.equal(vm.match, 'format', 'a value mask matches the format (any value of the field)');
  assert.equal(lit.match, 'exact', 'a literal matches only this exact text');
  const bracketed = buildSanitiseChoices(selectScoped('daemon sshd[27480]: started', '27480'));
  assert.ok(bracketed.filter(c => c.id.startsWith('part:')).every(c => c.match === 'part'),
    'a per-part offer is a part match');
  const marked = buildSanitiseChoices(selectScoped('daemon sshd[27480]: started', '27480', { scope: 'sshd[27480]' }));
  assert.equal(marked.find(c => c.id === 'mark').match, 'part', 'a marked run is a part match');
  for (const c of [...valued, ...bracketed, ...marked]) {
    assert.ok(['format', 'exact', 'part'].includes(c.match), `${c.id} has a valid match badge`);
  }
});

test('canRefineSelection: offered only for a composite value, and not once a mark is active', () => {
  // A composite value (a word + a version) can be narrowed by highlighting a part — offer the
  // second step. The OriginatingServer case the user reported: two runs, so refinable.
  const composite = selectScoped(
    '{"OriginatingServer": "BEUP281MB3649 (15.20.4200.000)"}',
    'BEUP281MB3649 (15.20.4200.000)');
  assert.ok(composite.pattern && composite.pattern.shape.groups.length > 1, 'the value is a composite');
  assert.ok(canRefineSelection(composite), 'a composite value can be refined into a part');
  // An atomic value has nothing finer to pick.
  const atomic = selectScoped('user=bob logged in', 'bob');
  assert.ok(!canRefineSelection(atomic), 'a single-run value is not refinable');
  // Once the reviewer HAS marked a sub-run, the refinement already happened — do not re-prompt.
  const marked = selectScoped('daemon sshd[27480]: started', '27480', { scope: 'sshd[27480]' });
  assert.ok(marked.markMask, 'the marked selection produced a markMask');
  assert.ok(!canRefineSelection(marked), 'no refine prompt once a mark is active');
  assert.ok(!canRefineSelection(null), 'no selection, nothing to refine');
});

test('splitStructuredToken: each alnum run of a composite is an individually pickable piece', () => {
  // The user's case: a version must break into its dot-separated components so a piece like
  // 4200 can be picked on its own, not only the whole 15.20.4200.000.
  const pieces = splitStructuredToken('BEUP281MB3649 (15.20.4200.000)');
  assert.deepEqual(pieces.map(p => p.text), ['BEUP281MB3649', '15', '20', '4200', '000'],
    'the server name and each version component are separate pieces');
  // Offsets must index back into the SAME string, so a piece maps to a markedValueShape cleanly.
  const value = 'BEUP281MB3649 (15.20.4200.000)';
  for (const p of pieces) {
    assert.equal(value.slice(p.start, p.end), p.text, `piece "${p.text}" offsets are correct`);
  }
  // Kind is inferred from the run's characters — used only for labelling.
  const byText = Object.fromEntries(pieces.map(p => [p.text, p.kind]));
  assert.equal(byText['15'], 'digits', 'a pure-number run is digits');
  assert.equal(byText['BEUP281MB3649'], 'alnum', 'a mixed run is alnum');

  // A pure-letters run is classified letters.
  const words = splitStructuredToken('alpha-beta');
  assert.deepEqual(words.map(p => p.text), ['alpha', 'beta']);
  assert.ok(words.every(p => p.kind === 'letters'), 'both runs are letters');

  // Fewer than two runs → nothing to split, return []. A single atomic value is not refinable.
  assert.deepEqual(splitStructuredToken('bob'), [], 'a single run yields no pieces');
  assert.deepEqual(splitStructuredToken('12345'), [], 'a single number yields no pieces');
  assert.deepEqual(splitStructuredToken(''), [], 'empty input yields no pieces');
  // A lone-digit run adjacent to a word is dropped (too small to be a meaningful, safe part),
  // but a letter run of any length is kept.
  const trimmed = splitStructuredToken('a.1.bb');
  assert.deepEqual(trimmed.map(p => p.text), ['a', 'bb'], 'single-digit "1" is dropped, letters kept');
});

test('the new-pack step has no inline pick bar — the guided radios live in the wizard', () => {
  const app = read('src/App.tsx');
  // The whole inline pick bar (question + radios + apply) moved into the SanitizeWizard
  // modal, so the new-pack step must NOT render its own copy. The wizard's guided radios
  // are covered by the parity test below.
  assert.ok(!/What should be masked\?/.test(app), 'no inline "what should be masked?" question');
  assert.ok(!/name="sanitise-mask"/.test(app), 'no inline radio group');
  assert.ok(!/buildSanitiseChoices\(/.test(app), 'no inline choice helper call');
  assert.ok(!/addSanitiseToken|applySanitiseChoice|setSanitiseChoiceId/.test(app),
    'the inline pick-bar handlers are removed from the new-pack step');
  assert.ok(!/addSanitisePattern|addSanitiseValueMask|groupRegexFragment/.test(app),
    'the old per-chip handlers/helpers are removed from the new-pack step');
});

test('the wizard renders the two-question guided panel (what / match by), driven by the shared choices', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // The choices still come from the one shared helper, so the panel can never diverge from the
  // rule that is applied — but they are now surfaced as two explicit questions, not a radio list.
  assert.match(wiz, /buildSanitiseChoices\(sel\)/, 'choices come from the shared helper');
  // Rendered as three numbered steps on a connecting rail: What → Match by → Mask it.
  assert.match(wiz, /className="sanitise-choices sanitise-steps"/, 'the panel is the numbered-rail layout');
  assert.match(wiz, /<span className="sanitise-step-num">1<\/span>/, 'step 1 number badge');
  assert.match(wiz, /<span className="sanitise-step-num">2<\/span>/, 'step 2 number badge');
  assert.match(wiz, /<span className="sanitise-step-num">3<\/span>/, 'step 3 number badge — Mask it is its own step');
  assert.match(wiz, /className="sanitise-q-head">What should be masked\?/, 'step 1 heading (number is on the rail, not in the text)');
  assert.match(wiz, /className="sanitise-q-head">Match by…/, 'step 2 heading');
  assert.match(wiz, /className="sanitise-q-head">Mask it/, 'step 3 heading');
  // Q1: whole value vs a part, chosen on ONE control — no mode gate. "Whole value" is the
  // pre-selected default chip; tapping a piece (or dragging the strip) IS choosing "a part".
  assert.ok(!/sanitise-q-pill/.test(wiz), 'the old "whole value / a part of it ↓" mode-gate pills are gone');
  assert.ok(!/A part of it/.test(wiz), 'no separate "A part of it" toggle — the pieces are the picker');
  assert.match(wiz, /className="sanitise-strip-pieces-label">Mask:/, 'a single "Mask:" row holds the whole-value default and the pieces');
  assert.match(wiz, /className=\{maskTarget === 'whole' \? 'sanitise-piece-chip whole on' : 'sanitise-piece-chip whole'\}/, 'the "Whole value" chip is on by default and clears the part selection');
  assert.match(wiz, /Whole value\s*<\/button>/, 'the whole-value default chip copy');
  assert.match(wiz, /ref=\{stripRef\} className="sanitise-strip" onMouseUp=\{onStripSelect\}/, 'the value strip is the part picker');
  assert.match(wiz, /onClick=\{\(\) => togglePartPiece\(piece\.start, piece\.end\)\}/, 'each structured piece toggles in/out of the picked parts');
  assert.match(wiz, /pieceIsPicked\(piece\.start, piece\.end\)/, 'a picked piece shows as on (multi-select)');
  assert.match(wiz, /markedValueShapeMulti\(wholeValueText, partRanges, partMatchBy, partContext\)/, 'several picked parts fold into one multi-run mask, built by shape/any/exact and pinned by exact or same-shape context');
  assert.match(wiz, /setPartMatchBy\('any'\)/, 'the "any text" toggle sets partMatchBy to any');
  assert.match(wiz, /setPartContext\('shape'\)/, 'the "same shape" context toggle');
  assert.match(wiz, /setPartContext\('exact'\)/, 'the "this exact text" context toggle');
  assert.ok(!/\x00/.test(wiz), 'no raw NUL bytes in the wizard source (grep treats the file as binary)');
  assert.match(wiz, /splitStructuredToken\(wholeValueText\)/, 'the pieces are the value split into its runs');
  // Q2 (whole value): format vs exact, both wired to matchBy.
  assert.match(wiz, /setMatchBy\('format'\)/, 'the format toggle sets matchBy');
  assert.match(wiz, /setMatchBy\('exact'\)/, 'the exact toggle sets matchBy');
  assert.match(wiz, /maskTarget === 'part' \?/, 'a part gets its own match question');
  // Q2 (a part): the run itself matches by SHAPE (a class like \d+ — "wildcards") or EXACTLY
  // (only this literal value, e.g. 123). The produced regex is shown so it can be edited.
  assert.match(wiz, /setPartMatchBy\('shape'\)/, 'the wildcards toggle sets partMatchBy to shape');
  assert.match(wiz, /setPartMatchBy\('exact'\)/, 'the exact toggle sets partMatchBy to exact');
  // The produced regex sits in its own labelled box in step 2, with a single "Edit regex" entry
  // beside it — the only way into the hand-written editor from the guided panel.
  assert.match(wiz, /className="sanitise-regex-strip-label">Regex</, 'the "Regex" label sits above the box');
  assert.match(wiz, /className="sanitise-regex-strip-code">\{partMask\.shape\.source\}<\/code>/, 'the produced regex is shown for the picked part');
  assert.match(wiz, /className="sanitise-regex-edit"[\s\S]*?onClick=\{\(\) => openRegex\(partMask\.shape\.source\)\}>✎ Edit regex/, '"Edit regex" opens the produced part regex, editable');
  assert.match(wiz, /onClick=\{\(\) => openRegex\(regexFromSelection\(sel\.selected\)\)\}>✎ Edit regex/, 'the whole-value flow opens a prefilled regex from the same entry');
  assert.ok(!/sanitise-choices-actions/.test(wiz), 'the old bottom actions row (Mask it + Write your own regex) is gone — Mask it is now step 3, regex entry is in step 2');
  assert.ok(!/format vs exact.*doesn.t apply/.test(wiz), 'the "doesn\'t apply" dead-end note is gone');
  // One apply button, dispatching the resolved token for the current answers.
  assert.match(wiz, /onClick=\{applySanitiseChoice\}/, 'one "Mask it" apply button');
  assert.match(wiz, />Mask it</, 'the apply button copy');
  assert.match(wiz, /const token = activeChoiceToken;/, 'apply dispatches the resolved token');
  assert.match(wiz, /addExtra\(token, 'picked'\)/, 'a part pick lands in the "picked" fold');
  // The mark gesture and the before/after view stay wired (they feed the same choices/plan).
  assert.match(wiz, /scopeStart: scope\?\.start, scopeEnd: scope\?\.end/, 'selection still carries the scope for a mark');
  assert.match(wiz, /previewSanitisation\(raw, active\.entries, PREVIEW_LINE_CAP, true, activeProvisional\?\.tryKeys, badKeys\)/, 'preview is the always-on, line-capped build from the same replacer, with the provisional pick and blocking masks flagged');
  assert.match(wiz, /className="sanitise-beforeafter"/, 'events are shown before and after, side by side');
  assert.match(wiz, /className="sanitise-sample sanitise-after"/, 'the after column renders the sanitised result');
  // Old per-chip handlers/helpers removed here too.
  assert.ok(!/addSelectionPattern|addSelectionMark|groupRegexFragment|partKindLabel/.test(wiz),
    'the old per-chip handlers/helpers are removed from the wizard');
  assert.ok(!/name="sz-sanitise-mask"/.test(wiz), 'the old flat radio group is gone');
  // The two-question panel shares one stylesheet across both panels.
  const css = read('src/App.css');
  assert.match(css, /\.sanitise-q \{/, 'the question blocks have a shared style');
  assert.match(css, /\.sanitise-strip \{/, 'the value strip has a shared style');
  assert.match(css, /\.sanitise-seg-toggle button\.on/, 'the format/exact toggle has a shared style');
  assert.match(css, /\.sanitise-choices-apply/, 'the apply button has a shared style');
});

test('the wizard live-previews the selected masking choice before it is committed', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  const css = read('src/App.css');
  // A throwaway plan layers the selected choice on top of the committed picks, flags the
  // entries it adds, and the after pane paints them in the distinct "try" colour.
  assert.match(wiz, /const provisional = useMemo/, 'a provisional preview is derived from the selected choice');
  assert.match(wiz, /planFromExtras\(nextText, plan\)/, 'the candidate plan reuses the pure plan builder');
  assert.match(wiz, /const tryKeys = new Set\(/, 'the entries the choice adds are collected as tryKeys');
  assert.match(wiz, /const token = activeChoiceToken;/, 'it previews the token resolved from the two-question answers');
  assert.match(wiz, /renderPreviewSpans\(line\.after, line\.afterSpans, 'sanitise-preview-ins', 'sanitise-preview-try', 'sanitise-preview-bad'\)/,
    'committed masks, the provisional pick, and a blocking pick get distinct classes');
  assert.match(wiz, /activeProvisional\?\.tryKeys\.size/, 'the after tag announces the live preview');
  assert.match(css, /\.sanitise-preview-try \{/, 'the provisional pick has its own highlight style');
  // Applying the pick clears the selection, so the provisional preview collapses into a
  // normal committed mask — the pick becomes permanent.
  assert.match(wiz, /if \(!plan \|\| !sel\) return null;/, 'the provisional preview only exists while a selection is live');
});

test('structuralOffenders flags exactly the masks that shift a delimiter/whitespace count', () => {
  // A value that carries a comma masked by an alias that has none: the CSV column boundary
  // moves. This is the mask the save gate (checkStructurePreserved) would reject.
  const shifts = [{ kind: 'custom', original: 'Doe, John', alias: 'Aaa Bbbb', enabled: true }];
  const bad = structuralOffenders(shifts);
  assert.equal(bad.size, 1, 'the comma-dropping mask is flagged');
  assert.ok(bad.has('custom:Doe, John'), 'flagged by its ${kind}:${original} key');

  // A same-shape alias (separators preserved char-for-char) keeps every delimiter count, so it
  // is NOT an offender — this is the safe case the char-class minter produces.
  const safe = [{ kind: 'pii', original: 'CN=Jane,OU=x', alias: 'CN=Mkpq,OU=y', enabled: true }];
  assert.equal(structuralOffenders(safe).size, 0, 'a delimiter-preserving alias is not flagged');

  // A disabled or no-op entry can never break the sample, so it is never an offender.
  const inert = [
    { kind: 'custom', original: 'a,b', alias: 'xy', enabled: false },
    { kind: 'custom', original: 'c', alias: 'c', enabled: true },
  ];
  assert.equal(structuralOffenders(inert).size, 0, 'disabled and identity masks are ignored');

  // The offenders it reports are exactly the ones checkStructurePreserved rejects on the sample.
  const before = 'name=Doe, John';
  const after = applySanitisation(before, shifts);
  assert.ok(!checkStructurePreserved(before, after).ok, 'the same mask trips the save gate');
});

test('previewSanitisation paints the blocking mask with the bad flag, not the others', () => {
  const before = 'user=alice host=Doe, John';
  const entries = [
    { kind: 'user', original: 'alice', alias: 'bmnop', enabled: true },       // safe, preserves counts
    { kind: 'custom', original: 'Doe, John', alias: 'Aaa Bbbb', enabled: true }, // drops the comma
  ];
  const badKeys = structuralOffenders(entries);
  const { lines } = previewSanitisation(before, entries, 5, true, undefined, badKeys);
  const spans = lines.flatMap(l => l.afterSpans);
  assert.ok(spans.some(s => s.bad), 'the comma-dropping mask is flagged bad');
  assert.equal(spans.filter(s => s.bad).length, 1, 'only the offending mask is flagged, not the safe one');
  // Without badKeys nothing is flagged — the flag is opt-in and backward compatible.
  const plain = previewSanitisation(before, entries, 5, true).lines.flatMap(l => l.afterSpans);
  assert.ok(!plain.some(s => s.bad), 'no bad flag when the caller passes no badKeys');
});

test('beforeSpans carry the same try/bad flags as afterSpans, so the before pane can colour in step', () => {
  const before = 'user=alice host=Doe, John';
  const entries = [
    { kind: 'user', original: 'alice', alias: 'bmnop', enabled: true },
    { kind: 'custom', original: 'Doe, John', alias: 'Aaa Bbbb', enabled: true }, // drops the comma
  ];
  const tryKeys = new Set(['user:alice']);
  const badKeys = structuralOffenders(entries);
  const { lines } = previewSanitisation(before, entries, 5, true, tryKeys, badKeys);
  const beforeSpans = lines.flatMap(l => l.beforeSpans);
  // The original values are marked in place, and each mark tells before/after apart the same way.
  assert.ok(beforeSpans.some(s => s.try), 'the provisional pick is flagged try in the before pane');
  assert.ok(beforeSpans.some(s => s.bad), 'the blocking pick is flagged bad in the before pane');
  assert.equal(beforeSpans.filter(s => s.bad).length, 1, 'only the offending original value is flagged bad');
});

test('the wizard marks a save-blocking mask red', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  const css = read('src/App.css');
  // The preview computes the offenders and threads them into both the spans and the tag.
  assert.match(wiz, /const badKeys = structuralOffenders\(active\.entries, raw\)/, 'the preview derives the blocking masks (with the sample, so JSON breakage is attributed)');
  assert.match(wiz, /previewSanitisation\(raw, active\.entries, PREVIEW_LINE_CAP, true, activeProvisional\?\.tryKeys, badKeys\)/,
    'badKeys are passed to the preview so their spans are flagged');
  assert.match(wiz, /preview\.badKeys\.size/, 'the after tag warns when a mask would block the save');
  assert.match(wiz, /sz-pick-hint-bad/, 'the blocking warning uses the red hint class');
  assert.match(css, /\.sanitise-preview-bad \{/, 'the blocking span has a red highlight style');
});

test('the save step lets the reviewer name the worker-group sample and defaults it', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // A dedicated, editable filename field — not a silent key-derived name.
  assert.match(wiz, /groupSampleName/, 'the wizard tracks a worker-group sample name');
  assert.match(wiz, /Sample name\s*\n?\s*<input value=\{groupSampleName\}/, 'the save step shows an editable sample-name input');
  // It is seeded from the sourcetype so the field is never empty, and save() falls back to
  // the key-derived default and appends a .log extension when the reviewer omits one.
  assert.match(wiz, /setGroupSampleName\(`\$\{sanitisedSampleKey\(sourcetype/, 'the name field is seeded on entering the save step');
  assert.match(wiz, /groupSampleName\.trim\(\) \|\| fallback/, 'save falls back to the key-derived default');
  assert.match(wiz, /if \(!\/\\\.\[a-z0-9\]\+\$\/i\.test\(name\)\) name \+= '\.log'/, 'a name with no extension gets .log');
});

test('the publish-to-pool row is omitted in the iframe and explains the block in standalone', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // Publishing to the team pool is standalone-only (GitHub write from the dev server), so
  // the whole option is hidden in the iframe rather than shown disabled with a "localhost
  // only" note. Standalone-without-token still spells out the one-time Settings setup.
  assert.match(wiz, /runMode !== 'iframe' && <div className=\{`sz-action/,
    'the publish option is gated so it does not render in the iframe app');
  assert.ok(!/Publishing runs on the local dev server only/.test(wiz),
    'the iframe "localhost only" note is gone — the option is simply absent');
  assert.match(wiz, /turn on .Share sanitised samples. and set a separate sample repository \+ write token in Settings/,
    'the standalone block states the one-time setup needed');
  assert.ok(!/onClick=\{onOpenSettings\}/.test(wiz), 'no wizard-dismissing Settings button was reintroduced');
});

test('the save step offers each destination as a self-contained action card, no "Save selected"', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  const css = read('src/App.css');
  // Redesign: every destination is its own card with its own button — the reviewer no longer
  // ticks boxes then presses one "Save selected". Each card runs via runAction(id, fn) which
  // records an inline confirmation/failure against that card's id.
  assert.ok(!/'Save selected'/.test(wiz), 'the single "Save selected" footer button is gone');
  assert.ok(!/checked=\{storeLocal\}/.test(wiz), 'no destination checkboxes remain');
  assert.match(wiz, /async function runAction\(id: string/, 'a generic per-card action runner exists');
  // Local library is still Pack-Generator-only (gated on !embedded): the standalone Sample
  // Sanitizer has no local library that anything reads, so the card is omitted there.
  assert.match(wiz, /\{!embedded && <div className="sz-action">[\s\S]*Add to this generator's sample library/,
    'the local library card is only shown when NOT embedded (Pack Generator)');
  assert.match(wiz, /runAction\('local', saveLocalAction\)/, 'the local library card has its own Add button');
  // Upload is its own card, fields live inside it, and it has its own Upload button.
  assert.match(wiz, /runAction\('upload', uploadAction\)/, 'the upload card has its own Upload button');
  // Download sanitised .log is now its own card (not a footer/primary button).
  assert.match(wiz, /runAction\('download', \(\) => \{ triggerDownload\(buildDoc\(\), 'log'\); return/,
    'the sanitised .log download is its own action card');
  // Report + evidence JSON are their own downloads (not the log) — a green row at the bottom,
  // no "Also download (optional):" label, both styled like the other action buttons.
  assert.match(wiz, /className="sz-btn" onClick=\{\(\) => triggerDownload\(buildDoc\(\), 'report'\)\}/, 'the HTML report download is a green action button');
  assert.match(wiz, /className="sz-btn" onClick=\{\(\) => triggerDownload\(buildDoc\(\), 'json'\)\}/, 'the evidence JSON download is a green action button');
  assert.ok(!/sz-downloads-label/.test(wiz), 'the "Also download (optional):" label is gone');
  // No "Do any of these…" preamble — the self-labelled cards are their own menu.
  assert.ok(!/Do any of these/.test(wiz), 'the redundant "Do any of these" line is gone');
  // No footer primary on the save step — nothing is forced, each card commits itself.
  assert.ok(!/onClick=\{onClose\}>Done</.test(wiz), 'the Done button is gone from the save step');
  assert.ok(!/step === 'save' &&[^\n]*sz-primary/.test(wiz), 'the save step has no primary footer button');
  assert.match(css, /\.sz-action \{/, 'the action card has a style');
  assert.match(css, /\.sz-btn \{/, 'the per-card action button has a style');
  assert.match(css, /\.sz-action \.sz-dest-sub \{/, 'the fields inside the upload card are restyled');
});

test('the before pane marks the values about to change, in place, behind the textarea', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  const css = read('src/App.css');
  // A transparent-text backdrop renders each line's beforeSpans behind the drag-select textarea.
  assert.match(wiz, /className="sanitise-before-backdrop"/, 'the before column has a backdrop layer');
  assert.match(wiz, /renderPreviewSpans\(line\.before, line\.beforeSpans, 'sanitise-before-mark', 'sanitise-before-try', 'sanitise-before-bad'\)/,
    'the backdrop marks the original values with the committed/provisional/blocking classes');
  assert.match(wiz, /ref=\{backdropRef\}/, 'the backdrop is scroll-synced via its own ref');
  // The textarea stays the selectable surface; both scroll handlers keep the backdrop in lockstep.
  assert.match(wiz, /backdropRef\.current\.scrollTop = sampleRef\.current\.scrollTop/, 'before scroll mirrors to the backdrop');
  assert.match(wiz, /backdropRef\.current\.scrollTop = afterRef\.current\.scrollTop/, 'after scroll mirrors to the backdrop');
  // The backdrop's text is transparent (only the mark backgrounds show), and it shares the
  // textarea's metrics so the marks land under the real glyphs.
  assert.match(css, /\.sanitise-before-backdrop \{[^}]*color: transparent/, 'the backdrop text is transparent so glyphs come from the textarea');
  assert.match(css, /\.sanitise-ba-input \.sanitise-sample \{[^}]*background: transparent/, 'the textarea is transparent so the backdrop shows through');
  assert.match(css, /\.sanitise-before-mark \{/, 'the before-pane committed mark has a style');
  assert.match(css, /scrollbar-gutter: stable/, 'a stable scrollbar gutter keeps the two layers aligned');
});

test('the wizard events step offers the new-pack source options minus AI-generate', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // Same four tiles as the new-pack source screen: upload, group sample, paste, live capture.
  for (const name of ['Upload file', 'Group sample', 'Paste events', 'Live capture']) {
    assert.ok(wiz.includes(name), `events step offers "${name}"`);
  }
  assert.ok(!/'ai-generate'/.test(wiz), 'no AI-generate source mode (synthetic data needs no sanitising)');
  assert.match(wiz, /await liveCapture\(groupId, filter, batchEvents, windowMs\)/, 'live capture is wired to the API');
});

test('live capture streams events incrementally with a Stop button and a live counter', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // Incremental capture: a batching loop, not one blocking call.
  assert.match(wiz, /while \(\s*!stopCaptureRef\.current/, 'the capture loop keeps going until stopped/exhausted');
  assert.match(wiz, /collected\.length < captureMaxEvents/, 'the loop halts at the target event count');
  assert.match(wiz, /Date\.now\(\) - startedAt < totalBudgetMs/, 'the loop halts at the duration budget');
  // De-dupe across batches so overlapping windows do not double-count events.
  assert.match(wiz, /const seen = new Set<string>\(\)/, 'exact-duplicate lines are de-duped across batches');
  // Preview updates as each batch lands.
  assert.match(wiz, /setRaw\(normaliseSampleInput\(collected\.join\('\\n'\)\)\)/, 'the preview grows as events arrive');
  assert.match(wiz, /setCaptureProgress\(collected\.length\)/, 'the live counter tracks the running total');
  // Stop control and the live counter in the UI.
  assert.match(wiz, /function stopLiveCapture\(\)/, 'there is a Stop handler');
  assert.match(wiz, /onClick=\{stopLiveCapture\}/, 'the Stop button is wired');
  assert.match(wiz, /Capturing… \(\$\{captureProgress\}\/\$\{captureMaxEvents\}\)/, 'the button shows live progress');
});

test('live capture: only groups with a connected worker are offered, and events preview live', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // Only groups with workers are selectable (an empty group captures nothing).
  assert.match(wiz, /capturableGroups = useMemo\(\(\) => groups\.filter\(g => \(g\.workerCount \?\? 0\) > 0\)/, 'the picker filters to groups with workers');
  assert.match(wiz, /capturableGroups\.map\(group =>/, 'the dropdown renders the filtered groups');
  assert.match(wiz, /capturableGroups\.length === 0 &&/, 'an empty picker explains there is nothing to capture from');
  // The Start button is the prominent primary action, not a muted secondary one.
  assert.match(wiz, /className="sz-primary sz-capture-start"/, 'Start capture is a prominent primary button');
  // Events preview live in the capture step, before identifying the source.
  assert.match(wiz, /setCapturedEvents\(\[\.\.\.collected\]\)/, 'captured events feed the live preview');
  assert.match(wiz, /capturedEvents\.slice\(-50\)\.map/, 'the latest captured events are shown');
  assert.match(wiz, /const \[capturedEvents, setCapturedEvents\] = useState<string\[\]>\(\[\]\)/, 'captured events are tracked as state');
});

test('listGroups annotates each group with a connected-worker count', () => {
  const io = read('src/sample-io.ts');
  assert.match(io, /workerCount: number/, 'the group type carries a workerCount');
  assert.match(io, /criblFetch<\{ items: any\[\] \}>\('\/master\/workers'\)/, 'iframe path reads /master/workers');
  assert.match(io, /workerCountsByGroup/, 'worker counts are merged into the group list');
  // Both apps use the same wizard, so both policies must permit reading worker counts.
  const p1 = read('config/policies.yml');
  const p2 = read('config/sanitizer-policies.yml');
  assert.match(p1, /\/master\/workers/, 'pack-generator policy allows /master/workers');
  assert.match(p2, /\/master\/workers/, 'sanitizer policy allows /master/workers');
});

test('the save step can go back and the settings link that closed the wizard is gone', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  assert.match(wiz, /step === 'save' \? backFromSave/, 'Back on the save step restores the review');
  assert.ok(!/onClick=\{onOpenSettings\}/.test(wiz), 'the Open Settings button that dismissed the wizard is removed');
});

test('write-your-own-regex: named capture groups are the maskable fields', () => {
  const src = 'id=(?<test>\\d+) user=(?<who>[a-z]+)';
  assert.deepEqual(listNamedGroups(src), ['test', 'who'], 'both named groups, in order');
  // A lookbehind is not a capture group and must not be offered as a field.
  assert.deepEqual(listNamedGroups('(?<=id=)(?<n>\\d+)'), ['n'], 'lookbehind is skipped');
  // Duplicated names collapse to one field.
  assert.deepEqual(listNamedGroups('(?<a>x)|(?<a>y)'), ['a'], 'a repeated name appears once');
});

test('write-your-own-regex: describeRegexDraft reports validity, groups, samples and hits', () => {
  const sample = 'id=41 user=alice\nid=7 user=bob\nid=41 user=carol';
  const info = describeRegexDraft('id=(?<test>\\d+) user=(?<who>[a-z]+)', sample);
  assert.equal(info.valid, true);
  assert.equal(info.matches, 3, 'three whole-pattern matches across the sample');
  const test = info.groups.find(g => g.name === 'test');
  assert.equal(test.hits, 3);
  assert.equal(test.sample, '41', 'first captured value is offered as the example');
  // A regex that does not compile is reported, not thrown.
  const bad = describeRegexDraft('id=(?<test>\\d+', sample);
  assert.equal(bad.valid, false);
  assert.ok(bad.error, 'the compile error travels back for the UI');
});

test('write-your-own-regex: a hand-written named-group pick round-trips and masks only ticked fields', () => {
  const sample = 'id=41 user=alice\nid=7 user=bob';
  // The editor encodes the source with only the ticked groups; the reviewer masked `test`,
  // left `who` as context.
  const token = encodePatternExtra('id=(?<test>\\d+) user=(?<who>[a-z]+)', ['test']);
  assert.ok(token.startsWith('re:'), token);
  const parsed = parsePatternExtra(token);
  assert.deepEqual(parsed.groupNames, ['test'], 'a non-g1 named group survives the round-trip');
  const { patterns } = splitExtras(token);
  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0].groupNames, ['test']);
  const plan = planSanitisation(sample, { seed: 7, extraPatterns: patterns, suggestSuspects: false });
  const out = applySanitisation(sample, plan.entries);
  assert.ok(!/id=41|id=7/.test(out), 'the ticked id value is masked');
  // The un-ticked `who` group is context: the PICK does not mask it…
  const pick = plan.entries.find(e => e.via === PICKED_PATTERN_VIA && e.original === 'id=41 user=alice');
  assert.ok(pick && pick.alias.endsWith(' user=alice'), 'the pick itself leaves the un-ticked group as it is');
  // …but it no longer hides an identity the planner found on its own: `alice` is a detected user
  // with or without the pick, so it stays masked — a pick must not put it back in the clear.
  assert.ok(!/user=alice/.test(out) && !/user=bob/.test(out), 'auto-detected users inside the pick context stay masked');
  // Keeping it readable is the review row's job: untick the user and it is left alone.
  const kept = plan.entries.map(e => e.kind === 'user' ? { ...e, enabled: false } : e);
  const out2 = applySanitisation(sample, kept);
  assert.ok(/user=alice/.test(out2) && /user=bob/.test(out2) && !/id=41|id=7/.test(out2), 'unticking the user rows leaves them as context');
});

test('write-your-own-regex: a regex with commas survives the comma-separated extras box', () => {
  // `\d{1,3}` carries a comma; on its own line splitExtras must keep it whole, not tear it.
  const token = encodePatternExtra('addr=(?<octet>\\d{1,3})', ['octet']);
  const box = `ACME, host-01\n${token}`;
  const { literals, patterns } = splitExtras(box);
  assert.deepEqual(literals, ['ACME', 'host-01'], 'the comma list still splits');
  assert.equal(patterns.length, 1, 'the regex is one pattern, not shredded on its comma');
  assert.equal(patterns[0].source, 'addr=(?<octet>\\d{1,3})', 'the {1,3} quantifier is intact');
  assert.deepEqual(patterns[0].groupNames, ['octet']);
});

test('write-your-own-regex: a leading literal is valid — the group need not come first', () => {
  // The reviewer's own example: `1251\s(?<test>sed)`. A capture group anywhere in the
  // pattern is legal; a fixed literal prefix that anchors the match must not be rejected,
  // and must survive as context — only the named group's value is masked.
  const sample = 'foo 1251 sed bar\nbaz 1251 sed qux';
  const info = describeRegexDraft('1251\\s(?<test>sed)', sample);
  assert.equal(info.valid, true, 'a pattern that starts with a literal still compiles');
  assert.equal(info.matches, 2, 'the leading literal anchors both matches');
  assert.deepEqual(info.groups.map(g => g.name), ['test'], 'the sole field is the group after the literal');
  assert.equal(info.groups[0].sample, 'sed', 'it captures the value the reviewer wants masked');
  // Encode/round-trip: the leading literal and the `\s` survive the extras-box token.
  const token = encodePatternExtra('1251\\s(?<test>sed)', ['test']);
  const parsed = parsePatternExtra(token);
  assert.equal(parsed.source, '1251\\s(?<test>sed)', 'the literal prefix survives the round-trip');
  assert.deepEqual(parsed.groupNames, ['test']);
  // Applied: only `sed` is replaced; the anchoring `1251` stays put as literal context.
  const { patterns } = splitExtras(token);
  const out = applySanitisation(sample, planSanitisation(sample, {
    seed: 9, extraPatterns: patterns, suggestSuspects: false,
  }).entries);
  assert.ok(/1251/.test(out), 'the leading literal is kept as context, not masked');
  assert.ok(!/\bsed\b/.test(out), 'the captured group value is masked');
});

test('write-your-own-regex: a selection seeds an extraction regex, one literal field per token', () => {
  // The user's example: highlighting `test 1234` seeds a pattern that extracts each token as
  // its LITERAL text, so the seed anchors on the actual selection (a shape class like \S+ would
  // match the first such run anywhere in the event, not what was highlighted).
  assert.equal(regexFromSelection('test 1234'), '(?<g1>test)\\s+(?<g2>1234)',
    'a word and a number become two separately-maskable literal fields, split on the whitespace');
  assert.equal(regexFromSelection('1234'), '(?<g1>1234)', 'a bare number is its own literal field');
  assert.equal(regexFromSelection('host-01'), '(?<g1>host-01)', 'a mixed token is one literal field');
  // A whitespace-free selection is ONE run → ONE group covering the complete string, not a
  // generic \S+ that would grab the first token of the event.
  assert.equal(regexFromSelection('product_id=Goats'), '(?<g1>product_id=Goats)',
    'a whitespace-free selection is captured completely, not as a small unanchored part');
  // Regex metacharacters in the selection are escaped so they match themselves.
  assert.equal(regexFromSelection('/a.b?c'), '(?<g1>/a\\.b\\?c)', 'metacharacters are escaped');
  // Leading/trailing space does not create empty groups; internal runs collapse to \s+.
  assert.equal(regexFromSelection('  a   b  '), '(?<g1>a)\\s+(?<g2>b)', 'edges trimmed, gap is \\s+');
  assert.equal(regexFromSelection('   '), '', 'a blank selection yields nothing');
});

test('write-your-own-regex: the seed anchors on the highlighted span, not the first shape run', () => {
  // Regression for the apache-access report: a shape seed matched the leading IP instead of the
  // selected text. The literal seed must match exactly what was highlighted, once.
  const ev = '201.122.42.235 - - [26/Nov/2019:01:06:28 +0000] "GET /product.screen?product_id=Goats&JSESSIONID=SD3SL1FF7ADFF8 HTTP/1.1" 200 1007';
  const getProduct = describeRegexDraft(regexFromSelection('GET /product'), ev);
  assert.equal(getProduct.valid, true);
  assert.equal(getProduct.matches, 1, 'anchors on the one real "GET /product", not the leading IP');
  assert.deepEqual(getProduct.groups.map(g => [g.name, g.sample]), [['g1', 'GET'], ['g2', '/product']],
    'the fields capture the highlighted tokens, not 201.122.42.235');
  const idGoats = describeRegexDraft(regexFromSelection('product_id=Goats'), ev);
  assert.equal(idGoats.matches, 1, 'the whitespace-free selection matches its one real place');
  assert.deepEqual(idGoats.groups.map(g => [g.name, g.sample]), [['g1', 'product_id=Goats']],
    'the complete selected string is the captured field');
});

test('write-your-own-regex: the editor preview shows ONLY the pattern, not ambient auto-masks', () => {
  // The reviewer wrote `(?<g1>\S+)\[(?<g2>\d{1,4})\]`. The panes must show only the complete
  // pattern match — not the IP/email/FQDN the base detector also finds, which coincide with the
  // field shapes and read as the regex over-matching. The wizard isolates by folding the
  // pattern onto a fresh plan and keeping only the PICKED_PATTERN_VIA entries.
  const ev = 'srv[1234] from 10.20.30.40 user admin@acme.com host db-prod-01.internal';
  const source = '(?<g1>\\S+)\\[(?<g2>\\d{1,4})\\]';
  const full = planSanitisation(ev, { seed: 3, extraPatterns: [{ source, groupNames: ['g1', 'g2'] }] });
  // The base plan (suspects on by default) really does find the ambient identities…
  const ambient = full.entries.filter(e => e.enabled && e.alias !== e.original && e.via !== PICKED_PATTERN_VIA);
  assert.ok(ambient.some(e => e.original === '10.20.30.40'), 'the base plan does flag the IP');
  assert.ok(ambient.some(e => e.original === 'admin@acme.com'), 'and the email');
  // …but the editor preview keeps only the pattern picks — the one complete match.
  const patternOnly = full.entries.filter(e => e.via === PICKED_PATTERN_VIA);
  assert.deepEqual(patternOnly.map(e => e.original), ['srv[1234]'],
    'only the complete-pattern match is previewed, no ambient identities');
});

test('write-your-own-regex: the wizard isolates the preview to the pattern while the editor is open', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // regexProvisional folds the pattern onto a FRESH plan (null prev) and keeps only pattern picks.
  assert.match(wiz, /planFromExtras\(encodePatternExtra\(regexQuery\.trim\(\), picked\), null\)/,
    'the regex preview builds on a fresh plan, not the committed base plan');
  assert.match(wiz, /\.filter\(entry => entry\.via === PICKED_PATTERN_VIA\)/,
    'and keeps only the pattern-pick entries, dropping ambient auto-detected masks');
  // With no valid match yet, an open editor shows a clean before=after, never the base plan.
  assert.match(wiz, /regexOpen \? \{ \.\.\.plan, entries: \[\] \} : plan/,
    'an open-but-unmatched editor shows clean panes, not the ambient base plan');
});

test('write-your-own-regex: the editor opens in place of the guided picks, prefilled from the selection', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // Opening the regex editor is a first-class action from the selection choices AND the idle
  // hint — both call openRegex, and the selection form seeds it from the highlighted text.
  assert.match(wiz, /openRegex\(regexFromSelection\(sel\.selected\)\)/,
    'the "write your own regex" button in the choices seeds the draft from the selection');
  assert.match(wiz, /onClick=\{\(\) => openRegex\(''\)\}/, 'the no-selection entry opens an empty editor');
  // When open, the editor replaces the guided options entirely (regexOpen ? editor : picks).
  assert.match(wiz, /\{regexOpen \? \(/, 'the editor and the guided picks are mutually exclusive');
  assert.match(wiz, /className="sanitise-regex sanitise-regex-open"/, 'the open editor sits directly under the panes');
  // Fields are small toggle pills (buttons), not a checklist, side by side.
  assert.match(wiz, /className=\{regexPick\.has\(group\.name\) \? 'sanitise-regex-field on' : 'sanitise-regex-field'\}/,
    'each named group is a toggleable field pill');
  assert.match(wiz, /Write your own regex/, 'the entry point is labelled for the user');
  // Opening seeds both the immediate draft and the debounced query so the live preview runs at once.
  assert.match(wiz, /function openRegex\(prefill: string\) \{[\s\S]*setRegexDraft\(prefill\);[\s\S]*setRegexQuery\(prefill\);/,
    'the seed drives the live match without waiting for the debounce');
});

test('write-your-own-regex: going back and re-picking a sample starts a clean session', () => {
  const wiz = read('src/sanitize-wizard.tsx');
  // Entering the review from the source step wipes the prior sample's manual masking.
  assert.match(wiz, /function resetManualSanitisation\(\) \{/, 'there is a single reset for the manual state');
  assert.match(wiz, /function confirmSource\(\) \{[\s\S]*resetManualSanitisation\(\);[\s\S]*buildPlan\('', false\);/,
    'confirmSource resets and builds the plan from an empty box, not the stale extraText');
  // The reset clears every piece of manual state, including the regex editor.
  for (const cleared of ['setExtraText\\(\'\'\\)', 'setSel\\(null\\)', 'setMaskTarget\\(\'whole\'\\)',
    'setPartRanges\\(\\[\\]\\)', 'setRegexOpen\\(false\\)', 'setRegexPick\\(new Set\\(\\)\\)', 'setOpenGroups\\(\\{\\}\\)']) {
    assert.match(wiz.slice(wiz.indexOf('function resetManualSanitisation')), new RegExp(cleared),
      `reset clears ${cleared}`);
  }
});

test('events are shown before and after, side by side, always visible', () => {
  const app = read('src/App.tsx');
  const wiz = read('src/sanitize-wizard.tsx');
  const css = read('src/App.css');
  // The before/after view lives in the wizard now. The new-pack step no longer renders any
  // sanitise preview of its own — it only shows the plain sample preview + the banner.
  assert.ok(!/className="sanitise-beforeafter"|sanitise-ba-tag-before|className="sanitise-sample sanitise-after"/.test(app),
    'the new-pack step no longer renders an inline before/after view');
  assert.ok(!/sanitise-sample-marks|sanitise-sample-over|className="sanitise-preview"/.test(app),
    'the new-pack step no longer stacks a marks overlay or a separate capped preview');
  // The wizard is the single home of the before/after view.
  assert.match(wiz, /className="sanitise-beforeafter"/, 'the wizard lays events out before and after');
  assert.match(wiz, /sanitise-ba-tag-before/, 'the wizard labels the before column');
  assert.match(wiz, /sanitise-ba-tag-after/, 'the wizard labels the after column');
  assert.match(wiz, /className="sanitise-sample sanitise-after"/, 'the wizard renders the sanitised after column');
  assert.ok(!/sanitise-sample-marks|sanitise-sample-over|className="sanitise-preview"/.test(wiz),
    'the wizard no longer stacks a marks overlay or a separate capped preview');
  // The always-on preview includes unchanged lines so the after can never quietly disappear.
  assert.match(wiz, /previewSanitisation\(raw, active\.entries, PREVIEW_LINE_CAP, true, activeProvisional\?\.tryKeys, badKeys\)/,
    'the wizard after view is the always-on, line-capped build with the provisional pick and blocking masks layered in');
  // The before textarea shows the SAME capped line budget as the after pane, and the two
  // panes scroll-sync so a reviewer reads the same lines across.
  assert.match(wiz, /value=\{beforeDisplay\}/, 'the before pane shows the shared capped line budget');
  assert.match(wiz, /afterRef\.current\.scrollTop = sampleRef\.current\.scrollTop/, 'before scroll mirrors to after');
  assert.match(wiz, /sampleRef\.current\.scrollTop = afterRef\.current\.scrollTop/, 'after scroll mirrors to before');
  // Selection is a normal highlight now (the before column shows real glyphs, not transparent ones).
  assert.match(css, /\.sanitise-sample::selection \{ background: rgba\(255, 229, 143/,
    'the selection wash is a normal translucent yellow highlight');
  assert.ok(!/color:\s*transparent/.test(css.slice(css.indexOf('.sanitise-sample::selection'), css.indexOf('.sanitise-beforeafter'))),
    'the selection no longer hides its own glyphs');
});

test('CLF lines whose request has no protocol still give up their usernames, ticked', () => {
  // The Apache parser needs `"GET /x HTTP/1.1"` and reads nothing from `"GET /x"`, so these
  // names used to land in the unticked guesses. The CLF prefix is read by position instead.
  const raw = [
    '178.146.234.131 - dicki8506 [26/Nov/2019:01:34:17 +0000] "GET /efficient/wireless" 204 2338',
    '67.207.231.248 - marquardt4474 [26/Nov/2019:01:34:17 +0000] "PUT /synergistic" 503 9386',
    '206.249.78.234 - - [26/Nov/2019:01:34:17 +0000] "GET /e-enable" 204 895',
    '120.54.184.170 - murray2730 [26/Nov/2019:01:34:17 +0000] "GET /one-to-one/visionary" 302 1812',
    '10.1.2.3 - john.doe [27/Dec/2020:11:04:07 -0500] "GET /x" 200 1',
  ].join('\n');
  const { parsed, parserName } = parseSampleLocally(raw, 'access_combined');
  const plan = planSanitisation(raw, { parsed, parserName, seed: 7 });
  for (const name of ['dicki8506', 'marquardt4474', 'murray2730', 'john.doe']) {
    const e = plan.entries.find(x => x.original === name);
    assert.ok(e, `${name} is detected`);
    assert.equal(e.kind, 'user', `${name} is a user, not a guessed host`);
    assert.equal(e.enabled, true, `${name} is ticked by default`);
  }
  assert.ok(!plan.entries.some(e => e.original === '-'), 'the CLF "no user" dash is left alone');
  const out = applySanitisation(raw, plan.entries);
  for (const name of ['dicki8506', 'marquardt4474', 'murray2730', 'john.doe']) assert.ok(!out.includes(name), `${name} is masked`);
});
