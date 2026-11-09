/**
 * Find a prospect's logo by name, so the SE never downloads an image to import it.
 *
 * Wikidata names a company's official logo (claim P154, a Wikimedia Commons file) and its website
 * (P856); Commons renders the file as a small PNG; icon.horse serves a website's own icon. All are
 * public, anonymous and CORS-open: fetched directly in standalone, through the Cribl app proxy in
 * the iframe (config/proxies.yml lists exactly these hosts). Whiteboard data is SE-private, so
 * nothing is sent on its own: only the words the SE typed, when they press Search.
 */

export type LogoFetch = (url: string) => Promise<Response>;

export interface LogoCandidate {
  /** Wikidata id (Q…), or `site:<domain>` for a website icon. */
  id: string;
  name: string;
  /** What Wikidata says the entity is ("French telecommunications company"): tells two Oranges apart. */
  description: string;
  /** Where the image is read from (already routed through the proxy in the iframe). */
  imageUrl: string;
  source: 'wikidata' | 'site';
  site?: string;
}

/** The hosts config/proxies.yml lets the app read for logos. */
export const LOGO_HOSTS = ['www.wikidata.org', 'commons.wikimedia.org', 'thumb.wikimedia.org', 'upload.wikimedia.org', 'icon.horse'] as const;

const criblApiBase = (): string => (typeof window !== 'undefined'
  ? String((window as Window & { CRIBL_API_URL?: string }).CRIBL_API_URL || '').replace(/\/+$/, '')
  : '');

/** https://<host><path>, through the Cribl app proxy when the app runs in the iframe. */
export function logoUrl(host: (typeof LOGO_HOSTS)[number], pathAndQuery: string, apiBase = criblApiBase()): string {
  return apiBase ? `${apiBase}/proxy/${host}${pathAndQuery}` : `https://${host}${pathAndQuery}`;
}

/** An image URL Commons returned, routed like every other read; null for a host we may not read. */
export function routeImageUrl(raw: string, apiBase = criblApiBase()): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = LOGO_HOSTS.find(h => h === u.hostname);
  if (!host || u.protocol !== 'https:' || host === 'www.wikidata.org' || host === 'commons.wikimedia.org') return null;
  // Commons tags its thumbnail links with utm_* parameters; the image does not need them.
  return logoUrl(host, u.pathname, apiBase);
}

/** "https://www.orange.com/fr" or "orange.com" → "orange.com"; null when it is not a domain. */
export function domainOf(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(t) ? t : null;
}

/** A website's own icon, for a prospect Wikidata does not know (or a logo it has wrong). */
export function siteIconCandidate(site: string, apiBase = criblApiBase()): LogoCandidate | null {
  const d = domainOf(site);
  return d ? { id: `site:${d}`, name: d, description: 'Website icon', imageUrl: logoUrl('icon.horse', `/icon/${d}`, apiBase), source: 'site', site: d } : null;
}

type Claim = { mainsnak?: { datavalue?: { value?: unknown } } };
type Entity = { labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }>; claims?: Record<string, Claim[]> };
const claimText = (e: Entity, p: string): string => {
  const v = e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value;
  return typeof v === 'string' ? v : '';
};

async function json<T>(fetchFn: LogoFetch, url: string): Promise<T> {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`The logo search answered ${r.status}`);
  return await r.json() as T;
}

/**
 * Up to `limit` logos for a company name: Wikidata entities with an official logo first (as their
 * Commons PNG), then those with only a website (its icon). Entities with neither are left out.
 */
export async function searchLogos(query: string, opts: { fetchFn?: LogoFetch; lang?: string; limit?: number; apiBase?: string } = {}): Promise<LogoCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const fetchFn = opts.fetchFn ?? ((u: string) => fetch(u));
  const lang = /^[a-z]{2}$/.test(opts.lang || '') ? opts.lang! : 'en';
  const apiBase = opts.apiBase ?? criblApiBase();
  const enc = encodeURIComponent;
  const found = await json<{ search?: { id: string }[] }>(fetchFn, logoUrl('www.wikidata.org',
    `/w/api.php?action=wbsearchentities&search=${enc(q)}&language=${lang}&uselang=${lang}&type=item&limit=10&format=json&origin=*`, apiBase));
  const ids = (found.search || []).map(s => s.id).filter(id => /^Q\d+$/.test(id));
  if (!ids.length) return [];
  const langs = lang === 'en' ? 'en' : `${lang}|en`;
  const ents = await json<{ entities?: Record<string, Entity> }>(fetchFn, logoUrl('www.wikidata.org',
    `/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=claims|labels|descriptions&languages=${enc(langs)}&format=json&origin=*`, apiBase));
  const rows = ids.map(id => {
    const e = ents.entities?.[id] || {};
    const pick = (m?: Record<string, { value: string }>) => m?.[lang]?.value || m?.en?.value || '';
    return { id, name: pick(e.labels) || q, description: pick(e.descriptions), file: claimText(e, 'P154'), site: claimText(e, 'P856') };
  }).filter(r => r.file || domainOf(r.site));

  const files = [...new Set(rows.map(r => r.file).filter(Boolean))];
  const thumbs = new Map<string, string>();
  if (files.length) {
    const info = await json<{ query?: { pages?: Record<string, { title?: string; imageinfo?: { thumburl?: string; url?: string }[] }>; normalized?: { from: string; to: string }[] } }>(fetchFn,
      logoUrl('commons.wikimedia.org', `/w/api.php?action=query&titles=${files.map(f => enc(`File:${f}`)).join('|')}&prop=imageinfo&iiprop=url&iiurlheight=120&format=json&origin=*`, apiBase));
    const norm = new Map((info.query?.normalized || []).map(n => [n.to, n.from]));
    for (const p of Object.values(info.query?.pages || {})) {
      const raw = p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url;
      const routed = raw ? routeImageUrl(raw, apiBase) : null;
      if (!p.title || !routed) continue;
      const asked = (norm.get(p.title) || p.title).replace(/^File:/, '');
      thumbs.set(asked, routed);
    }
  }
  const out: LogoCandidate[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const img = r.file ? thumbs.get(r.file) : undefined;
    if (!img || seen.has(img)) continue;
    seen.add(img);
    out.push({ id: r.id, name: r.name, description: r.description, imageUrl: img, source: 'wikidata', ...(domainOf(r.site) ? { site: domainOf(r.site)! } : {}) });
  }
  for (const r of rows) {
    const c = siteIconCandidate(r.site, apiBase);
    if (!c || seen.has(c.imageUrl) || out.some(o => o.site === c.site)) continue;
    seen.add(c.imageUrl);
    out.push({ ...c, id: r.id, name: r.name, description: r.description ? `${r.description} — website icon` : 'Website icon' });
  }
  return out.slice(0, opts.limit ?? 8);
}

/** Read an image as a data URL (fetched, not hot-linked: the board is stored and exported on its own). */
export async function fetchImageDataUrl(url: string, fetchFn: LogoFetch = (u) => fetch(u)): Promise<string> {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`The image answered ${r.status}`);
  const blob = await r.blob();
  if (!/^image\//.test(blob.type)) throw new Error('That address is not an image');
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('The image could not be read'));
    fr.readAsDataURL(blob);
  });
}

/** Scale a logo to 96 px high as a PNG, as the board does with an uploaded file, so it stays small. */
export function scaleLogo(dataUrl: string, height = 96): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, height / (img.naturalHeight || height));
      const w = Math.max(1, Math.round((img.naturalWidth || height) * k)), h = Math.max(1, Math.round((img.naturalHeight || height) * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) { reject(new Error('This browser cannot scale the image')); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('The image could not be opened'));
    img.src = dataUrl;
  });
}
