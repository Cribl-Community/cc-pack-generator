// Batch Check screen: why a row needs you, what to do, and what happens to it
// in the build — one source for the "needs a decision" box, the weaker list,
// the pinned side panel and its "Decision N of M" stepper, so the three can
// never disagree about which rows are open. Pure data, no React.

export type CheckKind = 'err' | 'warn' | 'checking' | 'ok';
export type CheckPath = 'golden' | 'ai' | 'none';

/** Plain text with inline code / bold spans; the screen renders it. */
export type Rich = (string | { code: string } | { b: string })[];

export interface CheckRowFacts {
  index: number;
  pack: string;
  /** What the file's sourcetype cell says. */
  declared: string;
  /** The name the row builds as right now (draft, override or canonical). */
  sourcetype: string;
  /** The gate has a confirmed sourcetype for this row. */
  confirmed: boolean;
  recognized: 'recognized' | 'ai-classified' | 'unknown';
  checking: boolean;
  /** A recommendation was pre-filled and needs an explicit OK. */
  needsConfirm: boolean;
  /**
   * Only a vendor hint matched ("Ivanti appliance"): the vendor is known, the
   * log is not. No parser, no golden. Absent for any other row.
   */
  vendorOnly?: string;
  /** Why the name is not a log source at all (Splunk/OS internal data). */
  notSecurity?: string;
  /** Other declared names that build with the same parser and sample as this row. */
  sharedWith?: string[];
  path: CheckPath;
  /** "OCSF Network Activity", "CEF". */
  dest: string;
  sample: {
    state: 'found' | 'generated' | 'missing' | 'pending' | 'none';
    events: number;
    thin: boolean;
    /** The user's own events (picked or uploaded), not the library. */
    own: boolean;
    sanitised: boolean;
  };
}

export interface CheckExplain {
  kind: CheckKind;
  title: string;
  why: Rich;
  todo: Rich[];
  next: Rich;
  /** One line for the needs-you box. */
  short: Rich;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function buildNext(f: Pick<CheckRowFacts, 'sourcetype' | 'dest' | 'path'>): Rich {
  if (f.path === 'none' || !f.sourcetype) return ['Not buildable until the sourcetype is named.'];
  return [
    'Builds ', { code: f.sourcetype }, ' → ', { b: f.dest }, ' on the ',
    ...(f.path === 'golden'
      ? [{ b: '★ golden path' }, ': a tested parser and mapping, scored against a reference.']
      : [{ b: '✦ AI path' }, ': no golden exists, so AI writes the parser and mapping and the score is measured on the output.']),
  ];
}

export function explainCheckRow(f: CheckRowFacts): CheckExplain {
  const next = buildNext(f);
  const hasSample = f.sample.state === 'found' || f.sample.state === 'generated';
  if (f.checking) {
    return {
      kind: 'checking', title: 'Being identified',
      why: ['AI is reading ', { code: f.declared || 'this row' }, '. The row fills in when it answers.'],
      todo: [], next, short: ['being identified…'],
    };
  }
  if (f.recognized === 'unknown' && f.notSecurity) {
    return {
      kind: 'err', title: 'Not a log source',
      why: [
        'Your file says ', { code: f.declared || 'blank' }, ': ', f.notSecurity,
        '. There are no security events to map, so ', { b: 'this row blocks the batch' }, '.',
      ],
      todo: [
        ['Remove the row if it does not belong in this batch'],
        ['Or type the real sourcetype if the name hides a real log, and save it'],
      ],
      next: ['Once named, it builds on the ✦ AI path unless a golden exists for the new name.'],
      short: [{ code: f.declared || 'blank' }, ' is not a log source · ', f.notSecurity],
    };
  }
  if (f.recognized === 'unknown') {
    return {
      kind: 'err', title: 'Sourcetype not recognized',
      why: [
        'Your file says ', { code: f.declared || 'blank' }, '. That matches no known sourcetype',
        hasSample ? ', and AI could not identify the sample either' : '',
        '. Without a sourcetype the builder cannot choose a parser, so ', { b: 'this row blocks the batch' }, '.',
      ],
      todo: [
        ['Type the real sourcetype, or pick a suggestion below'],
        ['Or press ', { b: 'Detect sourcetype' }, '; if the sample is poor, ', { b: hasSample ? 'Replace sample' : 'Add sample' }, ' first'],
        ['Save it, or remove the row if it does not belong in this batch'],
      ],
      next: ['Once named, it builds on the ✦ AI path unless a golden exists for the new name.'],
      short: [{ code: f.declared || 'blank' }, ' matches nothing', hasSample ? ', and AI could not identify the sample' : ''],
    };
  }
  if (!f.confirmed && f.vendorOnly && (!f.sourcetype || same(f.sourcetype, f.declared))) {
    return {
      kind: 'warn', title: 'Only the vendor is recognized',
      why: [
        'Your file says ', { code: f.declared || 'blank' }, '. No known sourcetype has that name; a hint matched the vendor (',
        { b: f.vendorOnly }, '), not the log. There is no parser or golden for it, so it builds on the ✦ AI path from its sample.',
      ],
      todo: [
        ['Check it is a real log source, not a host, index or script name'],
        ['Rename it if a known sourcetype fits'],
        ['Press ', { b: 'Confirm' }, ', or remove the row'],
      ],
      next,
      short: [{ code: f.declared || 'blank' }, ' · only the vendor is known (', f.vendorOnly, ') · AI build'],
    };
  }
  if (!f.confirmed) {
    const suggested = !!f.sourcetype && !same(f.sourcetype, f.declared);
    const golden = f.path === 'golden' ? ' ★ golden' : f.path === 'ai' ? ' (AI build)' : '';
    return {
      kind: 'warn',
      title: suggested || f.needsConfirm ? 'Suggested sourcetype, please confirm' : 'Confirm the sourcetype',
      why: suggested
        ? ['Your file says ', { code: f.declared || 'blank' }, '. The closest known name ', { code: f.sourcetype }, ' was pre-filled',
          f.path === 'golden' ? ' (it has a golden)' : '', '. A sourcetype is never changed without your OK.']
        : ['Your file says ', { code: f.declared || 'blank' }, ', a known name. It decides the parser and whether a tested golden is used, so it is confirmed once before the build.'],
      todo: [
        ['Check the name; ★ means a tested golden exists'],
        ['Pick another suggestion if it is wrong'],
        ['Press ', { b: 'Confirm' }],
      ],
      next,
      short: suggested
        ? ['file says ', { code: f.declared || 'blank' }, ' → suggested ', { code: f.sourcetype }, golden]
        : [{ code: f.sourcetype || f.declared }, ' is a known name · confirm it', golden],
    };
  }
  return {
    kind: 'ok', title: 'Ready, nothing to do',
    why: ['Confirmed as ', { code: f.sourcetype }, !same(f.sourcetype, f.declared) && f.declared ? ' (your file says ' : '',
      ...(!same(f.sourcetype, f.declared) && f.declared ? [{ code: f.declared }, ')'] : []), '.'],
    todo: [], next, short: ['ready'],
  };
}

export interface SampleNote {
  title: string;
  detail: string;
  /** Button label; the button opens the sample picker for the row. */
  action: string;
}

/** A row that builds, but weaker, because of its sample. Null when the sample is fine. */
export function sampleNote(f: CheckRowFacts): SampleNote | null {
  const s = f.sample;
  if (s.state === 'missing') {
    return { title: 'No sample', detail: 'None chosen and none in the library. One is generated at build time and the score is less reliable.', action: 'Add sample' };
  }
  if (s.state === 'found' && s.thin) {
    return { title: 'Thin sample', detail: `Only ${s.events} event${s.events === 1 ? '' : 's'}. The row builds, but its score says less.`, action: 'Replace sample' };
  }
  const shared = f.sharedWith ?? [];
  if (shared.length && !s.own) {
    const list = shared.slice(0, 3).join(', ') + (shared.length > 3 ? ` +${shared.length - 3} more` : '');
    return {
      title: 'Shares a parser and sample',
      detail: `Builds as ${f.sourcetype} with the same sample as ${list}, so the packs come out alike. Pick this row's own events to tell them apart.`,
      action: 'Replace sample',
    };
  }
  if (s.own && !s.sanitised) {
    return { title: 'Not sanitized', detail: 'Your own events, used as-is. Sanitizing replaces IPs, hosts and user names with safe values before any AI step sees them.', action: 'Replace sample' };
  }
  return null;
}

/** "Add sample" when the row has none yet, otherwise "Replace sample". */
export function sampleActionLabel(f: Pick<CheckRowFacts, 'sample'>): string {
  return f.sample.state === 'found' || f.sample.state === 'generated' || f.sample.own ? 'Replace sample' : 'Add sample';
}

/** Rows that need a decision before the build, blocking ones first, then in file order. */
export function decisionQueue(rows: readonly CheckRowFacts[]): number[] {
  const kinds = rows.map(r => ({ i: r.index, k: explainCheckRow(r).kind }));
  return [
    ...kinds.filter(x => x.k === 'err').map(x => x.i),
    ...kinds.filter(x => x.k === 'warn').map(x => x.i),
  ];
}

export interface StepperState {
  /** 1-based position of `selected` in the queue; 0 when it is not an open decision. */
  position: number;
  total: number;
  prev: number | null;
  next: number | null;
  /** Where "Confirm & next →" goes: the next open decision after this one, wrapping. */
  afterConfirm: number | null;
}

export function stepperFor(queue: readonly number[], selected: number | null): StepperState {
  const at = selected == null ? -1 : queue.indexOf(selected);
  const others = queue.filter(i => i !== selected);
  return {
    position: at + 1,
    total: queue.length,
    prev: at > 0 ? queue[at - 1] : null,
    next: at >= 0 && at < queue.length - 1 ? queue[at + 1] : null,
    afterConfirm: at >= 0 ? (queue[at + 1] ?? others[0] ?? null) : (queue[0] ?? null),
  };
}

export interface CheckTiles {
  all: number;
  ready: number;
  confirm: number;
  unknown: number;
  ai: number;
  checking: number;
}

export function checkTiles(rows: readonly CheckRowFacts[]): CheckTiles {
  const kinds = rows.map(r => explainCheckRow(r).kind);
  return {
    all: rows.length,
    ready: kinds.filter(k => k === 'ok').length,
    confirm: kinds.filter(k => k === 'warn').length,
    unknown: kinds.filter(k => k === 'err').length,
    ai: rows.filter(r => r.path === 'ai').length,
    checking: kinds.filter(k => k === 'checking').length,
  };
}

/** Golden vs AI rows among the ones that will build — the estimate's input. */
export function pathCounts(rows: readonly Pick<CheckRowFacts, 'path'>[]): { golden: number; ai: number } {
  return {
    golden: rows.filter(r => r.path === 'golden').length,
    ai: rows.filter(r => r.path !== 'golden').length,
  };
}

export interface ScopedQueue {
  /** The decisions the box, "Start with the first" and the stepper walk. */
  queue: number[];
  /** True when a filter narrowed it to fewer than all open decisions. */
  scoped: boolean;
  /** All open decisions, filtered or not. */
  total: number;
}

/**
 * Decisions in the rows the table shows. With a filter on ("Not recognized"),
 * the box and stepper work through those rows first; a filter with no open
 * decisions in it (Ready) falls back to all of them, so the box never hides
 * work that is left.
 */
export function scopedQueue(queue: readonly number[], visible: ReadonlySet<number> | null): ScopedQueue {
  const inView = visible ? queue.filter(i => visible.has(i)) : [...queue];
  const use = inView.length ? inView : [...queue];
  return { queue: use, scoped: use.length < queue.length, total: queue.length };
}

/**
 * A decision-list row can be confirmed in place only when it asks for a
 * confirmation ('warn'); an unrecognized row needs a name first (Fix →).
 */
export function canConfirmInline(kind: CheckKind): boolean {
  return kind === 'warn';
}

/**
 * The selected row after row `removed` leaves the batch. Rows are re-indexed on
 * removal, so a selection past it shifts down by one; the removed row itself
 * clears the selection.
 */
export function selectionAfterRemove(sel: number | null, removed: number): number | null {
  if (sel == null || sel === removed) return null;
  return sel > removed ? sel - 1 : sel;
}

export type BusyStageId = 'names' | 'ai' | 'samples';

export interface BusyView {
  /** The three stages of the check, in order, with where it is now. */
  stages: { id: BusyStageId; label: string; state: 'done' | 'now' | 'todo' }[];
  title: string;
  /** What is happening and what the user can do meanwhile. */
  hint: string;
  /** "2 of 3", or "starting…" before the first row. */
  count: string;
  /** 0–100, or null while nothing has finished yet (the bar then moves on its own). */
  pct: number | null;
  /** Short form for the footer's Next button. */
  short: string;
}

/**
 * What the check screen's busy bar says. The progress label is the only signal of
 * which pass is running (the AI pass and the model pass set their own), so the
 * stage is read from it, never guessed from timing.
 */
export function preflightBusyView(
  phase: string,
  progress: { done: number; total: number; label: string } | null,
): BusyView {
  const label = progress?.label || (phase === 'sourcetype' ? 'Checking sourcetypes' : 'Resolving samples');
  const now: BusyStageId = phase === 'samples' ? 'samples' : /\bAI\b/.test(label) ? 'ai' : 'names';
  const order: BusyStageId[] = ['names', 'ai', 'samples'];
  const at = order.indexOf(now);
  const labels: Record<BusyStageId, string> = {
    names: 'Recognize names',
    ai: 'AI identifies the rest',
    samples: phase === 'samples' ? 'Find samples' : 'Find samples (after Next)',
  };
  const modelPass = phase === 'samples' && /Generating|extending/.test(label);
  const hint = now === 'names'
    ? 'Matching every sourcetype against the catalog and the stored goldens. Rows fill in as they resolve.'
    : now === 'ai'
      ? 'AI is reading the names nothing else recognized. Rows with a spinner can still change; decisions unlock when this finishes.'
      : modelPass
        ? 'AI is generating or extending samples, which takes minutes per source. You can continue without waiting; the rest is generated at build time.'
        : 'Looking up a library sample for every sourcetype.';
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const pct = total > 0 && done > 0 ? Math.round((done / total) * 100) : null;
  const count = total > 0 ? `${done} of ${total}` : 'starting…';
  return {
    stages: order.map((id, i) => ({ id, label: labels[id], state: i < at ? 'done' : i === at ? 'now' : 'todo' })),
    title: label,
    hint,
    count,
    pct,
    short: `${now === 'samples' ? 'Finding samples' : 'Checking'}… ${total > 0 ? count : ''}`.trim(),
  };
}
