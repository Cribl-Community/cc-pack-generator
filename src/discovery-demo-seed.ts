/**
 * From a validated whiteboard to the Demo environment flow, and back (spec R11, R12;
 * plan Task 10). Pure.
 *
 *   demoSeedFromPlan     what Demo mode is filled in with (sources, formats, Lake)
 *   groupNeighbours      the other boards' demos also running on that worker group
 *   deploymentRecord     what a finished demo writes on its board
 *   recordDeployment     the board after a deploy (newest first, ≤ 10)
 *   markGroupReleased    a board whose demo on that group is gone (cleanup, or a legacy replace)
 *
 * Each board's demo is named in its own namespace (spec R16), so several boards run on
 * one worker group and deploying one never replaces another. Only a demo made by hand
 * (legacy names, ns '') replaces the legacy block — which is what pre-Phase-3 board
 * records point at. These records are how the app knows whose demo is where.
 */
import type { DemoDeploymentRecord, WhiteboardDoc, WhiteboardIndexEntry } from './whiteboard/types';

const MAX_RECORDS = 10;

export interface DemoSeed {
  boardId: string;
  /** The board's demo namespace: every id the demo creates is named in it (spec R16). */
  ns: string;
  prospect: string;
  fingerprint: string;
  sources: string[];
  destFormats: string[];
  lake: { datasetId: string; retentionPeriodInDays: number; dashboard?: boolean } | null;
}

export function demoSeedFromPlan(
  plan: { sources: string[]; formats: string[]; lake: { datasetId: string; retentionPeriodInDays: number; dashboard?: boolean } | null },
  board: { id: string; prospect: string; fingerprint: string; ns: string },
): DemoSeed {
  return {
    boardId: board.id,
    ns: board.ns,
    prospect: board.prospect,
    fingerprint: board.fingerprint,
    sources: [...plan.sources],
    destFormats: [...plan.formats],
    lake: plan.lake ? { datasetId: plan.lake.datasetId, retentionPeriodInDays: plan.lake.retentionPeriodInDays, ...(plan.lake.dashboard ? { dashboard: true } : {}) } : null,
  };
}

/** The other boards' demos still on this group, newest first — information, not a conflict (R16). */
export function groupNeighbours(group: string, boardId: string, boards: WhiteboardIndexEntry[]): Array<{ boardId: string; prospect: string; deployedAt: string }> {
  return boards
    .filter(b => b.id !== boardId && b.demo && b.demo.group === group && b.demo.status !== 'removed')
    .sort((a, b) => (b.demo!.deployedAt).localeCompare(a.demo!.deployedAt))
    .map(b => ({ boardId: b.id, prospect: b.prospect || 'an untitled board', deployedAt: b.demo!.deployedAt }));
}

export function deploymentRecord(seed: DemoSeed, outcome: {
  group: string;
  results: Array<{ sourcetype: string; format: string; status: 'pending' | 'running' | 'success' | 'error' }>;
  packs: string[];
  buildNumber: number;
  lakeDataset?: string;
  at?: Date;
}): DemoDeploymentRecord {
  const done = outcome.results.filter(r => r.status === 'success');
  const status: DemoDeploymentRecord['status'] = done.length > 0 && done.length === outcome.results.length ? 'deployed' : 'partial';
  return {
    group: outcome.group,
    deployedAt: (outcome.at ?? new Date()).toISOString(),
    buildNumber: outcome.buildNumber,
    sourcetypes: [...new Set(done.map(r => r.sourcetype))],
    formats: [...new Set(done.map(r => r.format))],
    packs: [...outcome.packs],
    intakeFingerprint: seed.fingerprint,
    ...(seed.ns ? { ns: seed.ns } : {}),
    ...(outcome.lakeDataset ? { lakeDataset: outcome.lakeDataset } : {}),
    status,
  };
}

export function recordDeployment(doc: WhiteboardDoc, record: DemoDeploymentRecord): WhiteboardDoc {
  return { ...doc, updatedAt: record.deployedAt, deployments: [record, ...doc.deployments].slice(0, MAX_RECORDS) };
}

/**
 * A board whose live demo on `group` is gone. `namespaces` limits it to records whose
 * demo was named in one of them ('' = legacy names); absent = every record on the group.
 * Returns null when nothing on the board changed.
 */
export function markGroupReleased(doc: WhiteboardDoc, group: string, at: Date, namespaces?: ReadonlySet<string>): WhiteboardDoc | null {
  let changed = false;
  const deployments = doc.deployments.map(r => {
    if (r.group !== group || r.status === 'removed') return r;
    if (namespaces && !namespaces.has(r.ns || '')) return r;
    changed = true;
    return { ...r, status: 'removed' as const, removedAt: at.toISOString() };
  });
  return changed ? { ...doc, deployments } : null;
}
