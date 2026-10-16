// Fabricated zero defaults (packtester audit 2026-10-09: 689 expressions in 160
// OCSF packs). AI mappings coerce with `Number(src_port || 0)` — the prompt even
// taught it — so an event with no port gets `src_endpoint.port: 0`, a value the
// source never sent, and a NODATA flow record gets bytes 0 and packets 0. A
// missing value must stay missing.
//
// The rewrite keeps the expression and guards it: when NONE of the values its
// `|| 0` groups read is present, the field is left absent; when any is, the
// expression runs as written. So `Number(bytes_in || 0) + Number(bytes_out || 0)`
// still sums a half-present pair, and only the all-absent case changes.

import { maskQuoted } from './ocsf-finalize';

interface Fn { id: string; conf?: any; [k: string]: unknown }

const BARE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** The operands of each `( … || 0)` group whose `|| 0` is the group's last top-level term. */
function zeroDefaultOperands(expr: string): string[] {
  const masked = maskQuoted(expr);
  const out: string[] = [];
  const open: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') { open.push(i); continue; }
    if (ch !== ')' || !open.length) continue;
    const start = open.pop()! + 1;
    const body = masked.slice(start, i);
    const m = /\|\|\s*0\s*$/.exec(body);
    if (!m) continue;
    // Only the group's own top level: `a ? b : c || 0` defaults one branch, and
    // `f(a, b || 0)` one argument — neither is a whole-value default.
    let depth = 0, topLevel = true;
    for (const c of body.slice(0, m.index)) {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (depth === 0 && (c === '?' || c === ',')) { topLevel = false; break; }
    }
    if (!topLevel) continue;
    const operand = expr.slice(start, start + m.index).trim();
    if (operand && !out.includes(operand)) out.push(operand);
  }
  return out;
}

/** True when `s` is one parenthesized group: `(a && a.b)`, not `(a) || (b)`. */
function isWrapped(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  const m = maskQuoted(s);
  let depth = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '(') depth++;
    else if (m[i] === ')' && --depth === 0 && i < m.length - 1) return false;
  }
  return true;
}

// A field read is present when it is set and non-empty. A computed operand
// (`new Date(ts).getTime()`) can also yield NaN, which is no value either —
// `x === x` is false only for NaN (no isNaN call: the operand may be a string).
const present = (operand: string) => {
  if (BARE_PATH.test(operand)) return `${operand} != null && ${operand} !== ''`;
  const o = isWrapped(operand) ? operand : `(${operand})`;
  const computed = /[A-Za-z_$\]]\s*\(/.test(maskQuoted(operand).replace(/^\(/, ''));
  return `${o} != null && ${o} !== ''${computed ? ` && ${o} === ${o}` : ''}`;
};

function guardOf(operands: string[]): string {
  return operands.length === 1 ? present(operands[0]) : operands.map(o => `(${present(o)})`).join(' || ');
}

/** `Number(x || 0)` → `x != null && x !== '' ? Number(x || 0) : undefined`. Idempotent. */
export function guardZeroDefault(expr: string): string {
  const e = String(expr ?? '');
  const operands = zeroDefaultOperands(e);
  if (!operands.length) return e;
  const guard = guardOf(operands);
  if (e.startsWith(`${guard} ? (`)) return e;
  return `${guard} ? (${e}) : undefined`;
}

// OCSF enum ids (`severity_id`, `status_id`, `class_uid`…) define 0 as Unknown —
// a real value, so a `|| 0` there is the schema's own default, not a fabrication.
const ENUM_ID = /(?:^|\.)[A-Za-z]\w*_u?id$/;

/** `guardZeroDefault` for the field `name`, unless 0 is that field's own value (an enum id). */
export function guardZeroDefaultFor(name: string, value: string): string {
  if (!name || name.startsWith('__') || (ENUM_ID.test(name) && !name.startsWith('unmapped.'))) return value;
  return guardZeroDefault(value);
}

/** Guard every fabricated zero default in the eval adds of a function list. */
export function dropFabricatedZeroDefaults<T extends Fn>(fns: T[]): T[] {
  if (!Array.isArray(fns)) return fns;
  let any = false;
  const out = fns.map(f => {
    const add = f?.conf?.add;
    if (f?.id !== 'eval' || !Array.isArray(add)) return f;
    let changed = false;
    const next = add.map((a: { name?: unknown; value?: unknown }) => {
      const value = guardZeroDefaultFor(String(a?.name ?? ''), String(a?.value ?? ''));
      if (value === a.value) return a;
      changed = true;
      return { ...a, value };
    });
    if (!changed) return f;
    any = true;
    return { ...f, conf: { ...f.conf, add: next } };
  });
  return any ? out : fns;
}
