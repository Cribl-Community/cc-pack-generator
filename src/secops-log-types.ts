// Google SecOps log types — which Google default parser an app sourcetype
// belongs to, and whether that parser reads the user's sample.
//
// The Google SecOps raw card sends the original line as the log text and sets
// `__logType` per event; the Cribl Google SecOps destination (unstructured mode)
// passes it as the ingestion label and Google's own maintained parser does the
// UDM mapping. That needs two things to line up: the label is one Google knows
// (an unknown log type fails the WHOLE batch with HTTP 400, so only committed
// labels are ever stamped — never a guess, never a runtime logTypes fetch), and
// the line has a wire format that parser accepts (Google's Format column,
// checked here against the user's sample).
//
// A LEAF module (imports only its data and the leaves sample-format and
// elastic-integration) so
// destination-metadata callers, flow-builder and the card can all reach it.
// Callers pass a CANONICAL sourcetype (canonicalizeSourcetype).
import data from '../config/secops-log-types.json';
import { sampleWireFormat, type SourceWireFormat } from './sample-format';
import { elasticSampleEvents } from './elastic-integration';

export interface SecopsLogType {
  /** The canonical app sourcetype. */
  sourcetype: string;
  /** Google's ingestion label (`__logType`), e.g. FORTINET_FIREWALL. */
  logType: string;
  /** Google's product name for the parser. */
  product: string;
  /** Google's Format column, verbatim. */
  googleFormat: string;
  /** The app wire formats the parser accepts (derived from googleFormat, plus extraFormats). */
  formats: SourceWireFormat[];
  /** The parser's last-updated date on Google's list. */
  updated: string;
  /** `reshape` = the app's reference sample for this source is not in a format the parser reads. */
  fit?: 'reshape';
  note?: string;
}

interface RawLogType { logType: string; product: string; googleFormat: string; updated: string; extraFormats?: string[]; fit?: string; note?: string }

export const SECOPS_PARSER_LIST: { source: string; verified: string } = { source: data.source, verified: data.verified };

const LOG_TYPES = data.logTypes as Record<string, RawLogType>;

/** Google ingestion labels are upper-case identifiers (FORTINET_FIREWALL, BRO_JSON). */
export function isValidSecopsLogType(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(value);
}

const GOOGLE_TOKEN_FORMAT: Record<string, SourceWireFormat> = {
  JSON: 'json', XML: 'xml', CEF: 'cef', LEEF: 'leef', CSV: 'csv', KV: 'kvp',
};

/**
 * Google's Format column → the app wire formats. Alternatives are comma
 * separated; inside one, `+` joins framing and payload (`SYSLOG + KV`) or lists
 * payloads (`CSV + CEF + LEEF + JSON`). SYSLOG on its own is a text line;
 * SYSLOG beside a payload is only the framing, so it adds no format.
 */
export function secopsWireFormatsFromGoogle(googleFormat: string): SourceWireFormat[] {
  const out = new Set<SourceWireFormat>();
  for (const alt of String(googleFormat || '').split(',')) {
    const tokens = alt.split('+').map(t => t.trim().toUpperCase()).filter(Boolean);
    const payload = tokens.filter(t => t !== 'SYSLOG');
    if (!payload.length && tokens.includes('SYSLOG')) out.add('text');
    for (const t of payload) if (GOOGLE_TOKEN_FORMAT[t]) out.add(GOOGLE_TOKEN_FORMAT[t]);
  }
  return [...out];
}

/** The log type for a canonical sourcetype, or null when no Google parser is committed. */
export function secopsLogType(canonicalSourcetype: string | null | undefined): SecopsLogType | null {
  const key = String(canonicalSourcetype || '');
  const r = Object.prototype.hasOwnProperty.call(LOG_TYPES, key) ? LOG_TYPES[key] : null;
  if (!r) return null;
  const formats = new Set(secopsWireFormatsFromGoogle(r.googleFormat));
  for (const f of r.extraFormats || []) formats.add(f as SourceWireFormat);
  return {
    sourcetype: key, logType: r.logType, product: r.product, googleFormat: r.googleFormat,
    formats: [...formats], updated: r.updated, fit: r.fit === 'reshape' ? 'reshape' : undefined, note: r.note,
  };
}

/** Every committed log type (tests and docs). */
export function secopsLogTypes(): SecopsLogType[] {
  return Object.keys(LOG_TYPES).map(k => secopsLogType(k)!);
}

/** What the `secops` destination-metadata contract stamps, or null (no committed label). */
export function secopsLogTypeStamp(canonicalSourcetype: string | null | undefined): { logType: string } | null {
  const t = secopsLogType(canonicalSourcetype);
  return t && isValidSecopsLogType(t.logType) ? { logType: t.logType } : null;
}

/**
 * The sample's events: Windows XML breaks on the `<Event` boundary (newlines
 * inside an event are not event breaks), a JSON sample by object; anything
 * else is one event per non-blank line.
 */
export function secopsSampleEvents(sampleText: string): string[] {
  const text = String(sampleText || '').trim();
  if (/^<Event[\s>]/.test(text)) return text.split(/(?=<Event[\s>])/).map(e => e.trim()).filter(Boolean);
  return elasticSampleEvents(text);
}

/**
 * Does Google's parser accept the sample's wire format? The sample's own wire
 * format decides; a mixed sample (no one format) falls back to the share of
 * events, each read on its own, in an accepted format (`ok` at ≥70%, the
 * agreement bar column detection uses). null = not measurable (no entry, no
 * sample, or no event whose format can be told).
 */
export function secopsSampleFit(entry: SecopsLogType | null | undefined, sampleText: string | null | undefined): { wire: SourceWireFormat | 'mixed'; matched: number; total: number; ok: boolean } | null {
  if (!entry) return null;
  const events = secopsSampleEvents(sampleText || '');
  if (!events.length) return null;
  const wire = sampleWireFormat(events);
  if (wire) {
    const ok = entry.formats.includes(wire);
    return { wire, matched: ok ? events.length : 0, total: events.length, ok };
  }
  const each = events.map(e => sampleWireFormat([e]));
  const known = each.filter((w): w is SourceWireFormat => !!w);
  if (!known.length) return null;
  const matched = known.filter(w => entry.formats.includes(w)).length;
  return { wire: 'mixed', matched, total: events.length, ok: matched / events.length >= 0.7 };
}

export type SecopsSetupStatus = 'ready' | 'mismatch' | 'none';

export interface SecopsLogTypeAdvice {
  status: SecopsSetupStatus;
  entry: SecopsLogType | null;
  /** The SecOps card this source should use: raw + log type when Google's parser reads it, else UDM. */
  recommended: 'chronicle_raw' | 'chronicle';
  /** Plain-language setup and warnings, in order. */
  lines: string[];
}

/**
 * Everything the Google SecOps raw card says for a source: the destination
 * setup, and whether Google's parser will read what the pack sends. The sample,
 * when given, decides; without one the committed `fit` (measured on the app's
 * reference sample) stands in.
 */
export function secopsLogTypeAdvice(canonicalSourcetype: string | null | undefined, sampleText?: string | null): SecopsLogTypeAdvice {
  const entry = secopsLogType(canonicalSourcetype);
  if (!entry) {
    return {
      status: 'none', entry: null, recommended: 'chronicle',
      lines: [`No Google default parser is mapped for ${canonicalSourcetype || 'this source'}: the pack sets no __logType, so the destination's Default log type applies. Use Google Chronicle UDM unless you have a custom parser for this source.`],
    };
  }
  const fit = secopsSampleFit(entry, sampleText);
  const lines = [
    `In the Cribl Google SecOps destination, send unstructured logs with Log text field = _raw and Body size ≤ 4096 KB (Google's 4 MB request limit; 2048 KB recommended).`,
    `The pack sets __logType=${entry.logType} on every event (Google's ${entry.product} parser) and leaves _raw exactly as received; Google maps it to UDM.`,
  ];
  const ok = fit ? fit.ok : entry.fit !== 'reshape';
  if (!ok && !fit) {
    lines.push(`Google's ${entry.logType} parser reads ${entry.googleFormat}, which is not this source's usual shape.${entry.note ? ` ${entry.note}` : ''} Use Google Chronicle UDM, or change the source's output format.`);
  } else if (fit && !fit.ok) {
    const what = fit.wire === 'mixed' ? `only ${fit.matched}/${fit.total} sample events are in a format it reads` : `this sample is ${fit.wire}`;
    lines.push(`Google's ${entry.logType} parser reads ${entry.googleFormat}; ${what}, so those events would be stored unparsed.${entry.note ? ` ${entry.note}` : ''} Use Google Chronicle UDM, or change the source's output format.`);
  } else if (entry.note) {
    lines.push(entry.note);
  }
  return { status: ok ? 'ready' : 'mismatch', entry, recommended: ok ? 'chronicle_raw' : 'chronicle', lines };
}
