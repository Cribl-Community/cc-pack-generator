/**
 * Goatpedia library: the `library.json` GitHub Pages builds from `main` of
 * wvdlinde-cribl/goatpedia (the same source SE Toolkit reads). It is fetched
 * fresh every time the screen opens, so an article merged in the repository
 * shows here as soon as Pages republishes. Allowed in config/proxies.yml.
 */

import { parseLog, type ParsedField, type ParseInput } from './goatpedia-parse';
import type { StreamBlock, StreamCheck } from './goatpedia-stream';

export const LIBRARY_URL = 'https://wvdlinde-cribl.github.io/goatpedia/library.json';
/** What browse and search need, without the articles' bodies (Goatpedia build: index.json). */
export const INDEX_URL = 'https://wvdlinde-cribl.github.io/goatpedia/index.json';
/** One full article, fetched when it is opened. */
export const entryUrl = (id: string) => `https://wvdlinde-cribl.github.io/goatpedia/e/${encodeURIComponent(id)}.json`;
const LOGOS = new Map<string, Promise<string | null>>();
/**
 * A vendor logo as an object URL. Images in the app iframe are not proxied, so the SVG is
 * fetched through the proxy (config/proxies.yml already allows /goatpedia/) and shown from a
 * blob: URL; as an <img>, an SVG cannot run script. Cached for the session.
 */
export function logoUrl(src: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!LOGOS.has(src)) {
    LOGOS.set(src, fetchImpl(`${SITE_URL}${src}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((svg) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })))
      .catch(() => null));
  }
  return LOGOS.get(src)!;
}

/** Cards per browse page. */
export const PAGE_SIZE = 24;
export const SITE_URL = 'https://wvdlinde-cribl.github.io/goatpedia/';
export const REPO = 'https://github.com/wvdlinde-cribl/goatpedia';

export interface Category { label: string; color: string; icon: string }
export interface SourcetypeRef { st: string; desc?: string }
export interface LogSample extends ParseInput {
  type: string;
  sourcetype: string;
  desc: string;
  share?: string;
  avg?: string;
  key?: string[];
  noise?: string[];
}
export interface Cve {
  id: string; cvss?: number; title?: string; scope?: string; affected?: string;
  fixed?: string; detect?: string; avoid?: string; kev?: boolean;
}
export interface Detection {
  title: string; severity: string; signals: string[]; why: string; kql: string; mitre?: string[];
}
export interface Optimization { title: string; saving: string; fn: string; how: string; expr?: string; stream?: StreamBlock; verified?: StreamCheck }
export interface Entry {
  id: string; name: string; short: string; vendor: string; category: string;
  status: 'full' | 'stub'; summary: string; sourcetypes: SourcetypeRef[];
  aka?: string[]; tags?: string[]; updated?: string;
  facts?: Record<string, string>;
  placement?: { items: { slot: string; title: string; desc: string }[] };
  howItWorks?: { title: string; body: string }[];
  traffic?: { handles: string[]; flow: { step: string; desc: string }[] };
  logs?: LogSample[];
  cves?: Cve[];
  cveIds?: string[];
  detections?: Detection[];
  optimizations?: Optimization[];
  references?: { title: string; url: string }[];
  related?: string[];
  /** index.json only: the how-it-works and detection words, pre-joined for search. */
  text?: string;
  /** The vendor's logo, a path under the site (logos/<slug>.svg); absent → the category icon. */
  logo?: { src: string; title: string };
}
export interface Library {
  built: string;
  categories: Record<string, Category>;
  entries: Entry[];
  /** True when the entries are full articles (library.json), so none needs fetching. */
  complete?: boolean;
}
export interface DecoratedField extends ParsedField { key: boolean; noise: boolean }
export interface SearchHit { e: Entry; score: number }

const FALLBACK_CATEGORY: Category = { label: 'Other', color: '#64748b', icon: '•' };

export function categoryOf(categories: Record<string, Category>, key: string): Category {
  return categories[key] ?? { ...FALLBACK_CATEGORY, label: key || FALLBACK_CATEGORY.label };
}

export function cveIds(e: Entry): string[] {
  return e.cves ? e.cves.map((c) => c.id) : e.cveIds || [];
}

export function decorate(log: LogSample): DecoratedField[] {
  try {
    return parseLog(log).map((f) => ({
      ...f,
      key: (log.key || []).includes(f.name),
      noise: (log.noise || []).includes(f.name),
    }));
  } catch {
    return [];
  }
}

async function getJson(fetchImpl: typeof fetch, url: string, what: string): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(`${url}?v=${Date.now()}`, { cache: 'no-store' });
  } catch {
    throw new Error('GitHub could not be reached');
  }
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`The ${what} responded ${res.status}`);
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    throw new Error(`The ${what} file could not be read`);
  }
}

/**
 * The browse index (index.json): cards and search fields only, so the screen does not
 * download every article up front. Until a Goatpedia build has published index.json it
 * falls back to library.json, which holds every full article.
 */
export async function loadLibrary(fetchImpl: typeof fetch = fetch): Promise<Library> {
  let { status, body } = await getJson(fetchImpl, INDEX_URL, 'library');
  let complete = false;
  if (status === 404) {
    ({ status, body } = await getJson(fetchImpl, LIBRARY_URL, 'library'));
    if (status === 404) throw new Error('The library responded 404');
    complete = true;
  }
  const lib = body as Library | null;
  if (!lib || !Array.isArray(lib.entries) || lib.categories == null || typeof lib.categories !== 'object') {
    throw new Error('The library file has no entries');
  }
  return { ...lib, complete };
}

/** One full article (e/<id>.json). */
export async function loadEntry(id: string, fetchImpl: typeof fetch = fetch): Promise<Entry> {
  const { status, body } = await getJson(fetchImpl, entryUrl(id), 'article');
  if (status === 404) throw new Error('This article is not in the library');
  const e = body as Entry | null;
  if (!e || e.id !== id || !Array.isArray(e.sourcetypes)) throw new Error('The article file could not be read');
  return e;
}

/** The slice of `items` on 1-based `page`, with the page clamped to what exists. */
export function pageOf<T>(items: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { items: items.slice((at - 1) * size, at * size), page: at, pages };
}

/** Page buttons to show: first, last and two either side of the current one; null is a gap. */
export function pageButtons(page: number, pages: number): (number | null)[] {
  const want = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])].filter((x) => x >= 1 && x <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  want.forEach((x, i) => { if (i && x - want[i - 1] > 1) out.push(null); out.push(x); });
  return out;
}

const WEIGHT: Record<string, number> = { name: 10, sourcetype: 8, cve: 8, vendor: 6, category: 5, tag: 3, text: 1 };

function sortName(a: SearchHit, b: SearchHit): number {
  return a.e.status === b.e.status ? a.e.name.localeCompare(b.e.name) : a.e.status === 'full' ? -1 : 1;
}

/** Every word must match. A full article ranks above a stub when the scores tie. */
export function search(entries: Entry[], categories: Record<string, Category>, q: string): SearchHit[] {
  const toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return entries.map((e) => ({ e, score: 0 })).sort(sortName);
  const out: SearchHit[] = [];
  for (const e of entries) {
    const hay: Record<string, string> = {
      name: [e.name, e.short, ...(e.aka || [])].join(' ').toLowerCase(),
      vendor: e.vendor.toLowerCase(),
      sourcetype: e.sourcetypes.map((s) => s.st).join(' ').toLowerCase(),
      category: `${categories[e.category]?.label || ''} ${e.category}`.toLowerCase(),
      tag: (e.tags || []).join(' ').toLowerCase(),
      cve: cveIds(e).join(' ').toLowerCase(),
      text: [
        e.summary,
        // index.json carries these words pre-joined as e.text; a full article has them in place.
        e.text ?? [
          ...(e.howItWorks || []).map((h) => `${h.title} ${h.body}`),
          ...(e.detections || []).map((d) => `${d.title} ${d.signals.join(' ')}`),
        ].join(' '),
      ].join(' ').toLowerCase(),
    };
    let score = 0;
    let all = true;
    for (const t of toks) {
      let hit = false;
      for (const k of Object.keys(hay)) if (hay[k].includes(t)) { score += WEIGHT[k]; hit = true; }
      if (!hit) { all = false; break; }
    }
    if (all) out.push({ e, score: score + (e.status === 'full' ? 2 : 0) });
  }
  return out.sort((a, b) => b.score - a.score || sortName(a, b));
}

const SLOTS: Record<string, [number, number]> = {
  edge: [205, 175], internal: [515, 175], cloud: [640, 92], remote: [80, 300], dmz: [385, 118], endpoint: [380, 300],
};

function xmlEscape(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** The site's network diagram, as an SVG string. Unknown slots are skipped. */
export function diagramSvg(e: Entry): string {
  const t = { bg: '#f8fafc', box: '#fff', stroke: '#cbd5e1', text: '#14212b', muted: '#64748b', accent: '#0ea5a4', line: '#cbd5e1' };
  const box = (x: number, y: number, w: number, h: number, label: string, sub?: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${t.box}" stroke="${t.stroke}"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2 - (sub ? 4 : -4)}" text-anchor="middle" font-size="13" font-weight="600" fill="${t.text}">${xmlEscape(label)}</text>` +
    (sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" font-size="10.5" fill="${t.muted}">${xmlEscape(sub)}</text>` : '');
  const line = (a: number[], b: number[], dash = false, col = t.line, w = 2) =>
    `<path d="M${a[0]},${a[1]} L${b[0]},${b[1]}" stroke="${col}" stroke-width="${w}" ${dash ? 'stroke-dasharray="5 5"' : ''} fill="none"/>`;
  let s = `<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Network placement of ${xmlEscape(e.name)}" style="width:100%;height:auto;display:block;font-family:inherit"><rect width="760" height="360" rx="12" fill="${t.bg}"/>`;
  s += line([110, 175], [330, 175]) + line([205, 175], [300, 85]) + line([430, 175], [580, 175]) + line([380, 195], [380, 270]) + line([90, 150], [580, 60], true) + line([80, 200], [80, 280], true);
  s += `<ellipse cx="70" cy="175" rx="52" ry="34" fill="${t.box}" stroke="${t.stroke}"/><text x="70" y="180" text-anchor="middle" font-size="13" font-weight="600" fill="${t.text}">Internet</text>`;
  s += box(300, 40, 170, 56, 'DMZ', 'web · mail · VPN portal') + box(330, 155, 100, 40, 'Core') + box(300, 270, 160, 60, 'Campus', 'users · endpoints')
    + box(580, 145, 160, 60, 'Data center', 'servers · databases') + box(580, 30, 160, 56, 'Cloud VPC', 'AWS · Azure · GCP') + box(580, 270, 160, 60, 'Log pipeline', '→ SIEM · data lake');
  s += `<text x="80" y="342" text-anchor="middle" font-size="10.5" fill="${t.muted}">Remote users</text>`;
  const items = (e.placement?.items || []).filter((it) => SLOTS[it.slot]);
  for (const it of items) s += line(SLOTS[it.slot], [580, 300], true, t.accent, 1.2).replace('<path', '<path opacity=".55"');
  items.forEach((it, i) => {
    const [x, y] = SLOTS[it.slot];
    s += `<rect x="${x - 44}" y="${y - 14}" width="88" height="28" rx="14" fill="${t.accent}"/><text x="${x + 6}" y="${y + 4.5}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${xmlEscape(e.short)}</text>` +
      `<circle cx="${x - 33}" cy="${y}" r="9" fill="#fff"/><text x="${x - 33}" y="${y + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="${t.accent}">${i + 1}</text>`;
  });
  return `${s}</svg>`;
}
