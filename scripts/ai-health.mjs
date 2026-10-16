import { AI_BASE, AI_MODEL, invokeModel } from './cribl-auth.mjs';

// Fast startup AI health probe. Verifies TWO things the app depends on:
//   1. reachable  — the AI endpoint (Aperture via Tailscale / custom Bedrock)
//                   answers at all.
//   2. modelOk    — the SELECTED model actually returns usable TEXT. Reasoning
//                   models (claude-sonnet-5+) return a leading `thinking` block
//                   with no text; a model that is misconfigured/unavailable can
//                   also 200 with empty content. Both cases silently produced
//                   empty samples / empty AI parse across the app — this probe
//                   surfaces it at startup instead of mid-wizard.
// Kept tiny (max_tokens 64, one-word answer) so it costs ~nothing on boot.
//
// The call is cheap in tokens but not in time — a real round trip to a reasoning model is
// a second or two, and it is the last thing standing between a page load and a settled AI
// status. So a healthy verdict is held briefly and served to whoever asks next: a reload,
// a second tab, a colleague pointed at the same dev server. Successes only. A failure is
// usually something the user is actively fixing (Tailscale down, wrong model id) and must
// re-probe immediately, or the app would keep reporting a fault they had just cleared.
const HEALTHY_TTL_MS = 60_000;
const healthyCache = new Map();   // `${model}|${base}` -> { at, result }

// A single timed-out attempt is not evidence that AI is down, and reporting it as such is
// what made the banner cry wolf — most loudly right after an update, which is exactly when
// it is least true. Measured on a healthy Tailscale link: DNS ~5ms, connect ~100ms, full
// model round trip ~1.5s, and ~1.5s even with eight heavy generations already in flight, so
// the endpoint is not the thing that gets slow. The dev server is. It is one Node process,
// and an update restarts it (`autoRestartPlugin`, on package.json + scripts/*.mjs), after
// which the reloading page pulls a 34k-line module graph through the same event loop that
// owns this probe's socket. Timed under that load the identical probe took 10.5s — a 7x
// inflation with the model answering normally throughout, landing close enough to any fixed
// ceiling to trip it on a colder cache or a busier machine.
//
// So: retry before believing it. The starvation drains in seconds, so a later attempt costs
// one more cheap call and returns the truth. Bounded three ways — attempts, a per-attempt
// timeout, and a total budget — because the caller is a page load, not a background job.
export const ATTEMPT_TIMEOUT_MS = 12_000;
export const MAX_ATTEMPTS = 3;
export const TOTAL_BUDGET_MS = 30_000;
const BACKOFF_MS = [1_000, 2_500];

// Retry transport failures, never verdicts. A timeout or a dropped connection says nothing
// about the endpoint; a 4xx does — a wrong model id would fail identically three times over
// and only delay the message that fixes it. Throttles and 5xx are the provider asking to be
// asked again, so they retry with everything else that is transient.
export function isRetryable(err) {
  const msg = err?.message || '';
  const status = Number((msg.match(/(?:Bedrock|Anthropic|OpenAI) error (\d+)/) || [])[1] || 0);
  if (status) return status === 408 || status === 429 || status >= 500;
  return true;
}

/**
 * Probes the model until it answers or the budget runs out, and reports which happened.
 *
 * `invoke(signal)` resolves to the model's text. Injected rather than imported so the retry
 * policy can be tested against fabricated failures — the behaviour worth pinning is "two
 * timeouts then success is a healthy verdict, not an outage", which is unreachable through
 * a real endpoint that refuses to misbehave on request.
 */
export async function probeWithRetry(invoke, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const totalBudgetMs = opts.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const armSignal = opts.armSignal ?? (ms => AbortSignal.timeout(ms));

  const deadline = now() + totalBudgetMs;
  let attempts = 0;
  let lastError = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline - now();
    if (attempt > 0 && remaining < 2_000) break;   // no room for a fair attempt
    attempts++;
    try {
      // The last attempt is clamped to what is left of the budget — an attempt allowed to
      // run its full timeout past the deadline is how a bounded probe hangs a page load.
      const text = await invoke(armSignal(Math.min(attemptTimeoutMs, Math.max(remaining, 1))));
      const modelOk = String(text || '').trim().length > 0;
      // The model spoke. Whatever it said is the answer, including saying nothing —
      // that is a model-id/availability problem the user must see, not retry through.
      return { reachable: true, modelOk, attempts, error: modelOk ? '' : 'Model returned no text (check model id / availability).' };
    } catch (err) {
      const msg = err?.message || '';
      if (!isRetryable(err)) {
        return { reachable: true, modelOk: false, attempts, error: `Model reachable but returned error — ${msg.slice(0, 200)}` };
      }
      lastError = err?.name === 'TimeoutError' ? 'timeout' : (msg || 'AI endpoint unreachable');
    }
    const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    if (attempt < maxAttempts - 1 && deadline - now() > backoff + 2_000) await sleep(backoff);
  }

  const tries = attempts === 1 ? '' : ` after ${attempts} attempts`;
  return {
    reachable: false,
    modelOk: false,
    attempts,
    error: lastError === 'timeout'
      ? `AI endpoint timed out${tries} (is Tailscale connected?).`
      : `${lastError || 'AI endpoint unreachable'}${tries}`,
  };
}

export async function handleAiHealth(req, res) {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const model = url.searchParams.get('model') || AI_MODEL;
  const base = url.searchParams.get('base') || AI_BASE;

  const started = Date.now();
  const result = { reachable: false, modelOk: false, model, base, latencyMs: 0, attempts: 0, error: '' };

  const cacheKey = `${model}|${base}`;
  const hit = healthyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HEALTHY_TTL_MS) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ...hit.result, cached: true, latencyMs: 0 }));
    return;
  }

  const verdict = await probeWithRetry(
    signal => invokeModel(model, '', 'Reply with the single word: ok', 64, { signal }),
  );
  Object.assign(result, verdict);
  if (verdict.reachable && !verdict.modelOk && verdict.error.startsWith('Model reachable')) {
    result.error = verdict.error.replace('Model reachable', `Model "${model}" reachable`);
  }

  result.latencyMs = Date.now() - started;
  if (result.reachable && result.modelOk) healthyCache.set(cacheKey, { at: Date.now(), result });
  else healthyCache.delete(cacheKey);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result));
}
