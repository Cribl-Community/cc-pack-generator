// OCSF-field optimization rules for the Post-Processing flow.
//
// The Post-Processing flow takes events that are ALREADY OCSF and reshapes them
// for a SIEM destination. This module owns the *optimization* stage of that
// transform: a curated, reviewed set of predicates over OCSF FIELD paths that
// drop / sample / suppress noisy events, or omit / rewrite noisy fields.
//
// Three properties make the model safe, and all three are enforced here at LOAD
// time rather than left to a reviewer's attention:
//
//  1. `ACTION_SCOPE` splits every action into event-scope or field-scope. That
//     split — not `impact` — is the only axis the raw-fidelity gate keys off,
//     because a destination that requires byte-identical `_raw` (XSIAM,
//     CrowdStrike NG-SIEM) can still accept whole-event removal but must never
//     see a field rewritten.
//  2. `impact` (`reshape|noise|filter`) is a hand-authored, reviewed judgment and
//     is deliberately NOT derived from `action`: the same `action:'drop'` is
//     `noise` for a malformed record and `filter` for east-west traffic, and only
//     the latter is a policy decision a customer must opt into.
//  3. `defaultState` IS mechanically tied to `ACTION_SCOPE` — `'active'` only for
//     field-scope. Removing events is always the customer's call, so no
//     event-scope rule may ship enabled and no reviewer can override that.
//
// Rules are predicates over OCSF fields ONLY. A predicate over `_raw` is refused
// outright (design §3d "Deferred"): in this flow `_raw` is the upstream OCSF JSON
// envelope, so a `_raw`-shaped test is measuring the transport, not the event.
//
// NOT reachable from the Sample Sanitizer graph (CLAUDE.md Hard Rule 25) — it is
// imported only by postprocess-builder.ts, which the sanitizer never imports.
import type { PipelineFunction } from './source-recognition';
import qualifiedOptimizationRules from '../config/ocsf-optimization-qualified.json';
import { isSafeEvalExpression, isSafeFieldName, ocsfSchemaOptions, safeEvalFilter } from './pack-builder';

/**
 * The action list is the source of truth for the `OptimizationAction` union, so
 * `ACTION_SCOPE` below is exhaustive BY CONSTRUCTION: adding an action without
 * giving it a scope is a compile error, not a runtime surprise.
 */
export const OPTIMIZATION_ACTIONS = ['drop', 'sample', 'suppress', 'omit', 'transform'] as const;
export type OptimizationAction = typeof OPTIMIZATION_ACTIONS[number];

export type OptimizationScope = 'event' | 'field';

/**
 * Which scope each action operates on. Event-scope actions remove or thin whole
 * events and leave every surviving event byte-identical; field-scope actions
 * rewrite the event body, so they are suppressed for raw-fidelity destinations.
 */
export const ACTION_SCOPE: Record<OptimizationAction, OptimizationScope> = {
  drop: 'event',
  sample: 'event',
  suppress: 'event',
  omit: 'field',
  transform: 'field',
};

export const OPTIMIZATION_IMPACTS = ['reshape', 'noise', 'filter'] as const;
export type OptimizationImpact = typeof OPTIMIZATION_IMPACTS[number];

/**
 * A rule whose predicate is a CSV membership test rather than an expression. The
 * CSV ships in the pack through the existing reference-lookup mechanism (see
 * postProcessLookupsFor) — never inlined into the eval, which is what keeps the
 * list editable in the Cribl UI without touching pipeline code.
 *
 * A MATCH always fires the rule's action, in both modes — `mode` names what the
 * CSV is a list OF (`allow` = known-good destinations whose traffic is routine,
 * `deny` = a top-talkers/top-domains list whose events are repetitive), so it
 * drives the description and the list's intended contents, not the comparison.
 *
 * That is deliberate and it is the SAFE reading of a genuinely ambiguous spec
 * (design §1's inline comment describes `allow` as "match ⇒ keep", while both of
 * §3b's worked examples fire the action ON a match). Both shipped CSVs are empty
 * header-only files: fire-on-match makes an empty list INERT, whereas "match ⇒
 * keep" would make an empty allowlist drop every event the moment an operator
 * enabled the rule. An inert rule is recoverable; a total drop is not.
 *
 * `rows` are the single-column membership values shipped in the pack. Empty means
 * an empty (inert) list the operator fills in the Cribl UI.
 */
export interface OptimizationLookupRef {
  file: string;
  matchField: string;
  lookupField: string;
  mode: 'allow' | 'deny';
  rows?: string[];
}

export interface OcsfOptimizationRule {
  /** `<category>::<source>::<ruleId>` — must agree with its document. */
  key: string;
  /** OCSF class category (`network`, `dns`, …) or `any` for stream-wide. */
  category: string;
  /** Vendor/source slug (`fortinet`, …) or `generic` for the whole category. */
  source: string;
  /** The OCSF dot-path this rule reads; used by the §3c gate to prove the field is populated. */
  ocsfField: string;
  /** Cribl eval predicate. Mutually inclusive-or with `lookup` — at least one. */
  rule?: string;
  lookup?: OptimizationLookupRef;
  /** Fraction of matching events to KEEP, 0 < rate < 1 (0.04 ≈ 1-in-25). */
  sampleRate?: number;
  suppressWindowSec?: number;
  action: OptimizationAction;
  impact: OptimizationImpact;
  /** Destination formats this rule must never be emitted for. */
  excludeDestinations?: string[];
  /** Mechanically ACTION_SCOPE[action] === 'field' ? 'active' : 'inactive'. */
  defaultState: 'active' | 'inactive';
  description: string;
  /** Required iff `impact === 'filter'` — the tradeoff enabling it implies. */
  rationale?: string;
  /** Set by the qualification gate from real samples; never author-guessed. */
  measuredReductionPct?: number;
  /**
   * The author's declaration that no sample this repo can produce exercises this
   * rule, because the OCSF golden spec never populates its `ocsfField`. It is a
   * CLAIM, not a measurement: the gate measures independently, and
   * tests/postprocess-optimization-lookups-test.mjs cross-checks every claim
   * against golden-formats.json so the two cannot drift. Its point is that
   * "unmeasurable" must be its own outcome — a rule the gate could not exercise
   * looks exactly like one that reduced nothing (Hard Rule 32).
   */
  unmeasurable?: boolean;
  /** Required iff `unmeasurable` — why, and what would make it measurable. */
  unmeasurableReason?: string;
  /** Where the rule came from: mined pattern trail, or a curated author's note. */
  provenance?: { authored?: string; patterns?: unknown[] };
  author: string;
  build: number;
  updatedAt: string;
}

/** A golden document holding the rules for one `<category>::<source>` pair. */
export interface OptimizationRuleDoc {
  key: string;
  category: string;
  source: string;
  part: string;
  author: string;
  build: number;
  updated_at: string;
  rules: OcsfOptimizationRule[];
}

/**
 * The shipped catalog. Each seed golden is a STATIC import, deliberately:
 * `import.meta.glob` (used by src/bundled-data.ts) is Vite-only and unavailable
 * under tsx, which is how every test runs — so a globbed catalog would be
 * invisible to the tests that are supposed to guard it. A static list also means
 * a new golden reaching the build is a reviewed diff in this file rather than a
 * file appearing in a directory.
 *
 * Generated only by the qualification gate's explicit `--bundle` mode. The
 * runtime never reads candidates directly: rejected/unmeasurable rules must
 * not become live merely because their candidate JSON ships in the app.
 */
const BUNDLED_RULE_DOCS: unknown[] = Array.isArray(qualifiedOptimizationRules.docs)
  ? qualifiedOptimizationRules.docs
  : [];

let injectedDocs: unknown[] | null = null;
let memo: OcsfOptimizationRule[] | null = null;

/**
 * Replace the rule catalog (tests, and the qualification script's dry-run).
 * `null` restores the bundled catalog. Same push-in shape as `setSecretRules`
 * (Hard Rule 31) and `setSourcetypeVolumes` (Hard Rule 33).
 */
export function setOptimizationRuleDocs(docs: unknown[] | null): void {
  injectedDocs = docs;
  memo = null;
}

const fail = (msg: string): never => { throw new Error(`Invalid OCSF optimization rule: ${msg}`); };

/** `_raw` is the upstream OCSF envelope here — a rule over it is out of model. */
function assertNoRawReference(label: string, text: string): void {
  if (/\b_raw\b/.test(text)) {
    fail(`${label} references \`_raw\` — optimization rules read OCSF fields only, never the raw envelope`);
  }
}

/**
 * Validate one rule document and return its rules. Throws — a rule that cannot
 * match is indistinguishable from a rule that simply did not fire, so it must
 * never reach a pipeline (Hard Rule 32).
 */
export function validateOptimizationRuleDoc(input: unknown): OcsfOptimizationRule[] {
  const doc = input as OptimizationRuleDoc | null;
  if (!doc || typeof doc !== 'object') return fail('document is not an object');
  const category = String(doc.category || '').trim();
  const source = String(doc.source || '').trim();
  if (!category) fail('document has no category');
  if (!source) fail('document has no source');
  if (!Array.isArray(doc.rules)) fail(`document "${category}::${source}" has no rules array`);

  const prefix = `${category}::${source}::`;
  const seenIds = new Set<string>();
  return doc.rules.map((raw, idx) => {
    const r = (raw || {}) as OcsfOptimizationRule;
    const label = `rule ${idx} of "${category}::${source}"`;

    // Enum checks first: everything below is interpreted through action/impact,
    // so an unknown action must not surface as a confusing downstream failure.
    if (!OPTIMIZATION_ACTIONS.includes(r.action as OptimizationAction)) {
      fail(`${label}: unknown action "${String(r.action)}" (expected ${OPTIMIZATION_ACTIONS.join('|')})`);
    }
    if (!OPTIMIZATION_IMPACTS.includes(r.impact as OptimizationImpact)) {
      fail(`${label}: unknown impact "${String(r.impact)}" (expected ${OPTIMIZATION_IMPACTS.join('|')})`);
    }

    // Identity: the rule must agree with the document that carries it, so a
    // copy-pasted rule can never silently apply to the wrong source.
    if (String(r.category || '') !== category) {
      fail(`${label}: category "${String(r.category)}" does not match its document's "${category}"`);
    }
    if (String(r.source || '') !== source) {
      fail(`${label}: source "${String(r.source)}" does not match its document's "${source}"`);
    }
    const key = String(r.key || '');
    if (!key.startsWith(prefix) || key.length <= prefix.length) {
      fail(`${label}: key "${key}" must start with "${prefix}" and name a rule id`);
    }
    const id = key.slice(prefix.length);
    if (seenIds.has(id)) fail(`${label}: duplicate rule id "${id}" within one document`);
    seenIds.add(id);

    // The OCSF field the rule reads — the gate proves this field is populated in
    // a real sample, so it must be a real accessor path.
    const ocsfField = String(r.ocsfField || '');
    if (!ocsfField) fail(`${label}: ocsfField is required`);
    assertNoRawReference(`${label}: ocsfField`, ocsfField);
    if (!isSafeFieldName(ocsfField)) {
      fail(`${label}: ocsfField "${ocsfField}" is not a safe Cribl accessor path`);
    }

    // A predicate, a lookup, or both — but never neither.
    const rule = r.rule === undefined || r.rule === null ? undefined : String(r.rule);
    if (!rule && !r.lookup) {
      fail(`${label}: has neither \`rule\` nor \`lookup\` — it can never match`);
    }
    if (rule !== undefined) {
      if (!rule.trim()) fail(`${label}: \`rule\` is empty`);
      assertNoRawReference(`${label}: rule`, rule);
      if (!isSafeEvalExpression(rule)) {
        fail(`${label}: rule "${rule}" is not a safe Cribl eval expression`);
      }
    }
    if (r.lookup !== undefined) {
      const lk = r.lookup;
      if (!lk || typeof lk !== 'object') fail(`${label}: lookup is not an object`);
      if (!String(lk.file || '').trim()) fail(`${label}: lookup.file is required`);
      if (lk.mode !== 'allow' && lk.mode !== 'deny') {
        fail(`${label}: lookup.mode "${String(lk.mode)}" must be "allow" or "deny"`);
      }
      for (const f of ['matchField', 'lookupField'] as const) {
        const v = String(lk[f] || '');
        if (!v) fail(`${label}: lookup.${f} is required`);
        assertNoRawReference(`${label}: lookup.${f}`, v);
        if (!isSafeFieldName(v)) fail(`${label}: lookup.${f} "${v}" is not a safe Cribl accessor path`);
      }
      if (lk.rows !== undefined && (!Array.isArray(lk.rows) || lk.rows.some(x => typeof x !== 'string'))) {
        fail(`${label}: lookup.rows must be an array of strings when present`);
      }
    }

    // Action-specific parameters. A `sample` with no rate or a `suppress` with no
    // window is a shape, not a rule.
    if (r.action === 'sample') {
      const rate = r.sampleRate;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate >= 1) {
        fail(`${label}: action "sample" needs a sampleRate strictly between 0 and 1 (got ${String(rate)})`);
      }
    }
    if (r.action === 'suppress') {
      const win = r.suppressWindowSec;
      if (typeof win !== 'number' || !Number.isInteger(win) || win <= 0) {
        fail(`${label}: action "suppress" needs a positive integer suppressWindowSec (got ${String(win)})`);
      }
    }

    // A filter-impact rule trades data away for volume; the tradeoff must be
    // written down where the operator enabling it will read it.
    if (r.impact === 'filter' && !String(r.rationale || '').trim()) {
      fail(`${label}: impact "filter" requires a rationale explaining what enabling it gives up`);
    }

    // A bare `unmeasurable: true` would be an unfalsifiable excuse for a rule the
    // gate cannot exercise. Naming the reason is what makes the claim reviewable —
    // and what says which change would retire it.
    if (r.unmeasurable && !String(r.unmeasurableReason || '').trim()) {
      fail(`${label}: unmeasurable requires an unmeasurableReason naming the field the OCSF spec `
        + `does not populate and what would make the rule measurable`);
    }

    // The mechanical tie. Not a reviewer's choice.
    const expectedState = ACTION_SCOPE[r.action] === 'field' ? 'active' : 'inactive';
    if (r.defaultState !== expectedState) {
      fail(`${label}: defaultState "${String(r.defaultState)}" must be "${expectedState}" `
        + `because action "${r.action}" is ${ACTION_SCOPE[r.action]}-scope`);
    }

    // A rule is emitted with a RUNTIME guard derived from its category (an OCSF
    // class_uid) and its source (a vendor_name test) — see compileOptimizationFunctions.
    // A category with no derivable class_uid, or a slug that is not a plain
    // identifier, therefore yields a rule that can never fire (or a guard with a
    // regex-injected slug). Both must fail at LOAD time: a rule that never fires
    // is indistinguishable from one that simply did not match (Hard Rule 32).
    if (!isKnownOptimizationCategory(category)) {
      fail(`${label}: category "${category}" has no OCSF class_uid to guard on `
        + `(expected "${WILDCARD_CATEGORY}" or one of ${knownOptimizationCategories().join(', ')})`);
    }
    for (const [what, slug] of [['category', category], ['source', source]] as const) {
      if (!/^[a-z0-9_]+$/.test(slug)) {
        fail(`${label}: ${what} "${slug}" must be a lowercase [a-z0-9_] slug — it is compiled into a guard expression`);
      }
    }

    if (!String(r.description || '').trim()) fail(`${label}: description is required`);
    if (r.excludeDestinations !== undefined && !Array.isArray(r.excludeDestinations)) {
      fail(`${label}: excludeDestinations must be an array when present`);
    }

    return {
      ...r,
      key,
      category,
      source,
      ocsfField,
      rule,
      author: String(r.author || doc.author || 'unknown'),
      build: Number(r.build || doc.build || 0),
      updatedAt: String(r.updatedAt || doc.updated_at || ''),
    } as OcsfOptimizationRule;
  });
}

/**
 * Does a lookup rule's SHIPPED payload agree with its provenance record in
 * `config/golden-lookups/`?
 *
 * Two files describe one list and they must not drift: the rule's `lookup.rows`
 * is what actually reaches the pack (compileOptimizationFunctions writes the CSV
 * from it), while `config/golden-lookups/<file>.csv` + its index entry is where
 * the license and upstream source are recorded — which is what the §3c gate
 * check 1 requires. Reading the corpus at runtime instead would mean a fourth
 * store for the three-store lookup corpus (Vite glob / fs / backend define) and
 * buys nothing for a list that ships empty, so agreement is ASSERTED here and
 * the assertion is what makes the duplication safe.
 *
 * Pure: the caller injects the file content (`null` for "no such file"), exactly
 * like `readContent` in reference-lookup-select.ts. `ok:false` always carries a
 * reason — a missing CSV must read as a build failure, never as a list that
 * happened to match nothing.
 */
export function lookupCorpusAgreement(
  rule: OcsfOptimizationRule,
  csvContent: string | null | undefined,
): { ok: boolean; reason: string } {
  const lk = rule.lookup;
  if (!lk) return { ok: true, reason: 'rule has no lookup' };
  if (typeof csvContent !== 'string') {
    return {
      ok: false,
      reason: `names lookup file "${lk.file}" but config/golden-lookups/${lk.file} does not exist — `
        + 'the pipeline would ship a lookup that resolves nothing',
    };
  }
  const lines = csvContent.split('\n').map(l => l.trim()).filter(l => l !== '');
  const header = lines[0] || '';
  if (header !== lk.lookupField) {
    return { ok: false, reason: `${lk.file} header is "${header}" but the rule matches on lookupField "${lk.lookupField}"` };
  }
  const corpusRows = lines.slice(1);
  const shipped = [...(lk.rows || [])];
  const missing = corpusRows.filter(r => !shipped.includes(r));
  const extra = shipped.filter(r => !corpusRows.includes(r));
  if (missing.length || extra.length) {
    return {
      ok: false,
      reason: `${lk.file} and the rule's shipped rows disagree — `
        + `${missing.length} row(s) only in the corpus file, ${extra.length} only in the rule`,
    };
  }
  return { ok: true, reason: `${lk.file} agrees with the rule's ${shipped.length} shipped row(s)` };
}

/** Every rule in the active catalog, validated. Memoized; throws on a bad doc. */
export function loadOptimizationRules(): OcsfOptimizationRule[] {
  if (memo) return memo;
  const docs = injectedDocs ?? BUNDLED_RULE_DOCS;
  const all: OcsfOptimizationRule[] = [];
  for (const doc of docs) all.push(...validateOptimizationRuleDoc(doc));
  memo = all;
  return all;
}

const WILDCARD_CATEGORY = 'any';
const WILDCARD_SOURCE = 'generic';

/**
 * Rules applying to one `<category, source>`, most specific first:
 *   category::source → category::generic → any::source → any::generic
 *
 * This is a UNION, deduped by rule id with the most specific winner. A vendor
 * entry therefore OVERRIDES the generic rule of the same id without suppressing
 * the rest of its category — a Fortinet-specific tweak must not silently take
 * the shared east-west rule away from Fortinet.
 *
 * Never throws for a miss: an absent category is "nothing to optimize", which is
 * a normal outcome for a destination pair with no curated rules yet.
 */
export function resolveOcsfOptimizationRules(category?: string, source?: string): OcsfOptimizationRule[] {
  const cat = String(category || '').trim().toLowerCase() || WILDCARD_CATEGORY;
  const src = String(source || '').trim().toLowerCase() || WILDCARD_SOURCE;
  const tiers = [
    `${cat}::${src}`,
    `${cat}::${WILDCARD_SOURCE}`,
    `${WILDCARD_CATEGORY}::${src}`,
    `${WILDCARD_CATEGORY}::${WILDCARD_SOURCE}`,
  ];
  const rules = loadOptimizationRules();
  const out: OcsfOptimizationRule[] = [];
  const seenTiers = new Set<string>();
  const claimedIds = new Set<string>();
  for (const tier of tiers) {
    // Distinct tiers only — `network::generic` is both tier 1 and tier 2 when the
    // source IS `generic`, and its rules must not be listed twice.
    if (seenTiers.has(tier)) continue;
    seenTiers.add(tier);
    for (const r of rules) {
      if (`${r.category}::${r.source}` !== tier) continue;
      const id = r.key.split('::').pop() as string;
      if (claimedIds.has(id)) continue;
      claimedIds.add(id);
      out.push(r);
    }
  }
  return out;
}

const RAW_FIDELITY_FAMILIES = new Set(['xsiam', 'crowdstrike_ngsiem']);

/**
 * Destinations whose contract is the RAW line as received — the vendor parses the
 * wire format itself (XSIAM: `_raw_log` IS our `_raw`, Hard Rule 34), so any
 * field rewrite breaks its parser. Event-scope optimization is still allowed:
 * removing an event never alters a surviving one.
 */
export function requiresRawFidelity(destFormat?: string | null): boolean {
  return RAW_FIDELITY_FAMILIES.has(String(destFormat || '').split('#')[0]);
}

/**
 * The superset used to gate field-scope EMISSION: the raw-fidelity destinations
 * plus the ones that simply perform no field mapping, where a field-scope step
 * would mutate fields that never reach the wire. Keyed on the concrete format,
 * because `splunk#raw` passes through while `splunk#ocsf` maps fields.
 *
 * Kept separate from `requiresRawFidelity` on purpose: that predicate is the
 * spec-named contract for the two vendors, and widening it would silently claim
 * a byte-fidelity guarantee for destinations that never asked for one.
 */
const RAW_PASSTHROUGH_FORMATS = new Set(['splunk#raw', 'elasticsearch', 'chronicle#raw']);
export function isRawPassthroughDestination(destFormat?: string | null): boolean {
  const fmt = String(destFormat || '');
  return requiresRawFidelity(fmt) || RAW_PASSTHROUGH_FORMATS.has(fmt);
}

/** Read an OCSF dot-path, returning undefined rather than throwing mid-walk. */
export function readOcsfField(event: unknown, path: string): unknown {
  if (!event || !path) return undefined;
  let cur: unknown = event;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** `''`, null, undefined and a literal "N/A" carry nothing; `0`/`false` do. */
function isNoiseValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;      // 0 and false are real values
  const t = value.trim();
  return t === '' || t.toUpperCase() === 'N/A';
}

/**
 * Task 2 — the universal noise cleanup: of `fieldPaths`, the ones carrying
 * nothing in EVERY event. A field that is empty in one event and real in another
 * is kept, because omitting it would lose the real value.
 *
 * An empty event list returns `[]`: nothing was measured, and "measured nothing"
 * must never present as "everything is empty" (Hard Rule 32).
 */
export function universalNoiseCleanupFields(events: unknown[] | null | undefined, fieldPaths: string[]): string[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  if (!Array.isArray(fieldPaths) || fieldPaths.length === 0) return [];
  return fieldPaths.filter(path => events.every(ev => isNoiseValue(readOcsfField(ev, path))));
}

/**
 * Every leaf dot-path PRESENT in at least one event (an array counts as a leaf —
 * OCSF arrays are values, not sub-objects to walk). This is the candidate set for
 * the universal cleanup, and "present in at least one event" is the deliberate
 * limit: the cleanup may only ever drop a field we OBSERVED carrying nothing, not
 * one that merely happens to be absent from this sample.
 */
export function ocsfLeafPaths(events: unknown[] | null | undefined, maxDepth = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > maxDepth) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!isSafeFieldName(key)) continue;                     // not addressable by Cribl
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, path, depth + 1);
      } else if (!seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  };
  for (const ev of (Array.isArray(events) ? events : [])) walk(ev, '', 1);
  return out;
}

// ── §3c golden qualification gate ───────────────────────────────────────────
//
// Neither mining (§3a) nor curation (§3b) writes a candidate straight into
// `shared-goldens/`. Every candidate — however it was produced — passes through
// this ONE gate first (design §3c), because two failure modes are cheap to ship
// and expensive to discover later: a rule that looks right but never actually
// matches the OCSF field it claims to (Hard Rule 32's failure mode — a check
// that can't run must never look like it passed), and an `impact` label that
// is wrong because `impact` is a reviewed judgment call, never derivable from
// `action` (see the module header).

export type QualificationVerdict = 'qualified' | 'rejected' | 'unmeasurable';

export interface QualificationResult {
  key: string;
  verdict: QualificationVerdict;
  /** Always non-empty for 'rejected'/'unmeasurable'; empty for 'qualified'. */
  reasons: string[];
  measuredReductionPct?: number;
  sampleSize: number;
  matchedCount: number;
  hasCounterExample: boolean;
}

const rejected = (
  key: string, reasons: string[], sampleSize = 0, matchedCount = 0, hasCounterExample = false,
): QualificationResult => ({ key, verdict: 'rejected', reasons, sampleSize, matchedCount, hasCounterExample });

/**
 * Does a candidate's predicate ACTUALLY fire on this event? `rule` is evaluated
 * with the SAME `safeEvalFilter` the rest of the app uses to measure a compiled
 * filter against a sample (pack-builder.ts's `evaluateDropRate`) — one evaluator,
 * not a second copy of eval semantics. A `lookup` is fire-on-match in both modes
 * (see `OptimizationLookupRef`'s own doc) — a case-insensitive exact match against
 * the rule's SHIPPED rows, mirroring `compileOptimizationFunctions`'s compiled
 * `lookup` function (`matchMode:'exact', ignoreCase:true`). `rule` AND `lookup`
 * both present means both must fire, matching how compilation ANDs them together.
 */
function candidateMatchesEvent(rule: OcsfOptimizationRule, event: unknown): boolean {
  let matched = true;
  if (rule.rule) matched = matched && safeEvalFilter(rule.rule, (event || {}) as Record<string, unknown>);
  if (rule.lookup) {
    const value = String(readOcsfField(event, rule.lookup.matchField) ?? '').toLowerCase();
    const rows = (rule.lookup.rows || []).map(r => r.toLowerCase());
    matched = matched && value !== '' && rows.includes(value);
  }
  return matched;
}

/**
 * Run one authored candidate rule against a real OCSF sample set and decide
 * qualified / rejected / unmeasurable. Deliberately reuses `validateOptimizationRuleDoc`
 * for every STRUCTURAL check (safety, enums, action params, filter-impact
 * rationale, defaultState-vs-ACTION_SCOPE, unmeasurable-needs-reason) rather than
 * re-implementing them — a second copy would drift from Task 1's loader the
 * moment either one changed. This function adds exactly the checks that need
 * REAL sample evidence, which the loader cannot provide on its own.
 *
 * `events` should already be narrowed to the candidate's category (by class_uid)
 * and, when `source` is not `generic`, further narrowed to that vendor — that
 * selection is the caller's job (the qualify script resolves it against the OCSF
 * sample library, design §3c/Task 8); this function only measures.
 */
export function qualifyOptimizationRule(candidate: unknown, events: unknown[]): QualificationResult {
  const c = (candidate || {}) as Partial<OcsfOptimizationRule>;
  const key = String(c.key || `${String(c.category || '?')}::${String(c.source || '?')}::?`);
  const sampleEvents = Array.isArray(events) ? events : [];

  // §3c check 7 / spec §3d "Deferred" — checked BEFORE structural validation so
  // the rejection reason names the real cause instead of the loader's generic
  // "`_raw` referenced" message. In this flow `_raw` is the upstream OCSF
  // envelope, so a predicate over it measures the transport, not the event.
  const rawRefTargets = [
    String(c.ocsfField || ''), String(c.rule || ''),
    String(c.lookup?.matchField || ''), String(c.lookup?.lookupField || ''),
  ];
  if (rawRefTargets.some(t => /\b_raw\b/.test(t))) {
    return rejected(key, [
      'deferred: this candidate tests `_raw` rather than a normalized OCSF field — '
      + 'per design §3d ("Deferred"), a `_raw` predicate measures the transport, not the '
      + 'event, and is out of model for the OCSF optimization stage. Not qualified for v1.',
    ], sampleEvents.length);
  }

  // Structural checks (safety, enums, defaultState/ACTION_SCOPE, filter-impact
  // rationale, unmeasurable-needs-reason, …) — Task 1's own validator, wrapped
  // in a one-rule document so a bad candidate is REJECTED, not thrown, here.
  let rule: OcsfOptimizationRule;
  try {
    const category = String(c.category || '');
    const source = String(c.source || '');
    const oneRuleDoc: OptimizationRuleDoc = {
      key: `${category}::${source}::__qualify__`, category, source, part: 'ocsf_optimization',
      author: String(c.author || 'qualify'), build: Number(c.build || 0), updated_at: String(c.updatedAt || ''),
      rules: [c as OcsfOptimizationRule],
    };
    [rule] = validateOptimizationRuleDoc(oneRuleDoc);
  } catch (err) {
    return rejected(key, [String((err as Error).message)], sampleEvents.length);
  }

  // §3c check 2 — real-sample validation. `ocsfField` must carry a real value
  // (not merely be absent/empty) on at least one available event.
  const populated = sampleEvents.some(ev => !isNoiseValue(readOcsfField(ev, rule.ocsfField)));

  if (rule.unmeasurable) {
    // The author's CLAIM that no sample this repo can produce exercises this rule
    // is itself measured, never taken on faith (Hard Rule 32): if the field turns
    // out to be populated after all, the claim is stale and must be reported as a
    // contradiction rather than silently promoted OR silently accepted.
    if (populated) {
      return rejected(key, [
        `marked unmeasurable ("${rule.unmeasurableReason}") but ocsfField "${rule.ocsfField}" `
        + 'IS populated in the available sample(s) — the claim is stale and must be revisited',
      ], sampleEvents.length);
    }
    return {
      key, verdict: 'unmeasurable', sampleSize: sampleEvents.length, matchedCount: 0, hasCounterExample: false,
      reasons: [rule.unmeasurableReason || 'unmeasurable'],
    };
  }

  if (!populated) {
    return rejected(key, [
      `ocsfField "${rule.ocsfField}" is never populated (non-empty) in the `
      + `${sampleEvents.length} available sample event(s) — an unmeasurable rule is not a golden`,
    ], sampleEvents.length);
  }

  // §3c checks 3 & 4 — a counter-example alongside real matches, and a real
  // (non-zero) measured reduction. Kept as TWO distinct reasons on purpose: "the
  // rule never fires" and "the rule fires on everything" are different defects
  // with different fixes, and collapsing them into one message would hide which
  // one actually happened.
  const matches = sampleEvents.map(ev => candidateMatchesEvent(rule, ev));
  const matchedCount = matches.filter(Boolean).length;
  const hasCounterExample = matchedCount > 0 && matchedCount < sampleEvents.length;
  const measuredReductionPct = sampleEvents.length ? Math.round((matchedCount / sampleEvents.length) * 100) : 0;

  const reasons: string[] = [];
  if (matchedCount === 0) {
    reasons.push(
      `measured 0% reduction — the rule's predicate never matched any of the `
      + `${sampleEvents.length} sample event(s) it was run against`,
    );
  } else if (!hasCounterExample) {
    reasons.push(
      'no counter-example — every available sample event matched, so the rule cannot be '
      + 'shown to correctly leave a real event alone (too narrow a sample to trust, or too broad a rule)',
    );
  }
  if (reasons.length) {
    return { key, verdict: 'rejected', reasons, sampleSize: sampleEvents.length, matchedCount, hasCounterExample, measuredReductionPct };
  }

  return {
    key, verdict: 'qualified', reasons: [], sampleSize: sampleEvents.length, matchedCount, hasCounterExample, measuredReductionPct,
  };
}

// ── compilation to Cribl functions ──────────────────────────────────────────

/** Namespace for the throwaway fields a lookup-driven rule needs. Always stripped. */
export const OPT_SCRATCH_PREFIX = '__opt_';

/** Mirrors pack-builder's own hint so an operator sees one consistent phrasing. */
const DISABLED_HINT = ' (enable in Cribl UI to activate)';

// `audit` and `http` are the spellings the dataclass vocabulary uses for classes
// OCSF names differently; everything else is the ocsfSchemaOptions() key verbatim.
const CATEGORY_ALIASES: Record<string, string> = { audit: 'cloud_audit', http: 'web_proxy' };

/**
 * OCSF `class_uid` a category resolves to, or `null` for the `any` wildcard /
 * an unrecognized category. Exported so the qualify script (Task 4c) can select
 * which sample files in the OCSF sample library actually exercise a category,
 * without re-deriving the alias table.
 */
export function categoryClassUid(category: string): number | null {
  const cat = CATEGORY_ALIASES[category] || category;
  const hit = ocsfSchemaOptions().find(o => o.key === `ocsf#${cat}`);
  return hit ? hit.classUid : null;
}

export function knownOptimizationCategories(): string[] {
  return [WILDCARD_CATEGORY, ...ocsfSchemaOptions().map(o => o.key.replace(/^ocsf#/, '')), ...Object.keys(CATEGORY_ALIASES)];
}

export function isKnownOptimizationCategory(category: string): boolean {
  const c = String(category || '').trim().toLowerCase();
  return c === WILDCARD_CATEGORY || categoryClassUid(c) !== null;
}

/**
 * The guarded-accessor idiom the OCSF→canonical aliases already use: read a nested
 * OCSF path without `?.` (unsupported by Cribl eval) and without throwing when an
 * intermediate object is absent. `src_endpoint.ip` → `(src_endpoint||{}).ip`.
 */
export function guardedOcsfAccessor(path: string): string {
  const segs = String(path || '').split('.');
  let expr = segs[0] || '';
  for (let i = 1; i < segs.length; i++) expr = `(${expr}||{}).${segs[i]}`;
  return expr;
}

const VENDOR_ACCESSOR = `String(${guardedOcsfAccessor('metadata.product.vendor_name')} || vendor || '')`;

/**
 * A vendor slug tested against the OCSF product vendor name. `_` matches a space
 * or hyphen too, because the slug is `palo_alto` and the wire value is
 * "Palo Alto Networks" — an exact-slug test would silently never fire.
 */
function vendorTest(source: string): string {
  return `/${source.replace(/_/g, '[ _-]?')}/i.test(${VENDOR_ACCESSOR})`;
}

/**
 * Plain-JS mirror of `vendorTest`'s slug-matching regex, for OFFLINE measurement
 * (the qualify script narrowing the OCSF sample library to one vendor) rather
 * than compiled-pipeline emission. Kept as a literal mirror rather than deriving
 * one from the other so each stays readable in its own idiom (eval-expression
 * string vs. a plain predicate) — `tests/qualify-ocsf-optimization-rule-test.mjs`
 * and `tests/postprocess-optimization-test.mjs` both exercise the same slugs, so
 * a future drift between the two shows up as a test failure in one of them.
 */
export function eventMatchesSource(event: unknown, source: string): boolean {
  if (String(source || '').trim().toLowerCase() === WILDCARD_SOURCE) return true;
  const vendorName = String(readOcsfField(event, 'metadata.product.vendor_name') || (event as any)?.vendor || '');
  return new RegExp(String(source || '').replace(/_/g, '[ _-]?'), 'i').test(vendorName);
}

const ruleIdOf = (r: OcsfOptimizationRule): string => r.key.split('::').pop() as string;

/** `(a) && (b) && …`, or `'true'` for no parts — never an empty filter string. */
function conjoin(parts: string[]): string {
  const kept = parts.filter(p => p && p.trim());
  return kept.length ? kept.map(p => `(${p})`).join(' && ') : 'true';
}

export interface OptimizationCompileOptions {
  /** Events the universal cleanup is measured against (§4). Omitted → no cleanup. */
  sampleEvents?: unknown[] | null;
  /** Explicit cleanup candidates; omitted → every leaf path present in the sample. */
  candidateFields?: string[] | null;
}

export interface OptimizationSkip { key: string; reason: string }

export interface OptimizationCompileResult {
  functions: PipelineFunction[];
  /** The rules actually emitted, in emission order. */
  rules: OcsfOptimizationRule[];
  /** Rules deliberately NOT emitted for this destination, each with its reason. */
  skipped: OptimizationSkip[];
  lookupFiles: string[];
  /** In-pack CSV payloads, in the deploy shape postProcessLookupsFor returns. */
  lookups: { file: string; content: string; description: string }[];
}

/**
 * Compile the optimization stage for one destination.
 *
 * Every rule in the catalog is emitted, each behind a RUNTIME guard on
 * `class_uid` (its category) and `metadata.product.vendor_name` (its source),
 * because the Post-Processing input is a MIXED OCSF stream — a single pipeline
 * carries network, authentication and HTTP events at once, so the category cannot
 * be decided at build time. The guards read NATIVE OCSF fields, not the canonical
 * aliases, so they keep working for destinations that skip the mapping entirely.
 *
 * The destination gate is `ACTION_SCOPE`, never `impact`: event-scope rules leave
 * every surviving event untouched and so apply everywhere; field-scope rules
 * rewrite the body and are suppressed (with a reason) for a raw destination.
 */
export function compileOptimizationFunctions(
  destFormat: string,
  options: OptimizationCompileOptions = {},
): OptimizationCompileResult {
  const all = loadOptimizationRules();
  const family = String(destFormat || '').split('#')[0];
  const noFieldScope = isRawPassthroughDestination(destFormat);

  const functions: PipelineFunction[] = [];
  const emitted: OcsfOptimizationRule[] = [];
  const skipped: OptimizationSkip[] = [];
  const scratch: string[] = [];
  const lookupRows = new Map<string, { lookupField: string; mode: string; rows: string[] }>();

  for (const r of all) {
    const id = ruleIdOf(r);
    const excluded = r.excludeDestinations || [];
    if (excluded.includes(destFormat) || excluded.includes(family)) {
      skipped.push({ key: r.key, reason: `excluded for "${destFormat}" by the rule's excludeDestinations` });
      continue;
    }
    const scope = ACTION_SCOPE[r.action];
    if (scope === 'field' && noFieldScope) {
      skipped.push({
        key: r.key,
        reason: `"${destFormat}" requires raw fidelity — a field-scope ${r.action} would rewrite the event body`,
      });
      continue;
    }
    if (r.action === 'transform' && !r.rule) {
      skipped.push({ key: r.key, reason: 'action "transform" needs a `rule` expression to compute the new value' });
      continue;
    }

    // Guards. A generic rule that a vendor entry overrides gets that vendor
    // NEGATED, so the override replaces it instead of firing alongside it.
    const guards: string[] = [];
    const uid = categoryClassUid(r.category);
    if (r.category !== WILDCARD_CATEGORY && uid !== null) guards.push(`class_uid == ${uid}`);
    if (r.source !== WILDCARD_SOURCE) {
      guards.push(vendorTest(r.source));
    } else {
      for (const other of all) {
        if (other.category === r.category && other.source !== WILDCARD_SOURCE && ruleIdOf(other) === id) {
          guards.push(`!${vendorTest(other.source)}`);
        }
      }
    }
    const guard = conjoin(guards);

    // A lookup rule needs its match value as a FLAT field (Cribl lookup inFields
    // take a field name, not an expression), and the hit read back into a scratch
    // field. The plumbing stays ENABLED even when the action is disabled, so
    // enabling the rule in the Cribl UI is one click rather than three.
    let predicate = r.rule || '';
    if (r.lookup) {
      const keyField = `${OPT_SCRATCH_PREFIX}${id}_key`;
      const hitField = `${OPT_SCRATCH_PREFIX}${id}_hit`;
      scratch.push(keyField, hitField);
      functions.push({
        id: 'eval',
        filter: guard,
        description: `Prepare lookup key for: ${r.description}`,
        conf: { add: [{ name: keyField, value: `String(${guardedOcsfAccessor(r.lookup.matchField)} || '')` }] },
      });
      functions.push({
        id: 'lookup',
        filter: guard,
        description: `Match ${r.lookup.matchField} against ${r.lookup.file} (editable in-pack list)`,
        conf: {
          matchMode: 'exact',
          reloadPeriodSec: 60,
          addToEvent: false,
          ignoreCase: true,
          inFields: [{ eventField: keyField, lookupField: r.lookup.lookupField }],
          outFields: [{ lookupField: r.lookup.lookupField, eventField: hitField }],
          file: r.lookup.file,
        },
      });
      const hit = `String(${hitField} || '') != ''`;
      predicate = predicate ? `(${predicate}) && (${hit})` : hit;
      const entry = lookupRows.get(r.lookup.file)
        || { lookupField: r.lookup.lookupField, mode: r.lookup.mode, rows: [] };
      for (const row of (r.lookup.rows || [])) if (!entry.rows.includes(row)) entry.rows.push(row);
      lookupRows.set(r.lookup.file, entry);
    }

    const disabled = r.defaultState === 'inactive';
    const description = r.description + (disabled ? DISABLED_HINT : '');

    if (r.action === 'drop') {
      functions.push({ id: 'drop', filter: conjoin([guard, predicate]), disabled, final: true, description, conf: {} });
    } else if (r.action === 'sample') {
      // The function filter carries the guards; the per-rule filter carries the
      // predicate, matching the sampling idiom used by qualified OCSF rules.
      functions.push({
        id: 'sampling', filter: guard, disabled, description,
        conf: { rules: [{ filter: predicate || 'true', rate: Math.max(2, Math.round(1 / (r.sampleRate as number))) }] },
      });
    } else if (r.action === 'suppress') {
      functions.push({
        id: 'suppress', filter: conjoin([guard, predicate]), disabled, description,
        conf: {
          allow: 1,
          suppressPeriodSec: r.suppressWindowSec,
          dropEventsMode: true,
          maxCacheSize: 50000,
          cacheIdleTimeoutPeriods: 2,
          numEventsIdleTimeoutTrigger: 10000,
          keyExpr: guardedOcsfAccessor(r.ocsfField),
        },
      });
    } else if (r.action === 'omit') {
      functions.push({
        id: 'eval', filter: conjoin([guard, predicate]), disabled, description,
        conf: { remove: [r.ocsfField] },
      });
    } else {
      functions.push({
        id: 'eval', filter: guard, disabled, description,
        conf: { add: [{ name: r.ocsfField, value: r.rule as string }] },
      });
    }
    emitted.push(r);
  }

  // §4 universal noise cleanup — field-scope, so gated exactly like every other
  // field-scope step. Candidates are limited to paths OBSERVED carrying nothing.
  if (!noFieldScope) {
    const events = Array.isArray(options.sampleEvents) ? options.sampleEvents : [];
    const candidates = options.candidateFields ?? ocsfLeafPaths(events);
    const empty = universalNoiseCleanupFields(events, candidates).filter(isSafeFieldName);
    if (empty.length) {
      functions.push({
        id: 'eval',
        description: `Omit ${empty.length} OCSF field(s) carrying no value in any sample event (universal noise cleanup)`,
        conf: { remove: empty },
      });
    }
  }

  if (scratch.length) {
    functions.push({
      id: 'eval',
      description: 'Strip optimization scratch fields',
      conf: { remove: scratch },
    });
  }

  // A generated filter is machine-composed from reviewed parts, but the parts are
  // concatenated — re-assert the guard on the RESULT so a composition mistake
  // fails here rather than as a Cribl 500 on PATCH.
  for (const fn of functions) {
    if (fn.filter && !isSafeEvalExpression(fn.filter)) {
      fail(`compiled filter for "${fn.description}" is not a safe Cribl eval expression: ${fn.filter}`);
    }
  }

  const lookups = [...lookupRows.entries()].map(([file, e]) => ({
    file,
    content: [e.lookupField, ...e.rows].join('\n') + '\n',
    description: `Optimization ${e.mode}-list (${e.lookupField}) — edit in the Cribl UI to change what the rule matches`,
  }));

  // A lookup function whose CSV was never shipped resolves every key to nothing:
  // the rule silently stops matching instead of failing (Hard Rule 32). The two
  // sets are built in the same loop above, so this can only break if a future
  // edit ships lookups conditionally — which is exactly when it must be caught.
  for (const r of emitted) {
    if (r.lookup && !lookups.some(l => l.file === r.lookup?.file)) {
      fail(`rule "${r.key}" emits a lookup on "${r.lookup.file}" that is not in the shipped lookup set`);
    }
  }

  return { functions, rules: emitted, skipped, lookupFiles: [...lookupRows.keys()], lookups };
}
