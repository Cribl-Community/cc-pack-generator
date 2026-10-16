/**
 * AI-sample library — disk access for the standalone backend.
 *
 * Two locations, and the split is the whole point:
 *   config/ai-samples/        COMMITTED library. Read by both run modes.
 *   .cache/ai-samples-pending/  staging. Written by generation, never committed.
 *
 * Generation only ever writes to staging; `npm run samples:promote` moves a
 * sample into the library. That keeps "this sample is correct" a human decision
 * and keeps the app from dirtying the working tree while someone is working on
 * something else (a golden-store write got swept into an unrelated commit that
 * way once already).
 *
 * The iframe path can't touch either directory; it reads the library through the
 * Vite-bundled copy in src/bundled-data.ts. Shared conventions and the verifier
 * live in src/sample-library.ts so there is one implementation, not a mirror.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiSampleKeyToFile, detectKeyEcho, keyEchoReason, sampleStoreKeys,
} from '../src/sample-library.ts';

const LIB_DIR = join(process.cwd(), 'config', 'ai-samples');
const PENDING_DIR = process.env.AI_SAMPLE_PENDING_DIR || join(process.cwd(), '.cache', 'ai-samples-pending');
const INDEX_PATH = join(LIB_DIR, 'index.json');
const REJECTED_PATH = join(LIB_DIR, 'rejected.json');
const DEFERRED_PATH = join(LIB_DIR, 'deferred.json');

export { LIB_DIR, PENDING_DIR };

function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// --- Library (committed) ------------------------------------------------------

export function readLibraryIndex() {
  const idx = readJson(INDEX_PATH, { version: 1, samples: [] });
  return Array.isArray(idx.samples) ? idx : { version: 1, samples: [] };
}

export function readRejected() {
  const r = readJson(REJECTED_PATH, { version: 1, fingerprints: [] });
  return new Set(Array.isArray(r.fingerprints) ? r.fingerprints : []);
}

/** Fingerprint → { key, reason } for the rejections that recorded why. */
export function readRejectedNotes() {
  const r = readJson(REJECTED_PATH, {});
  return r.notes && typeof r.notes === 'object' ? r.notes : {};
}

/**
 * Key → the open question recorded when a sample was deferred. NOT a gate: nothing
 * here blocks a promotion, which is the whole difference from `rejected.json`.
 */
export function readDeferred() {
  const d = readJson(DEFERRED_PATH, { version: 1, deferred: {} });
  return d.deferred && typeof d.deferred === 'object' ? d.deferred : {};
}

export function readLibraryDoc(key) {
  return readJson(join(LIB_DIR, aiSampleKeyToFile(key)), null);
}

/**
 * Resolve a library sample for a sourcetype. Tries the format-specific key first
 * (`zscaler_web::cef`) and then the bare sourcetype, so a caller that knows the
 * wire format gets the right variant and one that doesn't still gets something —
 * then the same two under a store alias. Order comes from `sampleStoreKeys`, shared
 * with the vendor store and with both run modes.
 */
export function getAiLibrarySample(sourcetype, format) {
  for (const key of sampleStoreKeys(sourcetype, format)) {
    const doc = readLibraryDoc(key);
    if (doc?.events?.length) return doc;
  }
  return null;
}

/** The shape handleReferenceSample returns, so this slots into the tier chain. */
export function toReferenceResponse(doc) {
  if (!doc?.events?.length) return null;
  return {
    available: true,
    events: doc.events,
    sourcetype: doc.sourcetype,
    pack: 'ai-samples',
    fields: doc.verification?.fields || [],
    sampleName: `${doc.sourcetype}_ai_sample`,
    // Surfaced so callers/UI can tell synthetic data from real vendor logs and
    // see how strongly it was verified.
    synthetic: true,
    verification: doc.verification || null,
  };
}

// --- Staging (.cache, never committed) ---------------------------------------

export function writePendingDoc(doc) {
  if (!doc?.key) return null;
  mkdirSync(PENDING_DIR, { recursive: true });
  const path = join(PENDING_DIR, aiSampleKeyToFile(doc.key));
  writeJson(path, doc);
  return path;
}

export function listPendingDocs() {
  if (!existsSync(PENDING_DIR)) return [];
  return readdirSync(PENDING_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(PENDING_DIR, f), null))
    .filter(d => d && Array.isArray(d.events) && d.events.length > 0);
}

export function deletePending(key) {
  const path = join(PENDING_DIR, aiSampleKeyToFile(key));
  if (existsSync(path)) { unlinkSync(path); return true; }
  return false;
}

// --- Promote / reject ---------------------------------------------------------

/**
 * Move a staged sample into the committed library and record it in index.json.
 * Refuses a previously-rejected fingerprint — otherwise removing a bad sample
 * would only last until the next generation produced the same thing again.
 */
export function promotePending(key, { force = false } = {}) {
  const doc = readJson(join(PENDING_DIR, aiSampleKeyToFile(key)), null);
  if (!doc) return { ok: false, reason: `nothing staged for "${key}"` };
  if (readRejected().has(doc.fingerprint)) {
    return { ok: false, reason: `these exact events were rejected before (fingerprint ${doc.fingerprint})` };
  }
  if (doc.verification?.verdict === 'fail' && !force) {
    return { ok: false, reason: `verification failed: ${(doc.verification.reasons || [])[0] || 'unknown'} (use --force to promote anyway)` };
  }
  // The STORED verdict was produced by whichever build generated the sample, and
  // checks get ADDED under it — the key-echo detector (build 464) did not exist
  // when the current queue was staged, so 6 fabricated samples sit there with a
  // stored `pass`. Re-run it here, at the write, or the review screen would show a
  // failure while promoting still succeeded.
  const echo = detectKeyEcho(doc.sourcetype || key, doc.events || []);
  if (echo && !force) {
    return { ok: false, reason: `verification failed: ${keyEchoReason(echo)} (use --force to promote anyway)` };
  }
  mkdirSync(LIB_DIR, { recursive: true });
  writeJson(join(LIB_DIR, aiSampleKeyToFile(key)), doc);

  const idx = readLibraryIndex();
  const entry = {
    key: doc.key,
    sourcetype: doc.sourcetype,
    format: doc.format || null,
    events: doc.events.length,
    fingerprint: doc.fingerprint,
    verdict: doc.verification?.verdict || 'unverified',
    method: doc.verification?.method || 'none',
    fields: (doc.verification?.fields || []).length,
    model: doc.provenance?.model || null,
    buildNumber: doc.provenance?.buildNumber ?? null,
    generatedAt: doc.provenance?.generatedAt || null,
    file: aiSampleKeyToFile(doc.key),
  };
  idx.samples = [...idx.samples.filter(s => s.key !== doc.key), entry]
    .sort((a, b) => a.key.localeCompare(b.key));
  writeJson(INDEX_PATH, idx);
  deletePending(key);
  // The question is answered, so it stops being an open one. Note this runs AFTER
  // the promote decision, never before it — a deferral records doubt, not a verdict.
  const clearedDeferral = clearDeferred(key);
  return { ok: true, entry, clearedDeferral };
}

/**
 * The exact inverse of promote: move a committed sample back to staging, drop its
 * index entry, blacklist nothing.
 *
 * Needed because promote is a judgement made on the evidence available at the time,
 * and the evidence can improve. 8 `ncsc_*` samples were promoted on a `pass` that build
 * 464 later split into three tiers — all 8 were structure-only, which proves the events
 * are well-formed data and nothing about the vendor's format, and 7 of them turned out
 * to be shadowing real Cloudflare Logpush fixtures already on disk. Rejecting them
 * would have blacklisted content that was never judged wrong, only judged too early;
 * deleting them would have thrown away work. Sending them back to the queue puts the
 * decision where it belongs, with the evidence now stated honestly.
 */
export function unpromoteSample(key) {
  const libPath = join(LIB_DIR, aiSampleKeyToFile(key));
  const doc = readJson(libPath, null);
  if (!doc) return { ok: false, reason: `no committed sample for "${key}"` };
  const pendPath = join(PENDING_DIR, aiSampleKeyToFile(key));
  if (existsSync(pendPath)) return { ok: false, reason: `"${key}" is already staged — resolve that copy first` };
  mkdirSync(PENDING_DIR, { recursive: true });
  writeJson(pendPath, doc);
  unlinkSync(libPath);
  const idx = readLibraryIndex();
  idx.samples = idx.samples.filter(s => s.key !== key);
  writeJson(INDEX_PATH, idx);
  return { ok: true, key, events: doc.events?.length ?? 0 };
}

/**
 * Drop a staged sample from the queue WITHOUT deciding about it — the verdict for
 * "I am not sure yet".
 *
 * `reject` is permanent and `discard` says nothing, so an unclear sample had only
 * two bad options: blacklist a fingerprint on a suspicion, or delete the file and
 * lose the doubt with it. Then the next generation stages the same thing and the
 * next reviewer starts the same investigation from nothing.
 *
 * A deferral is keyed by SAMPLE KEY, not by fingerprint. That is deliberate: the
 * point is to be told about the doubt when a sample for that source comes back, and
 * a regenerated sample has different content, so a fingerprint-keyed note would
 * never be found again — which is exactly the failure this is meant to fix. The
 * fingerprints seen are recorded inside the entry instead, so review can say whether
 * the new sample is genuinely new or the same one again.
 *
 * Nothing here is a gate. `promotePending` does not read this file.
 */
export function deferSample(key, { reason = '' } = {}) {
  if (existsSync(join(LIB_DIR, aiSampleKeyToFile(key)))) {
    return { ok: false, reason: `"${key}" is committed, not staged — run samples:unpromote ${key} first if you want it back in the queue` };
  }
  const doc = readJson(join(PENDING_DIR, aiSampleKeyToFile(key)), null);
  if (!doc) return { ok: false, reason: `nothing staged for "${key}"` };

  const file = readJson(DEFERRED_PATH, { version: 1, deferred: {} });
  const all = file.deferred && typeof file.deferred === 'object' ? { ...file.deferred } : {};
  const prev = all[key];
  const seen = [...new Set([...(prev?.seen || []), doc.fingerprint].filter(Boolean))].sort();
  all[key] = {
    reason: String(reason).slice(0, 500),
    deferredAt: new Date().toISOString().slice(0, 10),
    times: (prev?.times || 0) + 1,
    events: doc.events.length,
    verdict: doc.verification?.verdict || 'unverified',
    method: doc.verification?.method || 'none',
    // Every fingerprint this key has been deferred at, so a repeat can be told
    // apart from a genuinely new sample.
    seen,
    // Enough content to recognise what was deferred when the next one arrives,
    // without making this file a second copy of the store.
    firstEvent: String(doc.events[0] || '').slice(0, 200),
  };
  const sorted = Object.fromEntries(Object.entries(all).sort((a, b) => a[0].localeCompare(b[0])));
  writeJson(DEFERRED_PATH, { ...file, version: 1, deferred: sorted });
  deletePending(key);
  return { ok: true, key, times: all[key].times, repeat: Boolean(prev), sameContent: Boolean(prev?.seen?.includes(doc.fingerprint)) };
}

/**
 * Forget a deferral, because the question has been answered. Called by promote and
 * reject so the file stays a list of OPEN questions rather than a log of old ones —
 * a stale entry would keep warning about a doubt that has since been settled, which
 * is how the KNOWN_VERIFIER_GAPS and UNREADABLE_SOURCE_SAMPLES lists are policed too.
 */
export function clearDeferred(key) {
  const file = readJson(DEFERRED_PATH, null);
  if (!file?.deferred || !Object.hasOwn(file.deferred, key)) return false;
  const all = { ...file.deferred };
  delete all[key];
  writeJson(DEFERRED_PATH, { ...file, version: 1, deferred: all });
  return true;
}

/**
 * Remove a sample from the library and/or staging and blacklist its content so
 * it can never be promoted again.
 *
 * `reason` is recorded against the fingerprint in `notes`. That matters when the
 * rejection came from an outside review ("contradicted: cs1 carries the policy name,
 * not the payload"): the fingerprint alone says a sample was wrong, the note says
 * what was wrong with it, which is what a regeneration needs. Readers only ever look
 * at `fingerprints`, so the extra key is backward-compatible.
 */
export function rejectSample(key, { reason = '' } = {}) {
  const libPath = join(LIB_DIR, aiSampleKeyToFile(key));
  const libDoc = readJson(libPath, null);
  const pendDoc = readJson(join(PENDING_DIR, aiSampleKeyToFile(key)), null);
  const doc = libDoc || pendDoc;
  if (!doc) return { ok: false, reason: `no sample found for "${key}" in the library or staging` };

  const rejected = readJson(REJECTED_PATH, { version: 1, fingerprints: [] });
  const prints = new Set(Array.isArray(rejected.fingerprints) ? rejected.fingerprints : []);
  const notes = rejected.notes && typeof rejected.notes === 'object' ? { ...rejected.notes } : {};
  for (const d of [libDoc, pendDoc]) {
    if (!d?.fingerprint) continue;
    prints.add(d.fingerprint);
    if (reason) notes[d.fingerprint] = { key, reason: String(reason).slice(0, 500) };
  }
  writeJson(REJECTED_PATH, { ...rejected, version: 1, fingerprints: [...prints].sort(), notes });

  let removedFromLibrary = false;
  if (libDoc) { unlinkSync(libPath); removedFromLibrary = true; }
  const removedFromPending = deletePending(key);

  if (removedFromLibrary) {
    const idx = readLibraryIndex();
    idx.samples = idx.samples.filter(s => s.key !== key);
    writeJson(INDEX_PATH, idx);
  }
  // A rejection is the answer to whatever the deferral was asking, and the reason
  // recorded here supersedes it.
  const clearedDeferral = clearDeferred(key);
  return { ok: true, removedFromLibrary, removedFromPending, clearedDeferral, fingerprints: [...prints].length };
}
