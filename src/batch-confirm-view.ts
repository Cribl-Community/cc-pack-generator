// Batch Confirm box (Group step): packs that already exist in the group, each
// with its pipelines and the stored golden's score per part, so the operator
// can see WHICH part is weak before choosing Overwrite / Skip / Repair /
// Scorecard. Pure data, no React.

export type ConflictAction = 'overwrite' | 'skip' | 'repair' | 'scorecard';

/** A stored golden's scores: the whole pipeline, and its extraction and mapping parts. */
export interface PartScores {
  overall: number | null;
  extraction: number | null;
  mapping: number | null;
}

export interface ConflictPipe {
  pipeline: string;
  sourcetype: string;
  dest: string;
  scores: PartScores;
}

export type ScoreTone = 'good' | 'warn' | 'fail' | 'none';

export function scoreTone(n: number | null | undefined): ScoreTone {
  if (n == null) return 'none';
  return n >= 85 ? 'good' : n >= 60 ? 'warn' : 'fail';
}

/** The pack's headline score: its weakest pipeline, so one bad pipeline is not hidden by good ones. */
export function packScore(pipes: readonly ConflictPipe[]): number | null {
  const known = pipes.map(p => p.scores.overall).filter((n): n is number => n != null);
  return known.length ? Math.min(...known) : null;
}

/** The weakest part across the pack's pipelines, for the "weakest: mapping" hint. Null when all parts score 85+ or none are known. */
export function weakestPart(pipes: readonly ConflictPipe[]): { part: 'extraction' | 'mapping'; score: number } | null {
  let worst: { part: 'extraction' | 'mapping'; score: number } | null = null;
  for (const p of pipes) {
    for (const part of ['extraction', 'mapping'] as const) {
      const s = p.scores[part];
      if (s != null && s < 85 && (!worst || s < worst.score)) worst = { part, score: s };
    }
  }
  return worst;
}

export const CONFLICT_ACTIONS: { key: ConflictAction; label: string; hint: string }[] = [
  { key: 'overwrite', label: 'Overwrite', hint: 'Build it again and replace the pack' },
  { key: 'skip', label: 'Skip', hint: 'Leave the existing pack as it is' },
  { key: 'repair', label: 'Repair', hint: 'Keep the pack, improve its weak parts' },
  { key: 'scorecard', label: 'Scorecard', hint: 'Only score the existing pack' },
];

/** "7 overwrite · 2 skip · 1 repair" for the actions actually chosen. */
export function actionTally(packIds: readonly string[], actions: ReadonlyMap<string, ConflictAction>): string {
  const n = new Map<ConflictAction, number>();
  for (const id of packIds) {
    const a = actions.get(id) || 'overwrite';
    n.set(a, (n.get(a) || 0) + 1);
  }
  return CONFLICT_ACTIONS.filter(a => n.get(a.key)).map(a => `${n.get(a.key)} ${a.label.toLowerCase()}`).join(' · ');
}

/** The line under the pack name: what is weak, or why there is no headline score. */
export function packHint(pipes: readonly ConflictPipe[]): string {
  const headline = packScore(pipes);
  const anyPart = pipes.some(p => p.scores.extraction != null || p.scores.mapping != null);
  if (headline == null) return anyPart ? 'parts stored, no overall score' : 'no stored golden';
  const weak = weakestPart(pipes);
  if (weak) return `weakest: ${weak.part} ${weak.score}`;
  // Parts are fine but the whole pipeline scores lower: the gap is outside
  // extraction and mapping (output shaping, or how the parts combine).
  return headline < 85 ? `overall ${headline}, parts 85+` : 'all parts 85+';
}
