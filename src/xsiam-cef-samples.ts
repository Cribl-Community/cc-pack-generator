/**
 * Destination-specific CEF samples for sources whose Cortex XSIAM contract
 * requires CEF. This is intentionally separate from the general sample resolver:
 * native KVP/syslog samples remain correct for other destinations, but must never
 * satisfy an explicit XSIAM CEF request.
 */

import fixturesData from '../config/xsiam-cef-samples.json';
import checkpointSample from '../config/xsiam-pack/samples/XSIAM-Checkpoint-CEF.log.json';
import fortigateSample from '../config/xsiam-pack/samples/XSIAM-Fortinet-Fortigate-CEF.log.json';
import { lookupSourceMap, resolveXsiamDestination } from './xsiam-resolver';

type SampleEvent = string | { _raw?: string; [key: string]: unknown };

interface ContractFixture {
  evidence: string;
  events: string[];
}

export interface XsiamCefSample {
  available: true;
  events: SampleEvent[];
  sourcetype: string;
  pack: 'xsiam-pack' | 'vendor-samples' | 'xsiam-cef-contract';
  sampleName: string;
  synthetic: boolean;
  provenance: string;
}

const CONTRACT_FIXTURES = (fixturesData as { sources: Record<string, ContractFixture> }).sources;

/**
 * Real harvested lines that back an asserted CEF contract. They live in the fixture
 * file rather than in the samples pool for one reason: an asserted requirement BLOCKS
 * the destination screen until it is satisfied, so the sample that satisfies it must
 * resolve with no network read. See the `_notice` in config/xsiam-cef-samples.json.
 */
interface HarvestedFixture {
  sourcetype: string;
  sampleName: string;
  provenance: string;
  events: string[];
}
const HARVESTED = ((fixturesData as { harvested?: Record<string, HarvestedFixture> }).harvested || {});

const MIRRORED: Record<string, Omit<XsiamCefSample, 'available' | 'sourcetype'>> = {
  checkpoint_firewall: {
    events: checkpointSample,
    pack: 'xsiam-pack',
    sampleName: 'XSIAM-Checkpoint-CEF.log',
    synthetic: false,
    provenance: 'Palo Alto-provided sample mirrored from cribl-paloalto-xsiam',
  },
  fortinet_fortigate: {
    events: fortigateSample,
    pack: 'xsiam-pack',
    sampleName: 'XSIAM-Fortinet-Fortigate-CEF.log',
    synthetic: false,
    provenance: 'Palo Alto-provided sample mirrored from cribl-paloalto-xsiam',
  },
  cyberark_pta: {
    events: HARVESTED.cyberark_pta?.events || [],
    // Still `vendor-samples`: the label states the TRUST TIER ("a real harvested
    // vendor log"), which is what the UI and scoring read, not where the bytes sit.
    pack: 'vendor-samples',
    sampleName: HARVESTED.cyberark_pta?.sampleName || 'cyberark_pta_cef',
    synthetic: false,
    provenance: HARVESTED.cyberark_pta?.provenance || '',
  },
};

/** Return the asserted XSIAM wire format only when XSIAM is a selected destination. */
export function getRequiredXsiamSampleFormat(
  sourcetype: string,
  destinations: readonly string[],
): string | undefined {
  if (!destinations.includes('xsiam') || !sourcetype.trim()) return undefined;
  const required = resolveXsiamDestination(sourcetype).requiredInputFormat;
  return required?.enforcement === 'fail' ? required.format : undefined;
}

/**
 * Return a CEF sample only when XSIAM explicitly requires CEF for this source.
 * Aliases resolve through the same hand-authored source map as the XSIAM builder.
 */
export function getXsiamCefSample(sourcetype: string): XsiamCefSample | null {
  const mapped = lookupSourceMap(sourcetype);
  if (!mapped) return null;
  const resolution = resolveXsiamDestination(mapped.key);
  if (resolution.requiredInputFormat?.format !== 'cef') return null;

  const real = MIRRORED[mapped.key];
  if (real) return { available: true, sourcetype: mapped.key, ...real };

  const fixture = CONTRACT_FIXTURES[mapped.key];
  if (!fixture?.events?.length) return null;
  return {
    available: true,
    events: fixture.events,
    sourcetype: mapped.key,
    pack: 'xsiam-cef-contract',
    sampleName: `${mapped.key}_xsiam_cef`,
    synthetic: true,
    provenance: fixture.evidence,
  };
}
