import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRIBL_ORG,
  CRIBL_USER_EMAIL,
  LAKE_TOKEN,
  LAKE_URL,
  getToken,
} from './cribl-auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const SCORE_DATASET = 'pack_generator_app_scores';
let discoveredConfig = null;

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function rejectLegacyQueryToken(req, res) {
  const u = new URL(req.url || '/', 'http://localhost');
  if (!u.searchParams.has('token')) return false;
  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Credentials in URL query parameters are rejected; use secure server credentials.' }));
  return true;
}

// No built-in ingest URL: the target is your own org's endpoint, so it comes
// from LAKE_URL in .env or the Settings screen. A Stream worker-group HTTP
// source fronted by the Cloud LB on :443 (e.g. http://selab.main.<org>.cribl.cloud:443)
// works from both Node and the browser; it serves PLAINTEXT http on :443, so
// https:// fails the TLS handshake (normalizeIngestUrl below fixes the scheme).
// The ingest TOKEN is never committed — it is server-only LAKE_TOKEN, or an
// unsaved connection-test value in a POST body.

function authorizationHeader(url, token) {
  if (/^Bearer\s/i.test(token)) return token;
  return url.includes('direct-access') || url.includes(':10080') ? token : `Bearer ${token}`;
}

// The selab worker-group HTTP source serves PLAINTEXT on :443. Any saved
// setting that points at that host must be http:// with an explicit :443,
// or it fails: https:// → TLS handshake EPROTO ("wrong version number");
// no port → the http fallback defaults to :80 and connects to nothing.
// Deterministically rewrite ANY selab…cribl.cloud scoring URL (whatever scheme
// or port the user typed) to the known-good http://<host>:443<path> so stale /
// hand-typed settings self-correct without relying on a handshake retry.
function normalizeIngestUrl(url) {
  if (!url) return url;
  // Prepend a scheme if the user typed a bare host (new URL() needs one).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
  try {
    const u = new URL(withScheme);
    if (/(^|\.)selab\..*\.cribl\.cloud$/i.test(u.hostname)) {
      const path = u.pathname === '/' ? '' : u.pathname;
      return `http://${u.hostname}:443${path}${u.search || ''}`;
    }
  } catch { /* not a parseable URL — leave as-is */ }
  return url;
}

export async function resolveIngestConfig(overrides = {}) {
  // The TOKEN is never committed. Normal logging reads server-only LAKE_TOKEN;
  // an explicit POST connection test may supply a transient override.
  const token = (overrides.token || LAKE_TOKEN || '').trim();
  // 1. Explicit settings-screen override (unsaved test values): url + token.
  if (overrides.url && token) return { url: normalizeIngestUrl(overrides.url), token };
  // 2. A token is configured (settings/.env) — send to the configured URL.
  if (token) {
    const configured = overrides.url || LAKE_URL;
    if (!configured) throw new Error('LAKE_TOKEN is set but LAKE_URL is not — add your scoring ingest URL to .env or Settings');
    return { url: normalizeIngestUrl(configured), token };
  }
  // 3. LAST RESORT (no token configured): auto-discover the Lake Direct-Access
  //    NDJSON endpoint. NOTE: :10080 is browser-blocked — works server-side only.
  if (discoveredConfig) return discoveredConfig;
  const managementToken = await getToken();
  const resp = await fetch(`${CRIBL_ORG.replace(/\/+$/, '')}/api/v1/products/lake/lakes/default/direct-access`, {
    headers: { Authorization: `Bearer ${managementToken}` },
  });
  if (!resp.ok) throw new Error(`Direct Access discovery returned ${resp.status}`);
  const body = await resp.json();
  const source = body?.items?.[0];
  const template = source?.ingestUrls?.find((item) => item.type === 'ndjson')?.url;
  const discoveredToken = source?.authTokens?.[0]?.token;
  if (!template || !discoveredToken) throw new Error('No ready NDJSON Direct Access URL/token found');
  discoveredConfig = { url: template.replace('<lake_dataset_id>', SCORE_DATASET), token: discoveredToken };
  return discoveredConfig;
}

// A TLS handshake error means we spoke https:// to an endpoint that actually
// serves plaintext HTTP (Cribl Cloud's worker-group HTTP source answers
// plaintext on :443 — https:// there yields "wrong version number"/EPROTO).
// When we see that, we retry the same host:port over http://.
function isTlsWrongVersion(msg) {
  return /wrong version number|EPROTO|ERR_SSL|SSL routines|packet length too long/i.test(msg || '');
}

// One raw request over the given scheme. Never rejects — connection errors
// resolve as { ok:false, status:0, text } so callers get a real message
// instead of an opaque thrown "fetch failed".
function rawRequest(scheme, parsed, token, body, url) {
  return new Promise((resolve) => {
    const isHttps = scheme === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const req = requestFn({
      protocol: scheme, hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`, method: 'POST',
      headers: { Authorization: authorizationHeader(url, token), 'Content-Type': 'application/x-ndjson', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let responseBody = '';
      res.on('data', (c) => { responseBody += c; });
      res.on('end', () => resolve({ ok: (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300, status: res.statusCode || 500, text: async () => responseBody }));
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, tlsError: isTlsWrongVersion(err && err.message), text: async () => (err && err.message) || 'connection error' }));
    req.end(body);
  });
}

async function postNdjson(url, token, body) {
  // Node's fetch follows the browser forbidden-port list and rejects Cribl's
  // standard Direct Access port (10080) as a "bad port"; the raw client has no
  // such restriction. Everything (Direct Access :10080 AND worker-group HTTP
  // source) goes through the raw http/https client picked from the URL scheme.
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, status: 0, text: async () => `Invalid URL: ${url}` }; }

  const resp = await rawRequest(parsed.protocol, parsed, token, body, url);
  // Self-heal a mis-schemed https:// endpoint that actually serves plaintext
  // (the classic selab…:443 case). A plaintext endpoint rejects the TLS
  // handshake as EPROTO/"wrong version number" OR drops it as ECONNRESET
  // depending on timing — both surface here as a status:0 connection failure.
  // Retrying the same host:port over http:// is safe: if http also can't
  // connect we just return that error instead.
  if (resp.status === 0 && parsed.protocol === 'https:') {
    const httpResp = await rawRequest('http:', parsed, token, body, url);
    // Prefer the http result if it actually connected (any HTTP status).
    if (httpResp.status !== 0) return httpResp;
  }
  return resp;
}

// Reuse verdicts (golden-trust R3, docs/specs/golden-trust.md). A build that
// measured a stored golden carries `golden_key`, `golden_origin` (which stage
// reused it) and `golden_recorded_score` (what the record claimed) beside the
// score it actually got (`golden_observed_score`). This dataset IS the
// cross-install observation log — there is no second store. Normalised so a
// missing verdict is ABSENT, never an empty string an aggregation would count.
export function goldenVerdictFields(scoreData = {}) {
  if (!scoreData.golden_key) return {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    golden_key: String(scoreData.golden_key),
    golden_origin: scoreData.golden_origin ? String(scoreData.golden_origin) : null,
    golden_recorded_score: num(scoreData.golden_recorded_score),
    golden_observed_score: num(scoreData.golden_observed_score),
  };
}

export async function logScore(scoreData, overrides = {}) {
  try {
    const event = {
      _time: Math.floor(Date.now() / 1000),
      event_type: 'pack_generator_score',
      source_sourcetype: scoreData.sourcetype || '',
      ...scoreData,
      ...goldenVerdictFields(scoreData),
      // Routing keys off `sourcetype` — force it to the scoring value AFTER the
      // spread so it isn't clobbered by the source's own sourcetype (which is
      // preserved above as source_sourcetype). Ensures S3/Lake routing.
      sourcetype: 'pack_generator_score',
      user_email: CRIBL_USER_EMAIL,
      environment: CRIBL_ORG,
      build_number: pkg.buildNumber || 0,
    };

    const { url, token } = await resolveIngestConfig(overrides);

    const resp = await postNdjson(url, token, `${JSON.stringify(event)}\n`);
    const ok = resp.ok;
    if (!ok) console.warn('[score-logger] Unexpected response:', resp.status, await resp.text().catch(() => ''));
    return ok;
  } catch (err) {
    console.warn('[score-logger] Error logging score:', err.message);
    return false;
  }
}

export async function handleLakeHealth(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { url: overrideUrl = '' } = await readBody(req);
    // Resolve the effective target (settings override, else auto-discovered
    // Direct-Access). The credential remains server-side in LAKE_TOKEN. Then
    // POST a real probe so the status reflects ACTUAL
    // delivery — the old version reported "configured" without ever posting,
    // which masked a broken endpoint (Simon's masking issue #1).
    const cfg = await resolveIngestConfig(overrideUrl ? { url: overrideUrl } : {});
    const probe = { _time: Math.floor(Date.now() / 1000), sourcetype: 'pack_generator_score', event_type: 'pack_generator_score', probe: true, environment: CRIBL_ORG };
    const resp = await postNdjson(cfg.url, cfg.token, `${JSON.stringify(probe)}\n`);
    const detail = await resp.text().catch(() => '');
    let message;
    if (resp.ok) message = `Scoring endpoint reachable → ${cfg.url}`;
    else if (resp.status === 0) message = `Could not connect to ${cfg.url}: ${detail} — check URL/port/scheme (http vs https).`;
    else if (resp.status === 401 || resp.status === 403) message = `${resp.status} — token rejected by the endpoint.`;
    else message = `Endpoint returned ${resp.status}${detail ? ': ' + detail.slice(0, 120) : ''}`;
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ active: resp.ok, message }));
  } catch (err) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ active: false, message: err.message || 'Scoring export unavailable' }));
  }
}

// POST a minimal TEST event (datetime, username, version, test flag) to the
// configured scoring endpoint — so the "Test" button verifies real end-to-end
// delivery (the event is searchable in the dataset/S3), not just reachability.
// Uses the settings URL/token override when provided, else auto-discovery.
export async function handleLakeTestEvent(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const { url, token } = await readBody(req);
    const overrides = url && token ? { url, token } : {};
    const cfg = await resolveIngestConfig(overrides);
    const event = {
      _time: Math.floor(Date.now() / 1000),
      sourcetype: 'pack_generator_score',  // routing key — must match the score route
      datetime: new Date(Date.now()).toISOString(),
      username: CRIBL_USER_EMAIL,
      version: pkg.buildNumber || 0,
      test: true,
      event_type: 'pack_generator_score',
    };
    const resp = await postNdjson(cfg.url, cfg.token, `${JSON.stringify(event)}\n`);
    const detail = await resp.text().catch(() => '');
    const active = resp.ok;
    const message = active
      ? `Test event sent to ${cfg.url} — look for test=true in your dataset/S3.`
      : (resp.status === 0
        ? `Could not connect to ${cfg.url}: ${detail}`
        : `Endpoint returned ${resp.status}${detail ? ': ' + detail.slice(0, 120) : ''}`);
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ active, message }));
  } catch (err) {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ active: false, message: err.message || 'Test event failed' }));
  }
}

export async function handleLogScore(req, res) {
  try {
    if (rejectLegacyQueryToken(req, res)) return;
    const parsed = await readBody(req);
    const { _lakeUrl, ...scoreData } = parsed;
    const ok = await logScore(scoreData, { url: _lakeUrl });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ logged: ok }));
  } catch (err) {
    console.warn('[score-logger] handleLogScore error:', err.message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ logged: false }));
  }
}
