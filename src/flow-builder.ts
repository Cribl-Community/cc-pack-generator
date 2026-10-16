// "Build pack flow (including post-processing)" — pure logic behind the
// bottom-up flow destination screen (FlowDestination.tsx) and the build that
// follows it. No React, no network: what the canvas shows, what the summary
// says, and which post-processing packs the build creates all derive from here,
// so the UI and the builder can never disagree about the plan.
//
// Model:
//   source → main pack (one pipeline per destination format)
//          → OCSF pipeline → post-processing packs (one pack per output format)
// The main pack is built like "Create new pack". OCSF is never optimized: it
// leaves the main pack full-fidelity and is optimized only inside a
// post-processing pack, per output, when the user picks "Optimize by category".
// Other destination cards may offer Optimize (flowFormatOptimizable): CIM
// compacts to the clean model, and any mapped format can take the source's
// noise drops from the Cribl packs (source-optimization.ts).

import {
  POSTPROCESS_DEST_FORMATS, postProcessSchemaOptions, buildPostProcessFunctions, getPostProcessPair,
  isNoPairPostProcessDestination, postProcessFamilyOf,
} from './postprocess-builder';
import {
  formatSupportsSourceOptimization, sourceOptimizationRules, optimizeToggleKey, ruleToggleKey, type SourceOptRule,
} from './source-optimization';
import { canonicalizeSourcetype } from './source-recognition';
import { elasticIntegrationAdvice, type ElasticIntegrationAdvice } from './elastic-integration';
import { secopsLogTypeAdvice, type SecopsLogTypeAdvice } from './secops-log-types';

/** A destination system box on the top row. Labels only — nothing is created in Cribl. */
export interface FlowSystem { name: string; color: string; letter: string }

export const FLOW_SYSTEMS: Record<string, FlowSystem> = {
  lake: { name: 'Cribl Lake / S3 / Blob', color: '#00a3a3', letter: 'L' },
  splunk: { name: 'Splunk', color: '#65a637', letter: 'S' },
  sentinel: { name: 'Microsoft Sentinel', color: '#0078d4', letter: 'M' },
  elastic: { name: 'Elastic', color: '#f04e98', letter: 'E' },
  secops: { name: 'Google SecOps', color: '#4285f4', letter: 'G' },
  arcsight: { name: 'ArcSight / CEF SIEM', color: '#1f3a93', letter: 'A' },
  xsiam: { name: 'Cortex XSIAM', color: '#fa582d', letter: 'X' },
  crowdstrike: { name: 'CrowdStrike Falcon', color: '#e01e26', letter: 'C' },
  anyjson: { name: 'JSON destination', color: '#6b7280', letter: 'J' },
  custom: { name: 'Custom destination', color: '#8c8c8c', letter: '?' },
};

/**
 * How a main-pack destination format is presented. Whether the card offers
 * Full fidelity / Optimize is flowFormatOptimizable (it depends on the source);
 * `fixedNote` is what a card without the switch says instead.
 */
export interface FlowFormatInfo {
  label: string;
  system: keyof typeof FLOW_SYSTEMS;
  group: 'lake' | 'analytics';
  what: string;
  ocsf?: boolean;
  aiReady?: boolean;
  notAiReady?: boolean;
  /** Summary wording for a card without the Optimize switch (default "destination schema"). */
  tag?: string;
  fixedNote: string;
}

/**
 * Why route through OCSF: shown in the Step 2 box on the flow canvas and as
 * chips on the OCSF row of the destination picker.
 */
export const OCSF_VALUE = {
  title: 'Store once in OCSF, send anywhere',
  tiers: [
    { name: 'Cribl Lake', what: 'every event, full fidelity', cost: '$ low cost', hi: false },
    { name: 'Your SIEM', what: 'trimmed to what it needs', cost: '$$$ pay less', hi: true },
  ],
  benefits: [
    { key: 'tiering', label: 'Data tiering', text: 'optimize only the copy you pay most for' },
    { key: 'ai', label: 'AI-ready', text: 'the Lake copy stays one clean schema' },
    { key: 'future', label: 'Future-proof', text: 'add Splunk, Sentinel… later, same OCSF' },
  ],
  cta: 'Send the OCSF to a SIEM',
} as const;

export const FLOW_FORMATS: Record<string, FlowFormatInfo> = {
  ocsf: {
    label: 'OCSF 1.9', system: 'lake', group: 'lake', ocsf: true, aiReady: true,
    what: 'Normalized to the Open Cybersecurity Schema: one consistent shape your AI, ML and search can reason over.',
    fixedNote: 'Always sent as full-fidelity OCSF. Optimize downstream in a post-processing pack.',
  },
  passthrough: {
    label: 'Passthrough (raw copy)', system: 'lake', group: 'lake', notAiReady: true,
    what: 'No transform, every byte preserved. Raw and un-normalized.',
    fixedNote: 'Full fidelity only. A raw copy has nothing to optimize.',
  },
  raw_fields: {
    label: 'Raw + extracted fields', system: 'lake', group: 'lake', tag: 'raw + extracted fields',
    what: 'The original _raw untouched, plus every extracted field alongside it: easy to search, and fast as Parquet columns.',
    fixedNote: 'Full fidelity only: _raw is kept as received, the extracted fields are added next to it.',
  },
  cim: {
    label: 'Splunk CIM', system: 'splunk', group: 'analytics',
    what: 'Mapped to Splunk data models.',
    fixedNote: 'Sent as the CIM model.',
  },
  splunk_raw: {
    label: 'Splunk raw', system: 'splunk', group: 'analytics', notAiReady: true,
    what: 'The event exactly as received, for Splunk to parse with its own add-on.',
    fixedNote: 'Full fidelity only. A raw copy has nothing to optimize.',
  },
  splunk_json: {
    label: 'Splunk JSON', system: 'splunk', group: 'analytics', tag: 'clean JSON',
    what: 'Every extracted field as one JSON event with tidy field names.',
    fixedNote: 'Sent as clean JSON.',
  },
  sentinel: {
    label: 'Microsoft Sentinel', system: 'sentinel', group: 'analytics',
    what: 'Shaped for a native Sentinel table.',
    fixedNote: 'Sent as the table’s own columns (the DCR accepts nothing else).',
  },
  asim: {
    label: 'Microsoft Sentinel ASIM', system: 'sentinel', group: 'analytics',
    what: 'Normalized Sentinel ASIM columns.',
    fixedNote: 'Sent as the ASIM schema.',
  },
  ecs: {
    label: 'Elastic ECS', system: 'elastic', group: 'analytics',
    what: 'Elastic Common Schema, for a custom logs-* data stream (not an integration\'s).',
    fixedNote: 'Sent as the ECS schema.',
  },
  elastic_raw: {
    label: 'Elastic integration', system: 'elastic', group: 'analytics', notAiReady: true,
    what: 'The original line in message, routed by the Elastic cribl integration (_dataId) to the vendor integration that parses it.',
    fixedNote: 'Full fidelity only: the integration parses the original line, so nothing is reshaped.',
  },
  elastic_json: {
    label: 'Elastic JSON', system: 'elastic', group: 'analytics', tag: 'clean JSON',
    what: 'Every extracted field as one JSON document with tidy field names.',
    fixedNote: 'Sent as clean JSON.',
  },
  chronicle: {
    label: 'Google Chronicle UDM', system: 'secops', group: 'analytics',
    what: 'Chronicle Unified Data Model.',
    fixedNote: 'Sent as the UDM schema.',
  },
  chronicle_raw: {
    label: 'Google SecOps raw (log type)', system: 'secops', group: 'analytics', notAiReady: true,
    what: 'The original line as the log text, labelled with its Google log type so Google\'s own default parser maps it to UDM.',
    fixedNote: 'Full fidelity only: Google parses the original line, so nothing is reshaped.',
  },
  cef: {
    label: 'CEF format', system: 'arcsight', group: 'analytics',
    what: 'Common Event Format.',
    fixedNote: 'Sent as CEF.',
  },
  nextgen: {
    label: 'CrowdStrike NG SIEM (vendor parser)', system: 'crowdstrike', group: 'analytics',
    what: 'The original event, byte for byte, for the NG SIEM connector’s vendor parser (one connector per parser).',
    fixedNote: 'Sent as the original _raw.',
  },
  xsiam: {
    label: 'PaloAlto Cortex XSIAM', system: 'xsiam', group: 'analytics', notAiReady: true,
    what: 'Passthrough with vendor tagging.',
    fixedNote: 'XSIAM parses the raw vendor format: no reshaping.',
  },
  json: {
    label: 'Clean JSON', system: 'anyjson', group: 'analytics', tag: 'clean JSON',
    what: 'Structured JSON with tidy field names.',
    fixedNote: 'Sent as clean JSON.',
  },
  manual: {
    label: 'Custom format', system: 'custom', group: 'analytics',
    what: 'Your own format definition.',
    fixedNote: 'Sent as your custom format.',
  },
};

/**
 * Flow destinations that are a destination-specific name for a transform the
 * builder already has: Splunk raw / Elastic integration / SecOps raw are passthrough, Splunk/Elastic JSON
 * are Clean JSON. The card keeps its own key (its own pipeline,
 * `<source>_to_splunk_raw`, so Splunk raw and Elastic integration never collide); only
 * the transform is shared. Everything else builds as itself.
 */
const FLOW_BUILD_FORMAT: Record<string, string> = {
  splunk_raw: 'passthrough', elastic_raw: 'passthrough', chronicle_raw: 'passthrough', splunk_json: 'json', elastic_json: 'json',
};

export function flowBuildFormat(fmt: string): string {
  return FLOW_BUILD_FORMAT[fmt] ?? fmt;
}

// Lake & storage keeps its own order (OCSF, the recommended one, first); the
// analytics tools are listed alphabetically.
const FLOW_LAKE_ORDER = ['ocsf', 'passthrough', 'raw_fields'];

/** What the destination picker offers, in display order. Custom format is not offered. */
export function flowDestOptions(): { value: string; label: string }[] {
  const byLabel = (a: string, b: string) => FLOW_FORMATS[a].label.localeCompare(FLOW_FORMATS[b].label, 'en', { sensitivity: 'base' });
  const analytics = Object.keys(FLOW_FORMATS).filter(k => FLOW_FORMATS[k].group === 'analytics' && k !== 'manual').sort(byLabel);
  return [...FLOW_LAKE_ORDER, ...analytics].map(value => ({ value, label: FLOW_FORMATS[value].label }));
}

export interface FlowDestPickerOption { kind: 'option'; value: string; label: string }
export interface FlowDestPickerFamily {
  kind: 'family';
  key: string;
  label: string;
  what: string;
  system: keyof typeof FLOW_SYSTEMS;
  variants: { value: string; label: string }[];
}
export type FlowDestPickerItem = FlowDestPickerOption | FlowDestPickerFamily;
export interface FlowDestPickerGroup {
  group: 'lake' | 'analytics';
  title: string;
  items: FlowDestPickerItem[];
}

const FLOW_ANALYTICS_FAMILIES: FlowDestPickerFamily[] = [
  {
    kind: 'family', key: 'splunk', label: 'Splunk',
    what: 'Choose how Splunk should receive this source.',
    system: 'splunk',
    variants: [
      { value: 'cim', label: 'CIM' },
      { value: 'splunk_json', label: 'JSON' },
      { value: 'splunk_raw', label: 'Raw' },
    ],
  },
  {
    kind: 'family', key: 'elastic', label: 'Elastic',
    what: 'Choose how Elastic should receive this source.',
    system: 'elastic',
    variants: [
      { value: 'ecs', label: 'ECS' },
      { value: 'elastic_json', label: 'JSON' },
      { value: 'elastic_raw', label: 'Raw' },
    ],
  },
  {
    kind: 'family', key: 'sentinel', label: 'Microsoft Sentinel',
    what: 'Choose the Sentinel schema family.',
    system: 'sentinel',
    variants: [
      { value: 'sentinel', label: 'Native table' },
      { value: 'asim', label: 'ASIM' },
    ],
  },
];

/** Picker layout: Lake stays as separate rows; similar analytics destinations are grouped. */
export function flowDestPickerGroups(): FlowDestPickerGroup[] {
  const grouped = new Set(FLOW_ANALYTICS_FAMILIES.flatMap(f => f.variants.map(v => v.value)));
  const byLabel = (a: string, b: string) => FLOW_FORMATS[a].label.localeCompare(FLOW_FORMATS[b].label, 'en', { sensitivity: 'base' });
  const standalone = Object.keys(FLOW_FORMATS)
    .filter(k => FLOW_FORMATS[k].group === 'analytics' && k !== 'manual' && !grouped.has(k))
    .sort(byLabel)
    .map((value): FlowDestPickerOption => ({ kind: 'option', value, label: FLOW_FORMATS[value].label }));
  return [
    {
      group: 'lake', title: '🗄️ Cribl Lake & storage',
      items: FLOW_LAKE_ORDER.map(value => ({ kind: 'option', value, label: FLOW_FORMATS[value].label })),
    },
    { group: 'analytics', title: '📊 Analytics & SIEM tools', items: [...FLOW_ANALYTICS_FAMILIES, ...standalone] },
  ];
}

/**
 * Picker staging ("tick several, add once"): toggle a format in or out of the
 * staged list. Formats already on the canvas can't be staged again.
 */
export function flowStageToggle(staged: string[], fmt: string, onCanvas: string[]): string[] {
  if (onCanvas.includes(fmt)) return staged;
  return staged.includes(fmt) ? staged.filter(f => f !== fmt) : [...staged, fmt];
}

/**
 * Footer summary and confirm label for the staged picker selection. Defaults to
 * the destination picker; the post-processing picker passes its own labels and noun.
 */
export function flowStageSummary(
  staged: string[],
  labelOf: (v: string) => string = f => FLOW_FORMATS[f]?.label || f,
  noun = 'destination',
): { text: string; button: string } {
  if (!staged.length) return { text: `Tick every ${noun} you need.`, button: `Add ${noun}` };
  const names = staged.map(labelOf);
  const text = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return { text, button: `Add ${staged.length} ${noun}${staged.length === 1 ? '' : 's'}` };
}

/** Source noise-drop rules this card's Optimize would ship (none for OCSF/raw formats). */
export function flowSourceRules(fmt: string, sourcetype: string): SourceOptRule[] {
  return formatSupportsSourceOptimization(flowBuildFormat(fmt)) ? sourceOptimizationRules(sourcetype) : [];
}

/**
 * Does this card offer Full fidelity / Optimize? CIM always does (compaction to
 * the clean model); another format only when there is something real behind the
 * switch — noise-drop rules for this source. OCSF never does.
 */
export function flowFormatOptimizable(fmt: string, sourcetype: string): boolean {
  if (fmt === 'ocsf') return false;
  return fmt === 'cim' || flowSourceRules(fmt, sourcetype).length > 0;
}

/** The destination-side setup a card shows (Elastic integration or SecOps raw). */
export type FlowDestinationAdvice =
  | (ElasticIntegrationAdvice & { system: 'elastic' })
  | (SecopsLogTypeAdvice & { system: 'secops'; routeEntries: null });

/**
 * The destination-side setup a card needs, read from the user's own sample.
 * The Elastic integration card: the route_entries row, the Fleet assets, and
 * whether the integration can parse this source at all. The SecOps raw card:
 * the Google log type, the destination settings, and whether Google's parser
 * reads the sample's wire format.
 */
export function flowDestinationSetup(fmt: string, sourcetype: string, sampleEvents?: string): FlowDestinationAdvice | null {
  const st = canonicalizeSourcetype(sourcetype);
  if (fmt === 'elastic_raw') return { ...elasticIntegrationAdvice(st, sampleEvents), system: 'elastic' };
  if (fmt === 'chronicle_raw') return { ...secopsLogTypeAdvice(st, sampleEvents), system: 'secops', routeEntries: null };
  return null;
}

/** The heading over a card's setup block. */
export function flowDestinationSetupHeading(setup: FlowDestinationAdvice): string {
  if (setup.system === 'secops') {
    return setup.status === 'ready' ? 'Setup in Google SecOps' : setup.status === 'mismatch' ? 'Google\'s parser will not read this sample' : 'No Google log type mapped';
  }
  return setup.status === 'ready' ? 'Setup in Elastic' : setup.status === 'reshape' ? 'Will not parse as sent' : setup.status === 'agent' ? 'Use Elastic Agent for this source' : 'No integration mapped';
}

/**
 * Which card of a destination the picker recommends for this source. Elastic:
 * the integration when its pipeline parses the sample's shape, ECS (a custom
 * logs-* data stream) otherwise. SecOps: raw + log type when Google ships a
 * default parser that reads the sample's wire format, UDM otherwise. null for
 * every other option.
 */
export function flowRecommendedFor(fmt: string, sourcetype: string, sampleEvents?: string): boolean | null {
  const st = canonicalizeSourcetype(sourcetype);
  if (fmt === 'elastic_raw' || fmt === 'ecs') return elasticIntegrationAdvice(st, sampleEvents).recommended === fmt;
  if (fmt === 'chronicle_raw' || fmt === 'chronicle') return secopsLogTypeAdvice(st, sampleEvents).recommended === fmt;
  return null;
}

/** Falls back to a neutral card for a format this map doesn't know yet. */
export function flowFormatInfo(fmt: string): FlowFormatInfo {
  return FLOW_FORMATS[fmt] ?? {
    label: fmt, system: 'custom', group: 'analytics', what: '', fixedNote: 'Sent as the destination schema.',
  };
}

/** Post-processing output family → destination system box. */
const PP_SYSTEM: Record<string, keyof typeof FLOW_SYSTEMS> = {
  cef: 'arcsight', arcsight: 'arcsight', cim: 'splunk', splunk: 'splunk', ecs: 'elastic',
  elasticsearch: 'elastic', asim: 'sentinel', commonsecuritylog: 'sentinel', chronicle: 'secops',
  json: 'anyjson', xsiam: 'xsiam', crowdstrike_ngsiem: 'crowdstrike',
};

export function ppOutputSystem(fmt: string): FlowSystem {
  return FLOW_SYSTEMS[PP_SYSTEM[postProcessFamilyOf(fmt)] ?? 'custom'];
}

/** One post-processing output: a destination family, its sub-schema and the optimize switch. */
export interface FlowPpOutput { fmt: string; schema?: string; optimize: boolean }

/**
 * One entry of the post-processing picker. Most are a whole family (CIM, ASIM
 * and Chronicle then pick their model inside the card); Splunk and Elastic are
 * split into one entry per sub-mode (raw / JSON), pinned by `schema`, so the
 * card has no sub-mode picker and both can be added side by side.
 */
export interface FlowPpChoice { key: string; label: string; fmt: string; schema?: string }

// Flow names that differ from the post-processing catalog's own label.
const PP_FAMILY_LABEL: Record<string, string> = {
  cef: 'CEF format', arcsight: 'CEF format — ArcSight (categorized)',
  crowdstrike_ngsiem: 'CrowdStrike NG SIEM', xsiam: 'PaloAlto Cortex XSIAM',
};
const PP_SPLIT_LABEL: Record<string, string> = {
  'splunk#raw': 'Splunk raw', 'splunk#ocsf': 'Splunk JSON',
  elasticsearch: 'Elastic integration', 'elasticsearch#ocsf': 'Elastic JSON',
};
const PP_SPLIT_FAMILIES = new Set(['splunk', 'elasticsearch']);

/** What the post-processing picker offers (buildable only), alphabetically. */
let ppChoicesCache: FlowPpChoice[] | null = null;
export function ppChoices(): FlowPpChoice[] {
  if (ppChoicesCache) return ppChoicesCache;
  const out: FlowPpChoice[] = [];
  for (const f of ppSelectableFamilies()) {
    if (PP_SPLIT_FAMILIES.has(f.value)) {
      for (const s of ppBuildableSchemas(f.value)) {
        out.push({ key: s.key, label: PP_SPLIT_LABEL[s.key] ?? `${f.label} — ${s.label}`, fmt: f.value, schema: s.key });
      }
    } else {
      out.push({ key: f.value, label: PP_FAMILY_LABEL[f.value] ?? f.label, fmt: f.value });
    }
  }
  ppChoicesCache = out.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  return ppChoicesCache;
}

export interface FlowPpPickerOption { kind: 'option'; key: string; label: string; system: FlowSystem }
export interface FlowPpPickerFamily {
  kind: 'family'; key: string; label: string; what: string; system: FlowSystem;
  variants: { key: string; label: string }[];
}
export type FlowPpPickerItem = FlowPpPickerOption | FlowPpPickerFamily;

/** Post-processing picker families, keyed by ppChoices() keys (same grouping as the destination picker). */
const PP_PICKER_FAMILIES: { key: string; label: string; what: string; variants: [string, string][] }[] = [
  { key: 'splunk', label: 'Splunk', what: 'Choose how Splunk should receive the OCSF.', variants: [['cim', 'CIM'], ['splunk#ocsf', 'JSON'], ['splunk#raw', 'Raw']] },
  { key: 'elastic', label: 'Elastic', what: 'Choose how Elastic should receive the OCSF.', variants: [['ecs', 'ECS'], ['elasticsearch#ocsf', 'JSON'], ['elasticsearch', 'Raw']] },
  { key: 'sentinel', label: 'Microsoft Sentinel', what: 'Choose the Sentinel schema family.', variants: [['commonsecuritylog', 'CommonSecurityLog'], ['asim', 'ASIM']] },
  { key: 'cef', label: 'CEF format', what: 'Generic CEF, or categorized for ArcSight.', variants: [['cef', 'CEF'], ['arcsight', 'ArcSight']] },
];

/**
 * The post-processing picker: Splunk / Elastic / Sentinel / CEF as families with
 * a format segment, the rest as rows. Only buildable choices appear, and a family
 * left with one choice falls back to a plain row.
 */
export function ppPickerItems(): FlowPpPickerItem[] {
  const byKey = new Map(ppChoices().map(c => [c.key, c]));
  const used = new Set<string>();
  const families: FlowPpPickerItem[] = [];
  for (const f of PP_PICKER_FAMILIES) {
    const variants = f.variants.filter(([k]) => byKey.has(k)).map(([key, label]) => ({ key, label }));
    if (variants.length < 2) continue;
    variants.forEach(v => used.add(v.key));
    families.push({ kind: 'family', key: f.key, label: f.label, what: f.what, system: ppOutputSystem(byKey.get(variants[0].key)!.fmt), variants });
  }
  const rest = ppChoices().filter(c => !used.has(c.key))
    .map((c): FlowPpPickerOption => ({ kind: 'option', key: c.key, label: c.label, system: ppOutputSystem(c.fmt) }));
  return [...families, ...rest];
}

/** The picker entry an output came from (a pinned entry matches on its sub-mode). */
export function ppChoiceFor(o: FlowPpOutput): FlowPpChoice | undefined {
  const all = ppChoices().filter(c => c.fmt === o.fmt);
  return all.find(c => c.schema && c.schema === ppEffectiveFormat(o)) ?? all.find(c => !c.schema);
}

/** An output pinned to one sub-mode (Splunk raw, Elastic JSON…) shows no sub-schema picker. */
export function ppOutputPinned(o: FlowPpOutput): boolean {
  return !!ppChoiceFor(o)?.schema;
}

export function ppOutputLabel(o: FlowPpOutput): string {
  return ppChoiceFor(o)?.label ?? POSTPROCESS_DEST_FORMATS.find(f => f.value === o.fmt)?.label ?? o.fmt;
}
export interface FlowPpState { added: boolean; name: string; outputs: FlowPpOutput[] }

export const EMPTY_FLOW_PP: FlowPpState = { added: false, name: '', outputs: [] };

export function flowHasOcsf(destFormats: string[]): boolean {
  return destFormats.includes('ocsf');
}

/**
 * Can this concrete post-processing format actually be built from OCSF? What the
 * screen offers must be buildable: anything that isn't is never shown, rather
 * than being selectable and then failing (or silently skipping) at build time.
 */
const buildableCache = new Map<string, boolean>();
export function ppFormatBuildable(eff: string): boolean {
  let ok = buildableCache.get(eff);
  if (ok === undefined) {
    const hasTransform = !!getPostProcessPair('ocsf', postProcessFamilyOf(eff)) || isNoPairPostProcessDestination(eff);
    ok = hasTransform && buildPostProcessFunctions('ocsf', eff, { optimize: false }).length > 0;
    buildableCache.set(eff, ok);
  }
  return ok;
}

/** The sub-schemas of a family that can be built (all of them, for a family with none). */
export function ppBuildableSchemas(fmt: string): { key: string; label: string }[] {
  return postProcessSchemaOptions(fmt).filter(o => ppFormatBuildable(o.key));
}

/** Families the output picker may offer: a family is selectable only if it can be built. */
export function ppSelectableFamilies(): typeof POSTPROCESS_DEST_FORMATS {
  return POSTPROCESS_DEST_FORMATS.filter(f =>
    postProcessSchemaOptions(f.value).length ? ppBuildableSchemas(f.value).length > 0 : ppFormatBuildable(f.value));
}

/** New output: the pinned sub-schema if given, else the family's first buildable one; "Optimize by category". */
export function newPpOutput(fmt: string, schema?: string): FlowPpOutput {
  return { fmt, schema: schema ?? ppBuildableSchemas(fmt)[0]?.key, optimize: true };
}

/** The concrete golden format a post-processing output builds (sub-schema else family). */
export function ppEffectiveFormat(o: FlowPpOutput): string {
  const opts = postProcessSchemaOptions(o.fmt);
  return o.schema && opts.some(s => s.key === o.schema) ? o.schema : o.fmt;
}

/**
 * The post-processing outputs the build will actually create. Empty unless OCSF
 * is a destination and post-processing was added — post-processing only ever
 * reads OCSF, so without it there is nothing to build on.
 */
export function ppOutputsToBuild(destFormats: string[], pp: FlowPpState): FlowPpOutput[] {
  return flowHasOcsf(destFormats) && pp.added ? pp.outputs : [];
}

/**
 * Build pack flow names read "<source> to <destination>": the pack name is
 * "cisco asa to ocsf + cim" and its ID is `cisco_asa_to_ocsf_cim` (snake case —
 * Cribl pack IDs allow underscores). Lowercased, since Cribl lowercases IDs.
 */
export function flowPackId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** "cisco:asa" → "cisco asa": the source half of every flow pack name. */
export function flowSourceLabel(sourcetype: string): string {
  return sourcetype.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'source';
}

const FLOW_DEST_WORD: Record<string, string> = { manual: 'custom', passthrough: 'raw' };

/** Default main pack name: "<source> to <dest> + <dest>" in the order the destinations were added. */
export function flowDefaultPackName(sourcetype: string, destFormats: string[]): string {
  const dests = destFormats.map(f => FLOW_DEST_WORD[f] ?? f.replace(/[#_]+/g, ' '));
  return dests.length ? `${flowSourceLabel(sourcetype)} to ${dests.join(' + ')}` : flowSourceLabel(sourcetype);
}

/**
 * Post-processing pack for one output: "<name> to <format> post", ID
 * `<name>_to_<format>_post`, where <name> is the post-processing name (defaults
 * to the source). One pack per output because a pack is attached per
 * destination — N pipelines in one pack would run every one of them on each
 * destination it's attached to. Sub-schemas are part of the name
 * (cim#authentication → cim authentication) so two CIM models never collide.
 */
export function ppPackNameFor(ppName: string, sourcetype: string, o: FlowPpOutput): string {
  const base = ppName.trim() || flowSourceLabel(sourcetype);
  return `${base} to ${ppEffectiveFormat(o).replace(/[#_]+/g, ' ')} post`;
}

export function ppPackIdFor(ppName: string, sourcetype: string, o: FlowPpOutput): string {
  return flowPackId(ppPackNameFor(ppName, sourcetype, o));
}

/**
 * Why the flow screen can't continue, or null. Everything the screen shows must
 * be built, so a post-processing band with no outputs (it would build nothing)
 * blocks until an output is added or post-processing is removed.
 */
export function flowBlockedReason(destFormats: string[], pp: FlowPpState): string | null {
  if (!destFormats.length) return 'Add at least one destination.';
  if (flowHasOcsf(destFormats) && pp.added && !pp.outputs.length) {
    return 'Post-processing has no outputs. Add an output format, or remove post-processing.';
  }
  return null;
}

/** A pack already on the worker group, as the Flow screen's name band sees it. */
export interface FlowExistingPack { id: string; version?: string }

/**
 * The main pack's name, typed on the Flow screen (there is no Name step in this
 * mode). The ID is flowPackId(name) (snake case, lowercased); the description
 * and display name are the name itself, and the route filter is always `true`.
 * An ID that already exists on the group blocks until the user renames or
 * explicitly chooses to overwrite.
 */
export function flowPackCheck(name: string, existing: FlowExistingPack[], overwrite: boolean): {
  id: string; existing: FlowExistingPack | null; blocked: string | null;
} {
  const id = flowPackId(name.trim());
  const hit = id ? existing.find(p => p.id.toLowerCase() === id) ?? null : null;
  const blocked = !id ? 'Enter a pack name.'
    : hit && !overwrite ? `Pack ${id} already exists: rename or overwrite.`
    : null;
  return { id, existing: hit, blocked };
}

/** Rename suggestion: "cisco asa to ocsf" → "cisco asa to ocsf 2" (3, 4 … while that ID is taken too). */
export function nextFreePackName(name: string, existing: FlowExistingPack[]): string {
  const ids = new Set(existing.map(p => p.id.toLowerCase()));
  const base = name.trim().replace(/\s+\d+$/, '') || 'pack';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!ids.has(flowPackId(candidate))) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * The post-processing packs' counterpart of flowPackCheck: every output's pack
 * ID, the ones already on the group, and a blocker while any of them exists
 * and the user hasn't chosen to overwrite. One name drives every output ID, so
 * one rename / overwrite choice covers them all.
 */
export function ppPackCheck(ppName: string, sourcetype: string, destFormats: string[], pp: FlowPpState, existing: FlowExistingPack[], overwrite: boolean): {
  ids: string[]; existing: FlowExistingPack[]; blocked: string | null;
} {
  const ids = ppOutputsToBuild(destFormats, pp).map(o => ppPackIdFor(ppName, sourcetype, o));
  const hits = ids.flatMap(id => existing.filter(p => p.id.toLowerCase() === id).slice(0, 1));
  const blocked = hits.length && !overwrite
    ? `Post-processing pack${hits.length > 1 ? 's' : ''} ${hits.map(h => h.id).join(', ')} already exist${hits.length > 1 ? '' : 's'}: rename or overwrite.`
    : null;
  return { ids, existing: hits, blocked };
}

/** Rename suggestion for the post-processing name: the first "<name> N" where no output's pack ID is taken. */
export function nextFreePpName(ppName: string, sourcetype: string, destFormats: string[], pp: FlowPpState, existing: FlowExistingPack[]): string {
  const ids = new Set(existing.map(p => p.id.toLowerCase()));
  const outs = ppOutputsToBuild(destFormats, pp);
  const base = (ppName.trim() || flowSourceLabel(sourcetype)).replace(/\s+\d+$/, '');
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!outs.some(o => ids.has(ppPackIdFor(candidate, sourcetype, o)))) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Route filter of the main pack in Build pack flow: every event the route sends in. */
export const FLOW_ROUTE_FILTER = 'true';

/** Pack/pipeline counts for the footer and summary. */
export function flowCounts(destFormats: string[], pp: FlowPpState): { pipelines: number; packs: number; ppPacks: number } {
  const outs = ppOutputsToBuild(destFormats, pp).length;
  return { pipelines: destFormats.length + outs, packs: (destFormats.length ? 1 : 0) + outs, ppPacks: outs };
}

function humanList(a: string[]): string {
  if (a.length <= 1) return a[0] || '';
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
}

/** Plain-text summary sentence(s) of the whole plan. */
export function flowSummary(args: {
  sourcetype: string;
  destFormats: string[];
  optimize: Record<string, boolean>;
  ocsfKeepRaw: boolean;
  pp: FlowPpState;
}): string[] {
  const { sourcetype, destFormats, optimize, ocsfKeepRaw, pp } = args;
  if (!destFormats.length) return [];
  const parts = destFormats.map(f => {
    const info = flowFormatInfo(f);
    let tag = flowFormatOptimizable(f, sourcetype) ? (optimize[f] ? 'optimized' : 'full fidelity')
      : info.ocsf ? 'full-fidelity OCSF'
      : info.notAiReady ? 'raw copy' : info.tag ?? 'destination schema';
    if (info.ocsf && ocsfKeepRaw) tag += ', + original _raw';
    return `${info.label} (${tag}) → ${FLOW_SYSTEMS[info.system].name}`;
  });
  const outs = ppOutputsToBuild(destFormats, pp);
  const lines = [`Build the main pack, which sends ${sourcetype || 'the source'} as ${humanList(parts)}.`];
  if (outs.length) {
    const po = outs.map(o => `${ppOutputLabel(o)} (${o.optimize ? 'optimized by category' : 'full copy'}) → ${ppOutputSystem(o.fmt).name}`);
    lines.push(`Then, on top of OCSF, ${outs.length === 1 ? 'a post-processing pack reshapes' : `${outs.length} post-processing packs reshape`} it as ${humanList(po)}.`);
  }
  const c = flowCounts(destFormats, pp);
  lines.push(`= ${c.pipelines} pipeline${c.pipelines === 1 ? '' : 's'} across ${c.packs} pack${c.packs === 1 ? '' : 's'}.`);
  return lines;
}

/**
 * Reduction toggles for the main build. `cim_keep_unmapped` is the CIM
 * Full fidelity (true) / Optimize (false) switch; `ocsf_keep_raw` carries the
 * original event into the OCSF `raw_data` attribute (staged-build finishBuild).
 * `srcopt_on:<fmt>` turns a card's source noise drops on; `srcopt_rule:<id>` is
 * each rule's checkbox (shared by every optimized card: the rules are the
 * source's, not the destination's). OCSF never gets `srcopt_on`.
 */
export function flowReductionToggles(
  base: Record<string, boolean>,
  optimize: Record<string, boolean>,
  ocsfKeepRaw: boolean,
  rules: Record<string, boolean> = {},
  destFormats: string[] = Object.keys(optimize),
): Record<string, boolean> {
  const t: Record<string, boolean> = { ...base, cim_keep_unmapped: !optimize.cim, ocsf_keep_raw: ocsfKeepRaw };
  for (const f of destFormats) if (formatSupportsSourceOptimization(flowBuildFormat(f))) t[optimizeToggleKey(f)] = optimize[f] === true;
  for (const [id, on] of Object.entries(rules)) t[ruleToggleKey(id)] = on;
  return t;
}

/**
 * The post-processing pack's sample = the upstream OCSF pipeline's preview
 * output, event for event, exactly as that pipeline emits it (the two packs are
 * chained). Every plain-object event is kept — never gate on `_raw`: a parser
 * that consumes `_raw` (Windows XML: parseWinEvent + flatten) leaves none, and
 * the kept original lives in `raw_data`, so a `_raw` gate would drop every event
 * and silently fall back to the curated OCSF sample.
 */
export function upstreamSampleEvents(out: unknown): Record<string, unknown>[] {
  if (!Array.isArray(out)) return [];
  return out.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e));
}

/** Live Build-screen model: one row per main-pack format, one per post-processing pack. */
export type FlowLiveState = 'queued' | 'running' | 'done' | 'skipped' | 'error';
export type FlowLiveStageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export interface FlowLiveFormat<S extends { status: FlowLiveStageStatus } = { status: FlowLiveStageStatus }> {
  fmt: string; label: string; pipelineId: string; state: FlowLiveState; stages: S[];
}
export interface FlowLivePp { packId: string; label: string; optimize: boolean; state: FlowLiveState; error?: string }
/** 'prep' = resolving the parse before the first format; 'done' = deployed. */
export type FlowBuildPhase = 'prep' | 'build' | 'post' | 'deploy' | 'done';

const settled = (s: string) => s === 'done' || s === 'skipped' || s === 'error';

/**
 * Overall Build-screen percent, in units: preparing (the one-off parse) 1; each
 * format 4 (its three stages, then saving the pipeline to Cribl; a skipped or
 * failed format counts all 4); each post-processing pack 1; the final
 * commit+deploy 1. Whatever is running counts `runningFrac` of its unit (the
 * screen creeps it with flowCreep so a long step still moves). Never 100 until deployed.
 */
export function flowBuildPercent(formats: FlowLiveFormat[], pps: FlowLivePp[], phase: FlowBuildPhase, runningFrac = 0.5): number {
  if (phase === 'done') return 100;
  const unit = (s: string) => (settled(s) ? 1 : s === 'running' ? runningFrac : 0);
  let got = phase === 'prep' ? runningFrac : 1;
  for (const f of formats) {
    if (f.state !== 'queued' && f.state !== 'running') { got += 4; continue; }
    const st = f.stages.slice(0, 3);
    got += st.reduce((a, s) => a + unit(s.status), 0);
    // all stages scored, format not done yet → the pipeline is being saved
    if (f.state === 'running' && st.length && st.every(s => settled(s.status))) got += runningFrac;
  }
  for (const p of pps) got += unit(p.state);
  if (phase === 'deploy') got += runningFrac;
  const total = 1 + formats.length * 4 + pps.length + 1;
  return Math.min(99, Math.round((got / total) * 100));
}

/** "x of N" counters for the Build-screen header. */
export function flowBuildCounts(formats: FlowLiveFormat[], pps: FlowLivePp[]): {
  pipelinesDone: number; pipelines: number; ppDone: number; pps: number; failed: number;
} {
  return {
    pipelinesDone: formats.filter(f => settled(f.state)).length,
    pipelines: formats.length,
    ppDone: pps.filter(p => settled(p.state)).length,
    pps: pps.length,
    failed: formats.filter(f => f.state === 'error' || f.state === 'skipped').length + pps.filter(p => p.state === 'error' || p.state === 'skipped').length,
  };
}

/**
 * The model / table / class a main-pack card picks, shown in the card itself
 * (like a post-processing output's schema). `field` is the WizardState key the
 * choice lives in; OCSF uses `ocsfSchema` (NG SIEM has no class). null = no picker.
 */
export interface FlowModelPick {
  field: 'sentinelTable' | 'cimModel' | 'asimSchema' | 'ocsfSchema';
  label: string;
  options: { key: string; label: string }[];
}

export function flowModelPick(fmt: string, src: {
  sentinelTables: string[];
  cimModels: string[];
  cimSuggested?: Set<string>;
  asim: { key: string; label: string }[];
  asimRecommended?: string;
  ocsf: { key: string; label: string; classUid?: number | string }[];
  ocsfRecommended?: string;
}): FlowModelPick | null {
  const star = (on: boolean) => (on ? ' ★' : '');
  const auto = (opts: { key: string; label: string }[], rec?: string) => {
    const hit = opts.find(o => o.key === rec);
    return { key: 'auto', label: `Auto${hit ? ` (${hit.label})` : ''}` };
  };
  switch (fmt) {
    case 'sentinel':
      return src.sentinelTables.length
        ? { field: 'sentinelTable', label: 'Table', options: src.sentinelTables.map(t => ({ key: t, label: t })) } : null;
    case 'cim':
      return src.cimModels.length
        ? { field: 'cimModel', label: 'Data model', options: src.cimModels.map(m => ({ key: m, label: m.replace(/_/g, ' ') + star(!!src.cimSuggested?.has(m)) })) } : null;
    case 'asim':
      return { field: 'asimSchema', label: 'Schema', options: [auto(src.asim, src.asimRecommended), ...src.asim.map(o => ({ key: o.key, label: o.label + star(o.key === src.asimRecommended) }))] };
    // NG SIEM ships the original line, so there is no OCSF class to pick.
    case 'ocsf': {
      const rec = src.ocsfRecommended?.startsWith('nextgen#') ? `ocsf#${src.ocsfRecommended.slice('nextgen#'.length)}` : src.ocsfRecommended;
      return {
        field: 'ocsfSchema', label: 'Class',
        options: [auto(src.ocsf, rec), ...src.ocsf.map(o => ({ key: o.key, label: `${o.label}${o.classUid != null ? ` (${o.classUid})` : ''}${star(o.key === rec)}` }))],
      };
    }
    default:
      return null;
  }
}

/**
 * How far into a running step the bar sits after `sec` seconds: starts at 0.1
 * and eases toward 0.9, never reaching the next unit (that is the step finishing).
 */
export function flowCreep(sec: number, tau = 30): number {
  return 0.1 + 0.8 * (1 - Math.exp(-Math.max(0, sec) / tau));
}

const STAGE_ACTIVITY: Record<string, [string, string]> = {
  extraction: ['Extract', 'trying the parsers and the AI extraction on the sample'],
  mapping: ['Map', 'mapping the fields and scoring each candidate'],
  optimization: ['Shape', 'shaping and scoring the output'],
};

/** What the Build screen is waiting on right now: a title and a plain-language "what". */
export function flowRunningActivity(formats: FlowLiveFormat<{ status: FlowLiveStageStatus; stage?: string }>[], pps: FlowLivePp[], phase: FlowBuildPhase): {
  key: string; title: string; what: string;
} {
  if (phase === 'done') return { key: 'done', title: 'Done', what: 'everything is built and deployed' };
  if (phase === 'deploy') return { key: 'deploy', title: 'Commit & deploy', what: 'Cribl is committing and deploying the worker group' };
  const pi = pps.findIndex(p => p.state === 'running');
  if (phase === 'post' || pi >= 0) {
    const p = pps[pi];
    return p ? { key: `pp:${p.packId}`, title: `Post-processing · ${p.label}`, what: 'building the post-processing pack' }
      : { key: 'post', title: 'Post-processing', what: 'building the post-processing packs' };
  }
  const fi = formats.findIndex(f => f.state === 'running');
  const f = formats[fi];
  if (f) {
    const si = f.stages.findIndex(st => st.status === 'running');
    if (si < 0 && f.stages.length && f.stages.every(st => settled(st.status))) {
      return { key: `f${fi}:save`, title: `Save · ${f.label}`, what: 'uploading the pipeline and its sample to Cribl' };
    }
    const st = f.stages[si];
    const [word, what] = STAGE_ACTIVITY[st?.stage ?? ''] ?? ['Build', 'building the pipeline'];
    return { key: `f${fi}:${si}`, title: `${word} · ${f.label}`, what };
  }
  return { key: 'prep', title: 'Preparing', what: 'reading the sample and resolving the parser' };
}
