/**
 * "Draw this Cribl org as it runs now": the org's groups (stream, fleets, search) and
 * connected workers per group. GET /master/groups and /master/workers, both already
 * granted in config/policies.yml; standalone goes through the dev server's handler.
 */
import { criblFetch, proxyFetch, shouldUseBackendProxy } from '../sample-io';
import type { OrgGroup } from './templates';

export async function readOrg(): Promise<{ groups: OrgGroup[]; workers: Record<string, number> }> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/groups');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list groups');
    const groups: OrgGroup[] = data.groups || [];
    const workers: Record<string, number> = {};
    for (const g of data.groups || []) workers[g.id] = g.workerCount || 0;
    return { groups, workers };
  }
  const data = await criblFetch<{ items: OrgGroup[] }>('/master/groups');
  const workers: Record<string, number> = {};
  try {
    const w = await criblFetch<{ items: { group?: string }[] }>('/master/workers');
    for (const x of w.items || []) if (x.group) workers[x.group] = (workers[x.group] || 0) + 1;
  } catch { /* groups still draw, without their workers */ }
  return { groups: data.items || [], workers };
}
