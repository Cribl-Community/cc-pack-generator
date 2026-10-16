/**
 * Cortex XSIAM pack emission — replay mirrored pipelines or construct T2/T3 tags.
 * Resolution lives in xsiam-resolver.ts; this module is the builder half of
 * docs/destination-specs/xsiam.md. It must not import pack-builder or
 * sample-library (cycle).
 */

import { stringify as yamlStringify } from 'yaml';
import breakersData from '../config/xsiam-pack/breakers.json';
import {
  resolveXsiamDestination,
  type XsiamRequiredFormat,
  type XsiamResolution,
} from './xsiam-resolver';
import { loadXsiamPackPipeline } from './xsiam-pack-pipelines';

/** T1c satisfies the UUID contract but must not present T1a's confidence (≥85). */
export const XSIAM_T1C_SCORE_CEILING = 84;

export interface XsiamFn {
  id: string;
  filter?: string;
  disabled?: boolean | null;
  description?: string;
  conf: Record<string, unknown>;
}

export class XsiamBuildError extends Error {
  readonly code: 'T4' | 'FORMAT';
  readonly consulted: string[];
  readonly requiredFormat?: string;
  readonly detectedFormat?: string;
  constructor(message: string, code: 'T4' | 'FORMAT', extra: { consulted?: string[]; requiredFormat?: string; detectedFormat?: string } = {}) {
    super(message);
    this.name = 'XsiamBuildError';
    this.code = code;
    this.consulted = extra.consulted || [];
    this.requiredFormat = extra.requiredFormat;
    this.detectedFormat = extra.detectedFormat;
  }
}

/**
 * Coarse classifier matching `describeSampleFormat().id` for the formats the
 * XSIAM gate actually compares (cef/leef/json/kvp/syslog/xml/csv/text). CEF/LEEF
 * headers beat their own key=value extensions; syslog-framed CEF still counts as
 * CEF because the CEF token is checked first.
 */
export function classifyXsiamSampleFormat(sampleEvents?: string | null): string | null {
  const lines = String(sampleEvents || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 50);
  if (!lines.length) return null;
  const hit = (re: RegExp) => lines.some(l => re.test(l));
  if (hit(/\bCEF:\d+\|/)) return 'cef';
  if (hit(/\bLEEF:\d/)) return 'leef';
  if (hit(/^\s*[{[]/)) return 'json';
  if (hit(/^\s*</)) return 'xml';
  const delim = (ch: string) => {
    const counts = lines.map(l => l.split(ch).length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    return mode >= 3 && counts.filter(c => c === mode).length / lines.length >= 0.7;
  };
  if (delim(',')) return 'csv';
  if (delim('\t')) return 'tsv';
  if (delim('|') && !hit(/\b(?:CEF|LEEF):/)) return 'psv';
  const kvp = lines.filter(l => /(?:^|[\s;|])[A-Za-z_][\w.-]*=\S+/.test(l)).length;
  if (kvp / lines.length >= 0.5) return 'kvp';
  if (hit(/^(?:<\d+>)?(?:[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}[T ])/)) return 'syslog';
  return 'text';
}

export function xsiamFormatsMatch(required: string, detected: string): boolean {
  return String(required || '').trim().toLowerCase() === String(detected || '').trim().toLowerCase();
}

export interface XsiamLintFinding {
  severity: 'error' | 'warning';
  stage: string;
  field: string;
  expr: string;
  hint: string;
}

export function resolveXsiamForBuild(sourcetype: string, sampleEvents?: string | null): XsiamResolution {
  return resolveXsiamDestination(sourcetype, { sampleFormat: classifyXsiamSampleFormat(sampleEvents) });
}

export function lintXsiamBuild(sourcetype: string, sampleEvents?: string | null): XsiamLintFinding[] {
  const resolution = resolveXsiamForBuild(sourcetype, sampleEvents);
  const detected = classifyXsiamSampleFormat(sampleEvents);
  const findings: XsiamLintFinding[] = [];
  if (!resolution.resolved) {
    findings.push({
      severity: 'error',
      stage: 'xsiam-resolve',
      field: sourcetype,
      expr: '',
      hint: xsiamFailureMessage(resolution),
    });
  }
  const gate = formatGateFinding(resolution.requiredInputFormat, detected);
  if (gate) findings.push(gate);
  return findings;
}

function formatGateFinding(required: XsiamRequiredFormat | null, detected: string | null): XsiamLintFinding | null {
  if (!required || !detected || xsiamFormatsMatch(required.format, detected)) return null;
  const hint = `Required input format is ${required.format} (${required.authority}: ${required.evidence || 'no evidence string'}), detected ${detected}. The output is never converted — supply a sample in the required shape`
    + (required.authority === 'pack-sample' ? '.' : ', or use the Palo Alto-provided pack sample.');
  if (required.enforcement === 'fail') {
    return { severity: 'error', stage: 'xsiam-format', field: '_raw', expr: detected, hint };
  }
  return { severity: 'warning', stage: 'xsiam-format', field: '_raw', expr: detected, hint };
}

export function xsiamFailureMessage(resolution: XsiamResolution): string {
  const consulted = resolution.failure?.consulted?.join('; ') || 'the three XSIAM knowledge mirrors';
  return `${resolution.failure?.reason || `No XSIAM knowledge source covers "${resolution.sourcetype}"`}. Consulted: ${consulted}.`;
}

export function assertXsiamBuildable(resolution: XsiamResolution, sampleEvents?: string | null): void {
  if (!resolution.resolved) {
    throw new XsiamBuildError(xsiamFailureMessage(resolution), 'T4', { consulted: resolution.failure?.consulted || [] });
  }
  const detected = classifyXsiamSampleFormat(sampleEvents);
  const required = resolution.requiredInputFormat;
  if (required?.enforcement === 'fail' && detected && !xsiamFormatsMatch(required.format, detected)) {
    throw new XsiamBuildError(
      `XSIAM requires ${required.format} for this source (${required.evidence || required.authority}); the sample is ${detected}.`,
      'FORMAT',
      { requiredFormat: required.format, detectedFormat: detected },
    );
  }
}

export function xsiamProvenanceComment(sourcetype: string, resolution: XsiamResolution): XsiamFn {
  const lines = [
    `${sourcetype} → Cortex XSIAM  [${resolution.tier}]`,
    resolution.provenance.source,
    resolution.provenance.packVersion ? `mirrored pack v${resolution.provenance.packVersion}` : null,
    resolution.provenance.docSyncedAt ? `UUID catalog synced ${resolution.provenance.docSyncedAt}` : null,
    resolution.provenance.contentCommit ? `demisto/content ${resolution.provenance.contentCommit.slice(0, 12)}` : null,
    resolution.dataset ? `dataset ${resolution.dataset}` : null,
    ...resolution.provenance.notes,
  ].filter((line): line is string => Boolean(line));
  return { id: 'comment', conf: { comment: lines.join('\n') } };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function replaceDeep(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map(item => replaceDeep(item, from, to));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = replaceDeep(item, from, to);
    return out;
  }
  return value;
}

export function replayXsiamFunctions(resolution: XsiamResolution): XsiamFn[] {
  const name = resolution.packPipeline;
  if (!name) return [];
  const body = loadXsiamPackPipeline(name);
  if (!body?.functions) {
    throw new XsiamBuildError(
      `Mirrored pipeline ${name} is missing — run npm run sync:xsiam-pack.`,
      'T4',
    );
  }
  let functions = cloneJson(body.functions) as XsiamFn[];
  const from = resolution.provenance.uuidOverriddenFrom;
  const to = resolution.sourceIdentifier;
  if (from && to && from !== to) {
    functions = replaceDeep(functions, from, to) as XsiamFn[];
  }
  return functions;
}

export function buildXsiamConstructedTags(resolution: XsiamResolution): XsiamFn[] {
  const adds: { name: string; value: string; disabled?: boolean }[] = [];
  const idField = resolution.sourceIdField || '__sourceIdentifier';
  if (resolution.sourceIdentifier) adds.push({ name: idField, value: `'${resolution.sourceIdentifier}'` });
  if (resolution.vendor) adds.push({ name: '__vendor', value: `'${resolution.vendor}'` });
  if (resolution.product) adds.push({ name: '__product', value: `'${resolution.product}'` });
  if (!adds.length) return [];
  const description = resolution.vendor
    ? 'Tag XSIAM routing metadata (__sourceIdentifier, __vendor, __product)'
    : 'Tag XSIAM routing metadata (__sourceIdentifier)';
  return [{ id: 'eval', filter: 'true', description, conf: { add: adds } }];
}

export function buildXsiamRoutingFunctions(sourcetype: string, sampleEvents?: string | null): XsiamFn[] {
  const resolution = resolveXsiamForBuild(sourcetype, sampleEvents);
  assertXsiamBuildable(resolution, sampleEvents);
  if (resolution.packPipeline) return replayXsiamFunctions(resolution);
  return buildXsiamConstructedTags(resolution);
}

export function buildXsiamBreakerYml(rulesetNames: string[]): string | null {
  if (!rulesetNames.length) return null;
  const all = (breakersData as { rulesets: Record<string, unknown> }).rulesets || {};
  const picked: Record<string, unknown> = {};
  for (const name of rulesetNames) {
    if (!all[name]) {
      throw new XsiamBuildError(
        `Mirrored breaker ruleset ${name} is missing — run npm run sync:xsiam-pack.`,
        'T4',
      );
    }
    picked[name] = all[name];
  }
  return yamlStringify(picked);
}

export { loadXsiamPackPipeline };
