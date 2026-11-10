// Performance mode (opt-in). The generated pipeline stays the source of truth. Always: a native
// clean-up from standard Functions only (`cleanPipeline`): consecutive evals merged and, only with
// "Use vendor field library" on, `||` fallbacks removed: around a field the library confirms for the
// source type (open or closed entry), and, with a CLOSED entry, to fields that source never carries. Only with Code functions allowed: the cleaned
// eval/serialize runs are then compiled into Code functions (`compilePipelineForPerformance`).
// Both versions run on the pack's own sample in Data Preview as a cross-check, and the result is
// offered ONLY when the outputs are identical.
// Nothing here deploys by itself — `applyPerformanceMode` is called from an explicit click.
import { commitDeploy, getPackPipeline, patchPipeline, previewInlinePipeline, type CriblPipelineProfile } from './api';
import type { PipelineFunction } from './pack-builder';
import { compilePipelineForPerformance, comparePipelineOutputs, type PerfCompileResult } from './perf-compile';
import { cleanPipeline, NATIVE_MARKER, type NativeCleanStats } from './perf-native';
import { addSeen, BUNDLED_LIBRARY, findEntry, libraryState, loadLibrary, loadSeenFields, type LibraryState } from './vendor-field-library';

export interface PerfModeTarget {
  workerGroup: string; packId: string; pipelineId: string; sampleName: string;
  /** Also compile into Code functions. Off: standard Functions only. */
  allowCode?: boolean;
  /** Remove fallbacks using the vendor field library (closed entries only). Off: evals are only merged. */
  useLibrary?: boolean;
  sourcetype?: string;
  /** Field names this build extracted (counted as seen, so a closed entry reopens on them at once). */
  seenNow?: string[];
}

export type PerfModeCheck =
  | { status: 'not-applicable'; reason: string; library?: LibraryState | null; neverSeen?: string[] }
  | { status: 'differs'; events: number; differing: number; fields: string[] }
  | {
      status: 'ready'; events: number; native: NativeCleanStats; compiled: PerfCompileResult | null;
      /** Library entry for the source type (null: none, or the library is off). */
      library: LibraryState | null;
      /** The conf to deploy. */
      functions: PipelineFunction[];
      /** The deployed conf, kept so Undo can put it back. */
      originalConf: any;
      before: { functions: number; ms: number | null }; after: { functions: number; ms: number | null };
    };

/** Sum of per-function process time (ms) from a preview CPU profile. */
function functionMs(stats: CriblPipelineProfile | null): number | null {
  const fns = stats?.functions;
  return fns?.length ? fns.reduce((s, f) => s + (Number(f.duration) || 0), 0) : null;
}

export async function checkPerformanceMode(t: PerfModeTarget): Promise<PerfModeCheck> {
  const pipeline = await getPackPipeline(t.workerGroup, t.packId, t.pipelineId);
  const functions: PipelineFunction[] = pipeline.conf?.functions || [];
  if (functions.some(f => (f.id === 'code' && /^Performance mode:/.test(String(f.description || '')))
    || (f.id === 'comment' && String((f.conf as { comment?: string })?.comment || '').startsWith(NATIVE_MARKER)))) {
    return { status: 'not-applicable', reason: 'This pipeline already runs in performance mode.' };
  }
  const base = { workerGroup: t.workerGroup, packId: t.packId, sampleName: t.sampleName };
  // The bundled library with any reviewed entries imported from the shared pool on top.
  const lib = t.useLibrary ? await loadLibrary() : BUNDLED_LIBRARY;
  const library = t.useLibrary
    ? libraryState(lib, addSeen(await loadSeenFields(), findEntry(lib, t.sourcetype)?.key ?? '', t.seenNow || []), t.sourcetype)
    : null;
  const native = cleanPipeline(functions, { complete: library?.complete ?? null, confirmed: library?.confirmed ?? null, known: library?.known ?? null });
  const compiled = t.allowCode ? compilePipelineForPerformance(native.functions) : null;
  const changed = native.stats.prunedOperands || native.stats.droppedAdds || native.stats.mergedEvals || compiled?.blocks;
  if (!changed) return { status: 'not-applicable', reason: 'No evals to merge and no fallback the vendor field library proves unused: the pipeline stays as generated.', library, neverSeen: native.stats.neverSeen };
  const removed = native.stats.prunedOperands
    ? ` ${native.stats.prunedOperands} fallbacks removed using the vendor field library entry ${library!.key}`
      + ` (${library!.status === 'closed' ? `closed, reviewed ${library!.entry.reviewedAt || 'n/a'}${library!.entry.reviewedBy ? ` by ${library!.entry.reviewedBy}` : ''}` : `${library!.status}: around confirmed fields only`}, library v${lib.version}): ${native.stats.prunedFields.join(', ').slice(0, 1500)}.`
    : ' No fallbacks removed.';
  const marker: PipelineFunction = {
    id: 'comment',
    conf: { comment: `${NATIVE_MARKER} ${native.stats.mergedEvals} evals merged.${removed} Undo restores the generated pipeline.` },
  } as PipelineFunction;
  const candidate = [marker, ...(compiled?.blocks ? compiled.functions : native.functions)];
  const ref = await previewInlinePipeline({ ...base, functions });
  const fast = await previewInlinePipeline({ ...base, functions: candidate });
  if (!ref.items.length) return { status: 'not-applicable', reason: 'The pack sample produced no output events to compare.' };
  const cmp = comparePipelineOutputs(ref.items, fast.items);
  if (cmp.differing) return { status: 'differs', ...cmp };
  return {
    status: 'ready', events: cmp.events, native: native.stats, compiled: compiled?.blocks ? compiled : null, library,
    functions: candidate, originalConf: pipeline.conf,
    before: { functions: functions.length, ms: functionMs(ref.stats) },
    after: { functions: candidate.length, ms: functionMs(fast.stats) },
  };
}

/** Write a pipeline conf and deploy the worker group. */
async function writeAndDeploy(t: PerfModeTarget, conf: any, message: string): Promise<void> {
  await patchPipeline(t.packId, t.pipelineId, t.workerGroup, conf);
  await commitDeploy(t.workerGroup, message);
}

export async function applyPerformanceMode(t: PerfModeTarget, check: Extract<PerfModeCheck, { status: 'ready' }>): Promise<void> {
  const how = check.compiled ? `, ${check.compiled.compiledCount} Functions compiled` : '';
  await writeAndDeploy(t, { ...check.originalConf, functions: check.functions },
    `Performance mode for ${t.packId}/${t.pipelineId} (${check.native.prunedOperands} fallbacks removed, ${check.native.mergedEvals} evals merged${how})`);
}

export async function undoPerformanceMode(t: PerfModeTarget, check: Extract<PerfModeCheck, { status: 'ready' }>): Promise<void> {
  await writeAndDeploy(t, check.originalConf, `Undo performance mode for ${t.packId}/${t.pipelineId}`);
}
