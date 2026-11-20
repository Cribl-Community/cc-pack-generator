// "A newer version of this app is on the Cribl Marketplace" — the check behind the
// update popup. Spike: docs/specs/2026-11-19-marketplace-update-popup-spike.md.
//
// Why it works this way (all measured 2026-11-19):
//   - The leader cannot tell us. `GET /api/v1/apps/<id>` returns the installed version and
//     `source` but no latest/available field, and the leader UI has no update concept at all.
//     An app cannot read it anyway: the preinstall check refuses any `/apps` path in
//     policies.yml, so the app also cannot upgrade itself.
//   - The catalog can. `GET https://marketplace.cribl.io/api/v1/apps/dispensary` is anonymous,
//     CORS `*`, ~21 KB, and lists only APPROVED versions — a version still in review is not
//     announced (1.0.336 was published but 1.0.335 was listed).
//   - In the App Platform frame every external call goes through the platform proxy
//     (`<CRIBL_API_URL>/proxy/<host><path>`), so the host is in config/proxies.yml with only
//     that one path allowed.
//
// Kept free of imports so it is testable without a DOM and pulls nothing into a chunk.

export const MARKETPLACE_HOST = 'marketplace.cribl.io';
export const MARKETPLACE_CATALOG_PATH = '/api/v1/apps/dispensary';

export interface MarketplaceListing {
  name: string;
  version: string;
  status?: string;
  displayName?: string;
  date?: number;
}

export interface MarketplaceUpdate {
  appId: string;
  installed: string;
  latest: string;
  displayName: string;
  publishedAt: number | null;
}

/** X.Y.Z numeric compare; a non-semver string never compares as newer (returns null). */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Only a catalog build running inside Cribl checks. The catalog package is named `cc-…`
 * (publish-community.mjs); the dev repo builds as `pack-generator` and its version is not the
 * catalog's, so it would always look out of date. Standalone and backend have no frame to
 * show a popup in, and a git clone updates with git.
 */
export function shouldCheckMarketplace(appId: string, runMode: string): boolean {
  return runMode === 'iframe' && /^cc-[a-z0-9-]+$/.test(appId);
}

/** The proxied catalog URL inside the frame, the direct one elsewhere. */
export function marketplaceCatalogUrl(criblApiBase: string | null | undefined): string {
  const base = (criblApiBase || '').replace(/\/+$/, '');
  return base ? `${base}/proxy/${MARKETPLACE_HOST}${MARKETPLACE_CATALOG_PATH}` : `https://${MARKETPLACE_HOST}${MARKETPLACE_CATALOG_PATH}`;
}

/** The listing for `appId` (case-insensitive, as Cribl matches App IDs), approved only. */
export function findListing(catalog: unknown, appId: string): MarketplaceListing | null {
  if (!Array.isArray(catalog)) return null;
  const id = appId.toLowerCase();
  for (const raw of catalog) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name.toLowerCase() !== id || typeof e.version !== 'string') continue;
    if (e.status != null && e.status !== 'approved') continue;
    return {
      name: e.name,
      version: e.version,
      status: typeof e.status === 'string' ? e.status : undefined,
      displayName: typeof e.displayName === 'string' ? e.displayName : undefined,
      date: typeof e.date === 'number' ? e.date : undefined,
    };
  }
  return null;
}

/** An update when the catalog's approved version is strictly newer than the running one. */
export function decideMarketplaceUpdate(catalog: unknown, appId: string, installed: string): MarketplaceUpdate | null {
  const listing = findListing(catalog, appId);
  if (!listing) return null;
  const cmp = compareVersions(listing.version, installed);
  if (cmp == null || cmp <= 0) return null;
  return {
    appId,
    installed,
    latest: listing.version,
    displayName: listing.displayName || appId,
    publishedAt: listing.date ?? null,
  };
}

/**
 * Fetch the catalog and decide. NEVER throws and never blocks anything: an offline proxy, a
 * host an admin removed, a 403, bad JSON — all answer null (no popup), because "could not
 * check" must not read as "you are out of date".
 */
export async function checkMarketplaceUpdate(opts: {
  appId: string;
  installed: string;
  criblApiBase: string | null | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MarketplaceUpdate | null> {
  const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000) : null;
  try {
    const r = await f(marketplaceCatalogUrl(opts.criblApiBase), { headers: { accept: 'application/json' }, signal: ctl?.signal });
    if (!r.ok) return null;
    return decideMarketplaceUpdate(await r.json(), opts.appId, opts.installed);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Where the popup sends people. Upgrade is Organization-admin only (Apps → Installed → ⋯ →
 * Upgrade, which for a Marketplace install resolves the current catalog version); the
 * listing carries the version history. `instanceBase` is the Cribl origin without `/api/v1`.
 */
export function marketplaceUpdateLinks(instanceBase: string | null, appId: string): { installedApps: string | null; listing: string } {
  return {
    installedApps: instanceBase ? `${instanceBase.replace(/\/+$/, '')}/apps` : null,
    listing: `https://${MARKETPLACE_HOST}/apps/${encodeURIComponent(appId)}`,
  };
}
