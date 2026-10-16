import { ghRest } from '../src/github-rest.ts';
import { aiSampleKeyToFile } from '../src/sample-library.ts';
import { parseSanitisedSampleDoc, sanitisedSampleIndexRow } from '../src/sanitised-sample-store.ts';
import { assertSuitableSanitisedSampleRepo } from '../src/sanitised-sample-github.ts';
import { env } from './cribl-auth.mjs';

const FOLDER = 'shared-sanitised-samples';

async function put(repo, branch, token, path, value, message, sha) {
  const body = {
    message, branch,
    content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString('base64'),
    ...(sha ? { sha } : {}),
  };
  return ghRest(`/repos/${repo}/contents/${path}`, { token, method: 'PUT', body, conditional: false });
}

async function getJsonWithSha(repo, branch, token, path) {
  const response = await ghRest(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
    token, conditional: false,
  });
  if (response.status === 404) return { sha: null, value: null };
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${response.text.slice(0, 160)}`);
  const meta = JSON.parse(response.text);
  return {
    sha: meta.sha || null,
    value: JSON.parse(Buffer.from(meta.content || '', 'base64').toString('utf8')),
  };
}

export async function publishSanitisedSampleDirect({ repo, branch = FOLDER, goldenRepo, doc, token = env('SANITISED_SAMPLE_TOKEN') }) {
  assertSuitableSanitisedSampleRepo(repo, branch, goldenRepo);
  if (!token) throw new Error('SANITISED_SAMPLE_TOKEN is not configured.');
  const parsed = parseSanitisedSampleDoc(doc);
  if (!parsed) throw new Error('Invalid sanitised sample document.');
  const path = `${FOLDER}/${aiSampleKeyToFile(parsed.key)}`;
  const created = await put(repo, branch, token, path, parsed, `Add sanitised sample ${parsed.key}`, null);
  if (created.status === 422) return { published: false, reason: 'A sample with this key already exists (first writer wins).' };
  if (!created.ok) throw new Error(`GitHub ${created.status}: ${created.text.slice(0, 160)}`);

  const indexPath = `${FOLDER}/index.json`;
  const current = await getJsonWithSha(repo, branch, token, indexPath);
  const rows = Array.isArray(current.value?.samples) ? current.value.samples.filter(row => row.key !== parsed.key) : [];
  rows.push(sanitisedSampleIndexRow(parsed));
  rows.sort((a, b) => a.key.localeCompare(b.key));
  const indexed = await put(repo, branch, token, indexPath, { version: 1, samples: rows },
    `Index sanitised sample ${parsed.key}`, current.sha);
  if (!indexed.ok) throw new Error(`Sample file was created but index update failed (${indexed.status}).`);
  return { published: true };
}

export async function testSanitisedSampleAccessDirect({
  repo, branch = FOLDER, goldenRepo, token = env('SANITISED_SAMPLE_TOKEN'),
}) {
  assertSuitableSanitisedSampleRepo(repo, branch, goldenRepo);
  if (!token) return { ok: false, message: 'SANITISED_SAMPLE_TOKEN is not configured.' };
  const response = await ghRest(`/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
    token, conditional: false,
  });
  return response.ok
    ? { ok: true, message: 'Repository and branch are reachable with the saved sample token.' }
    : { ok: false, message: `GitHub ${response.status}: ${response.text.slice(0, 120)}` };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

export async function handleSanitisedSamplePublish(req, res) {
  try {
    const input = await readBody(req);
    send(res, 200, await publishSanitisedSampleDirect({
      repo: input.repo,
      branch: input.branch,
      goldenRepo: input.goldenRepo,
      doc: input.doc,
      token: env('SANITISED_SAMPLE_TOKEN'),
    }));
  } catch (error) {
    send(res, 400, { published: false, error: error.message });
  }
}

export async function handleSanitisedSampleTest(req, res) {
  try {
    const input = await readBody(req);
    const result = await testSanitisedSampleAccessDirect({
      repo: input.repo,
      branch: input.branch,
      goldenRepo: input.goldenRepo,
      token: env('SANITISED_SAMPLE_TOKEN'),
    });
    send(res, result.ok ? 200 : 400, result);
  } catch (error) {
    send(res, 400, { ok: false, message: error.message });
  }
}
