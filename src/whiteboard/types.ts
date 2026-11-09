/**
 * Discovery whiteboard — documents the app stores (spec: docs/superpowers/specs/
 * 2026-10-31-discovery-whiteboard-design.md, "Data model").
 *
 * The board itself is the vendored v5 whiteboard. Its two documents keep the exact
 * shape that file reads and writes (`LIB` and `MEET`), so a board saved here imports
 * and exports losslessly. Only the fields the app reads are typed; the rest pass through.
 */

export interface WhiteboardLibItem {
  id: string;
  on?: boolean;
  custom?: boolean;
  label?: string;
  desc?: string;
  cribl?: string;
  mark?: string;
  isCribl?: boolean;
  family?: string;
  level?: string;
  badge?: string;
  kind?: string;
  target?: string;
}

/** The SE's library: their own items, Configure ticks, theme, colours, language. Shared by every board. */
export interface WhiteboardLibV5 {
  v: 5;
  groups: Record<string, { items: WhiteboardLibItem[] }>;
  removed: string[];
  theme?: string;
  colors?: Record<string, Record<string, string>>;
  /** A code of BOARD_LANGUAGES (config/whiteboard-i18n.json): en, fr, de, es. */
  lang?: string;
  saveFormats?: Record<string, boolean>;
  /** Set by the board once its built-in people profiles start off (P13); a library without it is switched over once. */
  peopleEmpty?: number;
  /** Added by the app (v5 ignores unknown keys): what this SE chose last time for the same words. */
  discoveryAliases?: DiscoveryAliases;
  [k: string]: unknown;
}

/** One meeting: prospect, logo, shown/removed items, selections, arrows, view. */
export interface WhiteboardMeetV5 {
  v: 5;
  prospect: string;
  logo: string;
  view: Record<string, string>;
  shown: Record<string, boolean>;
  ucSel: Record<string, boolean>;
  paSel: Record<string, boolean>;
  arrows: unknown[];
  /** Arrows: clean (layer to layer, one per store family out of the pipeline; the default), on (Auto, item by item), off (Manual). */
  auto: 'clean' | 'on' | 'off';
  started: string;
  /** An empty start: Cribl Detect stays off until the pipeline (and the Cribl column) is shown. */
  detectWithPipe?: boolean;
  [k: string]: unknown;
}

export interface DiscoveryAliases {
  sources: Record<string, { picks: string[]; savedAt: string }>;
  dests: Record<string, { format: string; note?: string; savedAt: string }>;
}

export interface DiscoveryValidation {
  intakeFingerprint: string;
  validatedAt: string;
  sources: Array<{ label: string; itemKey: string; picks: string[]; leftOut?: boolean }>;
  dests: Array<{ label: string; itemKey: string; format?: string; leftOut?: boolean; cribl?: 'lakehouse' | 'detect' }>;
  lake?: { datasetId: string; retentionPeriodInDays: number; reuse: boolean; format: 'ocsf' | 'raw_fields' | 'passthrough'; dashboard?: boolean } | null;
}

export interface DemoDeploymentRecord {
  group: string;
  deployedAt: string;
  buildNumber: number;
  sourcetypes: string[];
  formats: string[];
  packs: string[];
  intakeFingerprint: string;
  lakeDataset?: string;
  /** The namespace the demo's ids are named in ('' or absent = legacy, before Phase 3). */
  ns?: string;
  status: 'deployed' | 'partial' | 'removed';
  removedAt?: string;
}

export interface WhiteboardDoc {
  v: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  meet: WhiteboardMeetV5;
  validation?: DiscoveryValidation;
  /** The board's demo namespace (spec R16), assigned on its first generate and never renamed. */
  demoNs?: string;
  /** Newest first, at most 10. */
  deployments: DemoDeploymentRecord[];
}

/** Enough of a meeting to draw its list thumbnail, without storing the meeting. */
export interface BoardSketch {
  sources: number;
  point: number;
  cribl: number;
  platform: number;
  /** before: sources curve into the systems. after: the pipeline and the Cribl column are on. */
  pipe: 'before' | 'after' | 'off';
  search: boolean;
  ai: boolean;
  pains: number;
  useCases: number;
}

export interface WhiteboardIndexEntry {
  id: string;
  prospect: string;
  /** The board's logo when small enough for the list (≤ 4 KB data URL); else the list shows initials. */
  logoThumb?: string;
  /** Absent on rows written before build 949 — `createdAtOf` reads it from the id then. */
  createdAt?: string;
  updatedAt: string;
  summary: { sources: number; destinations: number; pains: number; useCases: number };
  /** How the list draws the thumbnail. Absent on rows saved before build 963; the list then uses the counts. */
  sketch?: BoardSketch;
  validation: 'none' | 'complete' | 'stale';
  /** The board's demo namespace, once assigned (absent on rows written before build 951). */
  demoNs?: string;
  demo?: { group: string; deployedAt: string; status: 'deployed' | 'partial' | 'removed' | 'stale'; ns?: string };
  /** The board's Architecture drawing, when one is drawn (absent before build 979). */
  arch?: { parts: number; groups: number; updatedAt: string };
}
