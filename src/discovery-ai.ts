/**
 * AI suggestions for whiteboard rows nothing matched (spec R18; Phase 3c).
 *
 * Advisory only: a suggestion is shown under its row and applied only when the SE
 * clicks it. Grounded: a source suggestion must be a supported sourcetype, a format
 * suggestion one of the demo formats — anything else is dropped, never shown. The
 * prompt carries the row's label and nothing else (no prospect, no other row,
 * spec R13). Pure: the callers pass the transport in.
 *
 * Shared by the platform (ai-client, called from the browser) and standalone
 * (scripts/ai-validate.mjs `mode:'demo-format'`), so both ask the same question.
 */

export interface AiSourceSuggestion {
  status: 'suggested' | 'real-unsupported' | 'none' | 'unavailable';
  picks: string[];
  why: string;
}

const normName = (s: string) => s.trim().toLowerCase().replace(/[\s:/-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

/**
 * Read the grounded sourcetype resolver's answer (aiValidate). Its failure mode is a
 * silent "valid" with no suggestion and no clarification — that is "unavailable",
 * not "matched".
 */
export function readSourceSuggestion(out: unknown, supported: ReadonlySet<string>): AiSourceSuggestion {
  const o = (out && typeof out === 'object' ? out : {}) as Record<string, unknown>;
  const suggestion = typeof o.suggestion === 'string' ? o.suggestion : '';
  const clarification = typeof o.clarification === 'string' ? o.clarification.trim() : '';
  const byNorm = new Map([...supported].map(n => [normName(n), n]));
  const picks = [...new Set(suggestion.split(',').map(s => byNorm.get(normName(s))).filter((n): n is string => !!n))].slice(0, 3);
  if (picks.length) return { status: 'suggested', picks, why: clarification || 'Closest supported source for this label.' };
  if (!suggestion && !clarification && o.isRealSource === undefined) return { status: 'unavailable', picks: [], why: 'The AI did not answer. Check Settings → AI, then try again.' };
  // The resolver's own wording here ("build via AI") is batch advice; a demo cannot build it from this screen.
  if (o.isRealSource === true) return { status: 'real-unsupported', picks: [], why: 'A real product, but no supported source has a parser for it yet. Leave it out, or search for the nearest source.' };
  return { status: 'none', picks: [], why: clarification || 'The AI found no supported source for this label.' };
}

export interface DemoFormatOption { format: string; label: string; system: string }

export function demoFormatSystemPrompt(options: DemoFormatOption[]): string {
  return `You pick the OUTPUT FORMAT a Cribl Stream demo should send to a destination product, from the product's name alone. Return ONLY valid JSON, no markdown.

FORMATS (choose one KEY from this list, or abstain — NEVER invent a key):
${options.map(o => `- ${o.format}: ${o.label} (${o.system})`).join('\n')}

Rules:
- Pick the format the product ingests natively, through its own API or parser: an Elasticsearch-compatible API → an elastic_* key; a Splunk HEC-compatible endpoint → a splunk/cim key; a SIEM that parses CEF over syslog → cef; a SIEM that takes vendor raw events and parses them itself → the matching raw key, else passthrough; plain HTTP JSON ingestion → json; a data lake or warehouse → ocsf.
- Only answer when you know the product. Unknown or too generic → "format": "".
Return JSON: {"format":"<key or empty>","why":"one short sentence naming the ingestion path you relied on","confidence":"high|low"}`;
}

export const demoFormatUserPrompt = (label: string): string => `Destination product: "${String(label || '').slice(0, 120)}"`;

/** Parse a demo-format answer; a key outside `allowed`, or a low-confidence pick, is no suggestion. */
export function parseDemoFormatAnswer(text: string, allowed: ReadonlySet<string>): { format: string | null; why: string } {
  let o: Record<string, unknown> = {};
  try { o = JSON.parse(text); } catch {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b > a) { try { o = JSON.parse(text.slice(a, b + 1)); } catch { /* none */ } }
  }
  const format = typeof o.format === 'string' ? o.format.trim() : '';
  const why = typeof o.why === 'string' ? o.why.trim() : '';
  if (!format || !allowed.has(format)) return { format: null, why: why || 'The AI does not know this product well enough to pick a format.' };
  if (o.confidence === 'low') return { format: null, why: why ? `Not sure enough to suggest: ${why}` : 'The AI was not sure enough to suggest a format.' };
  return { format, why };
}
