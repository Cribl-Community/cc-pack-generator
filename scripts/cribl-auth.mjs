import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

let envVars = {};
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envVars[key] = val;
    if (process.env[key] == null) process.env[key] = val;
  }
} catch {
  // .env not found — fall back to process.env
}

export function env(key) {
  return envVars[key] || process.env[key] || '';
}

// Mutable so the Settings screen can set them at RUNTIME (no restart needed).
// ES module exports are live bindings, so importers that use `${CRIBL_ORG}`
// automatically see updates after setCriblCredentials() reassigns these.
export let CRIBL_ORG = env('CRIBL_ORG');
export let CRIBL_CLIENT_ID = env('CRIBL_CLIENT_ID');
export let CRIBL_CLIENT_SECRET = env('CRIBL_CLIENT_SECRET');
export let CRIBL_USER_EMAIL = env('CRIBL_USER_EMAIL') || 'unknown';

// Upsert a set of KEY=VALUE lines into the .env file (create if missing),
// preserving other lines/comments. Used to persist credentials the user enters
// in the Settings screen so they survive a restart.
export class InvalidCredentialValueError extends Error {
  constructor(key, kind) {
    super(`Credential ${key} contains a forbidden ${kind}; paste a single-line value without CR, LF, or NUL characters.`);
    this.name = 'InvalidCredentialValueError';
    this.statusCode = 400;
  }
}

function validatePersistedValues(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) continue;
    const text = String(value);
    if (text.includes('\0')) throw new InvalidCredentialValueError(key, 'NUL character');
    if (/[\r\n]/.test(text)) throw new InvalidCredentialValueError(key, 'line break');
  }
}

export function persistEnv(updates, deps = {}) {
  validatePersistedValues(updates);
  const exists = deps.exists || existsSync;
  const read = deps.read || readFileSync;
  const write = deps.write || writeFileSync;
  let lines = [];
  try { if (exists(envPath)) lines = read(envPath, 'utf-8').split('\n'); } catch { /* new file */ }
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) continue;
    const idx = lines.findIndex(l => l.trim().replace(/^#\s*/, '').startsWith(`${key}=`) || l.trim().startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line; else lines.push(line);
  }
  write(envPath, lines.join('\n'));
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) continue;
    envVars[key] = value;
    process.env[key] = value;
  }
}

// Set Cribl credentials at runtime: update the live exports, clear the cached
// OAuth token, and persist to .env so they're there next time. Returns nothing.
export function setCriblCredentials({
  org, clientId, clientSecret, userEmail, goldenReadToken, sanitisedSampleToken, lakeToken,
  anthropicApiKey, openaiApiKey, mistralApiKey, azureaiApiKey, geminiApiKey,
  bedrockAccessKeyId, bedrockSecretAccessKey,
} = {}, deps = {}) {
  validatePersistedValues({
    CRIBL_ORG: org,
    CRIBL_CLIENT_ID: clientId,
    CRIBL_CLIENT_SECRET: clientSecret,
    CRIBL_USER_EMAIL: userEmail,
    GOLDEN_READ_TOKEN: goldenReadToken,
    SANITISED_SAMPLE_TOKEN: sanitisedSampleToken,
    LAKE_TOKEN: lakeToken,
    ANTHROPIC_API_KEY: anthropicApiKey,
    OPENAI_API_KEY: openaiApiKey,
    MISTRAL_API_KEY: mistralApiKey,
    AZUREAI_API_KEY: azureaiApiKey,
    GEMINI_API_KEY: geminiApiKey,
    AWS_ACCESS_KEY_ID: bedrockAccessKeyId,
    AWS_SECRET_ACCESS_KEY: bedrockSecretAccessKey,
  });
  const next = {
    org: org != null ? org.trim().replace(/\/+$/, '') : CRIBL_ORG,
    clientId: clientId != null ? clientId.trim() : CRIBL_CLIENT_ID,
    clientSecret: clientSecret != null ? clientSecret.trim() : CRIBL_CLIENT_SECRET,
    userEmail: userEmail != null ? (userEmail.trim() || 'unknown') : CRIBL_USER_EMAIL,
  };
  const updates = {};
  if (org != null) updates.CRIBL_ORG = next.org;
  if (clientId != null) updates.CRIBL_CLIENT_ID = next.clientId;
  if (clientSecret != null) updates.CRIBL_CLIENT_SECRET = next.clientSecret;
  if (userEmail != null) updates.CRIBL_USER_EMAIL = next.userEmail;
  if (goldenReadToken != null) updates.GOLDEN_READ_TOKEN = goldenReadToken.trim();
  if (sanitisedSampleToken != null) updates.SANITISED_SAMPLE_TOKEN = sanitisedSampleToken.trim();
  if (lakeToken != null) updates.LAKE_TOKEN = lakeToken.trim();
  if (anthropicApiKey != null) updates.ANTHROPIC_API_KEY = anthropicApiKey.trim();
  if (openaiApiKey != null) updates.OPENAI_API_KEY = openaiApiKey.trim();
  if (mistralApiKey != null) updates.MISTRAL_API_KEY = mistralApiKey.trim();
  if (azureaiApiKey != null) updates.AZUREAI_API_KEY = azureaiApiKey.trim();
  if (geminiApiKey != null) updates.GEMINI_API_KEY = geminiApiKey.trim();
  if (bedrockAccessKeyId != null) updates.AWS_ACCESS_KEY_ID = bedrockAccessKeyId.trim();
  if (bedrockSecretAccessKey != null) updates.AWS_SECRET_ACCESS_KEY = bedrockSecretAccessKey.trim();
  persistEnv(updates, deps.persistEnvDeps);
  CRIBL_ORG = next.org;
  CRIBL_CLIENT_ID = next.clientId;
  CRIBL_CLIENT_SECRET = next.clientSecret;
  CRIBL_USER_EMAIL = next.userEmail;
  // Force a fresh token with the new creds. Also drop any in-flight request —
  // it was started against the OLD credentials, so its result must not be
  // handed to callers that arrive after the change.
  cachedToken = null; tokenExpiry = 0; tokenInFlight = null;
  if (lakeToken != null) LAKE_TOKEN = lakeToken.trim();
}

// Whether the three required creds are present (for the Settings status).
export function hasCriblCredentials() {
  return !!(CRIBL_ORG && CRIBL_CLIENT_ID && CRIBL_CLIENT_SECRET);
}

// AI backend — env-overridable so the app works off the Cribl network.
// Defaults to Cribl Aperture (needs Tailscale); set AI_BASE + AI_MODEL in .env
// to point at your own Bedrock/Anthropic-compatible endpoint. AI_BASE must
// expose a `/model/<AI_MODEL>/invoke` route accepting the Anthropic
// Messages/Bedrock body the scripts send.
export const AI_BASE = env('AI_BASE') || 'http://ai-gateway.example/bedrock';
export const AI_MODEL = env('AI_MODEL') || 'us.anthropic.claude-sonnet-5';

// Extract the assistant TEXT from a Bedrock/Anthropic Messages response.
// REASONING models (claude-sonnet-5 and newer) prepend a `{type:'thinking'}`
// block as content[0] — whose `.text` is undefined — and put the real answer in
// a later `{type:'text'}` block. Reading `content[0].text` blindly (as every
// handler used to) then yields '' → empty samples / empty AI parse / 0-field
// mappings across the whole app. Always resolve the text via this helper:
// concatenate every text block, ignoring thinking/tool_use blocks.
export function extractAiText(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(c => c && (c.type === 'text' || (c.type === undefined && typeof c.text === 'string')))
      .map(c => c.text || '')
      .join('')
      .trim();
    if (text) return text;
  }
  // Fallback: OpenAI-style response (some Aperture models use Bedrock invoke URL
  // but return OpenAI choices[] format — e.g. qwen.*, zai.*)
  const choice = result?.choices?.[0];
  if (choice?.message?.content) return choice.message.content;
  return '';
}

// Unified model invocation — auto-routes based on model ID prefix:
//   us.anthropic.*  → Bedrock invoke (/bedrock/model/<id>/invoke)
//   anthropic.*     → Anthropic Messages API (/v1/messages)
//   gemini-*        → Gemini generateContent (/v1beta/models/<id>:generateContent)
//   everything else → OpenAI chat/completions (/v1/chat/completions)
const GATEWAY_ROOT = (env('AI_BASE') || 'http://ai-gateway.example/bedrock').replace(/\/bedrock\/?$/, '');
const OPENAI_BASE = GATEWAY_ROOT + '/v1/chat/completions';
const MESSAGES_BASE = GATEWAY_ROOT + '/v1/messages';
const GEMINI_BASE = GATEWAY_ROOT + '/v1beta/models';

function isBedrock(modelId) { return /^(us|eu|ap|global)\.anthropic\./.test(modelId || ''); }
function isAnthropicMessages(modelId) { return /^anthropic\./.test(modelId || ''); }
function isGemini(modelId) { return /^gemini-/.test(modelId || ''); }
function isBedrockInvoke(modelId) { return /^(qwen|zai)\./.test(modelId || ''); }
function isAnthropicModel(modelId) { return isBedrock(modelId) || isAnthropicMessages(modelId); }

export async function invokeModel(modelId, system, userContent, maxTokens = 8192, opts = {}) {
  const fetchOpts = opts.signal ? { signal: opts.signal } : {};
  if (isBedrock(modelId)) {
    const resp = await fetch(`${AI_BASE}/model/${encodeURIComponent(modelId)}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: userContent }],
      }),
      ...fetchOpts,
    });
    if (!resp.ok) throw new Error(`Bedrock error ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    const result = await resp.json();
    return extractAiText(result);
  }
  if (isAnthropicMessages(modelId)) {
    const resp = await fetch(MESSAGES_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: userContent }],
      }),
      ...fetchOpts,
    });
    if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    const result = await resp.json();
    return extractAiText(result);
  }
  if (isGemini(modelId)) {
    const contents = [];
    if (system) contents.push({ role: 'user', parts: [{ text: system }] }, { role: 'model', parts: [{ text: 'Understood.' }] });
    contents.push({ role: 'user', parts: [{ text: userContent }] });
    const resp = await fetch(`${GEMINI_BASE}/${modelId}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } }),
      ...fetchOpts,
    });
    if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    const result = await resp.json();
    return result?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
  }
  if (isBedrockInvoke(modelId)) {
    // qwen.*, zai.* — routed via Bedrock invoke URL but return OpenAI choices[] format
    const resp = await fetch(`${AI_BASE}/model/${encodeURIComponent(modelId)}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: userContent },
        ],
      }),
      ...fetchOpts,
    });
    if (!resp.ok) throw new Error(`AI error ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    const result = await resp.json();
    return result?.choices?.[0]?.message?.content || extractAiText(result) || '';
  }
  // OpenAI-compatible protocol (GPT, DeepSeek, Kimi, etc.)
  // GPT-5.x requires max_completion_tokens and rejects max_tokens;
  // DeepSeek/Qwen use max_tokens. Send the correct one based on model.
  const isGpt = /^(gpt-|o[3-9]|openai\.)/.test(modelId);
  const tokenParam = isGpt ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const resp = await fetch(OPENAI_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      ...tokenParam,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: userContent },
      ],
    }),
    ...fetchOpts,
  });
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
  const result = await resp.json();
  const choice = result.choices?.[0];
  return choice?.message?.content || '';
}

export { isAnthropicModel };

// Cribl Lake "direct access" ingest for the score dataset. Kept in .env so the
// token isn't committed. Users set their own; the settings screen can override.
export const LAKE_URL = env('LAKE_URL') || '';
export let LAKE_TOKEN = env('LAKE_TOKEN') || '';

let cachedToken = null;
let tokenExpiry = 0;
// In-flight token request, so N concurrent callers share ONE OAuth round-trip.
// A batch run with concurrency 10 hitting a cold cache used to fire 10 identical
// client_credentials requests simultaneously (every one of them saw
// `cachedToken === null` before any had returned) — wasteful, and enough
// duplicate auth traffic to risk provider-side rate limiting.
let tokenInFlight = null;

export async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (tokenInFlight) return tokenInFlight;

  if (!CRIBL_ORG || !CRIBL_CLIENT_ID || !CRIBL_CLIENT_SECRET) {
    throw new Error(`Missing Cribl credentials. Set CRIBL_ORG, CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET in .env (looked at: ${envPath}). Got ORG=${CRIBL_ORG ? 'set' : 'empty'}, CLIENT_ID=${CRIBL_CLIENT_ID ? 'set' : 'empty'}, SECRET=${CRIBL_CLIENT_SECRET ? 'set' : 'empty'}`);
  }

  // Cache the PROMISE, not just the resolved token. Cleared in `finally` so a
  // failed auth doesn't poison every later call with the same rejection.
  tokenInFlight = (async () => {
    const tokenUrl = CRIBL_ORG.includes('staging') ? 'https://login.cribl-staging.cloud/oauth/token' : 'https://login.cribl.cloud/oauth/token';
    const audience = CRIBL_ORG.includes('staging') ? 'https://api.cribl-staging.cloud' : 'https://api.cribl.cloud';

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CRIBL_CLIENT_ID,
        client_secret: CRIBL_CLIENT_SECRET,
        audience,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Auth failed (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    return cachedToken;
  })();

  try { return await tokenInFlight; }
  finally { tokenInFlight = null; }
}

async function readBody(req) { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; }
function sendJson(res, obj, status = 200) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); }

// GET — report which creds are configured (never returns the secret) so the
// Settings screen can pre-fill org/clientId + show status.
export function handleGetCreds(_req, res) {
  sendJson(res, {
    org: CRIBL_ORG || '', clientId: CRIBL_CLIENT_ID || '',
    hasSecret: !!CRIBL_CLIENT_SECRET, userEmail: CRIBL_USER_EMAIL === 'unknown' ? '' : CRIBL_USER_EMAIL,
    hasGoldenReadToken: !!env('GOLDEN_READ_TOKEN'),
    hasSanitisedSampleToken: !!env('SANITISED_SAMPLE_TOKEN'),
    configured: hasCriblCredentials(),
  });
}

// POST { org, clientId, clientSecret } — verify the creds by fetching an OAuth
// token WITHOUT persisting. If clientSecret is omitted, reuse the stored one
// (so "Test" works after a Save without re-typing the secret).
export async function handleTestCreds(req, res) {
  try {
    const { org, clientId, clientSecret } = await readBody(req);
    const o = (org || '').trim().replace(/\/+$/, '');
    const id = (clientId || '').trim();
    const secret = (clientSecret || '').trim() || CRIBL_CLIENT_SECRET;
    if (!o || !id || !secret) return sendJson(res, { ok: false, message: 'Org, Client ID and Client Secret are required.' });
    const tokenUrl = o.includes('staging') ? 'https://login.cribl-staging.cloud/oauth/token' : 'https://login.cribl.cloud/oauth/token';
    const audience = o.includes('staging') ? 'https://api.cribl-staging.cloud' : 'https://api.cribl.cloud';
    const r = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience }) });
    if (!r.ok) return sendJson(res, { ok: false, message: `Auth failed (${r.status}): ${(await r.text()).slice(0, 160)}` });
    const tok = (await r.json()).access_token;
    // Prove the token actually works against this org (lists worker groups).
    const g = await fetch(`${o}/api/v1/master/groups`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!g.ok) return sendJson(res, { ok: false, message: `Token OK but org API returned ${g.status} — check the org URL/permissions.` });
    const count = ((await g.json())?.items || []).length;
    return sendJson(res, { ok: true, message: `✓ Authenticated — ${count} worker group(s) reachable.` });
  } catch (e) {
    return sendJson(res, { ok: false, message: e.message || 'Test failed.' });
  }
}

// POST { org, clientId, clientSecret, userEmail } — persist to .env + apply at
// runtime (clears the token cache). Empty clientSecret keeps the stored one.
export async function handleSaveCreds(req, res, deps) {
  try {
    const {
      org, clientId, clientSecret, userEmail, goldenReadToken, sanitisedSampleToken, lakeToken,
      anthropicApiKey, openaiApiKey, mistralApiKey, azureaiApiKey, geminiApiKey,
      bedrockAccessKeyId, bedrockSecretAccessKey,
    } = await readBody(req);
    setCriblCredentials({
      org, clientId,
      clientSecret: (clientSecret || '').trim() ? clientSecret : undefined,
      userEmail,
      goldenReadToken: (goldenReadToken || '').trim() ? goldenReadToken : undefined,
      sanitisedSampleToken: (sanitisedSampleToken || '').trim() ? sanitisedSampleToken : undefined,
      lakeToken: (lakeToken || '').trim() ? lakeToken : undefined,
      anthropicApiKey: (anthropicApiKey || '').trim() ? anthropicApiKey : undefined,
      openaiApiKey: (openaiApiKey || '').trim() ? openaiApiKey : undefined,
      mistralApiKey: (mistralApiKey || '').trim() ? mistralApiKey : undefined,
      azureaiApiKey: (azureaiApiKey || '').trim() ? azureaiApiKey : undefined,
      geminiApiKey: (geminiApiKey || '').trim() ? geminiApiKey : undefined,
      bedrockAccessKeyId: (bedrockAccessKeyId || '').trim() ? bedrockAccessKeyId : undefined,
      bedrockSecretAccessKey: (bedrockSecretAccessKey || '').trim() ? bedrockSecretAccessKey : undefined,
    }, deps || {});
    sendJson(res, { saved: true, configured: hasCriblCredentials() });
  } catch (e) {
    sendJson(res, { saved: false, message: e.message }, e?.statusCode === 400 ? 400 : 500);
  }
}
