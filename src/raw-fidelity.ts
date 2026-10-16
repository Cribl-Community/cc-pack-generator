// Shared raw-fidelity destination logic (plan Task 5) — the ONE function both
// the main wizard's `nextgen` (CrowdStrike NG-SIEM) destination and
// Post-Processing's `crowdstrike_ngsiem`/`xsiam` destinations call, so "the
// same underlying function" is a fact provable by import, not just matching
// output shape.
//
// Deliberately a LEAF module with NO imports from pack-builder.ts or
// postprocess-optimization.ts. postprocess-optimization.ts already imports
// FROM pack-builder.ts (isSafeEvalExpression, safeEvalFilter, …); if
// pack-builder.ts imported back from postprocess-optimization.ts to reach this
// logic, that would be a circular import. Keeping this module self-contained
// is what lets pack-builder.ts (main wizard) and postprocess-builder.ts
// (Post-Processing) both reach it safely.
import type { PipelineFunction } from './source-recognition';

/**
 * Tag `__vendor`/`__product` for raw-fidelity routing, read from the OCSF
 * envelope's OWN `metadata.product` fields at RUNTIME — never resolved once
 * from a sourcetype the way `xsiam-resolver.ts`'s `resolveXsiamDestination()`
 * does for the main wizard's existing `xsiam` destination.
 *
 * That resolver's signature (one sourcetype string -> one static resolution)
 * cannot serve as the shared implementation here: Post-Processing's input is a
 * MIXED OCSF stream with no sourcetype available at all, and the main
 * wizard's `nextgen` destination gives up its own OCSF field mapping — the
 * very thing that would otherwise carry a sourcetype-derived vendor — the
 * moment it goes raw-fidelity (see `buildOcsfEnvelopeHeader` in
 * pack-builder.ts, which populates `metadata.product` from a MINIMAL envelope
 * instead). Reading the event's own envelope is therefore the one tagging
 * strategy that works identically in both places.
 *
 * Guarded accessors (no `?.` — unsupported by Cribl eval) so an absent
 * `metadata`/`metadata.product` yields `undefined`, never a thrown eval.
 */
export function buildRawFidelityTagFunctions(): PipelineFunction[] {
  return [{
    id: 'eval',
    description: 'Tag __vendor/__product from the OCSF envelope for raw-fidelity routing',
    conf: {
      add: [
        { name: '__vendor', value: "(metadata||{}).product && (metadata.product||{}).vendor_name || undefined" },
        { name: '__product', value: "(metadata||{}).product && (metadata.product||{}).name || undefined" },
      ],
    },
  }];
}

// NG-SIEM raw fidelity: the connector's vendor parser reads only the HEC `event`,
// so an event is right when its `_raw` is an ORIGINAL sample line, unchanged, and
// nothing billable travels beside it. `_time` rides as the HEC `time`; `__*` never
// leaves Cribl; `cribl_*` is stamped by the platform after the pack (cleared with the
// destination's "Fields to keep"), so neither is the pack's fault.
export interface RawFidelityAudit {
  applicable: boolean;
  events: number;
  faithful: number;
  altered: number;      // _raw missing, empty or not a sample line
  extraFields: string[]; // billable keys shipped beside _raw (union, ≤20)
  cap: number | null;
}

export function auditRawFidelity(rawEvents: string[], outputEvents: any[]): RawFidelityAudit {
  const none: RawFidelityAudit = { applicable: false, events: 0, faithful: 0, altered: 0, extraFields: [], cap: null };
  const evs = (outputEvents || []).filter(e => e && typeof e === 'object');
  // Both sides compare line-trimmed with blank lines dropped: indentation and
  // trailing whitespace inside a multi-line event are not what a parser reads.
  const norm = (v: string) => v.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  const lines = (rawEvents || []).map(l => norm(String(l))).filter(Boolean);
  if (!evs.length || !lines.length) return none;
  const exact = new Set(lines);
  // A multi-line event (Windows XML) may arrive as several newline-split sample
  // lines, so a MULTI-line _raw may match a run of whole consecutive lines. A
  // single line must be a whole sample event: one line cut out of a multi-line
  // event is a fragment a parser left behind, not the original.
  const joined = `\n${lines.join('\n')}\n`;
  const extra = new Set<string>();
  let faithful = 0, altered = 0;
  for (const ev of evs) {
    const raw = typeof ev._raw === 'string' ? norm(ev._raw) : '';
    const rawOk = raw.length > 0 && (exact.has(raw) || (raw.includes('\n') && joined.includes(`\n${raw}\n`)));
    const keys = Object.keys(ev).filter(k => k !== '_raw' && k !== '_time' && !k.startsWith('__') && !k.startsWith('cribl_'));
    keys.forEach(k => extra.add(k));
    if (!rawOk) altered++;
    if (rawOk && keys.length === 0) faithful++;
  }
  return {
    applicable: true, events: evs.length, faithful, altered,
    extraFields: [...extra].slice(0, 20),
    cap: Math.round((faithful / evs.length) * 100),
  };
}

/** Repair guidance for a raw-fidelity miss — the fix is always "send the original line, alone". */
export function rawFidelityIssues(a: RawFidelityAudit | null | undefined): string[] {
  if (!a?.applicable) return [];
  const out: string[] = [];
  if (a.altered) out.push(`${a.altered}/${a.events} events do not carry the original line in _raw — the NG SIEM vendor parser needs it byte for byte. Restore _raw from the untouched copy as the last step.`);
  if (a.extraFields.length) out.push(`Fields beside _raw are billed by NG SIEM and ignored by its parser: ${a.extraFields.slice(0, 8).join(', ')}. Keep only _raw and _time.`);
  return out;
}
