/**
 * Starting points for the Architecture board, after the reference architectures on
 * docs.cribl.io (Distributed agents, Hybrid cloud, Edge to Stream, Full suite), and
 * "this Cribl org" drawn from its groups and workers. Pure: builds into an `Arch`.
 */
import { Arch, type ArchNode } from './model';

export type TemplateKey = 'distributed' | 'hybrid' | 'edge' | 'suite' | 'empty';

export const TEMPLATE_LIST: { key: TemplateKey; title: string; hint: string; menu: string }[] = [
  { key: 'distributed', title: 'Distributed agents', hint: 'A worker group per location', menu: 'HA leader, a worker group per location' },
  { key: 'hybrid', title: 'Hybrid cloud', hint: 'Cloud and on-prem groups', menu: 'Cloud and on-prem worker groups, syslog' },
  { key: 'edge', title: 'Edge to Stream', hint: 'Fleets send to a group', menu: 'Edge fleets sending to a worker group' },
  { key: 'suite', title: 'Full suite', hint: 'With Lake, Search and Detect', menu: 'Stream, Edge, Lake, Search and Detect together' },
  { key: 'empty', title: 'Empty canvas', hint: 'Start from nothing', menu: '' },
];

function wgWith(a: Arch, label: string, x: number, y: number, n: number, extra: Partial<ArchNode> = {}) {
  const g = a.make('wg', x, y, { label, ...extra });
  a.addKids(g, 'worker', n);
  return g;
}
function panel(a: Arch, x: number, y: number, list: string[]) {
  const p = a.make('srcpanel', x, y);
  list.forEach((l, i) => a.make(`src:${l}`, 0, 0, { parent: p.id, order: i }));
  return p;
}

const TEMPLATES: Record<TemplateKey, (a: Arch) => void> = {
  distributed(a) {
    const L = a.make('leader', 600, 40, { where: 'self', ha: true, label: 'Leader', sub: 'High availability' });
    a.ensureCompanions(L, true);
    const git = a.make('git', 300, 110);
    a.connect(git, L, 'control');
    const nlb = a.companion(L, 'nlb');
    const lake = a.make('datalake', 470, 470), tool = a.make('tool', 780, 480);
    [40, 560, 1080].forEach((x, i) => {
      const g = wgWith(a, `Location ${i + 1} Worker Group`, x, 660, 3);
      a.connect(nlb, g, 'control');
      a.connect(g, lake, 'optional');
      a.connect(g, tool, 'data');
      a.connect(panel(a, x + 10, 900, ['Cribl Edge', 'Elastic Agents (Beats)', 'HTTP / Splunk HEC', 'Splunk UF']), g, 'data');
    });
  },
  hybrid(a) {
    // The cloud group's sources sit in the Cribl Cloud zone with it.
    a.make('zone:Cribl Cloud', 20, 20, { w: 1460, h: 680 });
    const L = a.make('leader', 690, 60, { label: 'Leader', sub: 'Cribl Cloud' });
    a.make('zone:On-prem data centre', 20, 740, { w: 1460, h: 560 });
    const c1 = wgWith(a, 'Cribl Cloud Worker Group', 120, 250, 3);
    const c2 = wgWith(a, 'Syslog Worker Group', 520, 900, 3);
    const c3 = wgWith(a, 'General Purpose Worker Group', 960, 900, 3);
    [c1, c2, c3].forEach(g => a.connect(L, g, 'control'));
    a.ensureCompanions(L, true);
    a.connect(panel(a, 130, 460, ['AWS logs in S3', 'Kafka']), c1, 'data');
    a.connect(panel(a, 530, 1090, ['Palo Alto', 'Cisco', 'Zscaler']), c2, 'data');
    a.connect(panel(a, 970, 1090, ['Cribl Edge', 'Splunk UF', 'OpenTelemetry']), c3, 'data');
    const tool = a.make('tool', 1150, 260), lake = a.make('datalake', 900, 260, { label: 'Blob Storage' });
    a.connect(c1, tool, 'data');
    a.connect(c3, tool, 'data');
    a.connect(c2, lake, 'optional');
  },
  edge(a) {
    a.make('zone:Cribl Cloud', 20, 20, { w: 1460, h: 300 });
    const L = a.make('leader', 400, 90, { label: 'Leader', sub: 'Cribl Cloud' });
    const se = a.newSearch(940, 40), lk = a.make('cribllake', 1220, 90);
    const g = wgWith(a, 'Ingest Worker Group', 560, 470, 3);
    a.make('zone:On-prem data centre', 20, 380, { w: 1460, h: 520 });
    const f1 = a.make('fleet', 60, 690, { label: 'Windows servers' }); a.addKids(f1, 'edgenode', 3);
    const f2 = a.make('fleet', 1060, 690, { label: 'Kubernetes clusters' }); a.addKids(f2, 'edgenode', 2);
    [g, f1, f2].forEach(x => a.connect(L, x, 'control'));
    a.ensureCompanions(L, true);
    a.connect(f1, g, 'data', { label: 'Cribl TCP' });
    a.connect(f2, g, 'data', { label: 'Cribl HTTP' });
    a.connect(g, lk, 'data');
    a.connect(lk, g, 'optional', { label: 'Replay' });
    a.connect(a.kidsOf(se.id)[0], lk, 'data', { label: 'Federated search' });
    a.connect(g, a.make('tool', 620, 720, { label: 'SIEM', sub: 'Splunk, Sentinel, etc' }), 'data');
  },
  suite(a) {
    // After the Cribl full-suite reference architecture.
    a.make('zone:Cribl Cloud', 20, 30, { w: 1500, h: 560 });
    const L = a.make('leader', 330, 70, { label: 'Leader', sub: 'Manages every group and fleet' });
    const m = wgWith(a, 'Cribl-managed Worker Group', 540, 300, 2);
    const se = a.newSearch(1260, 60), lk = a.make('cribllake', 1270, 400), de = a.make('cribldetect', 960, 90);
    const le = a.make('engine:lakehouse', 0, 0, { parent: se.id, order: 1, sub: 'Security data' });
    const h = wgWith(a, 'Hybrid Worker Group', 540, 760, 3);
    const sp = panel(a, 60, 360, ['Push sources', 'Pull sources']);
    const f = a.make('fleet', 40, 700, { label: 'Edge fleet' }); a.addKids(f, 'edgenode', 2);
    const dests = ['Other data lakes', 'SIEM', 'Monitoring'].map((l, i) => a.make(`dst:${l}`, 1320, 680 + i * 160));
    a.connect(L, m, 'control');
    a.ensureCompanions(L, true);
    a.connect(sp, m, 'data'); a.connect(f, h, 'data'); a.connect(h, m, 'data');
    a.connect(m, lk, 'data'); a.connect(lk, m, 'optional', { label: 'Replay' });
    a.connect(a.kidsOf(se.id)[0], lk, 'data', { label: 'Federated search' });
    a.connect(m, le, 'data', { label: 'Ingest' });
    a.connect(de, le, 'data', { label: 'Detections' });
    if (dests[0]) a.connect(de, dests[0], 'optional', { label: 'Alerts' });
    for (const d of dests) { a.connect(h, d, 'data'); a.connect(m, d, 'data'); }
  },
  empty() {},
};

export function applyTemplate(a: Arch, key: TemplateKey) {
  a.clear();
  TEMPLATES[key](a);
}

// --- this Cribl org -----------------------------------------------------------

/** One row of GET /master/groups, as much as the board reads of it. */
export interface OrgGroup {
  id: string;
  name?: string;
  type?: string;
  isFleet?: boolean;
  isSearch?: boolean;
  onPrem?: boolean;
  cloud?: { provider?: string; region?: string } | null;
  inherits?: string;
}

/** The most nodes drawn in one group; the rest is said in its name. */
export const MAX_NODES_DRAWN = 5;

/**
 * The org as it runs: its leader, a zone for Cribl Cloud and one for customer-managed
 * groups and fleets, each group with its connected workers, and Cribl Search when the org
 * has a search group. Outposts are not drawn. Returns what it read, for the message.
 */
export function drawOrg(a: Arch, groups: OrgGroup[], workersByGroup: Record<string, number>): string {
  a.clear();
  const name = (g: OrgGroup) => g.name || g.id;
  const stream = groups.filter(g => !g.isSearch && !g.isFleet && (g.type || 'stream') === 'stream');
  const fleets = groups.filter(g => g.isFleet || g.type === 'edge');
  const search = groups.some(g => g.isSearch || g.type === 'search');
  const skipped = groups.filter(g => !stream.includes(g) && !fleets.includes(g) && !(g.isSearch || g.type === 'search'));
  // Cribl-managed groups say where they run; a search group exists only on Cribl Cloud.
  const onCloud = search || groups.some(g => !!g.cloud);
  const cloudGroups = stream.filter(g => !g.onPrem);
  const ownGroups = [...stream.filter(g => g.onPrem), ...fleets];

  const row = (list: OrgGroup[], y: number, x0: number) => {
    let x = x0;
    const made: ArchNode[] = [];
    for (const g of list) {
      const count = workersByGroup[g.id] || 0;
      const shown = Math.min(count, MAX_NODES_DRAWN);
      const fleet = g.isFleet || g.type === 'edge';
      const unit = fleet ? (count === 1 ? 'Edge node' : 'Edge nodes') : (count === 1 ? 'worker' : 'workers');
      const label = `${name(g)}${g.inherits ? ` (in ${g.inherits})` : ''}${count > MAX_NODES_DRAWN || count === 0 ? ` · ${count} ${unit}` : ''}`;
      const n = a.make(fleet ? 'fleet' : 'wg', x, y, { label, ghost: count === 0 });
      a.addKids(n, fleet ? 'edgenode' : 'worker', shown);
      made.push(n);
      x += a.size(n).w + 70;
    }
    return { made, right: x };
  };

  const L = a.make('leader', 0, 70, onCloud
    ? { label: 'Leader', sub: 'Cribl Cloud', where: 'cloud' }
    : { label: 'Leader', sub: 'Customer-managed', where: 'self' });
  const top = row(cloudGroups, 320, 80);
  let right = Math.max(top.right, 900);
  let se: ArchNode | undefined;
  if (search) {
    se = a.newSearch(right, 60);
    right += a.size(se).w + 70;
  }
  L.x = Math.round((Math.max(top.right, 900) - 112) / 2 / 10) * 10;
  a.ensureCompanions(L, true, true);
  const cloudW = Math.max(right, 1100);
  a.make(onCloud ? 'zone:Cribl Cloud' : 'zone:Customer-managed', 20, 20, { w: cloudW, h: cloudGroups.length ? 500 : Math.max(300, se ? a.size(se).h + 120 : 300) });
  const zoneTop = cloudGroups.length ? 580 : 380;
  const low = row(ownGroups, zoneTop + 100, 80);
  if (ownGroups.length) a.make('zone:On-prem data centre', 20, zoneTop, { w: Math.max(low.right, 600), h: 300 });
  for (const g of [...top.made, ...low.made]) a.connect(L, g, 'control');

  const workers = Object.entries(workersByGroup).filter(([g]) => stream.some(s => s.id === g)).reduce((s, [, n]) => s + n, 0);
  const nodes = Object.entries(workersByGroup).filter(([g]) => fleets.some(f => f.id === g)).reduce((s, [, n]) => s + n, 0);
  const parts = [
    `${stream.length} worker group${stream.length === 1 ? '' : 's'} with ${workers} worker${workers === 1 ? '' : 's'}`,
    `${fleets.length} Edge fleet${fleets.length === 1 ? '' : 's'} with ${nodes} node${nodes === 1 ? '' : 's'}`,
    ...(search ? ['Cribl Search'] : []),
  ];
  return `Read ${parts.join(', ')} from this org.${skipped.length ? ` Not drawn: ${skipped.map(name).join(', ')}.` : ''}`;
}
