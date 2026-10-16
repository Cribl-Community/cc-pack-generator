/**
 * OCSF DNS Activity (4003) + Email Activity (4009) golden formats
 * (project_ocsf_library_plan P4). Routes the `dns` and `email` data classes —
 * which previously fell back to Network Activity (4001) — to dedicated class
 * goldens, and grades the result with the Phase-1 schema oracle.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildGoldenFormatMapping,
  concretizeOcsfFormat,
  hasGoldenFormatPath,
  isOcsfFormat,
  ocsfSchemaOptions,
} from '../src/pack-builder.ts';
import { scoreOcsfAgainstSchema } from '../src/ocsf-schema.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(join(ROOT, 'config/golden-formats.json'), 'utf8'));

const FORBIDDEN = [/=>/, /\bfunction\b/, /\breturn\b/, /;/, /\?\./, /\?\?/];

// --- Faithful Cribl eval: absent field → undefined, globals pass through.
const GLOBALS = new Set(['String', 'Number', 'Math', 'Date', 'Boolean', 'parseInt',
  'parseFloat', 'JSON', 'RegExp', 'undefined', 'null', 'NaN', 'isNaN']);
function evalExpr(expr, scope) {
  const proxy = new Proxy(scope, { has: (_t, k) => !GLOBALS.has(k), get: (t, k) => (k in t ? t[k] : undefined) });
  // eslint-disable-next-line no-new-func
  return new Function('__s', 'with(__s){ return (' + expr + '); }')(proxy);
}
function assemble(spec, event) {
  const scope = { ...event };
  for (const [name, rule] of Object.entries(spec.valueRules)) scope[name] = evalExpr(rule, scope);
  const out = {};
  for (const m of spec.canonicalMap) {
    let v = evalExpr(m.expr, scope);
    if (v === undefined || v === null || v === '') continue;
    if (m.number) v = Number(v);
    const parts = m.dest.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ||= {});
    node[parts[parts.length - 1]] = v;
  }
  return out;
}

const CASES = [
  { key: 'ocsf#dns', classUid: 4003, cls: 'dns_activity' },
  { key: 'ocsf#email', classUid: 4009, cls: 'email_activity' },
];

for (const c of CASES) {
  const spec = golden.formats[c.key];

  test(`${c.key}: spec is a nested OCSF class with the right constants`, () => {
    assert.ok(spec, `${c.key} present`);
    assert.equal(spec.outputShape, 'nested');
    assert.equal(spec.timeField, 'log_time');
    const byDest = Object.fromEntries(spec.canonicalMap.map(m => [m.dest, m]));
    assert.equal(Number(byDest.class_uid.expr), c.classUid);
    assert.equal(Number(byDest.category_uid.expr), 4);
  });

  test(`${c.key}: canonicalMap covers every OCSF core-required attr`, () => {
    const dests = spec.canonicalMap.map(m => m.dest);
    const covers = (attr) => dests.some(d => d === attr || d.startsWith(attr + '.'));
    // Core is shared; email adds direction_id + email.
    const core = ['activity_id', 'category_uid', 'class_uid', 'metadata', 'severity_id', 'time', 'type_uid'];
    const extra = c.cls === 'email_activity' ? ['direction_id', 'email'] : [];
    for (const req of [...core, ...extra]) assert.ok(covers(req), `required ${req} not mapped in ${c.key}`);
  });

  test(`${c.key}: every expression is Cribl-eval-safe`, () => {
    const exprs = [...spec.canonicalMap.map(m => m.expr), ...Object.values(spec.valueRules)];
    for (const e of exprs) {
      for (const re of FORBIDDEN) assert.ok(!re.test(e), `forbidden token ${re} in: ${e}`);
      assert.doesNotThrow(() => new Function('return (' + e + ');'), `does not compile: ${e}`);
    }
  });

  test(`${c.key}: no output-object word appears inside a regex literal (build 344 landmine)`, () => {
    const objectNames = new Set(spec.canonicalMap.map(m => m.dest.split('.')[0]).filter(Boolean));
    for (const rule of Object.values(spec.valueRules)) {
      for (const rx of rule.match(/\/[^/]*\//g) || []) {
        for (const name of objectNames) assert.ok(!rx.includes(name), `regex ${rx} contains output-object word "${name}" in ${c.key}`);
      }
    }
  });

  test(`${c.key}: golden mapping emits the class constants and keeps structured output`, () => {
    const st = c.cls === 'dns_activity' ? 'infoblox_dns' : 'cisco_esa';
    const fns = buildGoldenFormatMapping(st, c.key);
    const adds = fns.flatMap(f => f.conf?.add || []);
    const names = new Set(adds.map(a => a.name));
    assert.ok(names.has('class_uid') && names.has('type_uid') && names.has('activity_id'), 'class constants mapped');
    assert.ok(adds.some(a => a.name === '_time'), 'sets _time');
    assert.ok(!fns.some(f => f.id === 'serialize' && f.conf?.dstField === '_raw'), 'OCSF output stays structured');
  });

  test(`${c.key}: exposed as a selectable schema option`, () => {
    assert.equal(isOcsfFormat(c.key), true);
    assert.ok(ocsfSchemaOptions().some(o => o.key === c.key && o.classUid === c.classUid));
  });
}

// --- Routing: dns / email data classes → the new classes ---------------------
test('concretizeOcsfFormat routes dns and email sources to their new classes', () => {
  assert.equal(concretizeOcsfFormat('ocsf', 'infoblox_dns'), 'ocsf#dns');
  assert.equal(concretizeOcsfFormat('ocsf', 'corelight_dns'), 'ocsf#dns');
  assert.equal(concretizeOcsfFormat('ocsf', 'cisco_esa'), 'ocsf#email');
  // Explicit schema selection wins.
  assert.equal(concretizeOcsfFormat('ocsf', 'anything', undefined, 'dns'), 'ocsf#dns');
  assert.equal(concretizeOcsfFormat('ocsf', 'anything', undefined, 'email'), 'ocsf#email');
  assert.equal(hasGoldenFormatPath('infoblox_dns', 'ocsf#dns'), true);
  assert.equal(hasGoldenFormatPath('cisco_esa', 'ocsf#email'), true);
});

// --- End-to-end: emulate the golden mapping, then grade with the oracle -------
test('a real Infoblox DNS response assembles to a valid DNS Activity event', () => {
  const spec = golden.formats['ocsf#dns'];
  const out = assemble(spec, {
    query: 'example.com', query_type: 'A', rcode: 'NOERROR', resolved_ip: '93.184.216.34',
    src_ip: '10.0.0.5', dest_ip: '10.0.0.53', log_time: 1787752808000,
    product: 'NIOS', vendor: 'Infoblox',
  });
  assert.equal(out.class_uid, 4003);
  assert.equal(out.category_uid, 4);
  assert.equal(out.activity_id, 2);          // Response (rcode/answers present)
  assert.equal(out.type_uid, 400302);        // 4003*100 + 2
  assert.equal(out.rcode_id, 0);             // NOERROR
  assert.equal(out.query.hostname, 'example.com');
  assert.deepEqual(out.answers, [{ rdata: '93.184.216.34' }]);
  assert.equal(out.status, 'Success');
  const r = scoreOcsfAgainstSchema([out], 'ocsf#dns');
  assert.equal(r.detectedClass, 'dns_activity');
  assert.equal(r.fromClassUid, true);
  assert.equal(r.checks.requiredPresent, r.checks.requiredTotal);
  assert.equal(r.checks.typeUidConsistent, true);
  assert.ok(r.score >= 85, `oracle expected >=85, got ${r.score} (${r.reasons[0]})`);
});

test('a real Cisco ESA inbound message assembles to a valid Email Activity event', () => {
  const spec = golden.formats['ocsf#email'];
  const out = assemble(spec, {
    sender: 'alice@corp.com', recipient: 'bob@ext.com', subject: 'Hello', message_id: '<abc@corp>',
    action: 'inbound delivered', direction: 'inbound', src_ip: '10.0.0.9', log_time: 1787752808000,
    product: 'ESA', vendor: 'Cisco',
  });
  assert.equal(out.class_uid, 4009);
  assert.equal(out.category_uid, 4);
  assert.equal(out.activity_id, 2);          // Receive (inbound)
  assert.equal(out.direction_id, 1);         // Inbound
  assert.equal(out.type_uid, 400902);        // 4009*100 + 2
  assert.equal(out.email.from, 'alice@corp.com');
  assert.deepEqual(out.email.to, ['bob@ext.com']);
  assert.equal(out.email.subject, 'Hello');
  assert.equal(out.status, 'Success');
  const r = scoreOcsfAgainstSchema([out], 'ocsf#email');
  assert.equal(r.detectedClass, 'email_activity');
  assert.equal(r.fromClassUid, true);
  assert.equal(r.checks.requiredPresent, r.checks.requiredTotal);
  assert.equal(r.checks.typeUidConsistent, true);
  assert.ok(r.score >= 85, `oracle expected >=85, got ${r.score} (${r.reasons[0]})`);
});

test('an outbound DMARC/email failure derives Outbound + Failure', () => {
  const spec = golden.formats['ocsf#email'];
  const out = assemble(spec, {
    sender: 'mailer@corp.com', recipient: 'x@ext.com', direction: 'outbound',
    action: 'rejected', disposition: 'reject', log_time: 1787752808000, vendor: 'Proofpoint',
  });
  assert.equal(out.direction_id, 2);         // Outbound
  assert.equal(out.activity_id, 1);          // Send
  assert.equal(out.status_id, 2);            // Failure
  assert.equal(out.status, 'Failure');
  const r = scoreOcsfAgainstSchema([out], 'ocsf#email');
  assert.ok(r.score >= 85, `oracle expected >=85, got ${r.score}`);
});
