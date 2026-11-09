// A pasted or captured "sample line" is sometimes a whole Cribl event
// (`{"_raw":"<vendor log>","_time":…,"host":"…"}`) rather than the vendor log.
// Uploading that JSON as `_raw` makes the parser treat the wrapper as the log:
// Check Point `src` swallowed `_time` and `host`, and CommonSecurityLog then
// had no host to put in DeviceName. Lift the inner log back out and keep the
// envelope fields the destination columns read.

export interface LiftedSampleEvent {
  _raw: string;
  _time?: number;
  host?: string;
  source?: string;
}

export interface LiftedSample {
  events: LiftedSampleEvent[];
  /** How many lines were a Cribl event wrapper rather than the vendor log. */
  lifted: number;
}

const ENVELOPE_KEYS = ['_time', 'host', 'source', 'sourcetype', '__criblEventType'] as const;

function finiteTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** One sample line. `lifted` is false when the line is already the vendor log. */
export function liftCriblEventLine(line: string): { lifted: boolean; event: LiftedSampleEvent } {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('{')) return { lifted: false, event: { _raw: line } };
  let obj: unknown;
  try { obj = JSON.parse(trimmed); } catch { return { lifted: false, event: { _raw: line } }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { lifted: false, event: { _raw: line } };
  const rec = obj as Record<string, unknown>;
  if (typeof rec._raw !== 'string' || !rec._raw.trim()) return { lifted: false, event: { _raw: line } };
  // A vendor JSON document that merely has a field named `_raw` is not an
  // exported Cribl event. Require one envelope field the collector stamps.
  if (!ENVELOPE_KEYS.some(k => rec[k] != null && rec[k] !== '')) return { lifted: false, event: { _raw: line } };
  const event: LiftedSampleEvent = { _raw: rec._raw };
  const time = finiteTime(rec._time);
  if (time != null) event._time = time;
  if (typeof rec.host === 'string' && rec.host.trim()) event.host = rec.host;
  if (typeof rec.source === 'string' && rec.source.trim()) event.source = rec.source;
  return { lifted: true, event };
}

/** Every non-empty line, with Cribl-event wrappers replaced by their inner log. */
export function liftCriblEventSample(sampleEvents: string): LiftedSample {
  const events: LiftedSampleEvent[] = [];
  let lifted = 0;
  for (const line of String(sampleEvents || '').split('\n')) {
    if (!line.trim()) continue;
    const one = liftCriblEventLine(line);
    if (one.lifted) lifted++;
    events.push(one.event);
  }
  return { events, lifted };
}

/**
 * The event stored as a pack sample. Keeps `host` and `source` (CommonSecurityLog
 * DeviceName reads `host`) and unwraps a `_raw` that is itself a Cribl event.
 * `structuredSample` callers keep every field themselves and must not use this.
 */
export function vendorSampleEvent(evt: unknown, nowSec: number): { _raw: string; _time: number; host?: string; source?: string } {
  if (typeof evt === 'string') {
    const one = liftCriblEventLine(evt);
    return {
      _raw: one.event._raw,
      _time: one.event._time ?? nowSec,
      ...(one.event.host ? { host: one.event.host } : {}),
      ...(one.event.source ? { source: one.event.source } : {}),
    };
  }
  if (evt && typeof evt === 'object') {
    const rec = evt as Record<string, unknown>;
    if (typeof rec._raw === 'string') {
      const inner = liftCriblEventLine(rec._raw);
      const host = (typeof rec.host === 'string' && rec.host.trim()) ? rec.host : inner.event.host;
      const source = (typeof rec.source === 'string' && rec.source.trim()) ? rec.source : inner.event.source;
      const time = finiteTime(rec._time) ?? inner.event._time ?? nowSec;
      return {
        _raw: inner.lifted ? inner.event._raw : rec._raw,
        _time: time,
        ...(host ? { host } : {}),
        ...(source ? { source } : {}),
      };
    }
  }
  return { _raw: JSON.stringify(evt ?? ''), _time: nowSec };
}
