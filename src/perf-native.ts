/**
 * Native performance mode: a cleaner pipeline from standard Functions only (no Code functions).
 *
 *  1. Consecutive evals are merged into one (a filter-less eval without remove/keep, followed by
 *     another filter-less eval: the adds run in the same order, the second one's remove/keep last).
 *     Exact for every event, so it needs no knowledge of the data.
 *  2. With the vendor field library (see vendor-field-library.ts), `||` fallbacks are removed:
 *     - CONFIRMED anchor (any entry, open or closed): a chain that reads a field the entry lists
 *       keeps that field and drops the field operands around it that are not confirmed. Dropped
 *       only when not listed, not seen on a build, not a common field and not written by the
 *       pipeline before that point. A chain without a confirmed field keeps all its fallbacks.
 *     - CLOSED entry: also removes, in any chain, the field operands the reviewed list proves the
 *       source never carries.
 *     Removal assumes the source carries no field outside the library's knowledge; for an open
 *     entry that is the vendor's documented field set, and a field seen on a build is never dropped.
 *
 * Merging is exact for every event; removal is exact for every event the library describes. Pruning
 * stays off as soon as the pipeline holds a Function whose output fields cannot be listed (Code,
 * flatten, a lookup without output fields, a dynamic regex, ...).
 */
import { GLOBALS, MISSING_GLOBALS, parseExpression, Refuse, type ExprNode as Node } from './perf-compile';
import type { PipelineFunction } from './source-recognition';
import { pathCovered } from './vendor-field-library';

export const NATIVE_MARKER = 'Performance mode (native):';

// ---------------------------------------------------------------------------------------------
// Printing (eval source). Parentheses in the source are kept as `paren` nodes, so printing the
// tree without adding any reproduces the original precedence.

function print(n: Node): string {
  switch (n.t) {
    case 'lit': return n.code;
    case 'id': return n.name;
    case 'paren': return `(${print(n.e)})`;
    case 'spread': return `...${print(n.arg)}`;
    case 'tpl': {
      let s = '`' + n.parts[0];
      n.exprs.forEach((x, i) => { s += '${' + print(x) + '}' + n.parts[i + 1]; });
      return s + '`';
    }
    case 'arr': return `[${n.items.map(print).join(', ')}]`;
    case 'obj': return `{${n.props.map(p => ('spread' in p ? `...${print(p.spread)}`
      : `${p.computed ? `[${print(p.computed)}]` : p.key}: ${print(p.value)}`)).join(', ')}}`;
    case 'mem': return `${print(n.obj)}.${n.prop}`;
    case 'idx': return `${print(n.obj)}[${print(n.index)}]`;
    case 'call': return `${print(n.callee)}(${n.args.map(print).join(', ')})`;
    case 'new': return `new ${print(n.callee)}(${n.args.map(print).join(', ')})`;
    case 'un': {
      const arg = print(n.arg);
      const space = /^[a-z]/.test(n.op) || ((n.op === '-' || n.op === '+') && arg[0] === n.op);
      return `${n.op}${space ? ' ' : ''}${arg}`;
    }
    case 'bin': return n.op === ',' ? `${print(n.l)}, ${print(n.r)}` : `${print(n.l)} ${n.op} ${print(n.r)}`;
    case 'cond': return `${print(n.test)} ? ${print(n.a)} : ${print(n.b)}`;
  }
}

/** Parse, or null when the expression is outside the parser's subset or does not print back to the same tree. */
function parseRoundTrip(src: string): Node | null {
  try {
    const ast = parseExpression(src);
    return JSON.stringify(parseExpression(print(ast))) === JSON.stringify(ast) ? ast : null;
  } catch (err) {
    if (err instanceof Refuse) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Chains and field references

const unparen = (n: Node): Node => (n.t === 'paren' ? unparen(n.e) : n);
const isEventRoot = (n: Node) => n.t === 'id' && n.name === '__e';
const isFieldId = (n: Node) => n.t === 'id' && n.name !== '__e' && n.name !== 'C' && !n.name.startsWith('$')
  && !GLOBALS.has(n.name) && !MISSING_GLOBALS.has(n.name);

/** A plain read of an event field: `x`, `x.y`, `__e.x`, `__e['x-y']`, `x[0]`. */
function isFieldRef(node: Node): boolean {
  const n = unparen(node);
  if (isFieldId(n)) return true;
  if (n.t === 'mem') return isFieldId(unparen(n.obj)) || isEventRoot(unparen(n.obj)) || isFieldRef(n.obj);
  if (n.t === 'idx') {
    const k = unparen(n.index);
    const literalKey = k.t === 'lit' && /^['"\d]/.test(k.code);
    return literalKey && (isEventRoot(unparen(n.obj)) || isFieldRef(n.obj));
  }
  return false;
}

// Calls that change their receiver or arguments: never evaluate such an expression twice.
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  'assign', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'set', 'delete', 'add', 'clear']);

function hasMutatingCall(n: Node): boolean {
  let found = false;
  walk(n, x => { if (x.t === 'call' && unparen(x.callee).t === 'mem' && MUTATORS.has((unparen(x.callee) as { prop: string }).prop)) found = true; });
  return found;
}

function children(n: Node): Node[] {
  switch (n.t) {
    case 'lit': case 'id': return [];
    case 'paren': return [n.e];
    case 'spread': return [n.arg];
    case 'tpl': return n.exprs;
    case 'arr': return n.items;
    case 'obj': return n.props.flatMap(p => ('spread' in p ? [p.spread] : [...(p.computed ? [p.computed] : []), p.value]));
    case 'mem': return [n.obj];
    case 'idx': return [n.obj, n.index];
    case 'call': case 'new': return [n.callee, ...n.args];
    case 'un': return [n.arg];
    case 'bin': return [n.l, n.r];
    case 'cond': return [n.test, n.a, n.b];
  }
}

function walk(n: Node, fn: (x: Node) => void) { fn(n); for (const c of children(n)) walk(c, fn); }

/** Operands of the `||` chain rooted at `n` (left-nested `a || b || c`, not through parentheses). */
function chainOperands(n: Node): Node[] {
  return n.t === 'bin' && n.op === '||' ? [...chainOperands(n.l), ...chainOperands(n.r)] : [n];
}

interface Chain { root: Node; operands: Node[]; first: number }

/** Every `||` chain in the tree, outermost first; `first` is its first operand's slot in the probe. */
function findChains(ast: Node): Chain[] {
  const chains: Chain[] = [];
  let slot = 0;
  const visit = (n: Node) => {
    if (n.t === 'bin' && n.op === '||') {
      const operands = chainOperands(n);
      chains.push({ root: n, operands, first: slot });
      slot += operands.length;
      operands.forEach(visit);
      return;
    }
    children(n).forEach(visit);
  };
  visit(ast);
  return chains;
}

/** Count of `||` operators in an expression (unparsable: counted in the source text). */
export function countOr(src: string): number {
  try {
    let c = 0;
    walk(parseExpression(src), x => { if (x.t === 'bin' && x.op === '||') c++; });
    return c;
  } catch {
    return (src.match(/\|\|/g) || []).length;
  }
}

export function pipelineOrCount(functions: PipelineFunction[]): number {
  let c = 0;
  for (const f of functions) {
    if (f.disabled) continue;
    if (f.filter) c += countOr(String(f.filter));
    if (f.id === 'eval') for (const a of (f.conf as { add?: { value?: string }[] })?.add || []) c += countOr(String(a.value ?? ''));
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Static prune

/** The field path a plain reference reads (`a.b`, `__e['x-y']`, `a[0].b` → `a.b`), or null. */
function refPath(node: Node): string[] | null {
  const n = unparen(node);
  if (isEventRoot(n)) return [];
  if (n.t === 'id') return isFieldId(n) ? [n.name] : null;
  if (n.t === 'mem') { const p = refPath(n.obj); return p && [...p, n.prop]; }
  if (n.t === 'idx') {
    const p = refPath(n.obj);
    const k = unparen(n.index);
    if (!p || k.t !== 'lit') return null;
    if (/^\d+$/.test(k.code)) return p.length ? p : null;   // array element: same path as the array
    const m = /^(['"])([^'"\\]*)\1$/.exec(k.code);
    return m ? [...p, m[2]] : null;
  }
  return null;
}

type AddEntry = { name?: string; value?: string; [k: string]: unknown };

export interface NativeCleanStats {
  prunedOperands: number;
  droppedAdds: number;
  mergedEvals: number;
  /** Removed fallback fields (distinct paths). */
  prunedFields: string[];
  /** Why nothing could be pruned, when a library list was given but pruning was off. */
  pruneBlockedBy?: string;
  /** Fallback fields neither documented, seen nor written: advice for the library review. */
  neverSeen: string[];
  orBefore: number; orAfter: number;
  functionsBefore: number; functionsAfter: number;
}

export interface NativeCleanOptions {
  /** Complete field list of a CLOSED library entry (documented + common). Null: no closed-entry pruning. */
  complete?: string[] | null;
  /** Fields the library entry lists for the source (open or closed). A chain reading one of them
   *  drops its unconfirmed, unknown field operands. Null: no anchored pruning. */
  confirmed?: string[] | null;
  /** Everything known to exist (documented + seen + common), for the `neverSeen` advice. */
  known?: string[] | null;
}

const trivialFilter = (f: PipelineFunction) => f.filter == null || String(f.filter).trim() === '' || String(f.filter).trim() === 'true';
const isEmptyList = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0);

/**
 * Fields a Function writes, or null when they cannot be listed. Parsers that extract an open set
 * (JSON, key=value without a field list) write source fields, which the library covers; they
 * return [] only when they extract straight into the event root.
 */
function writes(f: PipelineFunction): string[] | null {
  const c = (f.conf || {}) as Record<string, any>;
  switch (f.id) {
    case 'comment': case 'drop': return [];
    case 'eval': return (c.add || []).map((a: AddEntry) => String(a.name ?? ''));
    case 'serialize': return c.dstField ? [String(c.dstField)] : ['_raw'];
    case 'rename':
      if (c.renameExpr || c.wildcardDepth) return null;
      return (c.rename || []).map((r: { newName?: string }) => String(r.newName ?? ''));
    case 'lookup':
      return Array.isArray(c.outFields) && c.outFields.length
        ? c.outFields.map((o: { eventField?: string; lookupField?: string }) => String(o.eventField || o.lookupField || '')) : null;
    case 'regex_extract': {
      const rxs = [c.regex, ...(c.regexList || []).map((r: { regex?: string }) => r.regex)].map(r => String(r || ''));
      if (c.fieldNameExpression || rxs.some(r => /\(\?<_(?:NAME|VALUE|KEY)_/.test(r))) return null;
      return rxs.flatMap(r => [...r.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map(m => m[1]));
    }
    case 'serde': {
      if (c.mode && c.mode !== 'extract') return null;
      if (c.dstField) return [String(c.dstField)];
      return Array.isArray(c.fields) && c.fields.length ? c.fields.map(String) : [];
    }
    default: return null;
  }
}

/**
 * The cleaned pipeline. With `opts.complete` (a closed library entry) fallbacks to fields the
 * source never carries are removed; evals are always merged. Exact for every event.
 */
export function cleanPipeline(functions: PipelineFunction[], opts: NativeCleanOptions = {}): { functions: PipelineFunction[]; stats: NativeCleanStats } {
  const stats: NativeCleanStats = { prunedOperands: 0, droppedAdds: 0, mergedEvals: 0, prunedFields: [], neverSeen: [],
    orBefore: pipelineOrCount(functions), orAfter: 0, functionsBefore: functions.length, functionsAfter: 0 };
  const pruned = new Set<string>();
  const neverSeen = new Set<string>();
  const written: string[] = [];
  let open: string | null = null;   // first Function whose writes cannot be listed

  const cleaned: PipelineFunction[] = [];
  functions.forEach((fn, fi) => {
    if (fn.disabled) { cleaned.push(fn); return; }
    if (fn.id !== 'eval') {
      const w = writes(fn);
      if (w === null) open ??= fn.id;
      else written.push(...w);
      cleaned.push(fn);
      return;
    }
    const adds: AddEntry[] = (fn.conf as { add?: AddEntry[] })?.add || [];
    const out: AddEntry[] = [];
    adds.forEach((a, ai) => {
      const name = String(a.name ?? '');
      const src = String(a.value ?? '');
      const ast = name && src.includes('||') ? parseRoundTrip(src) : null;
      if (ast && !hasMutatingCall(ast)) {
        const r = pruneChains(ast, written, opts, open, neverSeen);
        if (r.pruned) {
          r.fields.forEach(f => pruned.add(f));
          stats.prunedOperands += r.pruned;
          const value = print(ast);
          // Nothing left to read, the target is not a field the source carries nor one written
          // before, and no later add claims its key position: the add does nothing.
          const targetAbsent = !!opts.complete && !pathCovered(opts.complete, name) && !pathCovered(written, name);
          if (value === 'undefined' && targetAbsent && !writtenLater(functions, fi, ai, name)) { stats.droppedAdds++; written.push(name); return; }
          out.push({ ...a, value });
          written.push(name);
          return;
        }
      }
      out.push(a);
      written.push(name);
    });
    if (out.length || !isEmptyList((fn.conf as AddEntry)?.remove) || !isEmptyList((fn.conf as AddEntry)?.keep)) {
      cleaned.push(out === adds || (out.length === adds.length && out.every((x, i) => x === adds[i])) ? fn : { ...fn, conf: { ...fn.conf, add: out } });
    }
  });
  if ((opts.complete || opts.confirmed?.length) && open) stats.pruneBlockedBy = open;
  const merged = mergeEvals(cleaned);
  stats.mergedEvals = merged.merged;
  stats.prunedFields = [...pruned].sort();
  stats.neverSeen = [...neverSeen].filter(f => !pruned.has(f)).sort();
  stats.orAfter = pipelineOrCount(merged.functions);
  stats.functionsAfter = merged.functions.length;
  return { functions: merged.functions, stats };
}

/** Prunes the chains of one add in place. Innermost chains first. */
function pruneChains(ast: Node, written: string[], opts: NativeCleanOptions, open: string | null,
  neverSeen: Set<string>): { pruned: number; fields: string[] } {
  const chains = findChains(ast);
  let pruned = 0;
  const fields: string[] = [];
  for (let ci = chains.length - 1; ci >= 0; ci--) {
    const c = chains[ci];
    const paths = c.operands.map(o => (isFieldRef(o) ? refPath(o) : null)?.join('.') || null);
    // A chain is anchored when it reads a field the library confirms for this source: its
    // alternatives are then guesses at a name this source does not use.
    const anchored = !open && !!opts.confirmed?.length && paths.some(p => p && pathCovered(opts.confirmed!, p));
    const absent = paths.map(path => {
      if (!path) return false;
      if (pathCovered(written, path)) return false;
      if (opts.known && !pathCovered(opts.known, path)) neverSeen.add(path);
      if (open) return false;
      if (opts.complete && !pathCovered(opts.complete, path)) return true;
      return anchored && !pathCovered(opts.confirmed!, path) && !pathCovered(opts.known || [], path);
    });
    const last = c.operands.length - 1;
    const kept = c.operands.filter((_, j) => !absent[j]);
    if (kept.length === c.operands.length) continue;
    // `x || absent` is not `x` when x is falsy: '' would stay instead of the field going unset.
    // `x || undefined` keeps that exactly.
    if (absent[last] && kept.length && unparen(kept[kept.length - 1]).t !== 'lit') kept.push({ t: 'id', name: 'undefined' });
    pruned += absent.filter(Boolean).length;
    paths.forEach((p, j) => { if (absent[j] && p) fields.push(p); });
    const replacement: Node = kept.length === 0 ? { t: 'id', name: 'undefined' }
      : kept.slice(1).reduce<Node>((l, r) => ({ t: 'bin', op: '||', l, r }), kept[0]);
    const copy = { ...replacement };
    for (const k of Object.keys(c.root)) delete (c.root as Record<string, unknown>)[k];
    Object.assign(c.root, copy);
  }
  return { pruned, fields };
}

function writtenLater(functions: PipelineFunction[], fi: number, ai: number, name: string): boolean {
  return functions.some((f, i) => i >= fi && f.id === 'eval'
    && ((f.conf as { add?: AddEntry[] })?.add || []).some((a, j) => (i > fi || j > ai) && a.name === name));
}

const EVAL_CONF_KEYS = new Set(['add', 'remove', 'keep']);
const mergeable = (f: PipelineFunction) => f.id === 'eval' && !f.disabled && trivialFilter(f)
  && !(f as { final?: boolean }).final && Object.keys(f.conf || {}).every(k => EVAL_CONF_KEYS.has(k));

/**
 * Merge runs of filter-less evals. Within a run every eval but the last has no remove/keep, so the
 * adds can run back to back and the last eval's remove/keep runs after all of them, as before.
 * Comments inside a run move in front of the merged eval.
 */
export function mergeEvals(functions: PipelineFunction[]): { functions: PipelineFunction[]; merged: number } {
  const out: PipelineFunction[] = [];
  let merged = 0;
  let run: PipelineFunction[] = [];
  let comments: PipelineFunction[] = [];
  const flush = () => {
    if (run.length > 1) {
      const last = run[run.length - 1];
      const conf: Record<string, unknown> = { add: run.flatMap(f => (f.conf as { add?: AddEntry[] })?.add || []) };
      if (!isEmptyList((last.conf as AddEntry)?.remove)) conf.remove = (last.conf as AddEntry).remove;
      if (!isEmptyList((last.conf as AddEntry)?.keep)) conf.keep = (last.conf as AddEntry).keep;
      out.push(...comments, {
        id: 'eval', filter: 'true',
        description: run.map(f => f.description).filter(Boolean).join('; ').slice(0, 500) || undefined,
        conf,
      } as PipelineFunction);
      merged += run.length - 1;
    } else out.push(...interleave(run, comments));
    run = []; comments = [];
  };
  for (const fn of functions) {
    if (fn.id === 'comment' && run.length) { comments.push(fn); continue; }
    if (mergeable(fn)) {
      run.push(fn);
      const removes = !isEmptyList((fn.conf as AddEntry)?.remove) || !isEmptyList((fn.conf as AddEntry)?.keep);
      if (removes) flush();   // nothing may run after this eval's remove/keep inside the same eval
      continue;
    }
    flush();
    out.push(fn);
  }
  flush();
  return { functions: out, merged };
}

// A run of 0-1 evals keeps the original order with its comments.
function interleave(run: PipelineFunction[], comments: PipelineFunction[]): PipelineFunction[] {
  return run.length ? [run[0], ...comments] : comments;
}
