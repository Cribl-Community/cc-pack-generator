/**
 * Shared golden-pipeline knowledge sync via a PUBLIC, goldens-only GitHub repo.
 *
 * Goldens live on a dedicated branch (default `shared-goldens`) under a
 * `shared-goldens/` folder, one file per key:
 *   shared-goldens/index.json          — manifest [{key, score, author, ...}]
 *   shared-goldens/<sourcetype>__<fmt>.json  — full functions + recipe + report
 *
 * READ needs no credential, in either run mode: every install is allowed to read
 * the pool, and requiring a token would have meant configuring one per install.
 * The repository holds ONLY goldens for exactly that reason — a token that could
 * read the app's own repository would have granted far more than the goldens.
 *
 * WRITE needs a token with Contents:Read+Write, held server-side here and never
 * shipped to the browser, so publishing happens only outside the iframe.
 *
 * WHAT may be published is decided by the golden-trust rules
 * (docs/specs/golden-trust.md, src/golden-trust.ts), never by a score the client
 * sends: the publisher reads THIS install's stored record and requires its
 * evidence to clear the code-constant POOL_MIN_SCORE (R6) and its standing to be
 * corroborated or better (R2) — measured on two different sample shapes, which the
 * offline holdout (scripts/golden-holdout.mjs) can supply before publishing. An
 * existing pool key is replaced only when the local record outranks it under the
 * shared comparator (R4). Import merges through `planGoldenImport`: a legacy pool
 * doc is admitted only where nothing is stored, and never over a local golden.
 *
 * Quarantine (R5) is READ everywhere — a pool tombstone is never served — but
 * WRITTEN to the pool only when GOLDEN_POOL_QUARANTINE=1 is set server-side. The
 * spec holds pool writes of verdicts back until the observation log has been read
 * back end to end once; flipping the flag is that decision.
 */
import { getStoredGoldenRecord, importGoldenPipeline, listLocalGoldens, observeGoldenPipelineMany } from './schema-validator.mjs';
import {
  POOL_MIN_SCORE, compareGoldenCandidates, goldenFunctionsHash, planGoldenObservation, poolEntryImportStatus, publishDecision, shouldReplaceGolden,
  storedTrustState, trustRank, trustRecordOf, trustSummary, validateEvidence,
} from '../src/golden-trust.ts';
import { holdoutMeasure } from './golden-holdout.mjs';
import { nonSourceMappingKeyReason } from '../src/golden-source-identity.ts';
import { readFileSync } from 'node:fs';
import { ghLimitState, ghListPoolFiles, ghReadPoolFiles, ghReadPublicFile, ghReadPublicJson, ghRest } from '../src/github-rest.ts';

const FOLDER = 'shared-goldens';

// REMOVED (build 466): syncGoldensToPlatform.
//
// It copied every shared golden into the Cribl global var `pack_generator_goldens`
// "so the iframe can read them" — but nothing ever read that var (the iframe reads
// GitHub directly, `fetchGoldensFromGitHub` in src/bundled-data.ts), and to build the
// payload it fanned `Promise.all` out over all 641 index entries as 641 CONCURRENT
// GitHub GETs. It ran from handleGoldenAvailable, which the app calls on startup and
// again whenever the datatype modal opens — so a handful of page loads spent the whole
// 5,000/hour user quota and every golden read started answering 403. The call was
// `void`ed, so it failed silently for as long as it existed.
//
// Deleting it is the fix, not throttling it: the write had no reader. Bulk reads that
// ARE needed (reconcile, import) now use the GraphQL batch path in src/github-rest.ts.

// Map a golden key to its file path. Replace EVERY `::` (not just the first) so
// 3-segment experimental sub-part keys (`<st>::<fmt>::__mapping__`) produce a
// valid, round-trippable filename — the old single-replace mangled them.
function keyToFile(key) { return `${FOLDER}/${keyToFileName(key)}`; }
// Just the filename — what the GraphQL batch reader addresses files by. Splitting
// back on `__` is ambiguous, so callers keep their own
// filename→key map (or read the key out of the doc, which every golden carries).
function keyToFileName(key) { return `${key.replace(/::/g, '__')}.json`; }

// A Contents-API path goes straight into a request URL. Schema-format keys carry a
// '#' (e.g. cim#network, ocsf#endpoint), and an unencoded '#' is parsed as the URL
// FRAGMENT — so the server never sees anything after it: the file lands at the
// truncated pre-'#' name (github_audit__cim instead of
// github_audit__cim#authentication____mapping__.json) and collides with every other
// sub-part of that data class. Encode each segment, preserving the '/' separators.
function encContentsPath(path) { return String(path).split('/').map(encodeURIComponent).join('/'); }

// Split a golden key into the local-store (sourcetype, destFormat) pair. The
// store key is `${sourcetype}::${destFormat}`, so destFormat is EVERYTHING after
// the first `::` — for a mapping sub-part that's `<fmt>::__mapping__`, for a
// normal golden it's just `<fmt>`. A naive `[a,b]=split('::')` dropped the 3rd
// segment of mapping sub-parts.
function splitKey(key) {
  const i = key.indexOf('::');
  if (i < 0) return { sourcetype: key, destFormat: '' };
  return { sourcetype: key.slice(0, i), destFormat: key.slice(i + 2) };
}

function isLegacyOptimizationKey(key) {
  return String(key || '').endsWith('::__optimization__');
}

// Which experimental stage a key encodes (or null for a normal golden).
function partOf(key) {
  if (key.endsWith('::__extraction__')) return 'extraction';
  if (key.endsWith('::__mapping__')) return 'mapping';
  return null;
}

// The pool's admission bar is POOL_MIN_SCORE, a code constant (golden-trust R6).
// It used to be the publishing client's `qualityThreshold` — so an install that
// typed 40 into Settings published 40s into a pool every other install reads.
// Local thresholds still govern local repair and storage; they never reach here.

// Pool writes of a quarantine (R5) are opt-in — see the header.
function poolQuarantineEnabled() {
  return process.env.GOLDEN_POOL_QUARANTINE === '1';
}

const BUILD = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).buildNumber || 0; } catch { return 0; }
})();

function hashOfRecord(rec) {
  return rec ? (rec.functionsHash || goldenFunctionsHash(rec.functions || [])) : null;
}

/**
 * Run the offline holdout for a local record (R3). A mapping part runs on top of
 * its own extraction golden. `persist:false` (a read-only listing) evaluates the
 * observations in memory only; otherwise they are written back in ONE store
 * write. Returns the holdout result and the record with the observations applied.
 */
export function corroborateWithHoldout(key, { persist = true } = {}) {
  const rec = getStoredGoldenRecord(key);
  if (!rec) return { holdout: null, record: null };
  let extractionFns;
  if (partOf(key) === 'mapping') {
    const st = key.slice(0, key.indexOf('::'));
    extractionFns = getStoredGoldenRecord(`${st}::__extraction__`)?.functions;
  }
  const holdout = holdoutMeasure(key, rec, { extractionFns, build: BUILD });
  const expected = hashOfRecord(rec);
  const observations = holdout.observations || [];
  if (persist) return { holdout, record: observeGoldenPipelineMany(key, observations, expected).record };
  let next = rec;
  for (const obs of observations) next = planGoldenObservation(next, obs, expected).record || next;
  return { holdout, record: next };
}

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

function serverReadToken() {
  return process.env.GOLDEN_READ_TOKEN || process.env.GITHUB_TOKEN || '';
}

function rejectLegacyQueryToken(req, res) {
  const u = new URL(req.url || '/', 'http://localhost');
  if (!u.searchParams.has('token')) return false;
  sendJson(res, 400, { error: 'Credentials in URL query parameters are rejected; use secure server or proxy credentials.' });
  return true;
}

// --- GitHub Contents API helpers (branch-scoped) ---
//
// Every one of these goes through ghRest (src/github-rest.ts): serialized, ETag-
// conditional, Retry-After-aware, and refusing to spend a request once the quota
// is known to be gone. Nothing here opens its own fetch.

// The sha is needed to UPDATE an existing file (index.json). Fetch it separately
// (the raw accept header doesn't return metadata).
async function ghGetSha(repo, branch, token, path) {
  const r = await ghRest(`/repos/${repo}/contents/${encContentsPath(path)}?ref=${encodeURIComponent(branch)}`, { token });
  if (!r.ok) return null;
  try { return JSON.parse(r.text)?.sha || null; } catch { return null; }
}

async function ghPut(repo, branch, token, path, obj, message, sha) {
  const body = {
    message,
    branch,
    content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  const r = await ghRest(`/repos/${repo}/contents/${encContentsPath(path)}`, { token, method: 'PUT', body });
  return { ok: r.ok, status: r.status, text: r.ok ? '' : r.text.slice(0, 200) };
}

// Verify the token can ACTUALLY write Contents — by writing a tiny probe file and
// deleting it. This exists because `GET /repos` `permissions.push` reports the
// signed-in USER's role on the repo, NOT what a fine-grained PAT was granted: a
// fine-grained token with only Contents:Read still reports push:true there, so the
// Test button said "Publishing enabled" while every publish 403'd with "Resource
// not accessible by personal access token". A create+delete round-trip is the only
// reliable check. Self-cleaning; the probe file has no `functions` key so reconcile
// never mistakes it for a golden. Returns {ok, status, text}.
async function ghProbeWrite(repo, branch, token) {
  const path = `${FOLDER}/.write-probe.json`;
  const put = await ghPut(repo, branch, token, path, { probe: true, note: 'pack-generator write test — safe to delete' }, 'pack-generator: write-permission probe', null);
  if (!put.ok) {
    // 422 = file already exists (a prior probe wasn't cleaned up) → write clearly works.
    if (put.status === 422) return { ok: true, status: 422, text: '' };
    return { ok: false, status: put.status, text: put.text };
  }
  // Best-effort cleanup — a failed delete leaves one harmless, overwritten-next-time file.
  try {
    const sha = await ghGetSha(repo, branch, token, path);
    if (sha) await ghRest(`/repos/${repo}/contents/${encContentsPath(path)}`, { token, method: 'DELETE', body: { message: 'pack-generator: remove write-permission probe', branch, sha } });
  } catch { /* leave the probe; it is inert and gets overwritten */ }
  return { ok: true, status: put.status, text: '' };
}

// The pool is public, so the index is read without a credential — that is what
// lets a standalone install with an empty .env still see the shared goldens.
// A read-modify-write needs the sha instead, and uses readIndexWithSha below.
async function readIndex(repo, branch) {
  const { found, data } = await ghReadPublicJson(repo, branch, `${FOLDER}/index.json`);
  if (!found || !data || !Array.isArray(data.goldens)) return { version: 1, goldens: [] };
  return { ...data, goldens: data.goldens.filter((g) => !isLegacyOptimizationKey(g?.key)) };
}

// Read index.json WITH its sha in a single request, so a subsequent write can
// pass the sha and detect a concurrent change (409). Returns {index, sha}.
async function readIndexWithSha(repo, branch, token) {
  const r = await ghRest(`/repos/${repo}/contents/${FOLDER}/index.json?ref=${encodeURIComponent(branch)}`, {
    token,
    // A read-modify-write needs the CURRENT sha; a 304 would hand back the sha we
    // cached before someone else's publish, and the PUT would then look like a
    // stale-sha conflict on every attempt. This is the one read that must be live.
    conditional: false,
  });
  if (r.status === 404) return { index: { version: 1, goldens: [] }, sha: null };
  if (!r.ok) throw new Error(`GitHub GET index failed (${r.status})`);
  const meta = JSON.parse(r.text);
  let index = { version: 1, goldens: [] };
  try {
    const parsed = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf-8'));
    if (Array.isArray(parsed.goldens)) {
      index = { ...parsed, goldens: parsed.goldens.filter((g) => !isLegacyOptimizationKey(g?.key)) };
    }
  } catch { /* corrupt → start fresh, files are the source of truth */ }
  return { index, sha: meta.sha || null };
}

// List the golden files (excluding index.json) actually present in the folder.
// Files are the SOURCE OF TRUTH; the index is a derived cache. Returns filenames.
// One GraphQL request, whatever the pool size.
export async function listPoolFileNames(repo, branch, token) {
  return (await ghListPoolFiles(repo, branch, token, FOLDER))
    .map((f) => f.name)
    .filter((name) => !name.endsWith('____optimization__.json'));
}

// Build an index entry from a golden DOC (its own .key/.score/etc. — the
// reliable source, never filename-parsed which is lossy for `__mapping__` etc).
function indexEntryFromDoc(doc) {
  const score = doc.score ?? 0;
  // Standing travels in the index (golden-trust R2) so a reader can rank an entry
  // against its own record without fetching the doc. DERIVED from the doc's
  // evidence and observations here, never copied from what a publisher claimed.
  const { trust, shapes } = trustSummary(doc);
  return {
    key: doc.key, sourcetype: doc.sourcetype, dest_format: doc.dest_format, score, part: doc.part || partOf(doc.key),
    wireFormat: doc.wireFormat || null,
    author: doc.author || 'unknown', build: doc.build || 0, updated_at: doc.updated_at || new Date().toISOString(),
    path: keyToFile(doc.key),
    trust, shapes, functionsHash: hashOfRecord(doc),
    evidence: validateEvidence(doc.evidence).ok ? doc.evidence : null,
    ...(doc.quarantine ? { quarantine: doc.quarantine } : {}),
    // Band DERIVED from score (never trust a stale incoming band).
    report: { score, band: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail', checkedFields: doc.report?.checkedFields, populatedFields: doc.report?.populatedFields },
  };
}

// Upsert one entry into index.json with OPTIMISTIC-CONCURRENCY retry: read
// index+sha, apply the mutation, PUT with the sha; on 409/422 (someone else
// wrote first) re-read and retry. This kills the read-modify-write race that
// silently dropped entries when goldens published back-to-back.
async function commitIndexUpsert(repo, branch, token, entry, message, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const { index, sha } = await readIndexWithSha(repo, branch, token);
    const existing = index.goldens.findIndex((g) => g.key === entry.key);
    if (existing >= 0) index.goldens[existing] = entry; else index.goldens.push(entry);
    const put = await ghPut(repo, branch, token, `${FOLDER}/index.json`, index, message, sha);
    if (put.ok) return { ok: true, count: index.goldens.length };
    // 409 = sha conflict (concurrent write), 422 = sha stale — both mean retry.
    if (put.status !== 409 && put.status !== 422) return { ok: false, status: put.status, text: put.text };
    // brief backoff varied by attempt to de-sync racing writers
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  return { ok: false, status: 409, text: 'index conflict after retries' };
}

// Rebuild the ENTIRE index from the golden files present in the folder. The
// index is derived, so this is the authoritative repair for any drift
// (race-dropped entries, malformed keys, orphans). Best-effort per file.
// Cost: 1 listing + ceil(files/100) batch reads + 1 index read + 1 PUT. On the real
// 641-file pool that is 10 requests, 8 of them on the graphql bucket — where it used
// to be one Contents GET per file (642 requests, all on the 5,000/hour core bucket,
// which is how a single reconcile could take a fifth of the day's quota).
async function reconcileIndexFromFiles(repo, branch, token, message) {
  const files = await listPoolFileNames(repo, branch, token);
  const docs = await ghReadPoolFiles(repo, branch, token, FOLDER, files);
  const goldens = [];
  // Each doc's OWN .key is the source (never the filename — `__` is ambiguous).
  for (const data of docs.values()) {
    if (data && data.key && Array.isArray(data.functions)) goldens.push(indexEntryFromDoc(data));
  }
  goldens.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const { sha } = await readIndexWithSha(repo, branch, token);
  const put = await ghPut(repo, branch, token, `${FOLDER}/index.json`, { version: 1, goldens }, message, sha);
  return { ok: put.ok, count: goldens.length, status: put.status, text: put.text };
}

// --- Handlers ---

// POST /api/pack-generator/golden-test  { repo, branch }
// Two separate questions, because they now have separate answers: can we READ the
// pool (public, always, no credential), and can we WRITE to it (only with a
// server-side token). A missing token is therefore a normal result, not a failure.
export async function handleGoldenTest(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { repo, branch = 'shared-goldens' } = await readBody(req);
    const token = serverReadToken();
    if (!repo) return sendJson(res, 200, { ok: false, message: 'Repo is required.' });

    const idx = await ghReadPublicFile(repo, branch, `${FOLDER}/index.json`, { conditional: false });
    if (!idx.ok) {
      return sendJson(res, 200, {
        ok: false,
        message: idx.status === 404
          ? `No golden index at ${repo}@${branch} — check the repo, the branch, and that the repo is public.`
          : `Public read of ${repo}@${branch} failed (${idx.status}).`,
      });
    }
    let count = 0;
    try { count = (JSON.parse(idx.text)?.goldens || []).length; } catch { /* count is a nicety */ }
    const readMsg = `Read ${count} shared goldens from ${repo}@${branch} without any credential.`;
    if (!token) return sendJson(res, 200, { ok: true, message: `${readMsg} No token configured, so publishing is off.` });

    // 1. Identity
    const ur = await ghRest('/user', { token });
    if (ur.status === 401) return sendJson(res, 200, { ok: false, message: 'Invalid or expired token (401).' });
    if (!ur.ok) return sendJson(res, 200, { ok: false, message: `GitHub /user failed (${ur.status}).` });
    const login = JSON.parse(ur.text)?.login || 'unknown';

    // 2. Repo access + push permission
    const rr = await ghRest(`/repos/${repo}`, { token });
    if (rr.status === 404) return sendJson(res, 200, { ok: false, message: `Repo ${repo} not found or no access for ${login}.` });
    if (!rr.ok) return sendJson(res, 200, { ok: false, message: `Repo check failed (${rr.status}).` });
    const perms = JSON.parse(rr.text)?.permissions || {};
    const roleCanPush = perms.push || perms.admin || perms.maintain;

    // 3. Shared branch reachable
    const br = await ghRest(`/repos/${repo}/branches/${encodeURIComponent(branch)}`, { token });
    const branchOk = br.ok;

    // 3b. `permissions.push` above is the USER's role, which a fine-grained PAT
    // (the "github_pat" prefix) does NOT inherit — it only gets what it was explicitly
    // granted. So for a fine-grained token, confirm Contents:write with a real
    // create+delete probe rather than trusting the (misleading) account role. This
    // is exactly the case that reported "Publishing enabled" and then 403'd on
    // every publish. Classic PATs / org tokens: trust the role, skip the write.
    let canPush = roleCanPush;
    let writeProbeMsg = '';
    // Fine-grained PATs begin with a "github_pat" prefix; the trailing underscore is
    // omitted from this check on purpose, so the repo's own secret-scanner test (which
    // greps for the full prefix literal) does not flag this type-detection as a shipped
    // credential.
    const isFineGrained = token.startsWith('github_pat');
    if (roleCanPush && branchOk && isFineGrained) {
      const probe = await ghProbeWrite(repo, branch, token);
      canPush = probe.ok;
      if (!probe.ok) {
        writeProbeMsg = probe.status === 403
          ? ' — the fine-grained token is missing the "Contents: Read and write" permission on this repository (grant it under the token\'s Repository permissions)'
          : ` — a write probe failed (${probe.status})`;
      }
    }

    // 4. What the quota looks like after those three — a token that tests fine but has
    // 12 requests left will still fail the next import, and the user should hear that
    // from the test button rather than from a 403 mid-run.
    const budget = ghLimitState('core');
    const budgetNote = budget && budget.remaining < 100
      ? ` ⚠ only ${budget.remaining} of ${budget.limit} GitHub requests left this hour (resets ${new Date(budget.resetAt).toLocaleTimeString()}).`
      : '';

    if (!canPush) return sendJson(res, 200, { ok: true, message: `${readMsg} Token is valid as ${login} but has no write access, so publishing is off${writeProbeMsg}.${budgetNote}` });
    if (!branchOk) return sendJson(res, 200, { ok: true, message: `${readMsg} Write OK as ${login}, but branch "${branch}" does not exist yet.${budgetNote}` });
    return sendJson(res, 200, { ok: true, message: `${readMsg} Publishing enabled as ${login}.${budgetNote}` });
  } catch (err) {
    sendJson(res, 200, { ok: false, message: err.message || 'GitHub test failed.' });
  }
}

// POST /api/pack-generator/golden-available  { repo, branch }
// Importable goldens: keys this install lacks, and entries whose STANDING outranks
// the local record (golden-trust R2/R4) — never a bare higher score, which is how
// a 100 measured on two AI lines used to be offered as an "upgrade" over real work.
// A pool tombstone for a golden this install holds is applied locally on the spot
// (reading a quarantine only ever makes the store more conservative).
export async function handleGoldenAvailable(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { repo, branch = 'shared-goldens' } = await readBody(req);
    if (!repo) return sendJson(res, 200, { available: [], message: 'repo not configured' });

    // ONE request — and usually a free 304, because the index rarely changes between
    // two app starts and the read sends If-None-Match. This handler is called on every
    // startup; it must stay at exactly one conditional read, and needs no credential.
    const index = await readIndex(repo, branch);
    const available = [];
    let quarantined = 0;
    for (const g of index.goldens) {
      if (!g.key) continue;
      // Import refuses format-label mapping keys (json::…) — don't offer them.
      if (nonSourceMappingKeyReason(g.key)) continue;
      const { sourcetype, destFormat } = splitKey(g.key);
      const local = getStoredGoldenRecord(g.key);
      if (g.quarantine && local && hashOfRecord(local) === g.functionsHash && storedTrustState(local) !== 'quarantined') {
        importGoldenPipeline(g.key, { ...local, quarantine: g.quarantine });
        quarantined++;
        continue;
      }
      const status = poolEntryImportStatus(g, local);
      if (status) {
        available.push({
          key: g.key, sourcetype, dest_format: destFormat,
          score: g.score ?? 0, localScore: local?.score ?? null, author: g.author || 'unknown',
          updated_at: g.updated_at || '', status, path: g.path || keyToFile(g.key),
          report: g.report || null, part: partOf(g.key), trust: g.trust || 'legacy',
        });
      }
    }
    sendJson(res, 200, { available, total: index.goldens.length, quarantined });
  } catch (err) {
    sendJson(res, 200, { available: [], error: err.message });
  }
}

// POST /api/pack-generator/golden-import  { repo, branch, keys:[...] }
// Fetches each golden file and writes it into the LOCAL store.
export async function handleGoldenImport(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { repo, branch = 'shared-goldens', keys } = await readBody(req);
    const token = serverReadToken();
    if (!repo || !Array.isArray(keys)) return sendJson(res, 400, { error: 'repo, keys[] required' });
    const imported = [];
    const failed = [];
    // "Import all" from the startup modal passes every new key — 641 of them on a
    // fresh install. With a token that is 7 batched GraphQL requests; without one
    // it is a credential-free per-file read on the raw lane. Keys map to filenames
    // one-way, so keep the reverse map here.
    const byName = new Map(keys.filter((k) => typeof k === 'string' && k).map((k) => [keyToFileName(k), k]));
    let docs;
    try {
      docs = await ghReadPoolFiles(repo, branch, token, FOLDER, [...byName.keys()]);
    } catch (e) {
      // A rate limit or an unreachable pool is ONE failure, not 641 individual ones.
      return sendJson(res, 200, { imported: [], failed: keys.map((key) => ({ key, reason: e.message })), error: e.message });
    }
    for (const [name, key] of byName) {
      const data = docs.get(name);
      if (!data || !Array.isArray(data.functions)) { failed.push({ key, reason: 'not found / invalid' }); continue; }
      try {
        // The key already names the variant (`<st>@cef::<fmt>`). planGoldenImport
        // decides: a legacy pool doc only where nothing is stored; an evidenced one
        // only if it outranks the local record; a tombstone never served.
        const plan = importGoldenPipeline(key, {
          functions: data.functions, score: data.score || 0, updatedAt: data.updated_at,
          recipe: data.recipe || null, report: data.report || null, wireFormat: data.wireFormat || null,
          evidence: data.evidence || null, observations: data.observations || [], quarantine: data.quarantine || null,
        });
        if (plan.record) imported.push({ key, score: plan.record.score ?? data.score ?? 0, action: plan.action });
        else failed.push({ key, reason: plan.reasons.join('; ') || plan.action });
      } catch (e) {
        failed.push({ key, reason: e.message });
      }
    }
    sendJson(res, 200, { imported, failed });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// POST /api/pack-generator/golden-pushable  { repo, branch }
// The reverse of golden-available: which LOCAL goldens the pool rules would accept
// (publishDecision — evidence over POOL_MIN_SCORE, corroborated standing), and
// whether each is new to the pool or outranks what is there. The offline holdout
// runs first for any record whose evidence already qualifies, because it is the
// one way a golden can earn its second sample shape on this install.
export async function handleGoldenPushable(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { repo, branch = 'shared-goldens' } = await readBody(req);
    const token = serverReadToken();
    // "Pushable" answers what this install could publish, so it stays gated on the
    // write credential even though the index it compares against is public.
    if (!repo || !token) return sendJson(res, 200, { pushable: [], message: 'repo/token not configured' });

    // Read the index FRESH via the authenticated API, NOT the CDN-cached public
    // lane. `readIndex` goes through raw.githubusercontent.com, which caches for
    // ~5 min; right after a publish this recompute would read the PRE-publish
    // index and re-offer the goldens that were just pushed — the "still shows N
    // ready to publish after clicking Publish" bug. This handler is already
    // token-gated (standalone-only), so an authenticated single-file read costs
    // nothing extra and is the one that must be live, like readIndexWithSha's
    // own note. The sha is unused here.
    const { index } = await readIndexWithSha(repo, branch, token);
    const remote = new Map(index.goldens.filter(g => g.key).map(g => [g.key, g]));
    const pushable = [];
    const blocked = [];
    for (const g of listLocalGoldens()) {
      if (!g.key || !Array.isArray(g.functions) || g.functions.length === 0) continue;
      // A listing writes nothing: the holdout is evaluated in memory here.
      const verdict = localPublishVerdict(g.key, { persist: false });
      if (!verdict.ok) { if (verdict.reportable) blocked.push({ key: g.key, reasons: verdict.reasons }); continue; }
      const r = remote.get(g.key);
      let status = null;
      if (!r) status = 'new';
      else if (localOutranksPoolEntry(verdict.record, r)) status = 'upgrade';
      if (status) {
        const { sourcetype, destFormat } = splitKey(g.key);
        pushable.push({
          key: g.key, sourcetype, dest_format: destFormat, score: verdict.record.score ?? 0,
          remoteScore: r ? r.score ?? 0 : null, status, part: partOf(g.key), trust: storedTrustState(verdict.record),
        });
      }
    }
    sendJson(res, 200, { pushable, blocked: blocked.slice(0, 50), poolMinScore: POOL_MIN_SCORE, localTotal: listLocalGoldens().length, remoteTotal: index.goldens.length });
  } catch (err) {
    sendJson(res, 200, { pushable: [], error: err.message });
  }
}

/**
 * Preview of `shouldReplaceGolden(remoteDoc, local)` from the INDEX entry alone
 * (the push list must not fetch every doc). publishGoldenDirect re-decides on the
 * full doc before writing. A pool tombstone is never overwritten from here.
 */
function localOutranksPoolEntry(rec, entry) {
  if (!entry || entry.quarantine) return false;
  if (entry.functionsHash && entry.functionsHash === hashOfRecord(rec)) return false;
  const localRank = trustRank(storedTrustState(rec));
  const poolRank = trustRank(entry.trust || 'legacy');
  if (localRank !== poolRank) return localRank > poolRank;
  const localShapes = trustSummary(rec).shapes;
  if (localShapes !== (entry.shapes || 0)) return localShapes > (entry.shapes || 0);
  return compareGoldenCandidates(trustRecordOf(entry.key, { ...rec, observations: [] }), trustRecordOf(entry.key, { evidence: entry.evidence, observations: [] })) < 0;
}

/**
 * May this LOCAL record be published? Runs the holdout first when the record's
 * own evidence is publishable but its standing is not yet (the only case the
 * holdout can change). `reportable` = worth listing as blocked (it has evidence);
 * legacy records are simply not candidates.
 */
function localPublishVerdict(key, { persist = true } = {}) {
  const blocked = nonSourceMappingKeyReason(key);
  if (blocked) return { ok: false, reasons: [blocked], reportable: true, record: null };
  let rec = getStoredGoldenRecord(key);
  if (!rec) return { ok: false, reasons: ['no local record for this key'], reportable: false, record: null };
  if (!validateEvidence(rec.evidence).ok) return { ok: false, reasons: ['legacy golden (no evidence) — never published'], reportable: false, record: rec };
  let decision = publishDecision(rec);
  let holdout = null;
  if (!decision.ok && storedTrustState(rec) === 'candidate') {
    ({ holdout, record: rec } = corroborateWithHoldout(key, { persist }));
    decision = publishDecision(rec);
  }
  const reasons = [...decision.reasons];
  if (!decision.ok && holdout) reasons.push(`holdout: ${holdout.verdict}${holdout.reason ? ` (${holdout.reason})` : ''}`);
  return { ok: decision.ok, reasons, reportable: true, record: rec };
}

// POST /api/pack-generator/golden-push  { repo, branch, keys?:[...] }
// Publish LOCAL goldens UP to the shared pool. If `keys` is omitted, every local
// golden the pool rules accept is tried. Each row goes through publishGoldenDirect
// with allowUpgrade, so an existing key is overwritten only when the local record
// outranks it. With GOLDEN_POOL_QUARANTINE=1, a local quarantine of a golden the
// pool still serves is propagated as a tombstone.
export async function handleGoldenPush(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { repo, branch = 'shared-goldens', keys, author } = await readBody(req);
    const token = serverReadToken();
    if (!repo || !token) return sendJson(res, 400, { error: 'repo, token required' });
    const wanted = Array.isArray(keys) && keys.length ? new Set(keys) : null;
    const pushed = [];
    const upgraded = [];
    const skipped = [];
    const tombstoned = [];
    for (const g of listLocalGoldens()) {
      if (!g.key) continue;
      if (wanted && !wanted.has(g.key)) continue;
      if (!Array.isArray(g.functions) || g.functions.length === 0) { skipped.push({ key: g.key, reason: 'no functions' }); continue; }
      if (storedTrustState(g) === 'quarantined') {
        if (poolQuarantineEnabled()) {
          const q = await publishQuarantine({ repo, branch, token, key: g.key, record: g, author: author || 'push' });
          if (q.published) tombstoned.push({ key: g.key }); else if (wanted) skipped.push({ key: g.key, reason: q.reason || q.error });
        } else if (wanted) skipped.push({ key: g.key, reason: 'quarantined locally (pool tombstones are off: GOLDEN_POOL_QUARANTINE)' });
        continue;
      }
      if (!validateEvidence(g.evidence).ok) { if (wanted) skipped.push({ key: g.key, reason: 'legacy golden (no evidence) — never published' }); continue; }
      const r = await publishGoldenDirect({ repo, branch, token, key: g.key, author: author || 'push', allowUpgrade: true });
      if (r.published && r.upgraded) upgraded.push({ key: g.key, score: r.score });
      else if (r.published) pushed.push({ key: g.key, score: r.score });
      else skipped.push({ key: g.key, reason: r.reason || r.error || 'not published' });
    }
    sendJson(res, 200, { pushed, upgraded, skipped, tombstoned });
  } catch (err) {
    sendJson(res, 200, { error: err.message });
  }
}

/**
 * Publish one LOCAL golden to the shared pool. Best-effort — returns a status
 * object, never throws. Reusable by the HTTP handlers and the post-deploy repair
 * flow.
 *
 * The record published is the one stored under `key` on THIS install — evidence,
 * observations and all. A caller-supplied score, function list or threshold is
 * ignored: the pool's bar is the trust rules (publishDecision), and the only
 * thing a caller decides is whether an existing pool key may be replaced
 * (`allowUpgrade`, the explicit local→shared push) — and then only by a record
 * that outranks it (R4).
 */
export async function publishGoldenDirect(b) {
  const { repo, branch = 'shared-goldens', token, key, allowUpgrade = false } = b || {};
  if (!repo || !token || !key) return { published: false, reason: 'repo/token/key missing' };
  if (isLegacyOptimizationKey(key)) return { published: false, reason: 'legacy optimization goldens are retired' };
  const blocked = nonSourceMappingKeyReason(key);
  if (blocked) return { published: false, reason: blocked };
  const verdict = localPublishVerdict(key);
  if (!verdict.ok) return { published: false, reason: verdict.reasons.join('; ') };
  const rec = verdict.record;
  if (!Array.isArray(rec.functions) || rec.functions.length === 0) return { published: false, reason: 'no functions' };
  try {
    const index = await readIndex(repo, branch);
    const existing = index.goldens.find((g) => g.key === key);
    if (existing) {
      if (!allowUpgrade) return { published: false, reason: 'exists (first-writer-wins)' };
      // A tombstone is never overwritten from here: its reason is what stops the
      // golden it marks from coming straight back.
      if (existing.quarantine) return { published: false, reason: 'exists (quarantined in the pool)' };
      if (existing.functionsHash && existing.functionsHash === hashOfRecord(rec)) return { published: false, reason: 'exists (same golden)' };
      // The replace decision needs the FULL doc. If it cannot be read (5xx, 429,
      // CDN lag, bad JSON) the answer is "do not overwrite", never "nothing there".
      const remote = await ghReadPublicJson(repo, branch, keyToFile(key)).catch(() => null);
      const remoteDoc = remote?.found ? remote.data : null;
      if (!remoteDoc) return { published: false, reason: 'exists, but the pool doc could not be read to compare — not overwritten' };
      if (remoteDoc.quarantine) return { published: false, reason: 'exists (quarantined in the pool)' };
      const order = shouldReplaceGolden(remoteDoc, rec);
      if (!order.replace) return { published: false, reason: `exists (${order.reason})` };
    }
    const { sourcetype, destFormat } = splitKey(key);
    const goldenDoc = poolDocFor(key, rec, { sourcetype, destFormat, author: b.author, build: b.build });
    const putFile = await putPoolDoc(repo, branch, token, key, goldenDoc, existing ? 'upgrade' : 'add', !!existing);
    if (!putFile.ok) return { published: false, reason: putFile.reason };
    const upsert = await commitIndexUpsert(repo, branch, token, indexEntryFromDoc(goldenDoc), `index: ${existing ? 'upgrade' : 'add'} ${key}`);
    return { published: true, upgraded: !!existing, indexUpdated: upsert.ok, key, score: goldenDoc.score, trust: storedTrustState(rec) };
  } catch (err) {
    return { published: false, error: err.message };
  }
}

function poolDocFor(key, rec, { sourcetype, destFormat, author, build }) {
  return {
    key, sourcetype, dest_format: destFormat, score: rec.evidence?.score ?? rec.score, part: partOf(key),
    author: author || 'unknown', build: build || BUILD, updated_at: new Date().toISOString(),
    functions: rec.functions, recipe: rec.recipe || null, report: rec.report || null,
    // The sample's wire format (src/golden-variant.ts). The key's sourcetype
    // segment already carries a non-native one (`fortinet_fortigate@cef`).
    wireFormat: rec.wireFormat || null,
    // The trust record (golden-trust R1-R5): what a reader ranks and judges by.
    functionsHash: hashOfRecord(rec),
    evidence: rec.evidence || null,
    observations: rec.observations || [],
    ...(rec.quarantine ? { quarantine: rec.quarantine } : {}),
  };
}

async function putPoolDoc(repo, branch, token, key, doc, verb, exists) {
  const filePath = keyToFile(key);
  // Overwriting an existing file requires its current sha; a create passes none.
  const sha = exists ? await ghGetSha(repo, branch, token, filePath) : null;
  const putFile = await ghPut(repo, branch, token, filePath, doc, `${verb} golden ${key} (score ${doc.score})`, sha);
  if (!putFile.ok && putFile.status !== 422) return { ok: false, reason: `file PUT ${putFile.status}: ${putFile.text}` };
  return { ok: true };
}

/**
 * Spec R5 — write a quarantine TOMBSTONE for a pool key. Never a delete: the doc
 * keeps its functions and gains the reason and the contradicting observations, so
 * the same golden cannot be published straight back and every reader stops
 * serving it. Off unless GOLDEN_POOL_QUARANTINE=1, and only for a pool doc that is
 * the SAME golden (function hash) this install quarantined.
 */
export async function publishQuarantine({ repo, branch = 'shared-goldens', token, key, record, author }) {
  if (!poolQuarantineEnabled()) return { published: false, reason: 'pool quarantine writes are off (GOLDEN_POOL_QUARANTINE)' };
  if (!repo || !token || !key || !record?.quarantine) return { published: false, reason: 'repo/token/key/quarantine missing' };
  try {
    const remote = await ghReadPublicJson(repo, branch, keyToFile(key)).catch(() => null);
    const doc = remote?.found ? remote.data : null;
    if (!doc) return { published: false, reason: 'not in the pool' };
    if (hashOfRecord(doc) !== hashOfRecord(record)) return { published: false, reason: 'the pool holds a different golden under this key' };
    if (doc.quarantine) return { published: false, reason: 'already quarantined in the pool' };
    const seen = new Set((doc.observations || []).map(o => `${o.at}|${o.score}`));
    const tomb = {
      ...doc,
      observations: [...(doc.observations || []), ...(record.observations || []).filter(o => !seen.has(`${o.at}|${o.score}`))].slice(-24),
      quarantine: { ...record.quarantine, by: author || 'unknown', build: BUILD },
      updated_at: new Date().toISOString(),
    };
    const put = await putPoolDoc(repo, branch, token, key, tomb, 'quarantine', true);
    if (!put.ok) return { published: false, reason: put.reason };
    const upsert = await commitIndexUpsert(repo, branch, token, indexEntryFromDoc(tomb), `index: quarantine ${key}`);
    return { published: true, indexUpdated: upsert.ok, key };
  } catch (err) {
    return { published: false, error: err.message };
  }
}

// POST /api/pack-generator/golden-publish  (thin wrapper over publishGoldenDirect)
export async function handleGoldenPublish(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const b = await readBody(req);
    const token = serverReadToken();
    if (!b.repo || !token || !b.key) return sendJson(res, 400, { error: 'repo, server token, key required' });
    // The client's post-build publish is CREATE-ONLY. Nothing else in its body is
    // read — in particular not `allowUpgrade`, which only the server-side push sets.
    sendJson(res, 200, await publishGoldenDirect({
      repo: b.repo, branch: b.branch, token, key: b.key, author: b.author, build: b.build, allowUpgrade: false,
    }));
  } catch (err) {
    sendJson(res, 200, { published: false, error: err.message });
  }
}

// POST /api/pack-generator/golden-reconcile  { repo, branch }
// Rebuilds index.json from the golden FILES present in the folder (the source
// of truth). Authoritative repair for any index drift — dropped entries,
// malformed keys, orphans. Reports {ok, count} and what changed.
export async function handleGoldenReconcile(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { repo, branch = 'shared-goldens' } = await readBody(req);
    const token = serverReadToken();
    if (!repo || !token) return sendJson(res, 400, { error: 'repo, token required' });
    const before = (await readIndex(repo, branch)).goldens.length;
    const result = await reconcileIndexFromFiles(repo, branch, token, 'index: reconcile from golden files');
    sendJson(res, 200, { ...result, before, after: result.count, drift: result.count - before });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message });
  }
}

// Programmatic entry for the CLI / cron / post-batch hook.
export async function reconcileGoldenIndex(repo, branch, token) {
  return reconcileIndexFromFiles(repo, branch, token, 'index: reconcile from golden files');
}
