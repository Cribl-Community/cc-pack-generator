/** Standalone HTTP surface for config/sanitised-samples/. */
import {
  deleteSanitisedDoc,
  readSanitisedDoc,
  readSanitisedIndex,
  saveSanitisedDoc,
} from './sanitised-sample-library.mjs';

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

export async function handleSanitisedSamples(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const key = url.searchParams.get('key');
    if (key) return json(res, 200, { available: true, sample: await readSanitisedDoc(key) });
    const index = await readSanitisedIndex();
    return json(res, 200, { available: true, samples: index.samples });
  } catch (error) {
    return json(res, 500, { available: false, samples: [], error: error.message });
  }
}

export async function handleSanitisedSampleSave(req, res) {
  try {
    const input = await body(req);
    return json(res, 200, await saveSanitisedDoc(input.doc));
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
}

export async function handleSanitisedSampleDelete(req, res) {
  try {
    const input = await body(req);
    const keys = Array.isArray(input.keys) ? input.keys : [];
    if (!keys.length) return json(res, 400, { error: 'keys[] required' });
    const results = [];
    for (const key of keys) results.push(await deleteSanitisedDoc(key));
    return json(res, 200, { results });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}
