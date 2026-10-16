/**
 * Sample-library review API — the backend the review screen talks to.
 *
 * Everything here is a thin wrapper over ai-sample-library.mjs, which already owned
 * the disk rules (staging never gets committed, a rejected fingerprint can never come
 * back, promoting rewrites index.json). This module adds the two things a REVIEW
 * screen needs that a CLI did not:
 *
 *  1. **Bulk, with a per-key result.** A reviewer works through a queue and a partial
 *     failure must not look like a success — each key comes back with its own ok/reason
 *     so the UI can say "promoted 6, refused 1 because that fingerprint was rejected
 *     before" instead of a single boolean.
 *  2. **Whether a REAL sample already exists for that source.** This is the question
 *     that decides most of the queue and the CLI never asked it: generated samples are
 *     tier 4 of the ladder, so a staged sample for a source that already has a real
 *     vendor log can never be served. Reviewing it is wasted work — it should be
 *     dropped. Resolution reuses reference-api's own tier functions rather than
 *     re-deriving them, because a mirrored copy of that logic has drifted before.
 *
 * Standalone only, by construction: this reads and writes config/ai-samples/ and
 * .cache/ai-samples-pending/ on disk. The iframe has no filesystem, so api.ts returns
 * an explicit "unavailable" instead of calling these (Hard Rule 18).
 */

import { readFileSync } from 'node:fs';

import {
  listPendingDocs, promotePending, rejectSample, deferSample, deletePending,
  readLibraryIndex, readRejected, readDeferred,
} from './ai-sample-library.mjs';
import { vendorIndexRow } from './vendor-sample-library.mjs';
import { FALLBACK_SAMPLES, getSourceSampleFallback } from './reference-api.mjs';
import { setSourcetypeVolumes, sourcetypeVolume } from '../src/sample-library.ts';

/**
 * Install the volume census from a gitignored local file, if the maintainer has one.
 *
 * The census is REAL CUSTOMER DATA and is not in this repo (it lived at
 * `config/sourcetype-volumes.json` until build 699, where a static import carried it
 * into the Sample Sanitizer's published source graph). Reading it here — at runtime, in
 * the standalone backend only — is what keeps it out of any bundle or published tree.
 * Missing file, bad JSON and iframe mode all mean the same harmless thing: the review
 * queue is unranked.
 */
function loadVolumeCensus() {
  for (const name of ['sourcetype-volumes.local.json', 'sourcetype-volumes.json']) {
    try {
      const raw = readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8');
      const doc = JSON.parse(raw);
      setSourcetypeVolumes(doc?.volumes || doc);
      return;
    } catch { /* absent or unreadable — next candidate, else stay unranked */ }
  }
}
loadVolumeCensus();

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

/**
 * Does a REAL log already exist for this source, and from which tier?
 *
 * Only the tiers that OUTRANK generated samples count — curated fallbacks, the
 * Splunk-derived source-samples store, and the harvested vendor corpus. The
 * ai-samples store is deliberately not consulted: that is the tier being reviewed,
 * and a sample cannot shadow itself.
 *
 * The vendor tier is answered from its MANIFEST, not by fetching the sample: "is
 * there one, and how many events" is all this needs, and the review screen asks it
 * about every staged and committed key at once — fetching a body each time would
 * turn one screen into a hundred pool reads for information already on disk.
 */
export function realSampleFor(sourcetype, format) {
  const st = String(sourcetype || '').toLowerCase().trim();
  if (!st) return null;
  if (FALLBACK_SAMPLES[st]?.length) return { tier: 'curated', events: FALLBACK_SAMPLES[st].length };
  const src = getSourceSampleFallback(st);
  if (src?.available && src.events?.length) return { tier: 'source-samples', events: src.events.length };
  const vendor = vendorIndexRow(st, format || null);
  if (vendor?.events) return { tier: 'vendor', events: vendor.events };
  return null;
}

/** Shape one staged doc for the UI: the doc as stored, plus what only the backend knows. */
function stagedPayload(doc, deferred = {}) {
  const d = deferred[doc.key];
  return {
    key: doc.key,
    sourcetype: doc.sourcetype,
    format: doc.format || null,
    events: Array.isArray(doc.events) ? doc.events : [],
    eventsTotal: Array.isArray(doc.events) ? doc.events.length : 0,
    fingerprint: doc.fingerprint || '',
    verification: doc.verification || { verdict: 'unverified', method: 'none', eventsParsed: 0, eventsChecked: 0, fields: [], reasons: [] },
    provenance: doc.provenance || { model: 'unknown', buildNumber: 0, generatedAt: '' },
    // A conc_probe_* key is a concurrency-test artifact, never a sample anyone wants.
    probe: /^conc_probe_/.test(doc.key || ''),
    realSample: realSampleFor(doc.sourcetype, doc.format),
    // An earlier reviewer's unresolved doubt about this source. Attached here because
    // this is the only moment it is useful: the whole point of deferring instead of
    // deleting is that the question comes back WITH the next sample. `sameContent`
    // answers what the reviewer needs next — whether the generator actually produced
    // something new, or repeated what was already found unjudgeable.
    deferred: d
      ? {
        reason: d.reason || '',
        deferredAt: d.deferredAt || '',
        times: d.times || 1,
        sameContent: Array.isArray(d.seen) ? d.seen.includes(doc.fingerprint) : false,
        firstEvent: d.firstEvent || '',
      }
      : null,
    // Real customer event count, for ORDERING the queue only (never for deciding
    // whether a source is worth supporting). Alphabetical order put `aemcdn` and
    // `f5_bigip_apm` — 1 event in the census — above `cisco:estreamer:data:firewall`
    // at 52.9M, so the review effort landed where it mattered least.
    volume: sourcetypeVolume(doc.sourcetype),
  };
}

/**
 * Reviewable = staged minus the test artifacts.
 *
 * The header badge said 90 while only 34 of those files were samples anyone would
 * ever review; the other 56 were `conc_probe_*` fixtures from a concurrency test
 * that had escaped into the real staging directory. A queue count that includes
 * them misstates the work by 2.6x.
 */
function reviewable(staged) {
  return staged.filter(d => !d.probe);
}

/**
 * GET /api/pack-generator/sample-library
 * GET /api/pack-generator/sample-library?summary=1   → counts only
 *
 * The summary form exists for the header badge: the full form carries every event of
 * every staged sample (~400 KB at 98 docs), which is the right payload for the review
 * screen and the wrong one to fetch on every app start.
 */
export function handleSampleLibrary(req, res) {
  try {
    const u = new URL(req.url, 'http://localhost');
    // Ordered by real customer volume, biggest first — an unranked queue is reviewed
    // alphabetically, which is the same as at random. Keys with no census entry sort
    // last (a missing volume is "unknown", not "zero"), then alphabetically.
    const deferred = readDeferred();
    const staged = listPendingDocs().map(doc => stagedPayload(doc, deferred))
      .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || a.key.localeCompare(b.key));
    const index = readLibraryIndex();
    const rejected = readRejected();
    if (u.searchParams.get('summary')) {
      const real = reviewable(staged);
      return sendJson(res, 200, {
        available: true,
        // The badge counts what there is to REVIEW; probes are reported separately
        // so the screen can offer to delete them instead of hiding them.
        staged: real.length,
        probes: staged.length - real.length,
        library: index.samples.length,
        rejected: rejected.size,
        shadowed: real.filter(d => d.realSample).length,
      });
    }
    // A committed sample can be shadowed too — a real log may have been harvested
    // for that source after it was promoted, which makes the committed file dead
    // weight rather than a mistake. Same question, different tab.
    const library = index.samples.map(s => ({ ...s, realSample: realSampleFor(s.sourcetype, s.format) }));
    sendJson(res, 200, {
      available: true,
      staged,
      library,
      rejectedCount: rejected.size,
    });
  } catch (err) {
    sendJson(res, 200, { available: false, staged: [], library: [], error: err.message });
  }
}

/**
 * POST /api/pack-generator/sample-library/promote  { keys: [...], force?: bool }
 * Per-key result — a bulk promote where one key is refused must report that key.
 */
export async function handleSampleLibraryPromote(req, res) {
  try {
    const { keys, force = false } = await readBody(req);
    if (!Array.isArray(keys) || !keys.length) return sendJson(res, 400, { error: 'keys[] required' });
    const results = keys.map(key => {
      try {
        const r = promotePending(key, { force: !!force });
        return { key, ok: !!r.ok, reason: r.reason || null, entry: r.entry || null };
      } catch (err) {
        return { key, ok: false, reason: err.message };
      }
    });
    sendJson(res, 200, { results, promoted: results.filter(r => r.ok).length });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

/**
 * POST /api/pack-generator/sample-library/discard  { keys: [...] }
 *
 * Delete from STAGING only, and do NOT blacklist the fingerprint.
 *
 * Reject is the right write for a sample that is wrong — the blacklist is what stops
 * the next generation producing it again. It is the wrong write for a file that was
 * never a sample: 56 `conc_probe_*` concurrency-test artifacts would have put 56
 * meaningless content fingerprints in rejected.json permanently, which is a store of
 * "events we have judged" filled with events nobody generated.
 *
 * Staging-only by construction: `deletePending` cannot touch config/ai-samples/, so
 * this endpoint has no path to the committed library even if it is called with a
 * library key.
 */
export async function handleSampleLibraryDiscard(req, res) {
  try {
    const { keys } = await readBody(req);
    if (!Array.isArray(keys) || !keys.length) return sendJson(res, 400, { error: 'keys[] required' });
    const results = keys.map(key => {
      try {
        const removed = deletePending(key);
        return { key, ok: removed, reason: removed ? null : `nothing staged for "${key}"` };
      } catch (err) {
        return { key, ok: false, reason: err.message };
      }
    });
    sendJson(res, 200, { results, discarded: results.filter(r => r.ok).length });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

/**
 * POST /api/pack-generator/sample-library/reject  { keys: [...], reasons?: {key: text} }
 * Rejecting covers both tabs on purpose: rejectSample removes the key from staging
 * AND from the committed library, and blacklists the content fingerprint either way.
 * That is what "delete a promoted sample that turned out to be wrong" has to mean —
 * deleting the file alone would let the next generation re-create it.
 *
 * `reasons` is optional and comes from a reviewer's verdict block; it is stored with
 * the fingerprint so a later regeneration can be told what was wrong last time.
 */
export async function handleSampleLibraryReject(req, res) {
  try {
    const { keys, reasons = {} } = await readBody(req);
    if (!Array.isArray(keys) || !keys.length) return sendJson(res, 400, { error: 'keys[] required' });
    const results = keys.map(key => {
      try {
        const r = rejectSample(key, { reason: reasons?.[key] || '' });
        return {
          key, ok: !!r.ok, reason: r.reason || null,
          removedFromLibrary: !!r.removedFromLibrary, removedFromPending: !!r.removedFromPending,
        };
      } catch (err) {
        return { key, ok: false, reason: err.message };
      }
    });
      sendJson(res, 200, { results, rejected: results.filter(r => r.ok).length });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

/**
 * POST /api/pack-generator/sample-library/defer  { keys: [...], reasons: {key: text} }
 *
 * Take a sample out of the queue WITHOUT deciding about it, and blacklist nothing.
 *
 * The review screen offered promote and reject-and-blacklist per sample, and delete
 * only as a bulk action on the probe artifacts. So a reviewer who could not tell had
 * to either blacklist a fingerprint on a suspicion — permanent, and it stops the next
 * generation from ever producing those events again — or leave the sample sitting in
 * the queue being re-read at every review. Deferring clears it and keeps the doubt.
 *
 * The reason is REQUIRED here, unlike discard: a deferral whose question nobody wrote
 * down is a deleted file with a longer audit trail. See `deferSample`.
 */
export async function handleSampleLibraryDefer(req, res) {
  try {
    const { keys, reasons = {} } = await readBody(req);
    if (!Array.isArray(keys) || !keys.length) return sendJson(res, 400, { error: 'keys[] required' });
    const missing = keys.filter(k => !String(reasons?.[k] || '').trim());
    if (missing.length) {
      return sendJson(res, 400, { error: `a reason is required for every deferral — missing for ${missing.join(', ')}` });
    }
    const results = keys.map(key => {
      try {
        const r = deferSample(key, { reason: reasons[key] });
        return {
          key, ok: !!r.ok, reason: r.reason || null,
          removedFromPending: !!r.ok, times: r.times || 0, sameContent: !!r.sameContent,
        };
      } catch (err) {
        return { key, ok: false, reason: err.message };
      }
    });
    sendJson(res, 200, { results, deferred: results.filter(r => r.ok).length });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}
