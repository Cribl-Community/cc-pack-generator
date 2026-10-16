import type { AiMappingResult, QualitySettings } from './ai-client';
import { loadQualitySettings } from './ai-client';
import { aiMapping, getGoldenPipeline, type AiParseFunctions, type PreDeployResult, type ValidationReport } from './api';
import { goldenWireFormatForSample } from './golden-variant';
import {
  buildPack,
  cimFormatKeyForModel,
  concretizeOcsfFormat,
  fingerprintsMatch,
  goldenPathMatchesSample,
  hasGoldenFormatPath,
  rawFidelityIssues,
  sampleFingerprint,
  scoreAuthoritative,
} from './pack-builder';
import { aiSampleSnippet } from './sample-sanitise';
import { resolveSentinelTable } from './sentinel-knowledge';
import type { DestFormat, WizardState } from './types';

export const KNOWN_PARSER_SOURCETYPES = ['cisco_asa', 'cisco_ftd', 'cisco_firepower', 'palo_alto_traffic', 'palo_alto_threat', 'fortinet_fortigate', 'checkpoint_firewall', 'cisco_esa', 'windows_powershell', 'windows_security', 'windows_sysmon', 'linux_syslog', 'linux_audit', 'aws_vpc_flow', 'apache_access', 'nginx_access', 'aws_cloudtrail', 'crowdstrike_falcon', 'corelight_conn', 'f5_bigip', 'sap_audit', 'zeek_conn', 'zscaler_web', 'suricata_ids', 'corelight_dns', 'corelight_http', 'corelight_ssl', 'corelight_kerberos', 'corelight_ldap', 'corelight_ldap_search', 'corelight_ntp', 'corelight_notice', 'corelight_weird', 'corelight_tunnel', 'corelight_vpn', 'corelight_snmp', 'corelight_smtp_links', 'corelight_software', 'corelight_known_hosts', 'corelight_known_remotes', 'corelight_known_services', 'corelight_analyzer', 'corelight_reporter', 'corelight_suricata_enriched', 'corelight_suricata_eve'];

type DestinationSelection = Pick<WizardState, 'sentinelTable' | 'manualFormat' | 'asimSchema' | 'cimModel' | 'ocsfSchema'>;

const DESTINATION_LABELS: Partial<Record<DestFormat, string>> = {
  nextgen: 'CrowdStrike NG SIEM',
  ocsf: 'OCSF 1.9',
  cef: 'CEF',
  sentinel: 'Microsoft Sentinel',
  cim: 'Splunk CIM',
  ecs: 'Elastic ECS',
  asim: 'Microsoft Sentinel ASIM',
  chronicle: 'Google Chronicle UDM',
  json: 'Clean JSON',
  xsiam: 'Cortex XSIAM',
  manual: 'Custom / Other',
};

export function resolveDestFormat(f: DestFormat | string, state: Partial<DestinationSelection>): string {
  if (f === 'sentinel') {
    const table = resolveSentinelTable(state.sentinelTable || '')?.name || state.sentinelTable || '';
    return table.toLowerCase() === 'commonsecuritylog' ? 'commonsecuritylog' : table;
  }
  if (f === 'manual') return state.manualFormat || 'json';
  if (f === 'asim' && state.asimSchema && state.asimSchema !== 'auto') return state.asimSchema;
  if (f === 'cim' && state.cimModel) return cimFormatKeyForModel(state.cimModel) || 'cim';
  if (f === 'ocsf' && state.ocsfSchema && state.ocsfSchema !== 'auto') {
    return concretizeOcsfFormat(f, '', undefined, state.ocsfSchema);
  }
  return f;
}

type PackResult = ReturnType<typeof buildPack>;

export interface GenerateBestPackDependencies {
  buildPack: typeof buildPack;
  getGoldenPipeline: typeof getGoldenPipeline;
  aiMapping: typeof aiMapping;
  aiSampleSnippet: typeof aiSampleSnippet;
  sampleFingerprint: typeof sampleFingerprint;
  fingerprintsMatch: typeof fingerprintsMatch;
  hasGoldenFormatPath: typeof hasGoldenFormatPath;
  goldenPathMatchesSample: typeof goldenPathMatchesSample;
}

const DEFAULT_GENERATION_DEPENDENCIES: GenerateBestPackDependencies = {
  buildPack,
  getGoldenPipeline,
  aiMapping,
  aiSampleSnippet,
  sampleFingerprint,
  fingerprintsMatch,
  hasGoldenFormatPath,
  goldenPathMatchesSample,
};

export interface GenerateBestPackOptions {
  sourcetype: string;
  format: DestFormat;
  state: WizardState;
  reductionToggles: Record<string, boolean>;
  allowCodeFunctions: boolean;
  aiParseFns: AiParseFunctions | null;
  parsedFieldNames: string[];
  presetMappings?: AiMappingResult | null;
  qualitySettings?: Pick<QualitySettings, 'requireSanitisedSamples' | 'normalModel'>;
  dependencies?: GenerateBestPackDependencies;
  log?: (message: string) => void;
}

export interface GenerateBestPackResult {
  pack: PackResult;
  mappings: AiMappingResult | null;
  score: number;
  report: PreDeployResult | null;
}

// Resolve mapping inputs and build the first candidate. Scoring and golden
// promotion intentionally happen only after publish in runPostDeployQuality.
export async function generateBestPack(opts: GenerateBestPackOptions): Promise<GenerateBestPackResult> {
  const { sourcetype, format, state, reductionToggles, allowCodeFunctions, aiParseFns, parsedFieldNames, log } = opts;
  const qualitySettings = opts.qualitySettings || loadQualitySettings();
  const dependencies = opts.dependencies || DEFAULT_GENERATION_DEPENDENCIES;
  const destFormat = resolveDestFormat(format, state);
  const formatLabel = DESTINATION_LABELS[format] || destFormat;
  const sampleSnippet = dependencies.aiSampleSnippet({
    sampleEvents: state.sampleEvents,
    sourceMode: state.sourceMode,
    sanitised: state.sampleSanitised,
    required: qualitySettings.requireSanitisedSamples,
  });
  const currentFingerprint = dependencies.sampleFingerprint(state.sampleEvents);
  const isKnown = KNOWN_PARSER_SOURCETYPES.includes(sourcetype);
  const improveFields = parsedFieldNames.length > 0 ? parsedFieldNames : undefined;
  const golden = dependencies.hasGoldenFormatPath(sourcetype, format, state.sampleEvents)
    && dependencies.goldenPathMatchesSample(sourcetype, format, state.sampleEvents);

  let mappings: AiMappingResult | null = opts.presetMappings ?? null;
  if (!mappings && !golden && !isKnown && state.sampleEvents) {
    try {
      const recipe = await dependencies.getGoldenPipeline(sourcetype, destFormat, goldenWireFormatForSample(state.sampleEvents));
      if (recipe?.recipe?.mappings && dependencies.fingerprintsMatch(recipe.recipe.fingerprint, currentFingerprint)) {
        mappings = recipe.recipe.mappings;
        log?.(`[${formatLabel}] Replaying verified mappings (auto-promoted, no AI).`);
      }
    } catch {
      // Store unavailable: fall through to AI.
    }
  }
  if (!mappings && !golden && state.sampleEvents) {
    try {
      mappings = await dependencies.aiMapping(
        sourcetype,
        destFormat,
        sampleSnippet,
        undefined,
        improveFields,
        undefined,
        qualitySettings.normalModel,
      );
    } catch {
      // buildPack supplies the static fallback.
    }
  }

  const pack = dependencies.buildPack(
    state,
    sourcetype,
    reductionToggles,
    allowCodeFunctions,
    mappings,
    aiParseFns?.functions || null,
  );
  const bestMappings = mappings;
  const bestScore = 0;
  const bestReport: PreDeployResult | null = null;
  log?.(`[${formatLabel}] ${golden ? 'Golden path' : 'Built'} — deploying, scored live after publish.`);

  return { pack, mappings: bestMappings, score: bestScore, report: bestReport };
}

// The authoritative score is deterministic value coverage whenever the live
// preview supplies enough data. AI findings remain advisory.
export function applyDeterministicScore(
  report: ValidationReport,
  dependencies: { scoreAuthoritative: typeof scoreAuthoritative } = { scoreAuthoritative },
): ValidationReport {
  if (!report?.outputSample || report.outputSample.length === 0) return { ...report, scoreSource: 'ai' };
  const auth = dependencies.scoreAuthoritative({
    destFormat: report.destFormat,
    sourcetype: (report as ValidationReport & { sourcetype?: string }).sourcetype,
    rawSampleKeys: report.sampleKeys || [],
    rawEvents: report.sampleRaw || [],
    outputEvents: report.outputSample,
    aiScore: report.score,
  });
  const golden = auth.golden;
  const coverage = auth.coverage;
  const spec = auth.spec;
  const goldenMissing = golden?.supported
    ? golden.missing.map(field => ({ severity: 'medium' as const, field, issue: `OCSF field "${field}" defined for this class but empty in the output`, pointImpact: 0 }))
    : [];
  const specMissing = auth.scoreSource === 'spec-validation' && spec?.supported
    ? (spec.missingFields || []).map(field => ({ severity: 'medium' as const, field, issue: `CIM/spec field "${field}" has source data but is empty in output`, pointImpact: 0 }))
    : [];
  const lostFindings = auth.scoreSource === 'value-coverage' && coverage?.supported
    ? (coverage.lostValues || []).slice(0, 12).map(value => ({ severity: 'medium' as const, field: '_value', issue: `sample value "${value}" not extracted/mapped into the output`, pointImpact: 0 }))
    : [];
  // OCSF-completeness: flat output (canonical values, no nested objects) is not
  // valid OCSF and is capped into the fail band by scoreAuthoritative. Surface a
  // HIGH finding so repair rebuilds the nested envelope (mirrors repair-core.mjs).
  const ocsfFindings = auth.ocsf && auth.ocsf.applicable && !auth.ocsf.complete
    ? [{
        severity: 'high' as const, field: 'class_uid',
        issue: `Output is not a valid OCSF envelope — missing ${auth.ocsf.missing.join(' and ')}. Emit nested OCSF objects (src_endpoint, dst_endpoint, actor.user, device, connection_info/traffic) created parent-first, plus class_uid/category_uid/type_uid/severity_id and metadata.product.`,
        pointImpact: 0,
      }]
    : [];
  // OCSF class-correctness: the output is mapped to the WRONG OCSF class for this
  // source's data class. Capped by scoreAuthoritative; HIGH so repair re-maps to
  // the correct class (mirrors repair-core.mjs).
  const ocsfClassFindings = auth.ocsfClass && auth.ocsfClass.applicable && !auth.ocsfClass.match
    ? [{
        severity: 'high' as const, field: 'class_uid',
        issue: `Output is mapped to the WRONG OCSF class — this source's data maps to ${auth.ocsfClass.expectedClass} (class_uid ${auth.ocsfClass.expectedUid}), but the output emits class_uid ${auth.ocsfClass.emitted.join('/') || '(none)'}. Re-map the events to the ${auth.ocsfClass.expectedClass} class (class_uid ${auth.ocsfClass.expectedUid}, with its category_uid/type_uid and the class's nested content objects).`,
        pointImpact: 0,
      }]
    : [];
  // OCSF real-schema conformance: required/recommended attributes, enum validity
  // and JSON types checked against the vendored official OCSF schema
  // (src/ocsf-schema.ts) — the genuine article, not the shape heuristic above.
  // Capped by scoreAuthoritative; HIGH with the oracle's own reason (mirrors
  // repair-core.mjs).
  const ocsfSchemaFindings = auth.ocsfSchema && auth.ocsfSchema.supported && auth.ocsfSchema.score < 100
    ? [{
        severity: 'high' as const, field: 'class_uid',
        issue: auth.ocsfSchema.reasons[0] || `Output does not conform to the OCSF ${auth.ocsfSchema.detectedClass || ''} schema.`,
        pointImpact: 0,
      }]
    : [];
  // CEF wire-format: malformed CEF (bad header/severity/escaping) is capped by
  // scoreAuthoritative; surface a HIGH finding so repair fixes the wire format,
  // and non-standard extension keys as an advisory LOW (mirrors repair-core.mjs).
  const cefFindings = auth.cef && auth.cef.applicable && auth.cef.validEvents < auth.cef.totalEvents
    ? [{
        severity: 'high' as const, field: '_raw',
        issue: `Output is not valid CEF — ${auth.cef.malformed.slice(0, 4).join('; ')}. Emit CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|ext with severity 0–10 and well-formed key=value extension.`,
        pointImpact: 0,
      }]
    : [];
  const cefKeyFindings = auth.cef && auth.cef.unknownKeys.length
    ? [{
        severity: 'low' as const, field: '_raw',
        issue: `${auth.cef.unknownKeys.length} CEF extension key(s) are not standard/custom: ${auth.cef.unknownKeys.slice(0, 8).join(', ')} — map to a CEF dictionary key or a labelled custom field (csN/cnN).`,
        pointImpact: 0,
      }]
    : [];
  // Structured-format conformance (CIM/ASIM type conformance, ECS/Chronicle
  // envelope) is capped by scoreAuthoritative; surface as HIGH so repair fixes it.
  const schemaFindings = auth.schema && auth.schema.applicable && auth.schema.score < 100
    ? [{
        severity: 'high' as const, field: auth.schema.typeViolations[0]?.split(' ')[0] || '_raw',
        issue: auth.schema.reasons[0] || `Output does not conform to ${auth.schema.format.toUpperCase()} (${auth.schema.target}).`,
        pointImpact: 0,
      }]
    : [];
  // Advisory half (ECS): accepted by Elasticsearch, discouraged by ECS — LOW, never
  // capped (mirrors quality-stage repairGuidanceFindings).
  const schemaAdvisories = (auth.schema?.applicable ? auth.schema.advisories || [] : []).slice(0, 4)
    .map(issue => ({ severity: 'low' as const, field: (issue.match(/\b[a-z_]+(?:\.[a-z_]+)+\b/) || ['_raw'])[0], issue, pointImpact: 0 }));
  // XSIAM parse conformance: XSIAM's own parsing rule will not read this output, so the
  // tenant discards it (`no_hit=drop`) or stores it unparsed. Capped by
  // scoreAuthoritative; HIGH here so the wire shape gets fixed (mirrors repair-core.mjs).
  const xsiamFindings = auth.xsiamParse && auth.xsiamParse.applicable && auth.xsiamParse.cap != null
    ? [{
        severity: 'high' as const, field: '_raw',
        issue: `${auth.xsiamParse.reasons[0] || `XSIAM dataset ${auth.xsiamParse.dataset} will not parse this output.`} ${auth.xsiamParse.failures.slice(0, 3).join('; ')}`.trim(),
        pointImpact: 0,
      }]
    : [];
  const xsiamAdvisory = auth.xsiamParse && auth.xsiamParse.applicable && auth.xsiamParse.keysAbsentFromInput.length
    ? [{
        severity: 'medium' as const, field: auth.xsiamParse.keysAbsentFromInput[0],
        issue: `XSIAM's parsing rule for ${auth.xsiamParse.dataset} reads ${auth.xsiamParse.keysAbsentFromInput.join(', ')}, which this sample's wire format does not carry — check the sample is the format this dataset expects.`,
        pointImpact: 0,
      }]
    : [];
  // Google SecOps UDM wire contract: the destination drops events with a bad
  // event_type/event_timestamp and 400s the batch on a datatype mismatch. Capped by
  // scoreAuthoritative; HIGH so repair fixes the named UDM fields.
  const udmFindings = auth.udm && auth.udm.applicable && auth.udm.cap != null
    ? [{
        severity: 'high' as const, field: auth.udm.droppedEvents ? 'metadata' : '_raw',
        issue: `${auth.udm.reasons.join(' ')} ${auth.udm.failures.slice(0, 4).join('; ')}`.trim(),
        pointImpact: 0,
      }]
    : [];
  const rawFidelityFindings = rawFidelityIssues(auth.rawFidelity)
    .map(issue => ({ severity: 'high' as const, field: '_raw', issue, pointImpact: 0 }));
  const mergedFindings = [
    ...rawFidelityFindings,
    ...ocsfFindings,
    ...ocsfClassFindings,
    ...ocsfSchemaFindings,
    ...cefFindings,
    ...cefKeyFindings,
    ...schemaFindings,
    ...schemaAdvisories,
    ...xsiamFindings,
    ...xsiamAdvisory,
    ...udmFindings,
    ...goldenMissing,
    ...specMissing,
    ...lostFindings,
    ...(spec?.supported ? spec.findings : []),
    ...report.findings,
  ];

  if (auth.scoreSource === 'golden-spec' && golden) {
    return {
      ...report,
      score: auth.score,
      band: auth.band,
      findings: mergedFindings,
      missingFields: golden.missing,
      summary: `OCSF coverage: ${golden.populated}/${golden.expected} class fields populated.${report.summary ? ` AI notes: ${report.summary}` : ''}`,
      scoreSource: 'golden-spec' as ValidationReport['scoreSource'],
    };
  }
  if (auth.scoreSource === 'spec-validation' && spec?.supported) {
    const isXsiam = report.destFormat === 'xsiam';
    return {
      ...report,
      score: auth.score,
      band: auth.band,
      findings: isXsiam ? spec.findings : mergedFindings,
      missingFields: isXsiam ? [] : spec.missingFields,
      summary: isXsiam
        ? `XSIAM contract check: ${spec.populatedFields}/${spec.checkedFields} passed (_raw + exact __sourceIdentifier + __vendor/__product and payload shape when defined). __inputId is preserved but advisory-only because Cribl supplies it automatically.`
        : `Spec validation: ${spec.populatedFields}/${spec.checkedFields} source-relative fields populated.${report.summary ? ` AI notes: ${report.summary}` : ''}`,
      scoreSource: 'spec-validation' as ValidationReport['scoreSource'],
    };
  }
  if (auth.scoreSource === 'value-coverage' && coverage?.supported) {
    return {
      ...report,
      score: auth.score,
      band: auth.band,
      findings: mergedFindings,
      summary: `Value coverage: ${coverage.coveredValues}/${coverage.totalValues} sample values reach the final output (extraction + mapping together).${report.summary ? ` AI notes: ${report.summary}` : ''}`,
      scoreSource: 'value-coverage',
    };
  }
  if (auth.scoreSource === 'raw-fidelity' && auth.rawFidelity?.applicable) {
    const f = auth.rawFidelity;
    return {
      ...report,
      score: auth.score,
      band: auth.band,
      findings: mergedFindings,
      summary: `Raw fidelity: ${f.faithful}/${f.events} events carry the original line in _raw and nothing else.${report.summary ? ` AI notes: ${report.summary}` : ''}`,
      scoreSource: 'raw-fidelity',
    };
  }
  return { ...report, findings: mergedFindings, scoreSource: 'ai' };
}
