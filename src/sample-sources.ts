export interface SampleSource {
  id: string;
  label: string;
  description: string;
  icon: string;
  type: 'builtin' | 'ai';
  eventCount?: string;
}

const BUILTIN_SOURCE: SampleSource = {
  id: 'built-in',
  label: 'Built-in sample',
  description: 'Vendor-format events generated locally from the built-in template — no AI or network required',
  icon: '\u{1F4E6}',
  type: 'builtin',
  eventCount: '100',
};

const AI_SOURCE: SampleSource = {
  id: 'ai-generate',
  label: 'AI-Generated',
  description: 'Generate fresh synthetic events using AI — customizable count and diversity',
  icon: '\u{1F916}',
  type: 'ai',
};

/**
 * Sample sources offered by the AI-generate wizard. Real vendor samples come from the
 * reference tier and the shared samples pool (src/samples-pool.ts), never from a
 * third-party URL: the app fetches no GitHub repository it does not own.
 */
export function getAvailableSources(_sourcetype: string, hasBuiltIn = false): SampleSource[] {
  const sources: SampleSource[] = [];
  if (hasBuiltIn) sources.push(BUILTIN_SOURCE);
  sources.push(AI_SOURCE);
  return sources;
}
