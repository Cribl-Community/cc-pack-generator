/**
 * A Cribl Lake dataset for a whiteboard demo (spec R15; plan Task 11). Pure.
 *
 * Cribl Lake API (docs.cribl.io/cribl-as-code/api-reference/control-plane/cribl-lake/datasets.md,
 * read 2026-10-31): POST /products/lake/lakes/default/datasets creates one — only `id` is
 * required; ids are letters, digits and underscores, up to 512 characters, and must not
 * match an existing Search dataset (Manage Lake Datasets). Cribl.Cloud only. A new
 * dataset is searchable at once under the `cribl_lake` Search provider.
 */

export const LAKE_DATASET_ID_RE = /^[A-Za-z0-9_]{1,512}$/;
export const DEMO_LAKE_RETENTION_DAYS = 30;
export const LAKE_RETENTION_MIN_DAYS = 1;
export const LAKE_RETENTION_MAX_DAYS = 3650;
/** No prospect name: the description is visible to everyone in the org (spec R13). */
export const DEMO_LAKE_DESCRIPTION = 'Demo dataset (Pack Generator)';

/** `Acme Bank & Co` → `demo_acme_bank_co`. The SE sees and can edit it before deploy. */
export function defaultLakeDatasetId(prospect: string): string {
  const slug = String(prospect || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return `demo_${slug || 'prospect'}`;
}

export interface LakeDatasetBody { id: string; description: string; retentionPeriodInDays: number; format: 'json' }

export function lakeDatasetBody(id: string, retentionPeriodInDays = DEMO_LAKE_RETENTION_DAYS): LakeDatasetBody {
  return { id, description: DEMO_LAKE_DESCRIPTION, retentionPeriodInDays, format: 'json' };
}

export type LakeDatasetDecision =
  | { ok: true; reuse: boolean }
  | { ok: false; message: string };

/**
 * Can the demo use this id? An existing Lake dataset is reused, never overwritten; a
 * Search dataset that is not a Lake dataset blocks (duplicate ids break Lake searches).
 */
export function lakeDatasetDecision(id: string, retentionPeriodInDays: number, lakeIds: string[], searchIds: string[], deletingIds: string[] = []): LakeDatasetDecision {
  if (!LAKE_DATASET_ID_RE.test(id)) return { ok: false, message: 'Use letters, digits and underscores only (up to 512).' };
  if (id.startsWith('cribl_') || id.startsWith('default_')) return { ok: false, message: 'Ids starting with cribl_ or default_ are Cribl’s own datasets. Pick another.' };
  if (!Number.isInteger(retentionPeriodInDays) || retentionPeriodInDays < LAKE_RETENTION_MIN_DAYS || retentionPeriodInDays > LAKE_RETENTION_MAX_DAYS) {
    return { ok: false, message: 'Keep data between 1 day and 10 years.' };
  }
  // Lake deletes asynchronously: a dataset whose deletion started is still listed for a while.
  if (deletingIds.includes(id)) return { ok: false, message: 'That dataset is being deleted. Cribl can take several minutes to finish; pick another id to go on now.' };
  if (lakeIds.includes(id)) return { ok: true, reuse: true };
  if (searchIds.includes(id)) return { ok: false, message: 'That id is taken by a Search dataset. Pick another.' };
  return { ok: true, reuse: false };
}
