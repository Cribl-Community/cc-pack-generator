/**
 * Cribl Stream pipelines for Goatpedia optimizations — a TypeScript port of the Goatpedia
 * site's site/stream.js (wvdlinde-cribl/goatpedia), so the app shows exactly the pipeline the
 * site shows and Cribl checked. Keep it in step with that file.
 *
 * An optimization may carry `stream` (exact Stream functions, route table or note) and
 * `verified` (the result of running the pipeline in Cribl's preview on the article's sample).
 */

export interface StreamFunction { id: string; filter?: string; description?: string; final?: boolean; conf?: Record<string, unknown> }
export interface StreamRoute { name: string; filter: string; to: string; final?: boolean }
export interface StreamBlock {
  log?: string;
  parse?: boolean;
  functions?: StreamFunction[];
  serialize?: boolean;
  routes?: StreamRoute[];
  note?: string;
  test?: string[];
  expect?: Record<string, unknown>;
}
export interface StreamCheck { checked: string; group: string; ok: boolean; in: { events: number; bytes: number }; out: { events: number; bytes: number }; problems?: string[] }
export interface StreamLog { type: string; format: string; fields?: string[]; pattern?: string }
export interface StreamOptimization { title: string; stream?: StreamBlock; verified?: StreamCheck }
export interface StreamEntry { logs?: StreamLog[] }

export const FUNCTION_NAMES: Record<string, string> = {
  serde: 'Parser', regex_extract: 'Regex Extract', eval: 'Eval', drop: 'Drop', suppress: 'Suppress', aggregation: 'Aggregations',
  sampling: 'Sampling', dynamic_sampling: 'Dynamic Sampling', serialize: 'Serialize', mask: 'Mask', rename: 'Rename', lookup: 'Lookup',
  unroll: 'Unroll', flatten: 'Flatten', numerify: 'Numerify', comment: 'Comment',
};
const FORMATS: Record<string, string> = { csv: 'CSV', tsv: 'TSV', kv: 'key=value', json: 'JSON', cef: 'CEF', leef: 'LEEF', xml: 'XML', text: 'text' };

export function logOf(entry: StreamEntry, stream: StreamBlock): StreamLog | undefined {
  return (entry.logs || []).find((l) => l.type === stream.log) || (entry.logs || [])[0];
}

const regexLiteral = (pattern: string) => (/^\/.*\/[a-z]*$/.test(pattern) ? pattern : `/${pattern}/`);

/** How Stream reads this log's format, using the article's own field list or pattern. */
export function parseStep(log: StreamLog): StreamFunction[] {
  const d = (text: string) => `Parse the ${log.type} log (${FORMATS[log.format] || log.format})${text ? ` ${text}` : ''}`;
  switch (log.format) {
    case 'csv':
      return [{ id: 'serde', filter: 'true', description: d(`into its ${(log.fields || []).length} columns`), conf: { mode: 'extract', type: 'csv', srcField: '_raw', fields: log.fields } }];
    case 'tsv':
      return [{ id: 'serde', filter: 'true', description: d(`into its ${(log.fields || []).length} columns`), conf: { mode: 'extract', type: 'delim', srcField: '_raw', delimChar: '\t', fields: log.fields } }];
    case 'json':
      return [{ id: 'serde', filter: 'true', description: d('into fields'), conf: { mode: 'extract', type: 'json', srcField: '_raw' } }];
    case 'kv':
      return [{ id: 'serde', filter: 'true', description: d('into fields'), conf: { mode: 'extract', type: 'kvp', srcField: '_raw' } }];
    case 'text':
      return log.pattern ? [{ id: 'regex_extract', filter: 'true', description: d('with its pattern'), conf: { source: '_raw', regex: regexLiteral(log.pattern) } }] : [];
    default:
      return [];
  }
}

/** Write the event back in its original format, so the destination still gets what it expects. */
export function serializeStep(log: StreamLog): StreamFunction[] {
  switch (log.format) {
    case 'csv':
    case 'tsv':
      return [{ id: 'serialize', filter: 'true', description: `Write the ${log.type} log back as ${FORMATS[log.format]}, same column order (removed fields stay as empty columns)`, conf: { type: log.format === 'csv' ? 'csv' : 'delim', delimChar: log.format === 'tsv' ? '\t' : undefined, dstField: '_raw', fields: log.fields } }];
    case 'json':
      return [{ id: 'serialize', filter: 'true', description: `Write the ${log.type} log back as JSON`, conf: { type: 'json', dstField: '_raw', fields: ['!_*', '!cribl_*', '!__*', '*'] } }];
    case 'kv':
      return [{ id: 'serialize', filter: 'true', description: `Write the ${log.type} log back as key=value`, conf: { type: 'kvp', dstField: '_raw', fields: ['!_*', '!cribl_*', '!__*', '*'] } }];
    default:
      return [];
  }
}

function clean(fn: StreamFunction): StreamFunction {
  const out: StreamFunction = { id: fn.id, filter: fn.filter == null ? 'true' : fn.filter };
  if (fn.description) out.description = fn.description;
  if (fn.final) out.final = true;
  const conf: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fn.conf || {})) if (v !== undefined) conf[k] = v;
  out.conf = conf;
  return out;
}

export interface Pipeline { functions: StreamFunction[]; parseCount: number; serializeCount: number }

/** The full pipeline for one optimization: parse, the optimization, and (optionally) serialize. */
export function pipelineFor(entry: StreamEntry, opt: StreamOptimization): Pipeline | null {
  const s = opt.stream;
  if (!s || !s.functions || !s.functions.length) return null;
  const log = logOf(entry, s);
  if (!log) return null;
  const parse = s.parse === false ? [] : parseStep(log);
  const ser = s.serialize ? serializeStep(log) : [];
  return { functions: [...parse, ...s.functions, ...ser].map(clean), parseCount: parse.length, serializeCount: ser.length };
}

/** One line per step, for the article (the same text as the site). */
export function describe(fn: StreamFunction): string {
  const c = (fn.conf || {}) as Record<string, any>;
  const name = FUNCTION_NAMES[fn.id] || fn.id;
  const when = fn.filter && fn.filter !== 'true' ? ` when ${fn.filter}` : '';
  switch (fn.id) {
    case 'drop': return `${name}${when}`;
    case 'eval': return `${name}${when}: ${[...(c.add || []).map((a: { name: string }) => `set ${a.name}`), ...((c.remove || []).length ? [`remove ${c.remove.join(', ')}`] : [])].join('; ')}`;
    case 'suppress': return `${name}${when}: keep ${c.allow} per ${c.suppressPeriodSec} s for each ${c.keyExpr}`;
    case 'aggregation': return `${name}${when}: ${(c.aggregations || []).join(', ')} by ${(c.groupbys || []).join(', ')} every ${c.timeWindow}`;
    case 'sampling': return `${name}: ${(c.rules || []).map((r: { filter: string; rate: number }) => `keep 1 in ${r.rate} when ${r.filter}`).join('; ')}`;
    default: return fn.description || `${name}${when}`;
  }
}

/** The pipeline JSON to paste, and the same without the parse and serialize steps. */
export function copyTexts(p: Pipeline): { all: string; own: string } {
  return {
    all: JSON.stringify({ functions: p.functions }, null, 2),
    own: JSON.stringify({ functions: p.functions.slice(p.parseCount, p.functions.length - p.serializeCount) }, null, 2),
  };
}

export const measuredPct = (v: StreamCheck) => (v.in.bytes ? Math.round((1 - v.out.bytes / v.in.bytes) * 100) : 0);
export const kb = (b: number) => (b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
