/**
 * What one AI call may cost when the app runs INSIDE Cribl.
 *
 * The platform's fetch proxy cancels a proxied request that has not responded
 * within 30 seconds, and that ceiling belongs to the iframe→parent bridge: it is
 * NOT the `timeout:` in config/proxies.yml (that governs the later hop, upstream
 * of the platform) and it cannot be raised from this app. A request that exceeds
 * it comes back as the platform's own bare `Request timeout`.
 *
 * Nothing here makes a model faster. What it does is stop the browser path from
 * asking for answers that cannot arrive in time: the demo asked for an 8,000-token
 * format specification and then all 20 events in a single 16,000-token call, so it
 * timed out every time, while the wizard's short parse/mapping calls were fine.
 * Several small calls succeed where one long call cannot.
 */
import type { RunMode } from './run-mode';

/** The platform bridge's fixed ceiling. Documented in AGENTS.md. */
export const IFRAME_PROXY_BUDGET_MS = 30_000;

/**
 * Leave the round trip some room: the budget covers connection, model latency and
 * the response coming back through the bridge, and a call that lands at 29.5s is
 * not a success worth designing for.
 */
export const IFRAME_SAFE_CALL_MS = 22_000;

/**
 * A Cribl Backend Function invocation is killed at the `timeout:` declared in
 * config/backend.yml. Background Batch runs one durable stage per invocation, so
 * an AI call that runs until the platform kills the process takes the stage's
 * checkpoint with it — the work is redone from the last persisted stage, and the
 * row learns nothing about why.
 *
 * 300 s since build 842 (was 120 s, the documented max until CRIBL-44805 raised
 * it to Lambda's 900 s). Sized for the Cribl AI Settings provider: its
 * open_investigator agent sends no response headers until it starts answering,
 * and that took up to 38.6 s on an OCSF mapping prompt, with a whole mapping
 * (format research + mapping) at ~87 s (measured 2026-10-02). At 120 s neither
 * the 20 s per-request allowance nor the stage deadline could hold that.
 * Must equal `timeout:` in config/backend.yml (a test enforces it).
 */
export const BACKEND_FUNCTION_CEILING_MS = 300_000;

/**
 * What must still be affordable after the last AI call returns: writing the row
 * result and the artifact, and releasing the lease. Without this reserve a stage
 * that used its whole allowance would be killed while checkpointing, which is
 * the one outcome Hard Rule 32 forbids — work done, nothing recorded.
 */
export const BACKEND_CHECKPOINT_RESERVE_MS = 20_000;

/**
 * The EFFECTIVE stage deadline: when the background stage's AbortController
 * fires. Not an aspiration — the signal reaches both the staged builder (which
 * checks it before every deploy/patch) and the AI transport (which aborts the
 * in-flight request), so the stage stops rather than being outrun.
 */
export const BACKEND_STAGE_DEADLINE_MS = BACKEND_FUNCTION_CEILING_MS - BACKEND_CHECKPOINT_RESERVE_MS;

/**
 * How long an aborted stage is given to unwind before the runner concludes the
 * work may STILL BE ALIVE (a hang the signal cannot reach — a Cribl API call
 * with no signal of its own). It has to fit inside the checkpoint reserve,
 * because the row result still has to be written after it.
 */
export const BACKEND_STAGE_ABORT_GRACE_MS = 10_000;

/**
 * Time inside a stage that is NOT an AI request: pack/pipeline deploys, live
 * previews, scoring. Reserved so the stage's own AI budget cannot consume the
 * whole deadline and make the abort the normal path rather than the backstop.
 */
export const BACKEND_STAGE_NON_AI_RESERVE_MS = 20_000;

/**
 * AI calls the WORST single stage can make, measured against `staged-build.ts`:
 * `aiParse` (extraction, re-resolved on every build invocation), plus a mapping
 * stage's `schematizerMapping` and `aiMapping` — three — with one spare for the
 * second-model retry. This is the multiplier the per-request timeout is divided
 * by, so ALL of a stage's internal attempts are affordable before the deadline.
 */
export const BACKEND_STAGE_MAX_AI_CALLS = 4;

/**
 * What one AI request may cost inside a Backend Function — DERIVED, not chosen,
 * so that moving the platform ceiling moves it too. 65s at today's numbers, and
 * strictly less than the stage deadline by construction: a single provider
 * request must never be able to reach the deadline on its own.
 */
export const BACKEND_AI_REQUEST_TIMEOUT_MS = Math.floor(
  (BACKEND_STAGE_DEADLINE_MS - BACKEND_STAGE_NON_AI_RESERVE_MS) / BACKEND_STAGE_MAX_AI_CALLS,
);

/**
 * Everywhere else. Generous on purpose: its only job is to stop a hung
 * http://ai-gateway.example/bedrock (or a dead CORS proxy) from wedging the UI forever.
 */
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 180_000;

/** Ceiling for ONE provider request, by run mode. Backend only — see above. */
export function aiRequestTimeoutMs(mode: RunMode): number {
  return mode === 'backend' ? BACKEND_AI_REQUEST_TIMEOUT_MS : DEFAULT_AI_REQUEST_TIMEOUT_MS;
}

/**
 * How many provider requests have timed out in this process.
 *
 * The background stage runner needs to tell "the model never answered" from "it
 * answered badly", and it cannot: `buildStagedPipeline` CATCHES its own AI
 * failures by design (a timed-out `aiParse` degrades to a deterministic
 * candidate rather than failing the build), so nothing reaches the caller. A
 * counter incremented where the timeout is thrown is the one honest signal —
 * combined with "did this stage produce anything", it makes retrying a starved
 * stage possible without discarding a stage that succeeded without the model.
 */
let aiTimeoutCount = 0;

export function aiTimeoutsObserved(): number {
  return aiTimeoutCount;
}

/**
 * Build (and count) the error thrown when a provider request exceeds its
 * allowance. Always construct a timeout through this — a hand-written message
 * is invisible to `aiTimeoutsObserved()` and re-opens the gap above.
 */
export function aiTimeoutError(timeoutMs: number): Error {
  aiTimeoutCount += 1;
  return new Error(
    `AI request timed out after ${Math.round(timeoutMs / 1000)}s. `
    + 'The provider may be unreachable (for Cribl AI/Aperture, check Tailscale) or overloaded.',
  );
}

/**
 * The background stage's abort signal, for code that cannot be handed one.
 *
 * The AI transport is reached through several layers of dispatch that no caller
 * threads a signal through, and a stage that has run out of invocation must not
 * start another provider request. So the backend runner REGISTERS its signal
 * for the duration of one stage and clears it afterwards. Nothing else sets it:
 * in the iframe and standalone this is always null and the transport behaves
 * exactly as it always has.
 */
let backendStageSignal: AbortSignal | null = null;

export function setBackendStageSignal(signal: AbortSignal | null): void {
  backendStageSignal = signal ?? null;
}

export function backendStageSignal_(): AbortSignal | null {
  return backendStageSignal;
}

export const STAGE_ABORT_MARKER = 'background stage deadline';

/**
 * The error an aborted stage unwinds with. Recognizable on the way out (so the
 * runner classifies it as a retryable timeout rather than a broken row) and
 * carrying WHERE it stopped, because "stopped before the deploy" and "stopped
 * before the AI call" are different stories for whoever reads the row.
 */
export function stageAbortError(where: string): Error {
  return new Error(`Stopped at the ${STAGE_ABORT_MARKER} before ${where}.`);
}

export function isStageAbortError(message: unknown): boolean {
  return String(message ?? '').includes(STAGE_ABORT_MARKER);
}

/** Throw if the registered stage signal has already fired. */
export function assertStageLive(where: string): void {
  if (backendStageSignal?.aborted) throw stageAbortError(where);
}

/** Events per generation call, and the token allowance for one such call. */
export interface SampleGenerationPlan {
  batchSize: number;
  maxTokens: number;
  /** Ask for this many events per call after a call has already timed out. */
  retryBatchSize: number;
  retryMaxTokens: number;
  /** Below this, a generated sample is not worth handing to a build. */
  minUsableEvents: number;
}

/**
 * Sized so ONE call is a few thousand output tokens rather than tens of thousands.
 * A reasoning model spends thinking tokens from the same allowance (measured while
 * building sample extension), so the allowance is the thing to keep small — not
 * just the number of lines requested.
 */
export function sampleGenerationPlan(count: number): SampleGenerationPlan {
  return {
    batchSize: Math.max(1, Math.min(5, count)),
    maxTokens: 3000,
    retryBatchSize: 2,
    retryMaxTokens: 1500,
    minUsableEvents: 3,
  };
}

/** Token allowance for the format-research call that precedes generation. */
export const FORMAT_RESEARCH_MAX_TOKENS = 1800;

/**
 * Generation is RETRIED with a stronger model, and that policy lives here so every
 * flow shares it.
 *
 * The demo escalated `fast` → `balanced`; the batch pre-flight, the batch build path
 * and the per-row Rerun each made ONE `fast` attempt and then reported "No sample".
 * Measured generation is 45-87s against a 90s backend ceiling, so a single attempt
 * loses a whole row to one slow call — which is exactly the asymmetry that made the
 * batch look unable to produce a sample for a sourcetype the wizard handles fine.
 * The escalation is also useful on its own: `fast` models get an unusual wire format
 * wrong often enough that the second attempt is what lands it.
 */
export type SampleGenerationMode = 'fast' | 'balanced';

export function sampleGenerationAttemptModes(): SampleGenerationMode[] {
  return ['fast', 'balanced'];
}

const TIMEOUT_PATTERNS = [
  /\brequest timeout\b/i,
  /\btimed? ?out\b/i,
  /\b(504|524|408)\b/i,
  /\bETIMEDOUT\b/i,
];

export function isProxyTimeout(message: string): boolean {
  return TIMEOUT_PATTERNS.some(rx => rx.test(String(message || '')));
}

/**
 * The platform says only `Request timeout`, which reads like a network fault and
 * sent us looking at Tailscale and API keys. Say what actually happened and what
 * it means, so the next person does not repeat that.
 */
export function describeProxyTimeout(message: string): string {
  if (!isProxyTimeout(message)) return message;
  return `${message} — the Cribl app proxy cancels any request that takes longer than ${IFRAME_PROXY_BUDGET_MS / 1000}s, and this AI call exceeded it. Smaller batches are retried automatically; a model that is slow or heavily rate-limited can still miss the window.`;
}
