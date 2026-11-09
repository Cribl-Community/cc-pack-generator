/**
 * "What we can demo": the validation of a board's intake (spec R10, R15; plan Task 9).
 *
 * One row per board item: what was said beside what will be built, with the SE's
 * changes. Pure state + reducer, so the screen stays thin and the rules are testable:
 *
 *   - a source row builds its picks; a transport or a row with no pick blocks until the
 *     SE picks or leaves it out
 *   - a destination row builds its format; a suggestion (data platform → OCSF, no format
 *     → JSON) is applied, but an unresolved row or a compatibility hint blocks until the
 *     SE picks or accepts
 *   - Cribl products are carried for the story and never count
 *   - Cribl Lake creates a dataset: its id must be usable, and it adds a lake-group format
 *     (the one picked on the Lake row, else one picked elsewhere, else OCSF)
 *   - the demo takes DEMO_MAX_SOURCES sources and DEMO_MAX_FORMATS formats
 *
 * A prior validation saved on the board is re-applied row by row: a row whose words are
 * unchanged keeps the SE's decision; anything new is marked new.
 */
import type { DiscoveryIntake, DestinationColumn } from './discovery-intake';
import { matchDestination, matchSource, normWords, type DestCandidate, type DestMatch, type MatchContext, type SourceCandidate, type SourceMatch } from './discovery-match';
import { DEMO_MAX_FORMATS, DEMO_MAX_SOURCES } from './demo-flow';
import { FLOW_FORMATS } from './flow-builder';
import { DEMO_LAKE_RETENTION_DAYS, defaultLakeDatasetId, lakeDatasetDecision } from './lake-dataset';
import type { DiscoveryAliases, DiscoveryValidation } from './whiteboard/types';

export interface SourceRow {
  key: string;
  label: string;
  match: SourceMatch;
  picks: string[];
  leftOut: boolean;
  /** The SE changed the suggestion — "Remember for next time" applies. */
  changed: boolean;
  remember: boolean;
  isNew: boolean;
}

export interface DestRow {
  key: string;
  label: string;
  column: DestinationColumn;
  match: DestMatch;
  /** The format this row builds; undefined until picked (unresolved) or accepted (hint). */
  format?: string;
  leftOut: boolean;
  changed: boolean;
  remember: boolean;
  isNew: boolean;
}

export interface LakeState {
  /** Whether this org has Cribl Lake (null while checking). */
  available: boolean | null;
  lakeIds: string[];
  /** Datasets whose deletion has started (Lake deletes asynchronously). */
  deletingIds: string[];
  searchIds: string[];
  datasetId: string;
  retentionPeriodInDays: number;
  /** Also build a Cribl Search dashboard over the dataset (spec R19). */
  dashboard: boolean;
}

export interface ValidationState {
  prospect: string;
  fingerprint: string;
  sources: SourceRow[];
  dests: DestRow[];
  lake: LakeState;
  hadPrior: boolean;
}

export type ValidationAction =
  | { type: 'source-add'; key: string; sourcetype: string }
  | { type: 'source-remove'; key: string; sourcetype: string }
  | { type: 'source-set'; key: string; picks: string[] }
  | { type: 'dest-format'; key: string; format: string }
  | { type: 'leave-out'; key: string; leftOut: boolean }
  | { type: 'remember'; key: string; remember: boolean }
  | { type: 'lake-id'; datasetId: string }
  | { type: 'lake-retention'; days: number }
  | { type: 'lake-dashboard'; on: boolean }
  | { type: 'lake-status'; available: boolean; lakeIds: string[]; searchIds: string[]; deletingIds?: string[] };

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const isLakeFormat = (f: string) => FLOW_FORMATS[f]?.group === 'lake';
const isLakeRow = (r: DestRow) => r.match.status === 'lake';
const isCriblRow = (r: DestRow) => r.match.status === 'cribl';

/** The format a destination row builds before the SE touches it. */
function suggestedFormat(m: DestMatch): string | undefined {
  return m.status === 'matched' || m.status === 'choose' || m.status === 'no-format' ? m.format : undefined;
}

export function initValidation(intake: DiscoveryIntake, ctx: MatchContext, prior?: DiscoveryValidation | null): ValidationState {
  const priorSources = new Map((prior?.sources || []).map(r => [r.itemKey, r]));
  const priorDests = new Map((prior?.dests || []).map(r => [r.itemKey, r]));
  const sources: SourceRow[] = intake.sources.map(it => {
    const match = matchSource(it, ctx);
    const p = priorSources.get(it.itemKey);
    const keep = p && normWords(p.label) === normWords(it.label);
    const picks = keep ? p!.picks : match.picks;
    return {
      key: it.itemKey, label: it.label, match, picks, leftOut: keep ? !!p!.leftOut : false,
      changed: keep ? !sameList(p!.picks, match.picks) : false, remember: true, isNew: !!prior && !keep,
    };
  });
  const dests: DestRow[] = intake.destinations.map(it => {
    const match = matchDestination(it, ctx);
    const p = priorDests.get(it.itemKey);
    const keep = p && normWords(p.label) === normWords(it.label);
    const format = keep ? p!.format : suggestedFormat(match);
    return {
      key: it.itemKey, label: it.label, column: it.column, match, ...(format ? { format } : {}),
      leftOut: keep ? !!p!.leftOut : false, changed: keep ? (p!.format || '') !== (suggestedFormat(match) || '') : false,
      remember: true, isNew: !!prior && !keep,
    };
  });
  return {
    prospect: intake.prospect,
    fingerprint: intake.fingerprint,
    sources,
    dests,
    lake: {
      available: null, lakeIds: [], searchIds: [], deletingIds: [],
      datasetId: prior?.lake?.datasetId || defaultLakeDatasetId(intake.prospect),
      retentionPeriodInDays: prior?.lake?.retentionPeriodInDays || DEMO_LAKE_RETENTION_DAYS,
      dashboard: prior?.lake?.dashboard === true,
    },
    hadPrior: !!prior,
  };
}

export function reduceValidation(s: ValidationState, a: ValidationAction): ValidationState {
  const editSource = (key: string, fn: (r: SourceRow) => Partial<SourceRow>) => ({
    ...s, sources: s.sources.map(r => (r.key === key ? { ...r, ...fn(r) } : r)),
  });
  const withPicks = (r: SourceRow, picks: string[]) => ({ picks, changed: !sameList(picks, r.match.picks), leftOut: picks.length ? false : r.leftOut });
  switch (a.type) {
    case 'source-add': return editSource(a.key, r => withPicks(r, uniq([...r.picks, a.sourcetype])));
    case 'source-remove': return editSource(a.key, r => withPicks(r, r.picks.filter(p => p !== a.sourcetype)));
    case 'source-set': return editSource(a.key, r => withPicks(r, uniq(a.picks)));
    case 'dest-format':
      return { ...s, dests: s.dests.map(r => (r.key === a.key ? { ...r, format: a.format, leftOut: false, changed: a.format !== suggestedFormat(r.match) } : r)) };
    case 'leave-out':
      return {
        ...s,
        sources: s.sources.map(r => (r.key === a.key ? { ...r, leftOut: a.leftOut } : r)),
        dests: s.dests.map(r => (r.key === a.key ? { ...r, leftOut: a.leftOut } : r)),
      };
    case 'remember':
      return {
        ...s,
        sources: s.sources.map(r => (r.key === a.key ? { ...r, remember: a.remember } : r)),
        dests: s.dests.map(r => (r.key === a.key ? { ...r, remember: a.remember } : r)),
      };
    case 'lake-id': return { ...s, lake: { ...s.lake, datasetId: a.datasetId.trim() } };
    case 'lake-retention': return { ...s, lake: { ...s.lake, retentionPeriodInDays: Math.round(a.days) } };
    case 'lake-dashboard': return { ...s, lake: { ...s.lake, dashboard: a.on } };
    case 'lake-status': {
      // No Cribl Lake on this org: the Lake row is left out, with the reason on the row.
      const dests = a.available ? s.dests : s.dests.map(r => (isLakeRow(r) ? { ...r, leftOut: true } : r));
      return { ...s, dests, lake: { ...s.lake, available: a.available, lakeIds: a.lakeIds, searchIds: a.searchIds, deletingIds: a.deletingIds || [] } };
    }
  }
}

/** Whether the included rows carry a Cribl Lake destination. */
export const lakeIncluded = (s: ValidationState): boolean => s.lake.available !== false && s.dests.some(r => isLakeRow(r) && !r.leftOut);

/**
 * The lake-group format Cribl Lake receives: the one picked on the Lake row, else one
 * picked on another row, else OCSF — or, with a Search dashboard, raw + extracted fields:
 * the dashboard's parsers and KPI fields come from the source's own events, so that is
 * what has to land (spec R19).
 */
export function lakeFormat(s: ValidationState): 'ocsf' | 'raw_fields' | 'passthrough' {
  const picked = s.dests.filter(r => !r.leftOut && r.format && isLakeFormat(r.format))
    .sort((a, b) => Number(isLakeRow(b)) - Number(isLakeRow(a)))
    .map(r => r.format!);
  return (picked[0] as 'ocsf' | 'raw_fields' | 'passthrough') || (s.lake.dashboard ? 'raw_fields' : 'ocsf');
}

/** The sourcetypes and formats the demo will build. */
export function validationPlan(s: ValidationState): { sources: string[]; formats: string[]; lake: { datasetId: string; retentionPeriodInDays: number; format: string; dashboard: boolean } | null } {
  const sources = uniq(s.sources.filter(r => !r.leftOut).flatMap(r => r.picks));
  const formats = uniq(s.dests.filter(r => !r.leftOut && !isCriblRow(r) && !isLakeRow(r) && r.format).map(r => r.format!));
  const lake = lakeIncluded(s) ? { datasetId: s.lake.datasetId, retentionPeriodInDays: s.lake.retentionPeriodInDays, format: lakeFormat(s), dashboard: s.lake.dashboard } : null;
  if (lake && !formats.includes(lake.format)) formats.push(lake.format);
  return { sources, formats, lake };
}

export interface Blocker { rowKey: string; message: string }

/** Everything that stops "Continue", in the words the rows use. Empty = ready. */
export function validationBlockers(s: ValidationState): Blocker[] {
  const out: Blocker[] = [];
  for (const r of s.sources) {
    if (r.leftOut || r.picks.length) continue;
    out.push({
      rowKey: r.key,
      message: r.match.status === 'transport' ? `${r.label} needs a source or to be left out`
        : r.match.status === 'unresolved' ? `${r.label} has no match: search for one or leave it out`
        : `${r.label} needs a pick`,
    });
  }
  for (const r of s.dests) {
    if (r.leftOut || isCriblRow(r) || isLakeRow(r) || r.format) continue;
    out.push({ rowKey: r.key, message: r.match.status === 'hint' ? `${r.label} needs a format: accept the suggestion or pick another` : `${r.label} needs a format or to be left out` });
  }
  if (lakeIncluded(s)) {
    const lakeRow = s.dests.find(r => isLakeRow(r) && !r.leftOut)!;
    if (s.lake.available === null) out.push({ rowKey: lakeRow.key, message: 'Checking Cribl Lake on this organization…' });
    else {
      const d = lakeDatasetDecision(s.lake.datasetId, s.lake.retentionPeriodInDays, s.lake.lakeIds, s.lake.searchIds, s.lake.deletingIds);
      if (!d.ok) out.push({ rowKey: lakeRow.key, message: `Cribl Lake dataset: ${d.message}` });
    }
  }
  const plan = validationPlan(s);
  if (plan.sources.length > DEMO_MAX_SOURCES) out.push({ rowKey: '', message: `${plan.sources.length} sources; the demo takes ${DEMO_MAX_SOURCES}, so leave ${plan.sources.length - DEMO_MAX_SOURCES} out` });
  if (plan.formats.length > DEMO_MAX_FORMATS) out.push({ rowKey: '', message: `${plan.formats.length} formats; the demo takes ${DEMO_MAX_FORMATS}, so leave ${plan.formats.length - DEMO_MAX_FORMATS} out` });
  if (!plan.sources.length && !out.some(b => b.rowKey)) out.push({ rowKey: '', message: 'Pick at least one source' });
  if (!plan.formats.length && !out.some(b => b.rowKey)) out.push({ rowKey: '', message: 'Pick at least one destination format' });
  return out;
}

/** What is saved on the board — decisions only, the matches are recomputed. */
export function toDiscoveryValidation(s: ValidationState, now = new Date()): DiscoveryValidation {
  return {
    intakeFingerprint: s.fingerprint,
    validatedAt: now.toISOString(),
    sources: s.sources.map(r => ({ label: r.label, itemKey: r.key, picks: r.picks, ...(r.leftOut ? { leftOut: true } : {}) })),
    dests: s.dests.map(r => ({
      label: r.label, itemKey: r.key, ...(r.format ? { format: r.format } : {}), ...(r.leftOut ? { leftOut: true } : {}),
      ...(r.match.cribl === 'lakehouse' || r.match.cribl === 'detect' ? { cribl: r.match.cribl } : {}),
    })),
    lake: lakeIncluded(s)
      ? { datasetId: s.lake.datasetId, retentionPeriodInDays: s.lake.retentionPeriodInDays, reuse: s.lake.lakeIds.includes(s.lake.datasetId), format: lakeFormat(s), dashboard: s.lake.dashboard }
      : null,
  };
}

/** The SE's changes worth remembering: only rows they changed and asked to remember. */
export function aliasesToRemember(s: ValidationState, now = new Date()): DiscoveryAliases {
  const savedAt = now.toISOString();
  const out: DiscoveryAliases = { sources: {}, dests: {} };
  for (const r of s.sources) if (!r.leftOut && r.changed && r.remember && r.picks.length) out.sources[normWords(r.label)] = { picks: r.picks, savedAt };
  for (const r of s.dests) {
    // A learned format is matched before Cribl Lake, so remembering one would make the Lake row a plain format.
    if (r.leftOut || !r.remember || !r.format || isLakeRow(r)) continue;
    if (r.changed || r.match.status === 'hint' || r.match.status === 'unresolved') out.dests[normWords(r.label)] = { format: r.format, savedAt };
  }
  return out;
}

export function mergeAliases(into: DiscoveryAliases | undefined, add: DiscoveryAliases): DiscoveryAliases {
  return { sources: { ...(into?.sources || {}), ...add.sources }, dests: { ...(into?.dests || {}), ...add.dests } };
}

export type { SourceCandidate, DestCandidate };
