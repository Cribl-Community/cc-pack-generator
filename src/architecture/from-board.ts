/**
 * An architecture drawn from the prospect's whiteboard: what the board says they collect and
 * where it goes becomes a starting drawing the SE then changes. Only what maps to a part is
 * taken; the rest is named in the message. The whiteboard itself is never changed. Pure.
 *
 * Cribl's own products (Cribl Lake, the Lakehouse Engine, Detect) are on every new board
 * as part of the Cribl story, so only the ones the SE put on THIS board are taken
 * (`meet.shown["group:id"] === true`): a fresh board draws no Lake or Search.
 */
import { liveItems } from '../whiteboard/board-model';
import type { WhiteboardLibV5, WhiteboardMeetV5 } from '../whiteboard/types';
import { listing, type Arch, type ArchNode } from './model';

/** What the drawing takes from a board. */
export interface BoardIntake {
  sources: string[];
  /** Edge agent was on the board: an Edge fleet sends to the worker group. */
  edge: boolean;
  destinations: string[];
  lake: boolean;
  /** "Cribl Lake on your bucket" */
  lakeOnBucket: boolean;
  lakehouse: boolean;
  detect: boolean;
  /** the board's Search layer is on (After) */
  search: boolean;
  /** on the board, but nothing on the architecture stands for it */
  notDrawn: string[];
}

export function boardIntake(lib: WhiteboardLibV5 | null | undefined, meet: WhiteboardMeetV5 | null | undefined): BoardIntake {
  const label = (it: { label?: string }) => String(it.label || '').trim();
  const sources = liveItems(lib, meet, 'sources');
  const point = liveItems(lib, meet, 'point');
  const cribl = liveItems(lib, meet, 'cribl');
  const platform = liveItems(lib, meet, 'platform');
  const chosen = (group: string, id: string) => meet?.shown?.[`${group}:${id}`] === true;
  const has = (id: string) => cribl.some(it => it.id === id && chosen('cribl', it.id));
  const view = meet?.view || {};
  const notDrawn = cribl.filter(it => chosen('cribl', it.id) && !['cr-lake', 'cr-lakehouse', 'cr-byob'].includes(it.id)).map(label);
  if (view.ai === 'after') notDrawn.push('the AI layer');
  return {
    sources: sources.filter(it => it.id !== 'src-edge').map(label).filter(Boolean),
    edge: sources.some(it => it.id === 'src-edge'),
    destinations: [...point.filter(it => it.id !== 'pt-detect'), ...platform].map(label).filter(Boolean),
    lake: has('cr-lake') || has('cr-byob'),
    lakeOnBucket: has('cr-byob') && !has('cr-lake'),
    lakehouse: has('cr-lakehouse'),
    detect: point.some(it => it.id === 'pt-detect' && chosen('point', it.id)),
    search: view.search === 'after',
    notDrawn: notDrawn.filter(Boolean),
  };
}

/**
 * Lay the intake out after the full-suite reference: Cribl Cloud with the leader, a worker
 * group and the Cribl services; the sources on the left, the destinations on the right, an
 * Edge fleet on-prem below. Returns the message for the SE.
 */
export function drawFromBoard(a: Arch, b: BoardIntake): string {
  a.clear();
  const L = a.make('leader', 520, 70, { label: 'Leader', sub: 'Cribl Cloud', where: 'cloud' });
  const g = a.make('wg', 500, 400, { label: 'Worker group' });
  a.addKids(g, 'worker', 3);
  a.ensureCompanions(L, true, true);
  a.connect(L, g, 'control');

  const sp = a.make('srcpanel', 80, 370);
  b.sources.forEach(l => a.addToPanel(sp, l));
  a.connect(sp, g, 'data');

  // Cribl services, in a column on the right of the zone
  const right = 1150;
  let y = 60;
  let se: ArchNode | undefined, lk: ArchNode | undefined, de: ArchNode | undefined;
  if (b.search || b.lakehouse || b.detect) {
    se = a.newSearch(right, y);
    if (b.detect) a.make('engine:lakehouse', 0, 0, { parent: se.id, order: 1000, sub: 'Security data' });
    else if (b.lakehouse) a.make('engine:lakehouse', 0, 0, { parent: se.id, order: 1000 });
    y += a.size(se).h + 60;
  }
  if (b.lake) {
    lk = a.make('cribllake', right + 25, y, b.lakeOnBucket ? { sub: 'On your bucket' } : {});
    y += a.size(lk).h + 60;
  }
  if (b.detect) de = a.make('cribldetect', 860, 230);

  const zoneH = Math.max(y, 370 + a.size(sp).h + 40, 600) - 10;
  a.make('zone:Cribl Cloud', 20, 30, { w: 1420, h: zoneH });

  const dests = b.destinations.map((l, i) => a.make(`dst:${l}`, 1520, 380 + i * 160));
  for (const d of dests) a.connect(g, d, 'data');

  if (lk) { a.connect(g, lk, 'data'); a.connect(lk, g, 'optional', { label: 'Replay' }); }
  if (se) {
    const fe = a.kidsOf(se.id).find(k => k.eng === 'federated');
    if (fe && lk) a.connect(fe, lk, 'data', { label: 'Federated search' });
    for (const le of a.kidsOf(se.id).filter(k => k.eng === 'lakehouse')) a.connect(g, le, 'data', { label: 'Ingest' });
    if (b.search) a.connect(se, g, 'optional', { label: 'Search and send' });
  }
  if (de) {
    const sec = a.engines('lakehouse').find(k => /secur/i.test(k.sub || ''));
    if (sec) a.connect(de, sec, 'data', { label: 'Detections' });
    if (dests[0]) a.connect(de, dests[0], 'optional', { label: 'Alerts' });
  }
  if (b.edge) {
    const zy = 30 + zoneH + 50;
    a.make('zone:On-prem data centre', 20, zy, { w: 760, h: 300 });
    const f = a.make('fleet', 80, zy + 100, { label: 'Edge fleet' });
    a.addKids(f, 'edgenode', 3);
    a.connect(L, f, 'control');
    a.connect(f, g, 'data', { label: 'Cribl TCP' });
  }

  const took = [
    `${b.sources.length + (b.edge ? 1 : 0)} source${b.sources.length + (b.edge ? 1 : 0) === 1 ? '' : 's'}`,
    `${b.destinations.length} destination${b.destinations.length === 1 ? '' : 's'}`,
    ...(b.lake ? ['Cribl Lake'] : []),
    ...(se ? ['Cribl Search'] : []),
    ...(b.detect ? ['Cribl Detect'] : []),
  ];
  return `Drawn from the whiteboard: ${listing(took)}. Change anything here; the whiteboard stays as it is.${b.notDrawn.length ? ` Not drawn: ${listing(b.notDrawn)}.` : ''}`;
}
