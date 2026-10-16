/**
 * Sample Library review screen (build 462).
 *
 * AI-generated samples are staged in `.cache/ai-samples-pending/` and only become part
 * of the committed library (`config/ai-samples/`) when someone promotes them. This is
 * that screen: the queue, the evidence for each sample, and the three writes that clear
 * a row — promote, remove, and reject-and-blacklist.
 *
 * Remove exists because the other two are both assertions, and for a while they were the
 * only per-sample actions. A reviewer who did not want to rule on a row had to blacklist
 * its content on a suspicion — permanently, which also stops the next generation
 * producing those events — or leave it in the queue to be re-read at every review.
 * Removing writes no judgement at all: staging is a cache, so it drops one generated
 * file and nothing prevents the same sample being staged and reviewed again later.
 *
 * (`npm run samples:defer` is the same removal with a recorded question, for when the
 * doubt is worth handing to the next reviewer. This screen displays such a note when a
 * sample for that key comes back, but does not create them.)
 *
 * Three things it must get right, because each one has already gone wrong somewhere:
 *
 *  • **Evidence is measured here and now, not read back.** The stored verdict was
 *    produced by whichever build generated the sample, and parsers move under it — a
 *    sample can become readable because a parser was added, or stop being readable
 *    because one was tightened. Every row re-runs the real verifier against today's
 *    code and the drift against the stored claim is shown. A stored claim is not a
 *    measurement.
 *  • **"unverified" is never a soft pass.** It means nothing in the app checked these
 *    lines, and the screen says exactly that. Most of the queue is in that state, which
 *    is why the Markdown report exists: the one question the app cannot answer ("is this
 *    what the vendor really emits?") has to be asked of a human, a vendor doc or Glean.
 *  • **A sample that can never be served needs no review.** Generated samples are tier 4
 *    of the ladder, so a real vendor log for the same source outranks them permanently.
 *    The backend answers that question per row (`realSample`) and those rows are flagged
 *    for rejection rather than researched.
 *
 * A returned review comes back in the report's own one-line-per-sample grammar and is
 * read back by `parseVerdictBlock`, so a reviewer's answer is applied instead of
 * re-typed. Reject reasons are stored with the blacklisted fingerprint.
 *
 * Standalone only, by construction, not by policy: both directories are on disk. In the
 * iframe the tile is hidden and this panel explains why rather than failing a fetch
 * (Hard Rule 18).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  describeSampleFormat, sampleVariantsPresent, verifyGeneratedSample, SAMPLE_EXTEND_FLOOR,
  sampleEvidence, sampleEvidenceLabel, sourcetypeVolume, squashedDuplicateKeys,
  type SampleEvidence,
} from './sample-library';
import { describeSourcetype, getMultiFormatSpec } from './pack-builder';
import {
  fetchSampleLibrary, promoteStagedSamples, rejectSamples, discardStagedSamples,
  fetchSanitisedSamples, fetchSanitisedSample, deleteSanitisedSample,
  type SampleLibraryState, type SanitisedSampleLibraryState,
  type StagedSampleDoc, type LibrarySampleEntry, type SampleActionResult,
} from './api';
import {
  renderSampleReviewMarkdown, resolveProductLabel, sampleReviewFilename, parseVerdictBlock,
  REPORT_MAX_EVENTS, type ReviewSample,
} from './sample-review-report';
import { SanitizeWizard } from './sanitize-wizard';
import { downloadSanitisedSamplePayload } from './sanitised-sample-store';

type Verdict = 'pass' | 'fail' | 'unverified';

// The real floor, so the "thin" flag agrees with what the app enforces elsewhere.
const SAMPLE_EXTEND_FLOOR_HINT = SAMPLE_EXTEND_FLOOR;

type Filter = 'all' | 'verified' | 'declared' | 'structure' | 'unverified' | 'keyecho' | 'dupe' | 'mixed' | 'thin' | 'probe' | 'shadowed' | 'deferred';

/**
 * The four evidence tiers are SEPARATE chips on purpose.
 *
 * `verdict: 'pass'` is produced by three checks of very different strength, and the
 * screen used to render them the same way. Measured on the real 34-sample queue: 3
 * parser-verified, 17 structure-only, 14 unverifiable — and one of the structure-only
 * "passes" had 0 of 15 field names in common with the real captured vendor event. A
 * reviewer who cannot see which check ran cannot tell those apart.
 */
const FILTERS: { id: Filter; label: string; tone?: string }[] = [
  { id: 'all', label: 'All staged' },
  { id: 'verified', label: 'Parser-verified', tone: 'ok' },
  { id: 'declared', label: 'Matches declared format', tone: 'ok' },
  { id: 'structure', label: 'Structure only', tone: 'warn' },
  { id: 'unverified', label: 'Not checked', tone: 'warn' },
  { id: 'keyecho', label: 'Sourcetype echoed in the log', tone: 'bad' },
  { id: 'dupe', label: 'Squashed duplicate', tone: 'bad' },
  { id: 'mixed', label: 'Mixed format', tone: 'bad' },
  { id: 'thin', label: `Thin (<${SAMPLE_EXTEND_FLOOR_HINT} events)`, tone: 'bad' },
  { id: 'shadowed', label: 'Real log exists', tone: 'bad' },
  { id: 'probe', label: 'Probe artifacts', tone: 'bad' },
  // Deferred earlier and back with DIFFERENT content — the queue's most answerable
  // rows, because someone already wrote down what to look for.
  { id: 'deferred', label: 'Deferred, new sample in', tone: 'warn' },
];

/**
 * Keys that are the same sourcetype with the separators removed.
 *
 * The recognizer has a squashed-form tier (`XmlWinEventLog…` CamelCase resolution), and
 * a batch that arrives with both spellings generates a sample under each: the queue holds
 * `ivanti_top` AND `ivantitop`, `http_fpc_metadata` AND `httpfpcmetadata`, `vmware_nsx`
 * AND `vmwarensx` — three pairs of 34 rows, so ~9% of the review effort was duplicate
 * work nobody could see. The separator-less spelling is the derived one, so that is the
 * side flagged.
 */
/** 52 900 000 → "52.9M". A raw 9-digit number in a table cell is unreadable. */
function formatVolume(v: number | null | undefined): string {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/**
 * Doc-level evidence, computed live for every row.
 *
 * Deliberately excludes the per-line parser marks: those cost one verifier call per
 * event, and with ~100 staged samples of ~10 events that is ~1000 calls to render a
 * list where only one row's lines are on screen. They are computed for the selected
 * sample only (`parsedLinesFor`).
 */
function evidenceFor(doc: StagedSampleDoc, squashedDuplicate = false) {
  const format = describeSampleFormat(doc.events);
  // `synthetic: true` — everything in this queue was written by a model, which is
  // what makes the key-echo check applicable (see detectKeyEcho). The same call on a
  // harvested vendor log would not apply it.
  const now = verifyGeneratedSample(doc.sourcetype, doc.events, { synthetic: true });
  const tier = sampleEvidence(now);
  const volume = doc.volume ?? sourcetypeVolume(doc.sourcetype);
  const product = resolveProductLabel({
    sourcetype: doc.sourcetype,
    catalogDescription: describeSourcetype(doc.sourcetype),
    grounding: doc.provenance.grounding,
  });
  const spec = getMultiFormatSpec(doc.sourcetype);
  const variantsPossible = spec ? spec.formats.map(f => f.id) : [];
  const variantsPresent = variantsPossible.length ? sampleVariantsPresent(doc.events, variantsPossible) : [];
  const flags: string[] = [];
  if (now.keyEcho) flags.push(`sourcetype echoed as ${now.keyEcho.position}`);
  if (squashedDuplicate) flags.push('duplicate of the separated spelling');
  if (doc.realSample) flags.push(`real ${doc.realSample.tier} log exists`);
  // Whether the deferral has been answered by this sample is the useful half, so the
  // flag carries it — 'repeat' means the generator produced the same thing again.
  if (doc.deferred) flags.push(doc.deferred.sameContent ? 'deferred (repeat)' : 'deferred (new)');
  if (format.mixed) flags.push('mixed format');
  if (doc.eventsTotal < SAMPLE_EXTEND_FLOOR_HINT) flags.push(`thin (<${SAMPLE_EXTEND_FLOOR_HINT})`);
  if (doc.probe) flags.push('probe artifact');
  if (now.verdict !== doc.verification.verdict || now.method !== doc.verification.method) flags.push('verdict drifted');
  if (variantsPossible.length > 1 && variantsPresent.length === 1) flags.push('one variant of several');
  if (!product.known) flags.push('product unidentified');
  return { format, now, tier, volume, squashedDuplicate, product, variantsPossible, variantsPresent, flags };
}

type Evidence = ReturnType<typeof evidenceFor>;

/**
 * Which individual lines the parser can read. A ratio hides the shape of the problem —
 * one unreadable line in an otherwise good sample means something different from ten,
 * and the reviewer needs to see WHICH line. `null` = no parser could run at all.
 */
function parsedLinesFor(doc: StagedSampleDoc, method: string): (boolean | null)[] {
  if (method !== 'parser-emulation') return doc.events.map(() => null);
  return doc.events.map(ev => verifyGeneratedSample(doc.sourcetype, [ev]).eventsParsed === 1);
}

function matchesFilter(doc: StagedSampleDoc, ev: Evidence, f: Filter): boolean {
  switch (f) {
    case 'all': return true;
    // The tiers are exclusive by construction (`sampleEvidence`), so these four
    // chips partition the queue instead of overlapping — which is the point: the
    // counts have to add up for a reviewer to trust them.
    case 'verified': return ev.tier === 'parser-verified';
    case 'declared': return ev.tier === 'format-declared';
    case 'structure': return ev.tier === 'structure-only';
    case 'unverified': return ev.tier === 'none';
    case 'keyecho': return !!ev.now.keyEcho;
    case 'dupe': return ev.squashedDuplicate;
    case 'mixed': return ev.format.mixed;
    case 'thin': return doc.eventsTotal < SAMPLE_EXTEND_FLOOR_HINT;
    case 'shadowed': return !!doc.realSample;
    case 'probe': return !!doc.probe;
    // Only the ones with something new to look at: a deferral whose sample came back
    // unchanged is not a row that has become reviewable.
    case 'deferred': return !!doc.deferred && !doc.deferred.sameContent;
  }
}

const TIER_TONE: Record<SampleEvidence, string> = {
  'parser-verified': 'ok',
  'format-declared': 'ok',
  'structure-only': 'warn',
  none: 'warn',
};

/**
 * The verdict pill names the EVIDENCE, not just the verdict.
 *
 * "✓ pass · structure" reads as a pass; "structure only — format unproven" reads as
 * what it is. A failed check still shows as a failure, because that one IS a verdict.
 */
const verdictPill = (v: Verdict, method: string, tier?: SampleEvidence) => {
  if (v === 'fail') return <span className="sl-pill sl-bad">✗ failed · {method}</span>;
  const t = tier || 'none';
  const mark = t === 'parser-verified' ? '✓' : t === 'format-declared' ? '✓' : '?';
  return <span className={`sl-pill sl-${TIER_TONE[t]}`}>{mark} {sampleEvidenceLabel(t)}</span>;
};

/** One log line per key, so a bulk action that partly failed reads as partly failed. */
function describeResults(action: string, results: SampleActionResult[]): string[] {
  return results.map(r => r.ok
    ? `${action} ${r.key}${r.removedFromLibrary ? ' (removed from the committed library)' : ''}`
    : `REFUSED ${r.key} — ${r.reason || 'no reason given'}`);
}

export function SampleLibraryModal({
  open, onClose, runMode, hasToken, repo, onOpenSettings, embedded, view,
}: {
  open: boolean;
  onClose: () => void;
  runMode: 'iframe' | 'standalone' | 'backend';
  hasToken: boolean;
  repo: string;
  onOpenSettings: () => void;
  /** Rendered inside the Samples page, which owns the tabs: `view` picks the one shown. */
  embedded?: boolean;
  view?: 'sanitised' | 'staged' | 'library';
}) {
  /**
   * Sanitising is browser-only work, so it is the one tab that exists in BOTH run modes —
   * which is why an install inside Cribl can open this screen at all. The two review tabs
   * read directories on disk and stay standalone; they explain that rather than being
   * hidden, so the screen is never silently half a feature (Hard Rule 18).
   */
  const [ownTab, setTab] = useState<'sanitised' | 'staged' | 'library'>(
    runMode === 'standalone' ? 'staged' : 'sanitised',
  );
  const tab = embedded && view ? view : ownTab;
  const [sanitizeOpen, setSanitizeOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [state, setState] = useState<SampleLibraryState | null>(null);
  const [sanitisedState, setSanitisedState] = useState<SanitisedSampleLibraryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState('');
  const [onlyUnparsed, setOnlyUnparsed] = useState(false);
  const [verdictText, setVerdictText] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const downloadSanitised = useCallback(async (key: string, format: 'log' | 'json') => {
    setBusy(`preparing ${key}…`);
    try {
      const sample = await fetchSanitisedSample(key);
      if (!sample) throw new Error('Sample document was not found.');
      const payload = downloadSanitisedSamplePayload(sample, format);
      const url = URL.createObjectURL(new Blob([payload.body], { type: payload.mime }));
      const link = document.createElement('a');
      link.href = url;
      link.download = payload.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setLog(lines => [`download failed — ${error instanceof Error ? error.message : String(error)}`, ...lines]);
    } finally {
      setBusy('');
    }
  }, []);

  // Memoized on the loaded state, not derived inline: a fresh `[]` (or a fresh
  // `state.staged` reference) on every render would re-run the evidence pass over the
  // whole queue — ~100 verifier calls — on every keystroke in the verdict box.
  const staged = useMemo(() => state?.staged || [], [state]);
  const library = useMemo(() => state?.library || [], [state]);
  // Writing is a disk write through the standalone backend — that, and only that, is
  // what gates the buttons. A GitHub token is about SHARING the result and is advised
  // separately below; gating promote on it would block a working local review.
  const canWrite = runMode === 'standalone' && !!state?.available;

  const reload = useCallback(async () => {
    setLoading(true);
    const [next, sanitised] = await Promise.all([fetchSampleLibrary(), fetchSanitisedSamples()]);
    setState(next);
    setSanitisedState(sanitised);
    setLoading(false);
    // In the iframe there IS no staging directory, so its absence is not a failure and
    // does not belong in the action log — the review tabs say it in place instead. A
    // logged error here read as something having gone wrong on a screen that was working.
    if (!next.available && runMode !== 'iframe' && (next.error || next.unavailableReason)) {
      setLog(l => [`could not read the sample library — ${next.unavailableReason || next.error}`, ...l]);
    }
    return next;
  }, [runMode]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  // One live evidence pass per staged doc, memoized on the loaded list.
  const evidence = useMemo(() => {
    const dupes = squashedDuplicateKeys(staged);
    return new Map(staged.map(d => [d.key, evidenceFor(d, dupes.has(d.key))]));
  }, [staged]);
  // Volume-ranked, biggest first. The backend sorts the same way, but the order is
  // re-asserted here so it holds however the list arrived — an alphabetical queue is
  // reviewed in an order uncorrelated with what the review is worth, and that is how
  // `aemcdn` (1 event in the census) came to sit above `cisco:estreamer:data:firewall`
  // (52.9M). A key with no census entry is UNKNOWN, not zero, and sorts last.
  const rows = useMemo(
    () => staged.filter(d => matchesFilter(d, evidence.get(d.key)!, filter))
      .sort((a, b) => (evidence.get(b.key)!.volume ?? -1) - (evidence.get(a.key)!.volume ?? -1)
        || a.key.localeCompare(b.key)),
    [staged, evidence, filter],
  );
  const counts = useMemo(() => {
    const c = {} as Record<Filter, number>;
    for (const f of FILTERS) c[f.id] = staged.filter(d => matchesFilter(d, evidence.get(d.key)!, f.id)).length;
    return c;
  }, [staged, evidence]);

  const doc = staged.find(d => d.key === selected) || rows[0] || null;
  const ev = doc ? evidence.get(doc.key)! : null;
  const parsedLine = useMemo(
    () => (doc && ev ? parsedLinesFor(doc, ev.now.method) : []),
    [doc, ev],
  );

  const promote = useCallback(async (keys: string[], force = false) => {
    if (!keys.length) return;
    setBusy(`promoting ${keys.length} sample(s)…`);
    const { results, error } = await promoteStagedSamples(keys, force);
    setBusy('');
    if (error) { setLog(l => [`promote failed — ${error}`, ...l]); return; }
    setLog(l => [...describeResults('promoted', results).reverse(), ...l]);
    // A refusal because verification failed is recoverable with force, so say so
    // rather than leaving the reviewer to guess why nothing happened.
    const forceable = results.filter(r => !r.ok && /verification failed/.test(r.reason || ''));
    if (forceable.length && !force) {
      setLog(l => [`${forceable.length} refused on a failed verification — use "Promote anyway" if you have confirmed the format yourself`, ...l]);
    }
    await reload();
  }, [reload]);

  const reject = useCallback(async (keys: string[], reasons: Record<string, string> = {}) => {
    if (!keys.length) return;
    setBusy(`rejecting ${keys.length} sample(s)…`);
    const { results, error } = await rejectSamples(keys, reasons);
    setBusy('');
    if (error) { setLog(l => [`reject failed — ${error}`, ...l]); return; }
    setLog(l => [...describeResults('rejected + blacklisted', results).reverse(), ...l]);
    await reload();
  }, [reload]);

  /**
   * Remove from staging without touching the blacklist.
   *
   * Two uses, same write: the per-row "Remove from queue" for a sample a reviewer does
   * not want to rule on, and the bulk delete of the probe artifacts. Neither is a
   * verdict about the content — staging is a cache, so the only thing lost is one
   * generated file, and nothing stops the same sample being staged again later. That is
   * exactly what makes it the safe way out of an undecided row: `reject` would blacklist
   * the content permanently and stop the next generation producing it at all.
   */
  const discard = useCallback(async (keys: string[]) => {
    if (!keys.length) return;
    setBusy(`deleting ${keys.length} staged file(s)…`);
    const { results, error } = await discardStagedSamples(keys);
    setBusy('');
    if (error) { setLog(l => [`delete failed — ${error}`, ...l]); return; }
    setLog(l => [...describeResults('removed from the queue (not blacklisted)', results).reverse(), ...l]);
    await reload();
  }, [reload]);

  // Keyboard review: ~100 rows, so stepping through them must not need the mouse.
  useEffect(() => {
    if (!open || tab !== 'staged') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const i = rows.findIndex(r => r.key === (doc?.key || ''));
      if (e.key === 'j' && i < rows.length - 1) setSelected(rows[i + 1].key);
      if (e.key === 'k' && i > 0) setSelected(rows[i - 1].key);
      if (e.key === 'p' && doc && canWrite && !busy) void promote([doc.key]);
      if (e.key === 'r' && doc && canWrite && !busy) void reject([doc.key]);
      // Removal is deliberately NOT bound to a key: j/k paging means a stray keystroke
      // would delete the row under the cursor, and unlike promote/reject there would be
      // no dialog to catch it.
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, tab, rows, doc, canWrite, busy, promote, reject]);

  /**
   * Markdown review report — how a human or an external knowledge tool (Glean, a vendor
   * doc, the customer running the product) answers the question the app cannot. Built
   * from the LIVE evidence, and it carries the rules the answer has to follow.
   */
  const buildReport = useCallback((scope: 'one' | 'filtered' | 'all'): { text: string; name: string; count: number } => {
    const picked = scope === 'one' ? (doc ? [doc] : []) : scope === 'filtered' ? rows : staged;
    const samples: ReviewSample[] = picked.map(d => {
      const e = evidence.get(d.key)!;
      return {
        key: d.key,
        sourcetype: d.sourcetype,
        product: e.product.label,
        productKnown: e.product.known,
        events: d.events,
        eventsTotal: d.eventsTotal,
        formatLabel: e.format.label,
        mixed: e.format.mixed,
        variantsPresent: e.variantsPresent,
        variantsPossible: e.variantsPossible,
        verifiedNow: e.now,
        storedVerification: { ...d.verification, buildNumber: d.provenance.buildNumber },
        provenance: d.provenance,
        fingerprint: d.fingerprint,
        flags: e.flags,
        realSample: d.realSample || null,
      };
    });
    const generatedAt = new Date().toISOString();
    const build = typeof BUILD_NUMBER === 'number' ? BUILD_NUMBER : 0;
    const scopeWords = scope === 'one' ? `1 sample (${doc?.key})`
      : scope === 'filtered' ? `${samples.length} sample(s) matching "${FILTERS.find(f => f.id === filter)?.label}"`
        : `${samples.length} sample(s), whole staging queue`;
    return {
      text: renderSampleReviewMarkdown(samples, {
        buildNumber: build, generatedAt, scope: scopeWords,
        stagedTotal: staged.length, repo, maxEvents: REPORT_MAX_EVENTS,
      }),
      name: sampleReviewFilename(build, generatedAt),
      count: samples.length,
    };
  }, [doc, rows, staged, evidence, filter, repo]);

  function downloadReport(scope: 'one' | 'filtered' | 'all') {
    const { text, name, count } = buildReport(scope);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setLog(l => [`wrote ${name} — ${count} sample(s), ${text.length} chars`, ...l]);
  }

  function copyReport(scope: 'one' | 'filtered' | 'all') {
    const { text, count } = buildReport(scope);
    void navigator.clipboard?.writeText(text).then(
      () => setLog(l => [`copied a review report for ${count} sample(s) to the clipboard`, ...l]),
      () => setLog(l => ['clipboard was refused by the browser — use Download instead', ...l]),
    );
  }

  /**
   * A returned review, read back.
   *
   * Keys are matched against what actually exists — never fuzzy-matched. A verdict for
   * a key we do not have is reported as unmatched, because the alternative (guessing
   * which sample was meant) would promote or blacklist the wrong events.
   */
  const plan = useMemo(() => {
    if (!verdictText.trim()) return null;
    const parsed = parseVerdictBlock(verdictText);
    const known = new Set([...staged.map(d => d.key), ...library.map(l => l.key)]);
    const keep = parsed.verdicts.filter(v => v.action === 'keep' && known.has(v.key));
    const drop = parsed.verdicts.filter(v => v.action === 'reject' && known.has(v.key));
    const unknown = parsed.verdicts.filter(v => !known.has(v.key));
    return { ...parsed, keep, drop, unknown };
  }, [verdictText, staged, library]);

  async function applyPlan() {
    if (!plan) return;
    const reasons: Record<string, string> = {};
    for (const v of plan.drop) reasons[v.key] = v.reason;
    if (plan.drop.length && !window.confirm(
      `Reject ${plan.drop.length} sample(s) and blacklist their content fingerprints?`
      + ` They cannot be re-promoted, and the same events cannot be generated back in.`)) return;
    if (plan.drop.length) await reject(plan.drop.map(v => v.key), reasons);
    if (plan.keep.length) await promote(plan.keep.map(v => v.key));
    setLog(l => [`applied a returned review: ${plan.keep.length} keep, ${plan.drop.length} reject`
      + `${plan.unknown.length ? `, ${plan.unknown.length} key(s) not found` : ''}`
      + `${plan.skipped.length ? `, ${plan.skipped.length} line(s) unreadable` : ''}`, ...l]);
    setVerdictText('');
  }

  async function bulk(f: Filter, action: 'promote' | 'reject') {
    const keys = staged.filter(d => matchesFilter(d, evidence.get(d.key)!, f)).map(d => d.key);
    if (!keys.length) { setLog(l => [`nothing matches "${f}" in the staging queue`, ...l]); return; }
    if (action === 'reject' && !window.confirm(
      `Reject ${keys.length} sample(s) matching "${f}" and blacklist their content fingerprints?`)) return;
    if (action === 'promote') await promote(keys);
    else await reject(keys, Object.fromEntries(keys.map(k => [k, `bulk reject: ${f}`])));
  }

  if (!open) return null;

  const unavailable = state && !state.available;

  return (
    <>
    <div className={embedded ? 'tp-embed' : 'modal-backdrop'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'tp-embed-panel sample-lib-embed' : 'modal-panel sample-lib-modal'} onClick={e => e.stopPropagation()}>
        {!embedded && (
        <div className="modal-header">
          <h3>Sample Library</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        )}

        <div className="modal-body">
          {/* Busy/loading sits ABOVE the tables — a spinner below a long list is a
              spinner nobody sees. */}
          {(loading || busy) && (
            <div className="sl-busy">{busy || 'reading the staging queue and the committed library…'}</div>
          )}

          {/* The way in. Sits above the review queue because it is the only thing on this
              screen that starts with the user's own data rather than with something the
              app generated earlier. */}
          {(!embedded || tab === 'sanitised') && (
          <div className="sl-sanitize-cta">
            <span aria-hidden="true">🧼</span>
            <div>
              <b>Sanitize a sample</b> — take real events from a file, a paste or a worker group, replace the
              identities locally, and keep the result as a validated sample.
              <div className="sl-sanitize-sub">Runs in your browser · available in Cribl and on localhost</div>
            </div>
            <button className="btn-primary" onClick={() => setSanitizeOpen(true)}>Sanitize a sample</button>
          </div>
          )}

          {/* Scoped to the review tabs: an unreadable staging directory says nothing about
              whether sanitising works, and gating the whole screen on it is what kept this
              feature out of the iframe. */}
          {unavailable && tab !== 'sanitised' && (
            <div className="sl-gate">
              <div>
                <b>{runMode === 'iframe' ? 'Review runs on localhost only' : 'Could not read the sample library'}</b>
                <p>{runMode === 'iframe'
                  ? 'The staging queue and the committed library are directories in the repo, which only a local dev server can read. Sanitising does not need them.'
                  : (state?.unavailableReason || state?.error || 'unknown error')}</p>
              </div>
              {runMode !== 'iframe' && <button className="btn-secondary" onClick={() => void reload()}>Retry</button>}
            </div>
          )}

          {/* Advisory, not a gate: promoting writes the local repo, and a commit is what
              publishes it. Worth saying once, because a promoted sample nobody commits
              helps only this machine. */}
          {!unavailable && !hasToken && runMode === 'standalone' && (!embedded || tab !== 'sanitised') && (
            <div className="sl-note">
              <span>Promoting writes <code>config/ai-samples/</code> on this machine. It reaches
              {' '}<code>{repo || 'the shared repo'}</code> when the change is committed — set up the shared
              sample pool under Sharing if you also want the shared-library flow.</span>
              <button className="btn-secondary sl-small" onClick={onOpenSettings}>Open Sharing</button>
            </div>
          )}

          {/* "Staged" is the reviewable count; probes are named separately rather than
              folded in, because a queue of 90 that is really 34 misstates the work. */}
          {/* Rendered, not `hidden`: .sl-summary sets display:flex, which beats the
              hidden attribute's UA rule — the row stayed visible in the iframe showing a
              row of zeroes that read as an empty library rather than an unread one. */}
          {!unavailable && (!embedded || tab !== 'sanitised') && (
          <div className="sl-summary">
            <span><strong>{staged.length - (counts.probe ?? 0)}</strong> to review</span>
            {!!counts.probe && <span className="sl-summary-bad"><strong>{counts.probe}</strong> test artifacts</span>}
            <span><strong>{library.length}</strong> committed</span>
            <span><strong>{state?.rejectedCount ?? 0}</strong> blacklisted</span>
            <span><strong>{counts.verified ?? 0}</strong> parser-verified</span>
            <span><strong>{counts.shadowed ?? 0}</strong> shadowed by a real log</span>
            <span className="sl-repo">{repo || 'no repo configured'}</span>
          </div>
          )}

          {!embedded && (
          <div className="sl-tabs">
            <button className={tab === 'sanitised' ? 'active' : ''} onClick={() => setTab('sanitised')}>
              Sanitised samples ({sanitisedState?.samples.length || 0})
            </button>
            <button className={tab === 'staged' ? 'active' : ''} onClick={() => setTab('staged')}>
              Staged for review ({staged.length})
            </button>
            <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
              Committed library ({library.length})
            </button>
          </div>
          )}

          {/* Its own store, kept apart from the generated samples: these are real customer
              events with the identities swapped and a parser check behind them, and the
              two kinds answer different questions about trust. */}
          {tab === 'sanitised' && (
            <>
              <p className="step-desc">
                Samples you sanitised here, verified against the source's own parser. They are real vendor
                data with the identities replaced, so they outrank anything a model wrote — and unlike the
                review queue, they exist in both run modes.
              </p>
              {!sanitisedState?.samples.length ? <p className="dt-empty">
                Nothing sanitised yet. <b>Sanitize a sample</b> above walks through it: choose events,
                confirm what they are, review the replacements, then pick where the result goes.
              </p> : <div className="sl-sanitised-list">
                {sanitisedState.samples.map(sample => <div className="sl-library-row" key={sample.key}>
                  <div>
                    <b>{sample.key}</b>
                    <small>{sample.events} events · {sample.verdict} via {sample.method} · sanitised {new Date(sample.sanitisedAt).toLocaleString()}</small>
                  </div>
                  <div className="sl-row-actions">
                  <button className="btn-secondary" disabled={!!busy} onClick={() => { void downloadSanitised(sample.key, 'log'); }}>.log</button>
                  <button className="btn-secondary" disabled={!!busy} onClick={() => { void downloadSanitised(sample.key, 'json'); }}>Evidence JSON</button>
                  <button className="btn-secondary" disabled={!!busy} onClick={() => {
                    setBusy(`removing ${sample.key}…`);
                    void deleteSanitisedSample(sample.key).then(result => {
                      if (!result.ok) setLog(lines => [`remove failed — ${result.error}`, ...lines]);
                      else if (result.warning) setLog(lines => [`removed ${sample.key}, but — ${result.warning}`, ...lines]);
                      return reload();
                    }).finally(() => setBusy(''));
                  }}>Remove</button></div>
                </div>)}
              </div>}
            </>
          )}

          {tab === 'staged' && (
            <>
              <div className="sl-filters">
                {FILTERS.map(f => (
                  <button key={f.id} className={`sl-chip ${f.tone ? `sl-chip-${f.tone}` : ''} ${filter === f.id ? 'active' : ''}`}
                    onClick={() => setFilter(f.id)}>
                    {f.label} <b>{counts[f.id] ?? 0}</b>
                  </button>
                ))}
              </div>

              <div className="sl-bulk">
                <span className="sl-bulk-label">Triage:</span>
                <button className="btn-secondary" disabled={!canWrite || !!busy || !counts.verified}
                  onClick={() => void bulk('verified', 'promote')}>
                  Promote parser-verified ({counts.verified ?? 0})
                </button>
                <button className="btn-secondary sl-danger" disabled={!canWrite || !!busy || !counts.shadowed}
                  onClick={() => void bulk('shadowed', 'reject')}
                  title="A real vendor log outranks a generated sample permanently, so these can never be served">
                  Reject shadowed ({counts.shadowed ?? 0})
                </button>
                <button className="btn-secondary sl-danger" disabled={!canWrite || !!busy || !counts.keyecho}
                  onClick={() => void bulk('keyecho', 'reject')}
                  title="The events name their own Splunk sourcetype in a position the wire format owns — written from the key, not from the vendor's format">
                  Reject sourcetype-echo ({counts.keyecho ?? 0})
                </button>
                <button className="btn-secondary sl-danger" disabled={!canWrite || !!busy || !counts.mixed}
                  onClick={() => void bulk('mixed', 'reject')}>
                  Reject mixed-format ({counts.mixed ?? 0})
                </button>
                {/* DELETED, not rejected: these files were never samples, so blacklisting
                    their content would fill the "events we have judged" store with events
                    nobody generated. */}
                <button className="btn-secondary sl-danger" disabled={!canWrite || !!busy || !counts.probe}
                  onClick={() => {
                    const keys = staged.filter(d => d.probe).map(d => d.key);
                    if (window.confirm(`Delete ${keys.length} test artifact(s) from the staging queue?`
                      + ` They are not blacklisted — they were never samples.`)) void discard(keys);
                  }}
                  title="conc_probe_* files come from the concurrency test, not from a build — deleted outright, not blacklisted">
                  Delete test artifacts ({counts.probe ?? 0})
                </button>
                <button className="btn-secondary" disabled
                  title="Not built — would re-generate each thin sample up to the extend floor">
                  Regenerate thin ({counts.thin ?? 0})
                </button>
              </div>

              {/* Export for outside review. Nothing here writes anything, so it is NOT
                  gated — a reviewer without write access can still be the one who
                  answers "is this the real vendor format?". */}
              <div className="sl-bulk sl-report-bar">
                <span className="sl-bulk-label">Review report (.md):</span>
                <button className="btn-secondary" onClick={() => downloadReport('one')} disabled={!doc}>
                  This sample
                </button>
                <button className="btn-secondary" onClick={() => downloadReport('filtered')} disabled={!rows.length}>
                  Current filter ({rows.length})
                </button>
                <button className="btn-secondary" onClick={() => downloadReport('all')} disabled={!staged.length}>
                  All staged ({staged.length})
                </button>
                <button className="btn-secondary" onClick={() => copyReport('filtered')} disabled={!rows.length}
                  title="Copy the same Markdown to the clipboard — paste it into Glean, a ticket, or a mail to the product owner">
                  Copy
                </button>
                <span className="field-hint">events verbatim + the evidence, so a human or Glean can confirm the vendor format</span>
              </div>

              <details className="sl-verdicts">
                <summary>Apply a returned review ({plan ? plan.verdicts.length : 0} verdict(s) read)</summary>
                <p className="field-hint">
                  Paste the <code>## Verdicts</code> block from a reviewed report — or the whole report. Lines read as
                  <code> key: keep|reject — reason</code>; a line still holding the literal template, or naming both
                  words, is skipped rather than guessed. Reject reasons are stored with the blacklisted fingerprint.
                </p>
                <textarea className="sl-verdict-box" rows={6} value={verdictText} spellCheck={false}
                  placeholder={'vmware_nsx: reject — contradicted: NSX emits comp/subcomp in the SD, not level\nvcenter_syslog: keep — matches the vpxd example in VMware KB 2003322'}
                  onChange={e => setVerdictText(e.target.value)} />
                {plan && (
                  <div className="sl-plan">
                    <div><b>{plan.keep.length}</b> to promote{plan.keep.length ? `: ${plan.keep.map(v => v.key).join(', ')}` : ''}</div>
                    <div><b>{plan.drop.length}</b> to reject{plan.drop.length ? `: ${plan.drop.map(v => v.key).join(', ')}` : ''}</div>
                    {plan.unknown.length > 0 && (
                      <div className="sl-plan-warn">
                        <b>{plan.unknown.length}</b> key(s) not in staging or the library, so not acted on:
                        {' '}{plan.unknown.map(v => v.key).join(', ')}
                      </div>
                    )}
                    {plan.skipped.length > 0 && (
                      <div className="sl-plan-warn">
                        <b>{plan.skipped.length}</b> line(s) not read:
                        <ul>{plan.skipped.map((s, i) => <li key={i}><code>{s.line}</code> — {s.why}</li>)}</ul>
                      </div>
                    )}
                    <button className="btn-primary" disabled={!canWrite || !!busy || (!plan.keep.length && !plan.drop.length)}
                      onClick={() => void applyPlan()}>
                      Apply {plan.keep.length + plan.drop.length} verdict(s)
                    </button>
                  </div>
                )}
              </details>

              <div className="sl-split">
                <div className="sl-list">
                  {!loading && rows.length === 0 && (
                    <p className="dt-empty">{staged.length
                      ? 'No staged sample matches this filter.'
                      : 'Nothing is staged — generated samples appear here as builds create them.'}</p>
                  )}
                  {rows.map(d => {
                    const e = evidence.get(d.key)!;
                    const strong = e.tier === 'parser-verified' && e.now.verdict === 'pass';
                    return (
                      <button key={d.key} className={`sl-row ${doc?.key === d.key ? 'active' : ''}`} onClick={() => setSelected(d.key)}>
                        <span className="sl-row-key">{d.key}</span>
                        <span className="sl-row-meta">
                          <span className={`sl-dot ${e.now.verdict === 'fail' ? 'sl-bad' : strong ? 'sl-ok' : e.tier === 'none' ? 'sl-warn' : 'sl-mid'}`} />
                          {/* Volume first: it is why this row is where it is in the list. */}
                          <span className="sl-vol" title={typeof e.volume === 'number'
                            ? `${e.volume.toLocaleString()} events in the customer census`
                            : 'not in the customer census — ordering unknown, NOT unimportant'}>
                            {formatVolume(e.volume)}
                          </span>
                          {d.eventsTotal} ev · {e.format.label}
                          {e.flags.map(f => <span key={f} className="sl-flag">{f}</span>)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="sl-detail">
                  {!doc && <p className="dt-empty">Select a sample.</p>}
                  {doc && ev && (
                    <>
                      <div className="sl-detail-head">
                        <h4>{doc.key}</h4>
                        {verdictPill(ev.now.verdict as Verdict, ev.now.method, ev.tier)}
                      </div>

                      <div className="sl-evidence">
                        <div><span>What this source is</span><b>{ev.product.known ? ev.product.label : '⚠️ unidentified'}</b></div>
                        <div><span>Wire format</span><b>{ev.format.label}</b></div>
                        <div><span>Evidence</span><b>{sampleEvidenceLabel(ev.tier)}</b></div>
                        {/* Why this row is worth (or not worth) the reviewer's time. Never a
                            reason to skip a source — a 1-event sourcetype is still real. */}
                        <div><span>Customer volume</span><b>{typeof ev.volume === 'number'
                          ? `${ev.volume.toLocaleString()} events`
                          : 'not in the census'}</b></div>
                        <div><span>Parser check, now</span><b>{ev.now.method === 'none'
                          ? 'not checked — no parser'
                          : `${ev.now.eventsParsed}/${ev.now.eventsChecked} lines · ${ev.now.method}`}</b></div>
                        <div><span>Stored at generation</span><b>{doc.verification.verdict} · {doc.verification.method}</b></div>
                        <div><span>Events</span><b>{doc.eventsTotal}{doc.eventsTotal < SAMPLE_EXTEND_FLOOR_HINT ? ` (below the ${SAMPLE_EXTEND_FLOOR_HINT} floor)` : ''}</b></div>
                        <div><span>Fields extracted</span><b>{ev.now.fields.length}</b></div>
                        <div><span>Model</span><b>{doc.provenance.model.replace('us.anthropic.', '')}</b></div>
                        <div><span>Generated</span><b>build {doc.provenance.buildNumber} · {(doc.provenance.generatedAt || '').slice(0, 10) || 'unknown'}</b></div>
                        <div><span>Fingerprint</span><b><code>{doc.fingerprint}</code></b></div>
                        <div><span>Real sample exists</span><b>{doc.realSample
                          ? `yes — ${doc.realSample.tier} (${doc.realSample.events} events) outranks this`
                          : 'no — this one would be served'}</b></div>
                        {ev.variantsPossible.length > 1 && (
                          <div><span>Format variants</span><b>{ev.variantsPresent.join(', ') || 'none recognized'} of {ev.variantsPossible.join('/')}</b></div>
                        )}
                      </div>

                      {/* The decisive fact for this row, when it applies: a generated sample
                          for a source that already has a real log is dead weight, whatever
                          its quality. Say so instead of asking for research. */}
                      {/* The one finding that settles a row on its own: the events name
                          their own Splunk sourcetype in a position the wire format owns.
                          No vendor ships that, so the model wrote from the key. */}
                      {ev.now.keyEcho && (
                        <div className="sl-drift sl-fabricated">
                          <b>Written from the key, not from the format.</b> <code>{ev.now.keyEcho.form}</code> appears
                          {' '}{ev.now.keyEcho.position === 'syslog-program' ? 'as the syslog program name'
                            : ev.now.keyEcho.position === 'field-name' ? 'as a field name' : 'as a field value'} on
                          {' '}{ev.now.keyEcho.lines} of {ev.now.keyEcho.checked} events — e.g.
                          {' '}<code>…{ev.now.keyEcho.excerpt}…</code>. A Splunk sourcetype is our label for the data,
                          not something the product emits, so these events match nothing in production — <b>reject</b>.
                        </div>
                      )}

                      {/* Redundant, not wrong — so this one is DELETED rather than
                          blacklisted: the same events under the separated key spelling
                          may well be fine, and a content blacklist would poison both. */}
                      {ev.squashedDuplicate && (
                        <div className="sl-drift">
                          <code>{doc.sourcetype}</code> is the separator-less spelling of a sourcetype already staged
                          under its separated name. Both were generated from the same source, so one of them is duplicate
                          review work — <b>delete this one</b> (not blacklist: the events are redundant, not wrong).
                        </div>
                      )}

                      {doc.realSample && (
                        <div className="sl-drift">
                          A real <b>{doc.realSample.tier}</b> log ({doc.realSample.events} events) already exists for
                          {' '}<code>{doc.sourcetype}</code>. Real logs outrank generated ones in the sample ladder, so
                          these events can never be served — <b>no review needed, reject</b>.
                        </div>
                      )}

                      {/* The payoff of deferring rather than deleting: the earlier
                          reviewer's question arrives with the sample that might answer
                          it, and whether the content actually changed decides whether
                          there is anything new to judge. */}
                      {doc.deferred && (
                        <div className="sl-drift">
                          Deferred on <b>{doc.deferred.deferredAt}</b>
                          {doc.deferred.times > 1 ? ` (${doc.deferred.times} times)` : ''} with this question
                          unresolved: <b>{doc.deferred.reason}</b>
                          {doc.deferred.sameContent ? (
                            <> — and these are the <b>same events</b> you deferred, so the generator has not produced
                              anything new. Nothing has changed for the better; deferring again only repeats the loop.</>
                          ) : (
                            <> — but the content is <b>new</b> since then, so this is the fresh sample that deferral was
                              waiting for. Previously: <code>{doc.deferred.firstEvent}</code></>
                          )}
                        </div>
                      )}

                      {/* The stored verdict was made by an older build; parsers move under
                          it. Drift is worth its own line — it is the difference between a
                          claim and a measurement. */}
                      {(ev.now.verdict !== doc.verification.verdict || ev.now.method !== doc.verification.method) && (
                        <div className="sl-drift">
                          Re-checked on this build the verdict changed: stored <code>{doc.verification.verdict} / {doc.verification.method}</code>
                          {' → '}now <code>{ev.now.verdict} / {ev.now.method}</code>. The measurement above is the current one.
                        </div>
                      )}

                      {ev.tier === 'none' && (
                        <div className="sl-unverified">
                          <b>Nothing in the app has verified these lines.</b> There is no parser for this source, so the
                          format, the field names and the values are all unconfirmed — this is exactly the case the
                          Markdown report exists for: send it to someone (or something) that knows the product.
                        </div>
                      )}

                      {/* The tier that most needs saying out loud. A structural pass is a
                          pass of the WEAKEST check we have, and the screen used to render
                          it identically to a parser-verified one. */}
                      {ev.tier === 'structure-only' && (
                        <div className="sl-unverified">
                          <b>This "pass" proves only that the events are well-formed data.</b> We have no parser and no
                          declared wire format for <code>{doc.sourcetype}</code>, so the check that ran counted distinct
                          keys — it says nothing about whether these field names, values or framing are what the product
                          really emits. A fabricated sample passes this check easily. Confirm the format outside the app
                          (the Markdown report below) before promoting.
                        </div>
                      )}

                      {ev.now.reasons.length > 0 && (
                        <ul className="sl-reasons">
                          {ev.now.reasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      )}

                      {ev.now.fields.length > 0 && (
                        <div className="sl-fields">
                          {ev.now.fields.map(f => <code key={f} className="dt-chip">{f}</code>)}
                        </div>
                      )}

                      {doc.provenance.grounding && (
                        <details className="sl-grounding">
                          <summary>Grounding the model was given</summary>
                          <pre>{doc.provenance.grounding}</pre>
                        </details>
                      )}

                      <div className="sl-events-head">
                        <b>Events</b>
                        {/* The screen shows the sample WHOLE — judging a wire format means
                            reading the lines, so the box scrolls instead of the list being
                            cut short. Only the .md report caps (at REPORT_MAX_EVENTS). */}
                        <span className="field-hint">
                          all {doc.events.length} event{doc.events.length === 1 ? '' : 's'}, scroll to read
                          {doc.events.length > REPORT_MAX_EVENTS && ` · the .md report shows the first ${REPORT_MAX_EVENTS}`}
                        </span>
                        <label className="sl-sim">
                          <input type="checkbox" checked={onlyUnparsed} onChange={e => setOnlyUnparsed(e.target.checked)} />
                          only lines the parser could not read
                        </label>
                      </div>
                      <div className="sl-events">
                        {doc.events.map((line, i) => {
                          // Marked per LINE by the real parser (`null` = nothing could run),
                          // so a single bad line in an otherwise good sample is visible.
                          const parsed = parsedLine[i];
                          if (onlyUnparsed && parsed !== false) return null;
                          return (
                            <div key={i} className={`sl-ev ${parsed === false ? 'sl-ev-bad' : ''}`}>
                              <span className="sl-ev-n">{i + 1}</span>
                              <span className="sl-ev-mark">{parsed === null ? '–' : parsed ? '✓' : '✗'}</span>
                              <code>{line}</code>
                            </div>
                          );
                        })}
                      </div>

                      <div className="sl-actions">
                        <button className="btn-primary" disabled={!canWrite || !!busy} onClick={() => void promote([doc.key])}>
                          Promote to library
                        </button>
                        {/* Only offered where it applies: promotePending refuses a FAILED
                            verification, and force is the reviewer saying they checked the
                            format themselves. It is not an override for a rejected
                            fingerprint — that refusal stands. */}
                        {ev.now.verdict === 'fail' && (
                          <button className="btn-secondary" disabled={!canWrite || !!busy}
                            onClick={() => void promote([doc.key], true)}
                            title="Promote despite the failed parser check — only if you have confirmed the vendor format yourself">
                            Promote anyway
                          </button>
                        )}
                        {/* The third verdict, and the one for an undecided row. Sits before
                            Reject deliberately: the blacklist is permanent, so the
                            reversible option is the easier one to reach. No confirm and no
                            prompt — it takes one file out of a cache, decides nothing, and
                            the sample comes back if a later build generates it again. */}
                        <button className="btn-secondary" disabled={!canWrite || !!busy}
                          onClick={() => void discard([doc.key])}
                          title="Take it out of the queue — nothing is blacklisted, so the same sample can be staged and reviewed again later">
                          Remove from queue
                        </button>
                        <button className="btn-secondary sl-danger" disabled={!canWrite || !!busy}
                          onClick={() => { if (window.confirm(`Reject ${doc.key} and blacklist fingerprint ${doc.fingerprint}?`)) void reject([doc.key]); }}>
                          Reject &amp; blacklist
                        </button>
                        <span className="field-hint sl-keys">J / K move · P promote · R reject</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {tab === 'library' && (
            <>
              {/* Sanitised samples are listed here too, labelled, because this is where people
                  look for "the sample library" — the wizard's "saved to the sample library"
                  used to send them here to an empty list (in an installed app the committed
                  library below always is). Managing them stays on the Sanitize tab. */}
              {!!sanitisedState?.samples.length && (
                <>
                  <p className="step-desc">
                    <b>Sanitised samples ({sanitisedState.samples.length})</b> — real events you sanitised, with the
                    identities replaced. Remove or re-sanitise them on the <b>Sanitize</b> tab.
                  </p>
                  <div className="sl-sanitised-list">
                    {sanitisedState.samples.map(sample => <div className="sl-library-row" key={`sanitised-${sample.key}`}>
                      <div>
                        <span className="sl-pill sl-ok">Sanitised</span> <b>{sample.key}</b>
                        <small>{sample.events} events · {sample.verdict} via {sample.method} · sanitised {new Date(sample.sanitisedAt).toLocaleString()}</small>
                      </div>
                      <div className="sl-row-actions">
                        <button className="btn-secondary" disabled={!!busy} onClick={() => { void downloadSanitised(sample.key, 'log'); }}>.log</button>
                      </div>
                    </div>)}
                  </div>
                </>
              )}
              <p className="step-desc">
                Committed samples live in <code>config/ai-samples/</code> and are tier 4 of the sample ladder — served
                only when no real vendor log exists. Deleting one removes the file <b>and blacklists its content
                fingerprint</b>, so the same events can never be re-promoted; the change still needs a commit to
                reach <code>{repo || 'the shared repo'}</code>.
              </p>
              {!loading && library.length === 0 && <p className="dt-empty">No committed samples — nothing has been promoted yet.</p>}
              {library.length > 0 && (
                <table className="sl-table">
                  <thead>
                    <tr><th>Key</th><th>Events</th><th>Verified</th><th>Fields</th><th>Model / build</th><th>Generated</th><th>Real log</th><th></th></tr>
                  </thead>
                  <tbody>
                    {library.map((c: LibrarySampleEntry) => (
                      <tr key={c.key}>
                        <td><code>{c.key}</code></td>
                        <td>{c.events}</td>
                        {/* Stored verdict + stored method, so the tier is derived from the
                            same two fields the pill has always shown — no live re-check
                            here (that is the staged tab's job). */}
                        <td>{verdictPill(c.verdict, c.method, sampleEvidence({ verdict: c.verdict, method: c.method as never }))}</td>
                        <td>{c.fields}</td>
                        <td>{(c.model || 'unknown').replace('us.anthropic.', '')} · {c.buildNumber ?? '—'}</td>
                        <td>{(c.generatedAt || '').slice(0, 10) || '—'}</td>
                        {/* A real log may have been harvested AFTER this was promoted, which
                            makes the committed file dead weight rather than a mistake. */}
                        <td>{c.realSample ? `${c.realSample.tier} (${c.realSample.events})` : '—'}</td>
                        <td>
                          <button className="btn-secondary sl-danger sl-small" disabled={!canWrite || !!busy}
                            onClick={() => { if (window.confirm(`Delete ${c.key} from the library and blacklist its fingerprint?`)) void reject([c.key]); }}>
                            Delete &amp; blacklist
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {log.length > 0 && (
            <div className="sl-log">
              <b>Action log</b>
              {log.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>

    {/* Sibling of this screen's backdrop, never a child of it: that backdrop closes on
        click, so a wizard nested inside it was dismissed by its own controls.
        Publishing needs a write token AND the standalone backend to spend it, so the
        save step is told both facts rather than inferring one from the other. */}
    <SanitizeWizard
      open={sanitizeOpen}
      onClose={() => setSanitizeOpen(false)}
      runMode={runMode}
      canPublish={runMode === 'standalone' && hasToken}
      repo={repo}
      onOpenSettings={onOpenSettings}
      onLibraryChanged={() => { void reload(); }}
    />
    </>
  );
}
