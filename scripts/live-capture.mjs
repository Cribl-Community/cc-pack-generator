import { CRIBL_ORG, getToken } from './cribl-auth.mjs';
import { invalidateSampleCache } from './sample-cache.mjs';

export async function handleLiveCapture(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { workerGroup, filter, maxEvents = 100, durationMs = 10000 } = JSON.parse(body);

    if (!workerGroup) {
      throw new Error('workerGroup is required');
    }

    const token = await getToken();

    // Use Cribl's system/capture endpoint — synchronous, waits for events, returns NDJSON
    const captureResp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/system/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: filter || 'true',
        maxEvents: Math.min(maxEvents, 500),
        duration: Math.min(Math.round(durationMs / 1000), 30),
      }),
    });

    if (!captureResp.ok) {
      const errText = await captureResp.text();
      let errMsg;
      try {
        const errObj = JSON.parse(errText);
        errMsg = errObj.message || errText;
      } catch {
        errMsg = errText;
      }
      throw new Error(errMsg);
    }

    // Response is NDJSON — one JSON object per line
    const rawText = await captureResp.text();
    const lines = rawText.trim().split('\n').filter(Boolean);

    const events = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // Return _raw if present, otherwise the full event as JSON string
        if (obj._raw) {
          events.push(obj._raw);
        } else {
          const { __criblEventType, __ctrlFields, __final, __cloneCount, __eventId, __inputId, ...fields } = obj;
          events.push(JSON.stringify(fields));
        }
      } catch {
        // Skip unparseable lines
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ events, count: events.length }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Live capture failed' }));
  }
}

export async function handleListSamples(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const group = url.searchParams.get('group');

  if (!group) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing ?group= parameter' }));
    return;
  }

  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/samples`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to list samples (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    const samples = (data.items || []).map(s => ({
      id: s.id,
      name: s.sampleName || s.id,
      size: s.size || 0,
      numEvents: s.numEvents || 0,
      // Cross-app sanitised-library metadata rides in the record's description.
      ...(s.description ? { description: s.description } : {}),
    }));

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ samples }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to list samples' }));
  }
}

export async function handleDownloadSample(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { workerGroup, sampleId } = JSON.parse(body);

    if (!workerGroup || !sampleId) {
      throw new Error('workerGroup and sampleId are required');
    }

    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/system/samples/${encodeURIComponent(sampleId)}/content`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to download sample (${resp.status}): ${errText}`);
    }

    const content = await resp.json();
    // content is a JSON array of event objects — extract _raw from each
    const events = (Array.isArray(content) ? content : []).map(evt => {
      if (evt._raw) return evt._raw;
      const { __criblEventType, __ctrlFields, __final, __cloneCount, ...fields } = evt;
      return JSON.stringify(fields);
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ events, count: events.length }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to download sample' }));
  }
}

/** Create or replace a sample at WORKER-GROUP scope (not inside a pack). */
export async function handleUploadGroupSample(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { workerGroup, sampleName, events, description } = JSON.parse(body || '{}');
    if (!workerGroup || !sampleName || !Array.isArray(events) || !events.length) {
      throw new Error('workerGroup, sampleName and events[] are required');
    }
    const token = await getToken();
    const base = `${CRIBL_ORG}/api/v1/m/${workerGroup}/system/samples`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const listed = await fetch(base, { headers });
    if (!listed.ok) throw new Error(`Failed to list group samples (${listed.status}): ${await listed.text()}`);
    const existing = ((await listed.json()).items || []).find(s => s.sampleName === sampleName);
    const payload = {
      sampleName,
      // Sanitised-library metadata (fingerprint/verification/provenance) — omitted for
      // a plain group sample upload.
      ...(typeof description === 'string' && description ? { description } : {}),
      context: {
        events: events.map(raw => ({ _raw: String(raw), _time: Date.now() / 1000 })),
      },
    };
    const url = existing?.id ? `${base}/${encodeURIComponent(existing.id)}` : base;
    const saved = await fetch(url, {
      method: existing?.id ? 'PATCH' : 'POST',
      headers,
      body: JSON.stringify(existing?.id ? { id: existing.id, ...payload } : payload),
    });
    if (!saved.ok) throw new Error(`Failed to upload group sample (${saved.status}): ${await saved.text()}`);
    const result = await saved.json().catch(() => ({}));
    const sampleId = existing?.id || result?.items?.[0]?.id || result?.id || sampleName;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sampleId }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to upload group sample' }));
  }
}

/** Delete a WORKER-GROUP scoped sample (used by the shared sanitised library). */
export async function handleDeleteGroupSample(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { workerGroup, sampleId } = JSON.parse(body || '{}');
    if (!workerGroup || !sampleId) throw new Error('workerGroup and sampleId are required');
    const token = await getToken();
    const url = `${CRIBL_ORG}/api/v1/m/${workerGroup}/system/samples/${encodeURIComponent(sampleId)}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`Failed to delete group sample (${resp.status}): ${await resp.text()}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to delete group sample' }));
  }
}

function toSampleEvents(rawEvents) {
  return rawEvents.map((evt) => {
    if (typeof evt === 'object' && evt !== null && evt._raw) {
      return { _raw: evt._raw, _time: evt._time || Date.now() / 1000 };
    }
    if (typeof evt === 'string') {
      return { _raw: evt, _time: Date.now() / 1000 };
    }
    return { _raw: JSON.stringify(evt), _time: Date.now() / 1000 };
  });
}

export async function handleGetPackSample(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const workerGroup = url.searchParams.get('group');
    const packId = url.searchParams.get('pack');
    const preferredName = url.searchParams.get('name') || '';
    if (!workerGroup || !packId) throw new Error('group and pack are required');

    const token = await getToken();
    const base = `${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/samples`;
    const headers = { Authorization: `Bearer ${token}` };
    const listResp = await fetch(base, { headers });
    if (!listResp.ok) throw new Error(`Failed to list pack samples (${listResp.status}): ${await listResp.text()}`);
    const listed = await listResp.json();
    const samples = listed?.items || [];
    // Prefer exact / substring match. Never fall back to samples[0] when a name
    // was requested — an unrelated pack sample (e.g. weblog.log) would silently
    // become the optimize baseline and produce junk scores.
    const sample = preferredName
      ? (samples.find(s => s.sampleName === preferredName)
        || samples.find(s => String(s.sampleName || '').includes(preferredName))
        || null)
      : samples[0];
    if (!sample) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sample: null }));
      return;
    }

    const contentResp = await fetch(`${base}/${encodeURIComponent(sample.id)}/content`, { headers });
    if (!contentResp.ok) throw new Error(`Failed to read pack sample (${contentResp.status}): ${await contentResp.text()}`);
    const content = await contentResp.json();
    const events = (Array.isArray(content) ? content : []).map(evt => {
      if (evt?._raw != null) return String(evt._raw);
      const { __criblEventType, __ctrlFields, __final, __cloneCount, ...fields } = evt || {};
      return JSON.stringify(fields);
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sample: { id: sample.id, name: sample.sampleName || sample.id, events } }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to get pack sample' }));
  }
}

export async function handleUploadPackSample(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { workerGroup, packId, sampleName, events } = JSON.parse(body);
    if (!workerGroup || !packId || !sampleName || !Array.isArray(events) || events.length === 0) {
      throw new Error('workerGroup, packId, sampleName, and events[] are required');
    }

    const token = await getToken();
    const base = `${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/samples`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const sampleBody = { sampleName, context: { events: toSampleEvents(events) } };

    // Stable pipeline sample names are reused on every optimize/re-run — POST
    // alone returns 409 when the name already exists. Upsert: PATCH by id when
    // present, otherwise POST.
    const listResp = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
    if (!listResp.ok) throw new Error(`Failed to list pack samples (${listResp.status}): ${await listResp.text()}`);
    const listed = await listResp.json();
    const existing = (listed?.items || []).find(s => s.sampleName === sampleName);

    let sampleId;
    if (existing?.id) {
      const patchResp = await fetch(`${base}/${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id: existing.id, ...sampleBody }),
      });
      if (!patchResp.ok) {
        const errText = await patchResp.text();
        throw new Error(`Failed to update pack sample (${patchResp.status}): ${errText}`);
      }
      sampleId = existing.id;
    } else {
      const resp = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify(sampleBody),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Failed to upload pack sample (${resp.status}): ${errText}`);
      }
      const uploaded = await resp.json();
      sampleId = uploaded?.items?.[0]?.id || uploaded?.id || sampleName;
    }

    // This pack's sample set just changed — drop the validator's cached ID and
    // content for it, or the next preview would score against the OLD sample.
    invalidateSampleCache(workerGroup, packId);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sampleId }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to upload pack sample' }));
  }
}

export async function handleDeletePackSample(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { workerGroup, packId, sampleId } = JSON.parse(body);
    if (!workerGroup || !packId || !sampleId) {
      throw new Error('workerGroup, packId, and sampleId are required');
    }

    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(sampleId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to delete pack sample (${resp.status}): ${errText}`);
    }

    invalidateSampleCache(workerGroup, packId);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to delete pack sample' }));
  }
}

export async function handleListInputs(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const group = url.searchParams.get('group');

  if (!group) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing ?group= parameter' }));
    return;
  }

  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/system/inputs`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to list inputs (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    const inputs = (data.items || []).map(i => ({
      id: i.id,
      type: i.type || '',
      description: i.description || '',
      disabled: i.disabled || false,
    })).filter(i => !i.disabled);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ inputs }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to list inputs' }));
  }
}
