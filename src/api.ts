export { getRunMode } from './run-mode';
import { getRunMode } from './run-mode';
import { killBackgroundCheckpoint } from './batch-kill';
import { backendReferenceLookups } from './backend-reference-lookups';
import { buildPackCrbl } from './browser-tar';
import { normalizeRouteFinality } from './route-model';
import type { SampleFingerprint, SampleGrounding } from './pack-builder';
import {
  getBundledDatatypeParsers, getDatatypeParserStore, installDatatypeParserOverlay,
} from './pack-builder';
import type { DatatypeAuditReport } from './datatype-audit';
import {
  backgroundScheduleId,
  type BackgroundArtifactWrite,
  type BackgroundBatchCheckpoint,
  type BackgroundRowArtifact,
} from './background-batch';
import {
  backgroundBatchStore, isBackgroundBatchCorruptDocumentError, tagBackgroundRunId,
} from './background-batch-store';
import type { AiProvider } from './settings-store';
import { installPackSerially } from './pack-install';
import {
  assertStageLive, describeProxyTimeout, isStageAbortError, IFRAME_PROXY_BUDGET_MS,
} from './ai-budget';
import {
  diffDatatypeOverlay, loadDatatypeOverlay, overlayIsEmpty, saveDatatypeOverlay,
} from './datatype-overlay';
import {
  eventsToLines, guardExtendedEvents, needsSampleExtension, renderExtensionFeedback,
  sampleExtensionAttempts, sampleRejectionFingerprint, SAMPLE_EXTEND_TARGET,
  type SampleExtensionAttempt,
} from './sample-library';
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage';
import { verifyGeneratedSample } from './sample-library';
import { validateExtractionStage, validateMappingStage } from './pipeline-stages';
import { goldenFormatFallbacks, mappingServesFormat } from './golden-format-fallback';
import { goldenVariantSourcetype, goldenWireFormatForSample, splitGoldenVariant } from './golden-variant';
import { nonSourceMappingGoldenReason } from './golden-source-identity';
import {
  goldenFunctionsHash, planGoldenObservation, planGoldenWrite,
  type GoldenEvidence, type GoldenObservation, type GoldenWriteAction, type StoredGolden,
} from './golden-trust';
import { buildGoldenEvidence } from './golden-evidence';
import { describeSampleProvenance, recordStoreSample, recordSyntheticLines } from './sample-provenance';
import type { SourceWireFormat } from './sample-format';
import {
  driveQualityToCompletion,
  guardQualityOperations,
  initialQualityArtifact,
  runQualityTransition,
  type QualityConf,
  type QualityOperations,
  type QualityPipelineRef,
  type QualityScore,
} from './quality-stage';
import {
  measureAuthoritative, previewWithZeroOutputRetry, resolveSampleLines,
} from './quality-measure';
import { unquoteDatagenTimestamps, isDemoInputId, isDemoOutputId, demoSampleOwner } from './demo-flow-ids';

/**
 * `bundled-data` carries the reference catalogue and source-sample corpus (itself
 * statically importing a dozen multi-hundred-KB-to-multi-MB JSON files); bundled golden
 * bodies have their own still-lazier `bundled-goldens` path, behind which sits
 * `config/golden-pipelines.json` alone at 11+ MB. Neither is needed to paint the first
 * screen: the wizard opens on the mode picker, and every consumer below is already
 * inside an async function. Loading each knowledge area on demand keeps those chunks off
 * the browser's critical path — the ORIGINAL reason these are dynamic imports.
 *
 * INJECTED, not a direct `import()`, since build 714 — a SECOND reason joined the first:
 * the "Batch — Background" Backend Function (backend/run-batch-step.ts) imports this file
 * for `deploy`/`previewPipeline`/`getGoldenPart`/etc., and Cribl caps a Backend Function
 * bundle at 5 MB. A literal `import('./bundled-data')` or `import('./bundled-goldens')`
 * ANYWHERE in this file — even behind a runtime `if (getRunMode() === 'iframe')` never
 * true for a Backend Function — makes the whole multi-MB graph behind it statically
 * reachable to any bundler walking this file, because a bundler cannot prove a runtime
 * branch dead. Measured before this fix: 17 MB bundled, ~11 MB of which was
 * `golden-pipelines.json` alone. The browser build registers the real loaders once at
 * startup (App.tsx, the only place a literal `import('./bundled-data')`/
 * `import('./bundled-goldens')` may exist); a Backend Function never does, so its
 * bundler never sees either module — every one of this file's ~10 existing `bundled()`/
 * `bundledGoldens()` call sites below (getBundledCatalog, getGoldenPipeline, etc.) is
 * UNCHANGED and keeps working for the browser exactly as before; for a context with no
 * loader registered they reject/return null instead of silently returning wrong data.
 */
let bundledDataLoader: () => Promise<any> = async () => {
  throw new Error('Bundled reference data unavailable — no loader registered in this execution context.');
};
export function setBundledDataLoader(loader: () => Promise<any>): void { bundledDataLoader = loader; }
const bundled = () => bundledDataLoader();

let bundledGoldensLoader: () => Promise<any> = async () => {
  throw new Error('Bundled goldens unavailable — no loader registered in this execution context.');
};
export function setBundledGoldensLoader(loader: () => Promise<any>): void { bundledGoldensLoader = loader; }
const bundledGoldens = () => bundledGoldensLoader();

// Transport primitives, sample I/O, and the sanitised-sample library moved to the
// AI-free `sample-io.ts` so the sanitise screens and the standalone "Sample
// Sanitizer" build can import them without dragging in the AI client. `api.ts`
// re-exports every moved symbol (existing importers unchanged) and imports back
// the primitives it uses internally. Do not move these definitions back here.
export {
  getApiBase, fetchWithDeadline, proxyFetch, isTransientFetchError, withTransientRetry,
  criblFetch, shouldUseBackendProxy, listGroups, liveCapture, listSamples, downloadSample,
  listGroupAndPackSamples, downloadPackSample,
  workerGroupSamplesPath, uploadWorkerGroupSample, isSanitisedLibrarySampleName,
  fetchSanitisedSamples, fetchSanitisedSample,
  saveSanitisedSample, deleteSanitisedSample, suitableSanitisedSampleRepo, publishSanitisedSample,
  testSanitisedSampleAccess,
} from './sample-io';
export type { SanitisedSampleLibraryState } from './sample-io';
import {
  getApiBase, proxyFetch, criblFetch, shouldUseBackendProxy, withTransientRetry,
  setBundledSanitisedBaselineLoader,
} from './sample-io';

// Register the curated sanitised-sample baseline. This is the ONE place the
// bundled-data → sanitised-baseline edge is wired; `sample-io.ts` stays free of any
// `bundled-data` import so the sanitizer chunk never references it. Registering here
// (api.ts is pack-generator-only, imported by App.tsx) runs at module init.
setBundledSanitisedBaselineLoader(() =>
  bundled().then(module => module.loadBundledSanitisedSamples()));


// --- Packs ---

export async function listPacks(group: string): Promise<{ id: string; displayName: string; version: string }[]> {
  if (shouldUseBackendProxy()) {
    const resp = await fetch(`/api/pack-generator/packs?group=${encodeURIComponent(group)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list packs');
    return data.packs;
  }
  const data = await criblFetch<{ items: any[] }>(`/m/${group}/packs`);
  return (data.items || []).map((p: any) => ({
    id: p.id,
    displayName: p.displayName || p.id,
    version: p.version || '1.0.0',
  }));
}

export async function listPackPipelines(group: string, packId: string): Promise<{ id: string; description?: string }[]> {
  if (shouldUseBackendProxy()) {
    const resp = await fetch(`/api/pack-generator/pack-pipelines?group=${encodeURIComponent(group)}&pack=${encodeURIComponent(packId)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list pipelines');
    return data.pipelines as { id: string; description?: string }[];
  }
  const data = await criblFetch<{ items: any[] }>(`/m/${group}/p/${packId}/pipelines`);
  return (data.items || []).map(p => ({ id: p.id, description: p.conf?.description || '' }));
}

export async function getPackPipeline(group: string, packId: string, pipelineId: string): Promise<{ id: string; conf: any }> {
  if (shouldUseBackendProxy()) {
    const resp = await fetch(`/api/pack-generator/pack-pipeline?group=${encodeURIComponent(group)}&pack=${encodeURIComponent(packId)}&pipeline=${encodeURIComponent(pipelineId)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to get pipeline');
    return data.pipeline;
  }
  const data = await criblFetch<{ items: any[] }>(`/m/${group}/p/${packId}/pipelines/${pipelineId}`);
  const item = data.items?.[0];
  if (!item) throw new Error(`Pipeline ${pipelineId} not found`);
  return { id: item.id, conf: item.conf };
}

// --- Demo environment ------------------------------------------------------

export interface WorkerHealth { total: number; healthy: number }

// Worker health per group. /master/groups has no worker count, so aggregate
// /master/workers by .group and count status==='healthy'.
export async function listWorkers(): Promise<Record<string, WorkerHealth>> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/workers');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list workers');
    return data.workers;
  }
  const data = await criblFetch<{ items: any[] }>('/master/workers');
  const byGroup: Record<string, WorkerHealth> = {};
  for (const w of data.items || []) {
    const g = w.group || 'unknown';
    if (!byGroup[g]) byGroup[g] = { total: 0, healthy: 0 };
    byGroup[g].total += 1;
    if (w.status === 'healthy' && !w.disconnected) byGroup[g].healthy += 1;
  }
  return byGroup;
}

/**
 * A background batch runs its Backend Function on the target group's workers,
 * so a group with none connected cannot service the invocation — the kickoff
 * just sits until the ~30s bridge timeout. Report why a group cannot host a
 * background run, or null when it can. `health` being null/undefined means the
 * /master/workers aggregate has not loaded yet: unknown, not a refusal — the
 * caller should not block on it. A zero-worker group is ABSENT from a loaded
 * aggregate (no worker rows reference it), which reads here as no healthy worker.
 */
export function backgroundGroupBlockReason(
  workerGroup: string,
  health: Record<string, WorkerHealth> | null | undefined,
): string | null {
  if (!health) return null;
  const gh = health[workerGroup];
  if (gh && gh.healthy >= 1) return null;
  return `Worker group "${workerGroup}" has no connected workers`
    + `${gh ? ` (${gh.total} configured, 0 healthy)` : ''} — a background run `
    + 'executes on the group’s workers and would have nothing to run on. '
    + 'Select a group with at least one active worker.';
}

export interface LakeDataset { id: string; description: string }

export interface SearchDataset { id: string; description: string; type: string; provider: string; searchVersion: string }

export interface SearchDatatype {
  id: string;
  description: string;
  dataFormat: string;
  lib: string;
  automaticExtraction?: Record<string, unknown>;
  additionalExtractions?: unknown[];
  schemaMap?: unknown[];
  addFields?: unknown[];
}

export interface SearchDashboardDeployment { id: string; name: string; updated: boolean }

export async function listLakeDatasets(): Promise<LakeDataset[]> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/lake-datasets');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list Lake datasets');
    return data.datasets;
  }
  const data = await criblFetch<{ items: any[] }>('/products/lake/lakes/default/datasets');
  // Exclude Cribl's built-in datasets (default_* and cribl_*) from demo targets.
  return (data.items || [])
    .filter((d: any) => { const id = String(d.id || ''); return !id.startsWith('default_') && !id.startsWith('cribl_'); })
    .map((d: any) => ({ id: d.id, description: d.description || '' }));
}

export async function listSearchDatasets(): Promise<SearchDataset[]> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/search-datasets');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list Search datasets');
    return data.datasets;
  }
  const data = await criblFetch<{ items: any[] }>('/m/default_search/search/datasets?offset=0&limit=250&explorerStats=true');
  return (data.items || []).map((d: any) => ({
    id: d.id,
    description: d.description || '',
    type: d.type || d.provider?.type || '',
    provider: d.providerId || d.provider?.id || '',
    searchVersion: d.searchVersion || '',
  })).filter((d: SearchDataset) => !!d.id && d.searchVersion === 'v1');
}

export async function listSearchDatatypes(): Promise<SearchDatatype[]> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/search-datatypes');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list Search datatypes');
    return data.datatypes;
  }
  try {
    const data = await criblFetch<{ items: SearchDatatype[] }>('/m/default_search/search/datatypes?offset=0&limit=500');
    return (data.items || []).filter(datatype => !!datatype.id).sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('Failed to fetch') || msg.includes('404') || msg.includes('not found'))
      throw new Error('Cribl Search not available — ensure a "default_search" worker group exists and Search is licensed.');
    throw e;
  }
}

export interface SearchDatatypeDeployment { id: string; updated: boolean }

export async function deploySearchDatatype(datatype: Record<string, unknown>): Promise<SearchDatatypeDeployment> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/search-datatype', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datatype }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to deploy Search datatype');
    return data;
  }
  const path = '/m/default_search/search/datatypes';
  try {
    const created = await criblFetch<{ items: any[] }>(path, { method: 'POST', body: JSON.stringify(datatype) });
    return { id: String(created.items?.[0]?.id || datatype.id), updated: false };
  } catch (createError) {
    const id = String(datatype.id || '');
    if (!id) throw createError;
    const updated = await criblFetch<{ items: any[] }>(`${path}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(datatype) });
    return { id: String(updated.items?.[0]?.id || id), updated: true };
  }
}

export async function attachSearchDatatypes(datasetId: string, datatypeIds: string[]): Promise<void> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/search-dataset-datatypes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId, datatypeIds }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to attach Search datatypes');
    return;
  }
  const path = `/m/default_search/search/datasets/${encodeURIComponent(datasetId)}`;
  const current = await criblFetch<{ items: any[] }>(path);
  const dataset = current.items?.[0];
  if (!dataset) throw new Error(`Search dataset "${datasetId}" was not found.`);
  if (dataset.searchVersion !== 'v1') throw new Error(`Search dataset "${datasetId}" must be a federated v1 dataset for Datatype v1 parsing.`);
  const existing = Array.isArray(dataset.breakerRulesets) ? dataset.breakerRulesets : [];
  const breakerRulesets = [...new Set([...datatypeIds, ...existing])];
  await criblFetch(path, { method: 'PATCH', body: JSON.stringify({ ...dataset, breakerRulesets }) });
}

export async function deploySearchDashboard(dashboard: Record<string, unknown>): Promise<SearchDashboardDeployment> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/search-dashboard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dashboard }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to deploy Search dashboard');
    return data;
  }
  const path = '/m/default_search/search/dashboards';
  try {
    const created = await criblFetch<{ items: any[] }>(path, { method: 'POST', body: JSON.stringify(dashboard) });
    const item = created.items?.[0] || dashboard;
    return { id: String(item.id || dashboard.id), name: String(item.name || dashboard.name), updated: false };
  } catch (createError) {
    const id = String(dashboard.id || '');
    if (!id) throw createError;
    const updated = await criblFetch<{ items: any[] }>(`${path}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(dashboard) });
    const item = updated.items?.[0] || dashboard;
    return { id: String(item.id || id), name: String(item.name || dashboard.name), updated: true };
  }
}

export interface DemoOutput { id: string; type: string }

// Active destinations for the routing table's per-row picker (excludes disabled).
export async function listOutputs(group: string): Promise<DemoOutput[]> {
  if (shouldUseBackendProxy()) {
    const resp = await fetch(`/api/pack-generator/outputs?group=${encodeURIComponent(group)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to list outputs');
    return data.outputs;
  }
  const data = await criblFetch<{ items: any[] }>(`/m/${group}/system/outputs`);
  return (data.items || [])
    .filter((o: any) => o.disabled !== true)
    .map((o: any) => ({ id: o.id, type: o.type }));
}

// Ensure a cribl_lake output exists for a dataset (referenced by name via
// destPath). Returns the output id to point demo routes at.
export async function ensureLakeOutput(group: string, datasetId: string): Promise<string> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/ensure-lake-output', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, datasetId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to ensure Lake output');
    return data.outputId;
  }
  const listData = await criblFetch<{ items: any[] }>(`/m/${group}/system/outputs`);
  const existing = (listData.items || []).find((o: any) => o.type === 'cribl_lake' && o.destPath === datasetId);
  if (existing) return existing.id;
  const outputId = `demo_lake_${datasetId}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  await criblFetch(`/m/${group}/system/outputs`, {
    method: 'POST',
    body: JSON.stringify({
      id: outputId, type: 'cribl_lake', destPath: datasetId, format: 'json',
      compress: 'gzip', awsAuthenticationMethod: 'auto', systemFields: ['cribl_pipe'],
    }),
  });
  return outputId;
}

const DEMO_ROUTE_PREFIX = 'demo_';

export interface DemoRouteComment { comment: string; index: number }

// Prepend the demo route block (+ its comment rows) to the worker-group MASTER
// route table (/m/<group>/routes), replacing any prior demo block, then commit + deploy.
export async function setMasterRoutes(group: string, demoRoutes: any[], demoComments: DemoRouteComment[] = []): Promise<{ routeCount: number; demoCount: number; commit: string; version: string }> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/master-routes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, demoRoutes, demoComments }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to set master routes');
    return data;
  }
  const getData = await criblFetch<{ items: any[] }>(`/m/${group}/routes`);
  const table = getData.items?.[0] || { id: 'default', routes: [] };
  const existing = Array.isArray(table.routes) ? table.routes : [];
  const nonDemo = existing.filter((r: any) => !String(r.id || '').startsWith(DEMO_ROUTE_PREFIX));
  const newRoutes = [...demoRoutes, ...nonDemo];
  // Comment rows are keyed by position in the COMBINED comments+routes list. The
  // demo block occupies the first (demoRoutes.length + demoComments.length) rows,
  // so shift each existing customer comment down by that combined count.
  const genId = () => Math.random().toString(36).slice(2, 8);
  const prevComments: any[] = Array.isArray(table.comments) ? table.comments : [];
  const demoBlockRows = demoRoutes.length + demoComments.length;
  const shiftedExisting = prevComments
    .filter((c: any) => !String(c.comment || '').startsWith('[DEMO]'))
    .map((c: any) => ({ ...c, index: (c.index || 0) + demoBlockRows }));
  const demoCommentRows = demoComments.map(c => ({ id: genId(), comment: c.comment, index: c.index }));
  const comments = [...demoCommentRows, ...shiftedExisting];
  const tableId = table.id || 'default';

  // The master route table validates each route's pipeline against an enum of
  // registered packs; a just-committed pack can lag the validator, sinking the
  // whole PATCH. Poll for pack registration, retry with backoff, and prune any
  // still-missing pack ref on the final attempt (mirrors deploy-api.mjs).
  const referencedPackIds = [...new Set(
    newRoutes.map((r: any) => String(r.pipeline || '')).filter((p: string) => p.startsWith('pack:')).map((p: string) => p.slice(5))
  )];
  const listInstalledPacks = async (): Promise<Set<string> | null> => {
    try {
      const d = await criblFetch<{ items: any[] }>(`/m/${group}/packs`);
      return new Set((d.items || []).map((p: any) => p.id));
    } catch { return null; }
  };
  if (referencedPackIds.length > 0) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const installed = await listInstalledPacks();
      if (installed && referencedPackIds.every(id => installed.has(id))) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const backoff = [1000, 2000, 3000, 4000, 5000, 6000, 8000];
  let routesToWrite = newRoutes;
  let patchOk = false, lastErr = '';
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    const isLast = attempt === backoff.length;
    if (isLast) {
      const installed = await listInstalledPacks();
      if (installed) {
        routesToWrite = newRoutes.filter((r: any) => {
          const p = String(r.pipeline || '');
          return !p.startsWith('pack:') || installed.has(p.slice(5));
        });
      }
    }
    try {
      await criblFetch(`/m/${group}/routes/${tableId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...table, id: tableId, routes: routesToWrite, comments }),
      });
      patchOk = true; break;
    } catch (e: any) {
      lastErr = e?.message || String(e);
      const invalidPipeline = lastErr.includes('Invalid Pipeline ID') || lastErr.includes('should be equal to one of the allowed');
      if (!invalidPipeline || isLast) break;
      await new Promise(r => setTimeout(r, backoff[attempt]));
    }
  }
  if (!patchOk) throw new Error(`Failed to PATCH routes: ${lastErr}`);

  const commitResult = await criblFetch<any>(`/version/commit`, {
    method: 'POST',
    body: JSON.stringify({ message: `Demo routing table (${demoRoutes.length} routes)`, group }),
  });
  const isHashD = (v: unknown): v is string => typeof v === 'string' && v.length >= 7 && /^[0-9a-f]+$/i.test(v);
  let demoDeployVersion = [commitResult?.items?.[0]?.commit, commitResult?.items?.[0]?.hash, commitResult?.commit, commitResult?.version, commitResult?.items?.[0]?.id]
    .find(v => isHashD(v)) || '';
  if (!demoDeployVersion) {
    const versions = await criblFetch<any>(`/version?group=${group}`);
    demoDeployVersion = [versions?.items?.[0]?.commit, versions?.items?.[0]?.hash, versions?.items?.[0]?.id].find(v => isHashD(v)) || '';
  }
  if (!demoDeployVersion) throw new Error('Could not resolve a config version to deploy');
  const deployResult = await criblFetch<any>(`/master/groups/${group}/deploy`, {
    method: 'PATCH',
    body: JSON.stringify({ version: demoDeployVersion }),
  });
  const version = deployResult?.items?.[0]?.configVersion || demoDeployVersion;
  const demoWritten = routesToWrite.filter((r: any) => String(r.id || '').startsWith(DEMO_ROUTE_PREFIX)).length;
  return { routeCount: routesToWrite.length, demoCount: demoWritten, commit: demoDeployVersion, version };
}

export interface DemoDatagenSource { sourcetype: string; events: (string | { _raw: string })[] }

// Create ONE active group-level datagen source with one samples[] entry per
// source; per-source sourcetype is baked into each event.
export async function createDemoDatagen(
  group: string,
  sources: DemoDatagenSource[],
  opts: { datagenId?: string; eventsPerSec?: number } = {},
): Promise<{ datagenId: string; sources: { sourcetype: string; sampleRef: string }[]; created: boolean }> {
  const datagenId = opts.datagenId || 'demo_datagen';
  const eventsPerSec = opts.eventsPerSec ?? 10;
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/demo-datagen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, sources, datagenId, eventsPerSec }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to create demo datagen');
    return data;
  }
  // iframe: build the same payloads and hit the platform API directly.
  const samplesRef: { eventsPerSec: number; sample: string }[] = [];
  const perSource: { sourcetype: string; sampleRef: string }[] = [];
  // Datagen references samples by the id Cribl ASSIGNS on upload (a random
  // token), NOT the filename — look up existing ones for re-run refresh.
  const existing = await criblFetch<{ items: any[] }>(`/m/${group}/system/samples`).catch(() => ({ items: [] }));
  const existingByName = new Map((existing.items || []).map((s: any) => [s.sampleName, s.id]));
  for (const src of sources) {
    const st = src.sourcetype;
    const fileName = `${datagenId}_${st}.log`.toLowerCase().replace(/[^a-z0-9_.]/g, '_');
    const events = (src.events || []).map((evt: any) => {
      let raw: string;
      if (typeof evt === 'object' && evt !== null && evt._raw) raw = evt._raw;
      else if (typeof evt === 'string') raw = evt;
      else raw = JSON.stringify(evt);
      try {
        const parsed = JSON.parse(raw);
        if (parsed._time) parsed._time = '${timestamp:%s.%L}';
        if (parsed.timestamp) parsed.timestamp = '${timestamp:%s.%L}';
        raw = unquoteDatagenTimestamps(JSON.stringify(parsed));
      } catch { /* not JSON */ }
      return { _raw: raw, _time: Date.now() / 1000, sourcetype: st };
    });
    const sampleBody = { sampleName: fileName, isTemplate: true, tsTemplateField: '', context: { events } };
    let sampleId = existingByName.get(fileName) as string | undefined;
    if (sampleId) {
      // Re-run: PATCH the existing sample by its id, keeping the reference stable.
      await criblFetch(`/m/${group}/system/samples/${encodeURIComponent(sampleId)}`, {
        method: 'PATCH', body: JSON.stringify({ id: sampleId, ...sampleBody }),
      }).catch(() => {});
    } else {
      const up = await criblFetch<any>(`/m/${group}/system/samples`, { method: 'POST', body: JSON.stringify(sampleBody) });
      sampleId = up?.items?.[0]?.id || up?.id;
    }
    if (!sampleId) continue;
    samplesRef.push({ eventsPerSec, sample: sampleId });
    perSource.push({ sourcetype: st, sampleRef: sampleId });
  }
  const inputBody = {
    id: datagenId, type: 'datagen', disabled: false, stoppedBehavior: 'manual',
    sendToRoutes: true, throttleRatePerSec: 0, pqEnabled: false,
    streamtags: ['demo'], connections: [], metadata: [], samples: samplesRef,
    description: `Demo datagen — ${sources.length} source(s): ${sources.map(s => s.sourcetype).join(', ')}`,
  };
  try {
    await criblFetch(`/m/${group}/system/inputs`, { method: 'POST', body: JSON.stringify(inputBody) });
  } catch {
    await criblFetch(`/m/${group}/system/inputs/${datagenId}`, { method: 'PATCH', body: JSON.stringify(inputBody) });
  }
  return { datagenId, sources: perSource, created: true };
}

const DEMO_PACK_PREFIX = 'demo-';

// Remove routes (by id) and re-key comments. Comment `index` is the position in
// the COMBINED comments+routes list, so rebuild that list, drop removed routes +
// any [DEMO] comment anchoring a removed route, then renumber survivors.
function pruneRoutesAndComments(routes: any[], comments: any[], removeRouteIds: string[]): { routes: any[]; comments: any[] } {
  const idSet = new Set(removeRouteIds);
  const total = routes.length + comments.length;
  const commentAt = new Map<number, any>();
  for (const c of comments) commentAt.set(c.index || 0, c);
  const combined: { kind: 'route' | 'comment'; r?: any; c?: any }[] = [];
  let ri = 0;
  for (let pos = 0; pos < total; pos++) {
    if (commentAt.has(pos)) combined.push({ kind: 'comment', c: commentAt.get(pos) });
    else if (ri < routes.length) combined.push({ kind: 'route', r: routes[ri++] });
  }
  const removedPositions = new Set<number>();
  combined.forEach((e, pos) => { if (e.kind === 'route' && idSet.has(e.r.id)) removedPositions.add(pos); });
  const keptRoutes: any[] = [];
  const keptCombined: typeof combined = [];
  combined.forEach((e, pos) => {
    if (e.kind === 'route') {
      if (!idSet.has(e.r.id)) { keptRoutes.push(e.r); keptCombined.push(e); }
    } else {
      const isDemo = String(e.c.comment || '').startsWith('[DEMO]');
      if (!(isDemo && removedPositions.has(pos + 1))) keptCombined.push(e);
    }
  });
  const keptComments: any[] = [];
  keptCombined.forEach((e, pos) => { if (e.kind === 'comment') keptComments.push({ ...e.c, index: pos }); });
  return { routes: keptRoutes, comments: keptComments };
}

export interface DemoScanResult {
  routes: { id: string; name: string; pipeline: string; output: string }[];
  datagens: { id: string; sampleCount: number; description: string }[];
  packs: { id: string; displayName: string; version: string }[];
  outputs: { id: string; type: string; destPath: string }[];
}

// Scan a worker group for existing demo artifacts (by demo_ / demo- naming).
export async function scanDemo(group: string): Promise<DemoScanResult> {
  if (shouldUseBackendProxy()) {
    const resp = await fetch(`/api/pack-generator/demo-scan?group=${encodeURIComponent(group)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to scan demo artifacts');
    return data;
  }
  const [rt, inputs, packs, outputs] = await Promise.all([
    criblFetch<{ items: any[] }>(`/m/${group}/routes`),
    criblFetch<{ items: any[] }>(`/m/${group}/system/inputs`),
    criblFetch<{ items: any[] }>(`/m/${group}/packs`),
    criblFetch<{ items: any[] }>(`/m/${group}/system/outputs`),
  ]);
  return {
    routes: (rt.items?.[0]?.routes || [])
      .filter((r: any) => String(r.id || '').startsWith(DEMO_ROUTE_PREFIX))
      .map((r: any) => ({ id: r.id, name: r.name, pipeline: r.pipeline, output: r.output })),
    datagens: (inputs.items || [])
      .filter((i: any) => isDemoInputId(String(i.id || '')))
      .map((i: any) => ({ id: i.id, sampleCount: (i.samples || []).length, description: i.description || '' })),
    packs: (packs.items || [])
      .filter((p: any) => String(p.id || '').startsWith(DEMO_PACK_PREFIX))
      .map((p: any) => ({ id: p.id, displayName: p.displayName || p.id, version: p.version || '' })),
    outputs: (outputs.items || [])
      .filter((o: any) => isDemoOutputId(String(o.id || '')))
      .map((o: any) => ({ id: o.id, type: o.type, destPath: o.destPath || '' })),
  };
}

export interface DemoCleanupResult {
  removed: { routes: string[]; datagens: string[]; packs: string[]; outputs: string[] };
  errors: string[];
  commit: string;
}

// Remove SELECTED demo artifacts in sequence: routes → datagen → packs → outputs.
// Only the passed ids are touched; route removal also drops the matching [DEMO] comments.
export async function cleanupDemo(group: string, sel: { routeIds: string[]; datagenIds: string[]; packIds: string[]; outputIds?: string[] }): Promise<DemoCleanupResult> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/demo-cleanup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, ...sel }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to clean up demo artifacts');
    return data;
  }
  const removed = { routes: [] as string[], datagens: [] as string[], packs: [] as string[], outputs: [] as string[] };
  const errors: string[] = [];
  const outputIds = sel.outputIds || [];

  // 1. Routing — remove selected demo routes + their [DEMO] comment memos.
  if (sel.routeIds.length > 0) {
    const rt = await criblFetch<{ items: any[] }>(`/m/${group}/routes`);
    const table = rt.items?.[0];
    if (table) {
      const { routes: keptRoutes, comments: keptComments } = pruneRoutesAndComments(
        Array.isArray(table.routes) ? table.routes : [],
        Array.isArray(table.comments) ? table.comments : [],
        sel.routeIds,
      );
      try {
        await criblFetch(`/m/${group}/routes/${table.id || 'default'}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...table, id: table.id || 'default', routes: keptRoutes, comments: keptComments }),
        });
        removed.routes = sel.routeIds;
      } catch (e: any) { errors.push(`routes: ${e.message}`); }
    }
  }

  // 2. Datagen — delete selected inputs + their group-level sample files. The
  // owner of a sample is resolved against EVERY demo datagen (lane ids prefix each other).
  const allDemoInputs = sel.datagenIds.length > 0
    ? ((await criblFetch<{ items: any[] }>(`/m/${group}/system/inputs`).catch(() => ({ items: [] }))).items || [])
        .map((i: any) => String(i.id || '')).filter(isDemoInputId)
    : [];
  for (const id of sel.datagenIds) {
    try { await criblFetch(`/m/${group}/system/inputs/${id}`, { method: 'DELETE' }); removed.datagens.push(id); }
    catch (e: any) { errors.push(`datagen ${id}: ${e.message}`); }
  }
  if (sel.datagenIds.length > 0) {
    const samples = await criblFetch<{ items: any[] }>(`/m/${group}/system/samples`).catch(() => ({ items: [] }));
    for (const s of samples.items || []) {
      const name = String(s.sampleName || '');
      const owner = demoSampleOwner(name, [...new Set([...allDemoInputs, ...sel.datagenIds])]);
      if (owner && sel.datagenIds.includes(owner)) {
        await criblFetch(`/m/${group}/system/samples/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  }

  // 3. Packs — delete selected demo packs.
  for (const id of sel.packIds) {
    try { await criblFetch(`/m/${group}/packs/${id}`, { method: 'DELETE' }); removed.packs.push(id); }
    catch (e: any) { errors.push(`pack ${id}: ${e.message}`); }
  }

  // 4. Outputs — delete selected demo Cribl Lake outputs (after their routes are gone).
  for (const id of outputIds) {
    try { await criblFetch(`/m/${group}/system/outputs/${id}`, { method: 'DELETE' }); removed.outputs.push(id); }
    catch (e: any) { errors.push(`output ${id}: ${e.message}`); }
  }

  // Commit + deploy.
  const commitResult = await criblFetch<any>(`/version/commit`, {
    method: 'POST',
    body: JSON.stringify({ message: `Clean up demo artifacts (${removed.routes.length} routes, ${removed.datagens.length} datagens, ${removed.packs.length} packs, ${removed.outputs.length} outputs)`, group }),
  });
  const isHashC = (v: unknown): v is string => typeof v === 'string' && v.length >= 7 && /^[0-9a-f]+$/i.test(v);
  let cleanupVersion = [commitResult?.items?.[0]?.commit, commitResult?.items?.[0]?.hash, commitResult?.commit, commitResult?.version, commitResult?.items?.[0]?.id]
    .find(v => isHashC(v)) || '';
  if (!cleanupVersion) {
    const versions = await criblFetch<any>(`/version?group=${group}`);
    cleanupVersion = [versions?.items?.[0]?.commit, versions?.items?.[0]?.hash, versions?.items?.[0]?.id, versions?.commit].find(v => isHashC(v)) || '';
  }
  if (!cleanupVersion) throw new Error('Could not resolve version for deploy after cleanup commit');
  await criblFetch(`/master/groups/${group}/deploy`, { method: 'PATCH', body: JSON.stringify({ version: cleanupVersion }) });
  return { removed, errors, commit: cleanupVersion };
}


export async function getPackSample(
  workerGroup: string,
  packId: string,
  preferredName = '',
): Promise<{ id: string; name: string; events: string[] } | null> {
  if (shouldUseBackendProxy()) {
    const params = new URLSearchParams({ group: workerGroup, pack: packId });
    if (preferredName) params.set('name', preferredName);
    const resp = await fetch(`/api/pack-generator/pack-sample?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to get pack sample');
    return data.sample || null;
  }
  const listed = await criblFetch<{ items: any[] }>(`/m/${workerGroup}/p/${packId}/system/samples`);
  const samples = listed.items || [];
  // Prefer an exact / substring match. Never fall back to samples[0] when a
  // preferred name was asked for — that silently scores weblog through a PAN
  // pipeline (and similar) and produces junk mid-range scores.
  const sample = preferredName
    ? (samples.find(s => s.sampleName === preferredName)
      || samples.find(s => String(s.sampleName || '').includes(preferredName))
      || null)
    : samples[0];
  if (!sample) return null;
  const content = await criblFetch<any[]>(`/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(sample.id)}/content`);
  const events = (Array.isArray(content) ? content : []).map((evt: any) => {
    if (evt?._raw != null) return String(evt._raw);
    const { __criblEventType, __ctrlFields, __final, __cloneCount, ...fields } = evt || {};
    return JSON.stringify(fields);
  });
  return { id: sample.id, name: sample.sampleName || sample.id, events };
}

// Upload (or replace) sample events into a pack. Stable names like
// `<pipelineId>_sample.log` are reused on optimize/re-run — Cribl POST returns
// 409 when the name already exists, so this upserts (PATCH existing, else POST).
export async function uploadPackSample(
  workerGroup: string,
  packId: string,
  sampleName: string,
  events: string[],
): Promise<string | null> {
  if (events.length === 0) return null;
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/pack-sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerGroup, packId, sampleName, events }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to upload pack sample');
    return data.sampleId || sampleName;
  }
  const payload = events.map((evt) => ({
    _raw: evt,
    _time: Date.now() / 1000,
  }));
  const sampleBody = { sampleName, context: { events: payload } };
  const listed = await criblFetch<{ items: any[] }>(`/m/${workerGroup}/p/${packId}/system/samples`).catch(() => ({ items: [] }));
  const existing = (listed.items || []).find((s: any) => s.sampleName === sampleName);
  if (existing?.id) {
    await criblFetch(`/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ id: existing.id, ...sampleBody }),
    });
    return existing.id;
  }
  const uploaded = await criblFetch<any>(`/m/${workerGroup}/p/${packId}/system/samples`, {
    method: 'POST',
    body: JSON.stringify(sampleBody),
  });
  return uploaded?.items?.[0]?.id || uploaded?.id || sampleName;
}

export async function deletePackSample(workerGroup: string, packId: string, sampleId: string): Promise<void> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/pack-sample', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerGroup, packId, sampleId }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to delete pack sample');
    return;
  }
  await criblFetch(`/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(sampleId)}`, {
    method: 'DELETE',
  });
}

// --- Deploy ---

// Replace any arrow ("→", "->", "-->", "⟶", "➜", …) in the pack's
// displayName/description with the word "to", collapsing surrounding spaces so
// "aws_cloudtrail → CIM" reads "aws_cloudtrail to CIM". Mutates in place.
const ARROW_RE = /\s*(?:-{1,2}>|—>|–>|→|⟶|➜|➔|►)\s*/g;
function sanitizePackDescription(pkg: any): void {
  if (!pkg || typeof pkg !== 'object') return;
  for (const key of ['description', 'displayName'] as const) {
    if (typeof pkg[key] === 'string' && ARROW_RE.test(pkg[key])) {
      pkg[key] = pkg[key].replace(ARROW_RE, ' to ').replace(/\s{2,}/g, ' ').trim();
    }
    ARROW_RE.lastIndex = 0; // reset global regex state between fields
  }
}

export async function deploy(payload: any, log: (msg: string) => void): Promise<{ packId: string; pipelineId: string; commit: string; version: string; mode: string; bundledLookups?: { file: string; rows: number }[] }> {
  // Pack descriptions must read "<source> to <FORMAT>", never with an arrow.
  // Sanitize at the single deploy choke point so it catches literal strings AND
  // any AI-generated description, in both iframe and standalone paths.
  sanitizePackDescription(payload?.packageJson);

  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Deploy failed: ${resp.status} — ${body}`);
    }
    return resp.json();
  }

  // Iframe mode: call Cribl API directly (platform handles auth)
  const { packId, pipelineId = 'transform', workerGroup, packageJson, pipelineConf, mode = 'new', routeFilter, sourcetype, deferDeploy } = payload;


  if (mode === 'new') {
    log('Building pack archive...');
    const crblBlob = await buildPackCrbl({
      packId,
      pipelineId,
      packageJson,
      routeYml: payload.routeYml,
      pipelineYml: payload.pipelineYml,
      sampleId: payload.sampleId,
      samplesYml: payload.samplesYml,
      sampleData: payload.sampleData,
      readme: payload.readme,
      breakerYml: payload.breakerYml,
    });

    // One install at a time per app, old pack confirmed gone first — see src/pack-install.ts.
    const packPath = `/m/${workerGroup}/packs/${packId}`;
    await installPackSerially(packId, {
      remove: async () => {
        log('Deleting existing pack (if any)...');
        await criblFetch(packPath, { method: 'DELETE' });
      },
      exists: async () => {
        try { await criblFetch(packPath); return true; } catch (err) {
          if (/\(404\)/.test(err instanceof Error ? err.message : String(err))) return false;
          throw err;
        }
      },
      upload: async () => {
        log('Uploading pack...');
        const uploadResp = await fetch(`${getApiBase()}/m/${workerGroup}/packs?filename=${packId}.crbl`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: crblBlob,
        });
        if (!uploadResp.ok) {
          const text = await uploadResp.text();
          throw new Error(`Pack upload failed: ${uploadResp.status} — ${text}`);
        }
        return (await uploadResp.json()).source;
      },
      install: async source => {
        log('Installing pack...');
        await criblFetch<any>(`/m/${workerGroup}/packs`, { method: 'POST', body: JSON.stringify({ source }) });
      },
      log,
    });
  }


  // Push pipeline (PATCH updates what's in the .crbl; POST creates for add-pipeline mode)
  log('Pushing pipeline...');
  const pipelinePayload = { id: pipelineId, conf: pipelineConf };
  // Both directions fall back to the other verb (Hard Rule 18 — mirrors the
  // standalone handler in deploy-api.mjs): the 3-stage builder may already have
  // created the pipeline while scoring its stages, so a create can conflict, and
  // a .crbl import may not have created it, so an update can 404. Either way the
  // row must not fail on a verb choice.
  const writePipeline = async (createFirst: boolean) => {
    const create = () => criblFetch(`/m/${workerGroup}/p/${packId}/pipelines`, { method: 'POST', body: JSON.stringify(pipelinePayload) });
    const update = () => criblFetch(`/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, { method: 'PATCH', body: JSON.stringify(pipelinePayload) });
    try {
      await (createFirst ? create() : update());
    } catch {
      await (createFirst ? update() : create());
    }
  };
  await writePipeline(mode === 'add-pipeline');

  // Update route
  log('Configuring route...');
  const newRoute = {
    id: pipelineId,
    name: `${pipelineId} Route`,
    final: payload.routeFinal !== undefined ? payload.routeFinal : true,
    disabled: false,
    pipeline: pipelineId,
    description: '',
    enableOutputExpression: false,
    filter: routeFilter || `sourcetype=='${sourcetype || 'unknown'}'`,
    clones: [],
    output: 'default',
  };

  let existingRoutes: any[] = [];
  try {
    const routeData = await criblFetch<any>(`/m/${workerGroup}/p/${packId}/routes`);
    const routeItem = routeData?.items?.[0] || routeData;
    existingRoutes = (routeItem?.routes || []).map((r: any) => ({
      ...r,
      clones: Array.isArray(r.clones) && r.clones.length > 0 && Object.keys(r.clones[0] || {}).length === 0 ? [] : (r.clones || []),
    }));
  } catch { /* new pack, no routes yet */ }

  // Only the LAST route may be final — see src/route-model.ts. `routeFinal` above
  // is the caller's intent; this enforces it for the whole table, including routes
  // the `.crbl` import's route.yml wrote as final before a second pipeline existed.
  const updatedRoutes = normalizeRouteFinality(mode === 'add-pipeline' ? [...existingRoutes, newRoute] : [newRoute]);
  await criblFetch(`/m/${workerGroup}/p/${packId}/routes/default`, {
    method: 'PATCH',
    body: JSON.stringify({ id: 'default', routes: updatedRoutes }),
  });

  // Upload sample data if provided
  if (payload.sampleData && payload.sampleData.length > 0) {
    log('Uploading sample data...');
    // Sample is named by sourcetype (destination-independent, shared across a
    // pack's pipelines). Fall back to the pipeline id only if no sourcetype.
    const sampleName = payload.sampleName || (payload.sourcetype ? `${payload.sourcetype}_sample.log` : `${pipelineId}_sample.log`);
    const events = payload.sampleData.map((evt: any) => {
      // structuredSample: the events are ALREADY-PROCESSED output (a post-processing
      // pack's input = the upstream pipeline's output, exactly as emitted), so keep
      // every field — with or without a `_raw` (a Windows XML parser consumes it).
      // Otherwise a sample is vendor text the pipeline must parse, and parsed-JSON
      // fields must not pre-empt that — reduce to _raw/_time.
      if (payload.structuredSample && typeof evt === 'object' && evt !== null) {
        return { ...stripCtrl(evt), _time: evt._time || Date.now() / 1000 };
      }
      if (typeof evt === 'object' && evt !== null && evt._raw) {
        return { _raw: evt._raw, _time: evt._time || Date.now() / 1000 };
      }
      if (typeof evt === 'string') {
        return { _raw: evt, _time: Date.now() / 1000 };
      }
      return { _raw: JSON.stringify(evt), _time: Date.now() / 1000 };
    });
    // Sample names are deterministic per sourcetype+format (`<pipelineId>_sample.log`),
    // so a re-run / add-pipeline reuses the SAME name. Cribl POST returns 409 when the
    // name already exists and would KEEP the old sample — which the post-deploy quality
    // flow then scores the new pipeline against (build 586 bug). Upsert: PATCH the
    // existing sample id so the freshly selected events overwrite it.
    const listedSamples = await criblFetch<{ items: any[] }>(`/m/${workerGroup}/p/${packId}/system/samples`).catch(() => ({ items: [] }));
    const existingSample = (listedSamples.items || []).find((s: any) => s.sampleName === sampleName);
    if (existingSample?.id) {
      await criblFetch(`/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(existingSample.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ id: existingSample.id, sampleName, context: { events } }),
      });
    } else {
      await criblFetch(`/m/${workerGroup}/p/${packId}/system/samples`, {
        method: 'POST',
        body: JSON.stringify({ sampleName, context: { events } }),
      });
    }
  }

  // Create datagen source if requested (after sample upload so it can reference it)
  if (payload.createDatagen && payload.sampleData && payload.sampleData.length > 0) {
    log('Creating datagen source...');
    const datagenId = `${pipelineId}_datagen`;
    const datagenFileName = `${pipelineId}_events.log`;

    try {
      // Upload dedicated datagen file with timestamp templates
      // Datagen files live at group level (not pack-scoped)
      const datagenEvents = payload.sampleData.map((evt: any) => {
        let raw: string;
        if (typeof evt === 'object' && evt !== null && evt._raw) raw = evt._raw;
        else if (typeof evt === 'string') raw = evt;
        else raw = JSON.stringify(evt);
        try {
          const parsed = JSON.parse(raw);
          if (parsed._time) parsed._time = '${timestamp:%s.%L}';
          if (parsed.timestamp) parsed.timestamp = '${timestamp:%s.%L}';
          raw = JSON.stringify(parsed).replace(/"(\$\{timestamp:%s\.%L\})"/g, '$1');
        } catch { /* not JSON — use as-is */ }
        return { _raw: raw, _time: Date.now() / 1000 };
      });
      // isTemplate:true makes the file available to the datagen source on workers
      await criblFetch(`/m/${workerGroup}/system/samples`, {
        method: 'POST',
        body: JSON.stringify({ sampleName: datagenFileName, isTemplate: true, tsTemplateField: '', context: { events: datagenEvents } }),
      });

      // Datagen source must be at group level (pack-scoped sources can't find the file)
      const datagenSampleRef = datagenFileName.replace(/\.log$/, '');
      await criblFetch(`/m/${workerGroup}/system/inputs`, {
        method: 'POST',
        body: JSON.stringify({
          id: datagenId,
          type: 'datagen',
          disabled: true,
          stoppedBehavior: 'manual',
          sendToRoutes: true,
          throttleRatePerSec: 10,
          pqEnabled: false,
          streamtags: [],
          connections: [],
          metadata: [],
          fields: [{ name: 'sourcetype', value: `'${payload.sourcetype || 'unknown'}'` }],
          samples: [{ eventsPerSec: 10, sample: datagenSampleRef }],
          description: `Datagen for ${pipelineId}`,
        }),
      });
      log('Datagen source created (disabled).');
    } catch (e: any) {
      log(`Datagen source failed: ${e.message}`);
    }
  }

  // Bundle golden lookups into the pack so lookup-driven parsing resolves at
  // runtime (e.g. cisco_asa_parsing.csv with all 184 codes). The browser can't
  // read the filesystem, so App.tsx fetches the content and passes it in
  // payload.referenceLookups; we upload each to the pack's lookups API.
  const refLookups = payload.referenceLookups as { file: string; content: string; description?: string; rows?: number }[] | undefined;
  const bundledLookups: { file: string; rows: number }[] = [];
  if (refLookups && refLookups.length > 0) {
    log(`Bundling ${refLookups.length} reference lookup(s) into pack...`);
    for (const lk of refLookups) {
      try {
        // POST creates; on conflict (pack re-deploy / add-pipeline) PATCH to
        // UPDATE the content so a stale lookup can't persist.
        try {
          await criblFetch(`/m/${workerGroup}/p/${packId}/system/lookups`, {
            method: 'POST',
            body: JSON.stringify({ id: lk.file, content: lk.content, description: lk.description || '' }),
          });
        } catch {
          await criblFetch(`/m/${workerGroup}/p/${packId}/system/lookups/${encodeURIComponent(lk.file)}`, {
            method: 'PATCH',
            body: JSON.stringify({ id: lk.file, content: lk.content, description: lk.description || '' }),
          });
        }
        bundledLookups.push({ file: lk.file, rows: lk.rows || 0 });
        log(`  ✓ ${lk.file} (${lk.rows || 0} rows)`);
      } catch (e: any) {
        log(`  ⚠ ${lk.file}: ${e.message}`);
      }
    }
  }

  // Commit + deploy (skip when deferDeploy — batch will commit once at the end)
  if (deferDeploy) {
    log('Deferred — skipping commit/deploy (batch will commit once at end).');
    return { packId, pipelineId, commit: 'deferred', version: 'deferred', mode, bundledLookups };
  }

  log('Committing...');
  const commitMsg = mode === 'new' ? `Deploy pack ${packId}` : `Add pipeline ${pipelineId} to pack ${packId}`;
  const commitResult = await criblFetch<any>(`/version/commit`, {
    method: 'POST',
    body: JSON.stringify({ message: commitMsg, group: workerGroup }),
  });
  const isHash = (v: unknown): v is string => typeof v === 'string' && v.length >= 7 && /^[0-9a-f]+$/i.test(v);
  const rawCommit = commitResult?.items?.[0]?.commit || commitResult?.items?.[0]?.hash || commitResult?.commit || commitResult?.version || commitResult?.items?.[0]?.id || '';
  const commit = isHash(rawCommit) ? rawCommit : '';
  log(`Commit: ${commit || `(no valid hash — raw keys: ${JSON.stringify(Object.keys(commitResult?.items?.[0] || commitResult || {})).slice(0, 120)})`}`);

  // Deploy — version is required; if commit didn't return a valid hash, fetch the latest
  let deployVersion = commit;
  if (!deployVersion) {
    const versions = await criblFetch<any>(`/version?group=${workerGroup}`);
    deployVersion = [versions?.items?.[0]?.commit, versions?.items?.[0]?.hash, versions?.items?.[0]?.id, versions?.commit, versions?.version]
      .find(v => isHash(v)) || '';
    log(`Fetched latest version: ${deployVersion || `(none — version keys: ${JSON.stringify(Object.keys(versions?.items?.[0] || versions || {})).slice(0, 120)})`}`);
  }
  if (!deployVersion) throw new Error('Could not resolve a config version to deploy — commit returned no version hash');

  log(`Deploying version ${deployVersion} to worker group...`);
  const deployResult = await criblFetch<any>(`/master/groups/${workerGroup}/deploy`, {
    method: 'PATCH',
    body: JSON.stringify({ version: deployVersion }),
  });
  const version = deployResult?.items?.[0]?.configVersion || deployVersion;

  return { packId, pipelineId, commit: deployVersion, version, mode, bundledLookups };
}

// PATCH a candidate pipeline conf into an existing pack for preview/scoring —
// no pack recreate, no commit, no deploy. Used by the 3-stage experiment so it
// tries many candidates against ONE pack instead of redeploying each time.
export async function patchPipeline(packId: string, pipelineId: string, workerGroup: string, pipelineConf: any): Promise<void> {
  if (shouldUseBackendProxy()) {
    await withTransientRetry(async () => {
      const resp = await proxyFetch('/api/pack-generator/patch-pipeline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId, pipelineId, workerGroup, pipelineConf }),
      });
      if (!resp.ok) throw new Error(`patch-pipeline failed: ${resp.status} — ${await resp.text()}`);
    }, { label: 'patchPipeline' });
    return;
  }
  // iframe: POST-then-PATCH the pipeline directly, then a short settle.
  await withTransientRetry(async () => {
    const payload = JSON.stringify({ id: pipelineId, conf: pipelineConf });
    let r = await fetch(`${getApiBase()}/m/${workerGroup}/p/${packId}/pipelines`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    if (!r.ok) r = await fetch(`${getApiBase()}/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload });
    if (!r.ok) throw new Error(`pipeline write failed: ${r.status}`);
    await new Promise(rz => setTimeout(rz, 600));
  }, { label: 'patchPipeline-iframe' });
}

// Commit + deploy a worker group once (final step of the deferred 3-stage flow).
export async function commitDeploy(workerGroup: string, message?: string): Promise<{ commit: string; version: string }> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/commit-deploy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerGroup, message }),
    });
    if (!resp.ok) throw new Error(`commit-deploy failed: ${resp.status} — ${await resp.text()}`);
    return resp.json();
  }
  const commitResult = await criblFetch<any>('/version/commit', { method: 'POST', body: JSON.stringify({ message: message || `Deploy ${workerGroup}`, group: workerGroup }) });
  const isH = (v: unknown): v is string => typeof v === 'string' && v.length >= 7 && /^[0-9a-f]+$/i.test(v);
  let deployVersion = [commitResult?.items?.[0]?.commit, commitResult?.items?.[0]?.hash, commitResult?.commit, commitResult?.version, commitResult?.items?.[0]?.id]
    .find(v => isH(v)) || '';
  if (!deployVersion) {
    const versions = await criblFetch<any>(`/version?group=${workerGroup}`);
    deployVersion = [versions?.items?.[0]?.commit, versions?.items?.[0]?.hash, versions?.items?.[0]?.id, versions?.commit].find(v => isH(v)) || '';
  }
  if (!deployVersion) throw new Error('Could not resolve a config version to deploy');
  const deployResult = await criblFetch<any>(`/master/groups/${workerGroup}/deploy`, { method: 'PATCH', body: JSON.stringify({ version: deployVersion }) });
  return { commit: deployVersion, version: deployResult?.items?.[0]?.configVersion || deployVersion };
}

// --- AI endpoints ---
// In standalone+devproxy: route through Vite backend handlers (Node.js can reach http://ai-gateway.example/bedrock)
// In standalone+other providers OR iframe: call directly from frontend via ai-client

import {
  isAiConfigured,
  loadSettings,
  loadQualitySettings,
  saveLakeToken,
  saveGoldenReadToken,
  aiValidateSourcetype,
  aiDetectSourcetype,
  aiAdvise as aiAdviseClient,
  analyzeBuildTrace as analyzeBuildTraceClient,
  aiGenerateSamples,
  aiGenerateParse,
  aiGenerateMapping,
  validateMappingResult,
  aiScorePipelineOutput,
  aiRepairPipeline,
  invokeAi,
  invalidateAiHealthCache,
  AI_HEALTH_CACHE_KEY,
  canBackgroundUseProvider,
  installBackendAiSnapshot,
  type AiMappingResult,
  type AiProgressCallback,
} from './ai-client';

export { canBackgroundUseProvider, installBackendAiSnapshot };

export function aiAvailable(): boolean {
  const settings = loadSettings();
  if (settings.provider === 'devproxy') return true;
  if (getRunMode() === 'standalone') return true;
  return isAiConfigured();
}

export interface AiHealth {
  reachable: boolean;   // the AI endpoint answered at all
  modelOk: boolean;     // the SELECTED model returned usable text
  model: string;
  latencyMs: number;
  error: string;
  attempts?: number;    // probes spent before this verdict (see ai-health.mjs)
}

/**
 * The probe is a real model round trip, so a successful result is cached for the tab.
 *
 * What it proves — this endpoint answers and this model id returns text — cannot change
 * without the endpoint or the model id changing, which is why the key is exactly those two
 * plus the provider. Without the cache the app re-probed on every reload and every visit to
 * the Settings modal, and the header sat on "checking" for the model's full latency each
 * time. sessionStorage rather than localStorage so a new tab still verifies once, and only
 * healthy results are stored: a failure is usually transient and worth retrying.
 */
const AI_HEALTH_TTL_MS = 30 * 60 * 1000;

function aiHealthCacheKey(): string {
  const s = loadSettings();
  return [s.provider || '', s.devProxyUrl || '', s.model || ''].join('|');
}

function readAiHealthCache(): AiHealth | null {
  try {
    const raw = sessionStorage.getItem(AI_HEALTH_CACHE_KEY);
    if (!raw) return null;
    const { key, at, health } = JSON.parse(raw);
    if (key !== aiHealthCacheKey()) return null;
    if (!at || Date.now() - at > AI_HEALTH_TTL_MS) return null;
    return health as AiHealth;
  } catch { return null; }
}

function writeAiHealthCache(health: AiHealth): void {
  if (!health.reachable || !health.modelOk) return;
  try {
    sessionStorage.setItem(AI_HEALTH_CACHE_KEY, JSON.stringify({ key: aiHealthCacheKey(), at: Date.now(), health }));
  } catch { /* sandboxed iframe — probe every time, which is the old behaviour */ }
}

/**
 * Drops the cached result so the next check re-probes. For the manual Test button,
 * for a settings change — and, from invokeAi, for any AI call that actually fails,
 * so a green tick cannot outlive working AI.
 */
export function invalidateAiHealth(): void {
  invalidateAiHealthCache();
}

// Fast startup probe: is AI reachable AND does the selected model actually
// return text? Reasoning models (claude-sonnet-5+) return a leading empty
// `thinking` block; a mis-set model id can 200 with no text. Both silently
// produced empty samples/parse across the app — surface it at boot instead.
let aiHealthInFlight: Promise<AiHealth> | null = null;

export async function checkAiHealth(opts?: { force?: boolean }): Promise<AiHealth> {
  if (!opts?.force) {
    const cached = readAiHealthCache();
    if (cached) return cached;
    // Concurrent callers share one round trip. The cache alone cannot collapse these,
    // because nothing has been written yet while the first probe is still open — which is
    // exactly the case under React's development double-invoked effects.
    if (aiHealthInFlight) return aiHealthInFlight;
  }
  const probe = probeAiHealth().then(health => { writeAiHealthCache(health); return health; });
  aiHealthInFlight = probe;
  try { return await probe; }
  finally { if (aiHealthInFlight === probe) aiHealthInFlight = null; }
}

async function probeAiHealth(): Promise<AiHealth> {
  const settings = loadSettings();
  const model = settings.model || '';
  if (shouldUseBackendProxy()) {
    // Standalone / devproxy: the backend can reach http://ai-gateway.example/bedrock (Tailscale).
    //
    // Retried, but for a different failure than the one the backend retries. An update
    // restarts the dev server, and for a moment either nothing is listening or the
    // middleware is not mounted yet — the page reloading into that gap gets a refused
    // connection and used to render it as "AI unavailable", blaming Tailscale for a
    // process that was two seconds from being back. These attempts cost no model call,
    // so they are cheap to spend; the round trip behind them retries itself.
    const base = settings.devProxyUrl || '';
    const qs = new URLSearchParams();
    if (model) qs.set('model', model);
    if (base) qs.set('base', base);
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, attempt === 1 ? 600 : 1800));
      try {
        const resp = await fetch(`/api/pack-generator/ai-health?${qs.toString()}`);
        // A 5xx is the server still coming up; a 4xx is a route that will not appear.
        if (resp.status >= 500) { lastError = `HTTP ${resp.status}`; continue; }
        if (!resp.ok) return { reachable: false, modelOk: false, model, latencyMs: 0, error: `HTTP ${resp.status}` };
        return await resp.json();
      } catch (err) {
        lastError = (err as Error)?.message || 'AI health check failed';
      }
    }
    return { reachable: false, modelOk: false, model, latencyMs: 0, error: lastError || 'AI health check failed' };
  }
  // iframe: AI runs client-side via the configured provider — probe it directly.
  if (!isAiConfigured()) {
    return { reachable: false, modelOk: false, model, latencyMs: 0, error: 'No AI provider configured. Set an API key in Settings.' };
  }
  const started = Date.now();
  let lastError = '';
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 2500));
    attempts++;
    try {
      const text = await invokeAi('', 'Reply with the single word: ok', 64);
      const modelOk = String(text || '').trim().length > 0;
      return { reachable: true, modelOk, model, latencyMs: Date.now() - started, attempts, error: modelOk ? '' : 'Model returned no text (check model id / key).' };
    } catch (err) {
      lastError = (err as Error)?.message || 'AI provider unreachable';
      // A rejected key or a missing model fails the same way every time — retrying only
      // delays the message that tells the user which one to fix in Settings.
      if (/\b(400|401|403|404)\b/.test(lastError)) break;
    }
  }
  const tries = attempts === 1 ? '' : ` after ${attempts} attempts`;
  return { reachable: false, modelOk: false, model, latencyMs: Date.now() - started, attempts, error: `${lastError}${tries}` };
}

interface GeneratedSampleResult {
  events: string[];
  count: number;
  cached?: boolean;
  [key: string]: unknown;
}

const generatedSampleMemory = new Map<string, GeneratedSampleResult>();

function generatedSampleCacheKey(source: string, sourcetype: string, count: number, mode: string, variant = ''): string {
  const normalized = String(sourcetype || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  let variantHash = 0;
  for (const char of variant) variantHash = ((variantHash * 31) + char.charCodeAt(0)) >>> 0;
  return `${source}--${normalized}--${String(mode || 'balanced').toLowerCase()}--${count}--${variantHash.toString(16)}--v1`;
}

function parseGeneratedSample(value: unknown): GeneratedSampleResult | null {
  let candidate: any = value;
  for (let i = 0; i < 3 && typeof candidate === 'string'; i++) {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  candidate = candidate?.items?.[0]?.value ?? candidate?.value ?? candidate;
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  return Array.isArray(candidate?.events) && candidate.events.length > 0 ? candidate : null;
}

/**
 * A cached generation is only as good as its events, and the cache predates
 * verification-gated saves: refusal text and "[object Object]" were written to
 * it by builds that saved every result. So every read is re-verified, and a
 * failing entry is a miss — the caller regenerates rather than building from it.
 * `sourcetype` is omitted only by callers whose events are not a whole sample
 * (extension tails, already gated by `guardExtendedEvents`).
 */
const usableGeneratedSample = (sourcetype: string | undefined, cached: GeneratedSampleResult | null): GeneratedSampleResult | null =>
  (cached && (sourcetype === undefined || verifyGeneratedSample(sourcetype, cached.events, { synthetic: true }).verdict !== 'fail') ? cached : null);

/** The App KV library is reachable from the app iframe and from a Backend Function. */
const generatedSampleKvReachable = (): boolean => getRunMode() === 'iframe' || getRunMode() === 'backend';

async function loadGeneratedSample(key: string, sourcetype?: string): Promise<GeneratedSampleResult | null> {
  const memory = usableGeneratedSample(sourcetype, generatedSampleMemory.get(key) ?? null);
  if (memory) return { ...memory, cached: true };

  const fallback = usableGeneratedSample(sourcetype, parseGeneratedSample(safeGetItem(`generated-sample::${key}`)));
  if (fallback) {
    generatedSampleMemory.set(key, fallback);
    return { ...fallback, cached: true };
  }

  if (!generatedSampleKvReachable()) return null;
  try {
    const resp = await fetch(`${getApiBase()}/kvstore/generated-samples/${encodeURIComponent(key)}`);
    if (!resp.ok) return null;
    const text = await resp.text();
    const cached = usableGeneratedSample(sourcetype, parseGeneratedSample(text));
    if (cached) {
      generatedSampleMemory.set(key, cached);
      return { ...cached, cached: true };
    }
  } catch { /* cache miss */ }
  return null;
}

/**
 * Save a generation to the shared library — ONLY if it passed verification.
 * A sample that failed is still returned to the caller (with its warning), but
 * it must never become something the next run reuses as if it were correct.
 */
async function saveGeneratedSample(key: string, sourcetype: string | undefined, result: GeneratedSampleResult): Promise<void> {
  if (sourcetype !== undefined && verifyGeneratedSample(sourcetype, result.events, { synthetic: true }).verdict === 'fail') return;
  const stored = { ...result, cached: false };
  generatedSampleMemory.set(key, stored);
  if (generatedSampleKvReachable()) {
    try {
      // Content-Type MUST be text/plain, not application/json (build 725
      // finding, verified against a real org): a JSON content-type PUT to the
      // App KV store comes back 200 but the platform stores the literal
      // string "[object Object]" instead of the body — matches `kvWrite`
      // (settings-store.ts), the one KV writer already known to work (used
      // for AI Settings), which always sends text/plain over an
      // already-stringified body.
      const resp = await fetch(`${getApiBase()}/kvstore/generated-samples/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(stored),
      });
      if (resp.ok) return;
    } catch { /* use browser persistence fallback */ }
  }
  safeSetItem(`generated-sample::${key}`, JSON.stringify(stored));
}

// Batch-run checkpoint (build 709): lets a batch survive the app panel being
// closed/reloaded mid-run — offered back as Resume/Discard on next mount.
// Same mode split as saveGeneratedSample/loadGeneratedSample above: a browser
// copy always lands first (works everywhere, including the KV write failing),
// and iframe additionally mirrors to the App's own KV store so the checkpoint
// isn't lost if the user reopens the app in a different browser context.
export interface BatchCheckpoint {
  runId: string;
  workerGroup: string;
  batchRows: unknown[];
  results: unknown[];
  conflictActions: [string, string][];
  skipPacks: string[];
  status: 'running' | 'stopping' | 'done';
  startedAt: number;
  updatedAt: number;
}

const BATCH_CHECKPOINT_KV_KEY = 'batch-run/active';
const BATCH_CHECKPOINT_LS_KEY = 'batch-checkpoint';

function parseBatchCheckpoint(raw: string | null): BatchCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.runId) return parsed as BatchCheckpoint;
  } catch { /* corrupt/empty — treat as no checkpoint */ }
  return null;
}

export async function saveBatchCheckpoint(checkpoint: BatchCheckpoint): Promise<void> {
  const body = JSON.stringify(checkpoint);
  safeSetItem(BATCH_CHECKPOINT_LS_KEY, body);
  if (getRunMode() === 'iframe') {
    try {
      // text/plain, not application/json — see saveGeneratedSample's comment
      // above for why (build 725: a JSON content-type PUT silently stores
      // "[object Object]" instead of the body on this platform).
      await fetch(`${getApiBase()}/kvstore/${BATCH_CHECKPOINT_KV_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body,
      });
    } catch { /* browser copy above already covers this */ }
  }
}

export async function loadBatchCheckpoint(): Promise<BatchCheckpoint | null> {
  if (getRunMode() === 'iframe') {
    try {
      const resp = await fetch(`${getApiBase()}/kvstore/${BATCH_CHECKPOINT_KV_KEY}`);
      if (resp.ok) {
        const parsed = parseBatchCheckpoint(await resp.text());
        if (parsed) return parsed;
      }
    } catch { /* fall through to the browser copy */ }
  }
  return parseBatchCheckpoint(safeGetItem(BATCH_CHECKPOINT_LS_KEY));
}

export async function clearBatchCheckpoint(): Promise<void> {
  safeRemoveItem(BATCH_CHECKPOINT_LS_KEY);
  if (getRunMode() === 'iframe') {
    try { await fetch(`${getApiBase()}/kvstore/${BATCH_CHECKPOINT_KV_KEY}`, { method: 'DELETE' }); } catch { /* best effort */ }
  }
}

export async function aiValidate(sourcetype: string, destFormat: string, catalog?: string[]): Promise<any> {
  if (shouldUseBackendProxy()) {
    try {
      const resp = await proxyFetch('/api/pack-generator/ai-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcetype, destFormat, catalog }),
      });
      if (!resp.ok) throw new Error('AI unavailable');
      return resp.json();
    } catch {
      return { valid: true, sourcetypeOk: true, destFormatOk: true, suggestion: '', clarification: '' };
    }
  }
  if (!isAiConfigured()) return { valid: true, sourcetypeOk: true, destFormatOk: true, suggestion: '', clarification: '' };
  return aiValidateSourcetype(sourcetype, destFormat, catalog);
}

// Run-scoped background persistence is shared by iframe and Backend Functions:
// both use the App's relative `/api/v1/kvstore` API through one repository.
// Only lifecycle entry points that a browser user initiates enforce iframe
// capability; backend load/save paths stay mode-neutral.
export function backgroundBatchSchedulePayload(runId: string): {
  id: string;
  endpoint: 'runBatchStep';
  cronSchedule: '* * * * *';
  bodyExpression: string;
} {
  return {
    id: backgroundScheduleId(runId),
    endpoint: 'runBatchStep',
    cronSchedule: '* * * * *',
    bodyExpression: JSON.stringify({ runId, scheduledFor: '${scheduledFor}' }),
  };
}

function assertBackgroundBrowserCapability(): void {
  if (getRunMode() !== 'iframe') {
    throw new Error('Batch — Background requires the app to be installed in a Cribl org (iframe mode).');
  }
}

async function deleteBackgroundSchedule(scheduleId: string | undefined): Promise<void> {
  if (!scheduleId) return;
  const response = await fetch(`${getApiBase()}/backend-schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Background schedule delete failed (${response.status}).`);
  }
}

export async function triggerBatchBackgroundKickoff(
  runId: string,
): Promise<{ ok: boolean; status?: string; pending?: number; total?: number }> {
  const resp = await fetch(`${getApiBase()}/endpoints/runBatchStep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `action` is what separates the start call from a scheduled tick: the
    // schedule posts `{runId, scheduledFor}` and runs a stage, while kickoff
    // only validates, schedules and returns — it must answer inside the
    // iframe bridge's 30s ceiling.
    body: JSON.stringify({ action: 'kickoff', runId }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.reason || `Backend function call failed (${resp.status})`);
  return data;
}

/**
 * Start a background run: everything the runner will need, in the one order
 * that cannot leave a half-started run behind.
 *
 * 1. Refuse a run that can never execute, BEFORE any write. Direct Bedrock
 *    signs with browser-held credentials a Backend Function does not have, so
 *    a run on it would fail every stage — and each failure would be recorded
 *    against a row rather than against the setting that caused it.
 * 2. Create the run (manifest + active pointer).
 * 3. Persist every row artifact. This is before the schedule exists on purpose:
 *    a tick that arrived first would find rows whose samples had not landed and
 *    fail them one per minute.
 * 4. Create the schedule, mark the run running, and kick off.
 *
 * Any failure from step 2 onward rolls the whole thing back — schedule, row
 * artifacts, manifest and pointer. A failed Start must leave the operator able
 * to press Start again, not holding an active-run pointer that blocks it.
 */
export async function startBatchBackgroundRun(
  checkpoint: BackgroundBatchCheckpoint,
  artifacts: readonly BackgroundArtifactWrite[] = [],
): Promise<{ ok: boolean; status?: string; pending?: number; total?: number }> {
  assertBackgroundBrowserCapability();
  const eligibility = canBackgroundUseProvider(checkpoint.ai?.provider as AiProvider);
  if (!eligibility.ok) {
    throw new Error(eligibility.reason || 'This AI provider cannot be used by a background run.');
  }
  await backgroundBatchStore.createRun(checkpoint);
  const payload = backgroundBatchSchedulePayload(checkpoint.runId);
  let scheduleCreated = false;
  try {
    for (const artifact of artifacts) {
      await backgroundBatchStore.saveArtifact(artifact.key, artifact.value);
    }
    const response = await fetch(`${getApiBase()}/backend-schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Background schedule create failed (${response.status}).`);
    scheduleCreated = true;
    await backgroundBatchStore.saveRun({
      ...checkpoint,
      status: 'running',
      scheduleId: payload.id,
      updatedAt: Date.now(),
    });
    // Inside the rollback: a kickoff that failed leaves a one-minute schedule
    // firing at a run the operator was told did not start. Retrying Start is
    // cheap (the manifest is rebuilt from pre-flight state that is still in the
    // browser); an invisible run that keeps ticking is not.
    return await triggerBatchBackgroundKickoff(checkpoint.runId);
  } catch (error) {
    if (scheduleCreated) await deleteBackgroundSchedule(payload.id).catch(() => {});
    await backgroundBatchStore.deleteRun(checkpoint.runId).catch(() => {});
    throw error;
  }
}

/**
 * The run manifest, or `null` — and `null` means ONE thing: a read that
 * succeeded and found no document.
 *
 * A transient failure (dropped connection, 408/429/5xx) is thrown, not
 * flattened into that same `null`. The caller folds the two into different
 * states and offers different buttons for them: a run that is gone can only be
 * dismissed, while a run whose read failed is very likely still ticking and
 * must keep Stop instead. Collapsing them here is Hard Rule 32 — a measurement
 * that failed presenting itself as a measurement that succeeded — and it put
 * the destructive button under a healthy run.
 */
export async function loadBatchBackgroundRun(runId: string): Promise<BackgroundBatchCheckpoint | null> {
  return await backgroundBatchStore.loadRun(runId);
}

/**
 * The unbounded per-row detail — the scorecard the operator asks for by row.
 *
 * The manifest carries only bounded metadata (scores, phase), so the findings,
 * missing/empty fields and per-stage reasons live in this run-scoped artifact
 * and are fetched ONLY when a row is expanded — never polled with the manifest.
 * `null` means the document is not (yet) there, which for a still-running row is
 * an ordinary "no detail written for this stage yet", not an error.
 */
export async function loadBatchBackgroundRowArtifact(artifactKey: string): Promise<BackgroundRowArtifact | null> {
  return await backgroundBatchStore.loadArtifact<BackgroundRowArtifact>(artifactKey);
}

export async function stopBatchBackgroundRun(runId: string): Promise<void> {
  assertBackgroundBrowserCapability();
  const active = await backgroundBatchStore.loadActiveRunId();
  if (active !== runId) {
    throw new Error(
      `Stale background batch run "${runId}" is fenced; active run is "${active ?? 'none'}".`,
    );
  }
  const checkpoint = await backgroundBatchStore.loadRun(runId);
  if (!checkpoint) throw new Error(`Background batch run "${runId}" was not found.`);
  await backgroundBatchStore.saveRun({ ...checkpoint, status: 'stopping', updatedAt: Date.now() });
}

/**
 * Kill: end a background run NOW, for when Stop does not.
 *
 * Stop is one flag that the next tick acts on, and a tick only acts once it
 * holds the lease — an invocation that hung mid-stage keeps the lease, so the
 * run sits on "Stopping…" until it expires (or forever, when the commit keeps
 * failing). Kill does the runner's part itself: the manifest is written
 * terminal with the lease dropped, then the schedule is removed. The runner
 * treats a terminal manifest as the end, so an invocation
 * that wakes up afterwards commits nothing (`finishTick`).
 *
 * The manifest stays, so the screen shows what was killed; Dismiss clears it.
 * A run whose manifest is already gone needs no kill — only the schedule sweep.
 */
export async function killBatchBackgroundRun(runId: string): Promise<BackgroundBatchCheckpoint | null> {
  assertBackgroundBrowserCapability();
  const active = await backgroundBatchStore.loadActiveRunId();
  if (active && active !== runId) {
    throw new Error(
      `Stale background batch run "${runId}" is fenced; active run is "${active}".`,
    );
  }
  if (!active) {
    // No pointer: every tick already answers `stale` for this run, so only the
    // schedule that keeps firing them is left to remove.
    await deleteBackgroundSchedule(backgroundScheduleId(runId));
    return null;
  }
  let checkpoint: BackgroundBatchCheckpoint | null = null;
  try {
    checkpoint = await backgroundBatchStore.loadRun(runId);
  } catch (error) {
    // A corrupt manifest is exactly the run that must stay killable.
    if (!isBackgroundBatchCorruptDocumentError(error)) throw error;
  }
  if (!checkpoint) {
    await deleteBackgroundSchedule(backgroundScheduleId(runId));
    return null;
  }
  // The terminal write FIRST: once it lands every tick is a no-op, so the
  // schedule delete after it is cleanup. The other order left a run with no
  // schedule and a refused write — stuck on "Stopping…" with nothing to move it.
  const killed = killBackgroundCheckpoint(checkpoint, Date.now());
  await backgroundBatchStore.saveRun(killed);
  await deleteBackgroundSchedule(checkpoint.scheduleId || backgroundScheduleId(runId));
  return killed;
}

export async function dismissBatchBackgroundRun(runId: string): Promise<void> {
  assertBackgroundBrowserCapability();
  const active = await backgroundBatchStore.loadActiveRunId();
  if (active && active !== runId) {
    throw new Error(
      `Stale background batch run "${runId}" is fenced; active run is "${active ?? 'none'}".`,
    );
  }
  if (!active) {
    // The pointer is deleted LAST, so no pointer means this run is already
    // gone — which is precisely what Dismiss is asking for. Refusing here made
    // the only escape from a vanished run impossible: the cleanup the operator
    // was told to retry could never succeed. The derived schedule is still
    // swept in case an earlier delete was the thing that failed, best-effort
    // because nothing durable is left for a second attempt to fix.
    await deleteBackgroundSchedule(backgroundScheduleId(runId)).catch(() => {});
    return;
  }
  // The manifest is read for ONE thing here: the schedule id to remove. A
  // corrupt document cannot supply it, and that run is precisely the one that
  // has to be cleanable — so corruption falls through to the derived id below.
  // Any other failure (auth, policy, transport) leaves us not knowing what this
  // run is, and nothing destructive may happen on a read that answered nothing.
  let checkpoint: BackgroundBatchCheckpoint | null = null;
  try {
    checkpoint = await backgroundBatchStore.loadRun(runId);
  } catch (error) {
    if (!isBackgroundBatchCorruptDocumentError(error)) throw error;
  }
  // A legacy parked run (one written before the runner performed the quality
  // rows itself) has already deleted its schedule and FORGOTTEN its id (a
  // deleted id must never be reused). If that delete failed, the manifest can
  // no longer say what to remove, so Dismiss would leave the schedule firing
  // every minute against a run that no longer exists. The id is derived from
  // the run id, so this fallback can only ever name THIS run's schedule, and
  // the delete already treats a 404 as success.
  await deleteBackgroundSchedule(checkpoint?.scheduleId || backgroundScheduleId(runId));
  await backgroundBatchStore.deleteRun(runId);
}

/**
 * Whether this install can run a background batch at all. Backend Functions,
 * App KV and Backend Schedules are platform features, so standalone must show
 * the mode as unavailable rather than offering it and failing at Start.
 */
export function backgroundBatchSupported(): boolean {
  return getRunMode() === 'iframe';
}

/**
 * The run currently in flight, if any — what a reopened tab restores from.
 *
 * Returns null outside the iframe WITHOUT touching App KV: standalone has no
 * such store, and a request there is a guaranteed failure that the caller would
 * have to translate back into "no run" anyway.
 *
 * Inside the iframe, a read that FAILED throws. This is the mount read, so it
 * is the one answer that is never safe to guess at: reporting "no run" would
 * hide a run that is still going and invite a second Start the active pointer
 * will then refuse.
 */
export async function loadActiveBatchBackgroundRun(): Promise<BackgroundBatchCheckpoint | null> {
  if (!backgroundBatchSupported()) return null;
  const runId = await backgroundBatchStore.loadActiveRunId();
  if (!runId) return null;
  try {
    return await backgroundBatchStore.loadRun(runId);
  } catch (error) {
    // The pointer resolved, so we know WHICH run failed to read even though we
    // have no manifest. That id is the only thing a corrupt-document dead end
    // leaves to act on — without it the screen can offer a cleanup with nothing
    // to name (`backgroundRunIdOf` reads it back).
    throw tagBackgroundRunId(error, runId);
  }
}

// Destination/table-aware validation. Recognizes specific SIEM tables and flags
// ambiguous platforms (e.g. "Azure Sentinel") with specific-table suggestions.
// Returns { destFormatOk, canonical, suggestion, clarification }.
export async function aiValidateDest(destFormat: string, sourcetype = ''): Promise<{ destFormatOk: boolean; canonical: string; displayName: string; suggestion: string; clarification: string }> {
  const fallback = { destFormatOk: true, canonical: '', displayName: '', suggestion: '', clarification: '' };
  if (shouldUseBackendProxy()) {
    try {
      const resp = await proxyFetch('/api/pack-generator/ai-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'dest', destFormat, sourcetype }),
      });
      if (!resp.ok) throw new Error('AI unavailable');
      return await resp.json();
    } catch {
      return fallback;
    }
  }
  // iframe/no-backend: catalog match (done client-side by the caller) is the
  // primary path; without AI we can't table-ID, so don't block.
  return fallback;
}

/**
 * AI-generate sample events. Every line it returns is marked SYNTHETIC in the
 * provenance registry (src/sample-provenance.ts), whichever path produced it —
 * the backend, the local cache or a fresh generation — so a golden later
 * measured on these events records that a model wrote its input (golden-trust R1).
 */
export async function aiSamples(sourcetype: string, count: number, mode: string, onProgress?: AiProgressCallback, grounding?: SampleGrounding | null): Promise<GeneratedSampleResult> {
  const result = await generateAiSampleEvents(sourcetype, count, mode, onProgress, grounding);
  if (Array.isArray(result?.events)) recordSyntheticLines(result.events);
  return result;
}

async function generateAiSampleEvents(sourcetype: string, count: number, mode: string, onProgress?: AiProgressCallback, grounding?: SampleGrounding | null): Promise<GeneratedSampleResult> {
  // A user-confirmed wire format specializes the events; include it in the local
  // cache key so a KV request never reuses a cached JSON sample for the same type.
  const fmtKey = grounding?.confirmedFormat ? `${mode}::${grounding.confirmedFormat}` : mode;
  if (shouldUseBackendProxy()) {
    onProgress?.('researching', `Researching official ${sourcetype} log format documentation...`);
    const researchTimer = setTimeout(() => {
      onProgress?.('generating', `Generating ${count} ${sourcetype} events — this may take 2-3 minutes...`);
    }, 12000);

    const resp = await proxyFetch('/api/pack-generator/ai-samples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcetype, count, mode, grounding: grounding || null }),
    });
    clearTimeout(researchTimer);
    if (!resp.ok) {
      // Carry the handler's OWN reason ('empty', 'verification-failed: …', a
      // timeout message) instead of a generic string — the batch row shows this
      // text, and 'AI sample generation unavailable' told us nothing about the
      // 39 build-446 rows that ended up asking for a manual upload.
      let detail = `HTTP ${resp.status}`;
      try {
        const body = await resp.json();
        detail = body?.reason || body?.error || detail;
      } catch { /* non-JSON body — keep the status */ }
      throw new Error(`AI sample generation failed (${detail})`);
    }
    const result = await resp.json();
    onProgress?.('done', result.cached
      ? `Reused ${result.events?.length || 0} saved ${sourcetype} events.`
      : `Generated and saved ${result.events?.length || 0} events based on vendor documentation.`);
    return result;
  }
  if (!isAiConfigured()) throw new Error('AI not configured — open Settings to add your API key');
  const cacheKey = generatedSampleCacheKey('ai', sourcetype, count, fmtKey);
  const cached = await loadGeneratedSample(cacheKey, sourcetype);
  if (cached) {
    onProgress?.('done', `Reused ${cached.events.length} saved ${sourcetype} events.`);
    return cached;
  }
  let generated: GeneratedSampleResult;
  try {
    generated = await aiGenerateSamples(sourcetype, count, onProgress, grounding) as GeneratedSampleResult;
  } catch (err) {
    // The platform proxy says only "Request timeout", which reads like a network
    // fault and cost real time being chased as one.
    throw new Error(describeProxyTimeout(err instanceof Error ? err.message : String(err)));
  }
  // Mirror the standalone handler's 502-on-empty (Hard Rule 18): an empty
  // generation must THROW in both run modes so the caller reports a cause and
  // nothing caches a zero-event "success".
  if (!Array.isArray(generated?.events) || generated.events.length === 0) {
    throw new Error(`AI sample generation failed (produced no events for ${sourcetype})`);
  }
  await saveGeneratedSample(cacheKey, sourcetype, generated);
  onProgress?.('done', `Generated and saved ${generated.events.length} ${sourcetype} events.`);
  return generated;
}

// improveHints carries the previous quality-gate round's problems so a retry
// TARGETS the low-score causes instead of regenerating blind.
export interface MappingImproveHints {
  findings?: { severity: string; field: string; issue: string }[];
  missingFields?: string[];
  emptyFields?: string[];
  guidance?: string;
  currentFunctions?: any[];
}

export async function aiMapping(sourcetype: string, destFormat: string, sampleSnippet: string, onProgress?: AiProgressCallback, parsedFields?: string[], improveHints?: MappingImproveHints, model?: string, cimModel?: string): Promise<AiMappingResult | null> {
  if (shouldUseBackendProxy()) {
    onProgress?.('researching', `Researching ${sourcetype} fields and ${destFormat} schema...`);
    const timer = setInterval(() => {
      onProgress?.('mapping', 'Building field mappings from source to destination schema...');
      clearInterval(timer);
    }, 8000);
    try {
      const resp = await proxyFetch('/api/pack-generator/ai-mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcetype, destFormat, sampleSnippet, parsedFields, improveHints, model, cimModel }),
      });
      clearInterval(timer);
      if (!resp.ok) return null;
      const result = await resp.json();
      // Validate the backend's AI output shape before it reaches the pack
      // builder — same guard the direct-client path applies.
      const validated = validateMappingResult(result);
      onProgress?.('done', 'Field mappings ready.');
      return validated;
    } catch {
      clearInterval(timer);
      return null;
    }
  }
  if (!isAiConfigured()) return null;
  try {
    return await aiGenerateMapping(sourcetype, destFormat, sampleSnippet, onProgress, parsedFields, improveHints);
  } catch {
    return null;
  }
}

export interface AiParseFunctions {
  functions: Array<{
    id: string;
    filter?: string;
    disabled?: boolean;
    description?: string;
    conf: Record<string, unknown>;
  }>;
}

export async function aiParse(sourcetype: string, sampleSnippet: string, onProgress?: AiProgressCallback, model?: string, guidance?: string): Promise<AiParseFunctions | null> {
  if (shouldUseBackendProxy()) {
    onProgress?.('researching', `Analyzing ${sourcetype} log format...`);
    try {
      const resp = await proxyFetch('/api/pack-generator/ai-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcetype, sampleSnippet, model, guidance }),
      });
      if (!resp.ok) {
        onProgress?.('error', `parse backend returned HTTP ${resp.status}`);
        return null;
      }
      const result = await resp.json();
      onProgress?.('done', 'Parse functions generated.');
      return result;
    } catch (err) {
      onProgress?.('error', err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  if (!isAiConfigured()) {
    onProgress?.('error', 'no AI provider configured');
    return null;
  }
  try {
    return await aiGenerateParse(sourcetype, sampleSnippet, onProgress, guidance);
  } catch (err) {
    // Callers depend on null meaning "fall back to a static parser", so the
    // failure must not throw — but it must not vanish either.
    onProgress?.('error', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Delegate OCSF (and later ECS/UDM) pipeline generation to Cribl's Copilot
// "schematizer" agent — it returns a COMPLETE parse+map+enrich pipeline in one
// artifact. Runs on the org API (OAuth), same reachability as AI features.
// Returns { functions, schemaId, pipelineId } or null (unreachable / no Copilot
// / non-schematizer dest). Best-effort — a null just falls back to golden/AI.
export interface SchematizerResult { functions: any[]; schemaId?: string; pipelineId?: string; description?: string }
export async function schematizerMapping(sourcetype: string, destFormat: string, sampleId: string, inputEvents: any[], workerGroup: string): Promise<SchematizerResult | null> {
  const body = { sourcetype, destFormat, sampleId, inputEvents, workerGroup };
  // Runs through the backend .mjs handler (org OAuth). shouldUseBackendProxy()
  // is always true in standalone (Tailscale/Aperture), so this is the standalone
  // path; iframe falls through to the null return (golden/AI fallback).
  if (shouldUseBackendProxy()) {
    try {
      const resp = await proxyFetch('/api/pack-generator/schematizer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.pipeline || null;
    } catch { return null; }
  }
  // iframe mode: the org API is reachable via the platform; the schematizer agent
  // loop is heavy to run client-side, so it's standalone-only for now (falls back
  // to golden/AI in iframe). Returning null keeps iframe on the existing path.
  return null;
}

export async function aiAdvise(sourcetype: string, destFormat: string, sampleSnippet: string, allowCodeFunctions: boolean, onProgress?: AiProgressCallback): Promise<any> {
  if (shouldUseBackendProxy()) {
    onProgress?.('researching', `Researching ${sourcetype} format and ${destFormat} schema...`);
    const timer = setInterval(() => {
      onProgress?.('analyzing', 'Documentation loaded. Analyzing pipeline strategy...');
      clearInterval(timer);
    }, 10000);
    const resp = await proxyFetch('/api/pack-generator/ai-advise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcetype, destFormat, sampleSnippet, allowCodeFunctions }),
    });
    clearInterval(timer);
    if (!resp.ok) throw new Error('AI analysis unavailable');
    const result = await resp.json();
    onProgress?.('done', 'Pipeline recommendations ready.');
    return result;
  }
  if (!isAiConfigured()) throw new Error('AI not configured — open Settings to add your API key');
  return aiAdviseClient(sourcetype, destFormat, sampleSnippet, allowCodeFunctions, onProgress);
}

export async function analyzeBuildTrace(traceSummary: string, comment: string): Promise<string> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/ai-analyze-trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ traceSummary, comment }),
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => null);
      throw new Error(errBody?.error || 'AI trace analysis unavailable');
    }
    const result = await resp.json();
    return result.text as string;
  }
  if (!isAiConfigured()) throw new Error('AI not configured — open Settings to add your API key');
  return analyzeBuildTraceClient(traceSummary, comment);
}

export async function fetchPublicSamples(url: string, format: string, maxEvents = 100): Promise<{ events: string[]; count: number }> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/fetch-public-samples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format, maxEvents }),
    });
    if (!resp.ok) throw new Error('Failed to fetch public samples');
    return resp.json();
  }
  // In iframe mode, fetch via platform proxy (the URL is external)
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch: ${resp.status}`);
  const text = await resp.text();
  let events: string[];
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        events = eventsToLines(parsed);
      } else {
        events = text.trim().split('\n').filter(Boolean);
      }
    } catch {
      events = text.trim().split('\n').filter(Boolean);
    }
  } else {
    events = text.trim().split('\n').filter(Boolean);
  }
  return { events: events.slice(0, maxEvents), count: Math.min(events.length, maxEvents) };
}

export async function fetchHybridSamples(url: string, format: string, sourcetype: string, count = 100): Promise<GeneratedSampleResult> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/hybrid-samples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format, sourcetype, count }),
    });
    if (!resp.ok) throw new Error('Hybrid sample generation failed');
    return resp.json();
  }
  // In iframe mode: fetch seed then use AI client to augment
  const cacheKey = generatedSampleCacheKey('hybrid', sourcetype, count, 'hybrid', `${format}:${url}`);
  const cached = await loadGeneratedSample(cacheKey, sourcetype);
  if (cached) return cached;
  const seedResult = await fetchPublicSamples(url, format, 10);
  const { aiGenerateSamples } = await import('./ai-client');
  const aiResult = await aiGenerateSamples(sourcetype, count);
  // For true hybrid in iframe, we'd need to pass seed to AI — for now just combine
  const combined = [...seedResult.events.slice(0, 20), ...aiResult.events];
  const result = { events: combined.slice(0, count), count: Math.min(combined.length, count) };
  await saveGeneratedSample(cacheKey, sourcetype, result);
  return result;
}

export async function detectSourcetypeApi(sampleEvents: string): Promise<{ sourcetype: string; confidence: string; reason: string }> {
  if (shouldUseBackendProxy()) {
    try {
      const resp = await proxyFetch('/api/pack-generator/detect-sourcetype', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleEvents }),
      });
      if (!resp.ok) {
        // Include the backend status/body so the cause (e.g. AI proxy 5xx,
        // Tailscale/Aperture unreachable) is visible instead of a generic message.
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        return { sourcetype: '', confidence: 'none', reason: `AI detection unavailable (backend ${resp.status}${detail ? `: ${detail}` : ''}). Check Tailscale/AI proxy.` };
      }
      return resp.json();
    } catch (err) {
      // Network-level failure (dev server down, fetch rejected).
      return { sourcetype: '', confidence: 'none', reason: `AI detection unavailable — could not reach backend (${err instanceof Error ? err.message : 'network error'}).` };
    }
  }
  if (!isAiConfigured()) return { sourcetype: '', confidence: 'none', reason: 'AI not configured — open Settings' };
  return aiDetectSourcetype(sampleEvents);
}

// --- Schema validation + repair ---

export interface ValidationFinding {
  severity: 'high' | 'medium' | 'low';
  field: string;
  issue: string;
  example?: string;
  // Points this finding cost against the displayed score. Set by
  // applyDeterministicScore (App.tsx): the deterministic scorer's own findings
  // carry their real point cost; AI-only findings (advisory, didn't factor into
  // the displayed schema-validated score) are explicitly 0 — not omitted — so
  // the UI can show "no score impact" rather than leaving it ambiguous.
  pointImpact?: number;
}

export interface ValidationReport {
  pipelineId: string;
  destFormat: string;
  score: number;
  band: 'good' | 'warn' | 'fail';
  sampleFormatOk: boolean;
  sampleFormatNote?: string;
  outputFormatOk: boolean;
  findings: ValidationFinding[];
  missingFields: string[];
  emptyFields: string[];
  summary: string;
  lessons: string[];
  inputCount: number;
  outputCount: number;
  // Raw material for the deterministic + value-coverage scorers, when the
  // backend supplies it. Present from the dev-server post-deploy validator.
  outputSample?: any[];
  sampleKeys?: string[];
  sampleRaw?: string[];
  // Set to the scorer that produced the displayed score.
  scoreSource?: 'golden-spec' | 'value-coverage' | 'raw-fidelity' | 'schema-validated' | 'ai';
}

export interface ValidatePipelineArgs {
  workerGroup: string;
  packId: string;
  pipelineId: string;
  sourcetype: string;
  destFormat: string;
  sampleName: string;
  // When false, the backend skips the (fragile, ~30s) AI scoring call and
  // returns ONLY the deterministic live preview output. previewPipeline sets
  // this — it needs the transformed events, never an AI score.
  includeAi?: boolean;
}

function scoreBand(score: number): 'good' | 'warn' | 'fail' {
  if (score >= 85) return 'good';
  if (score >= 60) return 'warn';
  return 'fail';
}

// Strip Cribl control fields so AI scoring sees only real output.
function stripCtrl(e: any): any {
  if (!e || typeof e !== 'object') return e;
  const { __criblEventType, __ctrlFields, __final, __cloneCount, __id, __packId, cribl_pipe: _cribl_pipe, cribl_breaker: _cribl_breaker, ...rest } = e;
  return rest;
}

// Resolve a pack sample id from its name (iframe direct-Cribl path).
async function resolvePackSampleId(workerGroup: string, packId: string, sampleName: string): Promise<string | null> {
  const data = await criblFetch<{ items: any[] }>(`/m/${workerGroup}/p/${packId}/system/samples`);
  const items = data.items || [];
  const hit = items.find((s: any) => s.sampleName === sampleName) || items.find((s: any) => s.id === sampleName) || items.find((s: any) => (s.sampleName || '').includes(sampleName));
  return hit?.id || null;
}

// Run a sample through a pipeline via the preview API (iframe direct-Cribl path).
// IMPORTANT: the transform is applied only with `pipelineId` — `pipeline` is a no-op.
async function previewPack(workerGroup: string, packId: string, pipelineId: string, sampleId: string): Promise<any[]> {
  const data = await criblFetch<{ items: any[] }>(`/m/${workerGroup}/p/${packId}/preview`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'pipe', sampleId, pipelineId }),
  });
  return (data.items || []).map(stripCtrl);
}

// Validate a deployed pipeline entirely client-side (iframe mode): fetch sample,
// run preview, AI-score. Used when the dev backend proxy isn't available.
async function validatePipelineClient(args: ValidatePipelineArgs): Promise<ValidationReport> {
  const { workerGroup, packId, pipelineId, sourcetype, destFormat, sampleName } = args;
  const sampleId = await resolvePackSampleId(workerGroup, packId, sampleName);
  if (!sampleId) throw new Error(`No sample found matching "${sampleName}" in pack ${packId}`);

  const content = await criblFetch<any[]>(`/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(sampleId)}/content`);
  const sampleRaw = eventsToLines(Array.isArray(content) ? content : []).slice(0, 8);

  const outputEvents = await previewPack(workerGroup, packId, pipelineId, sampleId);
  const outputSample = outputEvents.slice(0, 8);

  const r = await aiScorePipelineOutput(sourcetype, destFormat, sampleRaw, outputSample);
  const score = Math.max(0, Math.min(100, Number(r.score) || 0));
  // Collect the field names present in the transformed output (excluding _raw
  // and internal cribl_/__ fields) so callers doing deterministic value-coverage
  // scoring (the 3-stage experiment) have the same signal the backend returns.
  const sampleKeys = Array.from(new Set(
    outputSample.flatMap((e: any) => Object.keys(e || {})
      .filter(k => k !== '_raw' && !k.startsWith('__') && !k.startsWith('cribl_')))
  ));
  return {
    pipelineId, destFormat, score, band: scoreBand(score),
    sampleFormatOk: r.sampleFormatOk !== false,
    sampleFormatNote: r.sampleFormatNote || '',
    outputFormatOk: r.outputFormatOk === true,
    findings: Array.isArray(r.findings) ? r.findings : [],
    missingFields: Array.isArray(r.missingFields) ? r.missingFields : [],
    emptyFields: Array.isArray(r.emptyFields) ? r.emptyFields : [],
    summary: r.summary || '',
    lessons: Array.isArray(r.lessons) ? r.lessons : [],
    inputCount: sampleRaw.length,
    outputCount: outputEvents.length,
    // These three power the deterministic value-coverage scorer + preview() in
    // the experiment path. Without them, iframe preview() saw [] → extraction &
    // mapping scored 0 while optimization falsely scored 80 (nothing to lose).
    outputSample,
    sampleKeys,
    sampleRaw,
  };
}

// Run a deployed pipeline's sample through the preview API and return ONLY the
// transformed output events — no AI scoring. This is what the 3-stage
// experiment needs per candidate (extraction/mapping/optimization each score
// deterministically via value-coverage, so an AI call per candidate is pure
// waste AND a fragility: a transient `TypeError: Failed to fetch` on any one of
// the many throwaway AI calls would abort a whole pack — observed as Zscaler
// "E 92 · M · O · Failed to fetch", where mapping tried multiple candidates
// and one AI-score fetch dropped). One transient-network retry included.
export async function previewPipeline(args: ValidatePipelineArgs): Promise<any[]> {
  // Standalone (shouldUseBackendProxy() true) → backend validate-pipeline. The
  // browser-direct client path below is iframe-only (criblFetch needs the
  // platform-injected auth). includeAi:false — previewPipeline needs ONLY the
  // transformed events, not a score. With the default (true) the backend runs a
  // per-candidate AI scoring call; when Aperture returns bad JSON the report
  // comes back with NO outputSample → [] → every staged candidate scored E0.
  if (shouldUseBackendProxy()) {
    return withTransientRetry(async () => {
      return (await validatePipeline({ ...args, includeAi: false }))?.outputSample || [];
    }, { label: 'previewPipeline' });
  }
  const { workerGroup, packId, pipelineId, sampleName } = args;
  const sampleId = await resolvePackSampleId(workerGroup, packId, sampleName);
  if (!sampleId) throw new Error(`No sample found matching "${sampleName}" in pack ${packId}`);
  return withTransientRetry(
    () => previewPack(workerGroup, packId, pipelineId, sampleId),
    { label: 'previewPipeline-iframe' },
  );
}

// The real Cribl Pipeline Profile — per-function timing/throughput exactly as
// shown in Cribl's preview "Pipeline Profile" tab. `duration` is the Summary
// Total (ms); each function carries its own bytes/events in→out and process ms.
export interface CriblPipelineFunctionStat {
  func: string;
  bytesIn: number;
  bytesOut: number;
  eventsIn: number;
  eventsOut: number;
  duration: number; // process time in ms
}
export interface CriblPipelineProfile {
  duration: number; // total process time (ms) — the Summary Total
  cpu?: { user: number; system: number };
  functions: CriblPipelineFunctionStat[];
}

// Fetch the live Cribl Pipeline Profile for a deployed pipeline. Standalone →
// backend proxy (OAuth); iframe → direct Cribl preview with cpuProfile flags.
// Returns null if the profile is unavailable (never throws to the UI — the
// Event Journey degrades to derived stats). `cpuProfile:true` + `level:3` is
// what makes the preview response include the `stats` object.
export async function previewPipelineProfile(args: {
  workerGroup: string; packId: string; pipelineId: string; sampleName: string;
}): Promise<CriblPipelineProfile | null> {
  try {
    if (shouldUseBackendProxy()) {
      const resp = await proxyFetch('/api/pack-generator/pipeline-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await resp.json();
      if (!resp.ok) return null;
      return (data?.stats as CriblPipelineProfile) || null;
    }
    // iframe: call the Cribl preview API directly with profiling enabled.
    const { workerGroup, packId, pipelineId, sampleName } = args;
    const sampleId = await resolvePackSampleId(workerGroup, packId, sampleName);
    if (!sampleId) return null;
    const data = await criblFetch<{ stats?: CriblPipelineProfile }>(`/m/${workerGroup}/p/${packId}/preview`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'pipe', sampleId, pipelineId,
        cpuProfile: true, level: 3, dropped: true,
        enhanceMetricsOutput: false, timeout: 10000, memory: 2048,
      }),
    });
    return data?.stats || null;
  } catch {
    return null;
  }
}

// Validate a deployed pipeline: runs the sample through it (preview API) and
// AI-scores the output against the target schema. Works in both modes:
// standalone → dev backend proxy; iframe → client-side (criblFetch + invokeAi).
export async function validatePipeline(args: ValidatePipelineArgs): Promise<ValidationReport | null> {
  // Standalone (shouldUseBackendProxy() true) → backend proxy for the Cribl
  // preview API. iframe → client-side (criblFetch + AI provider) below.
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/validate-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Validation failed');
    return data as ValidationReport;
  }
  if (getRunMode() === 'iframe') {
    if (!isAiConfigured()) throw new Error('AI not configured — open Settings to add your API key');
    return validatePipelineClient(args);
  }
  return null;
}

export interface RepairPipelineArgs extends ValidatePipelineArgs {
  findings: ValidationFinding[];
  lessons: string[];
  missingFields?: string[];
  emptyFields?: string[];
}

// Repair a pipeline client-side (iframe mode): AI regenerates failing stages,
// PATCH + commit + deploy via the Cribl API directly.
async function repairPipelineClient(args: RepairPipelineArgs): Promise<{ pipelineId: string; repaired: boolean; commit: string; functionCount: number }> {
  const { workerGroup, packId, pipelineId, sourcetype, destFormat, sampleName, findings } = args;
  const plData = await criblFetch<{ items: any[] }>(`/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`);
  const conf = plData.items?.[0]?.conf;
  if (!conf) throw new Error('Could not load current pipeline conf');

  const sampleId = await resolvePackSampleId(workerGroup, packId, sampleName);
  let sampleRaw: string[] = [];
  let currentOutput: any[] = [];
  if (sampleId) {
    const content = await criblFetch<any[]>(`/m/${workerGroup}/p/${packId}/system/samples/${encodeURIComponent(sampleId)}/content`);
    sampleRaw = eventsToLines(Array.isArray(content) ? content : []).slice(0, 6);
    try { currentOutput = (await previewPack(workerGroup, packId, pipelineId, sampleId)).slice(0, 4); } catch { /* ignore */ }
  }

  const newFunctions = await aiRepairPipeline(sourcetype, destFormat, conf.functions, sampleRaw, currentOutput, findings);
  const newConf = { ...conf, functions: newFunctions };

  await criblFetch(`/m/${workerGroup}/p/${packId}/pipelines/${pipelineId}`, {
    method: 'PATCH', body: JSON.stringify({ id: pipelineId, conf: newConf }),
  });
  const commit = await criblFetch<{ items: any[] }>(`/version/commit`, {
    method: 'POST', body: JSON.stringify({ message: `Repair pipeline ${pipelineId} in ${packId}`, group: workerGroup }),
  });
  const commitId = commit.items?.[0]?.commit || 'unknown';
  await criblFetch(`/master/groups/${workerGroup}/deploy`, { method: 'PATCH', body: JSON.stringify({ version: commitId }) });
  return { pipelineId, repaired: true, commit: commitId, functionCount: newFunctions.length };
}

// Repair a pipeline: AI regenerates the failing mapping/output stages from the
// findings, PATCHes + commits + deploys. Works in both modes. In standalone the
// dev backend also persists lessons to the learnings file for future runs.
export async function repairPipeline(args: RepairPipelineArgs): Promise<{ pipelineId: string; repaired: boolean; commit: string; functionCount: number }> {
  // Standalone (shouldUseBackendProxy() true) → backend (Cribl PATCH/commit/
  // deploy needs auth only the .mjs handlers hold); iframe → client-side.
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/repair-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Repair failed');
    return data;
  }
  if (getRunMode() === 'iframe') {
    if (!isAiConfigured()) throw new Error('AI not configured — open Settings to add your API key');
    return repairPipelineClient(args);
  }
  throw new Error('Repair requires the dev backend or iframe (Cribl-hosted) mode.');
}

// --- Golden pipeline store ---

// The deterministic inputs that produced a verified pipeline. Replaying this
// through buildPack reproduces the pipeline exactly — no AI — so a custom source
// that once passed the quality gate is auto-promoted to built-in quality.
export interface GoldenRecipe {
  parseFunctions: any[] | null;   // AI-generated parse stage (null = built-in parser)
  mappings: AiMappingResult | null; // AI mapping input for the destination
  fingerprint?: SampleFingerprint | null; // sample structure the recipe was proven against
}

export interface GoldenReport {
  band: string;
  scoreSource: string;
  findings: { severity: string; field: string; issue: string; example?: string; pointImpact: number }[];
  missingFields: string[];
  emptyFields?: string[];
  summary: string;
}

export interface GoldenPipeline {
  functions: any[];
  score: number;
  updatedAt: string;
  recipe?: GoldenRecipe | null;
  report?: GoldenReport | null;
  /** Wire format of the sample it was proven on; null/absent = unknown (legacy). */
  wireFormat?: SourceWireFormat | null;
  /** Trust record (src/golden-trust.ts) — absent on a legacy golden. */
  evidence?: GoldenEvidence | null;
  observations?: GoldenObservation[];
  quarantine?: { reason: string; at: string } | null;
  functionsHash?: string;
  /** The store key this record was READ from (set by readers, never persisted). */
  storeKey?: string;
}

/** What a golden write did (src/golden-trust.ts `planGoldenWrite`). */
export interface GoldenSaveResult { action: GoldenWriteAction; reasons: string[] }

/**
 * `wireFormat` is the build sample's wire format (`goldenWireFormatForSample`).
 * Given, the golden resolves through the variant rule (src/golden-variant.ts) so
 * a FortiGate CEF build never replays the key=value golden. Omitted (undefined)
 * = the exact key as given — the pre-variant behaviour.
 */
export async function getGoldenPipeline(sourcetype: string, destFormat: string, wireFormat?: SourceWireFormat | null): Promise<GoldenPipeline | null> {
  // Standalone reads goldens from the file store via the backend; only the
  // iframe (no backend) path uses bundled defaults + localStorage.
  if (shouldUseBackendProxy()) {
    const wire = wireFormat === undefined ? '' : `&wireFormat=${encodeURIComponent(wireFormat || '')}`;
    const resp = await fetch(`/api/pack-generator/golden-pipeline?sourcetype=${encodeURIComponent(sourcetype)}&destFormat=${encodeURIComponent(destFormat)}${wire}`);
    const data = await resp.json();
    return data.golden || null;
  }
  // iframe + direct-configured: safe storage first, then bundled defaults.
  // Every real call site (getGoldenPart and friends) already wraps this in
  // `.catch(() => null)`, so a context with no loader registered (e.g. the
  // Backend Function — see `bundledGoldens`'s declaration above) correctly
  // falls through to "no golden part found" rather than getting wrong data.
  return (await bundledGoldens()).getBundledGoldenPipeline(sourcetype, destFormat, wireFormat);
}

/**
 * `wireFormat` known → filed under its variant key (src/golden-variant.ts).
 *
 * `evidence` (src/golden-evidence.ts) is what admits the write: without it the
 * store REFUSES (docs/specs/golden-trust.md R1) — a bare score is source-relative
 * and cannot rank one golden against another. Both stores decide with the same
 * `planGoldenWrite`, so standalone and iframe keep the same knowledge.
 */
export async function saveGoldenPipeline(sourcetype: string, destFormat: string, functions: any[], score: number, recipe?: GoldenRecipe | null, report?: GoldenReport | null, wireFormat?: SourceWireFormat | null, evidence?: GoldenEvidence | null): Promise<GoldenSaveResult> {
  // A format label (`json`, `csv`, …) is not a source. Refuse before either
  // store so a vendor mapping cannot be filed where every sample of that
  // shape would replay it. CEF/LEEF and `<vendor>@json` stay allowed.
  const blocked = nonSourceMappingGoldenReason(goldenVariantSourcetype(sourcetype, wireFormat), destFormat);
  if (blocked) return { action: 'refuse', reasons: [blocked] };
  // Standalone persists goldens to the file store via the backend; only the
  // iframe (no backend) path falls back to localStorage.
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/golden-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcetype, destFormat, functions, score, recipe, report, wireFormat: wireFormat || null, evidence: evidence || null }),
    });
    const data = await resp.json().catch(() => ({}));
    return { action: data.action || (resp.ok ? 'keep' : 'refuse'), reasons: data.reasons || (resp.ok ? [] : [data.error || `HTTP ${resp.status}`]) };
  }
  // Explicit no-op rather than a misleading in-memory write that dies with the
  // invocation — a Backend Function has no durable local store to write to.
  if (getRunMode() === 'backend') return { action: 'keep', reasons: ['a Backend Function has no durable golden store'] };
  const exactKey = `${goldenVariantSourcetype(sourcetype, wireFormat)}::${destFormat}`;
  const key = `golden::${exactKey}`;
  const store = await bundledGoldens();
  const existing = await store.readStoredGolden(exactKey).catch(() => null) as StoredGolden | null;
  const plan = planGoldenWrite(existing, {
    functions, evidence, recipe: recipe || null, report: report || null,
    wireFormat: wireFormat || splitGoldenVariant(sourcetype).wire || null,
  });
  if (plan.record) await persistGoldenRecord(key, plan.record);
  return { action: plan.action, reasons: plan.reasons };
}

async function persistGoldenRecord(key: string, record: StoredGolden): Promise<void> {
  const body = JSON.stringify(record);
  const saved = await (await bundledGoldens()).saveGoldenDurably(key, body).catch(() => null);
  if (!saved?.ok) {
    safeSetItem(key, body);   // still serves the rest of this session
    console.warn(`[goldens] ${key} is kept for this session only — ${saved && !saved.ok ? saved.reason : 'browser storage refused the write'}.`);
  }
}

/**
 * Write a reused golden's verdict back to the record it judged (golden-trust R3).
 * Recorded WHATEVER the score — a low one is exactly the observation that must be
 * able to quarantine (R5). `expectedHash` = the function list that was measured;
 * a record replaced meanwhile is left alone. Best-effort: never fails a build.
 */
export async function observeGolden(exactKey: string, evidence: GoldenEvidence, expectedHash?: string | null): Promise<GoldenSaveResult> {
  try {
    if (shouldUseBackendProxy()) {
      const resp = await proxyFetch('/api/pack-generator/golden-observe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: exactKey, evidence, expectedHash: expectedHash || null }),
      });
      const data = await resp.json().catch(() => ({}));
      return { action: data.action || 'keep', reasons: data.reasons || [] };
    }
    if (getRunMode() === 'backend') return { action: 'keep', reasons: ['a Backend Function has no durable golden store'] };
    const existing = await (await bundledGoldens()).readStoredGolden(exactKey).catch(() => null) as StoredGolden | null;
    const plan = planGoldenObservation(existing, evidence, expectedHash);
    if (plan.record) await persistGoldenRecord(`golden::${exactKey}`, plan.record);
    return { action: plan.action, reasons: plan.reasons };
  } catch (e) {
    return { action: 'keep', reasons: [e instanceof Error ? e.message : String(e)] };
  }
}

/** The store key a stage part is filed under — the one `saveGoldenPart` writes. */
export function goldenPartStoreKey(stage: StagePart, sourcetype: string, destFormat: string, wireFormat?: SourceWireFormat | null): string {
  return `${goldenVariantSourcetype(sourcetype, wireFormat)}::${goldenPartKey(stage, destFormat)}`;
}

/** Identity of a golden's function list, for `observeGolden`'s `expectedHash`. */
export function goldenHashOf(golden: { functions?: unknown[]; functionsHash?: string } | null | undefined): string | null {
  if (!golden) return null;
  return golden.functionsHash || goldenFunctionsHash(golden.functions || []);
}

// --- Experimental 3-stage golden sub-parts -----------------------------------
// Reuses the golden store with composite keys that never collide with the real
// `sourcetype::destFormat` entries, so the single-line golden path ignores them:
//   extraction:    <sourcetype>::__extraction__        (destination-independent)
//   mapping:       <sourcetype>::<destFormat>::__mapping__
export type StagePart = 'extraction' | 'mapping';

export function goldenPartKey(stage: StagePart, destFormat: string): string {
  if (stage === 'extraction') return '__extraction__';
  return `${destFormat}::__mapping__`;   // combined with sourcetype by the store
}

export async function getGoldenPart(stage: StagePart, sourcetype: string, destFormat: string, wireFormat?: SourceWireFormat | null): Promise<GoldenPipeline | null> {
  const golden = await getGoldenPipeline(sourcetype, goldenPartKey(stage, destFormat), wireFormat);
  if (stage === 'extraction') {
    if (golden && !validateExtractionStage(golden.functions).valid) return null;
    return golden;
  }
  if (golden) return validateMappingStage(golden.functions).valid ? golden : null;
  // No part under the concrete key. A build always asks for a concretized format
  // (`ocsf#network`, never `ocsf`), so a part filed under the bare family key is
  // otherwise dead — see src/golden-format-fallback.ts. Promote one ONLY when it
  // proves it targets this class; an unprovable part stays unreachable.
  for (const family of goldenFormatFallbacks(destFormat)) {
    const cand = await getGoldenPipeline(sourcetype, goldenPartKey(stage, family), wireFormat).catch(() => null);
    if (!cand || !mappingServesFormat(cand.functions, destFormat)) continue;
    if (validateMappingStage(cand.functions).valid) return cand;
  }
  return null;
}

export async function saveGoldenPart(stage: StagePart, sourcetype: string, destFormat: string, functions: any[], score: number, report?: GoldenReport | null, fingerprint?: SampleFingerprint | null, wireFormat?: SourceWireFormat | null, evidence?: GoldenEvidence | null): Promise<GoldenSaveResult> {
  if (stage === 'extraction') {
    if (!fingerprint) {
      throw new Error('Extraction golden rejected: sample fingerprint is required.');
    }
    const contract = validateExtractionStage(functions);
    if (!contract.valid) {
      throw new Error(`Extraction golden rejected: ${contract.reasons.join('; ')}`);
    }
  }
  if (stage === 'mapping') {
    if (!fingerprint) {
      throw new Error('Mapping golden rejected: sample fingerprint is required.');
    }
    const contract = validateMappingStage(functions);
    if (!contract.valid) {
      throw new Error(`Mapping golden rejected: ${contract.reasons.join('; ')}`);
    }
  }
  // Store the sample fingerprint (input format + keys) the part was proven
  // against, so a later run can reject a golden whose input format doesn't match
  // the current sample (a sourcetype can arrive as CSV in one env, JSON in
  // another — a golden built on one must not be applied blindly to the other).
  const recipe = fingerprint ? { fingerprint } as GoldenRecipe : null;
  return saveGoldenPipeline(sourcetype, goldenPartKey(stage, destFormat), functions, score, recipe, report, wireFormat, evidence);
}

// --- Pre-deploy quality gate ---

export interface PreDeployResult {
  score: number;
  findings: { severity: string; field: string; issue: string }[];
  missingFields: string[];
  emptyFields?: string[];
  summary: string;
  suggestions: string[];
}

export async function preDeployValidate(sourcetype: string, destFormat: string, functions: any[], sampleEvents: string): Promise<PreDeployResult> {
  if (shouldUseBackendProxy()) {
    const resp = await proxyFetch('/api/pack-generator/pre-deploy-validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcetype, destFormat, functions, sampleEvents }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Pre-deploy validation failed');
    return data as PreDeployResult;
  }
  const { invokeAi } = await import('./ai-client');
  const sampleLines = sampleEvents.split('\n').filter(Boolean).slice(0, 5);
  const system = `You are a strict Cribl Stream pipeline QA validator. You are given pipeline functions (JSON config) and sample INPUT events. Mentally simulate what this pipeline would produce from these inputs, then score the expected output vs the target schema.

Return ONLY valid JSON:
{"score":0-100,"findings":[{"severity":"high|medium|low","field":"<field>","issue":"what is wrong"}],"missingFields":["schema fields the pipeline does not produce"],"summary":"2-3 sentence assessment","suggestions":["specific fixes to improve the pipeline"]}

Scoring:
- 85-100: Pipeline correctly parses, maps all key fields to target schema, handles edge cases.
- 60-84: Structurally correct but missing fields or has mapping gaps.
- <60: Broken — wrong parsing, empty mappings, field name mismatches, or expressions that would fail.
Score down hard for: eval expressions using arrow functions or semicolons (Cribl rejects these), field names with @ or hyphens, unmapped required schema fields, parse functions that don't match the input format.`;
  const user = `SOURCE: ${sourcetype}\nTARGET FORMAT: ${destFormat}\n\nPIPELINE FUNCTIONS (${functions.length} total):\n${JSON.stringify(functions, null, 2).slice(0, 8000)}\n\nSAMPLE INPUT (first ${sampleLines.length} events):\n${sampleLines.join('\n').slice(0, 4000)}\n\nMentally execute this pipeline against the sample events and score the expected output against the ${destFormat} schema.`;
  const text = await invokeAi(system, user, 4096);
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1].trim());
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s !== -1 && e > s) return JSON.parse(text.substring(s, e + 1));
    throw new Error('AI did not return valid JSON');
  }
}


// Reference catalog and sample library — knowledge extracted from professional
// dispensary packs (see config/reference-catalog.json).

export interface ReferenceAvailability {
  hasSamples: boolean;
  sampleEvents: number;
  fields: number;
  transformations: string[];
  optimizations: string[];
  pack: string | null;
}

export async function fetchReferenceCatalog(): Promise<{ sourcetypes: Record<string, { pack: string; displayName: string; hasSamples: boolean; sampleCount: number; fields: number; transformations: string[]; optimizations: string[] }>; total: number }> {
  if (getRunMode() === 'iframe') return (await bundled()).getBundledCatalog() as any;
  const res = await proxyFetch('/api/pack-generator/reference-catalog');
  return res.json();
}

// Bulk availability check for the app's canonical sourcetypes (drives UI badges).
export async function fetchReferenceAvailability(): Promise<{ availability: Record<string, ReferenceAvailability> }> {
  if (getRunMode() === 'iframe') return (await bundled()).getBundledAvailability() as any;
  const res = await proxyFetch('/api/pack-generator/reference-availability');
  return res.json();
}

export interface ReferenceSampleResult {
  available: boolean;
  events?: unknown[];
  sourcetype?: string;
  pack?: string;
  fields?: string[];
  sampleName?: string;
  synthetic?: boolean;
  /** Origin of a destination-specific sample (for example Palo pack vs contract fixture). */
  provenance?: string;
  /** Events appended by request-time extension (0 / absent when all real). */
  syntheticCount?: number;
  /** What extension did, for the build log — never an error the caller must handle. */
  extensionNote?: string;
}

/**
 * Top a thin real sample up to `SAMPLE_EXTEND_TARGET` events with AI.
 *
 * 486 of the harvested sourcetypes have fewer than 20 real lines in existence, and a
 * pipeline built from 1-2 events barely generalizes — a regex written from one
 * example usually matches only that example. The extra events are generated HERE, at
 * request time, and never committed: the sample stores stay real and traceable, and a
 * bad extension dies with this build.
 *
 * Every generated line must survive `guardExtendedEvents` (deterministic, no second
 * AI call): same envelope, no field the real lines don't carry, same column count or
 * vocabulary, and the source's own parser must still read the combined sample. A
 * failure at any point returns the REAL sample untouched — extension can improve a
 * build but must never block or damage one.
 */
async function extendThinSample(sourcetype: string, result: ReferenceSampleResult, format?: string): Promise<ReferenceSampleResult> {
  if (!result?.available || !needsSampleExtension(result.events)) return result;
  // `eventsToLines`, NOT JSON.stringify: `config/sample-library/` stores Cribl event
  // OBJECTS, and serialising one hands the model (and the pack) a double-wrapped
  // `{"_raw":"…"}` envelope instead of the log line. See eventToLine.
  const real = eventsToLines(result.events);
  if (!real.length) return result;
  const want = SAMPLE_EXTEND_TARGET - real.length;
  const note = (extensionNote: string): ReferenceSampleResult => ({ ...result, extensionNote });

  // Cache on the REAL lines' fingerprint: same sample in, same extension out, so
  // rebuilding a pack costs nothing and two runs of one batch stay comparable.
  const cacheKey = generatedSampleCacheKey('ext', sourcetype, SAMPLE_EXTEND_TARGET, format || 'ext', sampleRejectionFingerprint(real));
  const cached = await loadGeneratedSample(cacheKey);
  if (cached?.events?.length) {
    recordSyntheticLines(cached.events);
    return { ...result, events: [...real, ...cached.events], syntheticCount: cached.events.length,
      extensionNote: `reused ${cached.events.length} generated event(s) to reach ${real.length + cached.events.length}` };
  }

  // The generation call, in whichever mode we are in. ONE implementation of the
  // guard and the retry policy sits here so the two modes cannot drift.
  const generate = async (plan: SampleExtensionAttempt, feedback: string): Promise<string[]> => {
    if (shouldUseBackendProxy()) {
      const resp = await proxyFetch('/api/pack-generator/ai-extend-sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcetype, events: real, ask: plan.ask, maxTokens: plan.maxTokens, feedback }),
      });
      if (!resp.ok) throw new Error('extension backend unavailable');
      return (await resp.json())?.candidates || [];
    }
    if (!isAiConfigured()) throw new Error('no AI provider configured');
    const { aiExtendSampleEvents } = await import('./ai-client');
    return aiExtendSampleEvents(sourcetype, real, plan.ask, plan.maxTokens, feedback);
  };

  // At most two attempts (`sampleExtensionAttempts` owns the ask/budget plan for both
  // modes), and the second one is TOLD what failed — a model that got the shape wrong
  // repeats it verbatim if you re-send the same prompt, at 30-90s a go (the same
  // lesson the AI-sample library learned). Measured: a 1972-char kvp source came back
  // with 130-char lines and lost all 29 candidates to the length guard on attempt 1.
  // In the iframe the plan has to fit the platform proxy's 30s ceiling, or both
  // attempts are spent waiting for answers that will be cancelled on arrival.
  const plans = sampleExtensionAttempts(real, want,
    getRunMode() === 'iframe' ? { budgetMs: IFRAME_PROXY_BUDGET_MS } : {});
  let lastNote = 'sample too thin to extend: the model returned nothing usable';
  let feedback = '';
  for (let attempt = 1; attempt <= plans.length; attempt++) {
    let candidates: string[] = [];
    try {
      candidates = await generate(plans[attempt - 1], feedback);
    } catch (err) {
      // A failed call is not the end of the road: the commonest failure IS a timeout on
      // a wide ask (thycotic_ss ran past 240s asking for 16 CEF lines), and the retry's
      // whole point is that it asks for fewer. Only the last attempt's reason is kept.
      const why = err instanceof Error ? err.message : 'the generation call failed';
      lastNote = `sample too thin to extend: ${why}`;
      continue;
    }
    if (!candidates.length) continue;

    const guard = guardExtendedEvents(sourcetype, real, candidates);
    if (!guard.accepted.length) {
      lastNote = `sample too thin to extend: all ${candidates.length} generated event(s) failed the shape guards (${guard.rejected[0]?.reason || 'no reason recorded'})`;
      feedback = renderExtensionFeedback(guard.rejected);
      continue;
    }
    await saveGeneratedSample(cacheKey, undefined, { events: guard.accepted, count: guard.accepted.length } as GeneratedSampleResult);
    recordSyntheticLines(guard.accepted);
    return {
      ...result,
      events: [...real, ...guard.accepted],
      syntheticCount: guard.accepted.length,
      extensionNote: `extended ${real.length} real event(s) with ${guard.accepted.length} generated one(s)`
        + (guard.rejected.length ? `; ${guard.rejected.length} rejected by the shape guards` : '')
        + (attempt > 1 ? ' (second attempt)' : ''),
    };
  }
  return note(lastNote);
}

// `format` only narrows the AI-sample-library tier (a source that emits more than
// one wire format can have one verified sample per format); every other tier
// ignores it, so callers that don't know the format may omit it.
/**
 * Resolve the bundled/reference sample for a sourcetype.
 *
 * `extend: false` returns the stored events untouched. The wizard uses it to LABEL
 * the wire format of the sample it is offering — that probe must not trigger
 * request-time extension, which costs an AI call of 60-240s for events the user has
 * not asked for yet.
 */
export async function fetchReferenceSample(
  sourcetype: string,
  format?: string,
  opts?: { extend?: boolean },
): Promise<ReferenceSampleResult> {
  const resolve = async (): Promise<ReferenceSampleResult> => {
    if (getRunMode() === 'iframe') return await (await bundled()).getBundledSample(sourcetype, format);
    const qs = new URLSearchParams({ sourcetype });
    if (format) qs.set('format', format);
    const res = await fetch(`/api/pack-generator/reference-sample?${qs}`);
    return res.json();
  };
  const resolved = await resolve();
  if (resolved?.available && Array.isArray(resolved.events)) {
    recordStoreSample(eventsToLines(resolved.events), resolved.pack, { synthetic: resolved.synthetic === true });
  }
  if (opts?.extend === false) return resolved;
  return extendThinSample(sourcetype, resolved, format);
}

/**
 * Extend a sample that has ALREADY been resolved from the stores.
 *
 * The batch pre-flight reads the stores with `extend: false` — a store read has to
 * stay a store read, or a screen that says "resolving samples" silently fires a
 * 60-240s model call per thin source — and then extends the thin ones in its own
 * visible, capped pass. This is the same `extendThinSample` the build path uses, so
 * there is one guard, one cache key and one retry policy, not two.
 */
export async function extendResolvedSample(
  sourcetype: string,
  events: string[],
  format?: string,
): Promise<ReferenceSampleResult> {
  return extendThinSample(sourcetype, { available: true, events }, format);
}

export interface ReferenceLookupFile { file: string; content: string; description: string; rows: number }

// Fetch the golden lookup files (with CSV content) that apply to a sourcetype.
// Used by the deploy path to upload them into the pack so lookup-driven parsing
// resolves at runtime. Returns [] if none apply or the backend is unavailable.
export async function fetchReferenceLookups(sourcetype: string): Promise<ReferenceLookupFile[]> {
  if (getRunMode() === 'iframe') return (await bundled()).getBundledLookups(sourcetype);
  // A Backend Function has neither of the other two lookup stores: no Vite
  // middleware to ask (Hard Rule 17) and no bundled knowledge graph (it would
  // blow the 5 MB bundle cap). It has its own — the ~160 KB corpus the packager
  // injects as a build-time define — so a background-built pack ships the same
  // `data/lookups/` a wizard-built one does. With no corpus injected this is []
  // rather than a relative request with no dev server behind it.
  if (getRunMode() === 'backend') return backendReferenceLookups(sourcetype);
  try {
    const res = await fetch(`/api/pack-generator/reference-lookups?sourcetype=${encodeURIComponent(sourcetype)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.lookups || [];
  } catch {
    return [];
  }
}

export type DatatypeAudit = DatatypeAuditReport;

// Install the stored parser overlay so the builder resolves imported datatypes.
// Memoized: every caller awaits the same single KV read.
let datatypeOverlayReady: Promise<void> | null = null;
export function ensureDatatypeOverlay(): Promise<void> {
  if (!datatypeOverlayReady) {
    datatypeOverlayReady = loadDatatypeOverlay()
      .then(overlay => { if (!overlayIsEmpty(overlay)) installDatatypeParserOverlay(overlay); })
      .catch(() => { /* an unreadable overlay must never block building */ });
  }
  return datatypeOverlayReady;
}

// Audit Cribl Search datatypes vs. what the app has imported, and on apply import
// the new/changed parsers and drop the stale ones.
//
// Both modes run the SAME audit engine; only the store differs. Standalone writes
// config/datatype-parsers.json through the backend (the repo's own library). The
// iframe has no filesystem, so it persists the delta as a per-install overlay in
// the app's KV store and installs it into the builder immediately — before this,
// the iframe could only look at the report and the Sync button was dead.
export async function auditDatatypes(apply = false, group?: string): Promise<DatatypeAudit> {
  if (shouldUseBackendProxy()) {
    const qs = group ? `?group=${encodeURIComponent(group)}` : '';
    const res = await fetch(`/api/pack-generator/datatype-audit${qs}`, { method: apply ? 'POST' : 'GET' });
    return res.json();
  }

  await ensureDatatypeOverlay();
  const live = await listSearchDatatypes();
  const searchGroup = group || 'default_search';
  const { report, parsers, changed } = (await bundled()).getBundledDatatypeAudit(live, searchGroup, {
    apply,
    parsers: getDatatypeParserStore(),
  });
  if (!apply || !changed) return { ...report, storedIn: 'app-kv' };

  const overlay = diffDatatypeOverlay(getBundledDatatypeParsers(), parsers, { group: searchGroup });
  const { storedIn } = await saveDatatypeOverlay(overlay);
  installDatatypeParserOverlay(overlay);
  return { ...report, storedIn };
}

export interface LookupHealResult {
  file?: string;
  codeField?: string;
  content?: string;
  repaired?: { code: string; before: string | null; after: string; sampleCount: number; added?: boolean }[];
  persisted?: boolean;
}

// Self-heal the code-driven parsing lookup for a sourcetype against the real
// sample: codes whose regex doesn't match get an AI-repaired regex. Returns the
// patched lookup content (to bundle into the pack) + which codes were fixed.
// Returns { repaired: [] } when nothing needs fixing or the source has no such
// lookup. Best-effort — never throws into the deploy flow.
export async function healLookup(sourcetype: string, sampleEvents: string): Promise<LookupHealResult> {
  // Healing runs in the Vite backend handler, which a Backend Function cannot
  // reach (Hard Rule 17). Unlike the lookup CORPUS — which a Backend Function
  // now carries embedded — healing is not static data: it re-derives a code's
  // regex from the sample at build time, against the repo's own self-heal
  // engine. A background-built pack therefore ships the corpus as INDEXED,
  // matching a standalone build that healed nothing; the degradation is the
  // same one a failed heal already produces (no repairs), not a missing lookup.
  if (getRunMode() === 'backend') return { repaired: [] };
  try {
    const res = await proxyFetch('/api/pack-generator/heal-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcetype, sampleEvents }),
    });
    if (!res.ok) return { repaired: [] };
    return await res.json();
  } catch {
    return { repaired: [] };
  }
}

// --- Score logging (Cribl Lake dataset: pack_generator_app_scores) ---

// Sends one generated-pipeline score to the pack_generator_app_scores dataset via
// Cribl Search's HTTP ingest endpoint, so pipeline quality can be tracked over
// time. Best-effort/fire-and-forget by design — swallow all errors so a missing
// dataset or auth hiccup never blocks the generate/deploy flow.
export async function logPipelineScore(data: {
  sourcetype: string;
  pack_id: string;
  pipeline_id: string;
  dest_format: string;
  score: number | null;   // null = N/A (nothing to score, e.g. a passthrough raw copy) — logged as null, excluded from AVG
  sample_name: string;
  model_used: string;
  tokens_input: number;
  tokens_output: number;
  worker_group: string;
  is_golden_path: boolean;
  generation_mode: string;
  findings_count: number;
  status: 'success' | 'error' | 'skipped' | 'repaired';
  deploy_message: string;
  // Completion-event fields (one event per pipeline when its process finishes):
  flow?: 'normal' | 'repair';         // which path the pipeline went through
  trial_scores?: number[];            // score of each trial/round in the process
  first_score?: number | null;        // the initial live score (score_1)
  final_score?: number | null;        // best/final live score on the worker group
  deployment_score?: number | null;   // the SAVED/deployed score → average on this
  stored_value?: number | null;       // score stored to golden (null if not stored)
  start_time?: number;                // pipeline build start (epoch seconds)
  end_time?: number;                  // pipeline completion (epoch seconds)
  // --- 3-stage build fields (extraction / mapping / optimization) ---
  builder?: 'staged' | 'classic';     // which builder produced the pack
  build_mode?: string;                // 'new' | 'add-pipeline'
  origin?: string;                    // which UI flow: 'create' | 'demo' | 'batch' | 'experiment'
  extraction_score?: number | null;   // stage scores
  mapping_score?: number | null;
  optimization_score?: number | null;
  extraction_source?: string;         // where each stage's functions came from
  mapping_source?: string;            // (search | golden | copilot | ai | static | none)
  optimization_source?: string;
  // --- provenance + cost, so a batch can be analysed without a live-org probe ---
  sample_tier?: string;               // preflight | reference | ai-generated | bundled | none
  sample_store_tier?: string | null;  // golden-trust ladder tier (src/sample-provenance.ts); null = unknown
  sample_synthetic_count?: number | null; // AI-written lines in the sample; null = unknown
  // --- reuse verdict (golden-trust R3): a stored golden this build measured ---
  golden_key?: string;
  golden_origin?: string;             // 'extraction' | 'mapping' | 'extraction,mapping'
  golden_recorded_score?: number | null;
  golden_observed_score?: number | null;
  sample_reason?: string;             // why a row had no sample (verbatim tier failure)
  prepare_ms?: number;                // sample resolution + parser + lookups
  build_ms?: number;                  // 3-stage build
  total_ms?: number;                  // whole row
  // --- what the deployed pipeline is made of (function-composition.ts) ---
  function_total?: number;            // enabled functions, comments excluded
  function_types?: string;            // e.g. "eval×5 serde×2 regex_extract"
  regex_extract_count?: number;
  serde_count?: number;               // Parser functions
  code_count?: number;
  ungated_extractor_count?: number;   // serde/regex_extract/grok with no filter
  multi_regex?: boolean;              // >1 regex_extract
  multi_parser?: boolean;             // >1 Parser
  // --- OCSF destinations only (staged-build ocsfMappingTelemetry) ---
  ocsf_class_uid?: number | null;          // class_uid the mapped output emits (most frequent)
  ocsf_expected_class_uid?: number | null; // class this source should be (enforceable classes only)
  ocsf_schema_score?: number | null;       // real-schema oracle score, before any cap
  ocsf_cap?: number | null;                // envelope (55) / class (50) cap that bound the mapping score
  [k: `score_${number}`]: number | null | undefined; // per-trial columns score_1, score_2, …
}): Promise<{ ok: boolean; reason?: string }> {
  // Best-effort/fire-and-forget by design — this NEVER throws. But it USED to
  // return void and swallow every failure, so a whole batch could silently log
  // nothing (empty dataset) with no signal to the user. It now returns a status
  // the caller can tally + surface, without ever blocking the generate/deploy flow.
  try {
    const q = loadQualitySettings();
    if (shouldUseBackendProxy()) {
      const resp = await proxyFetch('/api/pack-generator/log-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, _lakeUrl: q.lakeUrl }),
      });
      if (!resp.ok) return { ok: false, reason: `log endpoint HTTP ${resp.status}` };
      const body = await resp.json().catch(() => ({} as { logged?: boolean; message?: string }));
      return body?.logged
        ? { ok: true }
        : { ok: false, reason: body?.message || 'scoring endpoint rejected the event' };
    }
    // iframe/backend mode: the Lake ingest credential is server-side by design
    // (never in the browser, and a Backend Function has no equivalent provisioned
    // for it either — Rule 15) and the direct-access port is browser-blocked, so
    // logging can only run from the standalone backend. Report it honestly
    // instead of a silent no-op that looks like it worked.
    return { ok: false, reason: `${getRunMode()} mode — score logging runs only from the standalone backend` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'score log call failed' };
  }
}

export async function checkLakeExportHealth(): Promise<{ active: boolean; message: string }> {
  try {
    const q = loadQualitySettings();
    if (shouldUseBackendProxy()) {
      const resp = await proxyFetch('/api/pack-generator/lake-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: q.lakeUrl }),
      });
      if (!resp.ok) return { active: false, message: `Health check failed: HTTP ${resp.status}` };
      return await resp.json();
    } else {
      // iframe mode — Lake scoring is not available (no token/endpoint configured)
      return { active: false, message: 'Score logging not available in iframe mode' };
    }
  } catch (err) {
    console.warn('[lake-health] error:', err);
    return { active: false, message: 'Lake export unavailable' };
  }
}

// --- Quality operations: the five effects behind src/quality-stage.ts --------
//
// The engine is pure; these are the only things that touch Cribl or AI, and
// they are shared by every caller (foreground wizard, iframe orchestration,
// the background Backend Function) so nobody forks the policy. Each one is
// mode-aware through the primitives it is built from — `previewPipeline`,
// `getPackPipeline`, `patchPipeline`, `saveGoldenPipeline` — so the SAME ops
// work in standalone (backend proxy), iframe and backend (Hard Rule 18).
//
// NOTHING here commits or deploys: a repair PATCHes with the deploy deferred,
// and the caller commits exactly once afterwards (Hard Rule 13).

/** The sample the pipeline parses, read back from the pack when not held. */
const qualitySampleLines = (ref: QualityPipelineRef): Promise<string[]> => resolveSampleLines(ref, async () => {
  const stored = await getPackSample(ref.workerGroup, ref.packId, ref.sampleName);
  return (stored?.events || []).map(line => String(line));
});

/**
 * Score a LIVE pipeline authoritatively: run its sample through the deployed
 * pipeline and measure value coverage over the real events (Hard Rule 12). The
 * AI is not consulted — `includeAi:false` (Hard Rule 17) — because the score is
 * deterministic and an AI call here is cost and fragility, not signal.
 *
 * The preview is this function's; everything after it — the false-zero retry,
 * the raw keys, the real/unmeasured rule, the repair guidance — is the shared
 * measurement in `src/quality-measure.ts`, so this and the backend scorer can
 * never drift onto two ideas of what a score is.
 */
export async function scoreLivePipeline(ref: QualityPipelineRef): Promise<QualityScore> {
  const args: ValidatePipelineArgs = {
    workerGroup: ref.workerGroup,
    packId: ref.packId,
    pipelineId: ref.pipelineId,
    sourcetype: ref.sourcetype,
    destFormat: ref.destFormat,
    sampleName: ref.sampleName,
    includeAi: false,
  };
  const rawEvents = await qualitySampleLines(ref);

  const attempt = await previewWithZeroOutputRetry(async () => {
    try {
      assertStageLive('the scoring preview');
      const outputEvents = await previewPipeline(args);
      assertStageLive('scoring the preview output');
      return { rawEvents, outputEvents };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A stage that ran out of invocation must unwind, not be recorded as an
      // unscorable pipeline.
      if (isStageAbortError(message)) throw err;
      // The measurement FAILED. Not a zero (Hard Rule 32) — a zero here is
      // indistinguishable from a pipeline that genuinely extracts nothing.
      return { rawEvents, outputEvents: [] as any[], error: message };
    }
  });

  const measured = measureAuthoritative({
    destFormat: ref.destFormat,
    sourcetype: ref.sourcetype,
    rawEvents,
    outputEvents: attempt.outputEvents,
    error: attempt.error,
  });
  const { auth, sampleKeys: _keys, ...score } = measured;
  return {
    ...score,
    report: auth
      ? { score: auth.score, band: auth.band, scoreSource: auth.scoreSource, outputCount: attempt.outputEvents.length, inputCount: rawEvents.length }
      : null,
  };
}

/**
 * ONE AI repair proposal, PATCHed onto the live pipeline with its deploy
 * DEFERRED. Distinct from `repairPipeline`, which commits and deploys on the
 * spot: a quality run patches many pipelines and deploys them together, once.
 */
export async function proposeRepairPatch(
  args: RepairPipelineArgs & { model?: string; sampleEvents?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    assertStageLive('the AI repair proposal');
    if (shouldUseBackendProxy()) {
      const resp = await proxyFetch('/api/pack-generator/repair-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, deferDeploy: true }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) return { ok: false, error: data.error || `Repair failed (${resp.status}).` };
      return { ok: true };
    }
    // iframe and Backend Function: the repair is composed here from the same
    // browser-safe primitives, so neither mode needs the dev middleware.
    const { conf } = await getPackPipeline(args.workerGroup, args.packId, args.pipelineId);
    if (!conf) return { ok: false, error: 'Could not load the live pipeline conf.' };
    const currentOutput = await previewPipeline({ ...args, includeAi: false }).catch(() => [] as any[]);
    // The same sample the SCORER measures against: a foreground or iframe
    // repair holds no sample text, and used to send the model an empty one
    // while asking it to fix the parsing.
    const sampleRaw = (await qualitySampleLines({ ...args } as QualityPipelineRef)).slice(0, 6);
    const functions = await aiRepairPipeline(
      args.sourcetype, args.destFormat, conf.functions, sampleRaw, currentOutput.slice(0, 4), args.findings,
    );
    if (!Array.isArray(functions) || !functions.length) return { ok: false, error: 'The model returned no functions.' };
    assertStageLive('the repair PATCH');
    await patchPipeline(args.packId, args.pipelineId, args.workerGroup, { ...conf, functions });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The real operations for `runQualityTransition`. A caller that wants a
 * READ-ONLY run does not pass a different set — it asks for the `scorecard`
 * action, which never reaches a write (see src/quality-stage.ts).
 */
export function criblQualityOperations(opts: { model?: string } = {}): QualityOperations {
  // Every operation is wrapped in the stage's abort check — before it starts
  // and again before its result is used — so a background stage that is out of
  // invocation can neither begin a PATCH nor act on a preview that came back
  // too late (Task 5's discipline, applied to quality).
  return guardQualityOperations({
    score: ref => scoreLivePipeline(ref),
    loadConf: async ref => {
      try {
        const { conf } = await getPackPipeline(ref.workerGroup, ref.packId, ref.pipelineId);
        return (conf as QualityConf) || null;
      } catch {
        // No baseline means no rollback target; the engine treats that as
        // "nothing to restore" rather than failing the row.
        return null;
      }
    },
    proposeRepair: (ref, input) => proposeRepairPatch({
      workerGroup: ref.workerGroup,
      packId: ref.packId,
      pipelineId: ref.pipelineId,
      sourcetype: ref.sourcetype,
      destFormat: ref.destFormat,
      sampleName: ref.sampleName,
      sampleEvents: ref.sampleEvents,
      findings: input.findings as ValidationFinding[],
      lessons: input.lessons,
      missingFields: input.missingFields,
      emptyFields: input.emptyFields,
      model: opts.model,
    }),
    patchConf: (ref, conf) => patchPipeline(ref.packId, ref.pipelineId, ref.workerGroup, conf),
    saveGolden: async (ref, input) => {
      const report = (input.report as GoldenReport) || null;
      // The engine stores only a REAL score at/above the bar (finalizeRepairStage),
      // so `real` is true by construction here. The evidence describes the exact
      // lines the scorer measured — the caller's sample, else the pack's — and its
      // provenance comes from the registry, with the caller's context as fallback.
      const evidence = buildGoldenEvidence({
        score: input.score, real: true, scoreSource: report?.scoreSource || 'value-coverage', band: report?.band,
        sampleEvents: await qualitySampleLines(ref),
        context: { sampleTier: ref.sampleTier, sourceMode: ref.sourceMode },
      });
      const r = await saveGoldenPipeline(
        ref.sourcetype, ref.destFormat, input.functions, input.score, null, report,
        goldenWireFormatForSample(ref.sampleEvents), evidence,
      );
      // A refused write is not a stored golden — and neither is a kept one (the
      // stored golden outranked this one, or this was a repeat). Mirrors
      // repair-core's `stored = action !== 'keep'`, so both modes report alike.
      if (r.action === 'refuse' || r.action === 'keep') {
        throw new Error(`golden not stored: ${r.reasons.join('; ') || 'kept the stored golden'}`);
      }
    },
  }, assertStageLive);
}

// Result of the post-deploy quality flow for one live pipeline.
export interface RepairQualityResult {
  pipelineId: string;
  flow: 'normal' | 'repair';
  // NULL = unmeasured. A score-only run whose live preview failed has no
  // number to report, and a 0 there reads as "this pipeline extracts nothing"
  // (Hard Rule 32).
  startScore: number | null;       // first live score after publish
  finalScore: number | null;       // best/final live score
  trialScores: number[];           // score per repair round (empty for normal flow)
  real: boolean;                   // deterministic score vs AI estimate
  stored: boolean;                 // stored to golden
  storedValue: number | null;
  rounds: number;
  error?: string;
  /**
   * The live pipeline may still be holding a repair candidate nobody verified:
   * the repair failed AND the rollback that would have removed it failed too.
   *
   * The caller OWNS the outer commit, so it has to be told. This function
   * refuses its own commit, but the interactive and batch flows commit the
   * whole worker group once at the end, and that commit is what would make the
   * candidate live — the one state the app cannot undo.
   */
  unresolved?: boolean;
  report?: any;                    // full validation report (for scorecard display)
}

// Score a just-deployed pipeline live and, if below the quality threshold, run
// the repair loop (real-score, best-wins, rollback). Works in both modes:
// standalone → backend NDJSON stream; iframe → client-side orchestration.
export async function repairQuality(opts: {
  workerGroup: string;
  packId: string;
  pipelineId: string;
  sourcetype: string;
  destFormat: string;
  sampleName: string;
  qualityThreshold?: number;
  /**
   * SCORE ONLY — the Scorecard action. No AI repair, no PATCH, no golden store,
   * at ANY score. (The old mechanism asked for `qualityThreshold: 101`, which
   * every "repair when below the threshold" branch correctly read as "repair
   * this": a request to MEASURE a pack rewrote it.)
   */
  dryRun?: boolean;
  deferCommit?: boolean;
  sampleEvents?: string;
  /** Provenance context for golden evidence when the sample never passed a store (src/sample-provenance.ts). */
  sampleTier?: string;
  sourceMode?: string;
  onProgress?: (msg: string) => void;
}): Promise<RepairQualityResult | null> {
  const q = loadQualitySettings();

  // --- score-only: the shared engine's read-only path, in EVERY run mode ---
  if (opts.dryRun) {
    const ref: QualityPipelineRef = {
      workerGroup: opts.workerGroup, packId: opts.packId, pipelineId: opts.pipelineId,
      sourcetype: opts.sourcetype, destFormat: opts.destFormat, sampleName: opts.sampleName,
      sampleEvents: opts.sampleEvents, sampleTier: opts.sampleTier, sourceMode: opts.sourceMode,
    };
    const transition = await runQualityTransition({
      phase: 'repair-score',
      action: 'scorecard',
      ref,
      artifact: initialQualityArtifact('scorecard'),
      ops: criblQualityOperations({ model: q.repairModel }),
      threshold: opts.qualityThreshold ?? q.qualityThreshold ?? 80,
      log: msg => opts.onProgress?.(msg),
    });
    opts.onProgress?.(transition.message);
    const result = transition.result;
    if (!result) return null;
    return {
      pipelineId: result.pipelineId,
      flow: result.flow,
      // A scorecard that could not measure reports NULL scores, never 0.
      startScore: result.firstScore,
      finalScore: result.finalScore,
      trialScores: [],
      real: result.real,
      stored: false,
      storedValue: null,
      rounds: 0,
      ...(result.error ? { error: result.error } : {}),
      report: result.report,
    };
  }

  // --- iframe mode: drive the SAME engine the background runner drives ---
  //
  // This used to be a second implementation of the repair loop, with its own
  // copies of the retry floor and round cap and NO rollback — a regression was
  // simply left live, so "best score wins" was only true of the number, not of
  // the pipeline. One engine, one policy (src/quality-stage.ts).
  if (getRunMode() === 'iframe') {
    if (!isAiConfigured()) { opts.onProgress?.('AI not configured'); return null; }
    const ref: QualityPipelineRef = {
      workerGroup: opts.workerGroup, packId: opts.packId, pipelineId: opts.pipelineId,
      sourcetype: opts.sourcetype, destFormat: opts.destFormat, sampleName: opts.sampleName,
      sampleEvents: opts.sampleEvents, sampleTier: opts.sampleTier, sourceMode: opts.sourceMode,
    };
    // The transitions the background runner spreads over ticks, run back to
    // back by the SAME engine — including its safety: a transition that throws
    // is wound down through `repair-finalize`, which puts the exact best conf
    // back. The browser's artifact is the only record there is, so the driver
    // marks a possible PATCH before the call rather than after it returns.
    const drive = await driveQualityToCompletion({
      ref,
      ops: criblQualityOperations({ model: q.repairModel }),
      threshold: opts.qualityThreshold ?? q.qualityThreshold ?? 80,
      log: message => opts.onProgress?.(message),
    });
    const result = drive.result;
    if (!result) return null;
    // Repairs PATCH with the deploy deferred, so a caller that is not doing its
    // own commit needs one here — and only if something really changed. Never
    // when the rollback failed: the live pipeline is then holding a candidate
    // nobody verified, and a commit is what would ship it.
    if (!drive.unresolved && result.changed && !opts.deferCommit) {
      await commitDeploy(opts.workerGroup, `quality-repair ${opts.pipelineId} in ${opts.packId}`);
    }
    return {
      pipelineId: result.pipelineId,
      flow: result.flow,
      startScore: result.firstScore,
      // An unresolved rollback means nobody knows what the pipeline is running,
      // so there is no score to report for it — only the error.
      finalScore: drive.unresolved ? null : result.finalScore,
      trialScores: result.trialScores.filter((s): s is number => s != null),
      real: result.real,
      stored: result.stored,
      storedValue: result.storedValue,
      rounds: result.rounds,
      ...(result.error ? { error: result.error } : {}),
      ...(drive.unresolved ? { unresolved: true } : {}),
      report: result.report,
    };
  }

  // --- standalone mode: backend NDJSON stream ---
  //
  // `unresolved` travels on the backend's own result object (repair-core sets it
  // when the best conf could not be written back), so the caller sees the same
  // flag from either transport.
  //
  // The server stores the golden but cannot see where its sample came from, so
  // the browser answers from its provenance registry — over the caller's sample,
  // else the pack's (the lines the server will score).
  const provenanceLines = opts.sampleEvents
    || ((await getPackSample(opts.workerGroup, opts.packId, opts.sampleName).catch(() => null))?.events || []).join('\n');
  try {
    const resp = await proxyFetch('/api/pack-generator/repair-quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerGroup: opts.workerGroup,
        packId: opts.packId,
        pipelineId: opts.pipelineId,
        sourcetype: opts.sourcetype,
        destFormat: opts.destFormat,
        sampleName: opts.sampleName,
        qualityThreshold: opts.qualityThreshold ?? q.qualityThreshold,
        repairModel: q.repairModel,
        lakeUrl: q.lakeUrl,
        shareGoldens: q.shareGoldens,
        goldenRepo: q.goldenRepo,
        goldenBranch: q.goldenBranch,
        deferCommit: opts.deferCommit,
        // Files the golden under the sample's wire variant; without it the
        // backend reads the format off the events it scored.
        wireFormat: goldenWireFormatForSample(opts.sampleEvents) || undefined,
        // The server cannot see where the sample came from; golden evidence needs
        // it (golden-trust R1). Null = unknown, which the store refuses.
        ...describeSampleProvenance(provenanceLines, { sampleTier: opts.sampleTier, sourceMode: opts.sourceMode }),
      }),
    });
    if (!resp.body) {
      const j = await resp.json();
      return j.result || null;
    }
    // Stream NDJSON progress lines; the last line carries {result:{...}}.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result: RepairQualityResult | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.result) result = obj.result;
          else if (obj.message) opts.onProgress?.(obj.message);
        } catch { /* ignore partial */ }
      }
    }
    return result;
  } catch (err) {
    opts.onProgress?.(`Repair-quality error: ${err instanceof Error ? err.message : 'unknown'}`);
    return null;
  }
}

// --- Cribl Cloud credentials (standalone .env, set via Settings) ------------

export interface CriblCreds {
  org: string;
  clientId: string;
  hasSecret: boolean;
  hasGoldenReadToken: boolean;
  hasSanitisedSampleToken: boolean;
  userEmail: string;
  configured: boolean;
}

// Read the currently-configured creds (never returns the secret). Standalone only.
export async function getCriblCreds(): Promise<CriblCreds | null> {
  if (getRunMode() !== 'standalone') return null;
  try {
    const r = await proxyFetch('/api/pack-generator/creds');
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Test creds by fetching an OAuth token + hitting the org (no persist). Empty
// clientSecret reuses the stored one.
export async function testCriblCreds(org: string, clientId: string, clientSecret: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await proxyFetch('/api/pack-generator/creds-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, clientId, clientSecret }),
    });
    return await r.json();
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : 'Test failed' }; }
}

// Persist creds to .env + apply at runtime (no restart needed). Empty
// clientSecret keeps the stored one.
export async function saveCriblCreds(org: string, clientId: string, clientSecret: string, userEmail: string): Promise<{ saved: boolean; configured?: boolean; message?: string }> {
  try {
    const r = await proxyFetch('/api/pack-generator/creds-save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, clientId, clientSecret, userEmail }),
    });
    return await r.json();
  } catch (e) { return { saved: false, message: e instanceof Error ? e.message : 'Save failed' }; }
}

// --- AI-sample library review (disk-backed, standalone-only) ------------------
//
// The review screen's data. Standalone only, and not because of a policy choice:
// staging lives in .cache/ai-samples-pending/ and the library in config/ai-samples/,
// both on disk. The iframe gets an explicit `available: false` and shows why, rather
// than a failed fetch (Hard Rule 18).


export interface StagedSampleDoc {
  key: string;
  sourcetype: string;
  format?: string | null;
  events: string[];
  eventsTotal: number;
  fingerprint: string;
  verification: {
    verdict: 'pass' | 'fail' | 'unverified';
    method: 'parser-emulation' | 'structure' | 'provenance' | 'none';
    eventsParsed: number;
    eventsChecked: number;
    fields: string[];
    reasons: string[];
  };
  provenance: { model: string; buildNumber: number; generatedAt: string; grounding?: string };
  probe?: boolean;
  /** A REAL log already exists for this source — so this generated one can never be served. */
  realSample?: { tier: 'curated' | 'source-samples' | 'vendor'; events: number } | null;
  /** Events this sourcetype carries in the real customer census — ORDERING only. */
  volume?: number | null;
  /**
   * An earlier reviewer deferred this source: the question they could not answer, and
   * whether THIS sample is the same content they saw. `sameContent` is the part that
   * decides what to do now — new content is worth a fresh look, a repeat is not.
   */
  deferred?: {
    reason: string;
    deferredAt: string;
    times: number;
    sameContent: boolean;
    firstEvent: string;
  } | null;
}

export interface LibrarySampleEntry {
  key: string;
  sourcetype: string;
  format?: string | null;
  events: number;
  fingerprint: string;
  verdict: 'pass' | 'fail' | 'unverified';
  method: string;
  fields: number;
  model: string | null;
  buildNumber: number | null;
  generatedAt: string | null;
  realSample?: { tier: string; events: number } | null;
}

export interface SampleLibraryState {
  available: boolean;
  staged: StagedSampleDoc[];
  library: LibrarySampleEntry[];
  rejectedCount?: number;
  error?: string;
  unavailableReason?: string;
}

const SAMPLE_LIB_IFRAME_REASON =
  'The sample library lives on disk (config/ai-samples/ and .cache/ai-samples-pending/), which the iframe cannot read. Run the app standalone to review staged samples.';

export async function fetchSampleLibrary(): Promise<SampleLibraryState> {
  if (getRunMode() === 'iframe') {
    return { available: false, staged: [], library: [], unavailableReason: SAMPLE_LIB_IFRAME_REASON };
  }
  try {
    const resp = await proxyFetch('/api/pack-generator/sample-library');
    const data = await resp.json();
    return { available: data.available !== false, staged: data.staged || [], library: data.library || [], rejectedCount: data.rejectedCount, error: data.error };
  } catch (err) {
    return { available: false, staged: [], library: [], error: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Counts only — for the header badge, which must not pull every event of 98 samples.
 *
 * `staged` is what there is to REVIEW: test artifacts are counted separately as
 * `probes`. The badge used to read 90 when 56 of those files were `conc_probe_*`
 * fixtures, which made the queue look 2.6x larger than the real work.
 */
export async function fetchSampleLibrarySummary(): Promise<{ staged: number; probes: number; library: number; rejected: number; shadowed: number } | null> {
  if (getRunMode() === 'iframe') return null;
  try {
    const resp = await proxyFetch('/api/pack-generator/sample-library?summary=1');
    const data = await resp.json();
    if (data.available === false) return null;
    return { staged: data.staged || 0, probes: data.probes || 0, library: data.library || 0, rejected: data.rejected || 0, shadowed: data.shadowed || 0 };
  } catch {
    return null;
  }
}

export interface SampleActionResult {
  key: string;
  ok: boolean;
  reason?: string | null;
  removedFromLibrary?: boolean;
  removedFromPending?: boolean;
}

/** Move staged samples into config/ai-samples/. `force` overrides a failed verification. */
export async function promoteStagedSamples(keys: string[], force = false): Promise<{ results: SampleActionResult[]; error?: string }> {
  if (getRunMode() === 'iframe') return { results: [], error: SAMPLE_LIB_IFRAME_REASON };
  try {
    const resp = await proxyFetch('/api/pack-generator/sample-library/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, force }),
    });
    return await resp.json();
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Remove from staging AND the library, and blacklist the content fingerprint.
 *
 * `reasons` (key → text) is stored alongside the blacklisted fingerprint. A reviewer's
 * "contradicted: cs1 carries the policy name, not the payload" is the input a
 * regeneration needs; keeping only the fingerprint would remember that a sample was
 * wrong and forget how.
 */
export async function rejectSamples(keys: string[], reasons: Record<string, string> = {}): Promise<{ results: SampleActionResult[]; error?: string }> {
  if (getRunMode() === 'iframe') return { results: [], error: SAMPLE_LIB_IFRAME_REASON };
  try {
    const resp = await proxyFetch('/api/pack-generator/sample-library/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, reasons }),
    });
    return await resp.json();
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Take samples out of the queue without deciding about them — no blacklist.
 *
 * The verdict for "I cannot tell yet". `reject` blacklists a content fingerprint
 * permanently, so using it on a merely doubtful sample stops the next generation from
 * ever producing those events again; leaving the sample staged instead means re-reading
 * it at every review. Deferring clears the queue and keeps the question, which comes
 * back attached to the next sample for that key.
 *
 * `reasons` (key → text) is REQUIRED for every key, unlike `discardStagedSamples`: the
 * recorded question is the entire difference between deferring and deleting.
 */
export async function deferStagedSamples(keys: string[], reasons: Record<string, string>): Promise<{ results: SampleActionResult[]; error?: string }> {
  if (getRunMode() === 'iframe') return { results: [], error: SAMPLE_LIB_IFRAME_REASON };
  try {
    const resp = await proxyFetch('/api/pack-generator/sample-library/defer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, reasons }),
    });
    return await resp.json();
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Delete from STAGING only, without blacklisting the fingerprint.
 *
 * For files that were never samples — the `conc_probe_*` concurrency-test artifacts.
 * Rejecting those would write 56 content fingerprints nobody will ever generate into
 * the permanent blacklist; deleting them is the whole intent. Anything that IS a
 * sample and is wrong must go through `rejectSamples`, so it cannot come back.
 */
export async function discardStagedSamples(keys: string[]): Promise<{ results: SampleActionResult[]; error?: string }> {
  if (getRunMode() === 'iframe') return { results: [], error: SAMPLE_LIB_IFRAME_REASON };
  try {
    const resp = await proxyFetch('/api/pack-generator/sample-library/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    return await resp.json();
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : 'unknown' };
  }
}

// --- Shared golden knowledge (private GitHub repo, standalone-only) ---

export interface AvailableGolden {
  key: string;
  sourcetype: string;
  dest_format: string;
  score: number;
  localScore: number | null;
  author: string;
  updated_at: string;
  status: 'new' | 'upgrade';
  path: string;
  report?: any | null;
  // Experimental 3-stage sub-part this golden encodes (null for a normal golden).
  part?: 'extraction' | 'mapping' | null;
}

// Test a Lake ingest URL + token from the settings form (unsaved values).
// Send a real minimal TEST event (datetime, username, version, test) to the
// scoring endpoint so the user can verify end-to-end delivery in their dataset/S3.
export async function sendLakeTestEvent(url: string, token: string): Promise<{ active: boolean; message: string }> {
  if (getRunMode() !== 'standalone') return { active: false, message: 'Test event is available in standalone mode.' };
  try {
    const resp = await proxyFetch('/api/pack-generator/lake-test-event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token }),
    });
    return await resp.json();
  } catch (err) {
    return { active: false, message: err instanceof Error ? err.message : 'Test event failed.' };
  }
}

export async function testLakeConnection(url: string, token: string): Promise<{ active: boolean; message: string }> {
  if (getRunMode() === 'iframe') {
    return { active: false, message: 'Score logging not available in iframe mode' };
  }
  if (!url) return { active: false, message: 'URL is required.' };
  try {
    if (token.trim()) await saveLakeToken(token);
    const resp = await proxyFetch('/api/pack-generator/lake-health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    return await resp.json();
  } catch (err) {
    return { active: false, message: err instanceof Error ? err.message : 'Lake test failed.' };
  }
}

// Test the golden repo from the settings form (unsaved values). Reading is public,
// so a token is only relevant to publishing — it is saved when given, never required.
export async function testGoldenAccess(repo: string, branch: string, token: string): Promise<{ ok: boolean; message: string }> {
  if (!repo) return { ok: false, message: 'Repo is required.' };
  if (token) {
    try {
      await saveGoldenReadToken(token);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'GitHub credential save failed.' };
    }
  }
  if (getRunMode() === 'iframe') {
    return (await bundled()).testGitHubAccess(repo, branch || 'shared-goldens', '');
  }
  try {
    const resp = await proxyFetch('/api/pack-generator/golden-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, branch: branch || 'shared-goldens' }),
    });
    return await resp.json();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'GitHub test failed.' };
  }
}

// List shared goldens that are new or a score-upgrade vs the local store.
export async function fetchAvailableGoldens(): Promise<{ available: AvailableGolden[]; total?: number; error?: string }> {
  const q = loadQualitySettings();
  if (getRunMode() === 'iframe') {
    // The pool is public, so this needs no credential and works in a fresh install
    // with nothing configured. If GitHub is unreachable the bundled goldens still serve.
    return (await bundled()).fetchGoldensFromGitHub(q.goldenRepo, q.goldenBranch || 'shared-goldens', '');
  }
  if (!q.goldenRepo) return { available: [] };
  try {
    const resp = await proxyFetch('/api/pack-generator/golden-available', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: q.goldenRepo, branch: q.goldenBranch }),
    });
    return await resp.json();
  } catch (err) {
    return { available: [], error: err instanceof Error ? err.message : 'unknown' };
  }
}

// Import selected shared goldens into the local store (keeps higher score).
export async function importGoldens(keys: string[]): Promise<{ imported: { key: string; score: number }[]; failed: { key: string; reason: string }[] }> {
  const q = loadQualitySettings();
  if (getRunMode() === 'iframe') {
    return (await bundled()).importGoldensFromGitHub(q.goldenRepo, q.goldenBranch || 'shared-goldens', '', keys);
  }
  const resp = await proxyFetch('/api/pack-generator/golden-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: q.goldenRepo, branch: q.goldenBranch, keys }),
  });
  return await resp.json();
}

export interface PushableGolden {
  key: string;
  sourcetype: string;
  dest_format: string;
  score: number;
  remoteScore: number | null;   // null = not in shared pool yet
  status: 'new' | 'upgrade';
  part?: 'extraction' | 'mapping' | null;
}

// The reverse of fetchAvailableGoldens: which LOCAL goldens are new to the
// shared pool or beat the shared score.
export async function fetchPushableGoldens(): Promise<{ pushable: PushableGolden[]; localTotal?: number; remoteTotal?: number; error?: string }> {
  const q = loadQualitySettings();
  if (!q.shareGoldens || !q.goldenRepo) return { pushable: [] };
  // Publishing is standalone-only: it is the one golden operation that needs a
  // credential, and the iframe has nowhere to keep one that the browser cannot read.
  if (getRunMode() === 'iframe') return { pushable: [] };
  try {
    const resp = await proxyFetch('/api/pack-generator/golden-pushable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: q.goldenRepo,
        branch: q.goldenBranch,
        thresholds: {
          qualityThreshold: q.qualityThreshold,
          expExtractionThreshold: q.expExtractionThreshold,
          expMappingThreshold: q.expMappingThreshold,
          expOptimizationThreshold: q.expOptimizationThreshold,
        },
      }),
    });
    return await resp.json();
  } catch (err) {
    return { pushable: [], error: err instanceof Error ? err.message : 'unknown' };
  }
}

// Push local goldens UP to the shared pool (new + score-beating upgrades). Omit
// `keys` to push everything pushable. Overwrites an existing shared golden only
// when the local score strictly beats it (last-highest-wins for that key).
export async function pushGoldens(keys?: string[]): Promise<{ pushed: { key: string; score: number }[]; upgraded: { key: string; score: number }[]; skipped: { key: string; reason: string }[]; error?: string }> {
  const q = loadQualitySettings();
  const empty = { pushed: [], upgraded: [], skipped: [] };
  if (!q.shareGoldens || !q.goldenRepo) return empty;
  if (getRunMode() === 'iframe') return empty;   // writes are standalone-only
  const resp = await proxyFetch('/api/pack-generator/golden-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: q.goldenRepo, branch: q.goldenBranch, keys,
      thresholds: {
        qualityThreshold: q.qualityThreshold,
        expExtractionThreshold: q.expExtractionThreshold,
        expMappingThreshold: q.expMappingThreshold,
        expOptimizationThreshold: q.expOptimizationThreshold,
      },
    }),
  });
  return await resp.json();
}

// Publish one locally-stored golden to the shared pool (create-only, score>80).
// Fire-and-forget; no-op when sharing is off or token not configured.
export async function publishGolden(payload: {
  key: string; sourcetype: string; dest_format: string; score: number;
  functions: any[]; recipe: any | null; report: any | null; author?: string; build?: number;
  minScore?: number; wireFormat?: SourceWireFormat | null;
}): Promise<void> {
  const q = loadQualitySettings();
  if (!q.shareGoldens || !q.goldenRepo) return;
  // Writes to the shared pool are standalone-only (Hard Rule 16). The iframe
  // has no credential; a Backend Function has neither a credential nor the Vite
  // handler this POSTs to — and it reaches here for real, through
  // publishGoldenPart() in the staged builder, so a bare iframe check left the
  // background path issuing a relative request nothing serves.
  if (getRunMode() !== 'standalone') return;
  try {
    await proxyFetch('/api/pack-generator/golden-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: q.goldenRepo, branch: q.goldenBranch, build: BUILD_NUMBER, ...payload }),
    });
  } catch { /* best-effort */ }
}

// Publish one experimental 3-stage golden SUB-PART to the shared pool. Mirrors
// publishGolden but derives the composite key from the stage and passes the
// per-stage threshold as minScore (so the shared >80 bar doesn't reject a
// sub-part that's legitimately golden at its own stage threshold).
// The shared store key is `${sourcetype}::${partKey}` where partKey is
// `__extraction__` / `<fmt>::__mapping__`.
export async function publishGoldenPart(
  stage: StagePart, sourcetype: string, destFormat: string,
  functions: any[], score: number, minScore: number, report?: GoldenReport | null,
  fingerprint?: SampleFingerprint | null, wireFormat?: SourceWireFormat | null,
): Promise<void> {
  if (stage === 'extraction') {
    const contract = validateExtractionStage(functions);
    if (!contract.valid) {
      throw new Error(`Extraction golden rejected: ${contract.reasons.join('; ')}`);
    }
  }
  if (stage === 'mapping') {
    const contract = validateMappingStage(functions);
    if (!contract.valid) {
      throw new Error(`Mapping golden rejected: ${contract.reasons.join('; ')}`);
    }
  }
  if ((stage === 'extraction' || stage === 'mapping') && !fingerprint) {
    throw new Error(`${stage === 'extraction' ? 'Extraction' : 'Mapping'} golden rejected: sample fingerprint is required.`);
  }
  const partKey = goldenPartKey(stage, destFormat);
  // Same variant segment the local save used, so the pool and the local store
  // agree on the key (`fortinet_fortigate@cef::__extraction__`).
  const keySourcetype = goldenVariantSourcetype(sourcetype, wireFormat);
  await publishGolden({
    key: `${keySourcetype}::${partKey}`,
    sourcetype: keySourcetype,
    dest_format: partKey,   // everything after the first `::` in the store key
    score, functions, recipe: fingerprint ? { fingerprint } : null, report: report || null, minScore,
    wireFormat: wireFormat || null,
  });
}
