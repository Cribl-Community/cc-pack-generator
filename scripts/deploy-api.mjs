import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRIBL_ORG, getToken } from './cribl-auth.mjs';
import { getLookupsForSourcetype } from './lookup-bundler.mjs';
import { invalidateSampleCache } from './sample-cache.mjs';
import { normalizeRouteFinality, packRoutesFromRouteYml } from '../src/route-model.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// HTTP statuses worth another attempt: a throttle, or a leader/gateway that was
// momentarily unable to serve the write. Cribl answers 4xx for genuine
// validation problems, so those are NEVER retried — a 400 "Invalid Pipeline ID"
// must surface immediately, not three seconds later.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Retry BOTH thrown socket errors and retryable HTTP statuses. Status was the
// gap: in the build-446 batch a single leader 500 permanently failed a row whose
// pipeline had in fact been written correctly (fortigateutm-cim, 16 functions,
// previewing full CIM output). The config API is id-keyed, so re-sending an
// id-bearing POST/PATCH is safe — a duplicate create comes back as a conflict,
// which the callers now resolve by PATCHing instead.
export async function fetchRetry(url, opts, retries = 3) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, opts);
      if (!RETRYABLE_STATUS.has(resp.status) || i === retries) return resp;
      // Honour Retry-After on a throttle, else linear backoff.
      const after = Number(resp.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 15000) : (i + 1) * 1000;
      console.warn(`[deploy] HTTP ${resp.status} (attempt ${i + 1}/${retries + 1}) on ${url} — retrying in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    } catch (err) {
      lastErr = err;
      const msg = err?.message || '';
      const transient = msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('UND_ERR_SOCKET');
      if (!transient || i === retries) throw err;
      console.warn(`[deploy] transient error (attempt ${i + 1}/${retries + 1}): ${msg} — retrying in ${(i + 1)}s`);
      await new Promise(r => setTimeout(r, (i + 1) * 1000));
    }
  }
  if (lastErr) throw lastErr;
}

export async function handleDeploy(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const payload = JSON.parse(body);
    const { packId, pipelineId = 'transform', workerGroup, packageJson, routeYml, pipelineYml, pipelineConf, readme, mode = 'new', deferDeploy = false } = payload;
    console.log(`[deploy] mode=${mode}, packId=${packId}, pipelineId=${pipelineId}`);
    console.log(`[deploy] packageJson.version=${packageJson?.version}, packageJson.author=${packageJson?.author}`);

    const token = await getToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // Build datagen files if requested
    let datagenConf = null;
    let datagenData = null;
    let datagenFileName = null;

    if (payload.createDatagen && payload.sampleData && payload.sampleData.length > 0) {
      datagenFileName = `${pipelineId}_events.log`;
      datagenData = payload.sampleData.map(evt => {
        let raw;
        if (typeof evt === 'object' && evt !== null && evt._raw) raw = evt._raw;
        else if (typeof evt === 'string') raw = evt;
        else raw = JSON.stringify(evt);
        // Inject timestamp template so datagen replays with fresh timestamps
        try {
          const parsed = JSON.parse(raw);
          if (parsed._time) parsed._time = '${timestamp:%s.%L}';
          if (parsed.timestamp) parsed.timestamp = '${timestamp:%s.%L}';
          raw = JSON.stringify(parsed).replace(/"(\$\{timestamp:%s\.%L\})"/g, '$1');
        } catch { /* not JSON — use as-is */ }
        return raw;
      }).join('\n');

      datagenConf = JSON.stringify({
        [`${pipelineId}_datagen`]: {
          disabled: true,
          type: 'datagen',
          stoppedBehavior: 'manual',
          sendToRoutes: true,
          preprocess: { disabled: true, cmd: '' },
          throttleRatePerSec: 10,
          pqEnabled: false,
          streamtags: [],
          connections: [],
          metadata: [],
          fields: [{ name: 'sourcetype', value: `'${payload.sourcetype || 'unknown'}'` }],
          datagenFile: datagenFileName,
        },
      }, null, 2);
    }

    if (mode === 'new') {
      // Delete existing pack (ignore errors, but retry transient fetch drops so
      // a blip here doesn't abort the whole deploy before anything is created).
      await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/packs/${packId}`, {
        method: 'DELETE',
        headers,
      }).catch(() => {});

      // The pack's default route MUST reference the pipeline id we actually
      // deploy. buildRouteYml() guesses `<sourcetype>_to_<fmt>`, but callers
      // (batch) may deploy a different id (e.g. the CSV pipeline_name
      // `cisco_asa_cim`). A route pointing at a non-existent pipeline passes the
      // .crbl import but makes the NEXT route PATCH (add-pipeline) fail with
      // "Invalid Pipeline ID". Rewrite the route's pipeline: to the real id.
      let effectiveRouteYml = routeYml;
      if (typeof routeYml === 'string' && pipelineId) {
        effectiveRouteYml = routeYml.replace(/^(\s*pipeline:\s*).+$/m, `$1${pipelineId}`);
      }

      // Create pack via tar upload — build .crbl in memory
      const { createPackTar } = await import('./pack-tar.mjs');
      const tarBuffer = await createPackTar({
        packId, pipelineId, packageJson, routeYml: effectiveRouteYml, pipelineYml,
        sampleId: payload.sampleId, samplesYml: payload.samplesYml, sampleData: payload.sampleData,
        readme, datagenConf, datagenData, datagenFileName, breakerYml: payload.breakerYml,
      });

      const uploadResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/packs?filename=${packId}.crbl`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: tarBuffer,
      });
      const uploadResult = await uploadResp.json();
      const source = uploadResult.source;

      // Install pack (fetchRetry — a transient 'fetch failed' here otherwise
      // fails the whole deploy after the tar already uploaded).
      await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/packs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source }),
      });
    }

    // PATCH the pack's route table, retrying "Invalid Pipeline ID" — that error
    // is the read-after-write race: the leader's route-validator hasn't picked up
    // the just-written pipeline yet (it can lag more than 10s under parallel batch
    // load, on a DIFFERENT surface than GET /pipelines). Up to ~30s of backoff.
    const patchPackRoutes = async (routes) => {
      let routeErr = '';
      const delays = [1000, 2000, 3000, 4000, 5000, 6000, 8000];  // ~29s total
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        let routeUpdateResp;
        try {
          routeUpdateResp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/routes/default`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ id: 'default', routes }),
          });
        } catch (netErr) {
          routeErr = netErr?.message || 'fetch failed';
          if (attempt < delays.length) { await new Promise((r) => setTimeout(r, delays[attempt])); continue; }
          break;
        }
        if (routeUpdateResp.ok) { routeErr = ''; break; }
        routeErr = await routeUpdateResp.text();
        if (!routeErr.includes('Invalid Pipeline ID')) break;  // non-race error → stop
        if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
      }
      if (routeErr) throw new Error(`Route update failed: ${routeErr}`);
    };

    // 5. Push pipeline into the pack
    const pipelinePayload = {
      id: pipelineId,
      conf: pipelineConf,
    };

    if (mode === 'add-pipeline') {
      // POST creates a new pipeline in an existing pack
      let pipelineResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines`, {
        method: 'POST',
        headers,
        body: JSON.stringify(pipelinePayload),
      });
      if (!pipelineResp.ok) {
        const errText = await pipelineResp.text();
        // Auto-recover: the pipeline is ALREADY there, so update it instead of
        // failing the row. This is the normal case, not an edge case — the
        // 3-stage builder PATCHes each candidate stage conf into the pack while
        // it scores, so by the time this final write runs the pipeline usually
        // exists (build 446: `Wineventlog_CIM` was left as its 3-function
        // extraction stage and the row reported "pipeline already exists").
        // `patchPipeline` has always done POST-then-PATCH; this path did not.
        if (pipelineResp.status === 409 || /already exists/i.test(errText)) {
          console.log(`[deploy] Pipeline ${pipelineId} exists in ${packId} — PATCHing instead of creating.`);
          pipelineResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, {
            method: 'PATCH', headers, body: JSON.stringify(pipelinePayload),
          });
          if (!pipelineResp.ok) {
            const patchErr = await pipelineResp.text();
            throw new Error(`Pipeline update failed (${pipelineResp.status}): ${patchErr}`);
          }
        }
        // Auto-recover: if pack doesn't exist (404 Unknown Pack), create it and retry
        else if (pipelineResp.status === 404 && errText.includes('Unknown Pack')) {
          console.log(`[deploy] Pack ${packId} not found — creating and retrying...`);
          await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/packs`, {
            method: 'POST', headers,
            body: JSON.stringify({ id: packId }),
          });
          await new Promise((r) => setTimeout(r, 2000));
          pipelineResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines`, {
            method: 'POST', headers,
            body: JSON.stringify(pipelinePayload),
          });
          if (!pipelineResp.ok) {
            const retryErr = await pipelineResp.text();
            throw new Error(`Pipeline create failed (${pipelineResp.status}): ${retryErr}`);
          }
        } else {
          throw new Error(`Pipeline create failed (${pipelineResp.status}): ${errText}`);
        }
      }
      // Read-after-write race: the POST returns 200 but the leader may not have
      // registered the pipeline yet. Poll GET /pipelines until it lists the id
      // (fast, cheap first signal); the authoritative guard is the route-PATCH
      // retry loop below, since the route-validator lags this list.
      for (let attempt = 0; attempt < 10; attempt++) {
        const chk = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines`, { headers });
        if (chk.ok) {
          const ids = ((await chk.json())?.items || []).map((p) => p.id);
          if (ids.includes(pipelineId)) break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      // PATCH updates the pipeline created by .crbl import
      let pipelineResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(pipelinePayload),
      });
      // Mirror of the add-pipeline conflict fallback: if the import did NOT
      // create the pipeline, PATCH 404s — create it rather than failing the row.
      if (pipelineResp.status === 404) {
        console.log(`[deploy] Pipeline ${pipelineId} absent from ${packId} — creating instead of patching.`);
        pipelineResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines`, {
          method: 'POST', headers, body: JSON.stringify(pipelinePayload),
        });
      }
      if (!pipelineResp.ok) {
        const errText = await pipelineResp.text();
        throw new Error(`Pipeline push failed (${pipelineResp.status}): ${errText}`);
      }
      // The DELETE above fails (500) while a master route still points at the
      // pack, and then the upload does not replace it: the OLD route table stays.
      // Write route.yml's routes explicitly so 'new' always ends with exactly
      // the caller's table (seLab 2026-10-02: the demo packs kept `true`).
      const packRoutes = typeof routeYml === 'string' ? packRoutesFromRouteYml(routeYml, pipelineId) : [];
      if (packRoutes.length) await patchPackRoutes(packRoutes);
    }

    // 5. Add route to the pack's routes (append to existing routes for 'add-pipeline' mode)
    if (mode === 'add-pipeline') {
      const routeResp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/routes`, {
        headers,
      });
      let existingRoutes = [];
      if (routeResp.ok) {
        const routeData = await routeResp.json();
        const routeItem = routeData?.items?.[0] || routeData;
        existingRoutes = routeItem?.routes || [];
      }

      // Cribl validates EVERY route's pipeline on PATCH — a single stale route
      // pointing at a non-existent pipeline (e.g. a template's guessed
      // `<st>_to_<fmt>` that was never created) rejects the whole update with
      // "Invalid Pipeline ID". Drop any route whose pipeline no longer exists in
      // the pack so appending the new one can't be sunk by prior bad state.
      let validPipelineIds = null;
      try {
        const plResp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines`, { headers });
        if (plResp.ok) {
          const pls = (await plResp.json())?.items || [];
          validPipelineIds = new Set(pls.map((p) => p.id).concat(['devnull', 'main', 'passthru']));
        }
      } catch { /* if we can't list, don't prune (fail open) */ }
      if (validPipelineIds) {
        const before = existingRoutes.length;
        existingRoutes = existingRoutes.filter((r) => !r?.pipeline || validPipelineIds.has(r.pipeline) || r.pipeline === pipelineId);
        if (existingRoutes.length !== before) {
          console.warn(`[deploy] pruned ${before - existingRoutes.length} route(s) referencing a missing pipeline in ${packId}`);
        }
      }

      const newRoute = {
        id: pipelineId,
        name: `${pipelineId} Route`,
        // Positional — normalizeRouteFinality below owns this value for the whole
        // table. This handler used to hardcode `true` and ignore payload.routeFinal
        // (which the iframe path honours), so every multi-pipeline pack deployed
        // from standalone got a first route that swallowed the event.
        final: true,
        disabled: false,
        pipeline: pipelineId,
        description: `Route for ${pipelineId}`,
        enableOutputExpression: false,
        filter: payload.routeFilter || `sourcetype=='${payload.sourcetype || 'unknown'}'`,
        clones: [],
        output: 'default',
      };

      // Don't duplicate a route for this pipeline if one already exists.
      const deduped = existingRoutes.filter((r) => r?.id !== pipelineId && r?.pipeline !== pipelineId);
      // Only the LAST route may be final — see src/route-model.ts. The appended
      // route goes last, so every route above it is opened up, including ones a
      // previous add-pipeline call (or the pack's own route.yml) wrote as final.
      const updatedRoutes = normalizeRouteFinality([...deduped, newRoute]);
      // patchPackRoutes retries the validator's read-after-write lag.
      await patchPackRoutes(updatedRoutes);
    }

    // 6. Create datagen source if requested
    if (payload.createDatagen && payload.sampleData && payload.sampleData.length > 0) {
      console.log('[deploy] Creating datagen source...');
      const datagenId = `${pipelineId}_datagen`;
      const datagenFileName = `${pipelineId}_events.log`;

      // Upload dedicated datagen file with timestamp templates
      const datagenEvents = payload.sampleData.map(evt => {
        let raw;
        if (typeof evt === 'object' && evt !== null && evt._raw) raw = evt._raw;
        else if (typeof evt === 'string') raw = evt;
        else raw = JSON.stringify(evt);
        // Inject timestamp template: replace _time/timestamp values with rolling token
        try {
          const parsed = JSON.parse(raw);
          if (parsed._time) parsed._time = '${timestamp:%s.%L}';
          if (parsed.timestamp) parsed.timestamp = '${timestamp:%s.%L}';
          raw = JSON.stringify(parsed).replace(/"(\$\{timestamp:%s\.%L\})"/g, '$1');
        } catch { /* not JSON — prepend timestamp template */ }
        return { _raw: raw, _time: Date.now() / 1000 };
      });
      // Datagen files must be at group level with isTemplate:true for the worker to find them
      const dgSampleResp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/system/samples`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sampleName: datagenFileName, isTemplate: true, tsTemplateField: '', context: { events: datagenEvents } }),
      });
      if (!dgSampleResp.ok) {
        console.log(`[deploy] datagen file upload: ${dgSampleResp.status} ${await dgSampleResp.text()}`);
      }

      // Datagen source must be at group level (pack-scoped sources can't find the file)
      const datagenSampleRef = datagenFileName.replace(/\.log$/, '');
      const datagenResp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/system/inputs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: datagenId,
          type: 'datagen',
          disabled: true,
          stoppedBehavior: 'manual',
          sendToRoutes: true,
          throttleRatePerSec: 10,
          pqEnabled: false,
          streamtags: [],
          connections: [],
          metadata: [],
          fields: [{ name: 'sourcetype', value: `'${payload.sourcetype || 'unknown'}'` }],
          samples: [{ eventsPerSec: 10, sample: datagenSampleRef }],
          description: `Datagen for ${pipelineId}`,
        }),
      });
      if (!datagenResp.ok) {
        console.log(`[deploy] datagen source: ${datagenResp.status} ${await datagenResp.text()}`);
      }
    }

    // 7. Upload sample data if provided
    if (payload.sampleData && payload.sampleData.length > 0) {
      // Sample named by sourcetype (destination-independent, one per pack).
      const sampleName = payload.sampleName || (payload.sourcetype ? `${payload.sourcetype}_sample.log` : `${pipelineId}_sample.log`);
      const events = payload.sampleData.map(evt => {
        // structuredSample (mirrors src/api.ts): the events are already-processed
        // upstream OUTPUT, exactly as emitted — keep every field (with or without
        // a `_raw`), minus Cribl control fields. Otherwise reduce to _raw/_time
        // (vendor text to parse).
        if (payload.structuredSample && typeof evt === 'object' && evt !== null) {
          const { __criblEventType, __ctrlFields, __final, __cloneCount, __id, __packId, cribl_pipe: _cribl_pipe, cribl_breaker: _cribl_breaker, ...fields } = evt;
          return { ...fields, _time: evt._time || Date.now() / 1000 };
        }
        if (typeof evt === 'object' && evt !== null && evt._raw) {
          return { _raw: evt._raw, _time: evt._time || Date.now() / 1000 };
        }
        if (typeof evt === 'string') {
          return { _raw: evt, _time: Date.now() / 1000 };
        }
        return { _raw: JSON.stringify(evt), _time: Date.now() / 1000 };
      });
      // The sample name is deterministic per sourcetype+format, so a re-run /
      // add-pipeline reuses the SAME name. A bare POST returns 409 on a name
      // collision and KEEPS the old sample — the post-deploy quality flow then
      // scores the new pipeline against that stale sample (build 586 bug).
      // Upsert: PATCH the existing sample id so the fresh events overwrite it.
      let existingSampleId = null;
      const listResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/samples`, { headers }).catch(() => null);
      if (listResp && listResp.ok) {
        const listBody = await listResp.json().catch(() => ({}));
        const match = (listBody.items || []).find(s => s.sampleName === sampleName);
        if (match && match.id) existingSampleId = match.id;
      }
      const sampleResp = existingSampleId
        ? await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(existingSampleId)}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ id: existingSampleId, sampleName, context: { events } }),
          })
        : await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/samples`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ sampleName, context: { events } }),
          });
      if (!sampleResp.ok) {
        console.log(`[deploy] sample upload warning: ${sampleResp.status} ${await sampleResp.text()}`);
      }
      // Deploy replaces this pack's sample, and the post-deploy quality flow
      // reads it back immediately — drop the validator's cache for this pack so
      // it can't score the new pipeline against the previous sample.
      invalidateSampleCache(workerGroup, packId);
    }

    // 7b. Bundle golden lookups for this sourcetype into the pack's data/lookups/
    // so lookup-driven parsing resolves at runtime. This ships the FULL lookup
    // coverage (e.g. all 169 ASA codes), not just what the samples contained.
    // Prefer lookups passed in the payload (the frontend fetched them and both
    // deploy paths stay consistent); fall back to reading from disk by sourcetype.
    const bundledLookups = (Array.isArray(payload.referenceLookups) && payload.referenceLookups.length > 0)
      ? payload.referenceLookups
      : getLookupsForSourcetype(payload.sourcetype);
    for (const lk of bundledLookups) {
      // POST creates a new lookup; if it already exists (pack re-deploy / add-
      // pipeline), POST fails — fall back to PATCH so the content is UPDATED
      // (otherwise a stale lookup persists and extraction silently breaks).
      let lkResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/lookups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: lk.file, content: lk.content, description: lk.description }),
      });
      if (!lkResp.ok) {
        lkResp = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/lookups/${encodeURIComponent(lk.file)}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ id: lk.file, content: lk.content, description: lk.description }),
        });
      }
      if (!lkResp.ok) {
        console.log(`[deploy] lookup ${lk.file} warning: ${lkResp.status} ${await lkResp.text()}`);
      } else {
        console.log(`[deploy] bundled lookup ${lk.file} (${lk.rows} rows)`);
      }
    }

    // 7. Commit + Deploy — SKIPPED when deferDeploy is set. The 3-stage
    // experiment PATCHes+previews many candidate pipelines into ONE pack and
    // only wants a single commit+deploy at the very end (via /commit-deploy),
    // instead of a full commit/deploy cycle per candidate (slow + race-prone).
    let commit = 'deferred';
    let version = 'deferred';
    if (!deferDeploy) {
      const commitMsg = mode === 'new' ? `Deploy pack ${packId}` : `Add pipeline ${pipelineId} to pack ${packId}`;
      const commitResp = await fetchRetry(`${CRIBL_ORG}/api/v1/version/commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: commitMsg, group: workerGroup }),
      });
      const commitResult = await commitResp.json();
      commit = commitResult.items?.[0]?.commit || 'unknown';

      const deployResp = await fetchRetry(`${CRIBL_ORG}/api/v1/master/groups/${workerGroup}/deploy`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ version: commit }),
      });
      const deployResult = await deployResp.json();
      version = deployResult.items?.[0]?.configVersion || commit;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      packId,
      pipelineId,
      commit,
      version,
      mode,
      deferred: deferDeploy,
      bundledLookups: bundledLookups.map(l => ({ file: l.file, rows: l.rows })),
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Deploy failed' }));
  }
}

// PATCH a pipeline's conf into an EXISTING pack — no pack recreate, no commit,
// no deploy. Used by the 3-stage experiment to swap candidate pipelines into a
// single pack for preview/scoring. Polls until the leader lists the pipeline so
// the immediately-following preview transforms with the new conf.
export async function handlePatchPipeline(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { packId, pipelineId, workerGroup, pipelineConf } = JSON.parse(body);
    if (!packId || !pipelineId || !workerGroup || !pipelineConf) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'packId, pipelineId, workerGroup, pipelineConf required' }));
    }
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const payload = JSON.stringify({ id: pipelineId, conf: pipelineConf });
    // POST creates; if it already exists, PATCH updates.
    let r = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines`, { method: 'POST', headers, body: payload });
    if (!r.ok) {
      r = await fetchRetry(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, { method: 'PATCH', headers, body: payload });
    }
    if (!r.ok) {
      const txt = await r.text();
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: `pipeline write failed (${r.status}): ${txt.slice(0, 200)}` }));
    }
    // Settle by VERIFYING, not by a blind delay: poll GET until the persisted
    // conf has the function count we just wrote. A fixed 600ms was racy — the
    // following preview could read the PREVIOUS stage's conf, which made the
    // 3-stage report show the same event for every stage. Confirm-then-return.
    const wantCount = Array.isArray(pipelineConf?.functions) ? pipelineConf.functions.length : -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(rz => setTimeout(rz, 250));
      try {
        const g = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, { headers });
        if (g.ok) {
          const j = await g.json();
          const conf = j?.items?.[0]?.conf || j?.conf;
          const got = Array.isArray(conf?.functions) ? conf.functions.length : -2;
          if (wantCount < 0 || got === wantCount) break;
        }
      } catch { /* keep polling */ }
    }
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, packId, pipelineId }));
  } catch (err) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'patch-pipeline failed' }));
  }
}

// Commit + deploy a worker group ONCE. Called at the end of the 3-stage run
// after all the deferred PATCHes, so the pack goes live in a single cycle.
export async function handleCommitDeploy(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { workerGroup, message } = JSON.parse(body);
    if (!workerGroup) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'workerGroup required' }));
    }
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const commitResp = await fetchRetry(`${CRIBL_ORG}/api/v1/version/commit`, {
      method: 'POST', headers,
      body: JSON.stringify({ message: message || `Deploy ${workerGroup}`, group: workerGroup }),
    });
    const commit = (await commitResp.json()).items?.[0]?.commit || 'unknown';
    const deployResp = await fetchRetry(`${CRIBL_ORG}/api/v1/master/groups/${workerGroup}/deploy`, {
      method: 'PATCH', headers, body: JSON.stringify({ version: commit }),
    });
    const version = (await deployResp.json()).items?.[0]?.configVersion || commit;
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ commit, version }));
  } catch (err) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'commit-deploy failed' }));
  }
}
