/**
 * ONE place every GitHub request goes through, in BOTH run modes.
 *
 * Why this module exists: the app spent its entire 5,000-request/hour user quota
 * and every golden-pool read started answering 403. The cause was not a busy day
 * — it was `syncGoldensToPlatform`, which fanned `Promise.all` out over every
 * entry in the shared index (641 files) as 641 CONCURRENT GETs, fire-and-forget,
 * on EVERY app start (and again on every dev-server reload, doubled by React
 * StrictMode). Four page loads = 5,128 requests = the wall. Nobody saw it fail
 * because the call was `void`ed and the platform var it wrote was never read.
 *
 * GitHub's own best-practices doc names exactly what that code did wrong
 * (docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api):
 * don't make requests concurrently, use conditional requests, honour Retry-After
 * and x-ratelimit-*, pause between mutations, back off instead of retrying hard.
 * So those rules live HERE, once, in code — not as a habit each call site has to
 * remember:
 *
 *   1. SERIAL BY CONSTRUCTION. Every request goes through one promise queue, so
 *      concurrency is 1 no matter what the caller does. A future `Promise.all`
 *      over 641 keys is now slow, not a quota outage — the failure mode this
 *      module exists to prevent cannot be reintroduced from a call site.
 *   2. MUTATIONS ARE SPACED (>= 1s apart), per the doc's explicit rule.
 *   3. CONDITIONAL REQUESTS. GET responses are cached by ETag; a 304 costs
 *      nothing against the quota, and the caller still gets the body.
 *   4. FAIL FAST WHEN THE QUOTA IS GONE. Once a response says remaining=0, the
 *      next call throws GitHubRateLimit with the reset time WITHOUT issuing a
 *      request. Hammering an exhausted quota only pushes the reset further away.
 *   5. Retry-After / 5xx get a bounded, exponential wait — never a tight loop.
 *
 * And the reason the fan-out is gone rather than merely serialized: BULK READS
 * USE GraphQL. One POST returns 100 file bodies for ONE point of quota, on the
 * separate `graphql` bucket. Measured on the real pool: 641 golden files went
 * from 642 REST calls to 8 GraphQL calls (1 listing + 7 batches, ~0.8 MB each).
 *
 * No Node imports — the iframe imports this module directly (Hard Rule 18), and
 * api.github.com sends `access-control-allow-origin: *`, so the GraphQL path
 * works from the browser too.
 *
 * READING THE SHARED GOLDENS NEEDS NO CREDENTIAL AT ALL. They live in a public
 * repository, so every read goes to raw.githubusercontent.com unauthenticated —
 * which is what lets any install of the app, in either run mode, read the pool
 * without anybody typing a token. That path is deliberately NOT the API path:
 *
 *   * it never attaches an Authorization header, so no caller can leak one;
 *   * it does not consume (or get blocked by) the 5,000/hour API quota, so an
 *     exhausted API budget must not stop a plain read — hence no budget assert;
 *   * it is a CDN rather than the API, so it runs on its own small-concurrency
 *     lane instead of the serial API chain. But it is NOT unlimited: anonymous
 *     raw reads ARE throttled, and a large burst comes back as a bare 429 (no
 *     Retry-After, no x-ratelimit-*). Blasting ~1,100 golden files at 6-wide
 *     returned ~190 × 200 then ~2,000 × 429, and every 429 was silently dropped.
 *     So the lane is narrow, spaces its request starts, and backs a bare 429 off
 *     into a shared cooldown then retries — it does not drop the file.
 *
 * A token, when present, still buys the far cheaper GraphQL bulk read (100 bodies
 * per request), so the publisher keeps the fast path and everyone else gets a
 * working one.
 */

const UA = 'pack-generator';
/**
 * Parallel raw reads. raw.githubusercontent.com is a CDN but DOES throttle
 * anonymous bursts (see the header note), so this is deliberately narrow: paired
 * with rawGapMs spacing and the shared 429 cooldown it trades a few seconds of
 * wall-clock for reads that actually complete instead of getting dropped.
 */
const RAW_CONCURRENCY = 3;

/** Route through the Cribl app proxy in the iframe, direct everywhere else. */
const criblApiBase = (): string => (typeof window !== 'undefined'
  ? String((window as Window & { CRIBL_API_URL?: string }).CRIBL_API_URL || '').replace(/\/+$/, '')
  : '');

function proxiedUrl(host: string, relative: string): string {
  const criblApi = criblApiBase();
  return criblApi ? `${criblApi}/proxy/${host}${relative}` : `https://${host}${relative}`;
}

function githubApiUrl(path: string): string {
  const relative = /^https?:/.test(path)
    ? path.replace(/^https:\/\/api\.github\.com/, '')
    : `${path.startsWith('/') ? '' : '/'}${path}`;
  return proxiedUrl('api.github.com', relative);
}

function githubRawUrl(repo: string, branch: string, path: string): string {
  // Encode each path segment (preserving '/'): a golden filename can contain '#'
  // (schema keys like cim#network), which an unencoded URL treats as the fragment —
  // the read would then 404 on the truncated name while the file sits at the full
  // one. repo/branch are already safe. Mirrors encContentsPath in golden-github.mjs.
  //
  // Through the Cribl app proxy (iframe) the segment is encoded TWICE: the proxy
  // decodes the path once before forwarding, so a single `%23` reached GitHub as
  // a bare '#' and the read 404'd on the truncated name — "Not found in shared
  // goldens" for every ocsf#/cim# golden in the iframe (verified live 2026-10-03:
  // `%23` → 404, `%2523` → 200).
  const enc = criblApiBase() ? (seg: string) => encodeURIComponent(encodeURIComponent(seg)) : encodeURIComponent;
  const clean = path.replace(/^\/+/, '').split('/').map(enc).join('/');
  return proxiedUrl('raw.githubusercontent.com', `/${repo}/${branch}/${clean}`);
}

/** The quota is gone (or would be spent for nothing). Carries when it returns. */
export class GitHubRateLimit extends Error {
  readonly resource: string;
  readonly resetAt: number;
  constructor(resource: string, resetAt: number, detail?: string) {
    const mins = Math.max(0, Math.round((resetAt - Date.now()) / 60000));
    super(`GitHub ${resource} rate limit exhausted — resets in ${mins} min (${new Date(resetAt).toISOString()})${detail ? ` — ${detail}` : ''}`);
    this.name = 'GitHubRateLimit';
    this.resource = resource;
    this.resetAt = resetAt;
  }
}

/** GitHub answered, but not with an answer (5xx after retries, or a hard 403). */
export class GitHubUnreachable extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubUnreachable';
    this.status = status;
  }
}

interface GhConfig {
  /** GitHub: "wait at least one second between each mutative request". */
  minMutationGapMs: number;
  /** A Retry-After longer than this is a rate limit to report, not to sleep through. */
  maxRetryWaitMs: number;
  /** Attempts after the first, for Retry-After and 5xx. */
  retries: number;
  /** Blob bodies per GraphQL batch. 100 measured at ~0.8 MB / 7.5 s / 1 point. */
  batchSize: number;
  /** Min spacing between raw (unmetered CDN) request starts, to smooth the burst. */
  rawGapMs: number;
  /** Attempts after the first for a bare raw 429 (no Retry-After) — throttling is transient. */
  rawRetries: number;
}
const DEFAULTS: GhConfig = { minMutationGapMs: 1000, maxRetryWaitMs: 120_000, retries: 3, batchSize: 100, rawGapMs: 120, rawRetries: 5 };
let config: GhConfig = { ...DEFAULTS };
/** Test/caller override. Tests shrink the gaps; nothing in the app changes these. */
export function configureGitHub(p: Partial<GhConfig>): void { config = { ...config, ...p }; }

export interface GhLimit { limit: number; remaining: number; used: number; resetAt: number }
const limits = new Map<string, GhLimit>();
/** What the last response said about the quota (null until one has been seen). */
export function ghLimitState(resource = 'core'): GhLimit | null { return limits.get(resource) || null; }

const etags = new Map<string, { etag: string; text: string }>();

/**
 * Requests served from the ETag cache (304 = free) vs. paid for. `public` counts
 * unauthenticated raw reads, which cost nothing on either GitHub bucket and are
 * therefore kept out of `paid` — reporting them together would misstate the
 * quota this module exists to protect. Reporting only.
 */
const stats = { paid: 0, free: 0, graphql: 0, public: 0 };
export function ghRequestStats(): { paid: number; free: number; graphql: number; public: number } { return { ...stats }; }

/** Full reset — for tests only, so one suite's cached ETag can't leak into the next. */
export function ghResetForTests(): void {
  limits.clear();
  etags.clear();
  stats.paid = 0; stats.free = 0; stats.graphql = 0; stats.public = 0;
  queue = Promise.resolve();
  rawInFlight = 0;
  rawWaiting.length = 0;
  rawCooldownUntil = 0;
  lastRawStartAt = 0;
  lastMutationAt = 0;
  config = { ...DEFAULTS };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- the serial queue -----------------------------------------------------------
// One chain, so concurrency is 1 process-wide. A rejected task must not poison the
// chain for the next caller, hence the swallow on the tail.
let queue: Promise<unknown> = Promise.resolve();
let lastMutationAt = 0;
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

// --- the raw lane ---------------------------------------------------------------
// Unauthenticated CDN reads, capped at RAW_CONCURRENCY. Separate from the chain
// above because they spend no quota: serializing them would only make a public
// read slow, and blocking them behind a stalled API mutation would make it hang.
let rawInFlight = 0;
const rawWaiting: Array<() => void> = [];
// raw.githubusercontent throttles anonymous bursts with a bare 429. When one
// request hits it, the whole lane waits out a shared cooldown rather than each
// request discovering the wall independently. performRequest sets this via
// noteRawThrottle; enqueueRaw honours it before starting the next request.
let rawCooldownUntil = 0;
let lastRawStartAt = 0;
function noteRawThrottle(untilMs: number): void {
  if (untilMs > rawCooldownUntil) rawCooldownUntil = untilMs;
}
async function enqueueRaw<T>(fn: () => Promise<T>): Promise<T> {
  if (rawInFlight >= RAW_CONCURRENCY) await new Promise<void>((r) => rawWaiting.push(r));
  rawInFlight++;
  try {
    // Wait out any active throttle cooldown, then space this start off the last.
    const cool = rawCooldownUntil - Date.now();
    if (cool > 0) await sleep(cool);
    const gap = config.rawGapMs - (Date.now() - lastRawStartAt);
    if (gap > 0) await sleep(gap);
    lastRawStartAt = Date.now();
    return await fn();
  } finally {
    rawInFlight--;
    rawWaiting.shift()?.();
  }
}

function recordLimits(h: Headers): void {
  const resource = h.get('x-ratelimit-resource');
  const remaining = h.get('x-ratelimit-remaining');
  if (!resource || remaining == null) return;
  limits.set(resource, {
    limit: Number(h.get('x-ratelimit-limit')) || 0,
    remaining: Number(remaining),
    used: Number(h.get('x-ratelimit-used')) || 0,
    resetAt: (Number(h.get('x-ratelimit-reset')) || 0) * 1000,
  });
}

/**
 * Refuse to spend a request we know will 403. Also the preflight for bulk work:
 * `ghAssertBudget('core', 20)` says "don't start if 20 calls won't fit".
 */
export function ghAssertBudget(resource = 'core', need = 1): void {
  const state = limits.get(resource);
  if (!state) return;                                   // nothing observed yet — go and find out
  if (Date.now() >= state.resetAt) { limits.delete(resource); return; }   // window rolled over
  if (state.remaining < need) throw new GitHubRateLimit(resource, state.resetAt, `${state.remaining} left, ${need} needed`);
}

function retryAfterMs(h: Headers): number | null {
  const ra = h.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  return null;
}

export interface GhResponse {
  status: number;
  ok: boolean;
  /** Served from the ETag cache — this one did not cost quota. */
  notModified: boolean;
  text: string;
  headers: Headers | null;
}

export interface GhRequestOptions {
  token?: string;
  accept?: string;
  method?: string;
  body?: unknown;
  /** Send If-None-Match / store the ETag. GET only; default true. */
  conditional?: boolean;
  /** Override the mutation spacing decision (GraphQL reads POST but aren't mutations). */
  spaced?: boolean;
}

/**
 * One GitHub request, with every rule above applied. `path` is absolute or
 * relative to api.github.com. Throws GitHubRateLimit / GitHubUnreachable;
 * every other status comes back in the result for the caller to interpret
 * (404 in particular is an ANSWER, never an error).
 */
export async function ghRest(path: string, o: GhRequestOptions): Promise<GhResponse> {
  const method = (o.method || 'GET').toUpperCase();
  const cacheable = method === 'GET' && o.conditional !== false;
  const spaced = o.spaced ?? (method !== 'GET' && method !== 'HEAD');
  const accept = o.accept || 'application/vnd.github+json';
  return enqueue(() => {
    ghAssertBudget('core');
    return performRequest({
      url: githubApiUrl(path), label: path, method, accept,
      token: o.token, body: o.body, cacheable, spaced, metered: true,
    });
  });
}

interface RequestSpec {
  url: string;
  /** What an error names — the caller's path, never the proxied URL. */
  label: string;
  method: string;
  accept: string;
  token?: string;
  body?: unknown;
  cacheable: boolean;
  spaced: boolean;
  /** Spends the API quota, so its counters and its limit headers apply. */
  metered: boolean;
}

/**
 * The rules from this module's header, applied to one request. Shared by the
 * metered API lane and the unauthenticated public lane; WHICH lane a request
 * runs on is the caller's decision and is never made here.
 */
async function performRequest(o: RequestSpec): Promise<GhResponse> {
  const { url, accept, cacheable, spaced, method, label: path } = o;
  const charge = () => { if (o.metered) stats.paid++; else stats.public++; };
  const cacheKey = `${url} ${accept}`;

  for (let attempt = 0; ; attempt++) {
    if (spaced) {
      const gap = config.minMutationGapMs - (Date.now() - lastMutationAt);
      if (gap > 0) await sleep(gap);
    }
    const headers: Record<string, string> = { Accept: accept, 'User-Agent': UA };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    const cached = cacheable ? etags.get(cacheKey) : undefined;
    if (cached) headers['If-None-Match'] = cached.etag;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';

    const r = await fetch(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    if (spaced) lastMutationAt = Date.now();
    recordLimits(r.headers);

    if (r.status === 304 && cached) { stats.free++; return { status: 304, ok: true, notModified: true, text: cached.text, headers: r.headers }; }

    if (r.status === 403 || r.status === 429) {
      const state = limits.get(r.headers.get('x-ratelimit-resource') || 'core');
      // remaining=0 is the PRIMARY limit: waiting is pointless until the reset.
      if (r.headers.get('x-ratelimit-remaining') === '0' && state) {
        throw new GitHubRateLimit(state === limits.get('core') ? 'core' : (r.headers.get('x-ratelimit-resource') || 'core'), state.resetAt, `${(await r.text().catch(() => '')).slice(0, 120)}`);
      }
      // Retry-After without remaining=0 is a SECONDARY limit — bounded wait, then retry.
      const wait = retryAfterMs(r.headers);
      if (wait != null && wait <= config.maxRetryWaitMs && attempt < config.retries) { charge(); await sleep(wait); continue; }
      if (wait != null) throw new GitHubRateLimit('secondary', Date.now() + wait, 'secondary rate limit');
      // A bare 429/403 on the unmetered CDN lane is raw.githubusercontent
      // throttling an anonymous burst — no Retry-After, no x-ratelimit-*. Back
      // the whole raw lane off (shared cooldown) and retry; dropping the file
      // here is what lost ~2,000 golden reads.
      if (!o.metered && attempt < config.rawRetries) {
        const backoff = Math.min(config.maxRetryWaitMs, 500 * 2 ** attempt) + Math.floor(Math.random() * 500);
        noteRawThrottle(Date.now() + backoff);
        charge();
        await sleep(backoff);
        continue;
      }
      charge();
      return { status: r.status, ok: false, notModified: false, text: (await r.text().catch(() => '')).slice(0, 300), headers: r.headers };
    }

    if (r.status >= 500 && attempt < config.retries) { charge(); await sleep(1000 * 2 ** attempt); continue; }

    charge();
    const text = await r.text();
    if (cacheable && r.ok) {
      const etag = r.headers.get('etag');
      if (etag) etags.set(cacheKey, { etag, text });
    }
    if (r.status >= 500) throw new GitHubUnreachable(r.status, `GitHub ${r.status} on ${path} after ${config.retries} retries`);
    return { status: r.status, ok: r.ok, notModified: false, text, headers: r.headers };
  }
}

/**
 * One file from a PUBLIC repository, with no credential of any kind. This is how
 * every install reads the shared goldens: raw.githubusercontent.com serves them
 * with `access-control-allow-origin: *` and an ETag, so the browser reads them
 * directly and a repeat read costs a 304.
 *
 * There is deliberately no token parameter — not optional, not defaulted. A
 * public read that CAN carry a credential is one that eventually will.
 */
export async function ghReadPublicFile(repo: string, branch: string, path: string, o: { conditional?: boolean } = {}): Promise<GhResponse> {
  return enqueueRaw(() => performRequest({
    url: githubRawUrl(repo, branch, path),
    label: `${repo}/${branch}/${path}`,
    method: 'GET',
    accept: 'application/vnd.github.raw',
    cacheable: o.conditional !== false,
    spaced: false,
    metered: false,
  }));
}

/** ghReadPublicFile + JSON parse. Missing or unparseable → `{found:false}`. */
export async function ghReadPublicJson<T = unknown>(repo: string, branch: string, path: string, o: { conditional?: boolean } = {}): Promise<{ found: boolean; data: T | null; notModified: boolean }> {
  const r = await ghReadPublicFile(repo, branch, path, o);
  if (r.status === 404) return { found: false, data: null, notModified: false };
  if (!r.ok) throw new GitHubUnreachable(r.status, `GitHub raw ${r.status} on ${path} — ${r.text.slice(0, 200)}`);
  try { return { found: true, data: JSON.parse(r.text) as T, notModified: r.notModified }; }
  catch { return { found: false, data: null, notModified: r.notModified }; }
}

/** ghRest + JSON parse. 404 → `{found:false}`; a non-404 failure throws. */
export async function ghRestJson<T = unknown>(path: string, o: GhRequestOptions): Promise<{ found: boolean; data: T | null; notModified: boolean }> {
  const r = await ghRest(path, o);
  if (r.status === 404) return { found: false, data: null, notModified: false };
  if (!r.ok) throw new GitHubUnreachable(r.status, `GitHub ${r.status} on ${path} — ${r.text.slice(0, 200)}`);
  try { return { found: true, data: JSON.parse(r.text) as T, notModified: r.notModified }; }
  catch { return { found: true, data: null, notModified: r.notModified }; }
}

// --- GraphQL: the bulk read -----------------------------------------------------

/**
 * One GraphQL query. Costs 1 point of the SEPARATE `graphql` bucket regardless of
 * how many blobs it returns, which is the whole reason bulk reads use it.
 * A GraphQL rate limit arrives as HTTP 200 + `errors[].type === 'RATE_LIMITED'`,
 * so that is checked explicitly — an unchecked 200 would look like empty data.
 */
export async function ghGraphQL<T = unknown>(token: string, query: string): Promise<T> {
  const r = await ghRest('/graphql', { token, method: 'POST', body: { query }, spaced: false, conditional: false });
  stats.graphql++;
  if (r.status === 401) throw new GitHubUnreachable(401, 'GitHub GraphQL rejected the token (401)');
  if (!r.ok) throw new GitHubUnreachable(r.status, `GitHub GraphQL ${r.status} — ${r.text.slice(0, 200)}`);
  let body: { data?: T; errors?: Array<{ type?: string; message?: string }> };
  try { body = JSON.parse(r.text); } catch { throw new GitHubUnreachable(r.status, 'GitHub GraphQL returned non-JSON'); }
  const errors = body.errors || [];
  if (errors.some((e) => e.type === 'RATE_LIMITED')) {
    const state = limits.get('graphql');
    throw new GitHubRateLimit('graphql', state?.resetAt || Date.now() + 3_600_000, errors[0]?.message);
  }
  if (errors.length && body.data === undefined) throw new GitHubUnreachable(r.status, `GitHub GraphQL: ${errors.map((e) => e.message).join('; ').slice(0, 200)}`);
  return body.data as T;
}

// Golden filenames for schema formats carry a '#' from the data class
// (cim#network, ocsf#cloud_audit, asim#authentication → sap_audit__cim#network____mapping__.json).
// '#' is a comment delimiter in GraphQL only OUTSIDE string literals; inside the
// double-quoted `expression` it is a literal char, and the expression is now
// JSON-escaped besides — so it is safe to accept here. Omitting it silently
// dropped every schema-format golden from import (count "remains N" after import).
// A pool filename as the index records it. Sourcetypes carry ':' (pan:traffic),
// '@' (…@kvp) and, for Windows channels, '/' — a real subfolder in the pool.
// Excluding them silently dropped 120 of the pool's keys from every import as
// "Not found". Still a closed set, and no '.'/'..' segment, so a key from user
// data cannot leave the folder; the GraphQL path quotes it with JSON.stringify.
const POOL_SEGMENT = /^[A-Za-z0-9._#:@-]+$/;
export function isPoolFileName(name: string): boolean {
  const parts = name.split('/');
  return parts.every((p) => POOL_SEGMENT.test(p) && p !== '.' && p !== '..');
}
const gqlRepo = (repo: string): { owner: string; name: string } => {
  const [owner, name] = repo.split('/');
  return { owner: owner || '', name: name || '' };
};

export interface PoolFile { name: string; oid: string }

/**
 * Every file in one folder of a branch — ONE request, with each blob's oid (so a
 * caller can tell what actually changed). Replaces the Contents-API directory
 * listing plus the per-file GETs that followed it.
 *
 * `name`, `oid` and `type` all live in the tree entry itself, so they are cheap.
 * Asking for the blob's `byteSize` is NOT: it makes GitHub resolve 641 objects and,
 * measured on the real pool, took the query from ~2.4 s to ~10 s and returned
 * 502/504 on four of five attempts (vs one of five without it). Nothing needed the
 * size. If a caller ever does, fetch it for the handful of files it cares about
 * rather than for the whole folder.
 */
/**
 * Every name in a public folder, read one file at a time on the raw lane. The
 * per-file cost is what a credential-free read buys: raw serves blobs, not
 * directory listings and not batches, so there is no public equivalent of the
 * GraphQL bulk query. A file that is missing or unparseable is simply absent
 * from the map — exactly how the GraphQL path reports the same thing.
 */
async function readPublicPoolFiles<T>(
  repo: string, branch: string, folder: string, names: string[],
  o: { onBatch?: (done: number, total: number) => void },
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  let done = 0;
  await Promise.all(names.map(async (name) => {
    try {
      const r = await ghReadPublicJson<T>(repo, branch, `${folder}/${name}`);
      if (r.found && r.data) out.set(name, r.data);
    } catch { /* one unreachable file is not the whole read */ }
    o.onBatch?.(++done, names.length);
  }));
  return out;
}

export async function ghListPoolFiles(repo: string, branch: string, token: string, folder: string): Promise<PoolFile[]> {
  const { owner, name } = gqlRepo(repo);
  const data = await ghGraphQL<{ repository: { object: { entries?: Array<{ name: string; oid: string; type: string }> } | null } | null }>(
    token,
    `{ repository(owner: "${owner}", name: "${name}") { object(expression: "${branch}:${folder}") { ... on Tree { entries { name oid type } } } } }`,
  );
  const entries = data?.repository?.object?.entries || [];
  return entries
    .filter((e) => e.type === 'blob' && e.name.endsWith('.json') && e.name !== 'index.json')
    .map((e) => ({ name: e.name, oid: e.oid }));
}

/**
 * The bodies of many files in one folder, `batchSize` per request. Returns only
 * the names that resolved to a parseable JSON blob — a missing or corrupt file is
 * absent from the map, which is how every caller already treats "not found".
 *
 * A name that is not a plain filename is skipped rather than interpolated into
 * the query: a golden key reaches this function from user data, and the query is
 * a string.
 */
export async function ghReadPoolFiles<T = unknown>(
  repo: string, branch: string, token: string, folder: string, names: string[],
  o: { batchSize?: number; onBatch?: (done: number, total: number) => void } = {},
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const safe = [...new Set(names.filter(isPoolFileName))];
  if (!safe.length) return out;
  // No token: the pool is public, so read it as the public. Slower per file than
  // GraphQL's 100-per-request, but it needs no credential — which is the whole
  // point, and what every install without a publish token actually uses.
  if (!token) return readPublicPoolFiles<T>(repo, branch, folder, safe, o);
  const { owner, name: repoName } = gqlRepo(repo);
  const size = Math.max(1, o.batchSize ?? config.batchSize);
  for (let i = 0; i < safe.length; i += size) {
    const batch = safe.slice(i, i + size);
    // JSON.stringify produces a properly-quoted, escaped GraphQL string literal
    // (GraphQL shares JSON's string escaping) — so a '#' or any other special
    // char in a schema-format filename cannot break out of the expression.
    const aliases = batch.map((f, j) => `f${j}: object(expression: ${JSON.stringify(`${branch}:${folder}/${f}`)}) { ... on Blob { text } }`).join('\n');
    const data = await ghGraphQL<{ repository: Record<string, { text?: string } | null> | null }>(
      token, `{ repository(owner: "${owner}", name: "${repoName}") { ${aliases} } }`,
    );
    const repository = data?.repository || {};
    batch.forEach((f, j) => {
      const text = repository[`f${j}`]?.text;
      if (!text) return;
      try { out.set(f, JSON.parse(text) as T); } catch { /* corrupt file — absent, same as missing */ }
    });
    o.onBatch?.(Math.min(i + size, safe.length), safe.length);
  }
  return out;
}
