// Per-event extraction gaps (packtester audit 2026-10-09): a parser that handles
// most events wins on the sample average while others get no extraction at all.
// Find those events, group them by layout, gate an extra extraction to them.

import { scoreValueCoverage } from './pack-builder';

export interface EventCoverage {
  index: number;            // position in rawEvents
  score: number | null;     // null = this event has no measurable values
  out: any | null;          // the aligned preview event
}

const META = new Set(['_raw', '_time', 'host', 'source', 'sourcetype', 'index', 'cribl_pipe', 'cribl_breaker']);
const isDataKey = (k: string) => !META.has(k) && !k.startsWith('__') && !k.startsWith('cribl_');
const filled = (v: unknown) => v !== undefined && v !== null && v !== '';

/** Pair raw events with preview events: by `_raw`, else by position; null if neither works. */
export function alignOutputs(rawEvents: string[], outputEvents: any[]): (any | null)[] | null {
  if (!rawEvents?.length || !outputEvents?.length) return null;
  const byRaw = new Map<string, any[]>();
  for (const o of outputEvents) {
    if (o && typeof o._raw === 'string') {
      const list = byRaw.get(o._raw) || [];
      list.push(o);
      byRaw.set(o._raw, list);
    }
  }
  const viaRaw = rawEvents.map(r => byRaw.get(r)?.shift() ?? null);
  if (viaRaw.every(Boolean)) return viaRaw;
  if (outputEvents.length >= rawEvents.length) return rawEvents.map((_, i) => outputEvents[i] ?? null);
  return null;
}

export function perEventCoverage(rawEvents: string[], outputEvents: any[]): EventCoverage[] | null {
  const aligned = alignOutputs(rawEvents, outputEvents);
  if (!aligned) return null;
  return rawEvents.map((raw, index) => {
    const out = aligned[index];
    if (!out) return { index, score: 0, out: null };
    const r = scoreValueCoverage([raw], [out], true);
    return { index, score: r.supported ? r.score : null, out };
  });
}

// Relative, not a floor: under a weak parser the handled events may score 30–45
// and the missed ones 0 (the 2026-10-09 VPC golden) — a floor flags them all.
export const LAG_GAP = 30;   // points under the sample median

/** Events left behind — only when some were handled (all lagging = a failed parser). */
export function laggingEvents(cov: EventCoverage[]): number[] {
  const measured = cov.filter(c => c.score != null) as (EventCoverage & { score: number })[];
  if (measured.length < 2) return [];
  const sorted = measured.map(c => c.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const lag = measured.filter(c => c.score < median - LAG_GAP).map(c => c.index);
  return lag.length && lag.length < measured.length ? lag : [];
}

/** Coarse layout: JSON keys, XML root, or the kinds of the first tokens. */
export function shapeKey(raw: string): string {
  const t = String(raw ?? '').trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const keys = Object.keys(o);
        // {"message":"…"} envelope: the payload is the layout.
        if (keys.length === 1 && typeof o[keys[0]] === 'string') return `json:${keys[0]}>${shapeKey(o[keys[0]])}`;
        return `json:${keys.sort().slice(0, 6).join(',')}`;
      }
    } catch { /* not JSON */ }
  }
  if (/^<[A-Za-z?!]/.test(t)) return `xml:${(t.match(/^<\??([\w:-]+)/) || [])[1] || ''}`;
  const kind = (w: string) =>
    /^\d+$/.test(w) ? 'n'
      : /^\d{1,3}(\.\d{1,3}){3}$/.test(w) ? 'ip'
        : /^[A-Za-z]+-[0-9a-f]+$/i.test(w) ? `${w.split('-')[0].toLowerCase()}-`
          : /^[A-Za-z]+$/.test(w) ? 'w'
            : /^<\d+>/.test(w) ? 'pri'
              : 'x';
  return `text:${t.split(/\s+/).slice(0, 6).map(kind).join(' ')}`;
}

export function groupByShape(rawEvents: string[], indices: number[], max = 2): number[][] {
  const groups = new Map<string, number[]>();
  for (const i of indices) {
    const k = shapeKey(rawEvents[i]);
    groups.set(k, [...(groups.get(k) || []), i]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length).slice(0, max);
}

/** A field filled on every handled event and on none in `group`, else null. */
export function gateField(cov: EventCoverage[], group: number[], lagging: number[]): string | null {
  const inGroup = new Set(group);
  const lag = new Set(lagging);
  const handled = cov.filter(c => !lag.has(c.index) && c.out);
  const gapped = cov.filter(c => inGroup.has(c.index));
  if (!handled.length || !gapped.length) return null;
  for (const k of Object.keys(handled[0].out)) {
    if (!isDataKey(k)) continue;
    if (handled.every(c => filled(c.out[k])) && gapped.every(c => !c.out || !filled(c.out[k]))) return k;
  }
  return null;
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Run `extra` only where `field` is empty, tested once up front (`extra` may set it). */
export function gateFunctions(extra: any[], field: string, n: number): any[] {
  const flag = `__pe_gap${n}`;
  const cond = `__e[${quote(field)}] == null || __e[${quote(field)}] === ''`;
  return [
    { id: 'eval', filter: 'true', conf: { add: [{ name: flag, value: cond }] } },
    ...extra.map(f => {
      const { final: _final, ...rest } = f || {};
      const own = rest.filter && rest.filter !== 'true' ? String(rest.filter) : '';
      return { ...rest, filter: own ? `${flag} && (${own})` : flag };
    }),
    { id: 'eval', filter: 'true', conf: { remove: [flag] } },
  ];
}

export function jsonExtraction(rawEvents: string[], group: number[], baseFns: any[]): any[] | null {
  const allJson = group.every(i => {
    try { const o = JSON.parse(String(rawEvents[i]).trim()); return o && typeof o === 'object' && !Array.isArray(o); } catch { return false; }
  });
  if (!allJson) return null;
  if (baseFns.some(f => f?.id === 'serde' && f?.conf?.type === 'json' && (!f.filter || f.filter === 'true'))) return null;
  return [{ id: 'serde', conf: { mode: 'extract', type: 'json', srcField: '_raw' } }];
}

/** Keep it only if the score rose and no handled event lost more than `tolerance`. */
export function acceptAugmented(before: EventCoverage[], after: EventCoverage[] | null, lagging: number[], beforeScore: number, afterScore: number, tolerance = 5): boolean {
  if (!after || afterScore <= beforeScore) return false;
  const lag = new Set(lagging);
  return before.every(b => {
    if (lag.has(b.index) || b.score == null) return true;
    const a = after.find(x => x.index === b.index);
    return a?.score != null && a.score >= b.score - tolerance;
  });
}

export function lagReason(rawEvents: string[], lagging: number[], total: number, fixed: boolean): string {
  const eg = String(rawEvents[lagging[0]] ?? '').slice(0, 80);
  return fixed
    ? `${lagging.length} of ${total} events were not extracted by the chosen parser (e.g. "${eg}…") — a gated extraction was added for them.`
    : `${lagging.length} of ${total} events extracted little or nothing (e.g. "${eg}…") — no extraction covers that layout yet.`;
}
