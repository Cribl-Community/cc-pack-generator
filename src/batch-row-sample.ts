/**
 * A batch row's own sample, chosen per row in the pre-flight.
 *
 * The CSV has no sample column: one line of sample is not enough to build a
 * parser from. Each pre-flight row opens the sample picker (the sanitizer's
 * pick mode) and takes the library sample, a saved sanitised sample, or the
 * user's own events. `fitBatchRowSample` bounds what a row keeps, because the
 * rows are checkpointed. When a row has a sample, that text comes before every
 * store tier, and the app works out the format from it the way the single
 * wizard does. The user never names a format.
 *
 * Three rules live here so the upload screen, the pre-flight, the foreground
 * build and the background manifest cannot disagree:
 *
 * - ONE flattening rule. The cell goes through `flattenEventsToLines`, the rule
 *   every catalog sample goes through, so a pasted JSON object is compacted
 *   exactly like a stored one. A literal `\n` inside the cell is NOT decoded: it
 *   would corrupt a JSON event whose strings contain `\n`.
 * - ONE cache identity. Store samples are cached per sourcetype. A row sample is
 *   keyed by a hash of its TEXT (`batchSampleKey`), so two rows of the same
 *   sourcetype with different lines never share, or replace, a sample. The key
 *   leaves the sourcetype out on purpose: the pre-flight may still rename the
 *   row (content classification, an inline edit) after the sample is cached,
 *   and a renamed row must not lose its own events.
 * - ONE pack sample per sourcetype. A pack stores `<sourcetype>_sample.log` and
 *   upserts it by name, so two rows of the same pack and sourcetype with
 *   different samples would overwrite each other (and share one route filter).
 *   That is an upload error (`findBatchSampleConflicts`), not a silent merge.
 *
 * A row sample is treated as the user's own data: it builds with `sourceMode: 'paste'`
 * (`BATCH_ROW_SAMPLE_SOURCE_MODE`), so Settings → "Require sanitised samples"
 * keeps it away from the AI provider unless the picker marked it sanitised.
 * The picker marks a sanitised result, a saved sample and a library sample as sanitised.
 *
 * `readBatchSampleCell` still reads a `sample` value for the probe script and
 * JSON callers; the batch upload screen no longer reads one.
 */
import { toKebab } from './pack-builder';
import { flattenEventsToLines } from './sample-library';
import { canonicalizeSourcetype, normalizeSourcetypeName } from './source-recognition';

/** A row sample is a sample, not a log file. Measured in UTF-8 bytes of the flattened text. */
export const BATCH_SAMPLE_MAX_BYTES = 64 * 1024;

/** The most events a picked row sample keeps. */
export const BATCH_PICK_MAX_EVENTS = 100;

export interface FittedRowSample {
  /** One event per line; '' when not even the first event fits. */
  text: string;
  kept: number;
  total: number;
  error?: string;
}

/**
 * Bound a picked sample to what a row can carry. Keeps whole events from the
 * top, at most `BATCH_PICK_MAX_EVENTS` and `BATCH_SAMPLE_MAX_BYTES`. Never cuts
 * an event in half: a truncated line no longer parses as its source.
 */
export function fitBatchRowSample(events: readonly string[]): FittedRowSample {
  // One event per line, like flattenEventsToLines, minus its outer-quote strip
  // (that would corrupt a quoted CSV line). A multi-line event (pretty JSON,
  // an XML record) stays ONE event: compact JSON, else collapsed whitespace —
  // splitting it would turn one record into fragments.
  const lines = events.flatMap(event => {
    const text = String(event ?? '').trim();
    if (!text) return [];
    if (text.indexOf('\n') === -1) return [text];
    if (/^[{[]/.test(text)) {
      try { return [JSON.stringify(JSON.parse(text))]; } catch { /* not valid JSON */ }
    }
    return [text.replace(/\r?\n\s*/g, ' ')];
  });
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= BATCH_PICK_MAX_EVENTS) break;
    const size = encoder.encode(line).length + (kept.length ? 1 : 0);
    if (bytes + size > BATCH_SAMPLE_MAX_BYTES) break;
    kept.push(line);
    bytes += size;
  }
  if (!kept.length && lines.length) {
    return {
      text: '', kept: 0, total: lines.length,
      error: `the first event alone is over ${BATCH_SAMPLE_MAX_BYTES / 1024} KB`,
    };
  }
  return { text: kept.join('\n'), kept: kept.length, total: lines.length };
}

/** The source mode a row sample carries into the build: the user's own events. */
export const BATCH_ROW_SAMPLE_SOURCE_MODE = 'paste';

export interface BatchSampleCell {
  /** One event per line; '' when the cell is empty or invalid. */
  sample: string;
  error?: string;
}

/**
 * Read a row's `sample` value into build text. A CSV cell and a JSON string
 * field are ONE event; a JSON array is one event per element; a JSON object is
 * one event.
 */
export function readBatchSampleCell(value: unknown): BatchSampleCell {
  if (value == null) return { sample: '' };
  let text: string;
  if (typeof value === 'string') {
    if (!value.trim()) return { sample: '' };
    text = flattenEventsToLines([value]);
  } else if (Array.isArray(value)) {
    text = flattenEventsToLines(value);
  } else if (typeof value === 'object') {
    text = flattenEventsToLines([value]);
  } else {
    return { sample: '', error: `sample must be text, a JSON object or an array of events (got ${typeof value})` };
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > BATCH_SAMPLE_MAX_BYTES) {
    return {
      sample: '',
      error: `sample is ${Math.ceil(bytes / 1024)} KB; the limit is ${BATCH_SAMPLE_MAX_BYTES / 1024} KB (one or a few events, not a log file)`,
    };
  }
  return { sample: text };
}

/** FNV-1a, 32-bit, hex, from a given offset basis. */
function fnv1a(text: string, basis: number): string {
  let hash = basis;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/**
 * Content identity for a cache key, not a security property: two FNV-1a passes
 * from different bases (64 bits) plus the length, so two rows' samples cannot
 * plausibly collide and silently share one set of events. KV-path safe
 * (`[0-9a-z-]`), which the background runner's reuse key relies on.
 */
export function sampleContentId(text: string): string {
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x050c5d1f)}-${text.length.toString(36)}`;
}

// `#` never occurs in a batch sourcetype (App.tsx validateSourcetypeString rejects it), so a row key
// cannot collide with a store key.
const ROW_SAMPLE_PREFIX = 'row-sample#';

/**
 * The key a row's sample is cached under. No row sample → the sourcetype itself,
 * the key every store-resolved sample has always used.
 */
export function batchSampleKey(sourcetype: string, sample?: string): string {
  return sample ? `${ROW_SAMPLE_PREFIX}${sampleContentId(sample)}` : sourcetype;
}

/**
 * The name a batch row's SAMPLE is resolved under. A Windows channel name
 * (`XmlWinEventLog:System`, `WinEventLog:Microsoft-Windows-Sysmon/Operational`)
 * carries what its canonical name drops: the channel, and whether the events
 * are XML or classic text. The sample resolver routes those by the raw string,
 * so they resolve by it. Cisco FTD / Firepower canonicalize onto `cisco_asa`
 * for the parser (same LINA syslog layout) but are their own source with their
 * own `%FTD-` sample, so they resolve by their normalized raw name — otherwise
 * an FTD pack is built and scored on ASA events. Every other source resolves by
 * its canonical name.
 * `raw` is the name as the CSV wrote it, which the pre-flight keeps as
 * `outputSourcetype` after it canonicalizes `sourcetype` — so a batch row must
 * pass `row.outputSourcetype || row.sourcetype`, never the canonical field alone.
 */
export function batchSampleSourcetype(raw: string | undefined, canonical: string): string {
  const name = String(raw || '').trim();
  if (/wineventlog|winevent/i.test(name)) return name;
  if (/ftd|firepower/i.test(name)) return normalizeSourcetypeName(name);
  return canonical;
}

/** Whether a sample key names a row's own sample rather than a sourcetype's. */
export function isRowSampleKey(key: string): boolean {
  return key.startsWith(ROW_SAMPLE_PREFIX);
}

export interface BatchSampleConflict {
  /** 0-based index of the row that conflicts. */
  row: number;
  /** 0-based index of the earlier row it conflicts with. */
  firstRow: number;
  packId: string;
  sourcetype: string;
}

/**
 * Rows that would overwrite another row's pack sample: same pack, same
 * (canonical) sourcetype, different `sample` text. An empty cell counts as its
 * own value, because that row uploads the catalog sample under the same name.
 */
export function findBatchSampleConflicts(
  rows: ReadonlyArray<{ pack_name: string; sourcetype: string; sample?: string }>,
): BatchSampleConflict[] {
  const first = new Map<string, { row: number; sample: string }>();
  const out: BatchSampleConflict[] = [];
  rows.forEach((row, i) => {
    const packId = toKebab(row.pack_name || '');
    const sourcetype = canonicalizeSourcetype(row.sourcetype || '');
    const key = `${packId}\u0000${sourcetype}`;
    const sample = row.sample || '';
    const seen = first.get(key);
    if (!seen) first.set(key, { row: i, sample });
    else if (seen.sample !== sample) out.push({ row: i, firstRow: seen.row, packId, sourcetype });
  });
  return out;
}

/** The upload-screen message for a conflict (rows numbered from 1). */
export function batchSampleConflictMessage(c: BatchSampleConflict): string {
  return `Row ${c.row + 1}: pack "${c.packId}" already has a ${c.sourcetype} row (row ${c.firstRow + 1}) with a different sample. `
    + `A pack stores one ${c.sourcetype}_sample.log, so this row would overwrite that row's sample. Put each sample variant in its own pack.`;
}
