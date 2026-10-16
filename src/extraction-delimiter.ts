// A deterministic backstop over the AI extraction path. The model is told to use
// a `serde type:"csv"` for delimited logs, but the CSV serde defaults `delimChar`
// to a comma. Run a comma serde against a TAB-delimited record (Zscaler ZIA TSV is
// the canonical case) and it never splits: the whole line collapses into the first
// declared column, every downstream field is empty, and mapping has nothing to
// read. The scoring report for such a pack shows one giant field holding the raw
// line — "everything caught as 1 field".
//
// This corrects that after generation, without relying on the model getting the
// delimiter right: if a csv serde's own delimiter fails to split the sample but a
// structural delimiter (tab, pipe, semicolon) cleanly does, switch to it. It is
// deliberately conservative — it only acts when the current delimiter yields a
// single field, so a serde that already parses is never touched, and space is NOT
// a candidate (it appears incidentally in free-text log bodies and would
// over-split a comma record).

interface SerdeLikeConf {
  mode?: string;
  type?: string;
  srcField?: string;
  delimChar?: string;
  [k: string]: unknown;
}
interface FnLike {
  id?: string;
  conf?: SerdeLikeConf;
  [k: string]: unknown;
}

// Structural delimiters, in preference order. A real tab character; JSON.stringify
// serialises it to "\t" and Cribl reads it back as a tab, which is what the serde
// wants. Comma is intentionally absent — it is the default we are trying to repair.
const CANDIDATE_DELIMS = ['\t', '|', ';'];

function medianFieldCount(lines: string[], delim: string): number {
  if (!lines.length) return 0;
  const counts = lines.map(l => l.split(delim).length).sort((a, b) => a - b);
  return counts[Math.floor(counts.length / 2)];
}

/**
 * Return `functions` with any collapsing csv serde's `delimChar` corrected.
 * Pure: never mutates the input array or its objects; returns new objects only
 * for the entries it changes.
 */
export function repairDelimitedSerde<T extends FnLike>(functions: T[], sampleLines: string[]): T[] {
  if (!Array.isArray(functions)) return functions;
  const lines = (sampleLines || [])
    .filter(l => typeof l === 'string' && l.trim().length > 0)
    .slice(0, 20);
  if (lines.length === 0) return functions;

  return functions.map(fn => {
    if (!fn || fn.id !== 'serde') return fn;
    const conf = fn.conf || {};
    // Extract mode only (default is extract), csv type, parsing the raw line.
    if (conf.mode && conf.mode !== 'extract') return fn;
    if (conf.type !== 'csv') return fn;
    const src = conf.srcField || '_raw';
    if (src !== '_raw') return fn;

    const current = conf.delimChar || ',';
    if (medianFieldCount(lines, current) >= 2) return fn; // already splits — leave it

    let best = current;
    let bestCount = medianFieldCount(lines, current);
    for (const cand of CANDIDATE_DELIMS) {
      if (cand === current) continue;
      const c = medianFieldCount(lines, cand);
      if (c > bestCount) { best = cand; bestCount = c; }
    }
    if (best === current || bestCount < 2) return fn; // no better structural delimiter

    return { ...fn, conf: { ...conf, delimChar: best } };
  });
}

// Live (packtester 2026-10-12): serde `type:"csv"` IGNORES delimChar and always
// splits on commas, so a tab/pipe/space csv serde collapses the line into its
// first column (Ironport WSA scored 0). `type:"delim"` honours it, but splits on
// every single character: Squid pads its duration column with spaces, so for a
// space delimiter the serde reads a copy with each run collapsed.
const DELIM_SRC = '__delim_src';

/** Rewrite every non-comma csv serde as `delim` (one extra eval for a space delimiter). */
export function csvToDelimSerde<T extends FnLike>(functions: T[]): T[] {
  if (!Array.isArray(functions)) return functions;
  const out: T[] = [];
  for (const fn of functions) {
    const conf = fn?.conf;
    const d = conf?.delimChar;
    if (!fn || fn.id !== 'serde' || !conf || conf.type !== 'csv' || (conf.mode && conf.mode !== 'extract') || typeof d !== 'string' || d === '' || d === ',') {
      out.push(fn);
      continue;
    }
    const next: SerdeLikeConf = { ...conf, type: 'delim', quoteChar: conf.quoteChar || '"', escapeChar: conf.escapeChar || '\\', nullValue: conf.nullValue || '-' };
    if (d === ' ') {
      const src = String(conf.srcField || '_raw');
      const read = /^[A-Za-z_$][\w$]*$/.test(src) ? src : `__e['${src.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
      out.push({
        id: 'eval',
        filter: (fn as any).filter,
        description: 'Collapse runs of spaces for the space-delimited parse',
        conf: { add: [{ name: DELIM_SRC, value: `${read} != null ? String(${read}).trim().replace(/ {2,}/g, ' ') : undefined` }] },
      } as unknown as T);
      next.srcField = DELIM_SRC;
    }
    out.push({ ...fn, conf: next });
  }
  return out;
}
