// Pack route finality — shared by BOTH run modes (Hard Rule 18).
//
// Cribl evaluates a route table top-down and, on the first route whose filter
// matches, stops evaluating the rest IF that route is `final`. So in a pack that
// holds several pipelines, a non-last route with `final: true` silently swallows
// the event and every route below it is dead: the second/third pipeline is
// deployed, routed, and never sees data.
//
// Both route writers used to decide finality per-route at the moment of the
// write — `deploy-api.mjs` hardcoded `final: true` and ignored the caller's
// `routeFinal` entirely, so the standalone path produced exactly that dead-route
// table for every multi-pipeline pack. Finality is not a property of one route;
// it is a property of a route's POSITION in the table. This function is the one
// place that decides it, and it is applied to the whole array on every write, so
// a route written earlier (by the `.crbl` import's route.yml, or by a previous
// add-pipeline call that was the last route at the time) is corrected too.

import { parse as parseYaml } from 'yaml';

export interface PackRouteLike {
  final?: boolean;
  [key: string]: unknown;
}

/**
 * Returns the route array with `final` set positionally: only the LAST route is
 * final, everything above it passes the event on to the next route line.
 *
 * Returns new objects — callers PATCH the result, they don't own the input.
 */
export function normalizeRouteFinality<T extends PackRouteLike>(routes: T[]): T[] {
  const list = Array.isArray(routes) ? routes : [];
  return list.map((route, i) => ({ ...route, final: i === list.length - 1 }));
}

/**
 * The routes a new pack's `route.yml` declares, ready to PATCH. A `mode: 'new'`
 * deploy writes these explicitly after the upload: when the old pack can't be
 * deleted first (Cribl answers 500 while a master route still points at it) the
 * upload does not replace it, and its previous route table would silently stay
 * (seLab 2026-10-02: every demo pack kept a first route `true` that swallowed
 * the other lanes). Returns [] when the YAML has no routes.
 */
export function packRoutesFromRouteYml(routeYml: string, pipelineId?: string): Record<string, unknown>[] {
  let doc: any;
  try { doc = parseYaml(routeYml); } catch { return []; }
  const routes: any[] = Array.isArray(doc?.routes) ? doc.routes : [];
  return normalizeRouteFinality(routes.map((r, i) => ({
    ...r,
    // Same rewrite the upload gets: the first route runs the deployed pipeline.
    ...(i === 0 && pipelineId ? { pipeline: pipelineId } : {}),
    filter: r?.filter === true ? 'true' : String(r?.filter ?? 'true'),
  })));
}
