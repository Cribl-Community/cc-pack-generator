/**
 * The batch file reader: CSV text → one record per data row.
 *
 * Shared by the batch upload screen and `npm run batch:probe`, so the probe
 * reads a batch file exactly as the app does. Pure and import-free.
 *
 * Quoting is RFC 4180: a cell holding a comma or a quote is quoted, and a quote
 * inside it is doubled. Records are split on line breaks OUTSIDE quotes, so a
 * quoted cell that still holds a line break stays one record, and that record
 * is flagged. Every sample the app builds from is one line per event
 * (`flattenEventsToLines`), and Cribl re-breaks a sample on newlines, so a cell
 * holding a pasted multi-line event is a paste mistake. The old reader split the
 * file on newlines before reading quotes, which turned such a cell into several
 * garbage rows with no error.
 */

export interface BatchCsv {
  /** Normalized header names: lowercased, anything but a-z and `_` removed. */
  headers: string[];
  /** One record per data row, cells trimmed, keyed by header. */
  rows: Record<string, string>[];
  /** Problems found while reading, keyed by 0-based data-row index. */
  rowErrors: Record<number, string[]>;
  /** Problems with the file as a whole (for example an unterminated quote). */
  fileErrors: string[];
}

export const normalizeBatchHeader = (h: string): string => h.trim().toLowerCase().replace(/[^a-z_]/g, '');

/**
 * Parse a single CSV line with quote awareness: commas inside double-quoted
 * fields (e.g. a Cribl filter like sourcetype=='x',source=='y') are preserved,
 * and "" inside a quoted field is an escaped quote. A naive split(',') would
 * corrupt any row whose values contain commas.
 */
export function parseCsvLine(line: string): string[] {
  return readCsvRecords(line).records[0]?.cells ?? [''];
}

interface CsvRecord {
  cells: string[];
  /** Indexes of the cells that were quoted and held a line break. */
  brokenCells: number[];
}

function readCsvRecords(text: string): { records: CsvRecord[]; unterminated: boolean } {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let brokenCells: number[] = [];
  let field = '';
  let inQuotes = false;
  let fieldHasBreak = false;
  const endField = () => {
    if (fieldHasBreak) brokenCells.push(cells.length);
    cells.push(field);
    field = '';
    fieldHasBreak = false;
  };
  const endRecord = () => {
    endField();
    records.push({ cells, brokenCells });
    cells = [];
    brokenCells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        if (c === '\n' || c === '\r') fieldHasBreak = true;
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n') {
      endRecord();
    } else if (c === '\r') {
      // CRLF: the \n ends the record; a bare \r is dropped like trailing space.
    } else {
      field += c;
    }
  }
  if (field || cells.length || inQuotes) endRecord();
  return { records, unterminated: inQuotes };
}

export function parseBatchCsv(content: string): BatchCsv {
  const { records, unterminated } = readCsvRecords(String(content).replace(/^\uFEFF/, ''));
  // A line holding nothing but separators or spaces is not a row.
  const meaningful = records.filter(r => r.cells.some(c => c.trim()));
  const fileErrors: string[] = [];
  if (unterminated) fileErrors.push('A quoted cell is never closed: a " is missing somewhere in the file.');
  if (meaningful.length === 0) return { headers: [], rows: [], rowErrors: {}, fileErrors };
  const headers = meaningful[0].cells.map(normalizeBatchHeader);
  const rows: Record<string, string>[] = [];
  const rowErrors: Record<number, string[]> = {};
  meaningful.slice(1).forEach((record, index) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (record.cells[i] || '').trim(); });
    rows.push(row);
    if (record.brokenCells.length) {
      const names = record.brokenCells.map(i => headers[i] || `column ${i + 1}`);
      rowErrors[index] = [
        `${names.join(', ')} holds a line break: put each event on one line (replace its line breaks with a space, or paste JSON compacted)`,
      ];
    }
  });
  return { headers, rows, rowErrors, fileErrors };
}

/** Quote a cell the way `parseBatchCsv` reads it: commas, quotes and line breaks are quoted, and a quote inside is doubled. */
export function formatCsvCell(value: string): string {
  const text = value ?? '';
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One CSV document. Header order is the caller's; missing cells are empty. */
export function formatBatchCsv(headers: string[], rows: ReadonlyArray<Record<string, string>>): string {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => formatCsvCell(row[h] ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}
