/**
 * The Architecture board drawn as SVG markup, in the style of the Cribl reference
 * architectures: control lines teal and solid, data black dotted, optional grey dotted.
 * The icons are drawn here in the docs' style, not the Cribl brand assets (the app is
 * published publicly). Pure strings: the canvas sets them, export wraps them.
 */
import { Arch, DST_ROW, placeLabels, type ArchEdge, type ArchNode, type Pt } from './model';

export type Selection = { kind: 'node' | 'edge'; id: string } | null;

export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ICON = {
  hex: (c = '#fff') => `<path d="M0 -9 L8 -4.5 L8 4.5 L0 9 L-8 4.5 L-8 -4.5Z" fill="none" stroke="${c}" stroke-width="2"/><circle r="2.6" fill="${c}"/>`,
  group: (c = '#fff') => `<g fill="none" stroke="${c}" stroke-width="1.8"><path d="M0 -12 l5 3v6l-5 3-5-3v-6z"/><path d="M-8 2 l5 3v6l-5 3-5-3v-6z"/><path d="M8 2 l5 3v6l-5 3-5-3v-6z"/><path d="M-3 8 H3"/></g>`,
  leader: (c = '#fff') => `<circle cy="-8" r="7" fill="${c}"/><text y="-4.5" text-anchor="middle" font-size="9" font-weight="700" fill="#1ccbc8">L</text><g fill="none" stroke="${c}" stroke-width="1.3"><path d="M0 -1 L-12 9 M0 -1 L0 9 M0 -1 L12 9"/><circle cx="-12" cy="12" r="3"/><circle cy="12" r="3"/><circle cx="12" cy="12" r="3"/></g>`,
  edge: (c = '#fff') => `<g fill="none" stroke="${c}" stroke-width="2"><path d="M-7 -9 a9 9 0 0 1 0 18 a9 9 0 0 1 0 -18z"/><path d="M-1 -8 a8 8 0 0 1 0 16"/><path d="M4 -7 a7 7 0 0 1 0 14"/></g>`,
  lb: (c = '#fff') => `<g fill="none" stroke="${c}" stroke-width="1.8"><path d="M-10 0H10M0 -10V10"/><path d="M6 -3l4 3-4 3M-6 -3l-4 3 4 3M-3 6l3 4 3-4M-3 -6l3-4 3 4"/></g>`,
  src: (c = '#4a4a4a') => `<g fill="none" stroke="${c}" stroke-width="1.8"><circle r="8"/><path d="M-4 0h8M1 -3l3 3-3 3"/></g>`,
  // reference architectures: an analytic tool is a magnifier with one rising line; a data lake is a stack over two waves
  analytics: () => `<g class="arch-analytics" fill="none" stroke="#fff" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"><circle cx="-1" cy="-1.2" r="6.3"/><path d="M3.5 3.3 8.6 8.4"/><path d="M-3.2 1.1 1.2 -2.2"/></g>`,
  lake: () => `<g class="arch-lake"><g fill="#fff"><ellipse cy="-6.2" rx="7.2" ry="2.5"/><path d="M-7.2 -6.2v6.2c0 1.5 3.2 2.7 7.2 2.7s7.2-1.2 7.2-2.7v-6.2"/><path d="M-7.2 -1.6c0 1.3 3.2 2.3 7.2 2.3s7.2-1 7.2-2.3" fill="none" stroke="#00676b" stroke-width="1.15"/></g><g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"><path d="M-8.2 5.4c2.2 1.5 3.4 1.5 5.4 0s3.2-1.5 5.4 0 3.2 1.5 5.4 0"/><path d="M-8.2 8.6c2.2 1.5 3.4 1.5 5.4 0s3.2-1.5 5.4 0 3.2 1.5 5.4 0"/></g></g>`,
  user: (c = '#13233a') => `<g fill="none" stroke="${c}" stroke-width="2"><circle cy="-6" r="6"/><path d="M-11 12c0-7 5-10 11-10s11 3 11 10"/></g>`,
  git: () => `<g><rect x="-11" y="-11" width="22" height="22" rx="3" transform="rotate(45)" fill="#fff"/><circle cx="-3" cy="-3" r="2" fill="#f05033"/><circle cx="3" cy="3" r="2" fill="#f05033"/><path d="M-3 -3L3 3" stroke="#f05033" stroke-width="1.6"/></g>`,
};

const PRODUCT_GLYPH: Record<'criblsearch' | 'cribllake' | 'cribldetect', string> = {
  criblsearch: '<g fill="none" stroke="#fff" stroke-width="3"><circle cx="-2" cy="-2" r="8"/><path d="M4 4l7 7"/></g>',
  cribllake: '<g fill="none" stroke="#fff" stroke-width="3"><path d="M-12 -3c4 4 8 4 12 0s8-4 12 0"/><path d="M-12 5c4 4 8 4 12 0s8-4 12 0"/></g>',
  cribldetect: '<g fill="none" stroke="#fff" stroke-width="2.6"><path d="M0 -13l10 4v6c0 7-4 11-10 14C-6 8-10 4-10 -3v-6z"/><path d="M-5 0l4 4 6-7"/></g>',
};
const ENGINE_GLYPH = {
  // storage and compute in one: a stack with a bolt
  lakehouse: (c = '#fff') => `<g fill="none" stroke="${c}" stroke-width="2.6"><ellipse cy="-9" rx="11" ry="4"/><path d="M-11 -9v16c0 2 5 4 11 4s11-2 11-4v-16"/><path d="M2 -3l-5 7h5l-3 6"/></g>`,
  // reads storage in place: a stack behind a magnifier
  federated: (c = '#fff') => `<g fill="none" stroke="${c}" stroke-width="2.6"><ellipse cx="-4" cy="-8" rx="9" ry="3.5"/><path d="M-13 -8v12c0 2 4 3 9 3"/><circle cx="6" cy="5" r="5"/><path d="M10 9l4 4"/></g>`,
};

/** Arrow heads and the control line's end dots; ids are the board's own. */
export const DEFS = '<defs>'
  + '<marker id="arch-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#222"/></marker>'
  + '<marker id="arch-arr-g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9a9a9a"/></marker>'
  + '<marker id="arch-dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><circle cx="5" cy="5" r="4" fill="#1ccbc8"/></marker>'
  + '</defs>';

const EDGE_STYLE: Record<ArchEdge['kind'], string> = {
  control: 'stroke="#1ccbc8" stroke-width="1.8" marker-start="url(#arch-dot)" marker-end="url(#arch-dot)"',
  data: 'stroke="#222" stroke-width="1.6" stroke-dasharray="2 4" marker-end="url(#arch-arr)"',
  optional: 'stroke="#9a9a9a" stroke-width="1.6" stroke-dasharray="2 4" marker-end="url(#arch-arr-g)"',
};

/** The palette tile for a part (`type` or `type:arg`). */
export function paletteIcon(part: string): string {
  const k = part.split(':')[0];
  const tile = (bg: string, icon: string, w = 34, h = 26) => `<svg viewBox="-20 -15 40 30" aria-hidden="true"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="3" fill="${bg}"/><g transform="scale(.75)">${icon}</g></svg>`;
  const svg = (inner: string) => `<svg viewBox="-20 -15 40 30" aria-hidden="true">${inner}</svg>`;
  switch (k) {
    case 'leader': return tile('#1ccbc8', ICON.leader());
    case 'wg': return svg('<rect x="-19" y="-6" width="38" height="20" rx="2" fill="#d6e6f0"/><rect x="-9" y="-14" width="18" height="14" rx="2" fill="#2a6f9e"/><rect x="-15" y="3" width="8" height="8" fill="#2f8fc6"/><rect x="-4" y="3" width="8" height="8" fill="#2f8fc6"/><rect x="7" y="3" width="8" height="8" fill="#2f8fc6"/>');
    case 'worker': return tile('#2f8fc6', ICON.hex(), 28, 24);
    case 'fleet': return svg('<rect x="-19" y="-6" width="38" height="20" rx="2" fill="#ffffff" stroke="#1ccbc8" stroke-dasharray="2 2"/><rect x="-9" y="-14" width="18" height="14" rx="2" fill="#1ccbc8"/><rect x="-15" y="3" width="8" height="8" fill="#2f8fc6"/><rect x="-4" y="3" width="8" height="8" fill="#2f8fc6"/>');
    case 'edgenode': return tile('#2f8fc6', `<g transform="scale(.8)">${ICON.edge()}</g>`, 28, 24);
    case 'lb': return svg(`<circle r="13" fill="#7d7d7d"/><g transform="scale(.8)">${ICON.lb()}</g>`);
    case 'user': return svg(`<g transform="scale(.9)">${ICON.user()}</g>`);
    case 'git': return tile('#f05033', `<g transform="scale(.7)">${ICON.git()}</g>`);
    case 'srcpanel': return svg('<rect x="-16" y="-14" width="32" height="28" rx="2" fill="#ececec"/><rect x="-12" y="-6" width="24" height="7" fill="#fff"/><rect x="-12" y="4" width="24" height="7" fill="#fff"/>');
    case 'dst': case 'dstpanel': return svg(`<ellipse rx="16" ry="10" fill="#00676b"/><g transform="scale(.62)">${ICON.analytics()}</g>`);
    case 'engine': return svg(`<rect x="-19" y="-10" width="38" height="20" rx="2" fill="#fff" stroke="#c7d2dc"/><rect x="-19" y="-10" width="5" height="20" fill="#1ccbc8"/><g transform="translate(-4 0) scale(.42)">${ENGINE_GLYPH.lakehouse('#00797a')}</g><path d="M4 -3h11M4 3h8" stroke="#13233a" stroke-width="2"/>`);
    case 'tool': return svg(`<rect x="-16" y="-1" width="32" height="14" rx="3" fill="#8c8c8c"/><path d="M-8 -1a8 8 0 0 1 16 0z" fill="#8c8c8c"/><g transform="translate(0 -5) scale(.55)">${ICON.analytics()}</g>`);
    case 'datalake': return svg(`<ellipse rx="16" ry="10" fill="#00676b"/><g transform="scale(.5)">${ICON.lake()}</g>`);
    case 'cribllake': case 'criblsearch': case 'cribldetect':
      return svg(`<rect x="-19" y="-13" width="38" height="26" rx="4" fill="#eef2f5"/>${k === 'cribllake' ? '<rect x="-16" y="-10" width="32" height="20" rx="3" fill="none" stroke="#1ccbc8" stroke-dasharray="2 2"/>' : ''}<circle cx="-7" r="7" fill="#1ccbc8"/><g transform="translate(-7 0) scale(.42)">${PRODUCT_GLYPH[k]}</g><path d="M2 -3h12M2 3h9" stroke="#13233a" stroke-width="2"/>`);
    case 'zone': {
      const cloud = part.includes('Cribl Cloud');
      return svg(`<rect x="-18" y="-12" width="36" height="24" rx="4" fill="none" stroke="${cloud ? '#9fd4f2' : '#9aa6b2'}" stroke-width="1.6" ${part.includes('On-prem') ? 'stroke-dasharray="3 2"' : ''}/>`);
    }
  }
  return svg('');
}

function t(x: number, y: number, txt: unknown, o: { a?: string; s?: number; w?: number; c?: string; i?: boolean; halo?: boolean } = {}) {
  // halo: a white edge, so a line that runs behind a caption stays readable
  return `<text x="${x}" y="${y}" text-anchor="${o.a || 'middle'}" font-size="${o.s || 13}" font-weight="${o.w || 400}" fill="${o.c || '#2b2b2b'}"${o.i ? ' font-style="italic"' : ''}${o.halo ? ' stroke="#fff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"' : ''}>${esc(txt)}</text>`;
}

/** Parts a line does not start from: zones, and the rows that stand for their container. */
const NO_PORTS = new Set<ArchNode['type']>(['zone', 'worker', 'edgenode', 'src']);

const isOwnPlaceholder = (n: ArchNode) => !!n.own && /^Your own/.test(n.label || '');

function nodeSvg(a: Arch, n: ArchNode, sel: Selection, chrome: boolean): string {
  const { x, y, w, h } = a.box(n);
  let s = '';
  switch (n.type) {
    case 'zone': {
      const cloud = n.label === 'Cribl Cloud';
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${cloud ? 'rgba(159,212,242,.08)' : 'rgba(154,166,178,.05)'}" stroke="${cloud ? '#9fd4f2' : '#9aa6b2'}" stroke-width="2"${(n.label || '').includes('On-prem') ? ' stroke-dasharray="8 5"' : ''}/>`
        + (cloud ? `<path d="M${x + 60} ${y} c0 -20 18 -34 38 -30 c8 -16 34 -16 44 2 c22 -6 40 10 34 28" fill="#fff" stroke="#9fd4f2" stroke-width="2"/>${t(x + 128, y - 4, 'Cribl.Cloud', { s: 17, w: 600, c: '#13233a' })}` : t(x + 16, y + 24, n.label, { a: 'start', s: 15, w: 600, c: '#5b6773' }))
        + (chrome ? `<rect class="resize" data-resize="${n.id}" x="${x + w - 14}" y="${y + h - 14}" width="12" height="12" rx="2" fill="#fff" stroke="#9aa6b2"/>` : '');
      break;
    }
    case 'leader': {
      const tile = (ty: number, op: number, cap: string) => `<rect class="body" x="${x + (w - 104) / 2}" y="${ty}" width="104" height="80" rx="3" fill="#1ccbc8" opacity="${op}"/><g transform="translate(${x + w / 2} ${ty + 30})">${ICON.leader()}</g>${t(x + w / 2, ty + 70, 'Leader Node', { s: 11.5, c: '#fff' })}${cap ? t(x + w / 2, ty + 98, cap, { s: 12, i: true }) : ''}`;
      s = n.ha ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#e9e9e9"/>${tile(y + 10, 1, 'Active')}${tile(y + 120, 0.55, 'Standby')}` : tile(y + 6, 1, '');
      s += t(x + w / 2, y + h + 18, n.label, { s: 14, halo: true }) + (n.sub ? t(x + w / 2, y + h + 36, n.sub, { s: 13, c: '#555', halo: true }) : '');
      break;
    }
    case 'wg': case 'fleet': {
      const fleet = n.type === 'fleet';
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fleet ? '#fff' : '#d6e6f0'}"${fleet ? ' stroke="#1ccbc8" stroke-width="2" stroke-dasharray="6 4"' : ''}/>`
        + `<rect x="${x + w / 2 - 50}" y="${y - 26}" width="100" height="66" rx="3" fill="${fleet ? '#1ccbc8' : '#2a6f9e'}"/><g transform="translate(${x + w / 2} ${y - 2})">${fleet ? ICON.edge() : ICON.group()}</g>${t(x + w / 2, y + 30, fleet ? 'Edge Fleet' : 'Worker Group', { s: 11, c: '#fff' })}`
        + t(x + w / 2, y + 62, n.label, { s: 14.5 });
      if (n.ghost) {
        const k = a.kidsOf(n.id).length, gx = x + (w - (k + 1) * 80 + 12) / 2 + k * 80;
        s += `<rect x="${gx}" y="${y + 76}" width="68" height="58" fill="none" stroke="#2f8fc6" stroke-dasharray="3 3"/><rect x="${gx + 4}" y="${y + 80}" width="68" height="58" fill="none" stroke="#2f8fc6" stroke-dasharray="3 3" opacity=".6"/><g transform="translate(${gx + 34} ${y + 98})" opacity=".55">${fleet ? ICON.edge('#2f8fc6') : ICON.hex('#2f8fc6')}</g>${t(gx + 34, y + 126, fleet ? 'Edge Node' : 'Worker Node', { s: 9, c: '#2f8fc6' })}`;
      }
      break;
    }
    case 'worker': case 'edgenode':
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" fill="#2f8fc6"/><g transform="translate(${x + w / 2} ${y + 22})">${n.type === 'edgenode' ? ICON.edge() : ICON.hex()}</g>${t(x + w / 2, y + 50, n.type === 'edgenode' ? 'Edge Node' : 'Worker Node', { s: 9, c: '#fff' })}`;
      break;
    case 'srcpanel': {
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#ececec"/><g transform="translate(${x + w / 2 - 44} ${y + 26})">${ICON.src()}</g>${t(x + w / 2 + 8, y + 31, n.label, { s: 14.5 })}`;
      if (chrome) {
        const ay = y + 52 + a.kidsOf(n.id).length * 50;
        s += `<g class="addcard" data-addto="${n.id}"><rect x="${x + 13}" y="${ay}" width="210" height="40" fill="#f8fbfb" stroke="#00b3b3" stroke-width="1.4" stroke-dasharray="4 3"/>${t(x + w / 2, ay + 25, '+ Add a source', { s: 13, w: 600, c: '#00797a' })}</g>`;
      }
      break;
    }
    case 'dstpanel': {
      // no card: each destination is its own oval. The clear rect is only there so the column can be moved.
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/>`;
      if (chrome) {
        const ay = y + 4 + a.kidsOf(n.id).length * DST_ROW;
        s += `<g class="addcard" data-addto="${n.id}"><rect x="${x}" y="${ay}" width="${w}" height="32" rx="16" fill="#f4fbfb" stroke="#00b3b3" stroke-width="1.4" stroke-dasharray="4 3"/>${t(x + w / 2, ay + 21, '+ Destination', { s: 12, w: 600, c: '#00797a' })}</g>`;
      }
      break;
    }
    case 'src': {
      const ph = isOwnPlaceholder(n);
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"${ph ? ' stroke="#00b3b3" stroke-dasharray="4 3"' : ''}/>${t(x + w / 2, y + 26, n.label, { s: 13, i: ph, c: ph ? '#00797a' : '#2b2b2b' })}`;
      break;
    }
    case 'dst': {
      const cx = x + w / 2, cy = y + h / 2;
      const ph = isOwnPlaceholder(n);
      const store = /lake|blob|storage|\bs3\b|snowflake|databricks/i.test(`${n.label || ''} ${n.sub || ''}`);
      const mark = store ? ICON.lake() : ICON.analytics();
      s = ph
        ? `<ellipse class="body" cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="#f4fbfb" stroke="#00b3b3" stroke-width="1.4" stroke-dasharray="4 3"/>`
        : `<ellipse class="body" cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="#00676b"/><g transform="translate(${cx} ${cy}) scale(.95)">${mark}</g>`;
      s += t(cx, y + h + 20, n.label, { s: 13, i: ph, c: ph ? '#00797a' : '#2b2b2b' })
        + (n.sub ? t(cx, y + h + 36, n.sub, { s: 12, c: '#555' }) : '');
      break;
    }
    case 'lb':
      s = `<circle class="body" cx="${x + w / 2}" cy="${y + 24}" r="24" fill="#7d7d7d"/><g transform="translate(${x + w / 2} ${y + 24})">${ICON.lb()}</g>${t(x + w / 2, y + 68, n.label, { s: 13.5 })}`;
      break;
    case 'user':
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/><g transform="translate(${x + w / 2} ${y + 24})">${ICON.user('#2b2b2b')}</g>${t(x + w / 2, y + 62, n.label, { s: 14 })}`;
      break;
    case 'git':
      s = `<rect class="body" x="${x + 15}" y="${y}" width="${w - 30}" height="52" rx="3" fill="#f05033"/><g transform="translate(${x + 44} ${y + 26})">${ICON.git()}</g>${t(x + 82, y + 33, 'git', { s: 20, w: 600, c: '#fff' })}${t(x + w / 2, y + 74, n.label, { s: 13.5 })}`;
      break;
    case 'datalake': {
      // a data lake: teal oval, the stack in it, the name underneath
      const cx = x + w / 2, cy = y + h / 2;
      s = `<ellipse class="body" cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="#00676b"/><g transform="translate(${cx} ${cy}) scale(.85)">${ICON.lake()}</g>`
        + t(cx, y + h + 46, n.label, { s: 13.5 }) + (n.sub ? t(cx, y + h + 62, n.sub, { s: 12.5, c: '#555' }) : '');
      break;
    }
    case 'tool': {
      // the reference analytic tool: a gray card, a dome for the magnifier, the name in the card
      const top = y + 22, cx = x + w / 2;
      s = `<rect class="body" x="${x}" y="${top}" width="${w}" height="${h - 22}" rx="10" fill="#8c8c8c"/>`
        + `<path d="M${cx - 26} ${top}a26 26 0 0 1 52 0z" fill="#8c8c8c"/>`
        + `<g transform="translate(${cx} ${top - 2}) scale(.9)">${ICON.analytics()}</g>`
        + t(cx, top + 26, n.label, { s: 14, w: 600, c: '#fff' })
        + (n.sub ? t(cx, top + 44, n.sub, { s: 12, c: '#fff' }) : '');
      break;
    }
    case 'criblsearch': {
      // Cribl Search holds its engines: one federated engine per workspace, any number of lakehouse engines.
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#eef2f5"/><circle cx="${x + 38}" cy="${y + 38}" r="22" fill="#1ccbc8"/><g transform="translate(${x + 38} ${y + 38})">${PRODUCT_GLYPH.criblsearch}</g>`
        + t(x + 72, y + 32, 'Cribl', { a: 'start', s: 12, w: 600, c: '#13233a' }) + t(x + 72, y + 56, n.label, { a: 'start', s: 24, c: '#13233a' });
      if (chrome) {
        const ay = y + 80 + a.kidsOf(n.id).length * 60;
        s += `<g class="addcard" data-addeng="${n.id}"><rect x="${x + 12}" y="${ay}" width="226" height="38" fill="#f8fbfb" stroke="#00b3b3" stroke-width="1.4" stroke-dasharray="4 3"/>${t(x + w / 2, ay + 24, '+ Add a lakehouse engine', { s: 13, w: 600, c: '#00797a' })}</g>`;
      }
      break;
    }
    case 'engine': {
      const fed = n.eng === 'federated';
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#fff" stroke="#c7d2dc"/><rect x="${x}" y="${y}" width="6" height="${h}" fill="${fed ? '#7fd6d6' : '#1ccbc8'}"/><g transform="translate(${x + 28} ${y + h / 2}) scale(.85)">${ENGINE_GLYPH[fed ? 'federated' : 'lakehouse']('#00797a')}</g>`
        + t(x + 52, y + 21, n.label, { a: 'start', s: 13.5, w: 600, c: '#13233a' }) + t(x + 52, y + 38, n.sub, { a: 'start', s: 11, c: '#5b6773' });
      break;
    }
    case 'cribllake': case 'cribldetect': {
      // Cribl-managed services, drawn as in the full-suite reference: a light tile with the product mark.
      s = `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#eef2f5"/>`
        + (n.type === 'cribllake' ? `<rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${h - 12}" rx="4" fill="none" stroke="#1ccbc8" stroke-width="2.2" stroke-dasharray="5 4"/>` : '')
        + `<circle cx="${x + 42}" cy="${y + h / 2}" r="22" fill="#1ccbc8"/><g transform="translate(${x + 42} ${y + h / 2})">${PRODUCT_GLYPH[n.type]}</g>`
        + t(x + 76, y + h / 2 - 6, 'Cribl', { a: 'start', s: 12, w: 600, c: '#13233a' }) + t(x + 76, y + h / 2 + 18, n.label, { a: 'start', s: 24, c: '#13233a' })
        + (n.sub ? t(x + w / 2, y + h + 18, n.sub, { s: 12, c: '#555' }) : '');
      break;
    }
  }
  if (!chrome) return `<g>${s}</g>`;
  const grp = n.type === 'wg' || n.type === 'fleet';
  const selected = sel?.kind === 'node' && sel.id === n.id;
  const sb = `<rect class="selbox" x="${x - 6}" y="${y - (grp ? 32 : 6)}" width="${w + 12}" height="${h + (grp ? 38 : 12)}" rx="6"/>`;
  // a dot on each side: press one, then release or click on another part, to connect them
  const eb = a.ebox(n);
  const handle = NO_PORTS.has(n.type) ? '' : (['top', 'bottom', 'left', 'right'] as const).map(side => {
    const pt = a.port(eb, side);
    return `<circle class="handle" data-port="${n.id}" data-side="${side}" cx="${pt.x}" cy="${pt.y}" r="6" fill="#fff" stroke="#00b3b3" stroke-width="2"/>`;
  }).join('');
  return `<g class="node${selected ? ' selected' : ''}" data-id="${n.id}">${s}${sb}${handle}</g>`;
}

/** Text width at the board's label size, near enough to keep labels apart. */
const textW = (s: string, size: number) => s.length * size * 0.56 + 8;

/** A caption that is only a port, such as `TCP/4200` or `TCP/9514 · TCP/9997`. */
const PORT_ONLY = /^(?:TCP|UDP|HTTPS|HTTP)\/\d+(?: · (?:TCP|UDP|HTTPS|HTTP)\/\d+)*$/;

/** The words on a line: its own caption, plus the port when that traffic has one. */
function edgeCaption(a: Arch, e: ArchEdge): { label: string; sub: string } {
  const known = a.trafficPort(e) || '';
  const own = e.label || (e.kind === 'optional' ? 'Optional' : '');
  // a second line the SE typed replaces the known port
  if (e.sub) return { label: own, sub: e.sub };
  if (!own) return { label: known, sub: '' };
  if (!known || own.toLowerCase().includes(known.toLowerCase())) return { label: own, sub: '' };
  return { label: own, sub: known };
}

/** A port-only caption sits on the first stretch, so lines that leave together share one spot. */
function captionAnchor(pts: Pt[], cap: { label: string; sub: string }, fallback: Pt): Pt {
  if (cap.sub || !PORT_ONLY.test(cap.label) || pts.length < 2) return fallback;
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 - 6 };
}

function edgesSvg(a: Arch, sel: Selection, chrome: boolean, bg: string): string {
  const offs = a.spread();
  const routed = a.edges.map(e => ({ e, r: a.route(e, offs) })).filter(x => x.r).map(({ e, r }) => {
    const cap = edgeCaption(a, e);
    return { e, r: r!, cap, at: captionAnchor(r!.pts, cap, r!.label) };
  });
  // one TCP/4200 on a shared trunk, not a copy on every branch
  const seen = new Set<string>();
  const keptPorts: { label: string; at: Pt; from: Pt }[] = [];
  const labeled = [...routed].sort((p, q) => {
    const dp = Math.hypot(p.at.x - p.r.pts[0].x, p.at.y - p.r.pts[0].y);
    const dq = Math.hypot(q.at.x - q.r.pts[0].x, q.at.y - q.r.pts[0].y);
    return dp - dq;
  }).filter(({ cap, at, r }) => {
    if (!cap.label && !cap.sub) return false;
    const port = !cap.sub && PORT_ONLY.test(cap.label);
    const trunk = (k: { at: Pt; from: Pt }) =>
      (Math.abs(at.x - k.from.x) < 12 && Math.abs(k.at.x - k.from.x) < 12)
      || (Math.abs(at.y - k.from.y) < 12 && Math.abs(k.at.y - k.from.y) < 12);
    if (port && keptPorts.some(k => k.label === cap.label && trunk(k))) return false;
    if (port) keptPorts.push({ label: cap.label, at, from: r.pts[0] });
    const key = `${cap.label}|${cap.sub}|${Math.round(at.x / 30)}|${Math.round(at.y / 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const at = placeLabels(labeled.map(({ e, at: p, cap }) => ({
    id: e.id, x: p.x, y: p.y,
    w: Math.max(textW(cap.label, 12), textW(cap.sub, 11)), h: cap.sub ? 30 : 15,
  })));
  return routed.map(({ e, r, cap }) => {
    const d = `M${r.pts.map(p => `${p.x} ${p.y}`).join(' L')}`;
    const selected = chrome && sel?.kind === 'edge' && sel.id === e.id;
    const lp = at[e.id];
    const label = cap.label;
    const text = lp ? (label ? `<text x="${lp.x}" y="${lp.y}" text-anchor="middle" font-size="12" fill="#444" paint-order="stroke" stroke="${bg}" stroke-width="4">${esc(label)}</text>` : '')
      + (cap.sub ? `<text x="${lp.x}" y="${lp.y + 15}" text-anchor="middle" font-size="11" fill="#666" paint-order="stroke" stroke="${bg}" stroke-width="4">${esc(cap.sub)}</text>` : '') : '';
    const grip = selected && r!.corner
      ? `<rect class="grip" data-mid="${e.id}" data-axis="${r!.corner.axis}" x="${r!.corner.x - 6}" y="${r!.corner.y - 6}" width="12" height="12" rx="2" fill="#fff" stroke="#00b3b3" stroke-width="2"/>`
      : '';
    const corners = selected && e.free ? (e.pts || []).map(p => `<rect x="${p.x - 4}" y="${p.y - 4}" width="8" height="8" fill="#fff" stroke="#00b3b3" stroke-width="1.5"/>`).join('') : '';
    const hit = chrome ? `<path class="hit" d="${d}"/>` : '';
    return `<g class="edge${selected ? ' selected' : ''}" data-edge="${e.id}">${hit}<path class="vis" d="${d}" fill="none" ${EDGE_STYLE[e.kind]}/>${text}${grip}${corners}</g>`;
  }).join('');
}

/** The customer's logo, from the whiteboard, drawn above the architecture. The name is not drawn. */
export interface ArchHeading { logo?: string }

const HEAD = 76;

/** A logo the board stored: a PNG or JPEG data URL, nothing else. */
export function safeLogo(logo?: string): string {
  return logo && /^data:image\/(?:png|jpeg|jpg);base64,/i.test(logo) ? logo : '';
}

/** The logo's own pixel size, so it is drawn at its shape and not stretched into a box. */
function rasterSize(dataUrl: string): { w: number; h: number } | null {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!m) return null;
  let bin: string;
  try { bin = atob(m[2]); } catch { return null; }
  const u = (i: number) => bin.charCodeAt(i);
  if (/png/i.test(m[1]) && bin.length >= 24 && bin.slice(1, 4) === 'PNG') {
    const w = ((u(16) << 24) | (u(17) << 16) | (u(18) << 8) | u(19)) >>> 0;
    const h = ((u(20) << 24) | (u(21) << 16) | (u(22) << 8) | u(23)) >>> 0;
    return w > 0 && h > 0 && w < 8000 && h < 8000 ? { w, h } : null;
  }
  if (bin.length < 4 || u(0) !== 0xff || u(1) !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bin.length) {
    if (u(i) !== 0xff) return null;
    const mark = u(i + 1);
    const len = (u(i + 2) << 8) | u(i + 3);
    if (len < 2) return null;
    if (mark >= 0xc0 && mark <= 0xc3) {
      const h = (u(i + 5) << 8) | u(i + 6), w = (u(i + 7) << 8) | u(i + 8);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

const LOGO_H = 36;

function logoBox(logo: string): { w: number; h: number } {
  const size = rasterSize(logo);
  if (!size) return { w: LOGO_H, h: LOGO_H };
  return { w: Math.max(18, Math.min(168, Math.round(LOGO_H * size.w / size.h))), h: LOGO_H };
}

export function hasHeading(h?: ArchHeading): boolean {
  return !!safeLogo(h?.logo);
}

function headingWidth(h?: ArchHeading): number {
  const logo = safeLogo(h?.logo);
  return logo ? logoBox(logo).w : 0;
}

/** The drawing, plus the logo above it when the customer has one. */
export function contentFrame(a: Arch, heading?: ArchHeading): { x0: number; y0: number; x1: number; y1: number } | null {
  const b = a.bounds();
  const show = hasHeading(heading);
  if (!b) return show ? { x0: 40, y0: 24, x1: 40 + Math.max(480, headingWidth(heading)), y1: 24 + HEAD } : null;
  if (!show) return b;
  return { x0: b.x0, y0: b.y0 - HEAD, x1: Math.max(b.x1, b.x0 + headingWidth(heading)), y1: b.y1 };
}

function headingSvg(a: Arch, heading: ArchHeading): string {
  const f = contentFrame(a, heading);
  if (!f || !hasHeading(heading)) return '';
  const x = f.x0, y = f.y0 + 8;
  const logo = safeLogo(heading.logo);
  if (!logo) return '';
  const box = logoBox(logo);
  return `<g class="arch-heading" pointer-events="none"><image href="${esc(logo)}" x="${x}" y="${y}" width="${box.w}" height="${box.h}"/></g>`;
}

/** Zones at the back, then lines, then parts with their children. The heading sits above all of it. */
export function worldSvg(a: Arch, sel: Selection, chrome = true, bg = '#fafbfc', heading?: ArchHeading): string {
  const zones = a.nodes.filter(n => n.type === 'zone');
  const tops = a.nodes.filter(n => !n.parent && n.type !== 'zone');
  const withKids = (n: ArchNode) => nodeSvg(a, n, sel, chrome) + a.kidsOf(n.id).map(k => nodeSvg(a, k, sel, chrome)).join('');
  const head = heading && hasHeading(heading) ? headingSvg(a, heading) : '';
  return head + zones.map(z => nodeSvg(a, z, sel, chrome)).join('') + edgesSvg(a, sel, chrome, bg) + tops.map(withKids).join('');
}

export const FONT = "'Open Sans', 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

/** The whole drawing as a standalone SVG document, without the editing handles. */
export function exportSvgDoc(a: Arch, heading?: ArchHeading): { svg: string; w: number; h: number } | null {
  const b = contentFrame(a, heading);
  if (!b) return null;
  const x = b.x0 - 30, y = b.y0 - 16, w = Math.ceil(b.x1 - b.x0 + 60), h = Math.ceil(b.y1 - b.y0 + 46);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" font-family="${esc(FONT)}">${DEFS}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>${worldSvg(a, null, false, '#fff', heading)}</svg>`;
  return { svg, w, h };
}
