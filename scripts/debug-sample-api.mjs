import { CRIBL_ORG, getToken } from './cribl-auth.mjs';

const PACK_ID = 'cisco-test';
const WORKER_GROUP = 'seLab';

const SAMPLE_EVENTS = [
  '%ASA-6-302013: Built inbound TCP connection 12345 for outside:10.0.0.1/443 to inside:192.168.1.100/50000',
  '%ASA-6-302014: Teardown TCP connection 12345 for outside:10.0.0.1/443 to inside:192.168.1.100/50000 duration 0:01:30 bytes 8192',
  '%ASA-4-106023: Deny tcp src outside:10.0.0.2/12345 dst inside:192.168.1.50/22 by access-group "outside_in"',
];

export async function handleDebugSample(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { step } = JSON.parse(body);
    const token = await getToken();
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const sid = `DbgSm${step}`;
    const sname = `debug_s${step}.log`;

    let result;

    switch (step) {
      // Step 1: PATCH metadata to pack (upsert — creates if not exists)
      case 1: {
        const payload = { id: sid, sampleName: sname, isTemplate: true, size: SAMPLE_EVENTS.join('\n').length, numEvents: SAMPLE_EVENTS.length };
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples/${sid}`, {
          method: 'PATCH', headers: authHeaders, body: JSON.stringify(payload),
        });
        result = { step, desc: 'PATCH metadata to pack (upsert)', id: sid, name: sname, status: resp.status, ok: resp.ok, response: tryParse(await resp.text()) };
        break;
      }

      // Step 2: PATCH metadata to global (upsert — creates if not exists)
      case 2: {
        const payload = { id: sid, sampleName: sname, isTemplate: true, size: SAMPLE_EVENTS.join('\n').length, numEvents: SAMPLE_EVENTS.length };
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/system/samples/${sid}`, {
          method: 'PATCH', headers: authHeaders, body: JSON.stringify(payload),
        });
        result = { step, desc: 'PATCH metadata to global (upsert)', id: sid, name: sname, status: resp.status, ok: resp.ok, response: tryParse(await resp.text()) };
        break;
      }

      // Step 3: POST with context.events to pack (how the UI does it!)
      case 3: {
        const events = SAMPLE_EVENTS.map(raw => ({ _raw: raw, _time: Date.now() / 1000, cribl_breaker: 'Break on newlines' }));
        const payload = { sampleName: sname, context: { events } };
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify(payload),
        });
        const data = tryParse(await resp.text());
        const createdId = data?.items?.[0]?.id;
        result = { step, desc: 'POST context.events to pack (UI method)', name: sname, createdId, status: resp.status, ok: resp.ok, response: data };
        break;
      }

      // Step 4: POST with context.events to global (UI method at global scope)
      case 4: {
        const events = SAMPLE_EVENTS.map(raw => ({ _raw: raw, _time: Date.now() / 1000, cribl_breaker: 'Break on newlines' }));
        const payload = { sampleName: `debug_s4.log`, context: { events } };
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/system/samples`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify(payload),
        });
        const data = tryParse(await resp.text());
        const createdId = data?.items?.[0]?.id;
        result = { step, desc: 'POST context.events to global (UI method)', createdId, status: resp.status, ok: resp.ok, response: data };
        break;
      }

      // Step 5: PUT full sample object to pack (replace entire sample)
      case 5: {
        const targetId = 'DbgSm1';
        const items = SAMPLE_EVENTS.map(raw => ({ _raw: raw, _time: Date.now() / 1000, __criblEventType: 'event', __ctrlFields: [], __final: false, __cloneCount: 0 }));
        const payload = { id: targetId, sampleName: 'debug_s1.log', isTemplate: true, items, size: SAMPLE_EVENTS.join('\n').length, numEvents: SAMPLE_EVENTS.length };
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples/${targetId}`, {
          method: 'PUT', headers: authHeaders, body: JSON.stringify(payload),
        });
        result = { step, desc: 'PUT full object to pack', targetId, status: resp.status, ok: resp.ok, response: tryParse(await resp.text()) };
        break;
      }

      // Step 6: PUT full sample object to global (replace entire sample)
      case 6: {
        const targetId = 'DbgSm2';
        const items = SAMPLE_EVENTS.map(raw => ({ _raw: raw, _time: Date.now() / 1000, __criblEventType: 'event', __ctrlFields: [], __final: false, __cloneCount: 0 }));
        const payload = { id: targetId, sampleName: 'debug_s2.log', isTemplate: true, items, size: SAMPLE_EVENTS.join('\n').length, numEvents: SAMPLE_EVENTS.length };
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/system/samples/${targetId}`, {
          method: 'PUT', headers: authHeaders, body: JSON.stringify(payload),
        });
        result = { step, desc: 'PUT full object to global', targetId, status: resp.status, ok: resp.ok, response: tryParse(await resp.text()) };
        break;
      }

      // Step 7: POST multipart file upload to pack
      case 7: {
        const fileContent = SAMPLE_EVENTS.join('\n');
        const boundary = '----FormBoundary' + Date.now();
        const formBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sname}"\r\nContent-Type: text/plain\r\n\r\n${fileContent}\r\n--${boundary}--`;
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body: formBody,
        });
        result = { step, desc: 'POST multipart to pack', name: sname, status: resp.status, ok: resp.ok, response: tryParse(await resp.text()) };
        break;
      }

      // Step 8: POST multipart file upload to global
      case 8: {
        const fileContent = SAMPLE_EVENTS.join('\n');
        const boundary = '----FormBoundary' + Date.now();
        const formBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sname}"\r\nContent-Type: text/plain\r\n\r\n${fileContent}\r\n--${boundary}--`;
        const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/system/samples`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body: formBody,
        });
        result = { step, desc: 'POST multipart to global', name: sname, status: resp.status, ok: resp.ok, response: tryParse(await resp.text()) };
        break;
      }

      // Step 9: Commit + Deploy
      case 9: {
        const commitResp = await fetch(`${CRIBL_ORG}/api/v1/version/commit`, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ message: `Debug: add samples to ${PACK_ID}`, group: WORKER_GROUP }),
        });
        const commitResult = await commitResp.json();
        const commit = commitResult.items?.[0]?.commit;
        const deployResp = await fetch(`${CRIBL_ORG}/api/v1/master/groups/${WORKER_GROUP}/deploy`, {
          method: 'PATCH', headers: authHeaders,
          body: JSON.stringify({ version: commit }),
        });
        const deployResult = await deployResp.json();
        result = { step: 9, commit, deployVersion: deployResult.items?.[0]?.configVersion, message: 'Committed and deployed' };
        break;
      }

      // Step 10: List all pack samples + check content for each
      case 10: {
        const listResp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const listData = tryParse(await listResp.text());
        const samples = listData?.items || [];
        const checks = {};
        for (const s of samples) {
          const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples/${s.id}/content`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const txt = await resp.text();
          checks[s.id] = { name: s.sampleName, status: resp.status, ok: resp.ok, preview: resp.ok ? (tryParse(txt))?.slice?.(0,1) : txt.slice(0, 150) };
        }
        result = { step: 10, scope: 'pack', sampleCount: samples.length, checks };
        break;
      }

      // Step 11: List all pack samples + check content at GLOBAL scope
      case 11: {
        const listResp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const listData = tryParse(await listResp.text());
        const samples = listData?.items || [];
        const checks = {};
        for (const s of samples) {
          const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/system/samples/${s.id}/content`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const txt = await resp.text();
          checks[s.id] = { name: s.sampleName, status: resp.status, ok: resp.ok, preview: resp.ok ? (tryParse(txt))?.slice?.(0,1) : txt.slice(0, 150) };
        }
        result = { step: 11, scope: 'global', sampleCount: samples.length, checks };
        break;
      }

      // Step 12: Cleanup — delete ALL debug samples
      case 12: {
        const results = [];
        for (const id of ['DbgSm1', 'DbgSm2', 'DbgSm3', 'DbgSm4', 'DbgSm5', 'DbgSm6', 'DbgSm7', 'DbgSm8']) {
          const pd = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples/${id}`, { method: 'DELETE', headers: authHeaders });
          const gd = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/system/samples/${id}`, { method: 'DELETE', headers: authHeaders });
          results.push({ id, packDel: pd.status, globalDel: gd.status });
        }
        // Also delete by filename-based IDs that multipart upload might create
        for (const n of ['debug_s7', 'debug_s8']) {
          const pd = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/p/${PACK_ID}/system/samples/${n}`, { method: 'DELETE', headers: authHeaders });
          const gd = await fetch(`${CRIBL_ORG}/api/v1/m/${WORKER_GROUP}/system/samples/${n}`, { method: 'DELETE', headers: authHeaders });
          results.push({ id: n, packDel: pd.status, globalDel: gd.status });
        }
        result = { step: 12, results, message: 'Cleanup complete' };
        break;
      }

      default:
        result = { error: `Unknown step: ${step}` };
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message, stack: err.stack }));
  }
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}
