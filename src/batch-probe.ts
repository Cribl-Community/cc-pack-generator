/**
 * What will this batch row get? An offline answer, before anything is built.
 *
 * For one CSV row plus the sample it will build from, this runs the app's own
 * decision functions and reports what they decide:
 *  - the sourcetype the row resolves to (the pre-flight recognizer);
 *  - the sample's wire format, and the source its content names (CEF header,
 *    Search datatype, JSON signature), all offline;
 *  - the source-expectation guard: `mismatch` means the static parser and the
 *    golden path are refused, so the row goes to AI;
 *  - the extraction and mapping candidates, in the order the staged builder
 *    tries them, with any stored golden part it can actually reach;
 *  - the destination the build concretizes to (the OCSF class, the CIM model);
 *  - the composition of the static parser (duplicate Parser/regex work).
 *
 * No AI, no Cribl. The caller injects the golden lookup so `npm run batch:probe`
 * can read the local store the standalone backend reads. It is a prediction:
 * candidates are SCORED at build time, and a golden or static parser that
 * scores badly loses to the next one.
 */
import { formatFunctionTypes, functionComposition } from './function-composition';
import { goldenWireFormatForSample } from './golden-variant';
import {
  concretizeAsimFormat, concretizeCimFormat, concretizeOcsfFormat, fingerprintsMatch,
  getFamilyTokenVariants, getMappingFunctions, hasGoldenFormatPath,
} from './pack-builder';
import { describeSampleFormat, SAMPLE_EXTEND_FLOOR } from './sample-library';
import {
  getDatatypeParserFunctions, getParserForSourcetype, isWindowsCodeFamily, matchDatatypeParserBySample,
  matchJsonSignature, recognizeCefSource, recognizeSourcetype, sampleFingerprint, sampleMatchesSourceExpectation,
} from './source-recognition';

/** A stored golden part as the lookup returns it (the `GoldenPipeline` subset read here). */
export interface ProbeGoldenPart {
  functions?: unknown[];
  score?: number;
  recipe?: { fingerprint?: unknown } | null;
}

export type ProbeGoldenLookup = (
  stage: 'extraction' | 'mapping', sourcetype: string, destFormat: string, wire: ReturnType<typeof goldenWireFormatForSample>,
) => ProbeGoldenPart | null | Promise<ProbeGoldenPart | null>;

/**
 * The sourcetype a batch row resolves to, as the pre-flight recognizer decides
 * it (`recognizePreflightRow` in App.tsx): the canonical name, or the fuzzy
 * match it adopts. `blocked` rows stop at pre-flight until the user picks.
 */
export function resolveBatchSourcetype(raw: string, evidence: { destFormat?: string; packName?: string; pipelineName?: string } = {}): {
  canonical: string; recognition: string; blocked: boolean; note: string;
} {
  const rec = recognizeSourcetype(raw, evidence);
  const variants = rec.status === 'alias' ? [] : getFamilyTokenVariants(raw);
  if (variants.length) {
    return { canonical: rec.canonical, recognition: 'ambiguous', blocked: true, note: `pick a variant: ${variants.slice(0, 4).join(', ')}` };
  }
  if (rec.status === 'exact' || rec.status === 'alias') return { canonical: rec.canonical, recognition: rec.status, blocked: false, note: '' };
  if (rec.status === 'catalogue_gap') return { canonical: rec.canonical, recognition: 'catalogue_gap', blocked: false, note: 'known vendor, no golden' };
  if (rec.tier === 'fuzzy') {
    const adopted = rec.suggestion || rec.canonical;
    return { canonical: adopted, recognition: `fuzzy:${rec.confidence}`, blocked: false, note: `read as ${adopted}` };
  }
  return { canonical: rec.canonical, recognition: 'unresolved', blocked: true, note: 'AI content check at pre-flight' };
}

// Lives with the other row-sample keys; re-exported for the probe script.
export { batchSampleSourcetype } from './batch-row-sample';

/** The destination the staged builder concretizes a bare schema family to. */
export function concretizeBatchDestination(destFormat: string, sourcetype: string, sampleText: string, cimModel?: string): string {
  if (destFormat === 'cim') return concretizeCimFormat('cim', sourcetype, sampleText, cimModel);
  if (destFormat === 'asim') return concretizeAsimFormat('asim', sourcetype, sampleText);
  if (destFormat === 'ocsf' || destFormat === 'nextgen') return concretizeOcsfFormat(destFormat, sourcetype, sampleText);
  return destFormat;
}

const RAW_DESTINATIONS = ['json', 'manual', 'raw', 'raw_fields', 'passthrough', ''];
/** Destinations the staged builder first delegates to Cribl Copilot's schematizer. */
const SCHEMATIZER_FAMILIES = ['ocsf', 'ecs', 'chronicle'];

export interface BatchProbeInput {
  sourcetype: string;
  destFormat: string;
  cimModel?: string;
  /** The sample the row builds from, one event per line. Empty = none. */
  sampleText: string;
}

export interface BatchProbeResult {
  sourcetype: string;
  destFormat: string;
  destResolved: string;
  sampleEvents: number;
  sampleThin: boolean;
  wire: string | null;
  wireLabel: string | null;
  wireAgreement: number | null;
  wireMixed: boolean | null;
  goldenWire: string | null;
  /** The source the sample's CONTENT names, offline, with how it was found. */
  detected: string | null;
  detectedBy: 'cef-header' | 'datatype' | 'json-signature' | null;
  detectedDiffers: boolean;
  guard: 'match' | 'mismatch' | 'unknown' | null;
  staticParser: string | null;
  /** curated = a real per-source parser; the other two are the fallbacks. */
  staticKind: 'curated' | 'search-datatype' | 'generic-json' | null;
  staticMultiParser: boolean | null;
  staticMultiRegex: boolean | null;
  searchDatatype: string | null;
  goldenExtraction: string | null;
  goldenMapping: string | null;
  specMapping: boolean;
  schematizer: 'replay goldens' | 'tried first' | null;
  extractionCandidates: string;
  mappingCandidates: string;
  predictedExtraction: string;
  predictedMapping: string;
}

type Fingerprint = ReturnType<typeof sampleFingerprint>;

/**
 * Why a stored golden part is not replayed onto this sample, in the terms of
 * `fingerprintsMatch`. An unstructured sample (syslog text, CSV columns) has no
 * key signature, so it NEVER replays a golden, whatever is stored.
 */
function goldenSkipReason(stored: unknown, current: Fingerprint): string {
  const v = stored as Fingerprint | null | undefined;
  if (!v?.format) return 'no stored fingerprint';
  if (current.format === 'unstructured') return 'unstructured sample never replays';
  if (v.format !== current.format) return `stored for ${v.format}, sample is ${current.format}`;
  if (!current.keys.length) return 'sample has no keys';
  return 'sample keys differ';
}

function goldenLabel(part: ProbeGoldenPart | null, fpOk: boolean, fp: Fingerprint): string | null {
  if (!part?.functions?.length) return null;
  return `${part.score ?? '?'}${fpOk ? '' : ` (skipped: ${goldenSkipReason(part.recipe?.fingerprint, fp)})`}`;
}

/** What a row's own sample says, offline: the part of the probe the pre-flight shows beside it. */
export interface RowSampleReading {
  /** `describeSampleFormat` label (e.g. "CEF", "key=value"), null for no sample. */
  wireLabel: string | null;
  /** The source the sample's CONTENT names, with how it was found. */
  detected: string | null;
  detectedBy: 'cef-header' | 'datatype' | 'json-signature' | null;
  /** The content names a different source than the row's (generic `cef` and the row's own Search datatype do not count). */
  detectedDiffers: boolean;
  guard: 'match' | 'mismatch' | 'unknown' | null;
}

/**
 * Read a sample the way the wizard's detection does — format first, then the
 * source it names: the CEF header outranks the vendor datatype matcher, which
 * reads framed Infoblox CEF as VMware NSX.
 */
export function readRowSample(sourcetype: string, sampleText: string): RowSampleReading {
  const lines = sampleText.split('\n').filter(l => l.trim());
  if (!lines.length) return { wireLabel: null, detected: null, detectedBy: null, detectedDiffers: false, guard: null };
  const text = lines.join('\n');
  let detected: string | null = null;
  let detectedBy: RowSampleReading['detectedBy'] = null;
  const cef = recognizeCefSource(text);
  if (cef) { detected = cef.sourcetype; detectedBy = 'cef-header'; }
  // Named as the wizard's Tier 1/1b adopt them: the canonical of the match.
  if (!detected) {
    try {
      const dt = matchDatatypeParserBySample(text);
      if (dt) { detected = recognizeSourcetype(dt.parserKey).canonical || dt.parserKey; detectedBy = 'datatype'; }
    } catch { /* no match */ }
  }
  if (!detected) {
    try {
      const js = matchJsonSignature(text);
      if (js) { detected = recognizeSourcetype(js.sourcetype).canonical || js.sourcetype; detectedBy = 'json-signature'; }
    } catch { /* no match */ }
  }
  const dtp = getDatatypeParserFunctions(sourcetype);
  return {
    wireLabel: describeSampleFormat(lines).label,
    detected,
    detectedBy,
    // A generic `cef` answer or the source's own Search datatype is not a
    // disagreement.
    detectedDiffers: !!detected && detected !== sourcetype && detected !== 'cef' && detected !== dtp?.searchDatatypeId,
    guard: sampleMatchesSourceExpectation(sourcetype, text),
  };
}

export async function probeBatchRow(input: BatchProbeInput, goldenLookup: ProbeGoldenLookup): Promise<BatchProbeResult> {
  const { sourcetype, destFormat } = input;
  const lines = input.sampleText.split('\n').filter(l => l.trim());
  const sampleText = lines.join('\n');
  const hasSample = lines.length > 0;
  const destResolved = concretizeBatchDestination(destFormat, sourcetype, sampleText, input.cimModel);
  const family = destResolved.split('#')[0];
  const isMappedSchema = !RAW_DESTINATIONS.includes(destResolved);
  const isNativePass = destResolved === 'xsiam' || destResolved === 'passthrough';

  const fmt = hasSample ? describeSampleFormat(lines) : null;
  const wire = hasSample ? goldenWireFormatForSample(sampleText) : null;
  const fp = sampleFingerprint(sampleText);

  const { detected, detectedBy, detectedDiffers, guard } = readRowSample(sourcetype, sampleText);
  let staticFns: unknown[] = [];
  try { staticFns = getParserForSourcetype(sourcetype, isWindowsCodeFamily(sourcetype)) || []; } catch { /* none */ }
  const staticComp = staticFns.length ? functionComposition(staticFns as never) : null;
  const dtp = getDatatypeParserFunctions(sourcetype);

  const gExt = isNativePass ? null : await goldenLookup('extraction', sourcetype, destResolved, wire);
  const gMap = isNativePass || !isMappedSchema ? null : await goldenLookup('mapping', sourcetype, destResolved, wire);
  const gExtOk = !!gExt?.functions?.length && fingerprintsMatch(gExt.recipe?.fingerprint as never, fp);
  const gMapOk = !!gMap?.functions?.length && fingerprintsMatch(gMap.recipe?.fingerprint as never, fp);
  const specMapping = isMappedSchema && hasSample && hasGoldenFormatPath(sourcetype, destResolved, lines.slice(0, 8).join('\n'));

  // The staged builder's order (staged-build.ts, STAGE 1): a mapped schema tries
  // curated first (golden, static), then the Search datatype, then AI; raw/JSON
  // puts the Search datatype first. The static parser is skipped on `mismatch`.
  const staticOk = staticFns.length > 0 && guard !== 'mismatch';
  // `getParserForSourcetype` falls back to the Search datatype parser, and then
  // to a lone "Try JSON parse" serde for a name it does not know, so "static"
  // alone would claim a curated parser that does not exist.
  const staticKind: BatchProbeResult['staticKind'] = !staticFns.length ? null
    : dtp?.functions?.length && JSON.stringify(staticFns) === JSON.stringify(dtp.functions) ? 'search-datatype'
    : staticFns.length === 1 && (staticFns[0] as { description?: string }).description === 'Try JSON parse' ? 'generic-json'
    : 'curated';
  const ext: string[] = [];
  if (isNativePass) ext.push('none (native passthrough)');
  else {
    const golden = gExtOk ? `golden:${gExt!.score}` : null;
    const stat = staticOk ? (staticKind === 'curated' ? 'static' : `static(${staticKind})`) : null;
    const search = dtp?.functions?.length ? `search:${dtp.searchDatatypeId}` : null;
    const ordered = isMappedSchema ? [golden, stat, search] : [search, golden, stat];
    for (const c of ordered) if (c) ext.push(c);
    ext.push('AI');
  }
  // STAGE 2: golden part → spec mapping ('copilot') → AI, then the static
  // mapping as a floor when nothing reached SATISFIED.
  const map: string[] = [];
  if (destResolved === 'xsiam') map.push('XSIAM routing');
  else if (isMappedSchema && !isNativePass) {
    if (gMapOk) map.push(`golden:${gMap!.score}`);
    if (specMapping) map.push('spec');
    map.push('AI');
    let staticMap: unknown[] = [];
    try { staticMap = getMappingFunctions(sourcetype, destResolved) || []; } catch { /* none */ }
    if (staticMap.length) map.push('static');
  }
  // The schematizer is skipped only when BOTH golden parts exist and the
  // extraction part's fingerprint matches (trySchematizerCombined).
  const schematizer = !isNativePass && SCHEMATIZER_FAMILIES.includes(family)
    ? (gExtOk && !!gMap?.functions?.length ? 'replay goldens' : 'tried first')
    : null;

  return {
    sourcetype,
    destFormat,
    destResolved,
    sampleEvents: lines.length,
    sampleThin: hasSample && lines.length < SAMPLE_EXTEND_FLOOR,
    wire: fmt ? fmt.id : null,
    wireLabel: fmt ? fmt.label : null,
    wireAgreement: fmt ? Math.round(fmt.agreement * 100) : null,
    wireMixed: fmt ? fmt.mixed : null,
    goldenWire: wire,
    detected,
    detectedBy,
    detectedDiffers,
    guard,
    staticParser: staticComp ? formatFunctionTypes(staticComp.byType) : null,
    staticKind,
    staticMultiParser: staticComp ? staticComp.multiParser : null,
    staticMultiRegex: staticComp ? staticComp.multiRegex : null,
    searchDatatype: dtp?.searchDatatypeId ?? null,
    goldenExtraction: goldenLabel(gExt, gExtOk, fp),
    goldenMapping: goldenLabel(gMap, gMapOk, fp),
    specMapping,
    schematizer,
    extractionCandidates: ext.join(' → '),
    mappingCandidates: map.length ? map.join(' → ') : 'none',
    predictedExtraction: hasSample ? ext[0] : 'no sample (AI generates one at pre-flight)',
    predictedMapping: map[0] ?? 'none',
  };
}
