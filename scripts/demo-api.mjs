// Backend handlers for the "Create Demo Environment" mode (standalone dev).
// These reach Cribl Cloud via OAuth (cribl-auth.mjs) and cover the endpoints
// the normal pack-generation flow does NOT touch: worker health, Lake datasets,
// cribl_lake outputs, the worker-group MASTER route table, and a multi-sample
// group-level datagen source.
//
// iframe parity for all of these lives in src/api.ts (same shapes).
import { CRIBL_ORG, getToken } from './cribl-auth.mjs';
import {
  demoSampleOwner, isDemoInputId, isDemoOutputId, unquoteDatagenTimestamps,
} from '../src/demo-flow-ids.ts';

const DEMO_ROUTE_PREFIX = 'demo_';
const DEMO_PACK_PREFIX = 'demo-';        // toKebab('demo …') → demo-<source>-<fmt>

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function authHeaders(token) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Remove routes (by id set) from a route table and re-key comments. Comment
// `index` is the position in the COMBINED comments+routes list, so we rebuild
// that ordered list, drop deleted routes + any [DEMO] comment that anchored a
// deleted route, then renumber surviving comments by their new position.
function pruneRoutesAndComments(routes, comments, removeRouteIds) {
  const idSet = new Set(removeRouteIds);
  // Build the combined ordered list. Comments occupy their `index` slot; routes
  // fill the remaining slots in order.
  const total = routes.length + comments.length;
  const commentAt = new Map();
  for (const c of comments) commentAt.set(c.index || 0, c);
  const combined = [];
  let ri = 0;
  for (let pos = 0; pos < total; pos++) {
    if (commentAt.has(pos)) combined.push({ kind: 'comment', c: commentAt.get(pos) });
    else if (ri < routes.length) combined.push({ kind: 'route', r: routes[ri++] });
  }
  // Which combined positions are routes being removed?
  const removedPositions = new Set();
  combined.forEach((e, pos) => { if (e.kind === 'route' && idSet.has(e.r.id)) removedPositions.add(pos); });
  // Keep: all non-removed routes; comments except a [DEMO] comment immediately
  // above a removed route (its anchor is gone).
  const keptRoutes = [];
  const keptCombined = [];
  combined.forEach((e, pos) => {
    if (e.kind === 'route') {
      if (!idSet.has(e.r.id)) { keptRoutes.push(e.r); keptCombined.push(e); }
    } else {
      const isDemo = String(e.c.comment || '').startsWith('[DEMO]');
      const anchorsRemoved = removedPositions.has(pos + 1);
      if (!(isDemo && anchorsRemoved)) keptCombined.push(e);
    }
  });
  // Renumber surviving comments by their ordinal position in the kept list.
  const keptComments = [];
  keptCombined.forEach((e, pos) => { if (e.kind === 'comment') keptComments.push({ ...e.c, index: pos }); });
  return { routes: keptRoutes, comments: keptComments };
}

// --- Worker health (per group) --------------------------------------------
// /master/groups has no worker count; aggregate /master/workers by .group and
// count status==='healthy'. Returns { [group]: { total, healthy } }.
export async function handleListWorkers(req, res) {
  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/master/workers`, { headers: authHeaders(token) });
    const data = await resp.json();
    const byGroup = {};
    for (const w of data.items || []) {
      const g = w.group || 'unknown';
      if (!byGroup[g]) byGroup[g] = { total: 0, healthy: 0 };
      byGroup[g].total += 1;
      if (w.status === 'healthy' && !w.disconnected) byGroup[g].healthy += 1;
    }
    sendJson(res, 200, { workers: byGroup });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to list workers' });
  }
}

// --- Cribl Lake datasets ----------------------------------------------------
// lakeId is 'default' on Cribl Cloud orgs (see reference: probe found no
// /products/lake/lakes list endpoint — the id is fixed 'default').
export async function handleListLakeDatasets(req, res) {
  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/products/lake/lakes/default/datasets`, { headers: authHeaders(token) });
    const data = await resp.json();
    // Exclude Cribl's built-in datasets (default_* and cribl_*) — demos must
    // target a real customer dataset, not the stock/system ones.
    const datasets = (data.items || [])
      .filter(d => { const id = String(d.id || ''); return !id.startsWith('default_') && !id.startsWith('cribl_'); })
      .map(d => ({ id: d.id, description: d.description || '' }));
    sendJson(res, 200, { datasets });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to list Lake datasets' });
  }
}

// --- Cribl Search datasets + dashboard deployment --------------------------
// Search endpoints are always scoped to default_search, independent of the
// Stream worker group selected for the demo environment.
export async function handleListSearchDatasets(req, res) {
  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/default_search/search/datasets?offset=0&limit=250&explorerStats=true`, { headers: authHeaders(token) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || `Cribl Search returned ${resp.status}`);
    const datasets = (data.items || []).map(d => ({
      id: d.id,
      description: d.description || '',
      type: d.type || d.provider?.type || '',
      provider: d.providerId || d.provider?.id || '',
      searchVersion: d.searchVersion || '',
    })).filter(d => d.id && d.searchVersion === 'v1');
    sendJson(res, 200, { datasets });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to list Search datasets' });
  }
}

export async function handleListSearchDatatypes(req, res) {
  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/default_search/search/datatypes?offset=0&limit=500`, { headers: authHeaders(token) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || `Cribl Search returned ${resp.status}`);
    const datatypes = (data.items || []).filter(datatype => datatype.id).sort((a, b) => a.id.localeCompare(b.id));
    sendJson(res, 200, { datatypes });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to list Search datatypes' });
  }
}

export async function handleDeploySearchDashboard(req, res) {
  try {
    const { dashboard } = await readBody(req);
    if (!dashboard || typeof dashboard !== 'object' || !dashboard.id || !dashboard.name) {
      return sendJson(res, 400, { error: 'A dashboard object with id and name is required' });
    }
    const token = await getToken();
    const endpoint = `${CRIBL_ORG}/api/v1/m/default_search/search/dashboards`;
    let response = await fetch(endpoint, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(dashboard) });
    let updated = false;
    if (!response.ok && [400, 409].includes(response.status)) {
      response = await fetch(`${endpoint}/${encodeURIComponent(dashboard.id)}`, { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify(dashboard) });
      updated = true;
    }
    const text = await response.text();
    let data = {}; try { data = JSON.parse(text); } catch { /* retain raw error below */ }
    if (!response.ok) throw new Error(data.message || data.error || `Dashboard deployment returned ${response.status}: ${text.slice(0, 180)}`);
    const item = data.items?.[0] || dashboard;
    sendJson(res, 200, { id: item.id || dashboard.id, name: item.name || dashboard.name, updated });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to deploy Search dashboard' });
  }
}

export async function handleDeploySearchDatatype(req, res) {
  try {
    const { datatype } = await readBody(req);
    if (!datatype || typeof datatype !== 'object' || !datatype.id) return sendJson(res, 400, { error: 'A datatype object with id is required' });
    const token = await getToken();
    const endpoint = `${CRIBL_ORG}/api/v1/m/default_search/search/datatypes`;
    let response = await fetch(endpoint, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(datatype) });
    let updated = false;
    if (!response.ok && [400, 409].includes(response.status)) {
      response = await fetch(`${endpoint}/${encodeURIComponent(datatype.id)}`, { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify(datatype) });
      updated = true;
    }
    const text = await response.text();
    let data = {}; try { data = JSON.parse(text); } catch { /* retain raw error below */ }
    if (!response.ok) throw new Error(data.message || data.error || `Datatype deployment returned ${response.status}: ${text.slice(0, 180)}`);
    sendJson(res, 200, { id: data.items?.[0]?.id || datatype.id, updated });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to deploy Search datatype' });
  }
}

export async function handleAttachSearchDatatypes(req, res) {
  try {
    const { datasetId, datatypeIds } = await readBody(req);
    if (!datasetId || !Array.isArray(datatypeIds) || datatypeIds.length === 0) return sendJson(res, 400, { error: 'datasetId and datatypeIds are required' });
    const token = await getToken();
    const endpoint = `${CRIBL_ORG}/api/v1/m/default_search/search/datasets/${encodeURIComponent(datasetId)}`;
    const getResp = await fetch(endpoint, { headers: authHeaders(token) });
    const current = await getResp.json();
    if (!getResp.ok) throw new Error(current.message || `Dataset lookup returned ${getResp.status}`);
    const dataset = current.items?.[0];
    if (!dataset) throw new Error(`Search dataset "${datasetId}" was not found.`);
    if (dataset.searchVersion !== 'v1') throw new Error(`Search dataset "${datasetId}" must be a federated v1 dataset for Datatype v1 parsing.`);
    const breakerRulesets = [...new Set([...datatypeIds, ...(Array.isArray(dataset.breakerRulesets) ? dataset.breakerRulesets : [])])];
    const patchResp = await fetch(endpoint, { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify({ ...dataset, breakerRulesets }) });
    const text = await patchResp.text();
    if (!patchResp.ok) throw new Error(`Dataset update returned ${patchResp.status}: ${text.slice(0, 180)}`);
    sendJson(res, 200, { datasetId, datatypeIds });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to attach Search datatypes' });
  }
}

// --- List active destinations (outputs) -------------------------------------
// For the routing table's per-row destination picker. Excludes disabled outputs;
// always includes built-in devnull. Returns { id, type }.
export async function handleListOutputs(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const group = url.searchParams.get('group');
    if (!group) return sendJson(res, 400, { error: 'Missing ?group=' });
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/outputs`, { headers: authHeaders(token) });
    const data = await resp.json();
    const outputs = (data.items || [])
      .filter(o => o.disabled !== true)
      .map(o => ({ id: o.id, type: o.type }));
    sendJson(res, 200, { outputs });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to list outputs' });
  }
}

// --- Ensure a cribl_lake output for a dataset -------------------------------
// cribl_lake outputs reference the dataset by NAME via destPath (not lakeId).
// Reuse an existing output targeting the dataset if present, else create one.
export async function handleEnsureLakeOutput(req, res) {
  try {
    const { group, datasetId } = await readBody(req);
    if (!group || !datasetId) return sendJson(res, 400, { error: 'group and datasetId required' });
    const token = await getToken();
    const headers = authHeaders(token);

    const listResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/outputs`, { headers });
    const listData = await listResp.json();
    const existing = (listData.items || []).find(o => o.type === 'cribl_lake' && o.destPath === datasetId);
    if (existing) return sendJson(res, 200, { outputId: existing.id, created: false });

    const outputId = `demo_lake_${datasetId}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const createResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/outputs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: outputId,
        type: 'cribl_lake',
        destPath: datasetId,
        format: 'json',
        compress: 'gzip',
        awsAuthenticationMethod: 'auto',
        systemFields: ['cribl_pipe'],
      }),
    });
    if (!createResp.ok) {
      const txt = await createResp.text();
      // If a same-id output already exists, treat as success.
      if (createResp.status === 409 || txt.includes('already exists')) {
        return sendJson(res, 200, { outputId, created: false });
      }
      return sendJson(res, createResp.status, { error: `Failed to create Lake output: ${txt}` });
    }
    sendJson(res, 200, { outputId, created: true });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to ensure Lake output' });
  }
}

// --- Worker-group MASTER route table ---------------------------------------
// Prepend the demo route block to /m/<group>/routes, replacing any prior demo
// block (id prefix demo_). Then commit + deploy the group.
export async function handleSetMasterRoutes(req, res) {
  try {
    const { group, demoRoutes, demoComments = [] } = await readBody(req);
    if (!group || !Array.isArray(demoRoutes)) return sendJson(res, 400, { error: 'group and demoRoutes[] required' });
    const token = await getToken();
    const headers = authHeaders(token);

    const getResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/routes`, { headers });
    const getData = await getResp.json();
    const table = getData.items?.[0] || { id: 'default', routes: [] };
    const existing = Array.isArray(table.routes) ? table.routes : [];

    // Drop any previous demo routes so re-runs replace rather than stack.
    const nonDemo = existing.filter(r => !String(r.id || '').startsWith(DEMO_ROUTE_PREFIX));
    const newRoutes = [...demoRoutes, ...nonDemo];

    // Comment rows are keyed by their position in the COMBINED comments+routes
    // list (NOT the routes-only array). We prepend the demo block at the very
    // top, so it occupies the first (demoRoutes.length + demoComments.length)
    // rows — shift every existing customer comment down by that combined count.
    // Demo comment indices already account for their own interleaving.
    const genId = () => Math.random().toString(36).slice(2, 8);
    const prevComments = Array.isArray(table.comments) ? table.comments : [];
    const demoBlockRows = demoRoutes.length + demoComments.length;
    const shiftedExisting = prevComments
      .filter(c => !String(c.comment || '').startsWith('[DEMO]'))
      .map(c => ({ ...c, index: (c.index || 0) + demoBlockRows }));
    const demoCommentRows = demoComments.map(c => ({ id: genId(), comment: c.comment, index: c.index }));
    const comments = [...demoCommentRows, ...shiftedExisting];
    const tableId = table.id || 'default';

    // The master route table validates every route's `pipeline` against an enum
    // of registered pipelines/packs. A just-committed pack can lag the leader's
    // validator by several seconds, so a single PATCH 500s ("Invalid Pipeline
    // ID") and sinks the WHOLE table. Mirror deploy-api.mjs's proven pattern:
    // (1) poll GET /packs until every referenced pack:<id> is registered,
    // (2) retry the PATCH with backoff, (3) on the final try, prune any route
    // whose pack still isn't registered so one laggard can't sink the rest.
    const referencedPackIds = [...new Set(
      newRoutes.map(r => String(r.pipeline || '')).filter(p => p.startsWith('pack:')).map(p => p.slice(5))
    )];
    const listInstalledPacks = async () => {
      try {
        const r = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/packs`, { headers });
        if (!r.ok) return null;
        return new Set(((await r.json())?.items || []).map(p => p.id));
      } catch { return null; }
    };
    // (1) Poll for pack registration (~30s bounded).
    if (referencedPackIds.length > 0) {
      for (let attempt = 0; attempt < 15; attempt++) {
        const installed = await listInstalledPacks();
        if (installed && referencedPackIds.every(id => installed.has(id))) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    // (2)/(3) PATCH with backoff on Invalid-Pipeline-ID; prune missing on last try.
    const backoff = [1000, 2000, 3000, 4000, 5000, 6000, 8000];
    let routesToWrite = newRoutes;
    let patchOk = false, lastErr = '';
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      const isLast = attempt === backoff.length;
      if (isLast) {
        // Final attempt: drop demo routes whose pack still isn't registered
        // (built-in pipelines devnull/passthru/main are always valid).
        const installed = await listInstalledPacks();
        if (installed) {
          routesToWrite = newRoutes.filter(r => {
            const p = String(r.pipeline || '');
            if (!p.startsWith('pack:')) return true;
            return installed.has(p.slice(5));
          });
        }
      }
      const patchResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/routes/${tableId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ...table, id: tableId, routes: routesToWrite, comments }),
      });
      if (patchResp.ok) { patchOk = true; break; }
      lastErr = await patchResp.text();
      const invalidPipeline = lastErr.includes('Invalid Pipeline ID') || lastErr.includes('should be equal to one of the allowed');
      if (!invalidPipeline || isLast) break;
      await new Promise(r => setTimeout(r, backoff[attempt]));
    }
    if (!patchOk) {
      return sendJson(res, 500, { error: `Failed to PATCH routes: ${lastErr}` });
    }

    // Commit + deploy the group (same dance as deploy-api.mjs).
    const commitResp = await fetch(`${CRIBL_ORG}/api/v1/version/commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: `Demo routing table (${demoRoutes.length} routes)`, group }),
    });
    const commitResult = await commitResp.json();
    const commit = commitResult.items?.[0]?.commit || 'unknown';
    const deployResp = await fetch(`${CRIBL_ORG}/api/v1/master/groups/${group}/deploy`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ version: commit }),
    });
    const deployResult = await deployResp.json();
    const version = deployResult.items?.[0]?.configVersion || commit;

    const demoWritten = routesToWrite.filter(r => String(r.id || '').startsWith(DEMO_ROUTE_PREFIX)).length;
    const dropped = demoRoutes.length - demoWritten;
    sendJson(res, 200, { routeCount: routesToWrite.length, demoCount: demoWritten, dropped, commit, version });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to set master routes' });
  }
}

// --- Multi-sample group-level datagen source --------------------------------
// ONE datagen input holding one samples[] entry per selected source. Each
// source's events carry _raw + a per-source `sourcetype` field baked into the
// event so a single input can emit correctly-tagged mixed-source data.
// sources: [{ sourcetype, events: (string|{_raw})[] }]
export async function handleCreateDemoDatagen(req, res) {
  try {
    const { group, sources, datagenId = 'demo_datagen', eventsPerSec = 10 } = await readBody(req);
    if (!group || !Array.isArray(sources) || sources.length === 0) {
      return sendJson(res, 400, { error: 'group and sources[] required' });
    }
    const token = await getToken();
    const headers = authHeaders(token);

    // Existing group samples — used to find (and refresh) a demo sample on re-run
    // so we reference the id Cribl actually assigned, not the filename.
    const existingSamples = await (await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/samples`, { headers })).json();
    const existingByName = new Map((existingSamples.items || []).map(s => [s.sampleName, s.id]));

    const samplesRef = [];
    const perSource = [];
    for (const src of sources) {
      const st = src.sourcetype;
      const fileName = `${datagenId}_${st}.log`.toLowerCase().replace(/[^a-z0-9_.]/g, '_');
      const events = (src.events || []).map(evt => {
        let raw;
        if (typeof evt === 'object' && evt !== null && evt._raw) raw = evt._raw;
        else if (typeof evt === 'string') raw = evt;
        else raw = JSON.stringify(evt);
        // Roll timestamps for JSON events (same as deploy-api datagen path).
        try {
          const parsed = JSON.parse(raw);
          if (parsed._time) parsed._time = '${timestamp:%s.%L}';
          if (parsed.timestamp) parsed.timestamp = '${timestamp:%s.%L}';
          raw = unquoteDatagenTimestamps(JSON.stringify(parsed));
        } catch { /* not JSON — use as-is */ }
        // Bake per-source sourcetype into the event so ONE input emits mixed
        // sources correctly tagged (input-level fields[] can't vary per sample).
        return { _raw: raw, _time: Date.now() / 1000, sourcetype: st };
      });

      const sampleBody = { sampleName: fileName, isTemplate: true, tsTemplateField: '', context: { events } };
      // The datagen input must reference the sample by the ID Cribl ASSIGNS on
      // upload (a random token like "u8IpZc") — NOT the filename. Capture it.
      let sampleId = existingByName.get(fileName);
      if (sampleId) {
        // Re-run: PATCH the existing sample to refresh content, keep its id.
        const patchResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/samples/${encodeURIComponent(sampleId)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ id: sampleId, ...sampleBody }),
        });
        if (!patchResp.ok) console.log(`[demo-datagen] sample refresh ${fileName} (${sampleId}): ${patchResp.status} ${await patchResp.text()}`);
      } else {
        const upResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/samples`, {
          method: 'POST', headers, body: JSON.stringify(sampleBody),
        });
        if (upResp.ok) {
          const upJson = await upResp.json();
          sampleId = upJson.items?.[0]?.id || upJson.id;
        } else {
          console.log(`[demo-datagen] sample ${fileName}: POST ${upResp.status} ${await upResp.text()}`);
        }
      }
      if (!sampleId) { console.log(`[demo-datagen] no sample id for ${fileName} — skipping`); continue; }
      samplesRef.push({ eventsPerSec, sample: sampleId });
      perSource.push({ sourcetype: st, sampleRef: sampleId });
    }

    // Create ONE active datagen input referencing all samples.
    const createResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/inputs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: datagenId,
        type: 'datagen',
        disabled: false,
        stoppedBehavior: 'manual',
        sendToRoutes: true,
        throttleRatePerSec: 0,
        pqEnabled: false,
        streamtags: ['demo'],
        connections: [],
        metadata: [],
        samples: samplesRef,
        description: `Demo datagen — ${sources.length} source(s): ${sources.map(s => s.sourcetype).join(', ')}`,
      }),
    });
    let created = createResp.ok;
    if (!createResp.ok) {
      const txt = await createResp.text();
      // Replace an existing demo datagen input so re-runs are idempotent.
      if (createResp.status === 409 || txt.includes('already exists')) {
        const patchResp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/inputs/${datagenId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            id: datagenId, type: 'datagen', disabled: false, stoppedBehavior: 'manual',
            sendToRoutes: true, throttleRatePerSec: 0, pqEnabled: false,
            streamtags: ['demo'], connections: [], metadata: [], samples: samplesRef,
            description: `Demo datagen — ${sources.length} source(s): ${sources.map(s => s.sourcetype).join(', ')}`,
          }),
        });
        created = patchResp.ok;
        if (!patchResp.ok) {
          return sendJson(res, patchResp.status, { error: `Failed to update datagen: ${await patchResp.text()}` });
        }
      } else {
        return sendJson(res, createResp.status, { error: `Failed to create datagen: ${txt}` });
      }
    }
    sendJson(res, 200, { datagenId, sources: perSource, created });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to create demo datagen' });
  }
}

// --- Scan for existing demo artifacts on a worker group ---------------------
// Returns the demo routes, datagen inputs, and packs that a previous demo run
// created (identified by the demo_ / demo- naming), so the user can pick which
// to remove. Nothing is deleted here.
export async function handleScanDemo(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const group = url.searchParams.get('group');
    if (!group) return sendJson(res, 400, { error: 'Missing ?group=' });
    const token = await getToken();
    const headers = authHeaders(token);

    const [rtResp, inResp, pkResp, outResp] = await Promise.all([
      fetch(`${CRIBL_ORG}/api/v1/m/${group}/routes`, { headers }),
      fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/inputs`, { headers }),
      fetch(`${CRIBL_ORG}/api/v1/m/${group}/packs`, { headers }),
      fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/outputs`, { headers }),
    ]);
    const rt = await rtResp.json();
    const inputs = await inResp.json();
    const packs = await pkResp.json();
    const outputs = await outResp.json();

    const routes = (rt.items?.[0]?.routes || [])
      .filter(r => String(r.id || '').startsWith(DEMO_ROUTE_PREFIX))
      .map(r => ({ id: r.id, name: r.name, pipeline: r.pipeline, output: r.output }));
    const datagens = (inputs.items || [])
      .filter(i => isDemoInputId(String(i.id || '')))
      .map(i => ({ id: i.id, sampleCount: (i.samples || []).length, description: i.description || '' }));
    const packList = (packs.items || [])
      .filter(p => String(p.id || '').startsWith(DEMO_PACK_PREFIX))
      .map(p => ({ id: p.id, displayName: p.displayName || p.id, version: p.version || '' }));
    const outputList = (outputs.items || [])
      .filter(o => isDemoOutputId(String(o.id || '')))
      .map(o => ({ id: o.id, type: o.type, destPath: o.destPath || '' }));

    sendJson(res, 200, { routes, datagens, packs: packList, outputs: outputList });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to scan demo artifacts' });
  }
}

// --- Remove SELECTED demo artifacts, in sequence: routes → datagen → packs --
// Only the ids passed in are touched. Removing a route also drops its matching
// [DEMO] comment memo. One commit + deploy at the end.
export async function handleCleanupDemo(req, res) {
  try {
    const { group, routeIds = [], datagenIds = [], packIds = [], outputIds = [] } = await readBody(req);
    if (!group) return sendJson(res, 400, { error: 'group required' });
    const token = await getToken();
    const headers = authHeaders(token);
    const removed = { routes: [], datagens: [], packs: [], outputs: [] };
    const errors = [];

    // 1. ROUTING — remove selected demo routes + their [DEMO] comment memos.
    if (routeIds.length > 0) {
      const rt = await (await fetch(`${CRIBL_ORG}/api/v1/m/${group}/routes`, { headers })).json();
      const table = rt.items?.[0];
      if (table) {
        const { routes: keptRoutes, comments: keptComments } = pruneRoutesAndComments(
          Array.isArray(table.routes) ? table.routes : [],
          Array.isArray(table.comments) ? table.comments : [],
          routeIds,
        );
        const pr = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/routes/${table.id || 'default'}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ ...table, id: table.id || 'default', routes: keptRoutes, comments: keptComments }),
        });
        if (pr.ok) removed.routes = routeIds;
        else errors.push(`routes: ${pr.status} ${await pr.text()}`);
      }
    }

    // 2. DATAGEN — delete selected datagen inputs + their group-level samples.
    for (const id of datagenIds) {
      const dr = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/inputs/${id}`, { method: 'DELETE', headers });
      if (dr.ok) removed.datagens.push(id);
      else errors.push(`datagen ${id}: ${dr.status}`);
    }
    // Delete the sample files those datagens used (named <datagenId>_<st>.log).
    // Owner = the LONGEST demo input id prefixing the name, so removing
    // demo_datagen_ocsf never takes demo_datagen_ocsf_pp's samples with it.
    if (datagenIds.length > 0) {
      const samples = await (await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/samples`, { headers })).json();
      const known = new Set(datagenIds);
      try {
        const ins = await (await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/inputs`, { headers })).json();
        for (const i of ins.items || []) if (isDemoInputId(String(i.id || ''))) known.add(String(i.id));
      } catch { /* only the selected ids are known */ }
      for (const s of samples.items || []) {
        const name = String(s.sampleName || '');
        const owner = demoSampleOwner(name, [...known]);
        if (owner && datagenIds.includes(owner)) {
          await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/samples/${encodeURIComponent(s.id)}`, { method: 'DELETE', headers });
        }
      }
    }

    // 3. PACKS — delete selected demo packs.
    for (const id of packIds) {
      const pr = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/packs/${id}`, { method: 'DELETE', headers });
      if (pr.ok) removed.packs.push(id);
      else errors.push(`pack ${id}: ${pr.status}`);
    }

    // 4. OUTPUTS — delete selected demo Cribl Lake outputs (after routes that
    //    referenced them are already gone).
    for (const id of outputIds) {
      const or = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/outputs/${id}`, { method: 'DELETE', headers });
      if (or.ok) removed.outputs.push(id);
      else errors.push(`output ${id}: ${or.status} ${await or.text()}`);
    }

    // Commit + deploy the removal.
    const commitResp = await fetch(`${CRIBL_ORG}/api/v1/version/commit`, {
      method: 'POST', headers,
      body: JSON.stringify({ message: `Clean up demo artifacts (${removed.routes.length} routes, ${removed.datagens.length} datagens, ${removed.packs.length} packs, ${removed.outputs.length} outputs)`, group }),
    });
    const commit = (await commitResp.json()).items?.[0]?.commit || 'unknown';
    await fetch(`${CRIBL_ORG}/api/v1/master/groups/${group}/deploy`, {
      method: 'PATCH', headers, body: JSON.stringify({ version: commit }),
    });

    sendJson(res, 200, { removed, errors, commit });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Failed to clean up demo artifacts' });
  }
}
