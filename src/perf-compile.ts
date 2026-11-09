/**
 * Performance mode: compile a generated pipeline's eval/serialize runs into ONE Code function each.
 *
 * The generated eval pipeline stays the source of truth. This module translates it mechanically,
 * expression by expression, into a Code function that copies the event into a plain object once,
 * runs every add/remove/keep/serialize on that object, and writes back only the fields that changed.
 * Host reads and writes of `__e` are the expensive part of an eval chain (measured on the OCSF
 * reference pipelines: the mapping evals and the serialize → `unmapped` round trip were 70-80% of
 * the function time), so one pass over a plain object does the same work for a fraction of the CPU.
 *
 * Semantics follow the verified eval model (CLAUDE.md "Eval semantics", mirrored by
 * tests/lib/cribl-eval-sim.mjs):
 *  - adds run in order and each sees the previous writes;
 *  - a dotted add is dropped when its parent object is missing;
 *  - an add whose expression throws assigns undefined (the field is removed on the wire);
 *  - expressions navigate safely: `missing.x` and `missing(1)` are undefined, not errors.
 *    A Code function rejects `?.` (live 2026-10-17: the whole function silently does nothing),
 *    so every member access and call is written out as an explicit null check;
 *  - a computed member whose whole key is a bare field (`obj[k]`) fails the expression;
 *  - globals isNaN / isFinite / parseInt / parseFloat are undefined in an eval;
 *  - remove runs after add, keep wins over remove, wildcards never remove `__` fields;
 *  - serialize `fields` is first-match-wins in order.
 *
 * Anything outside that model (another function id, an unknown conf key, a syntax the expression
 * parser does not know, a risky global) is not compiled: that function stays as it was and splits
 * the run. Compiling is therefore always safe to attempt; whether the result is IDENTICAL is decided
 * afterwards by running both pipelines in Data Preview (`comparePipelineOutputs`) — only a variant
 * with 0 differences may be offered.
 *
 * Expressions are parsed (tokenizer + Pratt parser), never rewritten with regexes, so string, regex
 * and template literals are opaque by construction.
 */
import type { PipelineFunction } from './source-recognition';

// ---------------------------------------------------------------------------------------------
// Expression parsing

type Tok =
  | { k: 'num' | 'str' | 're' | 'id' | 'p'; v: string }
  | { k: 'tpl'; parts: string[]; exprs: Tok[][] };

export class Refuse extends Error {}
const refuse = (why: string): never => { throw new Refuse(why); };

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=',
  '&&', '||', '??', '?.', '**', '<<', '>>', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.'];
// Not jsExpression: assignment, arrow functions, update operators, statements, `??` and `?.`.
const FORBIDDEN_PUNCT = new Set(['>>>=', '**=', '<<=', '>>=', '&&=', '||=', '??=', '=>', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '=', ';', '??', '?.']);
const REGEX_AFTER_KW = new Set(['typeof', 'instanceof', 'in', 'new', 'void', 'delete', 'return', 'case']);
const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/;
const ID_RE = /^[A-Za-z_$][\w$]*/;

function tokenize(src: string, start: number, stopAtBrace: boolean): { toks: Tok[]; end: number } {
  const toks: Tok[] = [];
  let i = start;
  let depth = 0;
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.k === 'p') return p.v !== ')' && p.v !== ']' && p.v !== '}';
    return p.k === 'id' && REGEX_AFTER_KW.has(p.v);
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) refuse('comment in expression');
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') refuse('newline in string'); j++; }
      if (j >= src.length) refuse('unterminated string');
      toks.push({ k: 'str', v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const parts: string[] = [];
      const exprs: Tok[][] = [];
      let cur = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length) refuse('unterminated template');
        if (src[j] === '\\') { cur += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          parts.push(cur); cur = '';
          const inner = tokenize(src, j + 2, true);
          exprs.push(inner.toks);
          j = inner.end + 1;
          continue;
        }
        cur += src[j++];
      }
      parts.push(cur);
      toks.push({ k: 'tpl', parts, exprs });
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      for (;;) {
        if (j >= src.length || src[j] === '\n') refuse('unterminated regex');
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      toks.push({ k: 're', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = NUM_RE.exec(src.slice(i));
      if (!m) refuse('bad number');
      toks.push({ k: 'num', v: m![0] });
      i += m![0].length;
      continue;
    }
    const idm = ID_RE.exec(src.slice(i, i + 256));
    if (idm) { toks.push({ k: 'id', v: idm[0] }); i += idm[0].length; continue; }
    // `a?.5:b` is a ternary, not optional chaining.
    const p = PUNCT.find(q => src.startsWith(q, i) && !(q === '?.' && /[0-9]/.test(src[i + 2] || '')));
    if (!p) refuse(`unexpected character ${JSON.stringify(c)}`);
    if (p === '{') depth++;
    if (p === '}') {
      if (stopAtBrace && depth === 0) return { toks, end: i };
      depth--;
    }
    if (FORBIDDEN_PUNCT.has(p!)) refuse(`operator ${p} is not allowed`);
    toks.push({ k: 'p', v: p! });
    i += p!.length;
  }
  if (stopAtBrace) refuse('unterminated template substitution');
  return { toks, end: i };
}

export type ExprNode = Node;
type Node =
  | { t: 'lit'; code: string }
  | { t: 'id'; name: string }
  | { t: 'tpl'; parts: string[]; exprs: Node[] }
  | { t: 'arr'; items: Node[] }
  | { t: 'spread'; arg: Node }
  | { t: 'obj'; props: ({ key: string; computed?: Node; value: Node } | { spread: Node })[] }
  | { t: 'mem'; obj: Node; prop: string }
  | { t: 'idx'; obj: Node; index: Node }
  | { t: 'call'; callee: Node; args: Node[] }
  | { t: 'new'; callee: Node; args: Node[] }
  | { t: 'un'; op: string; arg: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'cond'; test: Node; a: Node; b: Node }
  | { t: 'paren'; e: Node };

const BIN_BP: Record<string, number> = {
  ',': 1, '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '==': 8, '!=': 8, '===': 8, '!==': 8,
  '<': 9, '>': 9, '<=': 9, '>=': 9, in: 9, instanceof: 9, '<<': 10, '>>': 10, '>>>': 10,
  '+': 11, '-': 11, '*': 12, '/': 12, '%': 12, '**': 13,
};
const UNARY = new Set(['!', '-', '+', '~', 'typeof', 'void']);
const BANNED_KW = new Set(['function', 'class', 'this', 'super', 'delete', 'await', 'yield', 'let', 'var', 'const',
  'return', 'if', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally',
  'import', 'export', 'with', 'debugger', 'arguments', 'eval']);

class Parser {
  private i = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok | undefined { return this.toks[this.i]; }
  private isP(v: string) { const t = this.peek(); return !!t && t.k === 'p' && t.v === v; }
  private expectP(v: string) { if (!this.isP(v)) refuse(`expected ${v}`); this.i++; }

  parseAll(): Node {
    if (!this.toks.length) refuse('empty expression');
    const n = this.expr(0);
    if (this.i !== this.toks.length) refuse('trailing tokens');
    return n;
  }

  private expr(minBp: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.k === 'p' && t.v === '?') {
        if (minBp > 2) break;
        this.i++;
        const a = this.expr(2);
        this.expectP(':');
        const b = this.expr(2);
        left = { t: 'cond', test: left, a, b };
        continue;
      }
      const op = t.k === 'p' || (t.k === 'id' && (t.v === 'in' || t.v === 'instanceof')) ? (t as { v: string }).v : null;
      const bp = op != null ? BIN_BP[op] : undefined;
      if (bp === undefined || bp < minBp) break;
      this.i++;
      const r = this.expr(op === '**' ? bp : bp + 1);
      left = { t: 'bin', op: op!, l: left, r };
    }
    return left;
  }

  private unary(): Node {
    const t = this.peek();
    if (t && (t.k === 'p' || t.k === 'id') && UNARY.has((t as { v: string }).v)) {
      this.i++;
      return { t: 'un', op: (t as { v: string }).v, arg: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(n: Node, noCall = false): Node {
    for (;;) {
      if (this.isP('.')) {
        this.i++;
        const t = this.peek();
        if (!t || t.k !== 'id') refuse('expected property name');
        this.i++;
        n = { t: 'mem', obj: n, prop: (t as { v: string }).v };
      } else if (this.isP('[')) {
        this.i++;
        const index = this.expr(0);
        this.expectP(']');
        n = { t: 'idx', obj: n, index };
      } else if (!noCall && this.isP('(')) {
        n = { t: 'call', callee: n, args: this.args() };
      } else if (this.peek()?.k === 'tpl') {
        refuse('tagged template');
      } else return n;
    }
  }

  private args(): Node[] {
    this.expectP('(');
    const out: Node[] = [];
    while (!this.isP(')')) {
      if (this.isP('...')) { this.i++; out.push({ t: 'spread', arg: this.expr(2) }); }
      else out.push(this.expr(2));
      if (!this.isP(')')) this.expectP(',');
    }
    this.i++;
    return out;
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) return refuse('unexpected end');
    this.i++;
    if (t.k === 'num' || t.k === 'str' || t.k === 're') return { t: 'lit', code: t.v };
    if (t.k === 'tpl') return { t: 'tpl', parts: t.parts, exprs: t.exprs.map(x => new Parser(x).parseAll()) };
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false' || t.v === 'null') return { t: 'lit', code: t.v };
      if (BANNED_KW.has(t.v) || t.v === 'in' || t.v === 'instanceof') refuse(`keyword ${t.v}`);
      if (t.v === 'new') {
        const callee = this.postfix(this.primary(), true);
        return { t: 'new', callee, args: this.isP('(') ? this.args() : [] };
      }
      return { t: 'id', name: t.v };
    }
    if (t.v === '(') {
      const e = this.expr(0);
      this.expectP(')');
      return { t: 'paren', e };
    }
    if (t.v === '[') {
      const items: Node[] = [];
      while (!this.isP(']')) {
        if (this.isP(',')) refuse('array hole');
        if (this.isP('...')) { this.i++; items.push({ t: 'spread', arg: this.expr(2) }); }
        else items.push(this.expr(2));
        if (!this.isP(']')) this.expectP(',');
      }
      this.i++;
      return { t: 'arr', items };
    }
    if (t.v === '{') {
      const props: ({ key: string; computed?: Node; value: Node } | { spread: Node })[] = [];
      while (!this.isP('}')) {
        if (this.isP('...')) { this.i++; props.push({ spread: this.expr(2) }); }
        else {
          const k = this.peek();
          if (!k) refuse('unterminated object');
          this.i++;
          let key = '';
          let computed: Node | undefined;
          if (k!.k === 'p' && (k as { v: string }).v === '[') { computed = this.expr(2); this.expectP(']'); }
          else if (k!.k === 'id' || k!.k === 'str' || k!.k === 'num') key = (k as { v: string }).v;
          else refuse('bad object key');
          if (this.isP(':')) { this.i++; props.push({ key, computed, value: this.expr(2) }); }
          else if (k!.k === 'id' && !computed && (this.isP(',') || this.isP('}'))) props.push({ key, value: { t: 'id', name: key } });
          else refuse('object method or getter');
        }
        if (!this.isP('}')) this.expectP(',');
      }
      this.i++;
      return { t: 'obj', props };
    }
    return refuse(`unexpected ${t.v}`);
  }
}

/** Parse one jsExpression; throws `Refuse` for anything outside the supported subset. */
export function parseExpression(src: string): Node {
  return new Parser(tokenize(src, 0, false).toks).parseAll();
}

// ---------------------------------------------------------------------------------------------
// Code generation

// Real globals inside an eval (tests/lib/cribl-eval-sim.mjs GLOBALS).
export const GLOBALS = new Set(['String', 'Number', 'Math', 'Date', 'Boolean', 'JSON', 'RegExp', 'Object', 'Array',
  'undefined', 'NaN', 'Infinity']);
// Undefined inside an eval (verified live 2026-10-02), defined inside a Code function.
export const MISSING_GLOBALS = new Set(['isNaN', 'isFinite', 'parseInt', 'parseFloat']);
// Real JS globals whose meaning inside an eval has not been verified: never compile these.
const RISKY_GLOBALS = new Set(['encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape',
  'unescape', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Promise', 'Proxy', 'Reflect', 'Intl', 'BigInt',
  'Buffer', 'require', 'globalThis', 'setTimeout', 'setInterval',
  'Function', 'Error', 'TypeError', 'Uint8Array', 'ArrayBuffer', 'DataView', 'atob', 'btoa']);
// Helpers and temporaries the generated code declares; an event field may not shadow them.
const RESERVED_PREFIX = '$';

const STRING_METHODS = new Set(Object.getOwnPropertyNames(String.prototype));
const REGEXP_METHODS = new Set(Object.getOwnPropertyNames(RegExp.prototype));
const globalHas = (g: string, p: string) => {
  const host = (globalThis as Record<string, unknown>)[g] as Record<string, unknown> | undefined;
  return !!host && Object.prototype.hasOwnProperty.call(host, p);
};

class Gen {
  temps = 0;
  private next(): string { return `$t${this.temps++}`; }

  /** Code for a value that is a string whatever it is called on (`String(x)`, a string literal). */
  private isStringValued(n: Node): boolean {
    if (n.t === 'paren') return this.isStringValued(n.e);
    if (n.t === 'lit') return n.code[0] === '"' || n.code[0] === "'";
    if (n.t === 'tpl') return true;
    return n.t === 'call' && n.callee.t === 'id' && n.callee.name === 'String';
  }

  expr(n: Node): string {
    switch (n.t) {
      case 'lit': return n.code;
      case 'id': return this.ident(n.name);
      case 'paren': return `(${this.expr(n.e)})`;
      case 'spread': return `...${this.expr(n.arg)}`;
      case 'tpl': {
        let s = '`' + n.parts[0];
        n.exprs.forEach((x, i) => { s += '${' + this.expr(x) + '}' + n.parts[i + 1]; });
        return s + '`';
      }
      case 'arr': return `[${n.items.map(x => this.expr(x)).join(', ')}]`;
      case 'obj': return `({${n.props.map(p => ('spread' in p ? `...${this.expr(p.spread)}`
        : `${p.computed ? `[${this.expr(p.computed)}]` : p.key}: ${this.expr(p.value)}`)).join(', ')}})`;
      case 'un': return `(${n.op}${/^[a-z]/.test(n.op) ? ' ' : ''}${this.expr(n.arg)})`;
      case 'bin': return `(${this.expr(n.l)} ${n.op} ${this.expr(n.r)})`;
      case 'cond': return `(${this.expr(n.test)} ? ${this.expr(n.a)} : ${this.expr(n.b)})`;
      case 'mem': {
        if (n.obj.t === 'id' && GLOBALS.has(n.obj.name) && globalHas(n.obj.name, n.prop)) return `${n.obj.name}.${n.prop}`;
        if (n.obj.t === 'id' && n.obj.name === '__e') return `e[${JSON.stringify(n.prop)}]`;
        return `$g(${this.expr(n.obj)}, ${JSON.stringify(n.prop)})`;
      }
      case 'idx': {
        let k = n.index;
        while (k.t === 'paren') k = k.e;
        // A bare field as the whole computed key fails the expression live (2026-10-12).
        if (k.t === 'id' && k.name !== '__e' && !GLOBALS.has(k.name)) return '$u()';
        if (n.obj.t === 'id' && n.obj.name === '__e') return `e[${this.expr(n.index)}]`;
        return `$g(${this.expr(n.obj)}, ${this.expr(n.index)})`;
      }
      case 'new': return `(new ${this.callee(n.callee)}(${n.args.map(a => this.expr(a)).join(', ')}))`;
      case 'call': return this.call(n);
    }
  }

  private ident(name: string): string {
    if (name === '__e') return 'e';
    if (name.startsWith(RESERVED_PREFIX)) refuse(`identifier ${name}`);
    if (GLOBALS.has(name) || name === 'C') return name;
    if (MISSING_GLOBALS.has(name)) return 'undefined';
    if (RISKY_GLOBALS.has(name)) refuse(`global ${name}`);
    return `e.${name}`;
  }

  private callee(n: Node): string {
    if (n.t === 'id' && GLOBALS.has(n.name)) return n.name;
    return `(${this.expr(n)})`;
  }

  private call(n: Extract<Node, { t: 'call' }>): string {
    const args = n.args.map(a => this.expr(a)).join(', ');
    const c = n.callee;
    if (c.t === 'id') {
      if (GLOBALS.has(c.name) && typeof (globalThis as Record<string, unknown>)[c.name] === 'function') return `${c.name}(${args})`;
      if (MISSING_GLOBALS.has(c.name)) return 'undefined';
    }
    if (c.t === 'mem') {
      // Receivers that can never be null, with a method that exists: call directly.
      if (c.obj.t === 'id' && GLOBALS.has(c.obj.name) && globalHas(c.obj.name, c.prop)) return `${c.obj.name}.${c.prop}(${args})`;
      if (c.obj.t === 'lit' && c.obj.code[0] === '/' && REGEXP_METHODS.has(c.prop)) return `${c.obj.code}.${c.prop}(${args})`;
      if (this.isStringValued(c.obj) && STRING_METHODS.has(c.prop)) return `${this.expr(c.obj)}.${c.prop}(${args})`;
    }
    if (c.t === 'mem' || c.t === 'idx') {
      const o = this.next();
      const f = this.next();
      const key = c.t === 'mem' ? JSON.stringify(c.prop) : (() => {
        let k = c.index;
        while (k.t === 'paren') k = k.e;
        return k.t === 'id' && k.name !== '__e' && !GLOBALS.has(k.name) ? '$u()' : this.expr(c.index);
      })();
      const recv = c.obj.t === 'id' && c.obj.name === '__e' ? 'e' : this.expr(c.obj);
      return `((${o} = ${recv}) == null ? undefined : (${f} = ${o}[${key}]) == null ? undefined : ${f}.call(${o}${args ? ', ' + args : ''}))`;
    }
    const f = this.next();
    return `((${f} = ${this.expr(c)}) == null ? undefined : ${f}(${args}))`;
  }
}

// ---------------------------------------------------------------------------------------------
// Function compilation

const globSource = (g: string) => g.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
/** One regex literal matching any of the globs (exact names included). */
const anyGlobRe = (globs: string[]) => `/^(?:${globs.map(globSource).join('|')})$/`;
const globToRe = (g: string) => new RegExp(`^${globSource(g)}$`);

const EVAL_KEYS = new Set(['add', 'remove', 'keep']);
const SERIALIZE_KEYS = new Set(['type', 'dstField', 'fields']);
const FN_KEYS = new Set(['id', 'filter', 'disabled', 'description', 'conf']);

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, what: string) {
  for (const k of Object.keys(obj)) if (obj[k] !== undefined && !allowed.has(k)) refuse(`${what} key ${k}`);
}

function filterGuard(g: Gen, filter: string | undefined, body: string): string {
  if (!filter || filter.trim() === 'true') return body;
  return `$ok = false;\ntry { $ok = !!${g.expr(parseExpression(filter))}; } catch ($x) { $ok = false; }\nif ($ok) {\n${body}\n}`;
}

function assignCode(name: string, dirty: Set<string>): string {
  const parts = name.split('.');
  if (parts.length === 1) return `e[${JSON.stringify(name)}] = $v;`;
  dirty.add(parts[0]);
  // The parent chain must already exist as objects, else the add is dropped (as in eval).
  let code = `$p = e[${JSON.stringify(parts[0])}];`;
  for (let i = 1; i < parts.length - 1; i++) code += ` if ($p && typeof $p === 'object') $p = $p[${JSON.stringify(parts[i])}]; else $p = undefined;`;
  return `${code} if ($p && typeof $p === 'object') $p[${JSON.stringify(parts[parts.length - 1])}] = $v;`;
}

/**
 * Live (probed 2026-10-17), remove/keep patterns match flattened paths and `*` crosses dots and
 * array indices: `remove:['*'], keep:['k']` empties a kept object `k`, `remove:['*_id']` deletes
 * `k.x_id`, `keep:['k.y']` keeps one nested key. The compiled code only works on top-level keys,
 * so it takes a remove/keep only when the top-level effect is the whole effect: no dotted names,
 * and every wildcard is `prefix*` (no dot in the prefix) that no keep pattern overlaps.
 */
function removeIsTopLevelOnly(remove: string[], keep: string[]): boolean {
  if ([...remove, ...keep].some(p => p.includes('.'))) return false;
  const lit = (p: string) => p.split('*')[0];
  return remove.every(p => {
    if (!p.includes('*')) return true;
    const prefix = p.slice(0, -1);
    if (!prefix || prefix.includes('*')) return false;
    return keep.every(k => { const l = lit(k); return !(l.startsWith(prefix) || (k.includes('*') && prefix.startsWith(l))); });
  });
}

function compileEval(fn: PipelineFunction, g: Gen, dirty: Set<string>): string {
  const conf = (fn.conf || {}) as { add?: { name?: string; value?: unknown; disabled?: boolean }[]; remove?: string[]; keep?: string[] };
  checkKeys(conf as Record<string, unknown>, EVAL_KEYS, 'eval conf');
  const lines: string[] = [];
  for (const a of conf.add || []) {
    if (a.disabled === true) continue;
    const src = a.value == null ? 'undefined' : String(a.value);
    lines.push(`try { $v = ${g.expr(parseExpression(src))}; } catch ($x) { $v = undefined; }`);
    if (a.name) lines.push(assignCode(String(a.name), dirty));
  }
  const keep = (conf.keep || []).map(String);
  const remove = (conf.remove || []).map(String);
  for (const p of [...keep, ...remove]) if (p.startsWith('!')) refuse('negated remove/keep pattern');
  if (!removeIsTopLevelOnly(remove, keep)) refuse('remove/keep that reaches nested fields');
  const keepRes = keep.map(globToRe);
  const keepTest = keep.length ? `${anyGlobRe(keep)}.test($k)` : 'false';
  for (const pat of remove) {
    if (!pat.includes('*')) {
      if (!keepRes.some(r => r.test(pat))) lines.push(`delete e[${JSON.stringify(pat)}];`);
      continue;
    }
    const match = pat === '*' ? '' : `if (!${anyGlobRe([pat])}.test($k)) continue; `;
    lines.push(`$ks = Object.keys(e);\nfor ($i = 0; $i < $ks.length; $i++) { $k = $ks[$i]; ${match}`
      + `if ($k.charCodeAt(0) === 95 && $k.charCodeAt(1) === 95) continue; if (${keepTest}) continue; delete e[$k]; }`);
  }
  // Eval has no try around its filter in the simulator; live, a failing filter skips the function.
  return filterGuard(g, fn.filter, lines.join('\n'));
}

/** First-match-wins field rules as one boolean expression over `$k`. */
function fieldRulesTest(fields: string[]): string {
  const groups: { inc: boolean; globs: string[] }[] = [];
  for (const f of fields) {
    const inc = !f.startsWith('!');
    const glob = inc ? f : f.slice(1);
    const last = groups[groups.length - 1];
    // Consecutive rules of the same polarity can be tested together without changing the result.
    if (last && last.inc === inc) last.globs.push(glob);
    else groups.push({ inc, globs: [glob] });
  }
  return groups.reduceRight((acc, gr) => `${anyGlobRe(gr.globs)}.test($k) ? ${gr.inc} : ${acc}`, 'false');
}

function compileSerialize(fn: PipelineFunction, g: Gen): string {
  const conf = (fn.conf || {}) as { type?: string; dstField?: string; fields?: string[] };
  checkKeys(conf as Record<string, unknown>, SERIALIZE_KEYS, 'serialize conf');
  const type = conf.type || 'json';
  if (type !== 'json' && type !== 'kvp') refuse(`serialize type ${type}`);
  const test = fieldRulesTest((conf.fields && conf.fields.length ? conf.fields : ['*']).map(String));
  if (String(conf.dstField || '').includes('.')) refuse('dotted serialize dstField');
  // Live serialize never writes internal `__` fields (`__id`, `__output`, …); naming one is unverified.
  if ((conf.fields || []).some(f => String(f).replace(/^!/, '').startsWith('__'))) refuse('serialize field rule on __ fields');
  const dst = JSON.stringify(conf.dstField || '_raw');
  const skip = 'if ($k.charCodeAt(0) === 95 && $k.charCodeAt(1) === 95) continue; ';
  const body = type === 'json'
    ? `$s = {};\n$ks = Object.keys(e);\nfor ($i = 0; $i < $ks.length; $i++) { $k = $ks[$i]; ${skip}if (${test}) $s[$k] = e[$k]; }\ne[${dst}] = JSON.stringify($s);`
    : `$a = [];\n$ks = Object.keys(e);\nfor ($i = 0; $i < $ks.length; $i++) { $k = $ks[$i]; ${skip}$v = e[$k]; if ($v == null || !(${test})) continue; $a.push($k + '=' + $kv($v)); }\ne[${dst}] = $a.join(' ');`;
  // Every non-eval function skips the event when its filter errors (simulator passesFilter).
  return filterGuard(g, fn.filter, body);
}

/** The compiled body of one function, or a reason it is left alone. */
function compileOne(fn: PipelineFunction, g: Gen, dirty: Set<string>): string {
  checkKeys(fn as unknown as Record<string, unknown>, FN_KEYS, 'function');
  if (fn.id === 'eval') return compileEval(fn, g, dirty);
  if (fn.id === 'serialize') return compileSerialize(fn, g);
  return refuse(`function ${fn.id}`);
}

// No `Object.prototype` here: the live Code function refuses it and then silently does nothing.
const HELPERS = `function $g(o, k) { return o == null ? undefined : o[k]; }
function $u() { throw new Error('computed key is a bare field'); }
function $kv(v) { var s = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v); return s === '' || /[\\s",=\\\\]/.test(s) ? '"' + s.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"' : s; }`;

function wrapBlock(bodies: string[], descriptions: string[], temps: number, dirty: Set<string>): string {
  const tmp = Array.from({ length: temps }, (_, i) => `$t${i}`);
  // Top-level fields a dotted add wrote into: written back even when the object is the same reference.
  const vars = [`$D = ${JSON.stringify(Object.fromEntries([...dirty].map(k => [k, 1])))}`, 'e = {}', '$o = {}', '$n = {}', '$ks', '$i', '$k', '$v', '$p', '$s', '$a', '$ok', ...tmp].join(', ');
  return [
    `// Performance mode: ${descriptions.length} generated Functions compiled into one pass (same semantics as the evals).`,
    HELPERS,
    `var ${vars};`,
    '$ks = Object.keys(__e);',
    'for ($i = 0; $i < $ks.length; $i++) { $k = $ks[$i]; $v = __e[$k]; e[$k] = $v; $o[$k] = $v; }',
    ...bodies.map((b, i) => `// ${i + 1}. ${descriptions[i].replace(/[\r\n]+/g, ' ')}\n${b}`),
    '// Write back only what changed.',
    '$ks = Object.keys(e);',
    'for ($i = 0; $i < $ks.length; $i++) { $k = $ks[$i]; $n[$k] = 1; $v = e[$k]; if ($v === undefined) { if ($o[$k] !== undefined) delete __e[$k]; } else if ($v !== $o[$k] || $D[$k] === 1) __e[$k] = $v; }',
    '$ks = Object.keys($o);',
    'for ($i = 0; $i < $ks.length; $i++) { $k = $ks[$i]; if ($n[$k] !== 1) delete __e[$k]; }',
  ].join('\n');
}

export interface PerfCompileResult {
  functions: PipelineFunction[];
  /** Generated Functions folded into Code functions. */
  compiledCount: number;
  /** Code functions emitted. */
  blocks: number;
  /** Why a function was left as it was (index into the input list). */
  kept: { index: number; id: string; reason: string }[];
}

// The live engine's ceiling: above 10000 the Code function silently does nothing.
const MAX_ITERATIONS = 10000;

/**
 * Replace every run of at least `minRun` compilable Functions (eval, serialize json/kvp; comments and
 * disabled Functions inside a run are dropped) with one Code function. Other Functions stay in place.
 */
export function compilePipelineForPerformance(functions: PipelineFunction[], opts: { minRun?: number } = {}): PerfCompileResult {
  const minRun = opts.minRun ?? 2;
  const out: PipelineFunction[] = [];
  const kept: PerfCompileResult['kept'] = [];
  let compiledCount = 0;
  let blocks = 0;
  let run: { fn: PipelineFunction; body: string }[] = [];
  let pending: PipelineFunction[] = [];   // the run's original Functions, comments included
  let gen = new Gen();
  let dirty = new Set<string>();

  const flush = () => {
    if (run.length >= minRun) {
      const code = wrapBlock(run.map(r => r.body), run.map(r => r.fn.description || r.fn.id), gen.temps, dirty);
      out.push({
        id: 'code', filter: 'true',
        description: `Performance mode: ${run.length} Functions in one pass (${run.map(r => r.fn.description || r.fn.id).join('; ').slice(0, 200)})`,
        conf: { code, maxNumOfIterations: MAX_ITERATIONS },
      });
      compiledCount += run.length;
      blocks++;
    } else out.push(...pending);
    run = []; pending = []; gen = new Gen(); dirty = new Set();
  };

  functions.forEach((fn, index) => {
    if (fn.disabled === true) { pending.push(fn); return; }
    if (fn.id === 'comment') { pending.push(fn); return; }
    const snapshot = gen.temps;
    const dirtyBefore = new Set(dirty);
    try {
      if ((fn as { final?: boolean }).final) refuse('final');
      const body = compileOne(fn, gen, dirty);
      run.push({ fn, body });
      pending.push(fn);
    } catch (err) {
      if (!(err instanceof Refuse)) throw err;
      gen.temps = snapshot;
      dirty = dirtyBefore;
      kept.push({ index, id: fn.id, reason: err.message });
      flush();
      out.push(fn);
    }
  });
  flush();
  return { functions: out, compiledCount, blocks, kept };
}

// ---------------------------------------------------------------------------------------------
// Equivalence

/** Canonical JSON: object keys sorted, so field order never counts as a difference. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export interface PerfEquivalence {
  events: number;
  differing: number;
  /** Field names that differ (never values), at most 20. */
  fields: string[];
}

/** Compare two preview outputs event by event. Only field NAMES are reported, never values. */
export function comparePipelineOutputs(reference: Record<string, unknown>[], candidate: Record<string, unknown>[]): PerfEquivalence {
  const fields = new Set<string>();
  let differing = Math.abs(reference.length - candidate.length);
  const n = Math.min(reference.length, candidate.length);
  for (let i = 0; i < n; i++) {
    const a = reference[i] || {};
    const b = candidate[i] || {};
    let diff = false;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (canonical(a[k]) !== canonical(b[k])) { diff = true; if (fields.size < 20) fields.add(k); }
    }
    if (diff) differing++;
  }
  return { events: Math.max(reference.length, candidate.length), differing, fields: [...fields] };
}
