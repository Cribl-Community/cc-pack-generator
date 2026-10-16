import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  resolveAliasChainToParser,
  buildGoldenFormatMapping,
} from '../src/pack-builder.ts';
import { getParserFieldNames, sourceMayEmitNativeFalsy } from '../src/source-recognition.ts';

// ---------------------------------------------------------------------------
// The claim under test (Rule 12 debuggability cleanup, no behaviour change):
// collapsing a golden spec's portable alias chain (`src_ip = a || b || c`) down
// to the operand(s) THIS sourcetype's parser can actually emit is byte-identical
// at runtime, because `||` already short-circuits to that same field and every
// dropped operand is one the parser can NEVER produce.
//
// We prove it two ways:
//   1. Resolver invariants — pure-chain-only, order-preserving, declared-only,
//      never-empty, transform-safe.
//   2. Corpus equivalence — for every golden-path sourcetype × format we build
//      the mapping twice (resolveAliases on/off) and, for every eval `add` whose
//      value the resolver changed, evaluate BOTH expressions over a battery of
//      random events. The load-bearing invariant of the events: a field the
//      parser does not declare is ALWAYS undefined (it is never produced). Under
//      that constraint the two expressions must agree on every event.
// ---------------------------------------------------------------------------

const GOLDEN_SOURCETYPES = [
  'cisco_asa', 'linux_audit', 'cisco_esa', 'sap_hana', 'fortinet_fortigate',
  'f5_bigip', 'sap_audit', 'salesforce_setupaudittrail', 'aws_cloudtrail',
  'gcp_audit', 'crowdstrike_falcon', 'palo_alto_traffic', 'palo_alto_threat',
  'corelight_conn', 'zeek_conn', 'vsphere', 'suricata_ids', 'corelight_dns',
  'corelight_http', 'corelight_ssl', 'corelight_kerberos', 'corelight_ldap',
  'corelight_ntp', 'corelight_notice', 'corelight_weird', 'corelight_snmp',
  'corelight_smtp_links', 'corelight_software', 'zscaler_web', 'windows_security',
  'windows_sysmon', 'windows_dns_client', 'windows_defender', 'windows_system',
  'windows_application', 'windows_powershell', 'linux_syslog', 'checkpoint_firewall',
  'apache_access', 'nginx_access', 'infoblox_dns', 'aws_vpc_v5', 'aws_vpc_v2',
];

const FORMATS = ['ocsf', 'cim', 'cef', 'ecs', 'asim', 'chronicle', 'commonsecuritylog', 'json'];

// Deterministic PRNG so a failure is reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// Representative present-values a source field might carry. A regex-extracted
// (`unstructured`) source produces ONLY strings — even a captured "0" is the
// truthy string '0', never the number 0 — so its value domain excludes native
// falsy (numeric 0 / boolean false). A JSON (or possibly-coercing kvp/cef) source
// CAN carry those, so its pool includes the adversarial numeric-0/false cases
// that make a dropped `|| undefined` tail observable. `sourceMayEmitNativeFalsy`
// is the SAME classifier the builder uses to decide whether to keep the tail, so
// the proof's value domain is exactly the domain the builder relied on.
const VALUE_POOL_STR = ['10.0.0.1', '443', 'tcp', 'alice', 'ALLOW', '1737021600', '2048', 'GET', 'x', '0'];
const VALUE_POOL_FALSY = [...VALUE_POOL_STR, 3, 0, false, ''];

const THREW = Symbol('threw');

// JS globals a jsExpression may legitimately reference — these must fall through
// `with` to the real global, NOT be captured as (absent → undefined) event fields.
const FALLTHROUGH = new Set([
  'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'RegExp', 'Array', 'Object', 'encodeURIComponent',
  'decodeURIComponent', 'NaN', 'Infinity', 'undefined', 'C',
]);

// Evaluate one Cribl jsExpression against an event object with Cribl's field
// semantics: a read of ANY field name that is not present returns `undefined`
// (NOT a ReferenceError — plain `with(obj)` gets this wrong for missing keys, so
// we back it with a Proxy that owns every non-global identifier). This is what
// makes a dropped, never-produced operand evaluate to `undefined`, exactly as at
// runtime — the crux of the byte-identical proof.
function evalInScope(expr, event) {
  const scope = new Proxy(event, {
    has: (_t, k) => (typeof k === 'symbol' ? true : !FALLTHROUGH.has(k)),
    get: (t, k) => t[k],
  });
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('$e', `with ($e) { return (${expr}); }`);
    return fn(scope);
  } catch {
    return THREW;
  }
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

// Simulate the eval `add` steps of a built golden mapping, in order. Cribl treats
// an `add` whose value is `undefined` as "leave the field unchanged" → skip.
function runEvals(functions, inputEvent) {
  const ev = structuredClone(inputEvent);
  for (const f of functions || []) {
    if (f?.id !== 'eval' || !Array.isArray(f?.conf?.add)) continue;
    for (const a of f.conf.add) {
      if (!a || typeof a.value !== 'string') continue;
      const r = evalInScope(a.value, ev);
      if (r === undefined) continue; // Cribl: undefined leaves the field unchanged
      if (r === THREW) { setPath(ev, a.name, '<<threw>>'); continue; } // record consistently
      setPath(ev, a.name, r);
    }
  }
  // Strip internal collision-snapshot temps — they are stripped by the keep-list
  // before output and are exactly where the (output-neutral) resolver plumbing
  // differs; comparing the real output fields is the byte-identical proof.
  for (const k of Object.keys(ev)) if (k.startsWith('gfsrc_tmp_')) delete ev[k];
  return ev;
}

function stableEqual(a, b) {
  const norm = (v) => JSON.stringify(v, (_k, val) => (typeof val === 'number' && Number.isNaN(val) ? '<<NaN>>' : val));
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// 1. Resolver invariants
// ---------------------------------------------------------------------------

test('resolver keeps only declared operands, order preserved (last kept → clean)', () => {
  const declared = new Set(['source_ip', 'ip']);
  // last original operand `src` is dropped → trailing `|| undefined` preserves
  // the all-falsy fall-through.
  assert.equal(
    resolveAliasChainToParser('source_ip || source || ip || src', declared),
    'source_ip || ip || undefined',
  );
  // last original operand `ip` is kept → clean join, no tail needed.
  assert.equal(
    resolveAliasChainToParser('source_ip || source || ip', declared),
    'source_ip || ip',
  );
});

test('resolver collapses to a single operand, tail iff a later operand was dropped', () => {
  assert.equal(resolveAliasChainToParser('a || b || c', new Set(['b'])), 'b || undefined');
  assert.equal(resolveAliasChainToParser('a || b || c', new Set(['c'])), 'c');
});

test('resolver keeps the whole chain when NO operand is declared', () => {
  assert.equal(
    resolveAliasChainToParser('a || b || c', new Set(['x', 'y'])),
    'a || b || c',
  );
});

test('resolver is a no-op on an empty declared set', () => {
  assert.equal(resolveAliasChainToParser('a || b', new Set()), 'a || b');
});

test('resolver leaves an expression with no `||` untouched', () => {
  assert.equal(resolveAliasChainToParser('cond ? a : b', new Set(['a'])), 'cond ? a : b');
});

test('resolver leaves a chain containing a string literal untouched', () => {
  // `'x'` is not a bare field ref → the whole chain is impure → kept verbatim.
  assert.equal(resolveAliasChainToParser("a || 'x'", new Set(['a'])), "a || 'x'");
});

test('resolver leaves a chain embedded in a transform call untouched', () => {
  // Whole-expression-only: a sub-chain inside a call/comparison is NOT resolved,
  // because `||` is also boolean-OR and matching across boundaries corrupts it.
  assert.equal(
    resolveAliasChainToParser('Number(bytes_in || bytes || total)', new Set(['bytes'])),
    'Number(bytes_in || bytes || total)',
  );
});

test('resolver leaves a ternary guard with `|| ` untouched (build-687 bug)', () => {
  const expr = "severity == null || severity === '' ? 5 : Number(severity)";
  assert.equal(resolveAliasChainToParser(expr, new Set(['severity'])), expr);
});

test('resolver preserves dotted operands and matches on their base name', () => {
  const declared = new Set(['network__application']);
  // last operand `protocol` dropped → tail.
  assert.equal(
    resolveAliasChainToParser('app || network__application.name || protocol', declared),
    'network__application.name || undefined',
  );
});

test('resolver drops the trailing `|| undefined` when keepFalsyTail is false', () => {
  const declared = new Set(['source_ip', 'ip']);
  // Same input as the first test, but with the tail suppressed.
  assert.equal(
    resolveAliasChainToParser('source_ip || source || ip || src', declared, false),
    'source_ip || ip',
  );
  assert.equal(resolveAliasChainToParser('a || b || c', new Set(['b']), false), 'b');
  // When the last operand is KEPT there is no tail to drop → identical either way.
  assert.equal(resolveAliasChainToParser('a || b || c', new Set(['c']), false), 'c');
});

test('classifier: unstructured (regex) sources are string-only; JSON/kvp/cef may emit falsy', () => {
  // Regex-extracted → guaranteed string-valued → tail is droppable.
  assert.equal(sourceMayEmitNativeFalsy('cisco_asa'), false);
  assert.equal(sourceMayEmitNativeFalsy('palo_alto_traffic'), false);
  assert.equal(sourceMayEmitNativeFalsy('f5_bigip'), false);
  // JSON / kvp / cef → may carry a native 0/false the presence guard admits.
  assert.equal(sourceMayEmitNativeFalsy('aws_cloudtrail'), true);
  assert.equal(sourceMayEmitNativeFalsy('fortinet_fortigate'), true);
  assert.equal(sourceMayEmitNativeFalsy('zscaler_web'), true); // kvp + json alsoFormat
  // Unknown source → conservative (keep the tail).
  assert.equal(sourceMayEmitNativeFalsy('totally_unknown_st'), true);
});

test('builder: string-only source adds NO leaf fall-through tails; JSON source retains them', () => {
  // Count `|| undefined` in LEAF mapping evals only (the CEF header legitimately
  // keeps its own tail via String()-wrapping). A golden spec may itself contain a
  // literal `|| undefined`, so the RESOLVER's contribution is the ON-minus-OFF
  // delta (OFF = no alias resolution = spec-literal tails only).
  const leafTails = (st, resolve) => {
    let total = 0;
    for (const fmt of FORMATS) {
      const fns = buildGoldenFormatMapping(st, fmt, undefined, undefined, [], false, false, resolve);
      for (const f of fns) {
        if (f?.id !== 'eval' || typeof f?.description !== 'string') continue;
        if (!/^Map /.test(f.description)) continue; // leaf mapping evals only
        for (const a of f.conf?.add || []) {
          if (typeof a.value === 'string' && /\|\|\s*undefined\b/.test(a.value)) total++;
        }
      }
    }
    return total;
  };
  // cisco_asa is `unstructured` (string-only) → the resolver drops every
  // fall-through tail, so it adds NONE beyond what the spec already had.
  assert.equal(
    leafTails('cisco_asa', true), leafTails('cisco_asa', false),
    'a string-only source must gain no resolver-added `|| undefined` tail',
  );
  assert.equal(leafTails('palo_alto_traffic', true), leafTails('palo_alto_traffic', false));
  // aws_cloudtrail is JSON → tails are retained for byte-identical falsy handling.
  assert.ok(
    leafTails('aws_cloudtrail', true) > leafTails('aws_cloudtrail', false),
    'a JSON source must retain resolver-added `|| undefined` tails',
  );
  assert.ok(leafTails('corelight_conn', true) > leafTails('corelight_conn', false));
});

// ---------------------------------------------------------------------------
// 2. Corpus equivalence — the byte-identical proof
// ---------------------------------------------------------------------------

test('golden corpus: resolved mapping produces byte-identical live output', () => {
  const rng = makeRng(0x5eed);
  let combosChecked = 0;
  let combosChanged = 0;
  let eventsChecked = 0;

  for (const st of GOLDEN_SOURCETYPES) {
    const fields = getParserFieldNames(st);
    const declared = new Set(fields);
    if (!declared.size) continue; // not a golden-path source; nothing to resolve

    // The value domain the builder relied on when it decided whether to drop the
    // trailing `|| undefined`: string-only sources never produce native falsy.
    const pool = sourceMayEmitNativeFalsy(st) ? VALUE_POOL_FALSY : VALUE_POOL_STR;

    for (const fmt of FORMATS) {
      const onFns = buildGoldenFormatMapping(st, fmt, undefined, undefined, [], false, false, true);
      const offFns = buildGoldenFormatMapping(st, fmt, undefined, undefined, [], false, false, false);
      if (!onFns.length && !offFns.length) continue;
      combosChecked++;

      // Did the resolver actually change any expression for this combo? (so we can
      // assert the test isn't vacuous)
      const flat = (fns) => JSON.stringify(fns.flatMap((f) => f?.conf?.add || []).map((a) => a.value));
      if (flat(onFns) !== flat(offFns)) combosChanged++;

      // Battery of events, each carrying a random subset of ONLY the declared
      // fields (an undeclared field is never present → dropped operands are
      // undefined by construction). Plus the builtins the assembly reads.
      for (let n = 0; n < 60; n++) {
        const ev = { _time: 1737021600 + n, _raw: 'line', vendor: 'v', product: 'p', version: '1' };
        for (const f of fields) {
          if (rng() < 0.55) ev[f] = pool[(rng() * pool.length) | 0];
        }
        const outOn = runEvals(onFns, ev);
        const outOff = runEvals(offFns, ev);
        eventsChecked++;
        assert.ok(
          stableEqual(outOn, outOff),
          `${st}::${fmt} DIVERGED on event #${n}\n  in:  ${JSON.stringify(ev)}\n  on:  ${JSON.stringify(outOn)}\n  off: ${JSON.stringify(outOff)}`,
        );
      }
    }
  }

  assert.ok(combosChecked > 40, `expected a broad corpus, only built ${combosChecked} sourcetype×format combos`);
  assert.ok(combosChanged > 0, 'resolver changed no expression across the corpus — test would be vacuous');
  // eslint-disable-next-line no-console
  console.log(`alias-chain corpus: ${combosChecked} combos (${combosChanged} resolved), ${eventsChecked} events proven identical`);
});
