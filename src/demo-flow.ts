// Demo environment v2: every demo source is a Build pack flow
// (docs/demo-ocsf-flow-design-v2-2026-10-02.html).
//
//   lane datagen per format ─▶ main pack per source (one pipeline per format)
//                                 └─ OCSF pipeline (optional) ─▶ replay datagen ─▶ post-processing packs
//
// A route can point at a pack but not at one pipeline inside it, so every
// main-pack format gets its own datagen input (its "lane") and the pack's
// internal routes pick the pipeline by input. The post-processing packs read
// OCSF from a replay datagen recorded from the OCSF pipeline's own preview output.
//
// Everything here is pure: App.tsx resolves samples, builds and deploys.
import {
  DEMO_EVENTS_PER_SEC, DEMO_FEED_FILTER, DEMO_LAKE_OUTPUT, DEMO_TERMINATOR_FILTER, demoLaneFilter, demoLaneId, demoMainPackId, demoPpPackId,
  demoPipelineId, idPart,
} from './demo-flow-ids';
import { FLOW_FORMATS, ppEffectiveFormat, ppOutputLabel, ppOutputsToBuild, type FlowPpOutput, type FlowPpState } from './flow-builder';

/** One column of the routing grid: a main-pack format or a post-processing output. */
export interface DemoTarget { key: string; kind: 'main' | 'pp'; fmt: string; label: string; pp?: FlowPpOutput }

export function demoTargets(destFormats: string[], pp: FlowPpState): DemoTarget[] {
  const main: DemoTarget[] = destFormats.map(fmt => ({ key: fmt, kind: 'main', fmt, label: FLOW_FORMATS[fmt]?.label || fmt }));
  const post: DemoTarget[] = ppOutputsToBuild(destFormats, pp).map(o => {
    const eff = ppEffectiveFormat(o);
    return { key: `pp:${eff}`, kind: 'pp', fmt: eff, label: `OCSF → ${ppOutputLabel(o)}`, pp: o };
  });
  return [...main, ...post];
}

/** One cell of the routing grid: does this source go to this target, and where to. */
export interface DemoCell { sourcetype: string; target: string; enabled: boolean; output: string }

/** Every cell on. Lake-type formats default to the demo Lake dataset when there is one. */
export function demoDefaultCells(sources: string[], targets: DemoTarget[], hasLake: boolean): DemoCell[] {
  return sources.flatMap(sourcetype => targets.map(t => ({
    sourcetype, target: t.key, enabled: true,
    output: hasLake && t.kind === 'main' && FLOW_FORMATS[t.fmt]?.group === 'lake' ? DEMO_LAKE_OUTPUT : 'devnull',
  })));
}

/** Keep the user's choices for cells that still exist; new cells get the defaults. */
export function demoMergeCells(prev: DemoCell[], next: DemoCell[]): DemoCell[] {
  return next.map(c => prev.find(p => p.sourcetype === c.sourcetype && p.target === c.target) ?? c);
}

export interface DemoPlannedRoute {
  id: string; name: string; filter: string; pipeline: string; output: string;
  sourcetype: string; target: string; kind: 'main' | 'pp';
}
export interface DemoPlanPack {
  sourcetype: string; packId: string;
  /** In build order; OCSF last so the post-processing packs can preview it. */
  pipelines: { fmt: string; pipelineId: string; routeFilter: string }[];
}
export interface DemoPlanPpPack { sourcetype: string; packId: string; target: string; output: FlowPpOutput }
export interface DemoPlan {
  lanes: { id: string; fmt: string; sourcetypes: string[] }[];
  /** Sources the OCSF replay datagen carries. */
  replaySourcetypes: string[];
  packs: DemoPlanPack[];
  ppPacks: DemoPlanPpPack[];
  /** Per source, in source order; the terminator is not included. */
  routes: DemoPlannedRoute[];
  terminatorFilter: string;
}

/**
 * Turn the Flow screen + routing grid into the exact Cribl objects to create.
 *
 * - A source's main pack holds every format that has an enabled cell, plus OCSF
 *   whenever one of its post-processing cells is on (they read its output).
 * - A lane exists only for formats some route actually reads; a source sits in a
 *   lane only when its route there is on (no ingest for data nobody routes).
 * - Post-processing without OCSF on the Flow screen yields nothing — ppOutputsToBuild.
 */
export function planDemoFlow(args: {
  sources: string[]; destFormats: string[]; pp: FlowPpState; cells: DemoCell[];
}): DemoPlan {
  const targets = demoTargets(args.destFormats, args.pp);
  const on = (st: string, key: string) => args.cells.some(c => c.sourcetype === st && c.target === key && c.enabled);
  const cell = (st: string, key: string) => args.cells.find(c => c.sourcetype === st && c.target === key);
  const laneMembers = new Map<string, string[]>();
  const join = (fmt: string, st: string) => {
    const list = laneMembers.get(fmt) ?? [];
    if (!list.includes(st)) list.push(st);
    laneMembers.set(fmt, list);
  };
  const packs: DemoPlanPack[] = [];
  const ppPacks: DemoPlanPpPack[] = [];
  const routes: DemoPlannedRoute[] = [];
  const replaySourcetypes: string[] = [];

  for (const st of args.sources) {
    const mainOn = targets.filter(t => t.kind === 'main' && on(st, t.key));
    const ppOn = targets.filter(t => t.kind === 'pp' && on(st, t.key));
    const fmts = mainOn.map(t => t.fmt);
    if (ppOn.length && !fmts.includes('ocsf')) fmts.push('ocsf');
    if (!fmts.length) continue;
    fmts.sort((a, b) => (a === 'ocsf' ? 1 : 0) - (b === 'ocsf' ? 1 : 0));
    const packId = demoMainPackId(st);
    packs.push({ sourcetype: st, packId, pipelines: fmts.map(fmt => ({ fmt, pipelineId: demoPipelineId(st, fmt), routeFilter: demoLaneFilter(fmt) })) });

    for (const t of mainOn) {
      join(t.fmt, st);
      routes.push({
        id: `demo_${idPart(st)}_${idPart(t.fmt)}`, name: `[DEMO] ${st} to ${t.label}`,
        filter: `${demoLaneFilter(t.fmt)} && sourcetype=='${st}'`, pipeline: `pack:${packId}`,
        output: cell(st, t.key)?.output || 'devnull', sourcetype: st, target: t.key, kind: 'main',
      });
    }
    if (!ppOn.length) continue;
    replaySourcetypes.push(st);
    for (const t of ppOn) {
      const ppPackId = demoPpPackId(st, t.fmt);
      ppPacks.push({ sourcetype: st, packId: ppPackId, target: t.key, output: t.pp! });
      routes.push({
        id: `demo_${idPart(st)}_${idPart(t.fmt)}_post`, name: `[DEMO] ${st} ${t.label}`,
        filter: `${DEMO_FEED_FILTER} && sourcetype=='${st}'`, pipeline: `pack:${ppPackId}`,
        output: cell(st, t.key)?.output || 'devnull', sourcetype: st, target: t.key, kind: 'pp',
      });
    }
  }

  const lanes = [...laneMembers.entries()].map(([fmt, sourcetypes]) => ({ id: demoLaneId(fmt), fmt, sourcetypes }));
  return { lanes, replaySourcetypes, packs, ppPacks, routes, terminatorFilter: DEMO_TERMINATOR_FILTER };
}

/** Lanes × sources × rate: what the demo ingests, shown before anything is built. */
export function demoEventsPerSecond(plan: DemoPlan, eps = DEMO_EVENTS_PER_SEC): number {
  const lanes = plan.lanes.reduce((n, l) => n + l.sourcetypes.length, 0);
  return (lanes + plan.replaySourcetypes.length) * eps;
}

export * from './demo-flow-ids';

/**
 * The line a failed row shows on the "Demo Environment Live" summary. The build
 * records why on the row; without this the summary said only "Failed" and the
 * reason was gone once the deploy log scrolled away.
 */
export function demoFailureReason(r: { status: string; message?: string }): string | null {
  if (r.status !== 'error') return null;
  return r.message?.trim() || 'Failed with no recorded reason — see the deploy log.';
}
