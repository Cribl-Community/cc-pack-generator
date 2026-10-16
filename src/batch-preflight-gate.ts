/**
 * The batch sourcetype gate (Task 9).
 *
 * A batch row's sourcetype is whatever the CSV says. Recognition can suggest a
 * better name, but a suggestion is not a decision: the golden key is
 * `${sourcetype}` or `${sourcetype}@${wire}`, so a typo or a fuzzy near-miss
 * reads and writes another source's entry. This gate stays shut until every
 * row has an explicit confirmation.
 *
 * Granularity is the row. The CSV has no sample column: each row's sample is
 * chosen in the pre-flight picker (the shared sanitizer in pick mode), and may
 * hold many events. The golden key and the pack sample are per row, so that
 * sample is one unit: one suggestion list, one confirmation.
 *
 * A row with no sample is a naming choice. Candidates come from the same
 * catalog the wizard searches (exact, alias, family variants, fuzzy, then
 * catalog search). A row with a sample shows those close names immediately,
 * led by what the sample itself names (CEF header, datatype, JSON signature).
 * Picking a sample replaces it and confirms the name the picker read from it;
 * the user can still edit and re-save. Detect fills the draft from the
 * leading suggestion. Save is the confirmation.
 *
 * A custom name is allowed. Confirming it is the decision; the gate does not
 * require the name to be in the catalog.
 */
import { formatBatchCsv } from './batch-csv';
import { goldenBaseSourcetype } from './golden-variant';
import { getFamilyTokenVariants, searchSupportedSourcetypes } from './pack-builder';
import { planSampleSanitisation, runSanitisation } from './sanitised-sample-workflow';
import {
  canonicalizeSourcetype,
  matchDatatypeParserBySample,
  matchJsonSignature,
  normalizeSourcetypeName,
  recognizeCefSource,
  recognizeSourcetype,
} from './source-recognition';

export interface GateCandidate {
  name: string;
  /** Why this name is on the list. The first entry is the one to lead with. */
  why: 'exact' | 'alias' | 'family' | 'fuzzy' | 'catalog' | 'cef-header' | 'datatype' | 'json-signature' | 'ai' | 'golden';
  confidence: 'high' | 'medium' | 'low';
  /** This name has a stored golden, even when a stronger reason already leads. */
  hasGolden?: boolean;
}

export type SuggestionKind = 'from sample' | 'AI (sample)' | 'has a golden' | 'close name' | 'declared name';

/** Short label for a suggestion chip: the sample named it, a golden exists, or the declared name is close. */
export function suggestionLabel(why: GateCandidate['why']): SuggestionKind {
  if (why === 'cef-header' || why === 'datatype' || why === 'json-signature') return 'from sample';
  if (why === 'ai') return 'AI (sample)';
  if (why === 'golden') return 'has a golden';
  if (why === 'exact' || why === 'alias') return 'declared name';
  return 'close name';
}

/**
 * The sourcetype of every stored golden key. `fortinet_fortigate@cef::ocsf` and
 * `fortinet_fortigate::__extraction__` are the same source. Keys starting with
 * `_` are store metadata, not pipelines.
 */
export function goldenSourcetypeNames(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    if (!key || key.startsWith('_')) continue;
    const head = key.split('::')[0];
    if (!head) continue;
    const base = goldenBaseSourcetype(head);
    if (base) out.add(base);
  }
  return [...out];
}

/** The name written back to the CSV, and the spelling the build emits. */
export interface ConfirmedSourcetype {
  /** Canonical when the name is known; the typed string when it is a new name. */
  sourcetype: string;
  /**
   * The spelling sample resolution and the emitted `sourcetype` field use.
   * Equals `sourcetype` when the user confirmed a canonical name. Keeps the
   * declared channel (`WinEventLog:System`) when that is what they confirmed.
   */
  outputSourcetype: string;
}

export interface BatchGateRow {
  /** The sourcetype cell, unchanged by recognition. */
  declared: string;
  /** The row's own sample, after a sanitise when the user applied one. */
  sample: string;
  /**
   * Kept for a caller that still withholds detectors. Open rows set this
   * false: suggestions are computed immediately, and Save is not blocked.
   */
  awaitingSanitise: boolean;
  suggestions: GateCandidate[];
  confirmed: ConfirmedSourcetype | null;
  /** The custom-name field. Confirming an empty draft does nothing. */
  draft: string;
  /** True after the user applied the sanitizer. `sample` is that modified text. */
  sanitised: boolean;
  /** One line about the sanitise choice, once the user has made it. */
  note?: string;
  /**
   * The user changed the name by hand (typed or picked a suggestion). Such a row
   * is never confirmed on its own again: confirmSettled would put the declared
   * name straight back on every keystroke.
   */
  edited?: boolean;
}

export interface SanitiseOffer {
  /** Enabled replacements that would change the sample. */
  replacements: number;
  summary: string;
  text: string;
  changed: boolean;
}

const CANDIDATE_LIMIT = 8;

function dedupe(list: GateCandidate[], cand: GateCandidate): void {
  const key = canonicalizeSourcetype(cand.name);
  if (!key || list.some(c => canonicalizeSourcetype(c.name) === key)) return;
  list.push(cand);
}

/**
 * Golden sourcetypes close to the declared name. An exact or prefix hit leads;
 * a shared token (fortinet_fo → fortinet_fortigate) still counts. Short queries
 * only match a prefix, so "cef" does not pull in every name that mentions CEF.
 */
function matchGoldenNames(declared: string, names: readonly string[]): string[] {
  const raw = declared.trim().toLowerCase();
  const q = normalizeSourcetypeName(declared).replace(/_/g, '');
  if (q.length < 3) return [];
  const tokens = normalizeSourcetypeName(declared).split('_').filter(t => t.length >= 4);
  const scored: { name: string; rank: number }[] = [];
  for (const name of names) {
    const nameKey = name.toLowerCase().replace(/_/g, '');
    const nameTokens = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4));
    let rank = -1;
    if (nameKey === q || name.toLowerCase() === raw) rank = 0;
    else if (nameKey.startsWith(q) || name.toLowerCase().startsWith(raw)) rank = 1;
    else if (q.length >= 4 && (nameKey.includes(q) || (nameKey.length >= 4 && q.includes(nameKey)))) rank = 2;
    else if (tokens.some(t => nameTokens.has(t) || nameKey.includes(t))) rank = 3;
    if (rank >= 0) scored.push({ name, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return scored.slice(0, CANDIDATE_LIMIT).map(s => s.name);
}

/** A suggestion whose name is itself a stored golden, whatever reason put it on the list. */
function markKnownGoldens(list: GateCandidate[], goldenNames: readonly string[]): void {
  if (!goldenNames.length) return;
  const known = new Set<string>();
  for (const name of goldenNames) {
    const key = canonicalizeSourcetype(name);
    if (key) known.add(key);
  }
  for (const cand of list) {
    if (known.has(canonicalizeSourcetype(cand.name))) cand.hasGolden = true;
  }
}

/** Mark names that already have a golden, and add golden-only close names. */
function applyGoldenNames(out: GateCandidate[], declared: string, goldenNames: readonly string[]): void {
  if (!goldenNames.length) return;
  for (const name of matchGoldenNames(declared, goldenNames)) {
    const key = canonicalizeSourcetype(name);
    const existing = out.find(c => canonicalizeSourcetype(c.name) === key);
    if (existing) { existing.hasGolden = true; continue; }
    dedupe(out, { name, why: 'golden', confidence: 'medium', hasGolden: true });
  }
  markKnownGoldens(out, goldenNames);
}

/** Ranked naming choices for a row that brought no sample. */
export function nameCandidates(declared: string, goldenNames: readonly string[] = []): GateCandidate[] {
  const out: GateCandidate[] = [];
  const family = getFamilyTokenVariants(declared);
  if (family.length) {
    for (const name of family) dedupe(out, { name, why: 'family', confidence: 'medium' });
  } else {
    let rec;
    try { rec = recognizeSourcetype(declared); } catch { rec = null; }
    if (rec && (rec.status === 'exact' || rec.status === 'alias')) {
      dedupe(out, { name: rec.canonical, why: rec.status, confidence: 'high' });
    } else if (rec && rec.tier === 'fuzzy' && rec.suggestion) {
      dedupe(out, {
        name: rec.suggestion,
        why: 'fuzzy',
        confidence: rec.confidence === 'high' ? 'high' : 'medium',
      });
    }
  }
  try {
    for (const hit of searchSupportedSourcetypes(declared, CANDIDATE_LIMIT)) {
      dedupe(out, { name: hit.name, why: 'catalog', confidence: 'low' });
    }
  } catch { /* catalog unavailable — the explicit confirm still works */ }
  applyGoldenNames(out, declared, goldenNames);
  return preferGolden(out).slice(0, CANDIDATE_LIMIT);
}

/** Sample hits stay first. A name that exists only because a golden does follows them. */
function preferGolden(list: GateCandidate[]): GateCandidate[] {
  const sample = list.filter(c => suggestionLabel(c.why) === 'from sample' || c.why === 'ai');
  const golden = list.filter(c => c.why === 'golden');
  const rest = list.filter(c => !sample.includes(c) && c.why !== 'golden');
  return [...sample, ...golden, ...rest];
}

/**
 * What one sample names, offline, strongest first. The whole cell is one
 * sample: several lines share one list, they are not confirmed separately.
 */
export function sampleSuggestions(sample: string, declared: string, goldenNames: readonly string[] = []): GateCandidate[] {
  const lines = sample.split('\n').map(l => l.trim()).filter(Boolean);
  const text = lines.join('\n');
  if (!text) return nameCandidates(declared, goldenNames);
  const out: GateCandidate[] = [];
  try {
    const cef = recognizeCefSource(text);
    if (cef?.sourcetype) dedupe(out, { name: cef.sourcetype, why: 'cef-header', confidence: 'high' });
  } catch { /* not CEF */ }
  try {
    const dt = matchDatatypeParserBySample(text);
    if (dt?.parserKey) {
      const name = recognizeSourcetype(dt.parserKey).canonical || dt.parserKey;
      dedupe(out, { name, why: 'datatype', confidence: 'high' });
    }
  } catch { /* no datatype match */ }
  try {
    const js = matchJsonSignature(text);
    if (js?.sourcetype) {
      const name = recognizeSourcetype(js.sourcetype).canonical || js.sourcetype;
      dedupe(out, { name, why: 'json-signature', confidence: 'high' });
    }
  } catch { /* no signature */ }
  for (const cand of nameCandidates(declared, goldenNames)) {
    const key = canonicalizeSourcetype(cand.name);
    const existing = out.find(c => canonicalizeSourcetype(c.name) === key);
    if (existing) {
      if (cand.hasGolden) existing.hasGolden = true;
      continue;
    }
    dedupe(out, cand);
  }
  markKnownGoldens(out, goldenNames);
  return preferGolden(out).slice(0, CANDIDATE_LIMIT);
}

export function openGateRow(input: { sourcetype: string; sample?: string; goldenNames?: readonly string[] }): BatchGateRow {
  const declared = String(input.sourcetype || '').trim();
  const sample = String(input.sample || '').trim();
  const goldenNames = input.goldenNames ?? [];
  return {
    declared,
    sample,
    awaitingSanitise: false,
    suggestions: sample ? sampleSuggestions(sample, declared, goldenNames) : nameCandidates(declared, goldenNames),
    confirmed: null,
    draft: declared,
    sanitised: false,
  };
}

/** Sanitise or keep: either choice is what lets the detectors run. */
export function revealSuggestions(row: BatchGateRow, sample?: string, note?: string, goldenNames: readonly string[] = []): BatchGateRow {
  const text = sample ?? row.sample;
  const suggestions = text.trim() ? sampleSuggestions(text, row.declared, goldenNames) : nameCandidates(row.declared, goldenNames);
  return {
    ...row,
    sample: text,
    awaitingSanitise: false,
    suggestions,
    note,
    draft: suggestions[0]?.name || row.draft || row.declared,
  };
}

/**
 * True when the offline tiers read the sample and it named no source. This is
 * exactly where the single-pack wizard's "Detect sourcetype" stops trying
 * locally and asks the model, so the batch gate asks at the same point.
 */
export function needsAiDetection(row: BatchGateRow): boolean {
  if (!row.sample.trim()) return false;
  return !row.suggestions.some(c => suggestionLabel(c.why) === 'from sample');
}

/**
 * The model's answer, ranked with the offline sample hits rather than among
 * the name-similarity ones: it read the events, not the spelling.
 */
export function addAiSuggestion(
  row: BatchGateRow,
  name: string,
  confidence: GateCandidate['confidence'],
  note?: string,
): BatchGateRow {
  const picked = String(name || '').trim();
  if (!picked) return note ? { ...row, note } : row;
  const cand: GateCandidate = { name: picked, why: 'ai', confidence };
  const kept = row.suggestions.filter(c => canonicalizeSourcetype(c.name) !== canonicalizeSourcetype(picked));
  const fromSample = kept.filter(c => suggestionLabel(c.why) === 'from sample');
  const rest = kept.filter(c => suggestionLabel(c.why) !== 'from sample');
  return {
    ...row,
    suggestions: [...fromSample, cand, ...rest].slice(0, CANDIDATE_LIMIT),
    // The draft only moves when the user has not typed something else.
    draft: row.draft && row.draft !== row.declared ? row.draft : picked,
    note,
  };
}

/**
 * The library sanitise, not a second implementation. Returns the offer; it
 * does not reveal suggestions. The caller does that after the user chooses.
 */
/**
 * One click for the whole batch. Each row with a sample runs the same library
 * plan the sanitizer modal uses, and the modified text replaces that row.
 * A row the user already sanitised is left alone. The canonical draft and a
 * saved confirmation stay: this changes the sample, not the chosen name.
 */
export function sanitiseAllGateRows(rows: readonly BatchGateRow[], goldenNames: readonly string[] = []): BatchGateRow[] {
  return rows.map(row => {
    if (!row?.sample.trim() || row.sanitised) return row;
    const offer = offerRowSanitise(row.sample, row.draft || row.declared);
    const note = offer.changed
      ? (offer.summary || 'Sanitized.')
      : 'Sanitized — nothing in this sample needed replacing.';
    const text = offer.changed ? offer.text : row.sample;
    const refreshed = revealSuggestions(row, text, note, goldenNames);
    return { ...refreshed, draft: row.draft, confirmed: row.confirmed, sanitised: true };
  });
}

export function offerRowSanitise(sample: string, sourcetype: string): SanitiseOffer {
  const plan = planSampleSanitisation(sample, sourcetype);
  const run = runSanitisation(sample, sourcetype, plan.entries);
  return {
    replacements: run.liveEntries,
    summary: run.summary,
    text: run.text,
    changed: run.changed,
  };
}

function sameSource(a: string, b: string): boolean {
  return canonicalizeSourcetype(a) === canonicalizeSourcetype(b);
}

export function confirmGateRow(row: BatchGateRow, name: string): BatchGateRow {
  const picked = String(name || '').trim();
  if (!picked || row.awaitingSanitise) return row;
  const confirmingDeclared = picked === row.declared || sameSource(picked, row.declared);
  let sourcetype: string;
  let outputSourcetype: string;
  if (confirmingDeclared) {
    sourcetype = canonicalizeSourcetype(row.declared);
    outputSourcetype = row.declared;
  } else {
    let known = false;
    try {
      const rec = recognizeSourcetype(picked);
      known = rec.status === 'exact' || rec.status === 'alias';
    } catch { /* a new name stays as typed */ }
    sourcetype = known ? canonicalizeSourcetype(picked) : picked;
    outputSourcetype = picked;
  }
  return { ...row, confirmed: { sourcetype, outputSourcetype }, draft: picked };
}

/** A hand edit of the name: unconfirms the row and keeps it unconfirmed until saved. */
export function editGateDraft(row: BatchGateRow, draft: string): BatchGateRow {
  return { ...row, draft, confirmed: null, edited: true };
}

export function clearGateConfirmation(row: BatchGateRow): BatchGateRow {
  return { ...row, confirmed: null };
}

export function isGateRowValidated(row: BatchGateRow): boolean {
  return !!row.confirmed?.sourcetype;
}

/** True only when every row has been confirmed. An empty batch is not a batch. */
export function batchGateOpen(rows: readonly BatchGateRow[]): boolean {
  return rows.length > 0 && rows.every(isGateRowValidated);
}

/**
 * A row whose declared name is already an exact or alias hit, and whose
 * sample (when it has one) does not name a different source. Family tokens
 * are not included ("cisco" is not a log source) unless a stored golden has
 * exactly that name ("juniper"). A sample that names a
 * different source is not included, and a row still marked `awaitingSanitise`
 * is not included.
 */
export function declarableAsIs(row: BatchGateRow): boolean {
  // A hand-edited row asked for another name: "accept declared" must not undo it.
  if (row.awaitingSanitise || row.confirmed || row.edited) return false;
  // A declared name with a stored golden is known even when the catalog
  // recogniser has no entry for it (google_workspace, squid_proxy), and even
  // when it is also a vendor token (juniper): the golden was built as written.
  const golden = row.suggestions.some(c => c.hasGolden && sameSource(c.name, row.declared));
  if (!golden && getFamilyTokenVariants(row.declared).length > 0) return false;
  let rec;
  try { rec = recognizeSourcetype(row.declared); } catch { return false; }
  if (rec.status !== 'exact' && rec.status !== 'alias' && !golden) return false;
  const lead = row.suggestions[0];
  if (lead && (lead.why === 'cef-header' || lead.why === 'datatype' || lead.why === 'json-signature')) {
    return sameSource(lead.name, row.declared);
  }
  return true;
}

export function confirmDeclared(row: BatchGateRow): BatchGateRow {
  if (!declarableAsIs(row)) return row;
  return confirmGateRow(row, row.declared);
}

/**
 * Pre-flight already settled this row on the name the file gives: a catalog
 * product (aemdispatcher), a stored golden (syslog, ps) or a source AI
 * confirmed as real under its own name (ncsc:rsa:metadata). Confirming would
 * change nothing, so it is confirmed without asking. A rename (fuzzy or AI
 * mapping) still waits for the user, and so does a row whose sample names a
 * different source.
 */
export function confirmSettled(row: BatchGateRow, buildName: string | undefined): BatchGateRow {
  if (row.awaitingSanitise || row.confirmed || row.edited || !buildName || !row.declared.trim()) return row;
  if (!sameSource(buildName, row.declared)) return row;
  const lead = row.suggestions[0];
  if (lead && (lead.why === 'cef-header' || lead.why === 'datatype' || lead.why === 'json-signature') && !sameSource(lead.name, row.declared)) return row;
  return confirmGateRow(row, row.declared);
}

export function confirmMatchingRows(rows: readonly BatchGateRow[]): BatchGateRow[] {
  return rows.map(confirmDeclared);
}

export interface ConfirmedBatchSource {
  sourcetype: string;
  pack_name: string;
  pipeline_name: string;
  dest_format: string;
  filter?: string;
  route_name?: string;
  cimModel?: string;
  sentinelTable?: string;
}

const CONFIRMED_HEADERS = [
  'sourcetype', 'pack_name', 'pipeline_name', 'dest_format', 'filter', 'route_name',
  'cim_model', 'sentinel_table', 'output_sourcetype',
];

/**
 * The CSV a later upload reads. Refuses to write while any row is still
 * unconfirmed. It carries no sample: samples are picked in the pre-flight,
 * not written into the file. `output_sourcetype` is set only when the emitted spelling
 * differs from the canonical sourcetype column.
 */
export function formatConfirmedBatchCsv(rows: readonly ConfirmedBatchSource[], gates: readonly BatchGateRow[]): string {
  if (rows.length !== gates.length) throw new Error('each batch row needs its own gate row');
  if (!batchGateOpen(gates)) throw new Error('every row needs a confirmed sourcetype before the CSV can be written');
  const records = rows.map((row, i) => {
    const confirmed = gates[i].confirmed!;
    return {
      sourcetype: confirmed.sourcetype,
      pack_name: row.pack_name,
      pipeline_name: row.pipeline_name,
      dest_format: row.dest_format,
      filter: row.filter || '',
      route_name: row.route_name || '',
      cim_model: row.cimModel || '',
      sentinel_table: row.sentinelTable || '',
      output_sourcetype: confirmed.outputSourcetype !== confirmed.sourcetype ? confirmed.outputSourcetype : '',
    };
  });
  return formatBatchCsv(CONFIRMED_HEADERS, records);
}

/**
 * How an uploaded row's two sourcetype columns become the batch row.
 * A corrected CSV writes the canonical name in `sourcetype` and, when the
 * spelling differs, the channel or colon form in `output_sourcetype`.
 * A file that has only `sourcetype` keeps that cell for both, as before.
 */
export function readBatchSourcetypeColumns(record: {
  sourcetype?: string;
  output_sourcetype?: string;
  outputSourcetype?: string;
}): { sourcetype: string; outputSourcetype: string } {
  const sourcetype = String(record.sourcetype || '').trim();
  const rawOut = String(record.output_sourcetype || record.outputSourcetype || '').trim();
  return { sourcetype, outputSourcetype: rawOut || sourcetype };
}
