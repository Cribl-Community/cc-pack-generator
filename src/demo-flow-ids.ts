// Demo environment v2: the IDs, filters and sample helpers every demo object is
// named by. Dependency-free so api.ts and the standalone backend share it with
// the planner (demo-flow.ts) without pulling the pack builder into their bundle.
export const DEMO_DATAGEN_PREFIX = 'demo_datagen';
export const DEMO_OCSF_REPLAY_ID = 'demo_datagen_ocsf_pp';
/** Every demo datagen sends at this rate per source. */
export const DEMO_EVENTS_PER_SEC = 2;
/** Output placeholder for "the demo's Cribl Lake dataset", resolved at build time. */
export const DEMO_LAKE_OUTPUT = '@lake';

export const idPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const demoLaneId = (fmt: string) => `${DEMO_DATAGEN_PREFIX}_${idPart(fmt)}`;
export const demoLaneFilter = (fmt: string) => `__inputId=='datagen:${demoLaneId(fmt)}'`;
export const demoMainPackId = (sourcetype: string) => kebab(`demo ${sourcetype}`);
export const demoPpPackId = (sourcetype: string, eff: string) => kebab(`demo ${sourcetype} ocsf to ${eff} post`);
export const demoPipelineId = (sourcetype: string, fmt: string) => `${idPart(sourcetype)}_to_${idPart(fmt)}`;
/** What the post-processing packs read: the OCSF replay datagen. */
export const DEMO_FEED_FILTER = `__inputId=='datagen:${DEMO_OCSF_REPLAY_ID}'`;
/** Every demo input: what the terminator drops so demo data never reaches production routes. */
export const DEMO_TERMINATOR_FILTER = `__inputId.startsWith('datagen:${DEMO_DATAGEN_PREFIX}')`;

/**
 * One OCSF pipeline output event → one replay datagen line: the event as JSON in
 * `_raw`, which is what step 1 of every post-processing pack parses. Cribl
 * internals and `_time` stay out (datagen stamps its own); OCSF `time` (epoch
 * ms) becomes a rolling datagen timestamp so the replayed events stay current.
 */
export function ocsfReplayLine(event: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === '_raw' || k === '_time' || k.startsWith('__') || k.startsWith('cribl_')) continue;
    out[k] = v;
  }
  if (typeof out.time === 'number') out.time = '${timestamp:%s%L}';
  return JSON.stringify(out);
}

/** Datagen samples quote nothing that is a timestamp template: `"${timestamp:…}"` → `${timestamp:…}`. */
export function unquoteDatagenTimestamps(json: string): string {
  return json.replace(/"(\$\{timestamp:[^"}]*\})"/g, '$1');
}

/**
 * Which demo datagen owns a group sample. Samples are named `<datagenId>_<st>.log`
 * and lane ids prefix each other (`demo_datagen_ocsf` / `demo_datagen_ocsf_pp`),
 * so the owner is the LONGEST id that prefixes the name — never the first match.
 */
export function demoSampleOwner(sampleName: string, datagenIds: string[]): string | null {
  let owner: string | null = null;
  for (const id of datagenIds) {
    if (sampleName.startsWith(`${id}_`) && (!owner || id.length > owner.length)) owner = id;
  }
  return owner;
}

/** Demo inputs (datagens) and outputs (Lake) the scan and cleanup look for. */
export const isDemoInputId = (id: string) => id.startsWith(DEMO_DATAGEN_PREFIX);
export const isDemoOutputId = (id: string) => id.startsWith('demo_lake_');

// --- Demo namespaces (spec R16) ------------------------------------------------
//
// A whiteboard's demo lives in its own namespace so several prospects run on one
// worker group. Legacy ids (a demo made by hand) have namespace ''. Ownership is
// decidable from an id alone: idPart/kebab collapse separators, so a legacy id
// never contains `__` (routes, datagens) or `--` (packs), and a namespaced id
// always does, right after its namespace.

export const DEMO_TERMINATOR_ID = 'demo_terminator';
const NS_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** `[a-z0-9_]`, no `__`, no leading/trailing `_` — or '' (legacy). */
export function demoNsPart(ns: string): string {
  const n = idPart(ns || '');
  if (n && !NS_RE.test(n)) throw new Error(`Invalid demo namespace "${ns}"`);
  return n;
}

/** A board's namespace: its prospect (≤ 12) plus 3 characters of its id, fixed once assigned. */
export function demoNamespaceFor(prospect: string, boardId: string): string {
  const slug = idPart(prospect || '').slice(0, 12).replace(/_+$/, '') || 'board';
  let h = 0;
  for (const c of boardId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${slug}_${h.toString(36).padStart(3, '0').slice(-3)}`;
}

/** Every id and filter one demo is named by, for its namespace. */
export function demoNames(nsRaw = '') {
  const ns = demoNsPart(nsRaw);
  const laneId = (fmt: string) => (ns ? `${DEMO_DATAGEN_PREFIX}_${ns}__${idPart(fmt)}` : demoLaneId(fmt));
  const replayId = ns ? `${DEMO_DATAGEN_PREFIX}_${ns}__ocsf_pp` : DEMO_OCSF_REPLAY_ID;
  return {
    ns,
    laneId,
    laneFilter: (fmt: string) => `__inputId=='datagen:${laneId(fmt)}'`,
    replayId,
    feedFilter: `__inputId=='datagen:${replayId}'`,
    mainPackId: (st: string) => (ns ? `demo-${kebab(ns)}--${kebab(st)}` : demoMainPackId(st)),
    ppPackId: (st: string, eff: string) => (ns ? `demo-${kebab(ns)}--${kebab(`${st} ocsf to ${eff} post`)}` : demoPpPackId(st, eff)),
    routeId: (st: string, fmt: string, post = false) => `${ns ? `demo_${ns}__` : 'demo_'}${idPart(st)}_${idPart(fmt)}${post ? '_post' : ''}`,
    /** Route-table comment text, tagged so the merge knows whose it is. */
    comment: (text: string) => `${ns ? `[DEMO:${ns}]` : '[DEMO]'} ${text}`,
  };
}

/** null = not a demo route; '' = legacy; else the namespace. The terminator is shared: null. */
export function demoNsOfRoute(id: string): string | null {
  if (!id.startsWith('demo_') || id === DEMO_TERMINATOR_ID) return null;
  const m = id.match(/^demo_([a-z0-9_]+?)__/);
  return m ? m[1] : '';
}
export function demoNsOfComment(text: string): string | null {
  const m = String(text || '').match(/^\[DEMO(?::([a-z0-9_]+))?\]/);
  return m ? (m[1] ?? '') : null;
}
export function demoNsOfDatagen(id: string): string | null {
  if (!isDemoInputId(id)) return null;
  const m = id.match(/^demo_datagen_([a-z0-9_]+?)__/);
  return m ? m[1] : '';
}
export function demoNsOfPack(id: string): string | null {
  if (!id.startsWith('demo-')) return null;
  const m = id.match(/^demo-([a-z0-9-]+?)--/);
  return m ? m[1].replace(/-/g, '_') : '';
}

/** A route-table comment: the text, at a position in the COMBINED comments+routes list. */
export interface RouteTableComment { id?: string; comment: string; index: number; [k: string]: unknown }
type Row = { kind: 'route'; route: any } | { kind: 'comment'; comment: RouteTableComment };

/** Cribl keys each comment by its row in the combined list; rebuild that list. */
function tableRows(routes: any[], comments: RouteTableComment[]): Row[] {
  const total = routes.length + comments.length;
  const byIndex = [...comments].sort((a, b) => (a.index || 0) - (b.index || 0));
  const rows: Row[] = [];
  let r = 0, c = 0;
  for (let i = 0; i < total; i++) {
    if (c < byIndex.length && (byIndex[c].index || 0) <= i) rows.push({ kind: 'comment', comment: byIndex[c++] });
    else if (r < routes.length) rows.push({ kind: 'route', route: routes[r++] });
    else rows.push({ kind: 'comment', comment: byIndex[c++] });   // comments past the end stay in order
  }
  return rows;
}

function rowsToTable(rows: Row[]): { routes: any[]; comments: RouteTableComment[] } {
  const routes: any[] = [];
  const comments: RouteTableComment[] = [];
  rows.forEach((row, i) => (row.kind === 'route' ? routes.push(row.route) : comments.push({ ...row.comment, index: i })));
  return { routes, comments };
}

const rowNs = (row: Row): string | null =>
  row.kind === 'route' ? demoNsOfRoute(String(row.route?.id || '')) : demoNsOfComment(row.comment.comment);
const isTerminatorRow = (row: Row) =>
  (row.kind === 'route' && row.route?.id === DEMO_TERMINATOR_ID)
  || (row.kind === 'comment' && /^\[DEMO(?::[a-z0-9_]+)?\] Terminator\b/.test(row.comment.comment));

/**
 * Write one namespace's demo block into a worker group's route table (spec R16).
 * Result order: [this block] → [every other demo block, unchanged] → [one terminator
 * (its comment first)] → [customer routes and comments, unchanged]. Comment positions
 * are recomputed from that order, never shifted. `block.comments` index into the
 * block's own combined list (as the planner emits them); the block's terminator, if
 * any, is moved to the shared slot.
 */
export function mergeDemoRouteTable(
  table: { routes: any[]; comments: RouteTableComment[] },
  ns: string,
  block: { routes: any[]; comments: RouteTableComment[] },
): { routes: any[]; comments: RouteTableComment[] } {
  const mine = demoNsPart(ns);
  const existing = tableRows(table.routes || [], table.comments || []);
  const incoming = tableRows(block.routes || [], block.comments || []);
  const terminator = [...incoming, ...existing].filter(isTerminatorRow);
  const terminatorRows = [
    ...terminator.filter(r => r.kind === 'comment').slice(0, 1),
    ...terminator.filter(r => r.kind === 'route').slice(0, 1),
  ];
  const others: Row[] = [];
  const customer: Row[] = [];
  for (const row of existing) {
    if (isTerminatorRow(row)) continue;
    const owner = rowNs(row);
    if (owner === null) customer.push(row);
    else if (owner !== mine) others.push(row);
  }
  const blockRows = incoming.filter(r => !isTerminatorRow(r));
  const anyDemo = blockRows.some(r => r.kind === 'route') || others.some(r => r.kind === 'route');
  return rowsToTable([...blockRows, ...others, ...(anyDemo ? terminatorRows : []), ...customer]);
}

/** Which demo namespace a scanned object belongs to (null = not a demo object, or shared). */
export function demoOwnerOf(kind: 'routes' | 'datagens' | 'packs' | 'outputs', id: string): string | null {
  return kind === 'routes' ? demoNsOfRoute(id) : kind === 'datagens' ? demoNsOfDatagen(id) : kind === 'packs' ? demoNsOfPack(id) : null;
}

/**
 * The ids that remove ONE namespace's demo from a scan (spec R16). The shared terminator
 * goes only when no other namespace keeps routes; Lake outputs are never auto-selected.
 */
export function demoCleanupSelection(
  scan: { routes: { id: string }[]; datagens: { id: string }[]; packs: { id: string }[] },
  ns: string,
): { routes: string[]; datagens: string[]; packs: string[] } {
  const mine = demoNsPart(ns);
  const routes = scan.routes.filter(r => demoNsOfRoute(r.id) === mine).map(r => r.id);
  const othersRemain = scan.routes.some(r => { const o = demoNsOfRoute(r.id); return o !== null && o !== mine; });
  if (!othersRemain && scan.routes.some(r => r.id === DEMO_TERMINATOR_ID)) routes.push(DEMO_TERMINATOR_ID);
  return {
    routes,
    datagens: scan.datagens.filter(d => demoNsOfDatagen(d.id) === mine).map(d => d.id),
    packs: scan.packs.filter(p => demoNsOfPack(p.id) === mine).map(p => p.id),
  };
}

/** Every namespace present in a scan, '' (made by hand) included. */
export function demoNamespacesIn(scan: { routes: { id: string }[]; datagens: { id: string }[]; packs: { id: string }[] }): string[] {
  const out = new Set<string>();
  for (const r of scan.routes) { const o = demoNsOfRoute(r.id); if (o !== null) out.add(o); }
  for (const d of scan.datagens) { const o = demoNsOfDatagen(d.id); if (o !== null) out.add(o); }
  for (const p of scan.packs) { const o = demoNsOfPack(p.id); if (o !== null) out.add(o); }
  return [...out].sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || a.localeCompare(b));
}

