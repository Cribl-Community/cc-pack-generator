import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { getRunMode } from './run-mode';
import { getApiBase } from './sample-io';
import { sanitizeCriblFunctions, renderSampleGroundingPrompt, recognizeCefSource } from './pack-builder';
import { describeSampleFormat } from './sample-format';
import type { SampleGrounding } from './pack-builder';
import { buildSampleFallbackDashboardPlan, normalizeDashboardPlan, type DashboardPlan, type DashboardStyle } from './dashboard-builder';
import { getSentinelDestinationSchema, getSentinelSolutionMappingContext } from './sentinel-knowledge';
import { OCSF_STATUS_MAPPING_RULE, ocsfMappingHintForKey, parseOcsfGuidance } from './ocsf-schema';
import { isEmptyEvent, splitNonEvents } from './sample-gate';
import { buildSampleExtensionPrompt, renderVerificationFeedback, stripAiReasoning, verifyGeneratedSample, type SampleVerification } from './sample-library';
import { repairDelimitedSerde } from './extraction-delimiter';
import { optimizationGuidance } from './optimization-knowledge';
import {
  aiRequestTimeoutMs, aiTimeoutError, assertStageLive, backendStageSignal_, describeProxyTimeout,
  isProxyTimeout, sampleGenerationPlan, stageAbortError,
  FORMAT_RESEARCH_MAX_TOKENS,
} from './ai-budget';
import { createSerialLock } from './serial-lock';


import {
  loadSettings, loadSettingsAsync, loadQualitySettings, loadQualitySettingsAsync,
  saveSettings, saveQualitySettings, clearBedrockCredentials,
  persistableAiSettings, scrubStoredAiSettings, persistAiSettingsToDurableSinks,
  persistableQualitySettings, persistQualitySettingsToDurableSinks, scrubStoredQualitySettings,
  GOLDEN_PATH_PREFIX, defaultGoldenRepo, isLegacyGoldenRepo,
  saveLakeToken, saveGoldenReadToken, saveSanitisedSampleToken,
  isDevIframe, persistDurableAiSettings, migrateModel, memorySettings, kvWrite, kvRead,
  canBackgroundUseProvider, installBackendAiSnapshot,
  type AiProvider, type AiSettings, type QualitySettings, type DurableSettingsSinks,
} from './settings-store';

// Re-export the settings API so every existing importer of './ai-client' is unaffected.
export {
  loadSettings, loadSettingsAsync, loadQualitySettings, loadQualitySettingsAsync,
  saveSettings, saveQualitySettings, clearBedrockCredentials,
  persistableAiSettings, scrubStoredAiSettings, persistAiSettingsToDurableSinks,
  persistableQualitySettings, persistQualitySettingsToDurableSinks, scrubStoredQualitySettings,
  GOLDEN_PATH_PREFIX, defaultGoldenRepo, isLegacyGoldenRepo,
  saveLakeToken, saveGoldenReadToken, saveSanitisedSampleToken, isDevIframe,
  canBackgroundUseProvider, installBackendAiSnapshot,
};
export type { AiProvider, AiSettings, QualitySettings, DurableSettingsSinks };



function hasBedrockCreds(): boolean {
  const s = loadSettings();
  return !!(s.bedrockAccessKeyId && s.bedrockSecretAccessKey) || !!s.bedrockCredsSet;
}

export function isAiConfigured(): boolean {
  const s = loadSettings();
  if (s.provider === 'devproxy') return true;
  // The org's AI Settings hold the credential; reachable from inside the Cribl UI
  // and from the app's own Backend Function (same platform, same policy grant).
  if (s.provider === 'cribl') return getRunMode() !== 'standalone';
  // In iframe, keys live in KV (proxy injects them) — trust the flag once set
  if (s.provider === 'anthropic') return !!s.anthropicApiKey || !!s.anthropicApiKeySet;
  if (s.provider === 'openai') return !!s.openaiApiKey || !!s.openaiApiKeySet;
  if (s.provider === 'mistral') return !!s.mistralApiKey || !!s.mistralApiKeySet;
  if (s.provider === 'azureai') return !!s.azureaiApiKey || !!s.azureaiApiKeySet;
  if (s.provider === 'gemini') return !!s.geminiApiKey || !!s.geminiApiKeySet;
  return !!s.bedrockAccessKeyId && !!s.bedrockSecretAccessKey || !!s.bedrockCredsSet;
}

function getProxyBase(): string {
  if (getRunMode() === 'iframe') {
    const criblUrl = window.CRIBL_API_URL || '';
    const base = criblUrl.replace(/\/api\/v1\/?$/, '');
    return `${base}/proxy`;
  }
  return '/proxy';
}

// Default ceiling for a single AI provider request. Sample generation can take
// a couple of minutes on "thorough" tiers, so this is generous — its only job
// is to prevent a hung http://ai-gateway.example/bedrock (or a dead CORS proxy) from wedging
// the UI forever with no way to recover. A Backend Function is the one runtime
// that cannot afford it: the platform kills the invocation at 120s, so
// aiRequestTimeoutMs() hands BACKEND mode a shorter ceiling that still leaves
// the background stage runner time to checkpoint the timeout. Iframe and
// standalone keep the generous default unchanged.
const defaultAiRequestTimeoutMs = (): number => aiRequestTimeoutMs(getRunMode());

// fetch() with an AbortController-based timeout. Throws a clear, actionable
// error on timeout instead of hanging indefinitely.
//
// Two things can abort a provider request: its own timeout, and — in the
// Backend Function only — the STAGE deadline (ai-budget's registered signal).
// The second is what stops a stage that has run out of invocation from starting
// yet another call, and it aborts the request in flight rather than leaving it
// running while something else gives up waiting. Exported for the transport
// tests; every provider call in this file goes through it.
export async function aiFetchWithTimeout(url: string, init: RequestInit, timeoutMs = defaultAiRequestTimeoutMs()): Promise<Response> {
  // Already past the stage deadline: do not issue the request at all.
  assertStageLive('an AI request');

  const controller = new AbortController();
  const stageSignal = backendStageSignal_();
  let stageAborted = false;
  const onStageAbort = () => { stageAborted = true; controller.abort(); };
  stageSignal?.addEventListener('abort', onStageAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (stageAborted) throw stageAbortError('an AI response');
      // Counted as well as thrown: the background stage runner cannot see this
      // from the outside, because the builder deliberately swallows AI failures.
      throw aiTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    stageSignal?.removeEventListener('abort', onStageAbort);
  }
}

const fetchWithTimeout = aiFetchWithTimeout;

// Extract assistant TEXT from an Anthropic/Bedrock Messages response. Reasoning
// models (claude-sonnet-5+) prepend a `{type:'thinking'}` block as content[0]
// whose `.text` is undefined; the real answer is in a later `{type:'text'}`
// block. Reading content[0].text blindly yields '' → empty AI output. Always
// resolve via this helper (concatenate all text blocks, skip thinking/tool_use).
function extractAnthropicText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: { type?: string; text?: string }) => c && (c.type === 'text' || (c.type === undefined && typeof c.text === 'string')))
    .map((c: { text?: string }) => c.text || '')
    .join('')
    .trim();
}

async function callAnthropic(system: string, userMsg: string, maxTokens: number): Promise<string> {
  const settings = loadSettings();

  // App-hosted runtimes fetch the declared HTTPS host and rely on proxies.yml
  // credential injection. Backend snapshots never contain provider secrets.
  const appHosted = getRunMode() === 'iframe' || getRunMode() === 'backend';
  const url = appHosted
    ? 'https://api.anthropic.com/v1/messages'
    : `${getProxyBase()}/api.anthropic.com/v1/messages`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // Standalone's local proxy has no platform credential injection.
  if (!appHosted && settings.anthropicApiKey) {
    headers['x-api-key'] = settings.anthropicApiKey;
  }

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();
  return extractAnthropicText(result);
}

async function writeBedrockAuthToKv(authHeader: string): Promise<void> {
  await kvWrite('bedrockAuth', authHeader, true);
}

let bedrockProxyAuthQueue: Promise<void> = Promise.resolve();

export function withBedrockProxyAuthLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = bedrockProxyAuthQueue.then(operation, operation);
  bedrockProxyAuthQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function runBedrockSignedOperation<THeaders, TResult>(
  iframe: boolean,
  sign: () => Promise<THeaders>,
  invokeSigned: (headers: THeaders) => Promise<TResult>,
): Promise<TResult> {
  const invoke = async () => invokeSigned(await sign());
  return iframe ? withBedrockProxyAuthLock(invoke) : invoke();
}

export async function ensureBedrockCredentialsLoaded(
  settings: AiSettings = loadSettings(),
  deps: {
    runMode?: 'iframe' | 'standalone';
    readCredential?: (key: string) => Promise<string>;
    persistUnavailable?: (settings: AiSettings) => void;
  } = {},
): Promise<AiSettings> {
  const runMode = deps.runMode || getRunMode();
  if (runMode !== 'iframe') return settings;
  if (settings.bedrockAccessKeyId && settings.bedrockSecretAccessKey) return settings;
  if (!settings.bedrockCredsSet) {
    throw new Error('Bedrock is not configured. Re-enter Bedrock credentials in AI Settings.');
  }

  const readCredential = deps.readCredential || kvRead;
  try {
    const accessKeyId = await readCredential('bedrockAccessKeyId');
    const secretAccessKey = await readCredential('bedrockSecretAccessKey');
    if (!accessKeyId || !secretAccessKey) throw new Error('credential missing');
    settings.bedrockAccessKeyId = accessKeyId;
    settings.bedrockSecretAccessKey = secretAccessKey;
    return settings;
  } catch {
    settings.bedrockCredsSet = false;
    settings.bedrockAccessKeyId = '';
    settings.bedrockSecretAccessKey = '';
    if (deps.persistUnavailable) deps.persistUnavailable(settings);
    else if (settings === memorySettings) persistDurableAiSettings(settings);
    throw new Error('Encrypted Bedrock credentials are unavailable. Re-enter Bedrock credentials in AI Settings.');
  }
}

async function callBedrock(system: string, userMsg: string, maxTokens: number): Promise<string> {
  const settings = await ensureBedrockCredentialsLoaded();
  const region = settings.bedrockRegion || 'us-east-1';
  const modelId = settings.model || 'us.anthropic.claude-sonnet-4-6';
  const hostname = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/invoke`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userMsg }],
  });

  const signer = new SignatureV4({
    credentials: {
      accessKeyId: settings.bedrockAccessKeyId || '',
      secretAccessKey: settings.bedrockSecretAccessKey || '',
    },
    region,
    service: 'bedrock',
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method: 'POST',
    protocol: 'https:',
    hostname,
    path,
    headers: {
      'Content-Type': 'application/json',
      host: hostname,
    },
    body,
  });

  const iframe = getRunMode() === 'iframe';
  const url = iframe
    ? `https://${hostname}${path}`
    : `${getProxyBase()}/${hostname}${path}`;

  return runBedrockSignedOperation(
    iframe,
    async () => {
      const signed = await signer.sign(request);
      return signed.headers as Record<string, string>;
    },
    async headers => {
      // The iframe proxy injects this transient signature from encrypted KV.
      const authKey = Object.keys(headers).find(k => k.toLowerCase() === 'authorization');
      const authValue = authKey ? headers[authKey] : '';
      // Iframe drops Authorization because the platform proxy injects it from KV.
      // Standalone keeps the signature because its dev proxy has no KV injection.
      const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk !== 'host' && (!iframe || lk !== 'authorization')) fetchHeaders[k] = v;
      }
      if (iframe) await writeBedrockAuthToKv(authValue);
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: fetchHeaders,
        body,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`Bedrock API error ${resp.status}: ${errText}`);
      }

      const result = await resp.json();
      return extractAnthropicText(result);
    },
  );
}

async function callOpenAi(system: string, userMsg: string, maxTokens: number): Promise<string> {
  const settings = loadSettings();
  const appHosted = getRunMode() === 'iframe' || getRunMode() === 'backend';
  const url = appHosted
    ? 'https://api.openai.com/v1/chat/completions'
    : `${getProxyBase()}/api.openai.com/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!appHosted && settings.openaiApiKey) {
    headers.Authorization = `Bearer ${settings.openaiApiKey}`;
  }

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();
  return result.choices?.[0]?.message?.content || '';
}

async function callMistral(system: string, userMsg: string, maxTokens: number): Promise<string> {
  const settings = loadSettings();
  const appHosted = getRunMode() === 'iframe' || getRunMode() === 'backend';
  const url = appHosted
    ? 'https://api.mistral.ai/v1/chat/completions'
    : `${getProxyBase()}/api.mistral.ai/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!appHosted && settings.mistralApiKey) {
    headers.Authorization = `Bearer ${settings.mistralApiKey}`;
  }

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    throw new Error(`Mistral API error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();
  return result.choices?.[0]?.message?.content || '';
}

async function callAzureAi(system: string, userMsg: string, maxTokens: number): Promise<string> {
  const settings = loadSettings();
  const appHosted = getRunMode() === 'iframe' || getRunMode() === 'backend';
  const url = appHosted
    ? 'https://models.inference.ai.azure.com/chat/completions'
    : `${getProxyBase()}/models.inference.ai.azure.com/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!appHosted && settings.azureaiApiKey) {
    headers.Authorization = `Bearer ${settings.azureaiApiKey}`;
  }

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    throw new Error(`Azure AI error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();
  return result.choices?.[0]?.message?.content || '';
}

// On every Gemini model from 2.5 onward, `maxOutputTokens` is a COMBINED budget
// for the model's internal thinking AND the visible answer — and thinking is on
// by default (Gemini 3 Pro defaults to "high" and cannot turn it off). A model
// that spends the whole allowance reasoning returns a candidate with NO text
// part and `finishReason: MAX_TOKENS`, which reads exactly like "the AI produced
// nothing" (build 563: every parse call on gemini-pro-latest came back empty).
// So: cap the reasoning, and give the answer room on top of it.
export const GEMINI_THINKING_RESERVE_TOKENS = 4096;

export interface GeminiThinkingPlan {
  /** Nested under generationConfig.thinkingConfig — never flattened. */
  thinkingConfig: Record<string, unknown>;
  /** Extra maxOutputTokens so thoughts cannot starve the answer. */
  reserve: number;
}

// Gemini 3 takes `thinkingLevel`; 2.5 takes `thinkingBudget` (Pro has a floor of
// 128 and rejects 0 with INVALID_ARGUMENT, Flash accepts 0). `*-latest` aliases
// resolve to the current generation, which is 3.x.
export function geminiThinkingPlan(modelRaw: string): GeminiThinkingPlan | null {
  const model = String(modelRaw || '').toLowerCase();
  if (!model.startsWith('gemini-')) return null;

  const isGen3 = /gemini-3/.test(model) || /-latest$/.test(model);
  if (isGen3) return { thinkingConfig: { thinkingLevel: 'low' }, reserve: GEMINI_THINKING_RESERVE_TOKENS };

  if (/gemini-2\.5/.test(model)) {
    if (/pro/.test(model)) return { thinkingConfig: { thinkingBudget: 128 }, reserve: GEMINI_THINKING_RESERVE_TOKENS };
    return { thinkingConfig: { thinkingBudget: 0 }, reserve: 0 };
  }

  return null; // 2.0 and earlier do not think, and reject the config.
}

export function geminiGenerationConfig(model: string, maxTokens: number): Record<string, unknown> | null {
  const thinking = geminiThinkingPlan(model);
  const outputCap = maxTokens ? maxTokens + (thinking?.reserve || 0) : 0;
  if (!outputCap && !thinking) return null;
  // REST generateContent rejects unknown names at generationConfig (HTTP 400
  // INVALID_ARGUMENT: `Unknown name "thinkingLevel" at 'generation_config'`).
  // Both knobs live under thinkingConfig: thinkingLevel (Gemini 3) and
  // thinkingBudget (Gemini 2.5). Flattening them was the gemini-3.6-flash 400.
  return {
    ...(outputCap ? { maxOutputTokens: outputCap } : {}),
    ...(thinking ? { thinkingConfig: thinking.thinkingConfig } : {}),
  };
}

async function callGemini(system: string, userMsg: string, maxTokens: number): Promise<string> {
  const settings = loadSettings();
  const model = migrateModel(settings.model || 'gemini-pro-latest');
  const host = 'generativelanguage.googleapis.com';

  const appHosted = getRunMode() === 'iframe' || getRunMode() === 'backend';
  const baseUrl = appHosted
    ? `https://${host}`
    : `${getProxyBase()}/${host}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!appHosted && settings.geminiApiKey) {
    headers['x-goog-api-key'] = settings.geminiApiKey;
  }

  // Try generateContent first (works with all model generations).
  const gcBody: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
  };
  if (system) gcBody.systemInstruction = { parts: [{ text: system }] };
  const generationConfig = geminiGenerationConfig(model, maxTokens);
  if (generationConfig) gcBody.generationConfig = generationConfig;
  const outputCap = Number(generationConfig?.maxOutputTokens || maxTokens);

  const post = (body: Record<string, unknown>) => fetchWithTimeout(`${baseUrl}/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });

  let gcResp = await post(gcBody);

  // A model that does not know the thinking knob we sent rejects the whole
  // request. Losing the call over the fix for a different model would be worse
  // than thinking too much, so drop the knob and ask again.
  if (!gcResp.ok && gcResp.status === 400 && generationConfig) {
    const errText = await gcResp.clone().text().catch(() => '');
    if (/thinking/i.test(errText)) {
      gcResp = await post({ ...gcBody, generationConfig: { maxOutputTokens: outputCap } });
    }
  }

  if (gcResp.ok) {
    const result = await gcResp.json();
    const candidate = result.candidates?.[0];
    if (candidate?.content?.parts) {
      const text = candidate.content.parts
        .filter((p: { text?: string }) => p.text)
        .map((p: { text?: string }) => p.text || '')
        .join('');
      if (text) return text;
    }
    if (result.error) throw new Error(`Gemini: ${result.error.message || JSON.stringify(result.error)}`);
    if (candidate?.finishReason === 'SAFETY') throw new Error('Gemini: response blocked by safety filter');
    // Answered, but with no answer. The interactions fallback below would hide
    // why, so name the cause here — it is a budget problem, not an outage.
    if (candidate?.finishReason === 'MAX_TOKENS') {
      const thoughts = result.usageMetadata?.thoughtsTokenCount;
      throw new Error(
        `Gemini: ${model} used its whole ${outputCap}-token allowance before writing an answer`
        + `${thoughts ? ` (${thoughts} of it on thinking)` : ''}`
        + ' — maxOutputTokens covers thinking AND output on this model. Lower the thinking level or pick a flash model.',
      );
    }
  }

  // Fallback: interactions endpoint (older API, works with 3.x flash models).
  const intBody: Record<string, unknown> = {
    model,
    input: system ? `System: ${system}\n\n${userMsg}` : userMsg,
    stream: false,
    store: false,
  };

  const intResp = await fetchWithTimeout(`${baseUrl}/v1beta/interactions`, {
    method: 'POST', headers, body: JSON.stringify(intBody),
  });

  if (!intResp.ok) {
    const errText = await (gcResp.ok ? intResp : gcResp).text().catch(() => 'unknown error');
    throw new Error(`Gemini API error ${gcResp.ok ? intResp.status : gcResp.status}: ${errText}`);
  }

  const intResult = await intResp.json();
  if (Array.isArray(intResult.steps)) {
    const output = intResult.steps.find((s: { type?: string }) => s.type === 'model_output');
    if (output && Array.isArray(output.content)) {
      return output.content
        .filter((c: { type?: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text || '')
        .join('');
    }
  }
  throw new Error(`Gemini: no text from either endpoint (model: ${model})`);
}

async function callBedrockDev(system: string, userMsg: string, maxTokens: number): Promise<string> {
  const settings = loadSettings();
  const MODEL_ID = settings.model || 'us.anthropic.claude-sonnet-4-6';
  const path = `/bedrock/model/${MODEL_ID}/invoke`;

  let url: string;
  if (getRunMode() === 'backend') {
    // Backend Functions have no Vite proxy. A full URL lets the platform route
    // through the declared `ai` proxy host without exposing any credential.
    url = `https://ai${path}`;
  } else if (getRunMode() === 'iframe' && !isDevIframe()) {
    // Deployed iframe: route through platform proxy → ai host (Aperture/Tailscale)
    const proxyBase = getProxyBase();
    url = `${proxyBase}/ai${path}`;
  } else {
    // Local dev: hit http://ai-gateway.example/bedrock directly (or custom devProxyUrl)
    const baseUrl = settings.devProxyUrl || 'http://ai-gateway.example/bedrock';
    url = `${baseUrl}/model/${MODEL_ID}/invoke`;
  }

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    throw new Error(`Bedrock error ${resp.status}: ${errText}`);
  }

  const result = await resp.json();
  return extractAnthropicText(result);
}

// --- Cribl AI Settings (App mode) ---
// Runs on whatever the org has configured in AI Settings (BYOM or Cribl-managed),
// so the app never holds a key. The transport is the platform's generic
// open_investigator agent — sanctioned by the AI team as the interim app path
// until apps can define their own agents. The schematizer and copilot agents
// refuse prompts outside their own scope, so they cannot carry ours.
const CRIBL_AI_AGENT_PATH = '/ai/q/agents/open_investigator';

// The agent ignores a role:'system' message; inlined ahead of the user message
// it is followed exactly (measured 2026-09-28).
export function criblAiPrompt(system: string, userMsg: string): string {
  return system ? `${system}\n\n---\n\n${userMsg}` : userMsg;
}

// One ndjson line of the agent stream. `content` chunks are the answer; `reason`
// chunks are the agent thinking aloud and are dropped. Throws on an error chunk
// so a failure mid-stream is not returned as a truncated answer.
function criblAiChunkText(line: string): string {
  const trimmed = line.trim().replace(/^data:\s*/, '');
  if (!trimmed) return '';
  let chunk: { content?: unknown; error?: unknown };
  try { chunk = JSON.parse(trimmed); } catch { return ''; }
  if (chunk?.error) {
    const e = chunk.error as { message?: string };
    throw new Error(`Cribl AI: ${typeof chunk.error === 'string' ? chunk.error : e.message || JSON.stringify(chunk.error)}`);
  }
  return typeof chunk?.content === 'string' ? chunk.content : '';
}

export function collectCriblAiStream(ndjson: string): string {
  return ndjson.split('\n').map(criblAiChunkText).join('').trim();
}

// Every Cribl AI prompt goes to the org's one open_investigator agent, and each
// call must answer inside the app proxy's 30s ceiling. Calls in parallel slow
// each other past it — a 4-row batch lost three rows to a bare `Request
// timeout` — so the app keeps exactly one Cribl AI call in flight, whoever
// asks. Batch and pre-flight also drop to one row at a time (aiParallelism).
const criblAiLock = createSerialLock();

// Only inside Cribl: a stale 'cribl' provider saved in a local dev session is not
// usable there (isAiConfigured says so too) and must not drop batches to one row.
export function isCriblAiActive(): boolean {
  return loadSettings().provider === 'cribl' && getRunMode() === 'iframe';
}

/** How many AI-driven tasks may run side by side: `n`, or 1 on Cribl AI. */
export function aiParallelism(n: number): number {
  return isCriblAiActive() ? 1 : n;
}

// One retry on the proxy's timeout: a lone call usually lands the second time.
// A second timeout is reported with what it means, not the platform's bare text.
// Not in a Backend Function: there the allowance is already the stage's whole
// per-request budget, and a second one would spend a call the deadline counted
// for the next step (ai-budget BACKEND_STAGE_MAX_AI_CALLS).
async function callCriblAiWithRetry(system: string, userMsg: string): Promise<string> {
  try {
    return await callCriblAi(system, userMsg);
  } catch (err) {
    if (getRunMode() === 'backend' || !isProxyTimeout(err instanceof Error ? err.message : String(err))) throw err;
    try {
      return await callCriblAi(system, userMsg);
    } catch (retryErr) {
      throw new Error(describeProxyTimeout(retryErr instanceof Error ? retryErr.message : String(retryErr)));
    }
  }
}

async function callCriblAi(system: string, userMsg: string): Promise<string> {
  if (getRunMode() === 'standalone') {
    throw new Error('Cribl AI Settings is only available when Pack Generator runs as an App inside Cribl.');
  }
  const sessionId = globalThis.crypto?.randomUUID?.() || `pack-generator-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resp = await fetchWithTimeout(`${getApiBase()}${CRIBL_AI_AGENT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: criblAiPrompt(system, userMsg) }],
      stream: true,
      context: {},
      tools: [],
      sessionId,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    const hint = resp.status === 404 || resp.status === 500
      ? ' — check that AI is enabled for this org in Settings → AI Settings.'
      : resp.status === 403 ? ' — the app is missing its policy grant for the AI agent.' : '';
    throw new Error(`Cribl AI error ${resp.status}: ${errText.slice(0, 200)}${hint}`);
  }

  // Read the stream as it arrives rather than buffering the whole body, so the
  // chunks keep the connection visibly alive through the platform fetch proxy.
  if (!resp.body) return collectCriblAiStream(await resp.text());
  const reader = resp.body.getReader();
  // The request timeout only covers the wait for headers; the agent can keep
  // streaming well after that. In a Backend Function the stage deadline must
  // still be able to stop the read, or the stage outruns its own checkpoint.
  const stageSignal = backendStageSignal_();
  let stageAborted = false;
  const onStageAbort = () => { stageAborted = true; reader.cancel().catch(() => {}); };
  stageSignal?.addEventListener('abort', onStageAbort, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (stageAborted) throw stageAbortError('the end of the Cribl AI response');
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) text += criblAiChunkText(line);
    }
  } finally {
    stageSignal?.removeEventListener('abort', onStageAbort);
  }
  text += criblAiChunkText(pending + decoder.decode());
  return text.trim();
}

// The health probe caches a GOOD verdict for the session (a real model round trip
// is not worth repeating on every reload). Nothing else may cache it, and every
// real failure must drop it — otherwise a key that stops working, a revoked quota
// or an endpoint that goes away leaves the header showing a green tick for up to
// half an hour while every actual call fails. The key lives here because this is
// the one door every AI call goes through; api.ts owns the probe itself.
export const AI_HEALTH_CACHE_KEY = 'pack-generator-ai-health';

export function invalidateAiHealthCache(): void {
  try { sessionStorage.removeItem(AI_HEALTH_CACHE_KEY); } catch { /* nothing to drop */ }
}

export async function invokeAi(system: string, userMsg: string, maxTokens: number = 2048): Promise<string> {
  const settings = loadSettings();
  let provider = settings.provider;

  // iframe: devproxy (Aperture/Tailscale) is unreachable — fall back to bedrock or anthropic
  if (provider === 'devproxy' && getRunMode() === 'iframe' && !isDevIframe()) {
    provider = hasBedrockCreds() ? 'bedrock' : 'anthropic';
  }

  try {
    switch (provider) {
      case 'devproxy': return await callBedrockDev(system, userMsg, maxTokens);
      case 'anthropic': return await callAnthropic(system, userMsg, maxTokens);
      case 'bedrock': return await callBedrock(system, userMsg, maxTokens);
      case 'openai': return await callOpenAi(system, userMsg, maxTokens);
      case 'mistral': return await callMistral(system, userMsg, maxTokens);
      case 'azureai': return await callAzureAi(system, userMsg, maxTokens);
      case 'gemini': return await callGemini(system, userMsg, maxTokens);
      case 'cribl': return await criblAiLock(() => callCriblAiWithRetry(system, userMsg));
      default: return await callBedrockDev(system, userMsg, maxTokens);
    }
  } catch (err) {
    invalidateAiHealthCache();
    throw err;
  }
}

function parseJsonResponse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(text.substring(start, end + 1));
    throw new Error('AI did not return valid JSON');
  }
}

// --- Schema validation + repair (client-side AI, used in iframe mode) ---
// These mirror the prompts in scripts/schema-validator.mjs but run through the
// browser AI client (invokeAi), so validation/repair also works when the app is
// hosted inside the Cribl UI (iframe) without the dev backend proxy.

// AI-score a pipeline's output against its target schema. Caller supplies the
// already-fetched sample input lines and preview output events.
export async function aiScorePipelineOutput(
  sourcetype: string,
  destFormat: string,
  sampleRaw: string[],
  outputSample: any[],
): Promise<any> {
  const system = `You are a strict Cribl Stream pipeline QA validator. You are given: (a) sample INPUT events, (b) the target schema/format, and (c) the pipeline OUTPUT events after transformation. Assess whether the output correctly and completely conforms to the target format.

Return ONLY valid JSON, no markdown:
{"score":0-100,"sampleFormatOk":true/false,"sampleFormatNote":"one line on whether input looks like real logs of this source",
"outputFormatOk":true/false,
"findings":[{"severity":"high|medium|low","field":"<field or _raw>","issue":"what is wrong","example":"short evidence from output"}],
"missingFields":["schema fields that should be present but aren't"],
"emptyFields":["fields present but empty/unpopulated across events"],
"summary":"2-3 sentence assessment",
"lessons":["generalizable rules to avoid these issues next time this source+format is generated"]}

Scoring guidance:
- 85-100: output is well-formed for the target schema, required fields present and populated.
- 60-84: structurally valid but missing/empty important fields or minor schema deviations.
- <60: broken — wrong shape, empty output, unpopulated required fields, or values that don't match the schema.
Score down hard for: empty output, required schema fields absent, mapped fields that are all empty strings, CEF _raw missing the CEF:0 header, OCSF missing numeric class_uid/category_uid/type_uid.`;

  const user = `SOURCE: ${sourcetype || 'unknown'}
TARGET FORMAT: ${destFormat}

SAMPLE INPUT EVENTS (first ${sampleRaw.length}):
${sampleRaw.join('\n')}

PIPELINE OUTPUT EVENTS (first ${outputSample.length}, JSON):
${JSON.stringify(outputSample, null, 2).slice(0, 6000)}

Validate the output against the ${destFormat} schema and score it.`;

  return parseJsonResponse(await invokeAi(system, user, 4096));
}

// AI-regenerate a pipeline's failing stages from validation findings. Returns
// the corrected functions array. Caller handles PATCH/commit/deploy.
export async function aiRepairPipeline(
  sourcetype: string,
  destFormat: string,
  functions: any[],
  sampleRaw: string[],
  currentOutput: any[],
  findings: { severity: string; field: string; issue: string }[],
): Promise<any[]> {
  const findingsText = (findings || []).map(f => `- [${f.severity}] ${f.field}: ${f.issue}`).join('\n') || '(none provided)';
  const system = `You repair a Cribl Stream pipeline so its output conforms to the target schema. You are given the current pipeline function array (JSON), the sample input, the current (flawed) output, and the validation findings. Return ONLY the corrected FULL pipeline conf as JSON:
{"functions":[ ...corrected Cribl function objects... ]}

Rules:
- Keep the parse/reduction stages that work; fix the mapping/output stages that cause the findings.
- Every eval expression must be a SINGLE valid Cribl expression: NO arrow functions, NO 'function', NO 'return', NO ';', NO IIFE, NO optional chaining ?., NO nullish coalescing ??. Use ternaries and || chains only. Keep each expression short and fully balanced — never emit a truncated or dangling ternary.
- Field NAMES (eval add "name", rename newName, every dotted segment) must be valid Cribl accessor paths: letters/digits/_/$ only, not starting with a digit. NEVER use '@' prefixes — for ECS write 'timestamp' or 'event_time', never '@timestamp'; no hyphens or spaces in names.
- Every eval add "value" must be a STRING containing the expression (e.g. "Number(dpt)", not the bare number).
- Reserved word 'in' → __e['in'].
- Preserve the function shape Cribl expects: {id, filter, disabled, description, conf}.
- Do not invent source fields — map only from fields visible in the sample/output.
- Return the COMPLETE functions array in one response; do not truncate mid-array.`;

  const user = `SOURCE: ${sourcetype}
TARGET FORMAT: ${destFormat}

VALIDATION FINDINGS:
${findingsText}

SAMPLE INPUT (first ${sampleRaw.length}):
${sampleRaw.join('\n')}

CURRENT OUTPUT (flawed, first ${currentOutput.length}):
${JSON.stringify(currentOutput, null, 2).slice(0, 3000)}

CURRENT PIPELINE FUNCTIONS:
${JSON.stringify(functions, null, 2).slice(0, 8000)}

Return the corrected pipeline conf.`;

  const repaired = parseJsonResponse(await invokeAi(system, user, 8192));
  if (!Array.isArray(repaired.functions) || repaired.functions.length === 0) {
    throw new Error('AI repair did not return a valid functions array');
  }
  // Strip entries Cribl would reject (bad field names like ECS '@timestamp',
  // non-single-expression values) so one bad mapping can't sink the PATCH.
  const { functions: safe, dropped } = sanitizeCriblFunctions(repaired.functions, { dropEmptyJsonFields: !!loadQualitySettings().dropEmptyJsonFields });
  if (dropped.length) console.warn(`[aiRepairPipeline] dropped ${dropped.length} unsafe entries: ${dropped.join('; ')}`);
  return safe;
}

// Coerce a loosely-parsed AI response into a well-formed AiMappingResult.
// The model can return the wrong shape (missing `mappings`, non-array, entries
// missing fields); rather than let malformed data reach the pack builder, we
// keep only entries with the three required string fields. Throws if the
// response has no usable mappings at all so the caller can surface a clear error.
export function validateMappingResult(raw: any): AiMappingResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('AI mapping response was not a JSON object');
  }
  const rawMappings = Array.isArray(raw.mappings) ? raw.mappings : [];
  const mappings: FieldMapping[] = rawMappings.filter(
    (m: any) =>
      m && typeof m.sourceField === 'string' &&
      typeof m.destField === 'string' &&
      typeof m.expression === 'string' &&
      m.destField.trim() !== '' &&
      m.expression.trim() !== ''
  );
  if (mappings.length === 0) {
    throw new Error('AI returned no valid field mappings');
  }
  // classInfo is optional; only keep it if it's a string→string object.
  let classInfo: Record<string, string> | undefined;
  if (raw.classInfo && typeof raw.classInfo === 'object' && !Array.isArray(raw.classInfo)) {
    classInfo = {};
    for (const [k, v] of Object.entries(raw.classInfo)) {
      if (typeof v === 'string' || typeof v === 'number') classInfo[k] = String(v);
    }
  }
  return { mappings, classInfo };
}

// --- Public AI functions ---

export interface DashboardSampleSource {
  sourcetype: string;
  sampleEvents: string;
  parsedFieldNames: string[];
}

export async function aiDesignSearchDashboard(
  datasetId: string,
  sources: DashboardSampleSource[],
  style: DashboardStyle,
): Promise<DashboardPlan> {
  const fields = [...new Set(['_time', 'datatype', 'sourcetype', ...sources.flatMap(source => source.parsedFieldNames)])]
    .filter(field => /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(field));
  const usableSources = sources.filter(source => source.sampleEvents.trim() && source.parsedFieldNames.length > 0);
  if (usableSources.length === 0) {
    throw new Error('The prepared demo samples exposed no parsed fields, so AI cannot create a usable dashboard.');
  }

  const system = `You are a Cribl Search dashboard architect. Analyze the observed events and select the most useful operational or security KPIs for this dataset. Return ONLY valid JSON, no markdown:
{"title":"...","summary":"...","kpis":[{"id":"snake_case","title":"...","visualization":"single|line|bar|pie|table|sankey|treemap","metric":"count|distinct|sum|avg|p95","field":"optional numeric or distinct field","groupBy":"optional category field","secondaryGroupBy":"required only for sankey","reason":"why this KPI matters for these events"}]}

Rules:
- Choose 5-7 KPIs that tell a coherent story about THIS data, not generic filler.
- Use only exact field names from DATATYPE OUTPUT FIELDS. Never invent a field.
- Always include event volume over time (line, metric=count) and total event volume (single, metric=count).
- Use sum/avg/p95 only on fields whose sampled values are numeric.
- Use pie only for a low-cardinality category; bar for ranked categories.
- Use sankey only when two meaningful categorical fields form a real flow.
- Use treemap for a meaningful hierarchy.
- Keep queries feasible in Cribl KQL; no joins or guessed enrichments.
- Target style is ${style === 'vizlab' ? 'Viz-Lab, so prefer one advanced visualization when the data supports it' : 'native Cribl Search, so favor line/bar/pie/table panels'}.
- Explain each choice in reason.`;

  const sample = usableSources.map(source => ({
    sourcetype: source.sourcetype,
    datatypeOutputFields: source.parsedFieldNames,
    rawSample: source.sampleEvents.split(/\r?\n/).filter(Boolean).slice(0, 8),
  }));
  const user = `TARGET DATASET: ${datasetId}\nDATATYPE OUTPUT FIELDS: ${fields.join(', ')}\nPREPARED PROCESSING SAMPLES:\n${JSON.stringify(sample, null, 2).slice(0, 14000)}\n\nInfer which fields are categorical or numeric from these raw samples, then select the most interesting KPIs. The target dataset may still be empty; do not assume it has been queried.`;
  try {
    const raw = parseJsonResponse(await invokeAi(system, user, 4096));
    return normalizeDashboardPlan({ ...raw, selectionMode: 'ai' }, fields, datasetId);
  } catch {
    return buildSampleFallbackDashboardPlan(fields, datasetId);
  }
}

const AIV_NAMESPACE_PREFIXES = ['ncsc', 'nci', 'custom', 'tenant', 'corp', 'org', 'prod', 'dev', 'test', 'lab', 'internal', 'ext', 'external', 'collector', 'ingest', 'src', 'source'];
const AIV_FORMAT_TOKENS = ['syslog', 'cef', 'leef', 'json', 'xml', 'kv', 'kvp', 'raw', 'log', 'logs', 'estreamer', 'operational', 'rfc3164', 'rfc5424', 'nopri', 'tcp', 'udp'];

export async function aiValidateSourcetype(sourcetype: string, destFormat: string, catalog?: string[]): Promise<{
  valid: boolean; sourcetypeOk: boolean; destFormatOk: boolean; suggestion: string; clarification: string; isRealSource?: boolean;
  description?: string; logFormat?: string; typicalFields?: string[];
}> {
  const supported = (catalog && catalog.length ? catalog : []).filter(Boolean);
  const catalogBlock = supported.length
    ? `\n\nSUPPORTED SOURCETYPES (map to one of these EXACT names, or abstain — NEVER invent a name not in this list):\n${supported.join(', ')}`
    : '';

  const systemPrompt = `You resolve a customer-delivered sourcetype label to a SUPPORTED sourcetype for a Cribl Stream pack generator. Return ONLY valid JSON, no markdown.${catalogBlock}

How customers label sources (strip/ignore these — they are NOT the product):
- Namespace / tenant / collector prefixes: ${AIV_NAMESPACE_PREFIXES.join(', ')} (e.g. "ncsc:cisco:asa" is cisco_asa; "custom::paloalto:traffic" is palo_alto_traffic).
- Format / transport tokens: ${AIV_FORMAT_TOKENS.join(', ')} (e.g. "cisco_asa_syslog" is cisco_asa; "XmlWinEventLog" is a Windows event log). These describe representation, not the vendor/product.
- Colons, slashes, and double-colons are just separators.

Return JSON:
{"valid":true/false,"sourcetypeOk":true/false,"isRealSource":true/false,"destFormatOk":true,"suggestion":"the single BEST matching supported sourcetype (exact name from the list), or a comma-separated shortlist of 2-3 if genuinely ambiguous, or empty string","clarification":"short reason if you can't confidently map it, or empty string","description":"one-sentence description of what this source IS (vendor, product, what it logs) — only if isRealSource, else empty","logFormat":"the log format/encoding this source typically emits (e.g. 'syslog RFC5424', 'key=value', 'JSON', 'CEF', 'CSV', 'XML Windows Event') — only if isRealSource, else empty","typicalFields":["up to ~12 field names this source commonly emits — only if isRealSource, else omit or empty array"]}

"isRealSource" = this label clearly names a REAL, identifiable product/log source from a known vendor (aws:waf, juniper:junos:firewall, citrix:netscaler, f5:bigip, cloudflare:dns, microsoft:sharepoint), REGARDLESS of whether it's in the supported list. false ONLY for gibberish or a token so generic it names no product ("firewall","test","asdf","misc-logs","syslog","metrics").

When isRealSource is true, fill "description", "logFormat", and "typicalFields" from your own knowledge of the product — this is reused later to generate realistic sample events, so be accurate. These are your best knowledge of the real product (equivalent to what public vendor docs describe); do NOT invent fields for a source you don't recognize. Leave them empty when isRealSource is false.

Rules:
- If, after stripping namespace/format tokens, the product clearly matches ONE supported name: sourcetypeOk=true, isRealSource=true, suggestion=that exact supported name, empty clarification.
- If it plausibly matches 2-3 supported names: sourcetypeOk=false, isRealSource=true, suggestion=that shortlist, clarification=why.
- If the product is real and identifiable but NOT in the supported list (SharePoint/Cloudflare/Juniper/AWS WAF…): sourcetypeOk=false, isRealSource=true, suggestion="", clarification="Real source, no golden path — build via AI." DO NOT invent a supported name.
- If gibberish/too generic ("firewall","test","asdf","misc-logs"): sourcetypeOk=false, isRealSource=false, suggestion=closest supported names if any, clarification=why.
- Only validate what is provided — if destFormat is empty, set destFormatOk true.
- Always copy supported names verbatim from the list — never a made-up variant.`;

  const userPrompt = `Customer sourcetype label: "${sourcetype || ''}"${destFormat ? `\nDestination format: "${destFormat}"` : ''}`;

  try {
    const text = await invokeAi(systemPrompt, userPrompt, 512);
    const out = parseJsonResponse(text);
    // Enforce grounding: drop any suggested name not in the supported catalog.
    if (supported.length && out && typeof out.suggestion === 'string' && out.suggestion) {
      const norm = (s: string) => s.trim().toLowerCase().replace(/[\s:/-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const supSet = new Set(supported.map(norm));
      const kept = out.suggestion.split(',').map((s: string) => s.trim()).filter(Boolean).filter((s: string) => supSet.has(norm(s)));
      out.suggestion = kept.join(', ');
      if (!out.suggestion) {
        out.sourcetypeOk = false;
        if (!out.clarification) out.clarification = 'No supported sourcetype matches this label.';
      }
    }
    // Normalize the enrichment bundle: only trust it for a real source.
    if (out && !out.isRealSource) { out.description = ''; out.logFormat = ''; out.typicalFields = []; }
    if (out && !Array.isArray(out.typicalFields)) out.typicalFields = out.typicalFields ? [String(out.typicalFields)] : [];
    return out;
  } catch {
    return { valid: true, sourcetypeOk: true, destFormatOk: true, suggestion: '', clarification: '' };
  }
}

export async function aiDetectSourcetype(sampleEvents: string): Promise<{
  sourcetype: string; confidence: string; reason: string;
}> {
  if (!sampleEvents || sampleEvents.trim().length === 0) {
    return { sourcetype: '', confidence: 'none', reason: 'No sample events provided' };
  }

  const lines = sampleEvents.trim().split('\n').filter(Boolean).slice(0, 10);
  const preview = lines.join('\n');
  // Format first: a CEF sample (bare or syslog-framed) names its source in the
  // header, so it is answered locally — the same rule as the wizard's Tier 0 and
  // the standalone detector (scripts/ai-validate.mjs).
  const cefSource = recognizeCefSource(sampleEvents);
  if (cefSource) return { sourcetype: cefSource.sourcetype, confidence: 'high', reason: cefSource.reason };
  // The model is told the wire format rather than left to infer it: the
  // deterministic classifier is right about SHAPE far more often than the model.
  const wire = describeSampleFormat(lines);

  const systemPrompt = `You are a log format classifier. Given sample log events, identify the sourcetype (data source).
Return ONLY valid JSON with these fields:
{"sourcetype":"<value>","confidence":"high|medium|low","reason":"one sentence explaining why"}

Known sourcetypes (use these exact values when matched):
cef, cisco_asa, cisco_firepower, palo_alto_traffic, palo_alto_threat, fortinet_fortigate, checkpoint_firewall,
windows_powershell, windows_security, windows_sysmon, linux_syslog, linux_audit, crowdstrike_falcon,
aws_cloudtrail, aws_vpc_flow, azure_signin, gcp_audit, okta_system, zscaler_web, apache_access, nginx_access

If the events don't match any known type, return a descriptive kebab-case sourcetype (e.g. "juniper_srx", "f5_bigip_ltm", "custom_json_app").

Identification hints:
- Decide the wire format FIRST (it is given below), then the source from the fields it carries.
- A CEF:<n>| header (at line start or after a syslog frame) → sourcetype "cef", unless its Device Vendor|Product is Fortinet|FortiGate → fortinet_fortigate, or Check Point → checkpoint_firewall. Never name any other vendor (Zscaler / Infoblox / Imperva / Palo Alto…) from a CEF header.
- %ASA- in syslog → cisco_asa
- Comma-separated with 40+ fields, starts with 1,date → palo_alto_traffic or palo_alto_threat
- key=value with devname="FGT → fortinet_fortigate
- product="VPN-1 & FireWall-1" → checkpoint_firewall
- SFIMS: Protocol: → cisco_firepower
- XML with <Event><System><EventID> → windows_security or windows_sysmon or windows_powershell
- RFC3164 syslog (month day time host process[pid]) → linux_syslog
- type=SYSCALL msg=audit → linux_audit
- JSON with eventName + userIdentity + awsRegion → aws_cloudtrail
- Space-separated: version account-id interface-id srcaddr dstaddr → aws_vpc_flow
- JSON with properties.userDisplayName + status.errorCode → azure_signin
- JSON with protoPayload + resource.type → gcp_audit
- JSON with eventType + actor + outcome → okta_system
- Combined log format (IP - user [date] "METHOD path" status bytes) → apache_access or nginx_access
- JSON with DetectionSummaryEvent or detect → crowdstrike_falcon`;

  try {
    const text = await invokeAi(systemPrompt, `Wire format (detected locally): ${wire.label}${wire.mixed ? ' — mixed sample' : ''}\n\nIdentify the sourcetype of these events:\n\n${preview}`, 256);
    return parseJsonResponse(text);
  } catch (err) {
    // Surface the cause (AI proxy unreachable, auth, parse) so an unavailable
    // AI isn't mistaken for an unrecognized file.
    return { sourcetype: '', confidence: 'none', reason: `Detection failed: ${err instanceof Error ? err.message : 'AI unavailable'}` };
  }
}

export async function aiAdvise(sourcetype: string, destFormat: string, sampleSnippet: string, allowCodeFunctions: boolean, onProgress?: AiProgressCallback): Promise<any> {
  onProgress?.('researching', `Researching ${sourcetype} format and ${destFormat} schema...`);
  const [sourceDoc, destDoc] = await Promise.all([
    aiResearchSourceFormat(sourcetype),
    aiResearchDestFormat(destFormat),
  ]);
  onProgress?.('analyzing', 'Documentation loaded. Analyzing pipeline strategy...');

  const systemPrompt = `You are a Cribl Stream pipeline architect. Return ONLY valid JSON — no markdown, no code fences, no text outside the JSON.

You have access to documentation for both the source and destination:

--- SOURCE FORMAT DOCUMENTATION ---
${sourceDoc}
--- END SOURCE DOCUMENTATION ---

--- DESTINATION SCHEMA ---
${destDoc}
--- END DESTINATION SCHEMA ---

Be concise: each string value should be 1-2 sentences max. Lists should have 3-5 items max, each under 15 words.

Required JSON shape:
{"summary":"...","parseStrategy":"...","mappingNotes":"...","reductionOpportunities":["..."],"risks":["..."],"pipelineSteps":["..."]}

Cribl context:
- Functions: comment, eval, code, serde, regex_extract, rename, drop, serialize, mask, lookup
- Code functions use __e for event access; eval cannot use arrow functions
- No code functions = use regex_extract or eval only`;

  const userPrompt = `Source: ${sourcetype}
Destination format: ${destFormat}
Code functions allowed: ${allowCodeFunctions ? 'yes' : 'no'}${optimizationGuidance(sourcetype, destFormat, 'advise')}
${sampleSnippet ? `\nSample event snippet:\n${sampleSnippet}` : ''}

Provide your pipeline recommendations as JSON. reductionOpportunities and risks must respect the destination constraints above.`;

  const text = await invokeAi(systemPrompt, userPrompt, 2048);
  onProgress?.('done', 'Pipeline recommendations ready.');
  return parseJsonResponse(text);
}

export async function analyzeBuildTrace(traceSummary: string, userComment: string): Promise<string> {
  const systemPrompt = `You are a Cribl Stream pipeline reviewer. You are given a condensed build trace for one or more generated pipelines (source recognition, candidate scores, chosen stage sources, key events, and the final pipeline's function composition) plus a note from the person who built it about what they think is wrong.

Answer in plain text (no JSON, no markdown headers) in 3 short sections:
1. What the trace actually shows — cite specific stage scores, reasons, or events that support or contradict the reporter's comment.
2. Likely root cause(s) of the quality problem, grounded ONLY in what appears in the trace (do not invent fields or events not mentioned).
3. Concrete next steps in the Cribl Pack Generator app to improve it (e.g. re-run with a real/extended sample, add a static parser for this sourcetype, adjust the destination format mapping, check for a canonical field-name mismatch) — be specific to what the trace shows, not generic advice.

Keep the whole answer under 300 words.`;

  const userPrompt = `Reporter's comment on what is wrong with this pack:
${userComment.trim() || '(no comment provided — just analyze the trace for signs of a quality problem)'}

Build trace:
${traceSummary}`;

  return invokeAi(systemPrompt, userPrompt, 1200);
}

export interface FieldMapping {
  sourceField: string;
  destField: string;
  expression: string;
}

export interface AiMappingResult {
  mappings: FieldMapping[];
  classInfo?: Record<string, string>;
}

const DEST_SCHEMA_HINTS: Record<string, string> = {
  nextgen: `CrowdStrike NG SIEM — raw fidelity. Do NOT map fields: the NG SIEM connector's vendor parser reads only the original line, so the pack ships _raw unchanged (and _time) and nothing else; every extra field is billed and ignored.`,

  ocsf: `OCSF v1.9 schema. Required fields by class:
- Network Activity (class_uid=4001, category_uid=4): activity_id (1=open,2=close,5=refuse), severity_id (0-6), src_endpoint.ip, src_endpoint.port, dst_endpoint.ip, dst_endpoint.port, connection_info.protocol_name, metadata.version="1.9.0", metadata.product.name, type_uid=400100+activity_id
- Authentication (class_uid=3002, category_uid=3): activity_id (1=logon,2=logoff,3=auth_ticket), actor.user.name, src_endpoint.ip, dst_endpoint.hostname, status_id (1=success,2=failure), metadata.version="1.9.0"
- Process Activity (class_uid=1007, category_uid=1): activity_id (1=launch,2=terminate), process.name, process.cmd_line, process.pid, actor.user.name, device.hostname
- DNS Activity (class_uid=4003): query.hostname, answers[].rdata, rcode_id
${OCSF_STATUS_MAPPING_RULE}
Use dot notation for nested fields. Values must be valid Cribl eval expressions (no arrow functions).`,

  cef: `CEF (Common Event Format) — output is a single _raw string:
CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extensions
Extension keys (use standard CEF key names):
- src (source IP), dst (destination IP), spt (source port), dpt (destination port)
- proto (protocol), act (device action: allow/deny/drop)
- in (bytes received), out (bytes sent)
- suser (source user), duser (destination user)
- shost (source hostname), dhost (destination hostname)
- deviceInboundInterface, deviceOutboundInterface
- app (application protocol)
- fname (file name), fileHash, request (URL)
- cs1Label + cs1, cs2Label + cs2 (custom string pairs)
The entire event output is ONE _raw field containing the CEF string. No separate columns.
Values must be valid Cribl eval expressions.`,

  commonsecuritylog: `Microsoft Sentinel CommonSecurityLog table columns (flat PascalCase fields):
- DeviceVendor, DeviceProduct, DeviceVersion (strings identifying the source device)
- DeviceEventClassID (event type identifier)
- Activity (human-readable event name)
- LogSeverity (0-10 integer)
- SourceIP, SourcePort, DestinationIP, DestinationPort
- Protocol (TCP/UDP/ICMP)
- DeviceAction (Allow/Deny/Block/Drop/Success/Failure)
- SentBytes, ReceivedBytes
- SourceUserName, DestinationUserName
- SourceHostName, DestinationHostName
- DeviceInboundInterface, DeviceOutboundInterface
- ApplicationProtocol
- DeviceCustomString1Label + DeviceCustomString1 (custom key-value pair)
- DeviceCustomString2Label + DeviceCustomString2
- SourceTranslatedAddress, DestinationTranslatedAddress (NAT)
- FileName, FileHash, RequestURL
- LogonType
Output is JSON with these PascalCase columns as top-level fields (for Sentinel table ingestion via DCR).
Values must be valid Cribl eval expressions.`,

  cim: `Splunk CIM data model fields:
- Network Traffic: src, src_port, dest, dest_port, transport (tcp/udp), action (allowed/blocked), app, bytes_in, bytes_out, packets_in, packets_out, duration, vendor_action, rule, user, protocol
- Authentication: user, src, dest, action (success/failure), app, authentication_method, signature, signature_id
- Endpoint/Process: process, process_id, parent_process, parent_process_id, user, dest, action (allowed/blocked/created), file_name, file_path
- Change: user, command, object, object_category, action, result, dest
Values must be valid Cribl eval expressions.`,

  ecs: `Elastic Common Schema (ECS) fields — use dot notation:
- event.kind (event/alert/signal), event.category (array: network/authentication/process/host), event.type (array: allowed/denied/start/end/connection/info), event.outcome (success/failure/unknown), event.action
- source.ip, source.port, source.bytes, source.user.name
- destination.ip, destination.port, destination.bytes
- network.transport (tcp/udp), network.protocol, network.bytes, network.direction (inbound/outbound/internal/external)
- user.name, user.domain, user.id
- host.name, host.ip
- process.name, process.pid, process.command_line, process.parent.name
- observer.vendor, observer.product, rule.name
- file.name, file.path, file.hash.sha256
Values must be valid Cribl eval expressions.`,

  asim: `Microsoft Sentinel ASIM normalized schema fields:
- NetworkSession: EventType="NetworkSession", EventSchema="NetworkSession", EventSchemaVersion="0.2.6", EventResult (Success/Failure), EventSeverity (Informational/Low/Medium/High/Critical), DvcAction (Allow/Deny/Drop/Reset), SrcIpAddr, SrcPortNumber, DstIpAddr, DstPortNumber, NetworkProtocol, SrcBytes, DstBytes, NetworkDirection, EventProduct, EventVendor, DvcHostname, SrcUsername, DstUsername
- Authentication: EventType="Logon"/"Logoff", EventSchema="Authentication", EventSchemaVersion="0.1.3", EventResult, EventSeverity, TargetUsername, SrcIpAddr, TargetHostname, LogonMethod, ActingAppName, EventProduct, EventVendor
- ProcessEvent: EventType="ProcessCreated", EventSchema="ProcessEvent", EventSchemaVersion="0.1.4", ActorUsername, TargetProcessName, TargetProcessCommandLine, ActingProcessName, DvcHostname
Values must be valid Cribl eval expressions.`,

  chronicle: `Google Chronicle UDM fields — use dot notation:
- metadata.event_type (REQUIRED — the destination drops the event otherwise): NETWORK_CONNECTION, USER_LOGIN, PROCESS_LAUNCH, FILE_CREATION, GENERIC_EVENT, STATUS_UPDATE
- metadata.event_timestamp is set by the pipeline from _time as {seconds, nanos} — do not map it
- metadata.vendor_name, metadata.product_name, metadata.description
- principal.ip and target.ip are ARRAYS: [String(src_ip)]. principal.port, principal.hostname, principal.user.userid, principal.process.file.full_path, principal.process.command_line, principal.process.pid (string)
- target.port, target.hostname, target.user.userid, target.url, target.file.full_path
- network.ip_protocol (TCP/UDP/ICMP/ICMP6 — the L4 transport, never an app protocol), network.application_protocol (HTTP/HTTPS/DNS/SSH…), network.sent_bytes, network.received_bytes, network.direction (INBOUND/OUTBOUND)
- security_result.action is an ARRAY of ALLOW/BLOCK/UNKNOWN_ACTION/QUARANTINE/FAIL/CHALLENGE — use UNKNOWN_ACTION, never a guess; security_result.severity (LOW/MEDIUM/HIGH/CRITICAL), security_result.rule_name
- extensions.auth.type (MACHINE/SSO/VPN/PHYSICAL/TACACS/AUTHTYPE_UNSPECIFIED); extensions.auth.mechanism is an ARRAY (INTERACTIVE/NETWORK/REMOTE_INTERACTIVE/SERVICE/USERNAME_PASSWORD/OTP/MECHANISM_OTHER…)
- Any value outside a UDM enum, or a scalar for an array field, fails the whole batch with 400
Values must be valid Cribl eval expressions.`,

  json: `Clean normalized JSON — create a flat/shallow structure with descriptive field names:
- event_type (network/authentication/process/dns/file/generic)
- timestamp, src_ip, src_port, dst_ip, dst_port, protocol, action, outcome
- user, src_host, dst_host, app, rule, severity
- bytes_in, bytes_out, duration, packets
- process_name, process_id, command_line, parent_process
- file_name, file_path, file_hash
- sourcetype (original sourcetype label)
Only include fields relevant to the data. Values must be valid Cribl eval expressions.`,

  xsiam: `Cortex XSIAM passthrough — DO NOT map fields to a target schema. XSIAM parses vendor formats natively.
Required output:
- Preserve _raw unchanged (the original vendor log line or JSON blob)
- __sourceIdentifier (or __sourceidentifier): data-source UUID from the XSIAM collector catalog — one per dedicated source type
- __vendor + __product: required when using the generic UUID collector (af01292940d7426594d3d3e55ae17ee0); omit when a dedicated UUID is used
Patterns:
- tag_only: add __sourceIdentifier only (OKTA, AWS audit, CrowdStrike, etc.)
- tag_vendor_product: add __sourceIdentifier + __vendor + __product (Cisco ASA syslog, FortiGate syslog)
- cef_extract: regex_extract __vendor/__product from CEF header, then add __sourceIdentifier (Check Point CEF)
- zscaler_wrap: event=_raw, tags, then serialize to JSON _raw envelope (Zscaler ZIA)
Do NOT parse, normalize, or drop _raw. Do NOT build CIM/OCSF/CEF output. Values must be valid Cribl eval expressions.`,
};

export async function aiGenerateParse(sourcetype: string, sampleSnippet: string, onProgress?: AiProgressCallback, guidance?: string): Promise<{ functions: any[] } | null> {
  onProgress?.('researching', `Analyzing ${sourcetype} log format...`);
  const guidancePrompt = guidance?.trim()
    ? `\n\nOPERATOR GUIDANCE (must honour unless it would break Cribl eval rules):\n${guidance.trim()}`
    : '';

  const systemPrompt = `You are an expert at building Cribl Stream pipeline parse functions. Given sample log events, generate the correct Cribl pipeline functions to extract structured fields from _raw.

Return ONLY valid JSON with this shape:
{"functions":[...array of Cribl pipeline function objects...]}

Each function object must be a valid Cribl pipeline function with this structure:
- id: "regex_extract" | "eval" | "serde"
- filter: JS expression string (usually "true")
- disabled: false
- description: short explanation
- conf: configuration object specific to the function type

IMPORTANT: Do NOT use "code" functions. Use only regex_extract and eval.

For regex_extract:
- conf.source: "_raw" (the field to extract from)
- conf.regex: "/regex with (?<named_groups>...)/" (Cribl regex format with forward slashes)
- conf.iterations: 1
- conf.overwrite: false

For eval:
- conf.add: array of {name, value} objects
- conf.remove: optional array of field names to remove
- value must be a valid Cribl eval expression (NO arrow functions, NO function keyword, NO optional chaining ?., NO nullish coalescing ??)

For serde (ONLY for confirmed JSON/CSV/KVP/delimited sources):
- conf.mode: "extract"
- conf.type: "json" | "csv" | "kvp"
- conf.srcField: "_raw"
- conf.fields: ["col1","col2",...]  — REQUIRED for csv/delimited positional logs, in column order
- conf.delimChar: the ACTUAL field delimiter — a single character. "," for comma CSV, "\t" for TAB-separated (TSV), "|" for pipe-delimited, ";" for semicolon. This defaults to a comma, so you MUST set it for anything that is not comma-separated.
- conf.quoteChar: usually a double-quote character (only if fields are quoted)
- For kvp: conf.delimChar is the pair separator (often " ") and conf.pairDelim is "="

Rules:
- Analyse the sample events to determine the log format AND its delimiter
- For text-based logs with no fixed delimiter: use regex_extract with named groups
- For JSON logs: use serde with type "json"
- For DELIMITED positional logs (comma, TAB, pipe, semicolon — e.g. Zscaler ZIA TSV, proxy access logs): use serde type "csv", set conf.delimChar to the real delimiter, and list every column in conf.fields in order. A TAB-separated line MUST use delimChar "\t" — a comma serde on tab data collapses the whole record into one field and every downstream field is empty.
- For KVP logs: use serde with type "kvp" with correct delimChar/pairDelim
- NEVER use serde type "json" on non-JSON text logs
- Keep it minimal: 2-6 functions total`;

  const userPrompt = `Source type: ${sourcetype}

Sample events (first lines from _raw):
${sampleSnippet}
${guidancePrompt}

Analyze the format and generate the minimal set of Cribl pipeline functions needed to parse these events into structured fields.`;

  const text = await invokeAi(systemPrompt, userPrompt, 8192);
  onProgress?.('done', 'Parse functions generated.');
  const parsed = parseJsonResponse(text);
  if (parsed?.functions?.length) {
    // Deterministic backstop: a csv serde left on the default comma delimiter
    // collapses a TAB/pipe-delimited record into one field (the ZIA TSV bug).
    // Correct the delimiter from the sample before the functions leave here.
    parsed.functions = repairDelimitedSerde(parsed.functions, sampleSnippet.split('\n'));
    return parsed;
  }
  // A bare null here reaches the wizard as "AI parse returned no functions" with
  // no cause, and the caller then silently re-derives extraction per format.
  // Say which of the three ways it went wrong.
  if (!text.trim()) throw new Error('AI returned an empty response');
  if (!parsed) throw new Error(`AI response was not usable JSON: ${text.trim().slice(0, 120)}`);
  throw new Error(`AI returned JSON with no parse functions (keys: ${Object.keys(parsed).join(', ') || 'none'})`);
}

export async function aiGenerateMapping(
  sourcetype: string,
  destFormat: string,
  sampleSnippet: string,
  onProgress?: AiProgressCallback,
  parsedFields?: string[],
  improveHints?: {
    findings?: { severity: string; field: string; issue: string }[];
    missingFields?: string[];
    emptyFields?: string[];
    guidance?: string;
    currentFunctions?: any[];
  },
): Promise<AiMappingResult> {
  onProgress?.('researching', `Researching ${sourcetype} fields and ${destFormat} schema...`);
  const [sourceDoc, destDoc] = await Promise.all([
    aiResearchSourceFormat(sourcetype),
    aiResearchDestFormat(destFormat),
  ]);
  onProgress?.('mapping', 'Building field mappings from source to destination schema...');

  // A concretized OCSF key gets its class's vendored schema (required/recommended
  // attributes, activity enum, type_uid rule) — not the generic multi-class blurb.
  // Guidance that names a class (class_uid=3003, "Authorize Session") wins, so
  // the hint never contradicts what the operator asked for.
  const guidedOcsf = /^ocsf(#|$)/.test(destFormat) ? parseOcsfGuidance(improveHints?.guidance) : null;
  const hintFormat = guidedOcsf?.key || destFormat;
  const schemaHint = (/^ocsf#/.test(hintFormat) && ocsfMappingHintForKey(hintFormat)) || DEST_SCHEMA_HINTS[destFormat] || getSentinelDestinationSchema(destFormat) || destDoc;
  const sentinelMappingContext = getSentinelSolutionMappingContext(sourcetype, destFormat);
  const parsedFieldsPrompt = parsedFields?.length
    ? `Parsed source fields:\n${parsedFields.join(', ')}`
    : 'Parsed source fields: none supplied; infer only fields supported by the sample and source documentation.';
  const improvementPrompt = improveHints
    ? `Previous quality findings to correct:\n${JSON.stringify({
        findings: improveHints.findings || [],
        missingFields: improveHints.missingFields || [],
        emptyFields: improveHints.emptyFields || [],
      })}`
    : '';
  const guidedTarget = guidedOcsf?.classUid != null
    ? `\nTARGET CLASS: OCSF ${guidedOcsf.caption} — set class_uid=${guidedOcsf.classUid}${guidedOcsf.activityId != null ? `, activity_id=${guidedOcsf.activityId}, type_uid=${guidedOcsf.classUid * 100 + guidedOcsf.activityId}` : ''} on every event.`
    : guidedOcsf?.activityId != null ? `\nTARGET ACTIVITY: activity_id=${guidedOcsf.activityId}.` : '';
  const guidancePrompt = improveHints?.guidance?.trim()
    ? `OPERATOR GUIDANCE (must honour unless it would break Cribl eval rules):\n${improveHints.guidance.trim()}${guidedTarget}`
    : '';
  const currentPipelinePrompt = improveHints?.currentFunctions?.length
    ? `CURRENT PIPELINE FUNCTIONS (preserve working behavior unless improving it):\n${JSON.stringify(improveHints.currentFunctions).slice(0, 12000)}`
    : '';

  const systemPrompt = `You are a field mapping expert for log data normalization. Given sample events from a specific source and a target schema, produce precise field mappings.

You have access to documentation for both the source format and the destination schema:

--- SOURCE FORMAT DOCUMENTATION ---
${sourceDoc}
--- END SOURCE DOCUMENTATION ---

Return ONLY valid JSON with this shape:
{"mappings":[{"sourceField":"<field from parsed event>","destField":"<target schema field>","expression":"<Cribl eval expression>"}],"classInfo":{"class_uid":"...","category_uid":"...","event_type":"..."}}

Rules for expressions:
- Must be valid Cribl eval expressions (NO arrow functions, NO function keyword)
- Each expression MUST be under 200 characters — split complex logic into multiple mappings
- Use field names directly: src_ip, EventID, action — these are available after parsing
- For string literals use single quotes: 'TCP'
- For conditionals: action == 'allow' ? 'Success' : 'Failure'
- For type coercion: src_port ? Number(src_port) : undefined, String(EventID || '') — never default a missing number to 0; a value the event does not carry must stay absent
- For string methods: (protocol || '').toUpperCase()
- For fallback chains: src_ip || srcaddr || srcip || ''
- For a nested source OBJECT guard each level: properties && properties.status && properties.status.errorCode
- A FLAT field whose name contains a dot or hyphen (Zeek/Corelight id.orig_h, id.resp_p) is one key, not a path: read it as __e['id.orig_h'] — never id.orig_h and never a bare ['id.orig_h']
- NEVER generate a single expression that assembles the entire _raw output — map individual fields only, the framework handles serialization

classInfo should contain schema-specific class/type identifiers (e.g. OCSF class_uid, UDM event_type, ASIM EventSchema).

Produce 15-25 mappings covering all relevant fields from the source data. Use the source documentation to understand ALL available fields — not just the ones visible in the sample snippet. Focus on fields that are standard for this source type even if a particular sample event doesn't show them all.`;

  const userPrompt = `Source: ${sourcetype}
Target schema: ${hintFormat}

Target schema reference:
${schemaHint}
${optimizationGuidance(sourcetype, destFormat, 'mapping')}
${sentinelMappingContext}

${parsedFieldsPrompt}

${currentPipelinePrompt}

${improvementPrompt}

${guidancePrompt}

Sample events (first 5):
${sampleSnippet}

Generate precise field mappings from the source fields to the target schema.`;

  const text = await invokeAi(systemPrompt, userPrompt, 4096);
  onProgress?.('done', 'Field mappings generated.');
  return validateMappingResult(parseJsonResponse(text));
}

// --- Dynamic documentation research (cached per session) ---

const sourceDocCache: Record<string, string> = {};
const destDocCache: Record<string, string> = {};

export async function aiResearchSourceFormat(sourcetype: string): Promise<string> {
  if (sourceDocCache[sourcetype]) return sourceDocCache[sourcetype];

  const systemPrompt = `You are a log format documentation expert. Given a sourcetype name, provide a precise technical specification of the log format that this source produces. This will be used to generate realistic sample data and build parsing pipelines.

Return a structured specification covering:
1. EVENT FORMAT: The exact structure (syslog header? key=value? CSV? JSON? XML?)
2. FIELD LIST: All standard fields with their names, types, and valid values
3. EVENT SUBTYPES: Different event types/categories and how they differ
4. VALID ENUMERATIONS: For each enum field, list ALL valid values (e.g., actions, severities, protocols)
5. REALISTIC RANGES: Numeric fields with min/typical/max ranges
6. EXAMPLE EVENTS: 2-3 complete realistic example events showing different subtypes

Be precise and comprehensive. Use the EXACT field names, separators, and quoting that appear in real logs from this source. Reference the vendor's actual documentation format — not approximations.

If you don't know the exact format for this source, say so clearly rather than guessing.`;

  // Deliberately bounded: this runs in the browser, where the platform proxy
  // cancels at 30s, and a "comprehensive" specification is precisely the kind of
  // long answer that misses that window. It only has to be good enough to ground
  // the generation calls that follow.
  const userPrompt = `Provide the log format specification for: ${sourcetype}

Be concise — field names, separators, valid values and 2 example events. Prefer completeness of FIELD NAMES over prose; omit commentary.`;

  const text = await invokeAi(systemPrompt, userPrompt, FORMAT_RESEARCH_MAX_TOKENS);
  sourceDocCache[sourcetype] = text;
  return text;
}

export async function aiResearchDestFormat(destFormat: string): Promise<string> {
  if (destDocCache[destFormat]) return destDocCache[destFormat];

  const schemaHint = (/^ocsf#/.test(destFormat) && ocsfMappingHintForKey(destFormat)) || DEST_SCHEMA_HINTS[destFormat];
  if (schemaHint) {
    destDocCache[destFormat] = schemaHint;
    return schemaHint;
  }

  const sentinelSchema = getSentinelDestinationSchema(destFormat);
  if (sentinelSchema) {
    destDocCache[destFormat] = sentinelSchema;
    return sentinelSchema;
  }

  const systemPrompt = `You are a data schema expert. Given a destination format name, provide the precise schema specification including all required fields, their types, naming conventions, and structural rules. This will be used to build field mapping pipelines.

Return:
1. SCHEMA STRUCTURE: How the output should look (flat JSON? nested? specific field naming?)
2. REQUIRED FIELDS: Fields that MUST be present with their exact names and types
3. OPTIONAL FIELDS: Common optional fields
4. ENUM VALUES: For each enum/classification field, list all valid values
5. NAMING CONVENTIONS: camelCase? snake_case? PascalCase? dot notation for nesting?
6. EXAMPLE OUTPUT: A complete example of what a correctly formatted output event looks like`;

  const userPrompt = `Provide the complete schema specification for destination format: ${destFormat}`;

  const text = await invokeAi(systemPrompt, userPrompt, 4000);
  destDocCache[destFormat] = text;
  return text;
}

export function clearDocCache() {
  Object.keys(sourceDocCache).forEach(k => delete sourceDocCache[k]);
  Object.keys(destDocCache).forEach(k => delete destDocCache[k]);
}

export type AiProgressCallback = (step: string, detail?: string) => void;

// Split AI-generated sample text into one event per line. The prompt asks for
// one event per line, but for JSON sources the model often pretty-prints each
// object across many lines. A naive .split('\n') shreds those into fragments
// (e.g. `"userName": "Hashimoto"` on its own line) that later fail JSON.parse.
// This coalesces brace/bracket-balanced multi-line JSON objects back into one
// compact line each, while leaving already-single-line events untouched.
export function coalesceSampleLines(text: string): string[] {
  const rawLines = text.split('\n');
  // Fast path: if nothing looks like a pretty-printed JSON container, keep the
  // simple line split (covers syslog, CEF, kvp, and JSONL).
  const looksPretty = rawLines.some(l => /^\s*[{[]\s*$/.test(l) || /^\s+["}\]]/.test(l));
  if (!looksPretty) return rawLines.filter(l => l.trim().length > 0);

  const events: string[] = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (depth === 0 && trimmed.length === 0) continue;
    buf += (buf ? '\n' : '') + line;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    if (depth <= 0) {
      const candidate = buf.trim();
      if (candidate) {
        // Re-serialize valid JSON to one compact line; else keep as-is.
        try { events.push(JSON.stringify(JSON.parse(candidate))); }
        catch { events.push(candidate.replace(/\n\s*/g, ' ')); }
      }
      buf = '';
      depth = 0;
      inStr = false;
      esc = false;
    }
  }
  if (buf.trim()) events.push(buf.trim().replace(/\n\s*/g, ' '));
  return events.filter(e => e.length > 0);
}

/**
 * This is the BROWSER generation path — it only ever runs inside the iframe
 * (standalone routes generation to the backend), so every call it makes has to
 * come back inside the platform proxy's 30s ceiling. It used to ask for all the
 * events at once with a 16,000-token allowance, which cannot: the demo failed on
 * every source that had no stored sample, reporting the platform's bare
 * `Request timeout`. See src/ai-budget.ts.
 */
export async function aiGenerateSamples(sourcetype: string, count: number, onProgress?: AiProgressCallback, grounding?: SampleGrounding | null): Promise<{ events: string[]; count: number; verification?: SampleVerification }> {
  onProgress?.('researching', `Researching official ${sourcetype} log format documentation...`);
  const formatDoc = await aiResearchSourceFormat(sourcetype);
  const groundingBlock = renderSampleGroundingPrompt(grounding);

  const plan = sampleGenerationPlan(count);
  const batches = Math.ceil(count / plan.batchSize);
  let allEvents: string[] = [];
  // Verification feedback from a rejected round, injected into the next round's
  // prompt. Mirrors what generateValidatedSample does on the backend (Hard Rule
  // 18); iframe mode cannot stage samples to disk, but it must not hand back
  // events the source's own parser can't read either.
  let feedback = '';
  let verification: SampleVerification | undefined;
  const MAX_ROUNDS = 2;

  onProgress?.('generating', `Format identified. Generating ${count} events in batches of ${plan.batchSize}...`);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
  let earlyReject = false;
  for (let b = 0; b < batches; b++) {
    const batchCount = Math.min(plan.batchSize, count - allEvents.length);
    if (batchCount <= 0) break;

    const systemPrompt = `You are a log generator that produces realistic, diverse sample events. Return ONLY the raw events, one per line. No markdown, no numbering, no explanation.

You have access to the following vendor documentation for this log source. Use it to ensure every field name, value, and format detail matches the real vendor specification EXACTLY:

--- SOURCE FORMAT DOCUMENTATION ---
${formatDoc}
--- END DOCUMENTATION ---
${groundingBlock}
Requirements for diversity:
- Vary timestamps across a 24-hour window (use recent dates)
- Use diverse IP addresses (mix of internal 10.x, 172.16.x, 192.168.x and external public ranges)
- Include different users/accounts/principals
- Mix different event types, severities, and outcomes (success AND failures)
- Include both routine operations and security-relevant events
- Vary hostnames, interfaces, zones, ports, protocols
- Use ONLY field names and values that are documented above — do not invent fields
- Make events realistic enough that a SOC analyst would find them plausible
- For structured formats (JSON, XML), maintain valid syntax per event
- Each event should be unique
- Include commonly-missed fields that real devices produce (MAC addresses, UUIDs, counters, reputation scores, etc.)`;

    const buildUserPrompt = (n: number) => `Generate exactly ${n} diverse ${sourcetype} log events.${allEvents.length > 0 ? `\nDo NOT repeat any of these already-generated events:\n${allEvents.slice(-5).join('\n')}` : ''}
Return raw events only, one per line. No numbering, no code fences.${feedback}`;

    // A timed-out batch is retried SMALLER rather than abandoned, and whatever
    // earlier batches produced is kept: a demo built on 12 good events is worth
    // far more than one that fails outright because the last batch was slow.
    let text = '';
    try {
      text = await invokeAi(systemPrompt, buildUserPrompt(batchCount), plan.maxTokens);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isProxyTimeout(msg)) throw err;
      onProgress?.('generating', `Batch timed out — retrying with ${plan.retryBatchSize} events...`);
      try {
        text = await invokeAi(systemPrompt, buildUserPrompt(plan.retryBatchSize), plan.retryMaxTokens);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (allEvents.length >= plan.minUsableEvents) break;
        throw new Error(describeProxyTimeout(retryMsg));
      }
    }

    // Shared with the backend's cleanSampleText: fences AND leaked reasoning.
    const lines = coalesceSampleLines(stripAiReasoning(text)).filter(l => !isEmptyEvent(l));
    allEvents.push(...lines);

    onProgress?.('generating', `Generated ${allEvents.length} of ${count} events...`);

    // EARLY FORMAT GATE — decide the wire format is wrong on the FIRST batch, not
    // after all ~100 events (which is minutes of proxy round-trips). If batch 0 is
    // the wrong log family / format, every later batch will be too, so abandon the
    // rest of the round now and restart with corrective feedback ("take the right
    // turn"). Only on rounds that still have a retry left — the final round always
    // runs to completion and reports whatever the full-sample check concludes.
    // verifyGeneratedSample is a local parser-emulation check (no AI, no network),
    // so this costs nothing but the parse of a handful of lines.
    if (b === 0 && round < MAX_ROUNDS && allEvents.length > 0) {
      const early = verifyGeneratedSample(sourcetype, allEvents, { synthetic: true });
      if (early.verdict === 'fail') {
        verification = early;
        feedback = renderVerificationFeedback(early);
        earlyReject = true;
        onProgress?.('generating', `First batch was not valid ${sourcetype} format — correcting before generating the rest...`);
        break;
      }
    }
  }

    if (earlyReject) {
      allEvents = [];
      continue;
    }

    // `synthetic: true` — these events came from the model, so the key-echo check
    // applies (a log named after its own Splunk sourcetype was written from the
    // key, not from the vendor's format).
    verification = verifyGeneratedSample(sourcetype, allEvents, { synthetic: true });
    if (verification.verdict !== 'fail' || round === MAX_ROUNDS) break;
    // Rejected: tell the model exactly what failed and start the round over with
    // a clean event list, so a wrong-format batch isn't mixed into the result.
    feedback = renderVerificationFeedback(verification);
    allEvents = [];
    onProgress?.('generating', `Sample rejected by the ${sourcetype} parser — regenerating with corrections...`);
  }

  const note = verification && verification.verdict === 'fail'
    ? ` (WARNING: the ${sourcetype} parser could not read these events — ${verification.reasons[0] || 'verification failed'})`
    : '';
  onProgress?.('done', `Generated ${allEvents.length} events based on vendor documentation.${note}`);
  return { events: allEvents.slice(0, count), count: Math.min(allEvents.length, count), verification };
}

/**
 * Extend a REAL sample with more events of the same source (iframe/client path;
 * the standalone backend does the same through handleAiExtendSample).
 *
 * Unlike `aiGenerateSamples` this does no format research and gets no diversity
 * licence: the real lines are the specification, and the caller discards anything
 * that departs from them (`guardExtendedEvents`).
 *
 * `ask` and `maxTokens` come from `sampleExtensionAttempts` via api.ts — the retry
 * policy lives there so both run modes obey the same one.
 */
export async function aiExtendSampleEvents(
  sourcetype: string,
  realEvents: string[],
  ask: number,
  maxTokens: number,
  feedback?: string,
): Promise<string[]> {
  const { systemPrompt, userPrompt } = buildSampleExtensionPrompt(sourcetype, realEvents, ask, feedback);
  const text = await invokeAi(systemPrompt, userPrompt, maxTokens);
  // The real lines are the spec: a refusal or `{}` here is simply not an event.
  return splitNonEvents(coalesceSampleLines(stripAiReasoning(text))).events.slice(0, ask);
}

export async function testAiConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const text = await invokeAi('Reply with exactly: OK', 'Test connection', 16);
    if (text && text.length > 0) {
      return { ok: true, message: `Connected — model responded: "${text.slice(0, 50)}"` };
    }
    return { ok: false, message: 'No response from model' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg };
  }
}

export async function testBackendProxy(): Promise<{ ok: boolean; message: string }> {
  // App-hosted runtimes test the configured provider directly. A Backend
  // Function has no local `/api/pack-generator/*` Vite handlers.
  if (getRunMode() === 'backend' || (getRunMode() === 'iframe' && !isDevIframe())) {
    const s = loadSettings();
    const provider = s.provider === 'devproxy' ? (hasBedrockCreds() ? 'bedrock' : 'anthropic') : s.provider;
    try {
      const text = await invokeAi('Reply with exactly: OK', 'Test connection', 16);
      if (text && text.length > 0) {
        return { ok: true, message: `AI connected (${provider})` };
      }
      return { ok: false, message: `No response from ${provider}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `${provider}: ${msg}` };
    }
  }
  // Local dev: test via Vite backend handlers
  try {
    const resp = await fetch('/api/pack-generator/ai-validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcetype: 'test_connection', destFormat: '' }),
    });
    if (resp.ok) {
      return { ok: true, message: 'Cribl AI (Aperture) connected' };
    }
    const text = await resp.text();
    return { ok: false, message: `Backend error ${resp.status}: ${text.slice(0, 80)}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg };
  }
}

