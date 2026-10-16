/**
 * What a finished pipeline is made of, for the efficiency review.
 *
 * A pipeline that runs two Parser (`serde`) functions, or a chain of
 * `regex_extract` functions, is often doing the same work twice. These counts
 * make that visible per pipeline — in the batch results export, the build-trace
 * AI summary and the score telemetry — without anyone opening the pipeline.
 *
 * Pure and import-free: the staged builder (also bundled into Backend
 * Functions) and the UI both call it.
 */

/** Functions that pull fields out of the event — the "parser" work. */
const EXTRACTOR_IDS = new Set(['serde', 'regex_extract', 'grok']);

export interface FunctionComposition {
  /** Enabled functions that do work (a `comment` function does none). */
  total: number;
  /** Functions present but switched off. */
  disabled: number;
  /** Enabled functions per Cribl function id, e.g. `{ eval: 5, serde: 2 }`. */
  byType: Record<string, number>;
  regexExtract: number;
  /** Cribl's Parser function. */
  serde: number;
  code: number;
  /**
   * Extractors (serde / regex_extract / grok) with no filter or `filter: 'true'`
   * — they run on EVERY event, so a variant-specific parser that is not gated
   * does its work on traffic it cannot parse.
   */
  ungatedExtractors: number;
  /** More than one `regex_extract`. */
  multiRegex: boolean;
  /** More than one Parser (`serde`). */
  multiParser: boolean;
}

const isUngated = (filter: unknown): boolean =>
  filter == null || (typeof filter === 'string' && (filter.trim() === '' || filter.trim() === 'true'));

export function functionComposition(fns: readonly unknown[] | null | undefined): FunctionComposition {
  const byType: Record<string, number> = {};
  let total = 0;
  let disabled = 0;
  let ungatedExtractors = 0;
  for (const fn of fns ?? []) {
    const f = (fn && typeof fn === 'object' ? fn : {}) as { id?: unknown; disabled?: unknown; filter?: unknown };
    if (f.disabled === true) { disabled++; continue; }
    const id = typeof f.id === 'string' && f.id ? f.id : 'unknown';
    byType[id] = (byType[id] ?? 0) + 1;
    if (id !== 'comment') total++;
    if (EXTRACTOR_IDS.has(id) && isUngated(f.filter)) ungatedExtractors++;
  }
  const regexExtract = byType.regex_extract ?? 0;
  const serde = byType.serde ?? 0;
  return {
    total,
    disabled,
    byType,
    regexExtract,
    serde,
    code: byType.code ?? 0,
    ungatedExtractors,
    multiRegex: regexExtract > 1,
    multiParser: serde > 1,
  };
}

/** `eval×5 serde×2 regex_extract` — most frequent first, ties by name. */
export function formatFunctionTypes(byType: Record<string, number>): string {
  return Object.entries(byType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, n]) => (n > 1 ? `${id}×${n}` : id))
    .join(' ');
}

/**
 * The composition as flat telemetry fields. Flat scalars on purpose: the score
 * dataset is queried with `summarize … by`, which cannot group on a nested map.
 */
export function functionCompositionTelemetry(c: FunctionComposition): {
  function_total: number;
  function_types: string;
  regex_extract_count: number;
  serde_count: number;
  code_count: number;
  ungated_extractor_count: number;
  multi_regex: boolean;
  multi_parser: boolean;
} {
  return {
    function_total: c.total,
    function_types: formatFunctionTypes(c.byType),
    regex_extract_count: c.regexExtract,
    serde_count: c.serde,
    code_count: c.code,
    ungated_extractor_count: c.ungatedExtractors,
    multi_regex: c.multiRegex,
    multi_parser: c.multiParser,
  };
}
