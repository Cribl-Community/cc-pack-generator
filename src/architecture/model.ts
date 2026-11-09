/**
 * The Architecture board's drawing: parts, containers and lines, and the rules that add the
 * parts a part needs to work (ARCHITECTURE-TODO "Parts that come along automatically").
 *
 * Pure: no DOM, no storage. The canvas (ArchitectureBoard.tsx) mutates an `Arch` and draws
 * it with render.ts; every rule speaks through `say()` so the board can show what it did.
 * Saved as `ArchDoc` (toDoc / fromDoc), one per prospect, next to the whiteboard.
 */

export type PartType =
  | 'leader' | 'lb' | 'user' | 'git'
  | 'wg' | 'worker' | 'fleet' | 'edgenode'
  | 'srcpanel' | 'src' | 'dstpanel' | 'dst' | 'tool' | 'datalake'
  | 'criblsearch' | 'engine' | 'cribllake' | 'cribldetect'
  | 'zone';
export type EdgeKind = 'control' | 'data' | 'optional';
export type CompanionRole = 'user' | 'git' | 'uilb' | 'nlb';

export interface ArchNode {
  id: string;
  type: PartType;
  x: number;
  y: number;
  order: number;
  label?: string;
  sub?: string;
  /** leader: Cribl Cloud or customer-managed; ha only when customer-managed */
  where?: 'cloud' | 'self';
  ha?: boolean;
  /** worker group / fleet: the dashed "scales out" placeholder */
  ghost?: boolean;
  /** a source or destination the SE typed */
  own?: boolean;
  eng?: 'lakehouse' | 'federated';
  /** zones only */
  w?: number;
  h?: number;
  parent?: string;
  /** added by a rule for this leader; moves and goes with it */
  autoFor?: string;
  role?: CompanionRole;
}

export interface Pt { x: number; y: number }

export interface ArchEdge {
  id: string;
  from: string | null;
  to: string | null;
  kind: EdgeKind;
  label?: string;
  sub?: string;
  /** the moved corner (y of the middle segment for top-to-bottom lines, x for sideways) */
  mid?: number;
  /** the sides it leaves and enters by, when the SE picked them; else they face each other */
  fromSide?: Side;
  toSide?: Side;
  /** drawn by hand with its own corners; stays where it was drawn */
  free?: boolean;
  pts?: Pt[];
}

export interface ArchDoc {
  v: 1;
  nodes: ArchNode[];
  edges: ArchEdge[];
  uid: number;
}

export interface Box {
  x: number; y: number; w: number; h: number; cx: number; cy: number;
  /** a group's title tile (or a tool's badge) sticks out above the box by this much */
  top?: number;
  /** half the width of that tile: a line into the top must land on it, not beside it */
  reach?: number;
  /** a caption under the part (a leader's name): in the box for clearance, but lines attach above it */
  foot?: number;
}

export const ARCH_DOC_VERSION = 1;

/** A destination oval plus the name under it, and the gap before the next one. */
export const DST_ROW = 100;

/** What each container holds, and the container each child needs. */
export const CONTAINER: Partial<Record<PartType, PartType>> = { wg: 'worker', fleet: 'edgenode', srcpanel: 'src', dstpanel: 'dst', criblsearch: 'engine' };
export const PANEL_FOR: Partial<Record<PartType, PartType>> = { worker: 'wg', edgenode: 'fleet', src: 'srcpanel', engine: 'criblsearch' };

export const KIND: Record<PartType, string> = {
  engine: 'Search engine', dst: 'Destination', dstpanel: 'Destinations panel', cribldetect: 'Cribl Detect', leader: 'Leader',
  wg: 'Worker group', fleet: 'Edge fleet', worker: 'Worker node', edgenode: 'Edge node', srcpanel: 'Sources panel', src: 'Source',
  lb: 'Load balancer', user: 'User', git: 'Git repo', tool: 'Analytic tool', datalake: 'Data lake', cribllake: 'Cribl Lake',
  criblsearch: 'Cribl Search', zone: 'Zone',
};

/** The palette, by group: [part, label]. `part` is `type` or `type:arg`. */
export const PARTS: [string, [string, string][]][] = [
  ['Control plane', [['leader', 'Leader'], ['lb', 'Load balancer'], ['user', 'User'], ['git', 'Git repo']]],
  ['Stream', [['wg', 'Worker group'], ['worker', 'Worker node']]],
  ['Edge', [['fleet', 'Edge fleet'], ['edgenode', 'Edge node']]],
  ['Sources', [['srcpanel', 'Sources panel']]],
  ['Cribl Cloud services', [['criblsearch', 'Cribl Search'], ['engine:lakehouse', 'Lakehouse engine'], ['cribllake', 'Cribl Lake'], ['cribldetect', 'Cribl Detect']]],
  ['Destinations', [['dst', 'Destination'], ['tool', 'Analytic tool'], ['datalake', 'Data lake']]],
  ['Zones', [['zone:Cribl Cloud', 'Cribl Cloud'], ['zone:On-prem data centre', 'On-prem site'], ['zone:Cloud region', 'Cloud region']]],
];

/**
 * The port a line can name, when that traffic has one Cribl default
 * (docs.cribl.io/stream/ports/ and the Cribl.Cloud ports diagram).
 * A vendor product or a pull source has no single listen port, so its line stays blank.
 * 9100 is node_exporter / Prometheus, not a Cribl listen port.
 */
export const KNOWN_PORTS: Record<string, string> = {
  Syslog: 'TCP/9514',
  'Splunk UF': 'TCP/9997',
  Splunk: 'TCP/9997',
  'Elastic Agents (Beats)': 'TCP/5044',
  Elastic: 'TCP/9200',
  OpenTelemetry: 'TCP/4317',
  'HTTP / Splunk HEC': 'TCP/8088',
  'Cribl TCP': 'TCP/10300',
  'Cribl HTTP': 'TCP/10200',
  'Cribl Edge': 'TCP/10300',
  Kafka: 'TCP/9092',
  'Microsoft Sentinel': 'HTTPS/443',
  'Google SecOps': 'HTTPS/443',
  Datadog: 'HTTPS/443',
  Snowflake: 'HTTPS/443',
  'Amazon S3': 'HTTPS/443',
  'Azure Blob Storage': 'HTTPS/443',
  'Object storage': 'HTTPS/443',
  Prometheus: 'TCP/9100',
  'Node exporter': 'TCP/9100',
};

/** What "+ Add a source / destination" offers; anything else typed is the SE's own. */
export const OPTIONS: Record<'src' | 'dst', string[]> = {
  src: ['Syslog', 'Splunk UF', 'Elastic Agents (Beats)', 'OpenTelemetry', 'HTTP / Splunk HEC', 'Kafka', 'AWS logs in S3', 'Cribl Edge', 'Windows events', 'Palo Alto', 'Cisco', 'Zscaler', 'CrowdStrike', 'Okta', 'Microsoft 365', 'Azure Event Hubs', 'Push sources', 'Pull sources'],
  dst: ['Splunk', 'Elastic', 'Microsoft Sentinel', 'Google SecOps', 'Datadog', 'Snowflake', 'Databricks', 'Amazon S3', 'Azure Blob Storage', 'Other data lakes', 'SIEM', 'Monitoring', 'Observability'],
};

const DEFAULTS: Record<PartType, (arg?: string) => Partial<ArchNode>> = {
  leader: () => ({ label: 'Leader', sub: 'Cribl Cloud', where: 'cloud', ha: false }),
  wg: () => ({ label: 'Worker group', ghost: true }),
  fleet: () => ({ label: 'Edge fleet', ghost: true }),
  worker: () => ({}),
  edgenode: () => ({}),
  srcpanel: () => ({ label: 'Sources' }),
  src: l => (l === '*' ? { label: 'Your own source', own: true } : { label: l || 'Source' }),
  dst: l => (l === '*' ? { label: 'Your own destination', own: true } : { label: l || 'Destination' }),
  dstpanel: () => ({ label: 'Destinations' }),
  lb: () => ({ label: 'Load balancer' }),
  user: () => ({ label: 'User' }),
  git: () => ({ label: 'External git repo' }),
  tool: () => ({ label: 'Analytic tool', sub: 'Splunk, Elastic, etc' }),
  datalake: () => ({ label: 'AWS S3', sub: 'Data lake' }),
  cribllake: () => ({ label: 'Lake', sub: '' }),
  criblsearch: () => ({ label: 'Search', sub: '' }),
  engine: l => (l === 'federated'
    ? { label: 'Federated engine', sub: 'Reads Lake, S3 and Blob in place', eng: 'federated' }
    : { label: 'Lakehouse engine', sub: 'Storage and compute', eng: 'lakehouse' }),
  cribldetect: () => ({ label: 'Detect', sub: '' }),
  zone: l => ({ label: l || 'Zone', w: 520, h: 300 }),
};

const PART_TYPES = new Set(Object.keys(DEFAULTS));
export const snap10 = (v: number) => Math.round(v / 10) * 10;
export const listing = (a: string[]) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const isGroup = (n?: ArchNode | null) => n?.type === 'wg' || n?.type === 'fleet';

export class Arch {
  nodes: ArchNode[] = [];
  edges: ArchEdge[] = [];
  uid = 1;
  /** What the rules did, for the board's message; read and cleared by the caller. */
  notes: string[] = [];

  say(msg: string) { this.notes.push(msg); }
  takeNotes(): string[] { const n = this.notes; this.notes = []; return n; }
  nextId(p: string) { return `${p}${this.uid++}`; }

  // --- persistence ------------------------------------------------------------

  toDoc(): ArchDoc {
    return { v: 1, nodes: JSON.parse(JSON.stringify(this.nodes)), edges: JSON.parse(JSON.stringify(this.edges)), uid: this.uid };
  }

  static fromDoc(doc: unknown): Arch {
    const a = new Arch();
    if (!doc || typeof doc !== 'object') return a;
    const d = doc as Partial<ArchDoc>;
    const nodes = Array.isArray(d.nodes) ? d.nodes.filter(n => n && typeof n.id === 'string' && PART_TYPES.has(n.type) && Number.isFinite(n.x) && Number.isFinite(n.y)) : [];
    const ids = new Set(nodes.map(n => n.id));
    // a child whose container is gone, or an edge to a part that is gone, is dropped
    a.nodes = JSON.parse(JSON.stringify(nodes.filter(n => !n.parent || ids.has(n.parent))));
    const kept = new Set(a.nodes.map(n => n.id));
    a.edges = JSON.parse(JSON.stringify((Array.isArray(d.edges) ? d.edges : []).filter(e => e && typeof e.id === 'string'
      && (e.free ? Array.isArray(e.pts) && e.pts.length >= 2 : !!e.from && !!e.to && kept.has(e.from) && kept.has(e.to)))));
    const maxId = [...a.nodes, ...a.edges].reduce((m, x) => Math.max(m, Number(String(x.id).replace(/^\D+/, '')) || 0), 0);
    a.uid = Math.max(Number(d.uid) || 1, maxId + 1);
    a.releaseDestinations();
    return a;
  }

  /**
   * A saved drawing may still hold destinations inside a destinations panel. Each one becomes
   * its own oval, and every line that met the panel meets each of them. The panel goes.
   */
  releaseDestinations() {
    for (const p of this.nodes.filter(n => n.type === 'dstpanel')) {
      const kids = this.kidsOf(p.id);
      for (const k of kids) {
        const at = this.pos(k);
        k.x = at.x; k.y = at.y;
        delete k.parent;
      }
      const touching = this.edges.filter(e => e.from === p.id || e.to === p.id);
      for (const e of touching) {
        if (!kids.length) continue;
        const fromPanel = e.from === p.id, toPanel = e.to === p.id;
        const retarget = (id: string) => { if (fromPanel) e.from = id; if (toPanel) e.to = id; };
        retarget(kids[0].id);
        for (const k of kids.slice(1)) {
          if (e.free) break;
          this.edges.push({ ...e, id: this.nextId('e'), from: fromPanel ? k.id : e.from, to: toPanel ? k.id : e.to, mid: undefined });
        }
      }
      if (!kids.length) this.edges = this.edges.filter(e => e.from !== p.id && e.to !== p.id);
      this.nodes = this.nodes.filter(n => n.id !== p.id);
    }
  }

  clear() { this.nodes = []; this.edges = []; this.uid = 1; }

  // --- parts ------------------------------------------------------------------

  byId(i: string | null | undefined): ArchNode | undefined { return i ? this.nodes.find(n => n.id === i) : undefined; }
  kidsOf(pid: string): ArchNode[] { return this.nodes.filter(n => n.parent === pid).sort((a, b) => a.order - b.order); }

  make(part: string, x: number, y: number, extra: Partial<ArchNode> = {}): ArchNode {
    const [type, arg] = part.split(':') as [PartType, string | undefined];
    const n: ArchNode = { id: this.nextId(type[0]), type, x, y, order: this.uid, ...DEFAULTS[type](arg), ...extra };
    this.nodes.push(n);
    return n;
  }

  addKids(parent: ArchNode, part: string, count: number) {
    for (let i = 0; i < count; i++) this.make(part, 0, 0, { parent: parent.id, order: i });
  }

  /** Every part this one takes with it: its children and its companions (and theirs). */
  removeNode(id: string) {
    const gone = new Set<string>();
    const walk = (i: string) => {
      if (gone.has(i)) return;
      gone.add(i);
      this.nodes.filter(n => n.parent === i || n.autoFor === i).forEach(n => walk(n.id));
    };
    walk(id);
    this.nodes = this.nodes.filter(n => !gone.has(n.id));
    this.edges = this.edges.filter(e => !(e.from && gone.has(e.from)) && !(e.to && gone.has(e.to)));
  }

  removeEdge(id: string) { this.edges = this.edges.filter(e => e.id !== id); }

  // --- geometry ---------------------------------------------------------------

  size(n: ArchNode): { w: number; h: number } {
    switch (n.type) {
      case 'leader': return n.ha ? { w: 150, h: 230 } : { w: 112, h: 92 };
      case 'wg': case 'fleet': { const k = this.kidsOf(n.id).length + (n.ghost ? 1 : 0); return { w: Math.max(250, k * 80 + 36), h: 150 }; }
      case 'worker': case 'edgenode': return { w: 68, h: 58 };
      case 'srcpanel': return { w: 236, h: 58 + this.kidsOf(n.id).length * 50 + 56 };
      case 'dstpanel': return { w: 140, h: 4 + this.kidsOf(n.id).length * DST_ROW + 44 };
      case 'src': return { w: 210, h: 42 };
      case 'dst': return { w: 120, h: 44 };
      case 'lb': return { w: 120, h: 76 };
      case 'user': return { w: 80, h: 70 };
      case 'git': return { w: 130, h: 82 };
      case 'tool': return { w: 172, h: 80 };
      case 'datalake': return { w: 120, h: 44 };
      case 'cribllake': case 'cribldetect': return { w: 200, h: 80 };
      case 'criblsearch': return { w: 250, h: 84 + this.kidsOf(n.id).length * 60 + 50 };
      case 'engine': return { w: 226, h: 50 };
      case 'zone': return { w: n.w || 520, h: n.h || 300 };
    }
  }

  /** Absolute position: children are laid out by their container. */
  pos(n: ArchNode): Pt {
    const p = this.byId(n.parent);
    if (!p) return { x: n.x, y: n.y };
    const pp = this.pos(p), ps = this.size(p), kids = this.kidsOf(p.id), i = kids.indexOf(n);
    if (p.type === 'srcpanel') return { x: pp.x + 13, y: pp.y + 52 + i * 50 };
    if (p.type === 'dstpanel') return { x: pp.x + (ps.w - 120) / 2, y: pp.y + 4 + i * DST_ROW };
    if (p.type === 'criblsearch') return { x: pp.x + 12, y: pp.y + 80 + i * 60 };
    const count = kids.length + (p.ghost ? 1 : 0);
    const start = pp.x + (ps.w - count * 80 + 12) / 2;
    return { x: start + i * 80, y: pp.y + 76 };
  }

  box(n: ArchNode): Box {
    const p = this.pos(n), s = this.size(n);
    return { x: p.x, y: p.y, w: s.w, h: s.h, cx: p.x + s.w / 2, cy: p.y + s.h / 2 };
  }

  /** The box lines attach to: a group's title tile sits above it, a leader's caption below. */
  ebox(n: ArchNode): Box {
    const b = this.box(n);
    if (isGroup(n)) { b.top = 26; b.reach = 50; }
    // the leader's name and second line sit under it, HA or not: lines attach to the tile, above them
    if (n.type === 'leader') { const foot = n.sub ? 40 : 22; b.h += foot; b.foot = foot; }
    // a destination is the oval; its name sits under it, so a line meets the oval.
    // an analytic tool keeps its name inside the card, so the line meets the card
    if (n.type === 'datalake') { const foot = n.sub ? 72 : 52; b.h += foot; b.foot = foot; }
    if (n.type === 'dst') { const foot = n.sub ? 40 : 28; b.h += foot; b.foot = foot; }
    return b;
  }

  /** Everything drawn, with room for captions: for fit and export. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (!this.nodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      const b = this.box(n);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y - 40); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h + 44);
    }
    for (const e of this.edges) for (const p of e.free ? e.pts || [] : []) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1 };
  }

  /** The container of `accepts` children under a point (a group's title tile counts). */
  containerAt(pt: Pt, accepts: PartType): ArchNode | undefined {
    return this.nodes.filter(n => !n.parent && CONTAINER[n.type] === accepts).find(n => {
      const b = this.box(n);
      return pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y - 26 && pt.y <= b.y + b.h;
    });
  }

  overlaps(a: ArchNode, b: ArchNode): boolean {
    const A = this.ebox(a), B = this.ebox(b);
    const at = A.y - (A.top || 0), bt = B.y - (B.top || 0);
    return A.x < B.x + B.w + 20 && B.x < A.x + A.w + 20 && at < B.y + B.h + 30 && bt < A.y + A.h + 30;
  }

  /** A dropped part slides down until it no longer covers another part (zones excepted). */
  nudgeFree(n: ArchNode) {
    for (let i = 0; i < 80 && this.nodes.some(m => m !== n && !m.parent && m.type !== 'zone' && m.autoFor !== n.id && this.overlaps(n, m)); i++) n.y += 20;
  }

  /** Snap every free-standing part to a 40 px grid. */
  tidy() {
    const moved = new Map<string, Pt>();
    this.nodes.filter(n => !n.parent).forEach(n => { moved.set(n.id, { x: n.x, y: n.y }); n.x = Math.round(n.x / 40) * 40; n.y = Math.round(n.y / 40) * 40; });
    return moved.size;
  }

  // --- connections ------------------------------------------------------------

  connect(from: ArchNode | undefined | null, to: ArchNode | undefined | null, kind: EdgeKind, extra: Partial<ArchEdge> = {}): ArchEdge | undefined {
    if (!from || !to || from.id === to.id) return undefined;
    const have = this.edges.find(e => !e.free && e.from === from.id && e.to === to.id);
    if (have) return have;
    const e: ArchEdge = { id: this.nextId('e'), from: from.id, to: to.id, kind, ...extra };
    this.edges.push(e);
    return e;
  }

  /**
   * The port written on a line when this traffic has one: `TCP/4200` between the leader
   * (or its network load balancer) and a worker group or Edge fleet, a source or
   * destination's default port, and the port under a label such as Cribl TCP.
   * Undefined when the port is not known.
   */
  trafficPort(e: ArchEdge): string | undefined {
    const from = this.byId(e.from), to = this.byId(e.to);
    if (e.kind === 'control') {
      const control = (n?: ArchNode) => !!n && (n.type === 'leader' || n.role === 'nlb');
      const group = (n?: ArchNode) => n?.type === 'wg' || n?.type === 'fleet';
      if ((control(from) && group(to)) || (control(to) && group(from))) return 'TCP/4200';
      if ((from?.type === 'leader' && to?.role === 'nlb') || (to?.type === 'leader' && from?.role === 'nlb')) return 'TCP/4200';
    }
    const git = (n?: ArchNode) => n?.type === 'git' || n?.role === 'git';
    const leader = from?.type === 'leader' ? from : to?.type === 'leader' ? to : undefined;
    if (leader && ((git(from) && leader === to) || (git(to) && leader === from)) && leader.where !== 'self') return 'HTTPS/443';
    if (e.label && KNOWN_PORTS[e.label]) return KNOWN_PORTS[e.label];
    const named = [from, to].find(n => n && (n.type === 'dst' || n.type === 'datalake') && KNOWN_PORTS[n.label || '']);
    if (named && (e.kind === 'data' || e.kind === 'optional')) return KNOWN_PORTS[named.label || ''];
    const panel = from?.type === 'srcpanel' || from?.type === 'dstpanel' ? from
      : to?.type === 'srcpanel' || to?.type === 'dstpanel' ? to : undefined;
    if (panel && (e.kind === 'data' || e.kind === 'optional')) {
      const ports = [...new Set(this.kidsOf(panel.id).map(k => KNOWN_PORTS[k.label || '']).filter((p): p is string => !!p))];
      if (ports.length) return ports.join(' · ');
    }
    return undefined;
  }

  /** Control when a leader is involved; optional for a group's second analytic destination; data otherwise. */
  inferKind(a: ArchNode, b: ArchNode): EdgeKind {
    if (a.type === 'leader' || b.type === 'leader' || (a.role === 'nlb' && isGroup(b))) return 'control';
    const out = (t?: PartType) => t === 'tool' || t === 'datalake' || t === 'dst';
    if (out(b.type) && a.type === 'wg' && this.edges.some(e => e.from === a.id && out(this.byId(e.to)?.type))) return 'optional';
    return 'data';
  }

  nearest(n: ArchNode, types: PartType[]): ArchNode | undefined {
    const b = this.box(n);
    let best: ArchNode | undefined, bd = Infinity;
    this.nodes.filter(m => !m.parent && types.includes(m.type) && m.id !== n.id).forEach(m => {
      const c = this.box(m), d = Math.hypot(c.cx - b.cx, c.cy - b.cy);
      if (d < bd) { bd = d; best = m; }
    });
    return best;
  }

  engines(kind: 'lakehouse' | 'federated') { return this.nodes.filter(k => k.type === 'engine' && k.eng === kind); }

  /** A new Cribl Search always has its workspace's federated engine. */
  newSearch(x: number, y: number): ArchNode {
    const se = this.make('criblsearch', x, y);
    this.make('engine:federated', 0, 0, { parent: se.id, order: 0 });
    return se;
  }

  addLakehouse(se: ArchNode, sub?: string): ArchNode {
    const le = this.make('engine:lakehouse', 0, 0, { parent: se.id, order: this.uid + 1000, ...(sub ? { sub } : {}) });
    this.autoConnect(le);
    return le;
  }

  /** The lines a part gets when it lands. */
  autoConnect(n: ArchNode) {
    if (isGroup(n)) {
      const lead = this.nodes.find(m => m.role === 'nlb') || this.nearest(n, ['leader']);
      if (lead) this.connect(lead, n, 'control');
    }
    if (n.type === 'srcpanel') { const wg = this.nearest(n, ['wg']); if (wg) this.connect(n, wg, 'data'); }
    if (n.type === 'tool' || n.type === 'datalake' || n.type === 'dst') { const wg = this.nearest(n, ['wg']); if (wg) this.connect(wg, n, this.inferKind(wg, n)); }
    // Cribl Lake: Stream writes to it and can replay from it; Search's federated engine reads it in place.
    if (n.type === 'cribllake') {
      const wg = this.nearest(n, ['wg']);
      if (wg) { this.connect(wg, n, 'data'); this.connect(n, wg, 'optional', { label: 'Replay' }); }
      const fe = this.engines('federated')[0];
      if (fe) this.connect(fe, n, 'data', { label: 'Federated search' });
    }
    // Cribl Search: its federated engine reads Lake in place; results can go back to Stream.
    if (n.type === 'criblsearch') {
      const fe = this.kidsOf(n.id).find(k => k.eng === 'federated'), lk = this.nearest(n, ['cribllake']);
      if (fe && lk) this.connect(fe, lk, 'data', { label: 'Federated search' });
      const wg = this.nearest(n, ['wg']);
      if (wg) this.connect(n, wg, 'optional', { label: 'Search and send' });
    }
    const parent = this.byId(n.parent);
    // A lakehouse engine: Stream sends it the data it stores and searches.
    if (n.type === 'engine' && n.eng === 'lakehouse' && parent) { const wg = this.nearest(parent, ['wg']); if (wg) this.connect(wg, n, 'data', { label: 'Ingest' }); }
    if (n.type === 'engine' && n.eng === 'federated' && parent) { const lk = this.nearest(parent, ['cribllake']); if (lk) this.connect(n, lk, 'data', { label: 'Federated search' }); }
    // Cribl Detect: runs on a lakehouse engine for security data, alerts to the SOC's tools.
    if (n.type === 'cribldetect') {
      const le = this.engines('lakehouse').find(k => /secur/i.test(k.sub || '')) || this.engines('lakehouse')[0];
      if (le) this.connect(n, le, 'data', { label: 'Detections' });
      const out = this.nearest(n, ['dst', 'tool', 'datalake']);
      if (out) this.connect(n, out, 'optional', { label: 'Alerts' });
    }
  }

  // --- the parts a leader needs -----------------------------------------------

  companion(L: ArchNode, role: CompanionRole) { return this.nodes.find(n => n.autoFor === L.id && n.role === role); }

  /**
   * Cribl Cloud: the user (HTTPS/443) and the external git repo. Customer-managed: the user
   * (HTTP/9000), no git. With HA: a UI load balancer in front of the user and a network load
   * balancer the groups' control lines move to. Parts the SE placed are never removed.
   */
  ensureCompanions(L: ArchNode, quiet = false, relayout = false) {
    if (L.where !== 'self') { L.where = 'cloud'; L.ha = false; }
    const want = new Set<CompanionRole>(L.where === 'cloud' ? ['user', 'git'] : L.ha ? ['user', 'uilb', 'nlb'] : ['user']);
    const removed: string[] = [];
    this.nodes.filter(n => n.autoFor === L.id && n.role && !want.has(n.role)).forEach(n => {
      // the groups' control lines go back to the leader when its network load balancer goes
      if (n.role === 'nlb') this.edges.filter(e => e.from === n.id && isGroup(this.byId(e.to))).forEach(e => { e.from = L.id; });
      this.edges = this.edges.filter(e => e.from !== n.id && e.to !== n.id);
      this.nodes = this.nodes.filter(x => x.id !== n.id);
      removed.push(n.label || KIND[n.type]);
    });
    const b = this.box(L), ry = b.y + 10, added: string[] = [], fresh = new Set<string>();
    const at = (n: ArchNode, x: number, y: number) => { if (relayout || fresh.has(n.id)) { n.x = snap10(x); n.y = snap10(y); } return n; };
    const get = (role: CompanionRole, part: string, label: string) => {
      let n = this.companion(L, role);
      if (!n) { n = this.make(part, 0, 0, { autoFor: L.id, role, label }); fresh.add(n.id); added.push(label); }
      return n;
    };
    const u = get('user', 'user', 'User');
    if (want.has('uilb')) {
      const lb = at(get('uilb', 'lb', 'Load balancer'), b.x + b.w + 110, ry);
      at(u, b.x + b.w + 290, ry);
      this.edges = this.edges.filter(e => !(e.from === L.id && e.to === u.id));
      this.connect(L, lb, 'control', { label: 'UI/API', sub: 'HTTP/9000' });
      this.connect(lb, u, 'control');
    } else {
      at(u, b.x + b.w + 200, ry);
      // the UI load balancer is gone: the user is straight behind the leader again
      const e = this.connect(L, u, 'control', { label: 'UI/API' })!;
      e.sub = L.where === 'cloud' ? 'HTTPS/443' : 'HTTP/9000';
    }
    if (want.has('git')) this.connect(at(get('git', 'git', 'External git repo'), b.x - 260, ry), L, 'control', { label: 'Git remote' });
    if (want.has('nlb')) {
      const n = at(get('nlb', 'lb', 'Network load balancer'), b.cx - 60, b.y + b.h + 90);
      this.connect(L, n, 'control');
      this.edges.filter(e => e.from === L.id && isGroup(this.byId(e.to))).forEach(e => { e.from = n.id; });
    }
    this.makeRoomBelow(L);
    if (quiet) return;
    const why = L.where === 'cloud' ? 'a Cribl Cloud leader' : L.ha ? 'a leader in high availability' : 'a customer-managed leader';
    if (added.length) this.say(`Added the ${listing(added).toLowerCase()} that ${why} needs.`);
    else if (removed.length) this.say(`Removed the ${listing(removed).toLowerCase()}: not needed for ${why}.`);
  }

  /**
   * A leader that grew (HA) or got a network load balancer under it must not cover the parts
   * below: everything below it moves down, together, until it is clear.
   */
  makeRoomBelow(L: ArchNode) {
    const mine = [L, ...this.nodes.filter(n => n.autoFor === L.id)];
    const ids = new Set(mine.map(n => n.id));
    const boxes = mine.map(n => this.ebox(n));
    const x0 = Math.min(...boxes.map(b => b.x)), x1 = Math.max(...boxes.map(b => b.x + b.w));
    // captions under the HA leader and the load balancers
    const bottom = Math.max(...boxes.map(b => b.y + b.h)) + 44;
    const below = this.nodes.filter(n => !n.parent && n.type !== 'zone' && !ids.has(n.id) && n.y > L.y);
    const inTheWay = below.filter(n => { const b = this.ebox(n); return b.x < x1 + 20 && b.x + b.w > x0 - 20; });
    if (!inTheWay.length) return;
    const top = Math.min(...inTheWay.map(n => { const b = this.ebox(n); return b.y - (b.top || 0); }));
    if (top >= bottom + 20) return;
    const dy = snap10(bottom + 20 - top + 9);
    below.forEach(n => { n.y += dy; });
  }

  /** The inspector changed the leader's "Runs in" or HA. */
  setLeader(L: ArchNode, change: { where?: 'cloud' | 'self'; ha?: boolean }) {
    if (change.where) {
      L.where = change.where;
      L.sub = L.where === 'cloud' ? 'Cribl Cloud' : 'Customer-managed';
      if (L.where === 'cloud') L.ha = false;
    }
    if (change.ha != null) L.ha = L.where === 'self' && change.ha;
    this.ensureCompanions(L, false, true);
  }

  // --- dropping parts ---------------------------------------------------------

  /**
   * A part dropped at a point on the canvas: children land in the container under the point,
   * or in one made for them; groups bring a leader; Detect brings Search and a security engine.
   * Returns the part to select, and whether its panel's picker should open.
   */
  drop(part: string, pt: Pt): { select: ArchNode; pick?: boolean; name?: boolean } {
    const kind = part.split(':')[0] as PartType;
    const panel = PANEL_FOR[kind];
    if (panel) {
      let c = this.containerAt(pt, kind);
      // one Cribl Search per workspace: an engine dropped elsewhere joins it
      if (!c && kind === 'engine') {
        c = this.nodes.find(m => m.type === 'criblsearch');
        if (c) this.say('Added to Cribl Search: a workspace has one Search, with all its engines.');
      }
      if (!c) {
        c = kind === 'engine' ? this.newSearch(snap10(pt.x - 125), snap10(pt.y - 40)) : this.make(panel, snap10(pt.x - 125), snap10(pt.y - 40));
        this.nudgeFree(c);
        this.autoConnect(c);
        if (kind === 'worker' || kind === 'edgenode') this.bringLeader(c);
        this.say(kind === 'engine' ? 'Lakehouse engines are part of Cribl Search: added Search for it.'
          : kind === 'src' ? 'Sources sit in a sources panel: made one for it.'
            : `${kind === 'worker' ? 'Worker nodes live in a worker group' : 'Edge nodes live in a fleet'}: made one for it.`);
      }
      if (c.type === 'criblsearch' && !this.kidsOf(c.id).some(k => k.eng === 'federated')) this.make('engine:federated', 0, 0, { parent: c.id, order: -1 });
      const card = this.make(part, 0, 0, { parent: c.id, order: this.uid + 1000 });
      if (card.type === 'engine') this.autoConnect(card);
      return card.own ? { select: card, name: true } : { select: kind === 'engine' ? card : c };
    }
    const n = part === 'criblsearch' ? this.newSearch(0, 0) : this.make(part, 0, 0);
    const s = this.size(n);
    n.x = snap10(pt.x - s.w / 2); n.y = snap10(pt.y - s.h / 2);
    if (isGroup(n)) {
      this.addKids(n, n.type === 'wg' ? 'worker' : 'edgenode', 3);
      this.bringLeader(n);
    }
    this.nudgeFree(n);
    if (n.type === 'leader') this.ensureCompanions(n);
    if (n.type === 'cribldetect') {
      const need: string[] = [];
      let se = this.nodes.find(m => m.type === 'criblsearch');
      if (!se) { se = this.newSearch(n.x + 260, n.y); this.nudgeFree(se); need.push('Cribl Search'); this.autoConnect(se); }
      if (!this.engines('lakehouse').some(k => /secur/i.test(k.sub || ''))) { this.addLakehouse(se, 'Security data'); need.push('a lakehouse engine for security data'); }
      if (need.length) this.say(`Added ${listing(need)}: Detect runs on a lakehouse engine dedicated to security data.`);
    }
    this.autoConnect(n);
    return { select: n, pick: n.type === 'srcpanel' || n.type === 'dst' };
  }

  /** A worker group or fleet without a leader brings a Cribl Cloud one, with its user and git repo. */
  bringLeader(g: ArchNode) {
    if (this.nodes.some(m => m.type === 'leader')) return;
    const L = this.make('leader', snap10(g.x + this.size(g).w / 2 - 56), g.y - 300);
    this.ensureCompanions(L, true);
    this.connect(L, g, 'control');
    this.say(`Added a Cribl Cloud leader, with its user and git repo: every ${g.type === 'fleet' ? 'fleet' : 'worker group'} is managed by one.`);
  }

  /** A worker or Edge node dragged onto another container of its kind. */
  moveChild(n: ArchNode, to: ArchNode) {
    if (to.id === n.parent || CONTAINER[to.type] !== n.type) return false;
    n.parent = to.id;
    n.order = this.uid++ + 1000;
    this.say(`Moved to ${to.label || KIND[to.type]}`);
    return true;
  }

  setCount(g: ArchNode, delta: number) {
    const k = this.kidsOf(g.id);
    if (delta > 0) this.make(g.type === 'wg' ? 'worker' : 'edgenode', 0, 0, { parent: g.id, order: this.uid + 1000 });
    else if (k.length) this.removeNode(k[k.length - 1].id);
  }

  /** "+ Add" in a panel: a listed item, or the SE's own. */
  addToPanel(p: ArchNode, label: string): ArchNode {
    const k = p.type === 'srcpanel' ? 'src' : 'dst';
    const own = !OPTIONS[k].includes(label);
    return this.make(`${k}:${label}`, 0, 0, { parent: p.id, order: this.uid + 1000, own });
  }

  /** Name one free-standing destination from the list, or with the SE's own words. */
  nameDestination(n: ArchNode, label: string) {
    n.label = label;
    n.own = !OPTIONS.dst.includes(label);
  }

  /** What the picker still offers for a query; `typed` = offer the query as the SE's own. */
  pickerOptions(p: ArchNode, q: string): { typed: boolean; opts: string[] } {
    const qq0 = q.trim().toLowerCase();
    if (p.type === 'dst') {
      const opts = OPTIONS.dst.filter(o => o.toLowerCase().includes(qq0));
      return { typed: !!qq0 && !OPTIONS.dst.some(o => o.toLowerCase() === qq0), opts };
    }
    const k = p.type === 'srcpanel' ? 'src' : 'dst', qq = qq0;
    const have = new Set(this.kidsOf(p.id).map(c => (c.label || '').toLowerCase()));
    const opts = OPTIONS[k].filter(o => !have.has(o.toLowerCase()) && o.toLowerCase().includes(qq));
    const typed = !!qq && !OPTIONS[k].some(o => o.toLowerCase() === qq) && !have.has(qq);
    return { typed, opts };
  }

  /** Move a free-standing part, and the companions that belong to it. */
  moveTo(n: ArchNode, x: number, y: number) {
    const dx = snap10(x) - n.x, dy = snap10(y) - n.y;
    if (!dx && !dy) return;
    n.x += dx; n.y += dy;
    if (n.type === 'leader') this.nodes.filter(m => m.autoFor === n.id).forEach(m => { m.x += dx; m.y += dy; });
  }

  /** The part a click or a line lands on: a worker or Edge node stands for its group. */
  lineEnd(n: ArchNode | undefined): ArchNode | undefined {
    if (!n || n.type === 'zone') return undefined;
    return n.type === 'worker' || n.type === 'edgenode' ? this.byId(n.parent) : n;
  }

  // --- the line tool ----------------------------------------------------------

  /**
   * A hand-drawn line: part to part with no corners is a normal connection; with corners, or
   * ending on the canvas, a free line with its own points, every segment horizontal or vertical.
   */
  finishLine(fromId: string | null, drawn: Pt[], end: ArchNode | undefined): ArchEdge | undefined {
    const from = this.byId(fromId);
    if (from && end && drawn.length === 1 && from.id !== end.id) return this.connect(from, end, this.inferKind(from, end));
    const pts = drawn.map(p => ({ ...p }));
    if (end) {
      const B = this.ebox(end), last = pts[pts.length - 1];
      if (last.x !== B.cx && last.y !== B.cy) pts.push({ x: B.cx, y: last.y });
      pts.push({ x: B.cx, y: B.cy });
    }
    for (let i = pts.length - 1; i > 0; i--) if (pts[i].x === pts[i - 1].x && pts[i].y === pts[i - 1].y) pts.splice(i, 1);
    if (pts.length < 2) return undefined;
    if (from) this.clipTo(pts, 0, 1, from);
    if (end) this.clipTo(pts, pts.length - 1, pts.length - 2, end);
    const e: ArchEdge = { id: this.nextId('e'), free: true, pts, from: from?.id || null, to: end?.id || null, kind: from && end ? this.inferKind(from, end) : 'data' };
    this.edges.push(e);
    return e;
  }

  /** Move an end point from a part's centre to its border, along the first segment. */
  clipTo(pts: Pt[], i: number, j: number, n: ArchNode) {
    const B = this.ebox(n), p = pts[i], q = pts[j];
    if (p.x === q.x) p.y = q.y < p.y ? B.y - (B.top || 0) : B.y + B.h - (B.foot || 0);
    else p.x = q.x < p.x ? B.x : B.x + B.w;
  }

  // --- routing ----------------------------------------------------------------

  /** The point in the middle of one side of a part (a group's top is its title tile). */
  port(b: Box, side: Side): Pt {
    switch (side) {
      case 'top': return { x: b.cx, y: b.y - (b.top || 0) };
      case 'bottom': return { x: b.cx, y: b.y + b.h - (b.foot || 0) };
      case 'left': return { x: b.x, y: b.cy };
      case 'right': return { x: b.x + b.w, y: b.cy };
    }
  }

  /** The side of a part nearest to a point: where a line dropped there attaches. */
  nearestSide(n: ArchNode, pt: Pt): Side {
    const b = this.ebox(n), top = b.y - (b.top || 0);
    const d: [Side, number][] = [['top', Math.abs(pt.y - top)], ['bottom', Math.abs(pt.y - (b.y + b.h - (b.foot || 0)))], ['left', Math.abs(pt.x - b.x)], ['right', Math.abs(pt.x - (b.x + b.w))]];
    return d.sort((x, y) => x[1] - y[1])[0][0];
  }

  /**
   * The sides a connection uses: the ones the SE picked, else facing each other. Parts
   * clearly above or below each other connect top to bottom, like the reference
   * diagrams; side by side connect sideways.
   */
  sides(e: ArchEdge, A: Box, B: Box): [Side, Side] {
    const dx = B.cx - A.cx, dy = B.cy - A.cy;
    const gapY = dy > 0 ? B.y - (B.top || 0) - (A.y + A.h) : A.y - (A.top || 0) - (B.y + B.h);
    const auto: [Side, Side] = gapY > 24 ? (dy > 0 ? ['bottom', 'top'] : ['top', 'bottom']) : (dx < 0 ? ['left', 'right'] : ['right', 'left']);
    return [e.fromSide || auto[0], e.toSide || auto[1]];
  }

  /** The stretch of a part's side a line may attach to: a group's top is its title tile, not the whole width. */
  span(b: Box, side: Side, margin: number): [number, number] {
    if (side === 'top' && b.reach) return [b.cx - b.reach + margin, b.cx + b.reach - margin];
    return side === 'top' || side === 'bottom' ? [b.x + margin + 2, b.x + b.w - margin - 2] : [b.y + margin, b.y + b.h - (b.foot || 0) - margin];
  }

  /**
   * Where facing sides that overlap line up into one straight line, or null when they do not
   * overlap: on the source's centre when that is on both parts (so lines out of one side share
   * one trunk), else the target's, else the middle of the overlap; where that line would brush
   * another part, the nearest clear place. `off` is the spread offset, part of the position.
   */
  alignedAt(e: ArchEdge, a: ArchNode, b: ArchNode, off: number): { at: number; v: boolean } | null {
    const A = this.ebox(a), B = this.ebox(b);
    const [sa, sb] = this.sides(e, A, B);
    const vertical = (s: Side) => s === 'top' || s === 'bottom';
    if (sa === sb || vertical(sa) !== vertical(sb)) return null;
    const v = vertical(sa);
    const [la, ha] = this.span(A, sa, 0), [lb, hb] = this.span(B, sb, 0);
    const lo = Math.max(la, lb) + 8, hi = Math.min(ha, hb) - 8;
    if (hi < lo) return null;
    const ca = v ? A.cx : A.cy, cb = v ? B.cx : B.cy;
    const pref = (ca >= lo && ca <= hi ? ca : cb >= lo && cb <= hi ? cb : Math.round((lo + hi) / 2)) + off;
    const p = this.port(A, sa), q = this.port(B, sb);
    // crossings() forgives 1 px, the router does not: ask for 2 px more room than the router
    const walls = this.obstacles(new Set([a.id, b.id, a.parent || '', b.parent || ''])).map(w => ({ ...w, x: w.x - 2, y: w.y - 2, w: w.w + 4, h: w.h + 4 }));
    const line = (c: number): Pt[] => (v ? [{ x: c, y: p.y }, { x: c, y: q.y }] : [{ x: p.x, y: c }, { x: q.x, y: c }]);
    let at = Math.min(hi, Math.max(lo, pref));
    for (let d = 0; d <= hi - lo; d += 4) {
      const c = [pref - d, pref + d].find(x => x >= lo && x <= hi && !crossings(line(x), walls));
      if (c != null) { at = c; break; }
    }
    return { at, v };
  }

  /**
   * Both ends of a connection, before routing. Facing parts that overlap get one straight line
   * (`alignedAt`). A control line that cannot be straight still leaves its source on the trunk its
   * siblings use, so a leader's lines come out of it together.
   */
  ends(e: ArchEdge, a: ArchNode, b: ArchNode, offs: Record<string, [number, number]>) {
    const A = this.ebox(a), B = this.ebox(b);
    const [sa, sb] = this.sides(e, A, B);
    const p = this.port(A, sa), q = this.port(B, sb);
    let [o1, o2] = offs[e.id] || [0, 0];
    const vertical = (s: Side) => s === 'top' || s === 'bottom';
    const al = this.alignedAt(e, a, b, o1 || o2);
    if (al) {
      if (al.v) p.x = q.x = al.at; else p.y = q.y = al.at;
      o1 = o2 = 0;
    } else if (e.kind === 'control' && !offs[e.id]?.[0]) {
      for (const f of this.edges) {
        if (f === e || f.free || f.from !== e.from || f.kind !== 'control') continue;
        const fb = this.byId(f.to);
        if (!fb || this.sides(f, A, this.ebox(fb))[0] !== sa) continue;
        const fa = this.alignedAt(f, a, fb, (offs[f.id] || [0, 0])[0] || (offs[f.id] || [0, 0])[1]);
        if (fa && fa.v === vertical(sa)) {
          const [lo, hi] = this.span(A, sa, 8);
          if (fa.v) p.x = Math.min(hi, Math.max(lo, fa.at)); else p.y = Math.min(hi, Math.max(lo, fa.at));
          break;
        }
      }
    }
    if (vertical(sa)) p.x += o1; else p.y += o1;
    if (vertical(sb)) q.x += o2; else q.y += o2;
    return { p, q, sa, sb };
  }

  /**
   * Several lines meeting the same side of a part spread out, 16 px apart. Control lines
   * leave their source together instead: they share one bus, as in the reference diagrams.
   */
  spread(): Record<string, [number, number]> {
    const bucket: Record<string, [string, 0 | 1][]> = {}, offs: Record<string, [number, number]> = {};
    for (const e of this.edges) {
      if (e.free) continue;
      const a = this.byId(e.from), b = this.byId(e.to);
      if (!a || !b) continue;
      const [sa, sb] = this.sides(e, this.ebox(a), this.ebox(b));
      if (e.kind !== 'control') (bucket[`${e.from}|${sa}`] ||= []).push([e.id, 0]);
      (bucket[`${e.to}|${sb}`] ||= []).push([e.id, 1]);
    }
    const control = new Set(this.edges.filter(e => e.kind === 'control').map(e => e.id));
    for (const list of Object.values(bucket)) {
      if (list.some(([eid]) => control.has(eid))) {
        // a control line takes the middle (the source's own trunk); the others fan out around it
        const sorted = [...list].sort((x, y) => Number(control.has(y[0])) - Number(control.has(x[0])));
        sorted.forEach(([eid, end], i) => { (offs[eid] ||= [0, 0])[end] = (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 16; });
      } else {
        list.forEach(([eid, end], i) => { (offs[eid] ||= [0, 0])[end] = (i - (list.length - 1) / 2) * 16; });
      }
    }
    return offs;
  }

  /** Boxes a line must not run through, with 10 px to spare: every free-standing part. */
  obstacles(skip: Set<string>): Box[] {
    const pad = 10;
    const nodes = this.nodes.filter(n => !n.parent && n.type !== 'zone' && !skip.has(n.id));
    const boxes = nodes.map(n => {
      const b = this.ebox(n), top = b.top || 0, foot = b.foot || 0;
      return { ...b, x: b.x - pad, y: b.y - top - pad, w: b.w + 2 * pad, h: b.h - foot + top + 2 * pad };
    });
    // the name under a destination: lines leave the oval, then go around the words
    const captions = nodes.filter(n => n.type === 'datalake' || n.type === 'dst').map(n => {
      const b = this.box(n);
      const w = Math.max((n.label || '').length, (n.sub || '').length) * 7.4 + 16;
      const y = b.y + b.h + 26;
      return { x: b.cx - w / 2, y, w, h: n.sub ? 42 : 20, cx: b.cx, cy: y + 10 };
    });
    return [...boxes, ...captions];
  }

  /**
   * A connection's points: horizontal and vertical pieces only, out of one side and into the
   * other, around every other part (and its own two). A moved corner (`mid`) is the SE's
   * own route and is kept as drawn. Also its middle segment, for the grip, and its label point.
   */
  route(e: ArchEdge, offs: Record<string, [number, number]>): { pts: Pt[]; corner: (Pt & { axis: 'x' | 'y' }) | null; label: Pt } | null {
    if (e.free) {
      const pts = e.pts || [];
      return pts.length < 2 ? null : { pts, corner: null, label: labelPoint(pts) };
    }
    const a = this.byId(e.from), b = this.byId(e.to);
    if (!a || !b) return null;
    const { p, q, sa, sb } = this.ends(e, a, b, offs);
    const vertical = (s: Side) => s === 'top' || s === 'bottom';
    const axis: 'x' | 'y' | null = vertical(sa) && vertical(sb) ? 'y' : !vertical(sa) && !vertical(sb) ? 'x' : null;
    if (e.mid != null && axis) {
      const pts = simplify(axis === 'y'
        ? [p, { x: p.x, y: e.mid }, { x: q.x, y: e.mid }, q]
        : [p, { x: e.mid, y: p.y }, { x: e.mid, y: q.y }, q]);
      return { pts, corner: axis === 'y' ? { axis, x: (p.x + q.x) / 2, y: e.mid } : { axis, x: e.mid, y: (p.y + q.y) / 2 }, label: labelPoint(pts) };
    }
    // a line out of an engine leaves through its own Cribl Search: that box is not in the way
    const walls = this.obstacles(new Set([a.parent || '', b.parent || '']));
    const STUB = 20;
    const p1 = { x: p.x + NORMAL[sa].x * STUB, y: p.y + NORMAL[sa].y * STUB };
    const q1 = { x: q.x + NORMAL[sb].x * STUB, y: q.y + NORMAL[sb].y * STUB };
    const into = { x: -NORMAL[sb].x, y: -NORMAL[sb].y };
    const mid = orthoRoute(p1, q1, walls, NORMAL[sa], into);
    const pts = simplify([p, ...mid, q]);
    return { pts, corner: axis ? middleSegment(pts, axis) : null, label: labelPoint(pts) };
  }
}

export type Side = 'top' | 'bottom' | 'left' | 'right';
const NORMAL: Record<Side, Pt> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** Where a line's label goes: above the middle of its longest piece. */
function labelPoint(pts: Pt[]): Pt {
  let best = -1, bi = 1;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    if (l > best) { best = l; bi = i; }
  }
  return { x: (pts[bi - 1].x + pts[bi].x) / 2, y: (pts[bi - 1].y + pts[bi].y) / 2 - 6 };
}

/** The piece across the middle of a route that the SE can drag (horizontal for 'y', vertical for 'x'). */
function middleSegment(pts: Pt[], axis: 'x' | 'y'): (Pt & { axis: 'x' | 'y' }) | null {
  const cands: { i: number; d: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const horiz = pts[i].y === pts[i - 1].y;
    if ((axis === 'y') === horiz) cands.push({ i, d: Math.abs(i - pts.length / 2) });
  }
  if (!cands.length) return null;
  const { i } = cands.sort((x, y) => x.d - y.d)[0];
  return { axis, x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
}

/** How many obstacle boxes a polyline runs through. */
export function crossings(pts: Pt[], walls: Box[]): number {
  let n = 0;
  for (const w of walls) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (x1 > w.x + 1 && x0 < w.x + w.w - 1 && y1 > w.y + 1 && y0 < w.y + w.h - 1) { n++; break; }
    }
  }
  return n;
}

const BEND = 30;

/**
 * The shortest path of horizontal and vertical pieces from `from` to `to` that runs through
 * none of `walls`, with as few corners as it can (each costs BEND px). It searches the grid
 * of every wall edge and the channels between them (A*), first near the two ends, then over
 * everything; with no way through it goes straight across (the old behaviour) rather than fail.
 * `startDir` is the way the line leaves, `endDir` the way it must arrive.
 */
export function orthoRoute(from: Pt, to: Pt, walls: Box[], startDir: Pt, endDir: Pt): Pt[] {
  const near = (margin: number) => {
    const x0 = Math.min(from.x, to.x) - margin, x1 = Math.max(from.x, to.x) + margin;
    const y0 = Math.min(from.y, to.y) - margin, y1 = Math.max(from.y, to.y) + margin;
    return walls.filter(w => w.x < x1 && w.x + w.w > x0 && w.y < y1 && w.y + w.h > y0);
  };
  return search(from, to, near(240), startDir, endDir, 240)
    ?? search(from, to, walls, startDir, endDir, 1200)
    ?? [from, { x: from.x, y: to.y }, to];
}

function search(from: Pt, to: Pt, walls: Box[], startDir: Pt, endDir: Pt, margin: number): Pt[] | null {
  const inside = (x: number, y: number) => walls.some(w => x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h);
  const axisVals = (a: number, b: number, edges: number[]) => {
    const lo = Math.min(a, b) - margin, hi = Math.max(a, b) + margin;
    const v = [...new Set([a, b, lo, hi, ...edges.filter(x => x > lo && x < hi)])].sort((m, n) => m - n);
    const out: number[] = [];
    for (let i = 0; i < v.length; i++) { out.push(v[i]); if (i + 1 < v.length && v[i + 1] - v[i] > 20) out.push(Math.round((v[i] + v[i + 1]) / 2)); }
    return out;
  };
  const xs = axisVals(from.x, to.x, walls.flatMap(w => [w.x, w.x + w.w]));
  const ys = axisVals(from.y, to.y, walls.flatMap(w => [w.y, w.y + w.h]));
  const W = xs.length, H = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  const sx = xi.get(from.x)!, sy = yi.get(from.y)!, tx = xi.get(to.x)!, ty = yi.get(to.y)!;
  // a piece between two neighbouring grid points is blocked when its middle is inside a wall
  const blockedH = new Uint8Array(W * H), blockedV = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i + 1 < W; i++) blockedH[j * W + i] = inside((xs[i] + xs[i + 1]) / 2, ys[j]) ? 1 : 0;
  for (let j = 0; j + 1 < H; j++) for (let i = 0; i < W; i++) blockedV[j * W + i] = inside(xs[i], (ys[j] + ys[j + 1]) / 2) ? 1 : 0;
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const dirOf = (d: Pt) => DIRS.findIndex(k => k.x === d.x && k.y === d.y);
  const N = W * H * 4;
  const cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  const heap: [number, number][] = [];
  const push = (f: number, s: number) => {
    heap.push([f, s]);
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  const h = (i: number, j: number) => Math.abs(xs[i] - to.x) + Math.abs(ys[j] - to.y);
  const s0 = (sy * W + sx) * 4 + dirOf(startDir);
  cost[s0] = 0;
  push(h(sx, sy), s0);
  const endD = dirOf(endDir);
  while (heap.length) {
    const [, s] = pop();
    const d = s & 3, cell = s >> 2, i = cell % W, j = (cell - i) / W;
    if (i === tx && j === ty) {
      const pts: Pt[] = [];
      for (let k = s; k !== -1; k = prev[k]) { const c = k >> 2, ci = c % W; pts.push({ x: xs[ci], y: ys[(c - ci) / W] }); }
      return pts.reverse();
    }
    for (let nd = 0; nd < 4; nd++) {
      const D = DIRS[nd];
      if (D.x === -DIRS[d].x && D.y === -DIRS[d].y) continue;
      const ni = i + D.x, nj = j + D.y;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      if (D.y === 0 ? blockedH[j * W + Math.min(i, ni)] : blockedV[Math.min(j, nj) * W + i]) continue;
      let c = cost[s] + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === d ? 0 : BEND);
      if (ni === tx && nj === ty && nd !== endD) c += BEND;
      const ns = (nj * W + ni) * 4 + nd;
      if (c < cost[ns]) { cost[ns] = c; prev[ns] = s; push(c + h(ni, nj), ns); }
    }
  }
  return null;
}

/** Drop repeated and in-line points. */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Labels that would cover each other move down (then up) until they don't. */
export function placeLabels(items: { id: string; x: number; y: number; w: number; h: number }[]): Record<string, Pt> {
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const out: Record<string, Pt> = {};
  for (const it of items) {
    let y = it.y;
    const clash = (yy: number) => placed.some(p => Math.abs(p.x - it.x) * 2 < p.w + it.w && Math.abs(p.y - yy) * 2 < p.h + it.h);
    for (let k = 1; k <= 8 && clash(y); k++) y = it.y + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (it.h + 2);
    placed.push({ x: it.x, y, w: it.w, h: it.h });
    out[it.id] = { x: it.x, y };
  }
  return out;
}

/** Every segment of a polyline is horizontal or vertical. */
export const isOrthogonal = (pts: Pt[]) => pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);
