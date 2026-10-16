/**
 * Cortex XSIAM destination resolution — the ordered chain from
 * docs/destination-specs/xsiam.md.
 *
 *   T1a  validated pack pipeline      (mirror says a Palo-provided sample links to it)
 *   T1c  pack pipeline placeholder    (documented UUID, shape never exercised)
 *   T2   dedicated UUID from the doc  (no pack pipeline exists)
 *   T1b  generic CEF pack pipeline    (source established as CEF)
 *   T3   demisto INGEST vendor/product
 *   T3m  demisto MODEL-only dataset   (vendor/product split out of the dataset name)
 *   T4   unresolved — the build fails
 *
 * Two decisions sit OUTSIDE the walk, because they are about authority rather than
 * coverage, and conflating them with the tier is what made earlier designs wrong:
 *   - the Palo Alto doc owns the UUID VALUE even when a pack pipeline owns the shape
 *     (ordering rule 4), and
 *   - an asserted required format outranks a format inferred from a sample.
 *
 * Deliberate design constraints:
 *   - **Pure over committed data.** Three mirrors in, a decision out. No network, no
 *     AI, no filesystem, so it behaves identically in iframe and standalone (Hard
 *     Rule 18) and every test is offline.
 *   - **No import of `pack-builder` or `sample-library`.** `sample-library` imports
 *     `pack-builder`, so importing either here would create a cycle the moment the
 *     builder calls the resolver. The caller passes an ALREADY-canonicalized
 *     sourcetype (`canonicalizeSourcetype()`) and an ALREADY-classified sample format
 *     (`describeSampleFormat(events).id`).
 *   - **Pipeline bodies are not loaded.** A resolution names the pipeline; the builder
 *     reads the mirrored functions when it replays them. Loading 74 JSON files here
 *     would cost every consumer, including the iframe bundle, for one lookup.
 */

import packIndex from '../config/xsiam-pack/index.json';
import uuidCatalog from '../config/xsiam-uuid-catalog.json';
import demistoIndex from '../config/xsiam-demisto-index.json';
import sourceMap from '../config/xsiam-source-map.json';

export type XsiamTier = 'T1a' | 'T1b' | 'T1c' | 'T2' | 'T3' | 'T3m' | 'T4';

/** Where a required input format came from. An assertion beats an example. */
export type XsiamFormatAuthority = 'demisto-readme' | 'pack-sample';

export interface XsiamRequiredFormat {
  format: string;
  authority: XsiamFormatAuthority;
  evidence: string;
  /**
   * `fail` — Palo Alto ASSERTED this format, so a mismatch refuses the build
   * (FortiGate: `set format cef`).
   *
   * `advise` — the format was inferred from a Palo-provided sample, which evidences
   * ONE accepted shape and cannot prove others are rejected. Hard-failing on it would
   * contradict that: Cisco ASA's sample is syslog, so a legitimate CEF-wrapped ASA feed
   * would be refused on no evidence at all. Report the mismatch prominently, build anyway.
   */
  enforcement: 'fail' | 'advise';
}

export interface XsiamProvenance {
  tier: XsiamTier;
  /** Human-readable knowledge source, for the pipeline's leading comment. */
  source: string;
  packVersion: string | null;
  docSyncedAt: string | null;
  contentCommit: string | null;
  mapEvidence: string | null;
  /** Set when ordering rule 4 replaced a pack pipeline's identifier with the doc's. */
  uuidOverriddenFrom?: string;
  notes: string[];
}

export interface XsiamResolution {
  resolved: boolean;
  tier: XsiamTier;
  sourcetype: string;
  /** Mirrored pipeline to replay verbatim, for T1a / T1b / T1c. */
  packPipeline: string | null;
  /** True only on T1a: a Palo-provided sample exercised this pipeline's shape. */
  validated: boolean;
  sourceIdentifier: string | null;
  sourceIdField: string | null;
  vendor: string | null;
  product: string | null;
  dataset: string | null;
  /** Upstream rewrites `_raw` on purpose here, so byte-identity must not be asserted. */
  reshapesRaw: boolean;
  /** Breaker rulesets the replayed pipeline needs; the generated pack must ship them. */
  breakerRulesets: string[];
  requiredInputFormat: XsiamRequiredFormat | null;
  provenance: XsiamProvenance;
  /** Present only when `tier === 'T4'`. */
  failure?: { reason: string; consulted: string[] };
}

export interface ResolveXsiamOptions {
  /**
   * `describeSampleFormat(events).id` — the classified format of the sample the pack
   * will be built from. Omitted means "no sample yet", which is a valid state: T1b can
   * still be reached through an asserted CEF requirement.
   */
  sampleFormat?: string | null;
}

const GENERIC_UUID = 'af01292940d7426594d3d3e55ae17ee0';
const GENERIC_CEF_PIPELINE = 'XSIAM-All-CEF-Formatted-Events';

interface PackPipelineMeta {
  pattern: string;
  sourceIdField: string;
  sourceIdentifier: string | null;
  vendor: string | null;
  product: string | null;
  validated: boolean;
  reshapesRaw: boolean;
  sample: string | null;
  sampleFormat: string | null;
}

interface MapEntry {
  packPipeline?: string;
  uuidKey?: string;
  demistoKey?: string;
  demistoPack?: string;
  /** A MODEL-only dataset, reached at T3m. See `resolveMappedModel`. */
  modelKey?: string;
  /** The boundary a human placed in an unsplit `modelKey`; both halves or neither. */
  modelVendor?: string;
  modelProduct?: string;
  aliases?: string[];
  evidence?: string;
}

interface ModelSource {
  vendor: string;
  product: string;
  dataset: string;
  contentPack: string | null;
  modelingRules: string[];
  splitEvidence: string;
}

const PACK = packIndex as unknown as {
  version: string;
  syncedAt: string;
  breakers: { rulesets: string[] } | null;
  pipelines: Record<string, PackPipelineMeta>;
};
const DOC = uuidCatalog as unknown as {
  _syncedAt: string;
  sources: Record<string, { vendor: string; product: string; uuid: string; datasetKey: string | null; criblSupported: boolean }>;
};
const DEMISTO = demistoIndex as unknown as {
  _commit: string;
  sources: Record<string, { vendor: string; product: string; dataset: string; contentPack: string; requiredInputFormat: string | null; requiredInputFormatEvidence: string | null }>;
  formatsByPack: Record<string, { contentPack: string; requiredInputFormat: string; evidence: string }>;
  modelSources: Record<string, { vendor: string; product: string; dataset: string; contentPack: string; modelingRules: string[]; splitEvidence: string }>;
  modelSourcesUnsplit: string[];
};
const MAP = (sourceMap as unknown as { sources: Record<string, MapEntry> }).sources;
/**
 * Tier T3m. Derived at sync time (`buildModelSources` in scripts/sync-xsiam-content.mjs)
 * rather than here, because the split needs the whole corpus's INGEST-vendor lexicon and
 * the 1.1 MB rule-contracts mirror it comes from has no business in this lookup.
 */
const MODEL_SOURCES = DEMISTO.modelSources || {};
/** The datasets the sync REFUSED to split — reachable only through a curated `modelKey`. */
const MODEL_UNSPLIT = new Set(DEMISTO.modelSourcesUnsplit || []);

/**
 * Defensive only. Callers pass `canonicalizeSourcetype()` output; this catches the
 * cosmetic cases (case, dashes, spaces) without pulling in the builder's alias table.
 */
export function normalizeSourcetype(sourcetype: string): string {
  return String(sourcetype || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const ALIAS_INDEX: Record<string, string> = (() => {
  const index: Record<string, string> = {};
  for (const [key, entry] of Object.entries(MAP)) {
    index[normalizeSourcetype(key)] = key;
    for (const alias of entry.aliases || []) index[normalizeSourcetype(alias)] = key;
  }
  return index;
})();

export function lookupSourceMap(sourcetype: string): { key: string; entry: MapEntry } | null {
  const key = ALIAS_INDEX[normalizeSourcetype(sourcetype)];
  return key ? { key, entry: MAP[key] } : null;
}

/** Canonical source-map keys whose authoritative XSIAM contract requires CEF. */
export function listXsiamRequiredCefSources(): string[] {
  return Object.entries(MAP)
    .filter(([, entry]) => assertedFormat(entry)?.format === 'cef')
    .map(([key]) => key)
    .sort();
}

/**
 * An asserted requirement outranks a sample's shape: a README saying `set format cef`
 * states the requirement, while a sample only exemplifies one accepted shape.
 */
export function resolveRequiredFormat(entry: MapEntry | null, pipeline: PackPipelineMeta | null): XsiamRequiredFormat | null {
  const asserted = assertedFormat(entry);
  if (asserted) return asserted;
  if (pipeline?.sampleFormat) {
    return {
      format: pipeline.sampleFormat,
      authority: 'pack-sample',
      evidence: `Palo Alto-provided sample ${pipeline.sample} classifies as ${pipeline.sampleFormat}`,
      enforcement: 'advise',
    };
  }
  return null;
}

/**
 * `modelKey` — the curated route to a MODEL-only dataset, which is what a source needs
 * when T3m could not get there by itself. Two cases, and the difference is who placed the
 * vendor/product boundary:
 *
 *   - the sync ALREADY split it (`modelSources`): the entry names the key and nothing more.
 *     `modelVendor`/`modelProduct` are REFUSED here, because an entry that restates the
 *     mirror can silently contradict it after the next sync, and the mirror is the
 *     authority for a split it derived from the corpus.
 *   - the sync REFUSED to split it (`modelSourcesUnsplit`, e.g. `check_point_url_filtering_raw`):
 *     the entry MUST place the boundary itself, and the two halves must reassemble to the
 *     dataset name EXACTLY — the same invariant `buildModelSources` holds itself to, and
 *     the reason a human-placed boundary cannot invent a dataset. Reassembly is checked
 *     here rather than trusted: `__vendor`/`__product` ARE the dataset in XSIAM, so a
 *     boundary off by one character creates a new, empty dataset in the tenant.
 *
 * Returns the error instead of throwing, so a malformed entry falls to T4 (no tags) WITH
 * the reason in its provenance rather than resolving to something plausible.
 */
export function resolveMappedModel(entry: MapEntry | null): { source: ModelSource | null; error: string | null } {
  if (!entry?.modelKey) return { source: null, error: null };
  const key = normalizeSourcetype(entry.modelKey);
  const base = key.replace(/_raw$/, '');
  const stated = entry.modelVendor || entry.modelProduct;

  const split = MODEL_SOURCES[key] || MODEL_SOURCES[base];
  if (split) {
    if (stated) {
      return { source: null, error: `modelKey "${entry.modelKey}" is already split by the mirror as ${split.vendor}/${split.product}; modelVendor/modelProduct must not restate it` };
    }
    return { source: { ...split, contentPack: split.contentPack }, error: null };
  }

  const dataset = MODEL_UNSPLIT.has(key) ? key : MODEL_UNSPLIT.has(`${base}_raw`) ? `${base}_raw` : null;
  if (!dataset) {
    return { source: null, error: `modelKey "${entry.modelKey}" names no MODEL-only dataset in the demisto mirror` };
  }
  if (!entry.modelVendor || !entry.modelProduct) {
    return { source: null, error: `modelKey "${dataset}" is one the sync refused to split, so the entry must place the boundary itself with both modelVendor and modelProduct` };
  }
  const vendor = entry.modelVendor;
  const product = entry.modelProduct;
  if (normalizeSourcetype(`${vendor}_${product}`) !== base) {
    return { source: null, error: `modelVendor "${vendor}" + modelProduct "${product}" do not reassemble to ${dataset}; those tags would create a dataset that does not exist` };
  }
  // A dataset can be unsplit because its vendor_product key is ALREADY an INGEST source
  // (`buildModelSources` leaves those behind deliberately, since T3 outranks T3m). Routing
  // it through T3m would skip that contract's asserted-format check for identical tags.
  if (DEMISTO.sources[base]) {
    return { source: null, error: `${dataset} reassembles to "${base}", which is an INGEST source: use demistoKey so the T3 contract (and its asserted format) applies` };
  }
  return {
    source: {
      vendor,
      product,
      dataset,
      contentPack: entry.demistoPack || null,
      modelingRules: [],
      splitEvidence: 'a boundary confirmed by hand in config/xsiam-source-map.json',
    },
    error: null,
  };
}

function assertedFormat(entry: MapEntry | null): XsiamRequiredFormat | null {
  if (!entry) return null;
  const fromSource = entry.demistoKey ? DEMISTO.sources[entry.demistoKey] : null;
  if (fromSource?.requiredInputFormat) {
    return {
      format: fromSource.requiredInputFormat,
      authority: 'demisto-readme',
      evidence: fromSource.requiredInputFormatEvidence || '',
      enforcement: 'fail',
    };
  }
  // A pack can assert a format while shipping no INGEST rule at all — the four best
  // T1b candidates are exactly like that, which is why formats are indexed per pack.
  const packKey = entry.demistoPack ? normalizeSourcetype(entry.demistoPack) : null;
  const fromPack = packKey ? DEMISTO.formatsByPack[packKey] : null;
  return fromPack
    ? { format: fromPack.requiredInputFormat, authority: 'demisto-readme', evidence: fromPack.evidence, enforcement: 'fail' }
    : null;
}

/**
 * CEF specifically, never merely pipe-delimited (ordering rule 3). A LEEF header is
 * also `LEEF:1.0|Vendor|Product|`, so the pack's CEF regex would extract from it
 * happily and produce plausible, wrong tags — an asserted non-CEF format is therefore
 * a veto, not just an absence of evidence.
 */
export function isCefSource(entry: MapEntry | null, sampleFormat?: string | null): boolean {
  const asserted = assertedFormat(entry);
  if (asserted) return asserted.format === 'cef';
  return normalizeSourcetype(sampleFormat || '') === 'cef';
}

function breakersFor(pipelineName: string | null): string[] {
  // The mirror carries the pack's rulesets; only the Event Hub pipeline depends on one,
  // and it says so by needing the batch split before it runs.
  if (!pipelineName || !PACK.breakers) return [];
  return pipelineName === 'XSIAM_Microsoft_Defender_via_EventHub' ? [...PACK.breakers.rulesets] : [];
}

function baseProvenance(tier: XsiamTier, source: string, evidence: string | null): XsiamProvenance {
  return {
    tier,
    source,
    packVersion: PACK.version || null,
    docSyncedAt: DOC._syncedAt || null,
    contentCommit: DEMISTO._commit || null,
    mapEvidence: evidence,
    notes: [],
  };
}

function replay(
  tier: 'T1a' | 'T1b' | 'T1c',
  sourcetype: string,
  pipelineName: string,
  pipeline: PackPipelineMeta,
  entry: MapEntry | null,
  source: string,
): XsiamResolution {
  const provenance = baseProvenance(tier, source, entry?.evidence || null);
  let sourceIdentifier = pipeline.sourceIdentifier;

  // Ordering rule 4 — the doc is king for the identifier even though the pack owns the
  // shape. AWS Route 53 is the live case: the pack still tags the doc's (old) value.
  const docEntry = entry?.uuidKey ? DOC.sources[entry.uuidKey] : null;
  if (docEntry && sourceIdentifier && docEntry.uuid !== sourceIdentifier) {
    provenance.uuidOverriddenFrom = sourceIdentifier;
    provenance.notes.push(
      `Identifier replaced with the Palo Alto doc's ${docEntry.uuid} (the mirrored pack v${PACK.version} still tags ${sourceIdentifier}).`,
    );
    sourceIdentifier = docEntry.uuid;
  }

  if (tier === 'T1c') {
    provenance.notes.push(
      'Pack pipeline is a placeholder: it carries a documented UUID, and no Palo Alto-provided sample exercises its shape. Default to passthrough with _raw intact.',
    );
  }
  if (pipeline.reshapesRaw) {
    provenance.notes.push('This pipeline rewrites _raw by design, so it is exempt from the byte-identity check.');
  }

  return {
    resolved: true,
    tier,
    sourcetype,
    packPipeline: pipelineName,
    validated: tier === 'T1a',
    sourceIdentifier,
    sourceIdField: pipeline.sourceIdField,
    vendor: pipeline.vendor,
    product: pipeline.product,
    dataset: docEntry?.datasetKey || null,
    reshapesRaw: pipeline.reshapesRaw,
    breakerRulesets: breakersFor(pipelineName),
    requiredInputFormat: resolveRequiredFormat(entry, pipeline),
    provenance,
  };
}

export function resolveXsiamDestination(sourcetypeRaw: string, options: ResolveXsiamOptions = {}): XsiamResolution {
  const sourcetype = normalizeSourcetype(sourcetypeRaw);
  const found = lookupSourceMap(sourcetype);
  const entry = found?.entry || null;

  // T1a / T1c — a pack pipeline exists. Which of the two is decided by the mirror's
  // `validated` flag, never by a hand-kept list, so it re-derives on every sync.
  if (entry?.packPipeline) {
    const pipeline = PACK.pipelines[entry.packPipeline];
    if (pipeline) {
      return pipeline.validated
        ? replay('T1a', sourcetype, entry.packPipeline, pipeline, entry, `cribl-paloalto-xsiam pack v${PACK.version}, validated by a Palo Alto-provided sample`)
        : replay('T1c', sourcetype, entry.packPipeline, pipeline, entry, `cribl-paloalto-xsiam pack v${PACK.version}, placeholder pipeline (documented UUID only)`);
    }
  }

  // T2 — a dedicated UUID with no pipeline to replay. Must beat the generic paths:
  // out-of-the-box analytics only run for sources using their dedicated collector.
  if (entry?.uuidKey && DOC.sources[entry.uuidKey]) {
    const doc = DOC.sources[entry.uuidKey];
    const provenance = baseProvenance('T2', `Cortex data-source UUID catalog (${entry.uuidKey})`, entry.evidence || null);
    if (!doc.criblSupported) {
      provenance.notes.push('The UUID doc marks this source as not currently supported by Cribl.');
    }
    return {
      resolved: true,
      tier: 'T2',
      sourcetype,
      packPipeline: null,
      validated: false,
      sourceIdentifier: doc.uuid,
      sourceIdField: '__sourceIdentifier',
      // A dedicated UUID identifies the source on its own; sending vendor/product
      // alongside it is what the doc tells you NOT to do.
      vendor: null,
      product: null,
      dataset: doc.datasetKey,
      reshapesRaw: false,
      breakerRulesets: [],
      requiredInputFormat: resolveRequiredFormat(entry, null),
      provenance,
    };
  }

  // T1b — established as CEF, so the generic CEF pipeline applies. It needs no
  // per-source knowledge: vendor and product are read from the header at runtime.
  if (isCefSource(entry, options.sampleFormat)) {
    const pipeline = PACK.pipelines[GENERIC_CEF_PIPELINE];
    const asserted = assertedFormat(entry);
    return replay(
      'T1b', sourcetype, GENERIC_CEF_PIPELINE, pipeline, entry,
      asserted
        ? `cribl-paloalto-xsiam pack v${PACK.version} generic CEF pipeline; CEF required per ${asserted.evidence}`
        : `cribl-paloalto-xsiam pack v${PACK.version} generic CEF pipeline; sample classifies as CEF`,
    );
  }

  // T3 — the content pack's INGEST contract. An exact key hit needs no map entry.
  const demistoKey = entry?.demistoKey || (DEMISTO.sources[sourcetype] ? sourcetype : null);
  if (demistoKey && DEMISTO.sources[demistoKey]) {
    const contract = DEMISTO.sources[demistoKey];
    const provenance = baseProvenance('T3', `demisto/content ${contract.contentPack} INGEST rule`, entry?.evidence || null);
    if (!entry) provenance.notes.push(`Resolved by exact demisto key match on "${sourcetype}" — no source-map entry needed.`);
    return {
      resolved: true,
      tier: 'T3',
      sourcetype,
      packPipeline: null,
      validated: false,
      sourceIdentifier: GENERIC_UUID,
      sourceIdField: '__sourceIdentifier',
      // Verbatim from the INGEST rule, case included: never normalised, and never
      // cross-checked against the pack's own casing (they legitimately differ).
      vendor: contract.vendor,
      product: contract.product,
      dataset: contract.dataset,
      reshapesRaw: false,
      breakerRulesets: [],
      requiredInputFormat: resolveRequiredFormat(entry, null),
      provenance,
    };
  }

  // T3m — a dataset that exists only in a MODELING rule. Same tagging shape and the
  // same generic UUID as T3; what differs is where vendor and product come from, so the
  // resolution says which evidence permitted the dataset name to be split. Sits below
  // T3 by construction: the sync refuses to record a key an INGEST rule already owns.
  const mappedModel = resolveMappedModel(entry);
  const modelSource: ModelSource | null = MODEL_SOURCES[sourcetype]
    ? { ...MODEL_SOURCES[sourcetype], contentPack: MODEL_SOURCES[sourcetype].contentPack }
    : mappedModel.source;
  if (modelSource) {
    const provenance = baseProvenance(
      'T3m',
      `demisto/content ${modelSource.contentPack ? `${modelSource.contentPack} ` : ''}MODELING rule (no INGEST rule; dataset name split on ${modelSource.splitEvidence})`,
      entry?.evidence || null,
    );
    provenance.notes.push(
      `__vendor/__product are the two halves of the dataset name ${modelSource.dataset}, which they reassemble exactly, so the tags cannot create a dataset that does not exist.`,
    );
    provenance.notes.push(
      `No content-pack PARSING rule covers this dataset — nothing in ${modelSource.contentPack} transforms the line before its modeling rule reads it, so the wire shape must be one XSIAM parses natively.`,
    );
    return {
      resolved: true,
      tier: 'T3m',
      sourcetype,
      packPipeline: null,
      validated: false,
      sourceIdentifier: GENERIC_UUID,
      sourceIdField: '__sourceIdentifier',
      vendor: modelSource.vendor,
      product: modelSource.product,
      dataset: modelSource.dataset,
      reshapesRaw: false,
      breakerRulesets: [],
      // A pack-level README assertion is deliberately NOT read here: it hard-fails the
      // build and blocks the destination screen, and for a source with no curated entry
      // there is no CEF fixture to satisfy it with (see getXsiamCefSample). A map entry
      // remains the way that assertion reaches a source, which is where a human has
      // confirmed it applies.
      requiredInputFormat: resolveRequiredFormat(entry, null),
      provenance,
    };
  }

  // T4 — no tier matched. Fail loudly rather than tagging a guess: a wrong
  // vendor/product silently creates a new dataset in the customer's tenant.
  const consulted = [
    `cribl-paloalto-xsiam pack v${PACK.version} (${Object.keys(PACK.pipelines).length} pipelines)`,
    `Cortex data-source UUID catalog (${Object.keys(DOC.sources).length} sources)`,
    `demisto/content index (${Object.keys(DEMISTO.sources).length} INGEST contracts, ${Object.keys(MODEL_SOURCES).length} split MODEL-only datasets, ${MODEL_UNSPLIT.size} unsplit ones reachable only by a curated modelKey)`,
    `config/xsiam-source-map.json (${Object.keys(MAP).length} mapped sourcetypes)`,
  ];
  const asserted = assertedFormat(entry);
  const provenance = baseProvenance('T4', 'none', entry?.evidence || null);
  // A modelKey that did not resolve must say why here. Falling through silently would
  // present a broken map entry as "XSIAM has nothing for this source", which is a
  // different problem with a different fix.
  if (mappedModel.error) provenance.notes.push(`Its source-map entry names a MODEL-only dataset that could not be used: ${mappedModel.error}`);
  if (asserted && asserted.format !== 'cef') {
    provenance.notes.push(
      `A required input format of ${asserted.format.toUpperCase()} is asserted, which excludes the generic CEF pipeline (ordering rule 3), and nothing else matched.`,
    );
  }
  return {
    resolved: false,
    tier: 'T4',
    sourcetype,
    packPipeline: null,
    validated: false,
    sourceIdentifier: null,
    sourceIdField: null,
    vendor: null,
    product: null,
    dataset: null,
    reshapesRaw: false,
    breakerRulesets: [],
    requiredInputFormat: asserted,
    provenance,
    failure: { reason: `No XSIAM knowledge source covers "${sourcetypeRaw}"`, consulted },
  };
}
