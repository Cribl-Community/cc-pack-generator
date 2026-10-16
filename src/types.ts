export type SourceMode = '' | 'upload' | 'existing' | 'ai-generate' | 'paste' | 'live-capture';
// 'sentinel' is a pseudo-format: the user picks the concrete Microsoft Sentinel
// table below (stored in WizardState.sentinelTable); the build resolves it to
// the table name (or 'commonsecuritylog' for CSL, which has a dedicated mapping).
// 'commonsecuritylog' stays a valid internal/build format but is no longer a grid card.
// `asim#<dataClass>` variants (asim#authentication, asim#dns, …) are concrete
// ASIM schemas resolved from the sourcetype/sample data class; bare `asim`
// (= NetworkSession) is concretized to one of these at build time.
// `cim#<model|dataClass>` likewise — bare `cim` is concretized to Network Traffic
// (or the selected WizardState.cimModel) at build time.
export type AsimSchemaFormat = `asim#${string}`;
export type CimSchemaFormat = `cim#${string}`;
export type OcsfSchemaFormat = `ocsf#${string}`;
export type DestFormat = 'nextgen' | 'ocsf' | OcsfSchemaFormat | 'cef' | 'commonsecuritylog' | 'cim' | CimSchemaFormat | 'ecs' | 'asim' | AsimSchemaFormat | 'chronicle' | 'json' | 'xsiam' | 'passthrough' | 'raw_fields' | 'splunk_raw' | 'splunk_json' | 'elastic_raw' | 'elastic_json' | 'chronicle_raw' | 'sentinel' | 'manual';

export interface WizardState {
  packName: string;
  displayName: string;
  description?: string;
  sourceMode: SourceMode;
  sampleEvents: string;
  /**
   * The events have been pseudonymised locally and reviewed (see sample-sanitise.ts).
   *
   * Uploaded, worker-group, pasted and live-captured events are customer data, and
   * sample lines go into AI prompts. This flag is what `aiSampleSnippet` checks before
   * handing text to a model vendor, so it is cleared by `update()` the moment
   * `sampleEvents` changes — a mark granted for one sample must never cover another.
   */
  sampleSanitised?: boolean;
  destFormat: DestFormat;
  destFormats: DestFormat[];
  manualFormat: string;
  routeFilter: string;
  workerGroup: string;
  // Selected Splunk CIM data model (e.g. 'Network_Traffic') for destFormat 'cim'
  // — grounds the AI mapping on that model's exact field list. Optional.
  cimModel?: string;
  // Selected Microsoft Sentinel table (e.g. 'CommonSecurityLog') for the
  // 'sentinel' pseudo-format — resolves to the concrete build destFormat. Optional.
  sentinelTable?: string;
  // Selected ASIM schema for the 'asim' format — a concrete build format
  // ('asim#authentication', 'asim#dns', …) or 'auto' to let the sourcetype/sample
  // data class decide. Optional (defaults to auto).
  asimSchema?: string;
  // Selected OCSF class for 'ocsf' / 'nextgen' — concrete `ocsf#network` /
  // `ocsf#endpoint` / `ocsf#cloud_audit`, or 'auto' from the data class.
  ocsfSchema?: string;
}

export interface PackPayload {
  packageJson: object;
  routeYml: string;
  pipelineYml: string;
  samplesYml: string;
  sampleData: object[];
}
