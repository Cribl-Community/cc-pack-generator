/**
 * Build the evidence a golden is stored with (docs/specs/golden-trust.md R1).
 *
 * One builder for every writer — the 3-stage parts (src/staged-build.ts), the
 * post-deploy quality store (src/api.ts), and the server-side repair engines
 * (scripts/repair-core.mjs, scripts/ocsf-rebuild.mjs) — so a golden's evidence
 * means the same thing whichever path produced it. It never decides anything:
 * `validateEvidence` / `planGoldenWrite` (src/golden-trust.ts) do. A field this
 * builder cannot determine is left in the shape the trust rules REFUSE (tier
 * null, synthetic count null) rather than defaulted to something that passes.
 */
import type { GoldenEvidence, SampleTier } from './golden-trust';
import { SAMPLE_TIERS } from './golden-trust';
import { sampleFingerprint } from './source-recognition';
import { MIN_COVERAGE_VALUES, sampleValueDenominator } from './pack-builder';
import { describeSampleProvenance, tierFromBuildContext } from './sample-provenance';

export interface GoldenEvidenceInput {
  score: number | null | undefined;
  /** `false` = unscored (Hard Rule 32); the record is then refused. */
  real: boolean;
  scoreSource: string;
  band?: string | null;
  /** The sample the score was measured on — every line, real and extended. */
  sampleEvents: string | readonly unknown[];
  /**
   * Provenance the CALLER knows (the server engines, told by the browser). When
   * absent, the in-context registry (src/sample-provenance.ts) is asked, with
   * `context` as its fallback.
   */
  sampleTier?: string | null;
  syntheticCount?: number | null;
  context?: { sampleTier?: string | null; sourceMode?: string | null };
  /**
   * `false` on a server engine: its context never saw the sample resolve, so an
   * empty registry would read as "0 synthetic lines" — a clean claim nothing
   * measured. Provenance must then arrive explicitly or stay unknown.
   */
  useRegistry?: boolean;
  capsApplied?: string[];
  build?: number | null;
  at?: string;
}

const bandOf = (score: number): string => (score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail');

function linesOf(sample: string | readonly unknown[]): string[] {
  const list = typeof sample === 'string' ? sample.split('\n') : sample.map(e => (typeof e === 'string' ? e : JSON.stringify(e)));
  return list.map(l => String(l ?? '').trim()).filter(Boolean);
}

export function buildGoldenEvidence(input: GoldenEvidenceInput): GoldenEvidence {
  const lines = linesOf(input.sampleEvents || []);
  const ladderTier = input.sampleTier && (SAMPLE_TIERS as readonly string[]).includes(input.sampleTier)
    ? input.sampleTier as SampleTier : null;
  const explicit = ladderTier != null || typeof input.syntheticCount === 'number' || input.useRegistry === false;
  const prov = explicit
    ? {
      sampleTier: ladderTier ?? tierFromBuildContext(input.context || { sampleTier: input.sampleTier }),
      syntheticCount: typeof input.syntheticCount === 'number' ? input.syntheticCount : null,
    }
    : describeSampleProvenance(lines, input.context || { sampleTier: input.sampleTier });
  const denominatorSize = sampleValueDenominator(lines);
  const score = typeof input.score === 'number' ? input.score : (null as unknown as number);
  return {
    score,
    scoreSource: input.scoreSource || '',
    real: input.real === true && typeof input.score === 'number',
    band: input.band || (typeof input.score === 'number' ? bandOf(input.score) : 'na'),
    sampleFp: lines.length ? sampleFingerprint(lines.join('\n')) : null,
    sampleEventCount: lines.length,
    denominatorSize,
    sampleTier: (prov.sampleTier ?? undefined) as SampleTier,
    syntheticCount: prov.syntheticCount as number,
    sparse: denominatorSize < MIN_COVERAGE_VALUES,
    capsApplied: input.capsApplied || [],
    build: input.build ?? (typeof BUILD_NUMBER === 'number' ? BUILD_NUMBER : 0),
    at: input.at || new Date().toISOString(),
  };
}
