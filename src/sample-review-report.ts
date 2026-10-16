/**
 * Markdown review report for staged AI-generated samples (build 460).
 *
 * The problem this solves: the app can prove a sample is *machine-readable* (its
 * parser reads it) but it cannot prove the sample is *what the vendor actually
 * emits*. For the ~16% of staged samples with no parser to check against, that
 * judgement needs a human or an external knowledge tool (Glean, a vendor doc, the
 * customer who owns the product). So the panel exports the evidence and the events
 * as one self-contained Markdown file that can be pasted into any of those.
 *
 * Two rules the format obeys, because they decide whether the answer is useful:
 *
 *  1. **The events are verbatim, in a fenced block, never summarized.** A reviewer
 *     judges a log format by looking at the line. Truncating a line or reordering
 *     keys would ask them to review something we don't ship.
 *  2. **Every claim is labelled with how it was checked.** "unverified" must read
 *     as "we could not check this", never as a soft pass — the same rule the
 *     verifier and the scoring lenses follow. A reviewer who thinks the app already
 *     validated the format will rubber-stamp it.
 *
 * The report ends with a paste-back verdict block in a fixed one-line-per-sample
 * grammar (`<key>: keep|reject — reason`), so a reviewer's answer can be read back
 * mechanically instead of re-typed into the UI.
 *
 * Pure and offline: no Date, no fetch, no Node imports (`generatedAt` is passed in,
 * so the output is deterministic and the same function serves both run modes).
 */

export interface ReviewSample {
  /** Library key — `<sourcetype>` or `<sourcetype>::<format>`. */
  key: string;
  sourcetype: string;
  /** What the app knows the source IS, for the reviewer's context — see resolveProductLabel. */
  product?: string;
  /** False when `product` is a "we don't know" placeholder, never a product name. */
  productKnown?: boolean;
  /** Events to show, verbatim. */
  events: string[];
  /** How many events the staged doc really holds (`events` may be capped). */
  eventsTotal: number;
  /** Wire-format label from describeSampleFormat. */
  formatLabel: string;
  /** True when the sample carries more than one wire format — always a defect. */
  mixed?: boolean;
  /** Variants of a multi-format source this sample covers (and the full list). */
  variantsPresent?: string[];
  variantsPossible?: string[];
  /** Verification as re-run against TODAY's parsers. */
  verifiedNow: { verdict: string; method: string; eventsParsed: number; eventsChecked: number; fields: string[]; reasons: string[] };
  /** Verification as stored when the sample was generated, for drift. */
  storedVerification?: { verdict: string; method: string; buildNumber?: number };
  provenance: { model: string; buildNumber: number; generatedAt: string };
  fingerprint: string;
  /** Free-text flags the panel computed (thin, probe artifact, …). */
  flags?: string[];
  /** A REAL vendor log already exists for this source — which makes this one dead weight. */
  realSample?: { tier: string; events: number } | null;
}

export interface ReviewReportOptions {
  buildNumber: number;
  /** ISO timestamp — passed in so the renderer stays pure. */
  generatedAt: string;
  /** What the selection was, in words ("all 98 staged", "filter: unverified"). */
  scope: string;
  /** Total staged, so a partial report never reads as the whole backlog. */
  stagedTotal: number;
  repo?: string;
  /** Events shown per sample. The rest are counted, not hidden silently. */
  maxEvents?: number;
}

/**
 * Ten, matching SAMPLE_EXTEND_FLOOR — the number of events the app itself treats as
 * the minimum usable sample. Below that a reviewer is judging a fragment, and a
 * source that ships several event types (a firewall logging allow/deny/teardown)
 * needs more than a handful of lines before its shape is visible at all.
 *
 * This caps the REPORT only, because a report is something someone reads in a chat
 * window or pastes into a knowledge tool. The review screen itself never caps — it
 * shows every event in the sample, scrollable.
 */
export const REPORT_MAX_EVENTS = 10;
const DEFAULT_MAX_EVENTS = REPORT_MAX_EVENTS;

/**
 * What product is this, in words a reviewer can act on?
 *
 * Measured on the real staging queue: the samples that most need this line are the
 * ones the catalogue knows least about. `describeSourcetype` answers "Unknown source
 * type" for `aemaccess` and "Vmware Nsx" for `vmware_nsx` — the first is not an
 * answer and the second is just the key in title case. Both read like a checked fact
 * and neither helps someone judge whether Adobe Experience Manager emits these lines.
 *
 * So: prefer the product the generator was GROUNDED on (that text is what the model
 * was told to imitate, which is exactly what the reviewer must confirm), fall back to
 * a real catalogue description, and otherwise say plainly that we do not know —
 * `known: false` makes the report ask the reviewer to identify it instead of naming
 * something we invented.
 */
export function resolveProductLabel(input: { sourcetype: string; catalogDescription?: string; grounding?: string }): { label: string; known: boolean } {
  const fromGrounding = /^\s*[-*]?\s*Product:\s*(.+)$/im.exec(input.grounding || '')?.[1]?.trim();
  if (fromGrounding) return { label: fromGrounding, known: true };

  const desc = (input.catalogDescription || '').trim();
  // Reject the two non-answers: the unknown placeholder, and a description that is
  // nothing but the sourcetype key re-cased.
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isEcho = squash(desc) === squash(input.sourcetype);
  if (desc && !/^unknown source type$/i.test(desc) && !isEcho) return { label: desc, known: true };

  return { label: `not in the app's catalogue — sourcetype key \`${input.sourcetype}\``, known: false };
}

/** Fence width that cannot be broken by a log line containing ``` itself. */
function fence(lines: string[]): string {
  const longest = lines.reduce((n, l) => Math.max(n, (l.match(/`+/g) || []).reduce((m, t) => Math.max(m, t.length), 0)), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** `|` inside a log value would split a Markdown table cell. */
const cell = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function verdictWord(v: { verdict: string; method: string }): string {
  if (v.verdict === 'unverified' || v.method === 'none') return 'NOT CHECKED';
  return v.verdict === 'pass' ? 'passed' : v.verdict === 'fail' ? 'FAILED' : v.verdict;
}

/** The one thing we need a human to answer, phrased so it can be answered. */
function question(s: ReviewSample): string {
  const checked = s.verifiedNow.method !== 'none' && s.verifiedNow.verdict !== 'unverified';
  // Nothing to research: a generated sample can never be served for a source that
  // already has a real log, so accuracy is beside the point.
  if (s.realSample) {
    return `**No review needed — reject.** A real ${s.realSample.tier} log (${s.realSample.events} events) already exists`
      + ` for this source, and real logs outrank generated ones in the sample ladder, so these events can never be served.`;
  }
  // A sample carrying two wire formats is unbuildable whatever the vendor emits.
  if (s.mixed) {
    return `**Reject without research.** This sample carries more than one wire format (${s.formatLabel}), and a pack is built`
      + ' around one shape — whichever the vendor emits, no single pipeline reads both. Worth naming which formats you see,'
      + ' because the regeneration has to pick one.';
  }
  // With no product name there is nothing to ask ABOUT — so ask that first.
  if (s.productKnown === false) {
    return `The app cannot say what product \`${s.sourcetype}\` is, so it could not ground the generation on a real`
      + ` format either. **Which product writes this log, and does it emit lines in this exact shape (${s.formatLabel})?**`
      + ' If the key does not correspond to a real product, this sample should be rejected outright.';
  }
  const base = `Does **${s.product || s.sourcetype}** emit log lines in this exact shape (${s.formatLabel})`;
  return checked
    // A parser read it, so the envelope is not in doubt — the field VALUES are.
    ? `${base}, with these field names and value formats?`
    // Nothing checked it, so the whole line is the question.
    : `${base}? We have no parser for this source, so **nothing in the app has verified these lines** — the format, the field names and the values are all unconfirmed.`;
}

export function renderSampleReviewMarkdown(samples: ReviewSample[], opts: ReviewReportOptions): string {
  const max = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const out: string[] = [];

  out.push(`# Sample review — Cribl pack-generator build ${opts.buildNumber}`);
  out.push('');
  out.push(`Generated ${opts.generatedAt} · ${opts.scope} · ${opts.stagedTotal} sample(s) staged in total`
    + (opts.repo ? ` · library repo \`${opts.repo}\`` : ''));
  out.push('');
  out.push('## What this is, and what is being asked');
  out.push('');
  out.push('Every log sample below was **generated by an AI model**, not captured from a real system.'
    + ' They are staged for review and are **not yet part of the sample library** — nothing has shipped.'
    + ' The pack generator falls back to a generated sample only when it holds no real vendor log for a'
    + ' source, and a sample in the wrong wire format silently produces a pipeline that extracts almost'
    + ' nothing, which surfaces much later as a bad pack.');
  out.push('');
  out.push('The app can check whether **its own parser can read** a sample. It cannot check whether the'
    + ' sample is **what the product really emits**. That second question is what this report asks.');
  out.push('');
  out.push('For each sample: read the events, then answer *keep* or *reject*. Reject if any field name,'
    + ' value format, envelope or ordering is not what the named product emits — say which, because a'
    + ' named defect can be fixed on regeneration. **"Looks plausible" is not a keep.**');
  out.push('');
  out.push('Four rules that make the answer usable:');
  out.push('');
  out.push('1. **Keep requires ground truth.** Vendor documentation with a literal example line, or a'
    + ' third-party parser fixture captured from a real appliance (Elastic integrations'
    + ' `_dev/test/pipeline/*.log`, a Splunk TA\'s `props.conf`/`transforms.conf`, a Sentinel ASIM or'
    + ' Google SecOps parser). If you cannot find one, the answer is `reject — ungrounded:`, not keep.'
    + ' **Over-rejection is the intended error** — a wrong sample costs far more than a missing one.');
  out.push('2. **Two kinds of reject, and they need different work from us.** Start the reason with'
    + ' `ungrounded:` when no reference could be found, or `contradicted:` when a reference was found and'
    + ' the sample disagrees with it. The first sends us looking for a real log; the second is'
    + ' regeneration input, so name the defects precisely (wrong key, invented key, missing mandatory'
    + ' key, wrong slot semantics, dropped syslog envelope, mis-escaped delimiter).');
  out.push('3. **Ignore the parser result above.** It only proves our own regex can read the line, which'
    + ' says nothing about authenticity. The *wire format* and *mixed-format* lines are structural facts'
    + ' and can be trusted.');
  out.push('4. **Documentation addresses are deliberate.** `192.0.2.x` / `198.51.100.x` / `203.0.113.x`'
    + ' (RFC 5737) and `example.com` are policy in generated samples, not defects — judge structure,'
    + ' field names and value formats, not the choice of addresses. Constant severities, sequential IDs'
    + ' and one event type repeated *are* worth flagging.');
  out.push('');

  out.push('## Summary');
  out.push('');
  out.push('| # | Sample | Product | Wire format | Events | Parser check (today) | Fields | Flags |');
  out.push('|---|---|---|---|---|---|---|---|');
  samples.forEach((s, i) => {
    const v = s.verifiedNow;
    const check = v.method === 'none' || v.verdict === 'unverified'
      ? 'not checked — no parser'
      : `${verdictWord(v)} (${v.eventsParsed}/${v.eventsChecked} lines, ${v.method})`;
    const product = s.productKnown === false ? '⚠️ unidentified' : cell(s.product || '—');
    out.push(`| ${i + 1} | \`${cell(s.key)}\` | ${product} | ${cell(s.formatLabel)} `
      + `| ${s.eventsTotal} | ${cell(check)} | ${v.fields.length} | ${cell((s.flags || []).join(', ') || '—')} |`);
  });
  out.push('');

  samples.forEach((s, i) => {
    const v = s.verifiedNow;
    const shown = s.events.slice(0, max);
    const f = fence(shown);

    out.push(`## ${i + 1}. \`${s.key}\``);
    out.push('');
    if (s.product) out.push(`- **Product:** ${s.productKnown === false ? `⚠️ ${s.product}` : s.product}`);
    out.push(`- **Wire format:** ${s.formatLabel}${s.mixed ? ' — ⚠️ **this sample mixes more than one format**, which no single pipeline can read' : ''}`);
    if (s.realSample) {
      out.push(`- **⚠️ A real log already exists** for this source (${s.realSample.tier}, ${s.realSample.events} events),`
        + ' which outranks generated samples — so nothing would ever serve these events');
    }
    out.push(`- **Parser check (re-run on build ${opts.buildNumber}):** ${verdictWord(v)}`
      + (v.method === 'none' ? '' : ` · ${v.method} · ${v.eventsParsed}/${v.eventsChecked} lines read · ${v.fields.length} fields`));
    if (v.reasons.length) out.push(`- **Checker said:** ${v.reasons.map(r => cell(r)).join('; ')}`);
    if (s.storedVerification && (s.storedVerification.verdict !== v.verdict || s.storedVerification.method !== v.method)) {
      // Drift matters on its own: the stored claim was made by an older build.
      out.push(`- **⚠️ Changed since generation:** stored as \`${s.storedVerification.verdict} / ${s.storedVerification.method}\``
        + `${s.storedVerification.buildNumber ? ` on build ${s.storedVerification.buildNumber}` : ''}, now \`${v.verdict} / ${v.method}\``);
    }
    if (v.fields.length) out.push(`- **Fields the parser extracted:** ${v.fields.map(x => `\`${x}\``).join(', ')}`);
    if (s.variantsPossible?.length) {
      const present = s.variantsPresent?.length ? s.variantsPresent.join(', ') : 'none recognized';
      out.push(`- **Multi-format source:** this product ships as ${s.variantsPossible.join(' / ')}; this sample covers **${present}**`);
    }
    if (s.flags?.length) out.push(`- **Flags:** ${s.flags.join(', ')}`);
    out.push(`- **Generated by:** ${s.provenance.model} on app build ${s.provenance.buildNumber}, ${s.provenance.generatedAt}`);
    out.push(`- **Content fingerprint:** \`${s.fingerprint}\` (rejecting blacklists this, so the same events cannot come back)`);
    out.push('');
    out.push(`**Question:** ${question(s)}`);
    out.push('');
    out.push(`${f}log`);
    shown.forEach(e => out.push(e));
    out.push(f);
    if (s.eventsTotal > shown.length) {
      out.push('');
      out.push(`_Showing ${shown.length} of ${s.eventsTotal} events in this sample._`);
    }
    out.push('');
  });

  out.push('## Verdicts');
  out.push('');
  out.push('Fill one line per sample and send it back — the app parses this block directly, so keep the'
    + ' key exactly as printed (it is the library key, which may carry a `::format` suffix) and keep one'
    + ' line per sample. Reject reasons should start with `ungrounded:` or `contradicted:`. Lines still'
    + ' holding the literal `keep|reject` are treated as unanswered, never as keep.');
  out.push('');
  out.push('```');
  samples.forEach(s => out.push(`${s.key}: keep|reject — reason`));
  out.push('```');
  out.push('');

  return out.join('\n');
}

// --- Reading the answer back ---------------------------------------------------

export interface ParsedVerdict {
  key: string;
  action: 'keep' | 'reject';
  reason: string;
  /** From the reason's prefix — the two rejects mean different next steps. */
  classification: 'ungrounded' | 'contradicted' | null;
}

export interface ParsedVerdictBlock {
  verdicts: ParsedVerdict[];
  /** Every line that was NOT understood, with why — a dropped line must be visible. */
  skipped: { line: string; why: string }[];
}

const VERDICT_LINE = /^[-*\s]*(?:\d+[.)]\s*)?([A-Za-z0-9_.:\-/]+)\s*:\s*(.*)$/;

/**
 * Parse a reviewer's returned verdict block back into actions.
 *
 * A reviewer answers in a text file, a chat reply or a mail, so the parser has to be
 * generous about shape (bullets, numbering, `-` or `—` before the reason) and strict
 * about meaning. Three rules carry the weight:
 *
 *  • **The template is not an answer.** The report ships `key: keep|reject — reason`
 *    as the grammar to fill in; a returned file that still contains that literal must
 *    not be read as "keep". This is the one mistake that would silently promote
 *    everything in the queue.
 *  • **Ambiguity is not an answer either.** A line naming both words, or neither, is
 *    skipped rather than guessed.
 *  • **Nothing disappears quietly.** Every unparsed line comes back in `skipped` with
 *    a reason, so the UI can show "12 verdicts, 3 lines I could not read" instead of
 *    acting on 12 and pretending that was the whole reply.
 *
 * Keys are returned exactly as written — matching them against the real staged keys is
 * the caller's job, because only the caller knows what exists.
 */
export function parseVerdictBlock(text: string): ParsedVerdictBlock {
  const verdicts: ParsedVerdict[] = [];
  const skipped: { line: string; why: string }[] = [];
  const seen = new Set<string>();

  // If the whole report came back, only its verdict section is an answer — the body
  // quotes log lines and prose that would otherwise parse as `key: value`.
  const marker = text.indexOf('## Verdicts');
  const body = marker >= 0 ? text.slice(marker + '## Verdicts'.length) : text;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^`{3,}/.test(line)) continue;
    // The report's own instruction line, and any prose around the block.
    if (/^(fill one line|this exact grammar|verdicts?$)/i.test(line)) continue;

    const m = VERDICT_LINE.exec(line);
    if (!m) continue;                       // not verdict-shaped at all — prose, ignore
    const [, key, rest] = m;
    const hasKeep = /\bkeep\b/i.test(rest);
    const hasReject = /\breject(ed)?\b/i.test(rest);

    if (/keep\s*\|\s*reject/i.test(rest)) { skipped.push({ line, why: 'still the unfilled template' }); continue; }
    if (hasKeep && hasReject) { skipped.push({ line, why: 'says both keep and reject' }); continue; }
    if (!hasKeep && !hasReject) { skipped.push({ line, why: 'no keep/reject verdict' }); continue; }
    if (seen.has(key)) { skipped.push({ line, why: `duplicate verdict for ${key}` }); continue; }

    const action: 'keep' | 'reject' = hasReject ? 'reject' : 'keep';
    // Strip the verdict word and any separator the reviewer used before the reason.
    const reason = rest
      .replace(/\b(keep|reject(ed)?)\b/i, '')
      .replace(/^[\s—–-]*[:—–-]?\s*/, '')
      .trim();
    const cls = /^ungrounded\b/i.test(reason) ? 'ungrounded' as const
      : /^contradicted\b/i.test(reason) ? 'contradicted' as const : null;
    seen.add(key);
    verdicts.push({ key, action, reason, classification: cls });
  }
  return { verdicts, skipped };
}

/** Filename for a downloaded report — dated, so several reviews don't overwrite. */
export function sampleReviewFilename(buildNumber: number, generatedAt: string): string {
  const day = (generatedAt || '').slice(0, 10) || 'undated';
  return `sample-review-build-${buildNumber}-${day}.md`;
}
