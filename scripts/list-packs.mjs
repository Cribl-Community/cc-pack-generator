import { CRIBL_ORG, getToken } from './cribl-auth.mjs';

export async function handleListGroups(req, res) {
  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/master/groups`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await resp.json();
    // Best-effort connected-worker count per group so the live-capture picker can hide
    // groups with no workers (capture would return nothing there).
    const counts = {};
    try {
      const wResp = await fetch(`${CRIBL_ORG}/api/v1/master/workers`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const wData = await wResp.json();
      for (const w of wData.items || []) {
        const g = w.group || 'unknown';
        counts[g] = (counts[g] || 0) + 1;
      }
    } catch { /* leave counts empty → groups show as 0 workers */ }
    const groups = (data.items || []).map(g => ({
      id: g.id,
      name: g.name || g.id,
      description: g.description || '',
      type: g.type || 'stream',
      workerCount: counts[g.id] || 0,
    }));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ groups }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to list groups' }));
  }
}

export async function handleListPacks(req, res) {
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
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/packs`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await resp.json();
    const packs = (data.items || []).map(p => ({
      id: p.id,
      displayName: p.displayName || p.id,
      version: p.version || '1.0.0',
    }));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ packs }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to list packs' }));
  }
}

export async function handleListPackPipelines(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const group = url.searchParams.get('group');
  const pack = url.searchParams.get('pack');
  if (!group || !pack) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing ?group= and ?pack=' }));
    return;
  }
  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/p/${pack}/pipelines`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    const pipelines = (data.items || []).map(p => ({
      id: p.id,
      description: p.conf?.description || p.description || '',
    }));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pipelines }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to list pipelines' }));
  }
}

export async function handleGetPackPipeline(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const group = url.searchParams.get('group');
  const pack = url.searchParams.get('pack');
  const pipeline = url.searchParams.get('pipeline');
  if (!group || !pack || !pipeline) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing ?group=, ?pack=, and ?pipeline=' }));
    return;
  }
  try {
    const token = await getToken();
    const resp = await fetch(`${CRIBL_ORG}/api/v1/m/${group}/p/${pack}/pipelines/${pipeline}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    const item = (data.items || [])[0];
    if (!item) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Pipeline ${pipeline} not found` }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pipeline: { id: item.id, conf: item.conf } }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Failed to get pipeline' }));
  }
}
