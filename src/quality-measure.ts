/**
 * ONE authoritative measurement of a live pipeline, shared by every scorer.
 *
 * Scoring a deployed pipeline is the same job wherever it runs — the backend
 * `scripts/repair-core.mjs` (the app's standalone flow and the
 * `/pack-quality-check` skill), the browser `scoreLivePipeline` (iframe and
 * background Backend Function) and anything added later. It used to be written
 * out three times, and the copies disagreed about the two things that decide a
 * score: which raw keys the spec lens is allowed to see, and whether a pipeline
 * nothing could measure scores 0 or nothing at all.
 *
 * What lives here is everything BETWEEN "a preview ran" and "here is a score":
 * the false-zero retry, the raw-key extraction, the real/unmeasured rule and
 * the repair guidance. What does NOT live here is the transport — each caller
 * still runs its own preview, because the backend previews through the
 * validator handler and the browser through the platform API.
 */
import { scoreAuthoritative, type AuthoritativeScoreResult } from './pack-builder';
import { extractSampleKeys } from './source-recognition';
import { repairGuidanceFindings, type QualityScore } from './quality-stage';

/**
 * The live preview/validate endpoint serializes on the leader, so under
 * concurrent scoring (batch, `/pack-quality-check` concurrency, parallel worker
 * groups) it answers EMPTY for a pipeline that transforms perfectly well — a
 * FALSE zero that drives needless repair rounds and can roll back a good
 * pipeline (Hard Rule 32).
 */
export const ZERO_OUTPUT_RETRIES = 3;
export const ZERO_OUTPUT_BACKOFF_MS = [400, 900, 1600];

/**
 * Only a suspected false zero is retried. A hard error is an ANSWER (retrying
 * it just triples the cost) and a sample with no input events has nothing to be
 * suspicious about.
 */
export function shouldRetryEmptyOutput(observation: {
  error?: string;
  inputCount: number;
  outputCount: number;
}): boolean {
  return !observation.error && observation.inputCount > 0 && observation.outputCount === 0;
}

export interface PreviewAttempt {
  outputEvents: unknown[];
  rawEvents?: string[];
  /** The preview itself failed — not a score of any kind. */
  error?: string;
  /** Counts, where the caller knows them better than the arrays do. */
  inputCount?: number;
  outputCount?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * Run a preview, and re-run it while it looks like a false zero. The first
 * non-empty result wins; an output that stays empty is returned as it is,
 * because a pipeline that genuinely drops every event IS a zero.
 */
export async function previewWithZeroOutputRetry<T extends PreviewAttempt>(
  preview: (attempt: number) => Promise<T>,
  {
    sleep = realSleep,
    retries = ZERO_OUTPUT_RETRIES,
    backoff = ZERO_OUTPUT_BACKOFF_MS,
  }: { sleep?: (ms: number) => Promise<void>; retries?: number; backoff?: number[] } = {},
): Promise<T> {
  let result = await preview(0);
  for (let attempt = 0; attempt < retries; attempt++) {
    const counts = {
      error: result.error,
      inputCount: result.inputCount ?? (result.rawEvents || []).length,
      outputCount: result.outputCount ?? (result.outputEvents || []).length,
    };
    if (!shouldRetryEmptyOutput(counts)) break;
    await sleep(backoff[attempt] ?? backoff[backoff.length - 1] ?? 1600);
    result = await preview(attempt + 1);
  }
  return result;
}

/**
 * The sample a measurement (or a repair) is measured against.
 *
 * A caller that holds the sample text — every background row does, on its
 * artifact — uses it; one that does not reads the pack's own sample, by the
 * sourcetype-scoped name the pipeline parses (Hard Rule 27). The repair path
 * used to skip the fallback and send the model an EMPTY sample while the scorer
 * next to it read the pack sample properly.
 */
export async function resolveSampleLines(
  ref: { sampleEvents?: string },
  readPackSample: () => Promise<string[]>,
): Promise<string[]> {
  const held = (ref.sampleEvents || '').split('\n').map(line => line.trim()).filter(Boolean);
  if (held.length) return held;
  try {
    return (await readPackSample()).map(line => String(line).trim()).filter(Boolean);
  } catch {
    // No sample is a measurable fact ("unmeasured"); a throw here would turn it
    // into a broken row.
    return [];
  }
}

export interface MeasureInput {
  destFormat: string;
  sourcetype?: string;
  rawEvents: string[];
  outputEvents: unknown[];
  /**
   * The model's observations, for the repair prompt only. There is deliberately
   * no way to pass a model SCORE: Rule 12 makes the AI advisory, and an input
   * that can carry an estimate is an input a caller eventually fills in.
   */
  aiFindings?: unknown[];
  lessons?: string[];
  missingFields?: string[];
  emptyFields?: string[];
  /** The preview failed. Nothing below is a measurement. */
  error?: string;
}

export interface Measurement extends QualityScore {
  /** The full authoritative result, for callers that report its internals. */
  auth: AuthoritativeScoreResult | null;
  /** The keys the spec lens saw — derived here, never supplied by a caller. */
  sampleKeys: string[];
}

const unmeasurable = (error: string, sampleKeys: string[] = []): Measurement => ({
  score: null, real: false, error, auth: null, sampleKeys,
  findings: [], lessons: [], missingFields: [], emptyFields: [],
});

/**
 * Turn a preview into a score, or into an honest "unmeasured".
 *
 * The rule, in order, and every branch of it is load-bearing:
 * 1. the preview FAILED → unmeasured;
 * 2. something deterministic measured it → that is the score (Hard Rule 12);
 * 3. nothing deterministic could, and the pipeline emitted NOTHING from a real
 *    sample → a genuine 0: dropping every event is what a noise filter does
 *    on purpose, and reporting that as unmeasured would hide it;
 * 4. anything else — output nobody could score, or no sample to score it
 *    against — → unmeasured, because a number there would be invented
 *    (Hard Rule 32). In particular the model's own estimate is NOT that number;
 *    it is advisory in every run mode (Hard Rule 12).
 */
export function measureAuthoritative(input: MeasureInput): Measurement {
  const rawEvents = (input.rawEvents || []).filter(line => String(line).trim().length > 0);
  const outputEvents = input.outputEvents || [];
  const sampleKeys = [...extractSampleKeys(rawEvents).keys];

  if (input.error) return unmeasurable(input.error, sampleKeys);

  const auth = scoreAuthoritative({
    destFormat: input.destFormat,
    sourcetype: input.sourcetype,
    rawSampleKeys: sampleKeys,
    rawEvents,
    outputEvents,
    aiScore: null,
  });

  const estimated = !auth.real && auth.scoreSource === 'ai';
  if (estimated && !(rawEvents.length > 0 && outputEvents.length === 0)) {
    return unmeasurable(
      outputEvents.length === 0
        ? 'The live preview produced no output and the row has no sample to measure it against.'
        : 'The live output could not be measured — no deterministic lens supports this source and there is no AI estimate.',
      sampleKeys,
    );
  }

  return {
    score: auth.score,
    real: auth.real,
    band: auth.band,
    scoreSource: auth.scoreSource,
    auth,
    sampleKeys,
    // ADVISORY only (Rule 12): what to FIX, never what to score.
    findings: repairGuidanceFindings(auth, input.aiFindings || []),
    // `??`, never `length ? … : fallback`: "nothing is missing" is a RESULT,
    // and a length test turns it into "we did not look" — the repair prompt
    // then chases whatever list the model happened to produce.
    missingFields: input.missingFields
      ?? (auth.golden?.supported ? auth.golden.missing : (auth.spec?.supported ? auth.spec.missingFields : [])),
    emptyFields: input.emptyFields ?? (auth.spec?.supported ? auth.spec.emptyFields : []),
    lessons: input.lessons || [],
  };
}
