/**
 * Golden HOLDOUT — re-measure a stored golden on real samples it was not built on.
 *
 * Why: a golden is admitted on ONE install's score over ONE sample (golden-trust
 * spec, docs/specs/golden-trust.md). The cure the spec prescribes is
 * corroboration — survive re-measurement on a different sample SHAPE — but on its
 * own that waits for another install to reuse the golden. The repo already holds
 * real samples for most sources (curated seeds, hand-curated vendor logs, the
 * catalog's pack samples, the sanitised library), so the same test can run HERE,
 * offline, before a golden is published and on every PR that changes the bundled
 * store (tests/golden-evidence-guard-test.mjs).
 *
 * How: the golden's real function list runs through the offline Cribl emulator
 * (`emulatePipeline`, scripts/build-source-ocsf-samples.mjs) and is scored by the
 * SAME lens that admitted it — `scoreStage` for a 3-stage part, the shared
 * `measureAuthoritative` for a whole pipeline. Each measured sample becomes an
 * ordinary golden-trust observation, so the existing rules decide what it means:
 * a qualifying one on a new shape corroborates, a qualifying contradiction
 * quarantines (R5), a thin or unmeasurable one is recorded and decides nothing.
 *
 * The emulator is an APPROXIMATION of the live preview, so it must earn the right
 * to judge each golden. CALIBRATION: on a sample of the golden's own shape the
 * emulated score must land within QUARANTINE_REGRESSION of the recorded one. A
 * golden the emulator cannot reproduce is `unverified` — never contradicted on
 * the emulator's word (Hard Rule 32: an unmeasurable result must not look like a
 * measured failure). Pipelines using a function or `C.*` helper the emulator does
 * not implement are `unverified` the same way, before anything runs.
 */
import { emulatePipeline, unsupportedFeatures } from './build-source-ocsf-samples.mjs';
import { listRealLocalSamples } from './reference-api.mjs';
import { scoreStage } from '../src/staged-build.ts';
import { measureAuthoritative } from '../src/quality-measure.ts';
import { sampleFingerprint } from '../src/source-recognition.ts';
import { fingerprintsMatch } from '../src/pack-builder.ts';
import { eventsToLines } from '../src/sample-library.ts';
import { splitGoldenVariant } from '../src/golden-variant.ts';
import { buildGoldenEvidence } from '../src/golden-evidence.ts';
import { QUARANTINE_REGRESSION, quarantineDecision, sampleShapeId } from '../src/golden-trust.ts';

/** Lines scored per sample — the same first-8 denominator every live lens reads. */
const SCORED_EVENTS = 8;

/** `<st>[@wire]::<fmt>[::__mapping__]` → its parts. */
export function parseGoldenKey(key) {
  const i = String(key || '').indexOf('::');
  if (i < 0) return null;
  const stSegment = key.slice(0, i);
  const rest = key.slice(i + 2);
  const sourcetype = splitGoldenVariant(stSegment).base;
  if (rest === '__extraction__') return { stSegment, sourcetype, destFormat: '', part: 'extraction' };
  if (rest.endsWith('::__mapping__')) return { stSegment, sourcetype, destFormat: rest.slice(0, -'::__mapping__'.length), part: 'mapping' };
  return { stSegment, sourcetype, destFormat: rest, part: null };
}

/** The shape a golden was proven on — recorded evidence first, else the part's recipe. */
function recordFingerprint(rec) {
  return rec?.evidence?.sampleFp || rec?.recipe?.fingerprint || null;
}

function scoreOne(parsed, functions, extractionFns, lines) {
  const raw = lines.slice(0, SCORED_EVENTS);
  if (parsed.part === 'extraction') {
    const out = emulatePipeline(functions, raw).events;
    return scoreStage('extraction', 'json', parsed.sourcetype, raw, out, []);
  }
  if (parsed.part === 'mapping') {
    const extOut = emulatePipeline(extractionFns, raw).events;
    const out = emulatePipeline([...extractionFns, ...functions], raw).events;
    return scoreStage('mapping', parsed.destFormat, parsed.sourcetype, raw, out, extOut);
  }
  const out = emulatePipeline(functions, raw).events;
  const m = measureAuthoritative({ destFormat: parsed.destFormat, sourcetype: parsed.sourcetype, rawEvents: raw, outputEvents: out });
  return { score: m.error ? null : m.score, band: m.band, real: m.real };
}

/**
 * Re-measure one stored golden. `extractionFns` is required for a mapping part
 * (a mapping only reads what extraction produced) — without it the part is
 * `unverified`. `samples` overrides the local stores (tests).
 *
 * Returns `{ verdict, reason, calibration, observations }`:
 *   unverified    nothing here may judge this golden (reason says why)
 *   measured      calibrated; every observation is real evidence
 *   contradicted  calibrated, and at least one observation quarantines it
 */
export function holdoutMeasure(key, rec, opts = {}) {
  const none = (reason) => ({ verdict: 'unverified', reason, calibration: null, observations: [] });
  const parsed = parseGoldenKey(key);
  if (!parsed) return none('not a golden key');
  const functions = Array.isArray(rec?.functions) ? rec.functions : [];
  if (!functions.length) return none('no functions');
  const extractionFns = parsed.part === 'mapping' ? (opts.extractionFns || null) : [];
  if (parsed.part === 'mapping' && !extractionFns?.length) return none('a mapping part needs its extraction golden to run');
  const unsupported = unsupportedFeatures([...extractionFns, ...functions]);
  if (unsupported.length) return none(`emulator cannot run ${unsupported.join(', ')}`);
  const fp = recordFingerprint(rec);
  if (!fp?.format) return none('golden records no sample shape to calibrate against');
  const recorded = rec?.evidence?.score ?? rec?.score;
  if (typeof recorded !== 'number') return none('golden records no score');

  const pool = (opts.samples || listRealLocalSamples(parsed.sourcetype))
    .map(s => ({ ...s, lines: eventsToLines(s.events).map(l => String(l).trim()).filter(Boolean) }))
    .filter(s => s.lines.length)
    .map(s => ({ ...s, fp: sampleFingerprint(s.lines.join('\n')) }))
    // ONLY samples the golden would actually be SERVED on — the build's own gate
    // (`fingerprintsMatch`: same format, ≥85% of the sample's keys known to the
    // golden; never an unstructured sample, whose shape id cannot tell two event
    // types apart). Grading a golden on a sample the app would never hand it
    // measures the guard, not the golden: the first corpus run "contradicted" a
    // Cisco ASA network mapping on a single non-network ASA message.
    .filter(s => fingerprintsMatch(fp, s.fp));
  if (fp.format === 'unstructured') return none('an unstructured golden is never served on fingerprint (its shape id cannot distinguish event types)');
  if (!pool.length) return none(`no real ${fp.format} sample for ${parsed.sourcetype} the golden would be served on`);

  const ownShape = sampleShapeId(fp);
  const measured = pool.map(s => {
    let r;
    try { r = scoreOne(parsed, functions, extractionFns, s.lines); } catch (e) { r = { score: null, reason: e.message }; }
    return { ...s, score: typeof r?.score === 'number' ? r.score : null, band: r?.band };
  }).filter(m => m.score != null);
  if (!measured.length) return none('no sample produced a measurable score');

  // Calibration: the emulator must reproduce the recorded score on a sample the
  // golden is served on before its word counts at all — on its own shape when the
  // stores hold one, else on the closest served sample.
  const own = measured.filter(m => sampleShapeId(m.fp) === ownShape);
  const calib = own.length ? own : measured;
  const best = Math.max(...calib.map(m => m.score));
  const calibration = { recorded, emulated: best, shape: own.length ? ownShape : 'served', samples: calib.length };
  if (best < recorded - QUARANTINE_REGRESSION) {
    return { ...none(`emulator does not reproduce this golden (emulated ${best} vs recorded ${recorded} on its own shape)`), calibration };
  }

  const observations = measured
    .map(m => buildGoldenEvidence({
      score: m.score, real: true, scoreSource: 'holdout-emulated', band: m.band,
      sampleEvents: m.lines, sampleTier: m.tier, syntheticCount: 0, useRegistry: false,
      build: opts.build ?? 0, at: opts.at,
    }));
  const contradictions = observations
    .map(o => ({ o, d: quarantineDecision(recorded, o) }))
    .filter(x => x.d.quarantine);
  if (contradictions.length) {
    return { verdict: 'contradicted', reason: contradictions[0].d.reason, calibration, observations };
  }
  return { verdict: 'measured', reason: null, calibration, observations };
}
