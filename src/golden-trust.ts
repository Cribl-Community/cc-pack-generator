/**
 * Golden trust — the ONE definition of what a golden's evidence must contain,
 * what standing that evidence earns it, and which of two goldens wins.
 *
 * Spec: docs/specs/golden-trust.md   Guard: tests/golden-trust-test.mjs
 *
 * PURE by construction: no network, no fs, no store, no AI, and no value-import
 * of another app module (only `import type`). Every store — the local JSON file,
 * the shared GitHub pool, the iframe's localStorage — and both scoring engines
 * read the rules from here, so a second copy can never drift (the lesson of
 * Hard Rule 20's forked datatype audit and Hard Rule 34's forked findings).
 *
 * The problem this exists to solve, in one line: a value-coverage score is
 * SOURCE-RELATIVE (Hard Rule 12) and therefore not comparable between installs,
 * yet the shared pool ranked by it — so the thinnest sample won and a 100 could
 * never be beaten. Standing is earned by surviving re-measurement on a different
 * sample SHAPE instead. Score is the second-to-last tiebreak, never the decider.
 */
import type { SampleFingerprint } from './source-recognition';

/**
 * The shared pool's admission bar, as a CODE CONSTANT (spec R6).
 *
 * It must never be the publishing install's `qualityThreshold`: that setting is
 * user-editable and governs only local repair and local storage, so reading it
 * here let one install lower the bar for everybody (`thresholdFor()` in
 * scripts/golden-github.mjs does exactly that today — a client that types 40
 * publishes 40s into a pool every other install reads).
 */
export const POOL_MIN_SCORE = 80;

/** Distinct sample shapes needed for `corroborated`, then for `trusted`. */
export const CORROBORATION_SHAPES = 2;
export const TRUSTED_SHAPES = 3;

/**
 * How far below the recorded score a QUALIFYING observation must land before it
 * contradicts the golden rather than merely disagreeing with it. Value coverage
 * moves a few points between samples for honest reasons (a sample carrying one
 * extra vendor-specific value the destination has no field for), so a small drop
 * must not quarantine a working golden.
 */
export const QUARANTINE_REGRESSION = 15;

/**
 * Which tier resolved the sample the observation was measured on. Same ladder as
 * the resolver (curated → vendor → pool → sanitised → ai), plus `user` for
 * operator-supplied worker-group events, which is the strongest evidence there
 * is: it is that install's real production traffic.
 */
export const SAMPLE_TIERS = ['user', 'curated', 'vendor', 'pool', 'sanitised', 'ai'] as const;
export type SampleTier = (typeof SAMPLE_TIERS)[number];

/**
 * Tier credit, used ONLY as a tiebreak between two observations that already
 * qualify. It deliberately does not encode "trustworthiness" beyond provenance
 * volume — the load-bearing decision (qualifying beats non-qualifying) is
 * structural and happens before any of these numbers are consulted.
 */
const TIER_CREDIT: Record<SampleTier, number> = {
  user: 5, curated: 4, vendor: 4, pool: 3, sanitised: 3, ai: 0,
};

/** Evidence recorded WITH a golden at admission. Immutable once written. */
export interface GoldenEvidence {
  /** The authoritative score (Hard Rule 12), 0-100. */
  score: number;
  /** Which lens produced it: golden-spec | spec-validation | xsiam-spec | value-coverage | ai */
  scoreSource: string;
  /** `false` = UNSCORED, not zero (Hard Rule 32). Only `true` may be stored. */
  real: boolean;
  band: string;
  /** `null` = the record predates fingerprinting; it can never be corroborated. */
  sampleFp: SampleFingerprint | null;
  /** Events the sample actually held (not the 8 the denominator sampled). */
  sampleEventCount: number;
  /** Meaningful sample values the score divided by. */
  denominatorSize: number;
  sampleTier: SampleTier;
  /** AI-extended lines inside the sample (`extendThinSample`). Must be 0 to qualify. */
  syntheticCount: number;
  /** The scorer's own thin-evidence flag. Computed for years; had no reader. */
  sparse: boolean;
  /** Format-conformance caps that fired (Hard Rule 28): 'ocsf', 'cef', 'xsiam', … */
  capsApplied: string[];
  build: number;
  /** ISO timestamp. */
  at: string;
}

/** One re-measurement of a stored golden, from any install (spec R3). */
export interface GoldenObservation extends GoldenEvidence {
  /** The score the record claimed when this observation was taken. */
  recordedScore: number | null;
}

export type TrustState = 'legacy' | 'candidate' | 'corroborated' | 'trusted' | 'quarantined';

/** A golden as the trust rules see it. Stores map their own shape onto this. */
export interface GoldenRecord {
  key: string;
  evidence: GoldenEvidence | null;
  observations: GoldenObservation[];
  /** Set by a quarantine write (spec R5) — a tombstone, never a delete. */
  quarantine?: { reason: string; at: string } | null;
}

export interface ValidationResult { ok: boolean; reasons: string[] }

/**
 * Spec R1 — the gate every writer runs before storing or publishing.
 *
 * Refusing is the whole point: `handleSaveGolden` (scripts/schema-validator.mjs)
 * accepts arbitrary functions with `score || 85` and no fingerprint at all, so
 * without a refusal here the store keeps filling with records nothing can judge.
 */
export function validateEvidence(ev: GoldenEvidence | null | undefined): ValidationResult {
  const reasons: string[] = [];
  if (!ev || typeof ev !== 'object') return { ok: false, reasons: ['no evidence recorded'] };
  if (typeof ev.score !== 'number' || !Number.isFinite(ev.score) || ev.score < 0 || ev.score > 100) {
    reasons.push(`score must be a number in 0-100 (got ${JSON.stringify(ev.score)})`);
  }
  // Not `!ev.real`: an UNSCORED pipeline reports real:false, and a golden built
  // on a measurement that never happened is the exact thing Hard Rule 32 forbids
  // from looking like one that did.
  if (ev.real !== true) reasons.push('score is not real (unmeasured pipelines are never stored)');
  if (!ev.scoreSource) reasons.push('scoreSource missing');
  if (!ev.sampleFp || !ev.sampleFp.format) reasons.push('sampleFp.format missing (a golden must record the shape it was measured on)');
  if (!(ev.sampleEventCount > 0)) reasons.push('sampleEventCount must be > 0');
  if (!(ev.denominatorSize > 0)) reasons.push('denominatorSize must be > 0');
  // These two reach the user verbatim ("golden not stored: …"), so the plain
  // reason leads and the field contract follows in brackets.
  if (!SAMPLE_TIERS.includes(ev.sampleTier)) {
    reasons.push(`where the sample came from is unknown, so it cannot vouch for a golden (sampleTier must be one of ${SAMPLE_TIERS.join('|')}; got ${JSON.stringify(ev.sampleTier)})`);
  }
  // `typeof`, not `>= 0`: `null >= 0` is TRUE in JS, so a writer that did not
  // know whether its sample was AI-extended would have passed as "0 synthetic".
  if (typeof ev.syntheticCount !== 'number' || !(ev.syntheticCount >= 0)) {
    reasons.push('it is unknown how many sample lines were AI-written, and unknown is refused, not assumed clean (syntheticCount must be a number >= 0)');
  }
  if (typeof ev.sparse !== 'boolean') reasons.push('sparse must be a boolean');
  return { ok: reasons.length === 0, reasons };
}

/**
 * The independence key: two observations corroborate only if their samples have
 * DIFFERENT shape ids (decided 2026-09-25 — shape alone, never author or org
 * identity, because the pool is public and a doc's identity fields are published
 * with it).
 *
 * KNOWN LIMIT, deliberately not papered over: `sampleFingerprint` returns
 * `{format:'unstructured', keys:[]}` for every syslog-style source, so all
 * unstructured samples share ONE shape id and a second unstructured observation
 * is never independent. Those goldens stay `candidate`. Do not "fix" that by
 * making two unstructured samples compare as different — that fakes independence
 * the fingerprint cannot see. A token-skeleton shape id would fix it properly
 * and is not built.
 */
export function sampleShapeId(fp: SampleFingerprint | null | undefined): string | null {
  if (!fp || !fp.format) return null;
  const keys = [...(fp.keys || [])].map(k => String(k).toLowerCase()).sort();
  return `${fp.format}|${keys.join(',')}`;
}

/**
 * Whether an observation may PROMOTE a golden. Kept narrow on purpose: a
 * non-qualifying observation is still recorded, still counts AGAINST a golden
 * under `quarantineDecision`, and still tells us about the sample — it just
 * cannot buy standing.
 *
 * `sampleTier === 'ai'` never qualifies: the whole sample is model-generated, so
 * a perfect score proves the pipeline agrees with the model that wrote its input.
 */
export function isQualifying(ev: GoldenEvidence | null | undefined): boolean {
  if (!ev) return false;
  if (!validateEvidence(ev).ok) return false;
  if (ev.sparse) return false;
  if (ev.syntheticCount > 0) return false;
  if (ev.sampleTier === 'ai') return false;
  return ev.score >= POOL_MIN_SCORE;
}

/** Spec R6 — publication is exactly `isQualifying`, against the code constant. */
export function publishableEvidence(ev: GoldenEvidence | null | undefined): ValidationResult {
  const base = validateEvidence(ev);
  if (!base.ok) return base;
  const reasons: string[] = [];
  if (ev!.sparse) reasons.push('sample is sparse');
  if (ev!.syntheticCount > 0) reasons.push(`sample contains ${ev!.syntheticCount} AI-extended line(s)`);
  if (ev!.sampleTier === 'ai') reasons.push('sample is entirely AI-generated');
  if (ev!.score < POOL_MIN_SCORE) reasons.push(`score ${ev!.score} < POOL_MIN_SCORE ${POOL_MIN_SCORE}`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * Evidence volume, for tiebreaking between observations that already qualify.
 * Monotone in each input; capped so one enormous sample cannot dominate.
 */
export function evidenceStrength(ev: GoldenEvidence | null | undefined): number {
  if (!ev) return 0;
  const events = Math.min(Math.max(ev.sampleEventCount || 0, 0), 20);
  const denom = Math.min(Math.max(ev.denominatorSize || 0, 0), 60);
  const tier = TIER_CREDIT[ev.sampleTier] ?? 0;
  const synthetic = Math.max(ev.syntheticCount || 0, 0);
  return tier * 10 + events * 2 + denom - synthetic * 3 - (ev.sparse ? 20 : 0);
}

/** Distinct shapes among the record's own evidence plus its qualifying observations. */
export function independentShapes(rec: GoldenRecord): number {
  const shapes = new Set<string>();
  if (isQualifying(rec.evidence)) {
    const id = sampleShapeId(rec.evidence!.sampleFp);
    if (id) shapes.add(id);
  }
  for (const obs of rec.observations || []) {
    if (!isQualifying(obs)) continue;
    const id = sampleShapeId(obs.sampleFp);
    if (id) shapes.add(id);
  }
  return shapes.size;
}

/**
 * Spec R5 — does this observation CONTRADICT the golden?
 *
 * Only a qualifying observation can: a sparse, synthetic or unmeasured result is
 * evidence about the SAMPLE, not about the golden, and letting one quarantine a
 * working golden would hand every install a way to delete shared knowledge by
 * pointing a thin sample at it.
 */
export function quarantineDecision(
  recordedScore: number | null | undefined,
  obs: GoldenObservation | GoldenEvidence | null | undefined,
): { quarantine: boolean; reason: string | null } {
  if (recordedScore == null || !Number.isFinite(recordedScore)) return { quarantine: false, reason: null };
  if (!obs) return { quarantine: false, reason: null };
  // A LOW qualifying score is the contradiction; `isQualifying` requires
  // score >= POOL_MIN_SCORE, so it is the wrong question here. Ask for the parts
  // that make an observation trustworthy, minus the bar it is failing.
  const base = validateEvidence(obs);
  if (!base.ok) return { quarantine: false, reason: null };
  if (obs.sparse || obs.syntheticCount > 0 || obs.sampleTier === 'ai') return { quarantine: false, reason: null };
  const drop = recordedScore - obs.score;
  if (drop < QUARANTINE_REGRESSION) return { quarantine: false, reason: null };
  // A re-measurement that still clears the pool bar is disagreement with an
  // inflated record, not a contradiction of the golden: 714 of the 1,002 legacy
  // entries record exactly 100, so an honest 85 on a real sample is a 15-point
  // "drop" from a number nobody can account for. Quarantine is for goldens that
  // stop WORKING, which the pool bar is the definition of.
  if (obs.score >= POOL_MIN_SCORE) return { quarantine: false, reason: null };
  return {
    quarantine: true,
    reason: `re-measured at ${obs.score} against a recorded ${recordedScore} `
      + `(-${drop}, threshold ${QUARANTINE_REGRESSION}) on a ${obs.sampleTier} sample `
      + `of ${obs.sampleEventCount} event(s), shape ${sampleShapeId(obs.sampleFp) || 'unknown'}`,
  };
}

/** Spec R2 — standing is DERIVED from the observation log on every read. */
export function deriveTrustState(rec: GoldenRecord): TrustState {
  if (!rec) return 'legacy';
  if (rec.quarantine) return 'quarantined';
  const recorded = rec.evidence?.score ?? null;
  for (const obs of rec.observations || []) {
    if (quarantineDecision(obs.recordedScore ?? recorded, obs).quarantine) return 'quarantined';
  }
  // No evidence = predates spec R1. Served locally so nothing breaks, never
  // published, never preferred (see Migration in the spec).
  if (!validateEvidence(rec.evidence).ok) return 'legacy';
  const shapes = independentShapes(rec);
  if (shapes >= TRUSTED_SHAPES) return 'trusted';
  if (shapes >= CORROBORATION_SHAPES) return 'corroborated';
  return 'candidate';
}

const STATE_RANK: Record<TrustState, number> = {
  trusted: 4, corroborated: 3, candidate: 2, legacy: 1, quarantined: 0,
};

/** A quarantined golden is not served. Every other state is usable locally. */
export function isServable(state: TrustState): boolean { return state !== 'quarantined'; }
/** Only corroborated-or-better may reach the shared pool. */
export function isPublishable(state: TrustState): boolean {
  return state === 'corroborated' || state === 'trusted';
}
/** "Preferred" = chosen over a freshly built candidate without a contest. */
export function isPreferred(state: TrustState): boolean { return state === 'trusted'; }

/**
 * Spec R4 — order two goldens for the same key. Negative = `a` wins.
 *
 * THE load-bearing property, which `score > existing.score` in
 * `publishGoldenDirect` gets exactly backwards:
 *
 *   a score of 100 on a sparse or synthetically-extended sample must NEVER
 *   outrank a 92 measured on twenty verified real events.
 *
 * It is structural, not a weighting that happens to work out: state, then
 * independent shapes, then qualifying-ness are all consulted BEFORE either score
 * is. Do not move `score` up this list — that is the regression this whole spec
 * exists to prevent.
 */
export function compareGoldenCandidates(a: GoldenRecord, b: GoldenRecord): number {
  const sa = deriveTrustState(a); const sb = deriveTrustState(b);
  if (STATE_RANK[sa] !== STATE_RANK[sb]) return STATE_RANK[sb] - STATE_RANK[sa];

  const ia = independentShapes(a); const ib = independentShapes(b);
  if (ia !== ib) return ib - ia;

  const qa = isQualifying(a.evidence) ? 1 : 0;
  const qb = isQualifying(b.evidence) ? 1 : 0;
  if (qa !== qb) return qb - qa;

  const ea = evidenceStrength(a.evidence); const eb = evidenceStrength(b.evidence);
  if (ea !== eb) return eb - ea;

  const scoreA = a.evidence?.score ?? -1; const scoreB = b.evidence?.score ?? -1;
  if (scoreA !== scoreB) return scoreB - scoreA;

  const atA = Date.parse(a.evidence?.at || '') || 0;
  const atB = Date.parse(b.evidence?.at || '') || 0;
  return atB - atA;
}

/** Pick the winner for a key, or null when there is nothing servable. */
export function bestGolden(records: GoldenRecord[]): GoldenRecord | null {
  const servable = (records || []).filter(r => isServable(deriveTrustState(r)));
  if (!servable.length) return null;
  return [...servable].sort(compareGoldenCandidates)[0];
}

export interface ServingInput {
  state: TrustState;
  /**
   * `fingerprintsMatch(record.sampleFp, currentFp)`. `null` = the record has no
   * fingerprint (legacy), which is NOT the same as a fingerprint that disagrees.
   */
  fingerprintMatch: boolean | null;
  /** `sampleMatchesSourceExpectation(sourcetype, sample)`. */
  expectation: 'match' | 'mismatch' | 'unknown';
}

/**
 * Spec R7 — may this stored golden be served for THIS sample?
 *
 * The wire-format expectation guard (`sampleMatchesSourceExpectation`, Hard Rule
 * 14) gates the STATIC parser path today and sits one line away from the stored
 * golden candidate it does not gate. A stored golden is at least as capable of
 * being wrong about the format, so it gets the same guard.
 *
 * Pure on purpose: the two helpers live in pack-builder / source-recognition and
 * importing them here would be circular and would drag the pack-generation tail
 * into a module the sanitizer graph may reach (Hard Rules 25 + 28). Call sites
 * pass their RESULTS in.
 */
export function goldenServingDecision(input: ServingInput): { serve: boolean; preferred: boolean; reason: string | null } {
  if (!isServable(input.state)) return { serve: false, preferred: false, reason: 'golden is quarantined' };
  if (input.expectation === 'mismatch') {
    return { serve: false, preferred: false, reason: 'sample does not match the sourcetype wire-format expectation' };
  }
  if (input.fingerprintMatch === false) {
    return { serve: false, preferred: false, reason: 'sample fingerprint does not match the golden' };
  }
  // A legacy record (no fingerprint) may still be served — refusing would break
  // every pre-spec golden, and the 3-stage builder scores it as one candidate
  // anyway — but it can never be PREFERRED over a measured contest.
  const matched = input.fingerprintMatch === true;
  return { serve: true, preferred: matched && isPreferred(input.state), reason: null };
}

// ---------------------------------------------------------------------------
// The store boundary. Everything above judges a `GoldenRecord`; everything below
// is how a WRITE to any store (the local JSON file, the iframe's KV/localStorage,
// a shared-pool import) is decided, so the three stores run one rule and not
// three that drift. Still pure: callers read the existing record, ask here, and
// write what comes back.
// ---------------------------------------------------------------------------

/**
 * A golden as every store persists it. `evidence`/`observations`/`quarantine` are
 * absent on a record that predates R1 (`legacy`); `functionsHash` identifies the
 * exact function list so a re-measurement of the SAME golden is recorded as an
 * observation instead of competing with itself as a replacement.
 */
export interface StoredGolden {
  functions: unknown[];
  score: number;
  updatedAt?: string;
  recipe?: unknown;
  report?: unknown;
  wireFormat?: string | null;
  evidence?: GoldenEvidence | null;
  observations?: GoldenObservation[];
  quarantine?: { reason: string; at: string } | null;
  functionsHash?: string;
}

/** Observations kept per record, newest last. Bounded so a hot key cannot grow a store without limit. */
export const MAX_OBSERVATIONS = 24;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * Identity of a function list: key order inside a conf does not change what a
 * pipeline does, so it does not change the hash. FNV-1a, not a cryptographic
 * hash — this decides "same golden or a different one", it guards nothing.
 */
export function goldenFunctionsHash(functions: unknown): string {
  const s = stableStringify(Array.isArray(functions) ? functions : []);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `f${h.toString(16).padStart(8, '0')}${s.length.toString(36)}`;
}

function hashOf(rec: StoredGolden | null | undefined): string | null {
  if (!rec) return null;
  return rec.functionsHash || goldenFunctionsHash(rec.functions);
}

/** The trust view of a stored record. */
export function trustRecordOf(key: string, rec: StoredGolden | null | undefined): GoldenRecord {
  return {
    key,
    evidence: rec?.evidence ?? null,
    observations: Array.isArray(rec?.observations) ? rec!.observations! : [],
    quarantine: rec?.quarantine ?? null,
  };
}

/** Standing of a stored record, derived (R2). */
export function storedTrustState(rec: StoredGolden | null | undefined): TrustState {
  return deriveTrustState(trustRecordOf('', rec));
}

function sameObservation(a: GoldenObservation | GoldenEvidence | undefined, b: GoldenEvidence): boolean {
  if (!a) return false;
  return a.score === b.score && a.build === b.build && a.sampleEventCount === b.sampleEventCount
    && a.sampleTier === b.sampleTier && a.scoreSource === b.scoreSource
    && sampleShapeId(a.sampleFp) === sampleShapeId(b.sampleFp);
}

/**
 * Spec R3 — record one re-measurement against a stored golden. A repeat of an
 * observation already in the log (same score, build, lens, tier, sample shape and
 * size) is not a second piece of evidence and is dropped.
 * Returns the record unchanged when there is nothing to add.
 */
export function appendObservation(rec: StoredGolden, ev: GoldenEvidence, at?: string): StoredGolden {
  const observations = Array.isArray(rec.observations) ? rec.observations : [];
  // Against the WHOLE log, not just the last entry: a holdout re-run over N
  // samples would otherwise append N near-duplicates each time and push real
  // reuse verdicts out of the bounded log.
  if (observations.some(o => sameObservation(o, ev))) return rec;
  const obs: GoldenObservation = { ...ev, at: at || ev.at, recordedScore: rec.evidence?.score ?? rec.score ?? null };
  const next = [...observations, obs].slice(-MAX_OBSERVATIONS);
  return { ...rec, observations: next };
}

export type GoldenWriteAction = 'create' | 'replace' | 'observe' | 'keep' | 'refuse';

export interface GoldenWritePlan {
  action: GoldenWriteAction;
  /** The record to persist — absent for `keep` and `refuse`. */
  record?: StoredGolden;
  reasons: string[];
}

export interface GoldenWriteInput {
  functions: unknown[];
  evidence: GoldenEvidence | null | undefined;
  recipe?: unknown;
  report?: unknown;
  wireFormat?: string | null;
  at?: string;
}

/**
 * May `incoming` (a candidate, not yet stored) displace `existing`?
 *
 * The comparator (R4) decides, with one guard it cannot express on its own: a
 * legacy record has no evidence, so it sorts BELOW every evidenced candidate —
 * including one measured on an AI-written or sparse sample. Letting that displace
 * a legacy golden would turn "we know nothing about the old one" into "the new one
 * is better", which is the exact pollution this module exists to stop. Against a
 * legacy record the incoming evidence must QUALIFY.
 */
export function shouldReplaceGolden(existing: StoredGolden | null | undefined, incoming: StoredGolden): { replace: boolean; reason: string } {
  if (!existing) return { replace: true, reason: 'no existing record' };
  const exState = storedTrustState(existing);
  if (exState === 'quarantined') return { replace: true, reason: 'existing record is quarantined' };
  if (exState === 'legacy' && !isQualifying(incoming.evidence)) {
    return { replace: false, reason: 'an unqualified measurement never displaces a legacy golden (sparse, synthetic, AI-sampled or under the pool bar)' };
  }
  const order = compareGoldenCandidates(trustRecordOf('', incoming), trustRecordOf('', existing));
  if (order < 0) return { replace: true, reason: `incoming outranks existing (${storedTrustState(incoming)} vs ${exState})` };
  return { replace: false, reason: `existing ${exState} record outranks the incoming one` };
}

/**
 * Spec R1 + R3 + R4 at the store boundary — what a WRITE of a freshly measured
 * golden does to the record already stored under its key.
 *
 *   refuse   the evidence fails R1, or this exact function list is quarantined
 *            (a tombstone exists so the same golden cannot come straight back)
 *   create   nothing stored yet
 *   observe  the SAME function list re-measured: append the observation (R3); a
 *            legacy record adopts the evidence, since it has now been measured
 *   replace  a different function list that outranks the stored one (R4)
 *   keep     a different function list that does not
 */
export function planGoldenWrite(existing: StoredGolden | null | undefined, input: GoldenWriteInput): GoldenWritePlan {
  const v = validateEvidence(input.evidence);
  if (!v.ok) return { action: 'refuse', reasons: v.reasons };
  const ev = input.evidence!;
  const at = input.at || ev.at || new Date().toISOString();
  const hash = goldenFunctionsHash(input.functions);
  const fresh: StoredGolden = {
    functions: input.functions,
    score: ev.score,
    updatedAt: at,
    recipe: input.recipe ?? existing?.recipe ?? null,
    report: input.report ?? existing?.report ?? null,
    wireFormat: input.wireFormat ?? null,
    evidence: ev,
    observations: [],
    quarantine: null,
    functionsHash: hash,
  };
  if (!existing) return { action: 'create', record: fresh, reasons: [] };

  const exState = storedTrustState(existing);
  if (hashOf(existing) === hash) {
    if (exState === 'quarantined') {
      const why = existing.quarantine?.reason || 'contradicted by a qualifying re-measurement';
      return { action: 'refuse', reasons: [`this exact golden is quarantined: ${why}`] };
    }
    if (!validateEvidence(existing.evidence).ok) {
      // Legacy, now measured. Only QUALIFYING evidence is adopted (it replaces an
      // admission score nobody can account for); anything weaker is recorded as
      // an observation and the record stays legacy — adopting thin or AI-sampled
      // evidence would hand a legacy golden standing it did not earn, and change
      // the fingerprint the bundle guard pins it by.
      if (!isQualifying(ev)) {
        const observed = appendObservation({ ...existing }, ev, at);
        return observed.observations === existing.observations
          ? { action: 'keep', reasons: ['repeat of an earlier observation'] }
          : { action: 'observe', record: observed, reasons: ['unqualified measurement recorded on a legacy golden; it stays legacy'] };
      }
      const adopted: StoredGolden = {
        ...existing, functionsHash: hash, evidence: ev, score: ev.score, updatedAt: at,
        recipe: input.recipe ?? existing.recipe ?? null, report: input.report ?? existing.report ?? null,
        wireFormat: existing.wireFormat ?? input.wireFormat ?? null,
      };
      return { action: 'observe', record: adopted, reasons: ['legacy golden adopted its first recorded evidence'] };
    }
    const observed = appendObservation({ ...existing, functionsHash: hash }, ev, at);
    if (observed === existing || observed.observations === existing.observations) {
      return { action: 'keep', reasons: ['repeat of an earlier observation'] };
    }
    return { action: 'observe', record: observed, reasons: [] };
  }

  const verdict = shouldReplaceGolden(existing, fresh);
  if (verdict.replace) return { action: 'replace', record: fresh, reasons: [verdict.reason] };
  return { action: 'keep', reasons: [verdict.reason] };
}

/**
 * Spec R3 + R5 for a reuse that does NOT re-save: a stored golden entered a build
 * as a candidate and was measured. The verdict is written back whatever it was —
 * a low score is exactly the observation that must be able to quarantine. Only
 * applies when the stored record is still the function list that was measured
 * (`expectedHash`); a record replaced meanwhile is not the one this judged.
 */
export function planGoldenObservation(existing: StoredGolden | null | undefined, ev: GoldenEvidence, expectedHash?: string | null): GoldenWritePlan {
  if (!existing) return { action: 'keep', reasons: ['no stored golden to observe'] };
  if (expectedHash && hashOf(existing) !== expectedHash) return { action: 'keep', reasons: ['stored golden changed since it was measured'] };
  // An observation that fails R1 is not evidence about anything.
  const v = validateEvidence(ev);
  if (!v.ok) return { action: 'refuse', reasons: v.reasons };
  const observed = appendObservation(existing, ev);
  if (observed === existing) return { action: 'keep', reasons: ['repeat of the last observation'] };
  const before = storedTrustState(existing);
  const after = storedTrustState(observed);
  const record = after === 'quarantined' && before !== 'quarantined'
    ? { ...observed, quarantine: { reason: quarantineDecision(existing.evidence?.score ?? existing.score, ev).reason || 'contradicted by a qualifying re-measurement', at: ev.at } }
    : observed;
  return { action: 'observe', record, reasons: after !== before ? [`standing ${before} → ${after}`] : [] };
}

/**
 * A shared-pool doc arriving at a local store. Unlike a fresh build, a pool doc
 * may be LEGACY (the pool predates R1) — admitted only where nothing is stored,
 * exactly as the spec's Migration allows, and never over an existing record. A
 * pool tombstone propagates to the same function list locally (reading a
 * quarantine is always safe; writing one is not — see the publisher).
 */
export function planGoldenImport(existing: StoredGolden | null | undefined, doc: StoredGolden): GoldenWritePlan {
  if (!doc || !Array.isArray(doc.functions) || doc.functions.length === 0) return { action: 'refuse', reasons: ['pool doc has no functions'] };
  const hash = goldenFunctionsHash(doc.functions);
  const incoming: StoredGolden = {
    functions: doc.functions, score: doc.evidence?.score ?? doc.score ?? 0,
    updatedAt: doc.updatedAt || new Date().toISOString(),
    recipe: doc.recipe ?? null, report: doc.report ?? null, wireFormat: doc.wireFormat ?? null,
    evidence: doc.evidence && validateEvidence(doc.evidence).ok ? doc.evidence : null,
    observations: Array.isArray(doc.observations) ? doc.observations.slice(-MAX_OBSERVATIONS) : [],
    quarantine: doc.quarantine ?? null,
    functionsHash: hash,
  };
  const inState = storedTrustState(incoming);
  if (inState === 'quarantined') {
    if (existing && hashOf(existing) === hash && storedTrustState(existing) !== 'quarantined') {
      return { action: 'observe', record: { ...existing, quarantine: incoming.quarantine || { reason: 'quarantined in the shared pool', at: new Date().toISOString() } }, reasons: ['quarantined in the shared pool'] };
    }
    return { action: 'refuse', reasons: ['pool doc is quarantined'] };
  }
  if (!existing) return { action: 'create', record: incoming, reasons: [inState === 'legacy' ? 'legacy pool doc (no evidence) — served locally, never preferred' : ''].filter(Boolean) };
  if (hashOf(existing) === hash) {
    // Same golden: union the observation logs so evidence measured elsewhere counts here.
    let merged: StoredGolden = { ...existing, functionsHash: hash };
    if (!validateEvidence(existing.evidence).ok && incoming.evidence) merged = { ...merged, evidence: incoming.evidence, score: incoming.evidence.score };
    for (const o of incoming.observations || []) {
      const have = (merged.observations || []).some(x => sameObservation(x, o) && x.at === o.at);
      if (!have) merged = { ...merged, observations: [...(merged.observations || []), o].slice(-MAX_OBSERVATIONS) };
    }
    const changed = merged.evidence !== existing.evidence || (merged.observations || []).length !== (existing.observations || []).length;
    return changed ? { action: 'observe', record: merged, reasons: [] } : { action: 'keep', reasons: ['already have this golden and its evidence'] };
  }
  if (inState === 'legacy') return { action: 'keep', reasons: ['a legacy pool doc never replaces a stored golden'] };
  const verdict = shouldReplaceGolden(existing, incoming);
  return verdict.replace
    ? { action: 'replace', record: incoming, reasons: [verdict.reason] }
    : { action: 'keep', reasons: [verdict.reason] };
}

/**
 * Spec R2 + R6 — may this stored record be published to the shared pool? Both the
 * record's own evidence (R6, against the code constant) and its derived standing
 * (corroborated or better) must allow it.
 */
export function publishDecision(rec: StoredGolden | null | undefined): ValidationResult {
  if (!rec) return { ok: false, reasons: ['no local record'] };
  const ev = publishableEvidence(rec.evidence);
  const state = storedTrustState(rec);
  const reasons = [...ev.reasons];
  if (!isPublishable(state)) {
    reasons.push(`standing is ${state} — publishing needs ${CORROBORATION_SHAPES}+ qualifying measurements on different sample shapes (has ${independentShapes(trustRecordOf('', rec))})`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Index-level summary of a record's standing, published beside its score so a reader can rank without fetching the doc. */
export function trustSummary(rec: StoredGolden | null | undefined): { trust: TrustState; shapes: number } {
  return { trust: storedTrustState(rec), shapes: independentShapes(trustRecordOf('', rec)) };
}

/** Rank of a standing, for comparing index entries that carry only `trust`. */
export function trustRank(state: TrustState | string | null | undefined): number {
  return STATE_RANK[(state as TrustState)] ?? STATE_RANK.legacy;
}

/**
 * A local copy of a key vs the app bundle's record for it. The local copy wins
 * when it is the same golden (it carries this install's observations, and any
 * quarantine) or when it would have displaced the bundled one; otherwise the
 * bundle serves — which is how a later app version replaces a stale local copy.
 */
export function pickLocalOverBundled<T extends StoredGolden>(local: T | null | undefined, bundled: T | null | undefined): T | null {
  if (!local) return bundled || null;
  if (!bundled) return local;
  // Two legacy records carry nothing but the stored score (the trust view has no
  // evidence to rank), so the pre-R1 rule is all there is — kept so an install's
  // own pre-evidence work is not silently shadowed by the bundle. STRICTLY higher:
  // an equal copy is redundant, which is what lets compaction free its space.
  const bothLegacy = storedTrustState(local) === 'legacy' && storedTrustState(bundled) === 'legacy';
  if (hashOf(local) === hashOf(bundled)) {
    // The same golden: the local copy matters only if it carries MORE — this
    // install's observations, a quarantine, evidence the bundle lacks.
    const richer = (r: StoredGolden) => (r.quarantine ? 1000 : 0) + (r.observations?.length || 0) + (validateEvidence(r.evidence).ok ? 1 : 0);
    if (richer(local) !== richer(bundled)) return richer(local) > richer(bundled) ? local : bundled;
    if (!bothLegacy) return bundled;
  }
  if (bothLegacy) return (local.score || 0) > (bundled.score || 0) ? local : bundled;
  return shouldReplaceGolden(bundled, local).replace ? local : bundled;
}

/** What a shared-pool INDEX entry carries for ranking (scripts/golden-github.mjs `indexEntryFromDoc`). */
export interface PoolIndexEntry {
  key: string;
  score?: number;
  trust?: TrustState | string | null;
  shapes?: number;
  functionsHash?: string | null;
  evidence?: GoldenEvidence | null;
  quarantine?: { reason: string; at: string } | null;
}

/**
 * Should a pool index entry be OFFERED for import over what this install holds
 * (`local`, null when absent)? Decided from the index alone — the import itself
 * re-decides on the full doc (`planGoldenImport`). Standing first (R2/R4), never a
 * bare higher score: that rule is how a 100 over two AI lines used to be offered
 * as an "upgrade" over real work. A legacy entry never displaces a stored golden;
 * a tombstone is never offered.
 */
export function poolEntryImportStatus(entry: PoolIndexEntry, local: StoredGolden | null | undefined): 'new' | 'upgrade' | null {
  if (!entry || entry.quarantine) return null;
  if (!local) return 'new';
  const localState = storedTrustState(local);
  const localHash = Array.isArray(local.functions) && local.functions.length ? hashOf(local) : (local.functionsHash || null);
  // Checked BEFORE the tombstone branch, to agree with planGoldenImport: a legacy
  // pool doc never replaces a stored record — a local tombstone included — so
  // offering it would be an "upgrade" that fails on every load.
  if (!entry.trust || entry.trust === 'legacy') return null;
  if (localState === 'quarantined') return localHash && localHash === entry.functionsHash ? null : 'upgrade';
  const poolRank = trustRank(entry.trust);
  const localRank = STATE_RANK[localState];
  if (poolRank !== localRank) return poolRank > localRank ? 'upgrade' : null;
  if (localHash && localHash === entry.functionsHash) return null;
  const localShapes = independentShapes(trustRecordOf(entry.key, local));
  if ((entry.shapes || 0) !== localShapes) return (entry.shapes || 0) > localShapes ? 'upgrade' : null;
  const order = compareGoldenCandidates(
    trustRecordOf(entry.key, { functions: [], score: 0, evidence: entry.evidence ?? null, observations: [] }),
    trustRecordOf(entry.key, { ...local, observations: [] }),
  );
  return order < 0 ? 'upgrade' : null;
}
