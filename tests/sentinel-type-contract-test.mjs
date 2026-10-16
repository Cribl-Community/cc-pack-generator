// Sentinel DCR contract: column TYPES, and which tables the destination can write.
//
// The Cribl Sentinel destination is the Logs Ingestion API. Three ways a pack
// that "deployed fine" landed nothing or empty columns:
//   1. CommonSecurityLog ports/bytes arrived as strings ("31964") in int/long
//      columns and LogSeverity as a number in a string column: Azure stores a
//      mistyped value as an empty column, with no error.
//   2. The catalog offered (and suggested) DeviceEvents, DeviceFileEvents,
//      AzureActivity and AzureDiagnostics, which the Ingestion API cannot write.
//   3. Seven columns were declared `guid`, a type a DCR stream declaration does
//      not accept (declare string, cast with toguid() in the transform).
// Plus: TimeGenerated was only forced for sentinel/commonsecuritylog/asim*, not
// for a native table picked by name (SecurityEvent, Syslog, WindowsEvent).

import { strict as assert } from 'node:assert';
import test from 'node:test';

globalThis.BUILD_NUMBER = 0;
const {
  buildPack,
  isSentinelFamilyFormat,
  isSafeEvalExpression,
  hasAssignmentOperator,
  sentinelCoercionExpr,
  sentinelColumnCoercionFunctions,
} = await import('../src/pack-builder.ts');
const {
  isSentinelIngestionTable,
  listSentinelTables,
  resolveSentinelTable,
  sentinelDestinationSuggestions,
} = await import('../src/sentinel-knowledge.ts');
const { emulatePipeline } = await import('../scripts/build-source-ocsf-samples.mjs');
const { resolveReferenceSample } = await import('../scripts/reference-api.mjs');
const catalog = (await import('../config/sentinel-destinations.json', { with: { type: 'json' } })).default;

const STREAM_TYPES = new Set(['string', 'int', 'long', 'real', 'boolean', 'datetime', 'dynamic']);
const NO_API = ['AzureActivity', 'AzureDiagnostics', 'DeviceEvents', 'DeviceFileEvents'];

test('every catalog column declares a DCR stream type', () => {
  for (const [name, table] of Object.entries(catalog.tables)) {
    for (const c of table.columns) {
      assert.ok(STREAM_TYPES.has(c.type), `${name}.${c.name}: ${c.type} is not a DCR stream type`);
      if (c.tableType) assert.equal(c.type, 'string', `${name}.${c.name}: a ${c.tableType} column streams as string`);
    }
  }
});

test('tables the Logs Ingestion API cannot write are flagged, hidden and never suggested', () => {
  for (const t of NO_API) {
    assert.equal(catalog.tables[t]?.ingestionApi, false, `${t} must be ingestionApi:false`);
    assert.equal(isSentinelIngestionTable(t), false);
  }
  const listed = listSentinelTables();
  for (const t of NO_API) assert.ok(!listed.includes(t), `${t} is offered in the table list`);
  assert.equal(listed.length, Object.keys(catalog.tables).length - NO_API.length);
  for (const st of ['windows_sysmon', 'windows_powershell', 'crowdstrike_falcon', 'endpoint', 'windows_security',
    'fortinet_fortigate', 'aws_cloudtrail', 'linux_secure', 'dns', 'unknown_source']) {
    for (const t of sentinelDestinationSuggestions(st)) {
      assert.ok(isSentinelIngestionTable(t), `${st} suggests ${t}, which the Ingestion API cannot write`);
    }
  }
});

test('TimeGenerated is forced for a native table picked by exact name, not for look-alike format ids', () => {
  for (const t of ['SecurityEvent', 'WindowsEvent', 'Syslog', 'AWSVPCFlow', 'CommonSecurityLog']) {
    assert.equal(isSentinelFamilyFormat(t), true, t);
  }
  for (const f of ['syslog', 'event', 'cef', 'json', 'ecs', 'cim', 'ocsf', 'chronicle', 'splunk_raw']) {
    assert.equal(isSentinelFamilyFormat(f), false, f);
  }
});

// Evaluate a coercion expression against one field value, the way Cribl's eval would.
const run = (type, value) => {
  const expr = sentinelCoercionExpr('X', type);
  return new Function('X', `return (${expr});`)(value);
};

test('coercion expressions are legal Cribl jsExpressions', () => {
  for (const type of STREAM_TYPES) {
    const expr = sentinelCoercionExpr('SourcePort', type);
    if (expr === null) continue;
    assert.ok(isSafeEvalExpression(expr), `${type}: ${expr}`);
    assert.equal(hasAssignmentOperator(expr), false, `${type}: ${expr}`);
  }
});

test('coercion casts to the declared type and never fabricates a value', () => {
  assert.equal(run('int', '31964'), 31964);
  assert.equal(run('long', 142054), 142054);
  assert.equal(run('int', '12.9'), 12);
  assert.equal(run('int', 'n/a'), null, 'an unparseable number is null, not 0');
  assert.equal(run('int', ''), null);
  assert.equal(run('int', undefined), undefined, 'an absent column stays absent');
  assert.equal(run('real', '0.5'), 0.5);
  assert.equal(run('string', 4), '4');
  assert.equal(run('string', 'abc'), 'abc');
  assert.equal(run('string', { a: 1 }), '{"a":1}');
  assert.equal(run('boolean', 'false'), false, "Boolean('false') would be true");
  assert.equal(run('boolean', 'TRUE'), true);
  assert.equal(run('boolean', 'maybe'), null);
  assert.equal(run('datetime', '1737021600'), '2025-01-16T10:00:00.000Z');
  assert.equal(run('datetime', '1737021600123'), '2025-01-16T10:00:00.123Z');
  assert.equal(run('datetime', 'not a date'), null);
  assert.equal(sentinelCoercionExpr('X', 'dynamic'), null, 'dynamic is left alone');
});

test('only written columns are cast, TimeGenerated excepted', () => {
  const csl = resolveSentinelTable('CommonSecurityLog').table;
  const fns = sentinelColumnCoercionFunctions(csl, ['SourcePort', 'LogSeverity', 'TimeGenerated', 'not_a_column']);
  const names = fns.flatMap(f => f.conf.add.map(a => a.name));
  assert.deepEqual(names.sort(), ['LogSeverity', 'SourcePort']);
  assert.deepEqual(sentinelColumnCoercionFunctions(null, ['SourcePort']), []);
});

const typeOk = (t, v) => {
  switch (t) {
    case 'int': case 'long': return typeof v === 'number' && Number.isInteger(v);
    case 'real': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'datetime': return typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !isNaN(Date.parse(v));
    case 'dynamic': return true;
    default: return typeof v === 'string';
  }
};

for (const [st, fmt, tableName] of [
  ['fortinet_fortigate', 'commonsecuritylog', 'CommonSecurityLog'],
  ['palo_alto_traffic', 'commonsecuritylog', 'CommonSecurityLog'],
  ['cisco_asa', 'commonsecuritylog', 'CommonSecurityLog'],
  ['palo_alto_traffic', 'asim#network', 'ASimNetworkSessionLogs'],
  ['okta_system', 'asim#authentication', 'ASimAuthenticationEventLogs'],
]) {
  test(`${st} → ${fmt}: every populated column carries its DCR type`, async () => {
    const ref = await resolveReferenceSample(st, '');
    const lines = (ref?.events || []).slice(0, 8).map(e => typeof e === 'string' ? e : (e._raw ?? JSON.stringify(e)));
    assert.ok(lines.length > 0, `no reference sample for ${st}`);
    const state = { packName: `t_${st}`, displayName: st, sourceMode: 'reference', sampleEvents: lines.join('\n'),
      destFormat: fmt, destFormats: [fmt], manualFormat: '', routeFilter: '', workerGroup: 'default' };
    const pack = buildPack(state, st, {}, true);
    const out = emulatePipeline(pack.pipelineConf.functions, lines).events;
    const cols = new Map(resolveSentinelTable(tableName).table.columns.map(c => [c.name, c.type]));
    let checked = 0;
    for (const ev of out) {
      for (const [k, v] of Object.entries(ev)) {
        if (!cols.has(k) || v === undefined || v === null || v === '') continue;
        checked++;
        assert.ok(typeOk(cols.get(k), v), `${k} is ${cols.get(k)} but got ${typeof v} ${JSON.stringify(v)}`);
      }
    }
    assert.ok(checked > 0, 'no table column was populated');
  });
}

// Sentinel solution content (analytics rules, workbooks, parsers) filters
// CommonSecurityLog on the identity the vendor's own CEF feed writes. A row
// tagged "Zscaler / Internet Access" lands, but no Zscaler rule ever matches it.
const { getCefVendorInfo, getMappingFunctions } = await import('../src/pack-builder.ts');
const CSL_IDENTITY = {
  zscaler_web: ['Zscaler', 'NSSWeblog'],
  crowdstrike_falcon: ['CrowdStrike', 'FalconHost'],
  checkpoint_firewall: ['Check Point', 'VPN-1 & FireWall-1'],
  fortinet_fortigate: ['Fortinet', 'Fortigate'],
  palo_alto_traffic: ['Palo Alto Networks', 'PAN-OS'],
  cisco_asa: ['Cisco', 'ASA'],
};

for (const [st, [vendor, product]] of Object.entries(CSL_IDENTITY)) {
  test(`${st} → CommonSecurityLog carries the identity Sentinel content filters on`, async () => {
    const ref = await resolveReferenceSample(st, '');
    const lines = (ref?.events || []).slice(0, 4).map(e => typeof e === 'string' ? e : (e._raw ?? JSON.stringify(e)));
    assert.ok(lines.length > 0, `no reference sample for ${st}`);
    const state = { packName: `t_${st}`, displayName: st, sourceMode: 'reference', sampleEvents: lines.join('\n'),
      destFormat: 'commonsecuritylog', destFormats: ['commonsecuritylog'], manualFormat: '', routeFilter: '', workerGroup: 'default' };
    const out = emulatePipeline(buildPack(state, st, {}, true).pipelineConf.functions, lines).events;
    assert.ok(out.length > 0);
    for (const ev of out) {
      assert.equal(ev.DeviceVendor, vendor);
      assert.equal(ev.DeviceProduct, product);
    }
  });
}

test('the CSL identity never leaks into the shared vendor table (OCSF metadata.product)', () => {
  assert.equal(getCefVendorInfo('zscaler_web').product, 'Internet Access');
  assert.equal(getCefVendorInfo('checkpoint_firewall').product, 'SmartDefense');
  const ocsf = buildPack({ packName: 't', displayName: 'z', sourceMode: 'reference', sampleEvents: '', destFormat: 'ocsf',
    destFormats: ['ocsf'], manualFormat: '', routeFilter: '', workerGroup: 'default' }, 'zscaler_web', {}, true).pipelineConf.functions;
  assert.ok(!JSON.stringify(ocsf).includes('NSSWeblog'), 'OCSF picked up the Sentinel product name');
  const staticCsl = JSON.stringify(getMappingFunctions('crowdstrike_falcon', 'commonsecuritylog'));
  assert.ok(staticCsl.includes('FalconHost'), 'static CSL fallback keeps the marketing name');
});
