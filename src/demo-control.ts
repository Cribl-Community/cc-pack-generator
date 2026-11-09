// Whiteboards & demos: the live demos on every worker group, matched to the boards they
// were generated from, and what Stop / Start / Destroy touch for ONE of them. Pure —
// the page scans and acts; this decides. A demo is a (worker group, namespace) pair:
// each whiteboard's demo has its own names (demo-flow-ids.ts), so one can stop or go
// without touching the others on the same group.
import {
  DEMO_EVENTS_PER_SEC, DEMO_TERMINATOR_ID, demoCleanupSelection, demoNamespacesIn, demoNsOfDatagen,
} from './demo-flow-ids';
import type { DemoDeploymentRecord, WhiteboardIndexEntry } from './whiteboard/types';

export interface DemoScanLike {
  routes: { id: string }[];
  datagens: { id: string; sampleCount?: number; description?: string; disabled?: boolean }[];
  packs: { id: string }[];
}

/** running = every data generator on; stopped = every one off; partial = some of each. */
export type DemoRunState = 'running' | 'stopped' | 'partial';

export interface LiveDemo {
  /** `${group}::${ns}` — stable across rescans. */
  key: string;
  group: string;
  /** '' = made by hand (the classic names). */
  ns: string;
  /** The board whose namespace this is; null = made by hand, or its board was deleted. */
  boardId: string | null;
  routes: string[];
  datagens: string[];
  packs: string[];
  state: DemoRunState;
  /** Events a second while running (every sample of every enabled generator). */
  eventsPerSec: number;
  sourcetypes: string[];
  formats: string[];
  /** From the board's deployment record, when there is one. */
  deployedAt?: string;
  lakeDataset?: string;
  /** The board changed after this demo was generated. */
  stale?: boolean;
}

export const demoKey = (group: string, ns: string) => `${group}::${ns}`;

export function demoRunState(datagens: { disabled?: boolean }[]): DemoRunState {
  const off = datagens.filter(d => d.disabled === true).length;
  if (off === 0 && datagens.length > 0) return 'running';
  if (off === datagens.length) return 'stopped';
  return 'partial';
}

/** The sourcetypes a demo datagen's description lists (`Demo datagen — 2 source(s): a, b`). */
function describedSources(description = ''): string[] {
  const i = description.indexOf(': ');
  return i === -1 ? [] : description.slice(i + 2).split(',').map(s => s.trim()).filter(Boolean);
}

/** The format a lane datagen is named for; null for the OCSF replay (it feeds post-processing). */
function laneFormat(id: string, ns: string): string | null {
  const tail = ns ? id.slice(`demo_datagen_${ns}__`.length) : id.slice('demo_datagen_'.length);
  return !tail || tail === 'ocsf_pp' ? null : tail;
}

/** Board namespace → board id. A board keeps its namespace once assigned, so any record names it. */
export function boardsByNamespace(boards: WhiteboardIndexEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of boards) {
    const ns = b.demoNs || b.demo?.ns;
    if (ns && !out.has(ns)) out.set(ns, b.id);
  }
  return out;
}

/**
 * Every demo on one worker group, one per namespace. `records` are the boards' live
 * deployment records (newest first); a match fills in what the scan cannot know.
 */
export function liveDemosOnGroup(
  group: string,
  scan: DemoScanLike,
  boardOfNs: ReadonlyMap<string, string>,
  records: ReadonlyArray<{ boardId: string; record: DemoDeploymentRecord; stale?: boolean }> = [],
): LiveDemo[] {
  return demoNamespacesIn(scan).map(ns => {
    const pick = demoCleanupSelection(scan, ns);
    const gens = scan.datagens.filter(d => demoNsOfDatagen(d.id) === ns);
    const boardId = ns ? boardOfNs.get(ns) ?? null : null;
    const rec = boardId
      ? records.find(r => r.boardId === boardId && r.record.group === group && (r.record.ns || '') === ns && r.record.status !== 'removed')
      : undefined;
    const sources = [...new Set(gens.flatMap(d => describedSources(d.description)))];
    const formats = [...new Set(gens.map(d => laneFormat(d.id, ns)).filter((f): f is string => !!f))];
    return {
      key: demoKey(group, ns),
      group,
      ns,
      boardId,
      // The shared terminator is not this demo's to show (Destroy recomputes it).
      routes: pick.routes.filter(id => id !== DEMO_TERMINATOR_ID),
      datagens: pick.datagens,
      packs: pick.packs,
      state: demoRunState(gens),
      eventsPerSec: gens.filter(d => d.disabled !== true).reduce((n, d) => n + (d.sampleCount || 0), 0) * DEMO_EVENTS_PER_SEC,
      sourcetypes: rec?.record.sourcetypes.length ? [...rec.record.sourcetypes] : sources,
      formats: rec?.record.formats.length ? [...rec.record.formats] : formats,
      ...(rec ? { deployedAt: rec.record.deployedAt } : {}),
      ...(rec?.record.lakeDataset ? { lakeDataset: rec.record.lakeDataset } : {}),
      ...(rec?.stale ? { stale: true } : {}),
    };
  });
}

/** What Destroy removes for one demo: its own objects, plus the terminator when it is the last. */
export function destroySelection(scan: DemoScanLike, ns: string): { routeIds: string[]; datagenIds: string[]; packIds: string[]; outputIds: string[] } {
  const pick = demoCleanupSelection(scan, ns);
  return { routeIds: pick.routes, datagenIds: pick.datagens, packIds: pick.packs, outputIds: [] };
}

/** What Stop or Start flips: the demo's generators not already in the wanted state. */
export function runToggleIds(scan: DemoScanLike, ns: string, running: boolean): string[] {
  return scan.datagens.filter(d => demoNsOfDatagen(d.id) === ns && (d.disabled === true) === running).map(d => d.id);
}

/** A board's records that should be live on a group the scan read, but are not there. */
export function missingRecords(
  records: DemoDeploymentRecord[],
  scanned: ReadonlyMap<string, DemoScanLike>,
): DemoDeploymentRecord[] {
  return records.filter(r => {
    if (r.status === 'removed') return false;
    const scan = scanned.get(r.group);
    if (!scan) return false;              // not read (or the read failed): unknown, not missing
    return !demoNamespacesIn(scan).includes(r.ns || '');
  });
}

/** The newest live record per group (a board keeps up to 10, newest first). */
export function liveRecordsByGroup(records: DemoDeploymentRecord[]): DemoDeploymentRecord[] {
  const seen = new Set<string>();
  return records.filter(r => r.status !== 'removed' && !seen.has(r.group) && (seen.add(r.group), true));
}

/** "6 sources → OCSF, Splunk" — the strip's one-line summary. */
export function demoFlowLabel(d: Pick<LiveDemo, 'sourcetypes' | 'formats'>): string {
  const n = d.sourcetypes.length;
  const src = n ? `${n} source${n === 1 ? '' : 's'}` : 'Sources not known';
  return d.formats.length ? `${src} → ${d.formats.join(', ')}` : src;
}

export const DEMO_STATE_LABEL: Record<DemoRunState, string> = {
  running: 'Running',
  stopped: 'Stopped',
  partial: 'Partly running',
};

