/**
 * The foreground → background handoff, as a pure function.
 *
 * A background run is decided entirely here, in the browser, from state only
 * the browser has: the parsed CSV rows, the samples pre-flight resolved, and
 * the operator's per-pack conflict answers. Everything after this point is a
 * Backend Function replaying a manifest, so whatever this function does not
 * record is simply not available later — there is no second chance to ask.
 *
 * It lives outside `App.tsx` because the handoff IS the contract. Inside a
 * React callback the only way to check "does Overwrite still mean a build row"
 * is to read the source; out here it is a value you can assert on.
 *
 * Three rules shape the output:
 *
 * - PARITY. Canonicalization, concrete CIM/ASIM/OCSF keys, pack/pipeline ids,
 *   the output sourcetype and the route filter are resolved exactly as
 *   `handleBatchDeploy` resolves them. A row must not build differently just
 *   because it ran server-side.
 * - BOUNDED METADATA. The checkpoint is polled by the UI and rewritten on every
 *   stage, so sample text goes into the run-scoped row artifact instead.
 * - SAMPLE CREATION IS THE ROW'S FIRST STAGE. A build row no store could
 *   supply a sample for is queued with `needsSample` and the grounding the
 *   foreground would have generated from; the runner creates and verifies the
 *   sample in the background (Cribl AI, one 280-second stage), so Start never
 *   asks the operator to keep a tab open while samples generate.
 */
import type {
  BackgroundAiSnapshot,
  BackgroundArtifactWrite,
  BackgroundBatchCheckpoint,
  BackgroundBatchRow,
  BackgroundConflictAction,
} from './background-batch';
export type { BackgroundArtifactWrite } from './background-batch';
import { rowArtifactKey } from './background-batch-store';
import { batchSampleKey, batchSampleSourcetype, BATCH_ROW_SAMPLE_SOURCE_MODE } from './batch-row-sample';
import { sanitizeRouteFilter } from './batch-runtime';
import { canonicalizeSourcetype } from './source-recognition';
import { getRequiredXsiamSampleFormat } from './xsiam-cef-samples';
import {
  buildSampleGroundingContext,
  cimModelForFormatKey,
  concretizeAsimFormat,
  concretizeCimFormat,
  concretizeOcsfFormat,
  getMultiFormatSpec,
  recognizeSourcetype,
  toKebab,
  type SampleGrounding,
} from './pack-builder';
import { resolveDestFormat } from './pack-orchestrator';

/** The CSV row shape the batch wizard holds (structurally `BatchRow`). */
export interface BackgroundManifestRow {
  sourcetype: string;
  outputSourcetype?: string;
  pack_name: string;
  pipeline_name: string;
  dest_format: string;
  filter?: string;
  sentinelTable?: string;
  cimModel?: string;
  /** The row's own CSV sample (src/batch-row-sample.ts), when it has one. */
  sample?: string;
  /** The shared sanitizer was reviewed and applied to this exact sample. */
  sampleSanitised?: boolean;
}

export interface BackgroundManifestInput {
  runId: string;
  workerGroup: string;
  rows: readonly BackgroundManifestRow[];
  /**
   * Pre-flight samples, keyed by canonical sourcetype and/or the raw CSV
   * spelling — the same two lookups the foreground batch does, in the same
   * order, because a Windows channel and its canonical parser legitimately
   * disagree on the key. A row with its own `sample` cell is keyed by
   * `batchSampleKey` instead, and falls back to the cell text itself.
   */
  samples: ReadonlyMap<string, string>;
  /**
   * Which tier supplied each sample, keyed exactly as `samples` is. Provenance
   * for the score event (`sample_tier`), never data.
   */
  tiers?: ReadonlyMap<string, string>;
  /** How long resolving each sample took, keyed exactly as `samples` is. */
  prepareMs?: ReadonlyMap<string, number>;
  /** Conflict answers, keyed by kebab pack id, exactly as the UI records them. */
  actions: ReadonlyMap<string, BackgroundConflictAction>;
  /** Pack ids the UI marked "do not generate into", keyed the same way. */
  skippedPacks: ReadonlySet<string>;
  ai: BackgroundAiSnapshot;
  now: number;
}

export interface BackgroundManifest {
  checkpoint: BackgroundBatchCheckpoint;
  artifacts: BackgroundArtifactWrite[];
}

/** What a row that still needs a sample says until its sample stage runs. */
export const SAMPLE_PENDING_MESSAGE = 'No sample in the library — one will be created and verified in the background first.';

/**
 * The grounding the foreground generated from: recognised vendor/product, and
 * the wire format the row's destinations require (XSIAM CEF) or the source's
 * first multi-format variant. Same inputs, same order as the old Start loop.
 */
function sampleGroundingFor(canonical: string, destFormats: string[]): SampleGrounding | undefined {
  const rec = recognizeSourcetype(canonical);
  const mfSpec = getMultiFormatSpec(canonical);
  const requiredFormat = getRequiredXsiamSampleFormat(canonical, destFormats);
  return buildSampleGroundingContext(
    { vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily },
    canonical,
    requiredFormat || (mfSpec ? (mfSpec.formats[0]?.id || undefined) : undefined),
  );
}

/**
 * A stable, opaque, path-safe row id.
 *
 * Stable so two runs of the same CSV produce the same manifest and a re-read
 * artifact key still matches. Opaque because the id is part of an App KV path
 * and shows up in logs — a pack or source name there is customer information
 * for no benefit. The CSV index is what keeps two genuinely identical rows
 * distinct; the hash is what keeps the id stable when unrelated rows move.
 */
export function backgroundRowId(index: number, packId: string, pipelineId: string, destFormat: string): string {
  const seed = `${packId}\u0000${pipelineId}\u0000${destFormat}`;
  // FNV-1a, 32-bit. Not a security boundary — just a short, deterministic,
  // dependency-free digest.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `r${String(index).padStart(4, '0')}-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * The operator's answer for this row's pack, as one of the four actions the
 * background model carries.
 *
 * Mirrors `processRow`: the conflict UI marks Skip/Repair/Scorecard by ADDING
 * the pack to `skipPacks` and recording which of the three it is, while
 * Overwrite removes it. A pack with no conflict at all never appears in either
 * collection and is a plain new build — 'overwrite' is the model's name for
 * "this row generates config".
 */
function actionFor(
  packId: string,
  actions: ReadonlyMap<string, BackgroundConflictAction>,
  skippedPacks: ReadonlySet<string>,
): BackgroundConflictAction {
  if (!skippedPacks.has(packId)) return 'overwrite';
  const chosen = actions.get(packId);
  return chosen === 'repair' || chosen === 'scorecard' ? chosen : 'skip';
}

/** Repair and Scorecard inspect a LIVE pipeline; everything else writes config. */
const groupFor = (action: BackgroundConflictAction): BackgroundBatchRow['resultGroup'] =>
  (action === 'repair' || action === 'scorecard' ? 'quality' : 'build');

/**
 * The pre-flight cache keys to try, in the order regular Batch tries them.
 *
 * `prepareSource` looks up `sampleSourcetype || sourcetype` first and the
 * canonical name second, where `sampleSourcetype` is the RAW row sourcetype for
 * a Windows channel and the canonical name for everything else. The Windows
 * exception is load-bearing: several channels share one canonical parser, so
 * the canonical key holds whichever channel pre-flight resolved last. Reading
 * it for `WinEventLog:Security` would build that pipeline from the Application
 * channel's events — a pipeline that scores plausibly against the wrong data.
 */
function sampleKeyOrder(canonical: string, raw: string): [string, string] {
  const sampleName = batchSampleSourcetype(raw, canonical);
  return sampleName === canonical ? [canonical, raw] : [sampleName, canonical];
}

function resolveSample(
  samples: ReadonlyMap<string, string>,
  canonical: string,
  raw: string,
  rowSample?: string,
): string {
  // The row's own sample, as pre-flight left it (possibly extended), else the
  // cell as typed. Never a store sample in its place: the user named these events.
  if (rowSample) {
    const prepared = samples.get(batchSampleKey(canonical, rowSample)) ?? '';
    return prepared.trim() ? prepared : rowSample;
  }
  const [first, second] = sampleKeyOrder(canonical, raw);
  const found = samples.get(first) ?? samples.get(second) ?? '';
  return found.trim() ? found : '';
}

/**
 * The sample a CSV row would build from, for callers that only have the raw
 * row — the confirmation screen, which must name exactly the rows this builder
 * will park. Two lookups that agree by accident is how a screen ends up
 * promising a build the manifest then skips.
 */
export function resolvePreflightSample(
  samples: ReadonlyMap<string, string>,
  rawSourcetype: string,
  rowSample?: string,
): string {
  return resolveSample(samples, canonicalizeSourcetype(rawSourcetype), rawSourcetype, rowSample);
}

/**
 * The sources a background run would skip for want of a sample, keyed exactly
 * as `buildBackgroundManifest` will look them up (the first key of
 * `sampleKeyOrder`) → the canonical sourcetype to ground generation on.
 *
 * Pre-flight generates at most PREFLIGHT_MODEL_CAP sources and leaves the rest
 * "to build time". In a background run build time is the row's own sample
 * stage, so these are the samples the runner will create, one per key.
 * Rows with their own sample cell, quality rows and skipped packs never need one.
 */
export function missingBackgroundSamples(
  rows: readonly BackgroundManifestRow[],
  samples: ReadonlyMap<string, string>,
  actions: ReadonlyMap<string, BackgroundConflictAction>,
  skippedPacks: ReadonlySet<string>,
): Map<string, string> {
  const missing = new Map<string, string>();
  for (const row of rows) {
    if (row.sample) continue;
    const action = actionFor(toKebab(row.pack_name), actions, skippedPacks);
    if (action === 'skip' || groupFor(action) === 'quality') continue;
    const canonical = canonicalizeSourcetype(row.sourcetype);
    const raw = row.outputSourcetype || row.sourcetype;
    if (resolveSample(samples, canonical, raw)) continue;
    const [key] = sampleKeyOrder(canonical, raw);
    if (!missing.has(key)) missing.set(key, canonical);
  }
  return missing;
}

export interface BackgroundSampleSummary {
  /** Build rows that need a sample (own-sample, quality and skipped rows excluded). */
  needed: number;
  /** Of those, rows that already resolve one. */
  ready: number;
  /** Distinct samples the background run creates — exactly `missingBackgroundSamples(...).size`. */
  toGenerate: number;
  /** Missing sources per destination format, sorted, one entry per sample key. */
  groups: { format: string; sourcetypes: string[] }[];
}

/**
 * What the Ready-to-start screen shows about samples, counted per sample key,
 * not per row, so "111 to create" on screen is the 111 the background run's
 * sample stages will actually create.
 */
export function summarizeBackgroundSamples(
  rows: readonly BackgroundManifestRow[],
  samples: ReadonlyMap<string, string>,
  actions: ReadonlyMap<string, BackgroundConflictAction>,
  skippedPacks: ReadonlySet<string>,
): BackgroundSampleSummary {
  let needed = 0;
  let ready = 0;
  const seen = new Set<string>();
  const byFormat = new Map<string, string[]>();
  for (const row of rows) {
    const action = actionFor(toKebab(row.pack_name), actions, skippedPacks);
    if (action === 'skip' || groupFor(action) === 'quality') continue;
    needed++;
    if (row.sample) { ready++; continue; }
    const canonical = canonicalizeSourcetype(row.sourcetype);
    const raw = row.outputSourcetype || row.sourcetype;
    if (resolveSample(samples, canonical, raw)) { ready++; continue; }
    const [key] = sampleKeyOrder(canonical, raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const format = (row.dest_format || '').trim() || '—';
    const list = byFormat.get(format) ?? [];
    list.push(row.sourcetype);
    byFormat.set(format, list);
  }
  const groups = [...byFormat.entries()]
    .map(([format, list]) => ({ format, sourcetypes: [...new Set(list)].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => b.sourcetypes.length - a.sourcetypes.length || a.format.localeCompare(b.format));
  return { needed, ready, toGenerate: seen.size, groups };
}

/** Provenance for the sample above, read with the same key order. */
function resolveBy<T>(
  map: ReadonlyMap<string, T> | undefined,
  canonical: string,
  raw: string,
  rowSample?: string,
): T | undefined {
  if (!map) return undefined;
  if (rowSample) return map.get(batchSampleKey(canonical, rowSample));
  const [first, second] = sampleKeyOrder(canonical, raw);
  return map.get(first) ?? map.get(second);
}

/**
 * The concrete destination this row builds into — the same resolution, in the
 * same order, as `handleBatchDeploy`: family/table/model first, then the
 * sample-aware concretization of a bare CIM/ASIM/OCSF family.
 */
function resolveRowFormat(row: BackgroundManifestRow, canonical: string, sample: string): string {
  let destFmt = resolveDestFormat(row.dest_format, {
    sentinelTable: row.sentinelTable,
    manualFormat: '',
    cimModel: row.cimModel,
  });
  if (!sample) return destFmt;
  if (row.dest_format === 'cim') destFmt = concretizeCimFormat('cim', canonical, sample, row.cimModel);
  else if (row.dest_format === 'asim') destFmt = concretizeAsimFormat('asim', canonical, sample);
  else if (row.dest_format === 'ocsf' || row.dest_format === 'nextgen') {
    destFmt = concretizeOcsfFormat(row.dest_format, canonical, sample);
  }
  return destFmt;
}

export function buildBackgroundManifest(input: BackgroundManifestInput): BackgroundManifest {
  const { runId, workerGroup, rows, samples, tiers, prepareMs, actions, skippedPacks, ai, now } = input;

  // Pack groups in first-appearance order, rows within a pack in CSV order —
  // the visiting order sequential Batch produces. It matters beyond tidiness:
  // the runner decides new-vs-add-pipeline from which sibling already built, so
  // a pack's rows arriving together is what makes that decision stable.
  const packFirstSeen = new Map<string, number>();
  rows.forEach((row, index) => {
    const packId = toKebab(row.pack_name);
    if (!packFirstSeen.has(packId)) packFirstSeen.set(packId, index);
  });

  interface Draft { row: BackgroundBatchRow; artifact?: BackgroundArtifactWrite }

  // Every destination a source is built into, so a sample created for it is in
  // the wire format the strictest of them requires (XSIAM CEF).
  const sameSourceFormats = new Map<string, string[]>();
  for (const row of rows) {
    const canonical = canonicalizeSourcetype(row.sourcetype);
    const list = sameSourceFormats.get(canonical) ?? [];
    list.push(row.dest_format || '');
    sameSourceFormats.set(canonical, list);
  }

  const drafts: Array<Draft & { packOrder: number; index: number }> = rows.map((row, index) => {
    const canonical = canonicalizeSourcetype(row.sourcetype);
    // Pre-flight canonicalizes `sourcetype`; the CSV spelling (the Windows channel
    // the sample was resolved under) survives as `outputSourcetype`.
    const raw = row.outputSourcetype || row.sourcetype;
    const packId = toKebab(row.pack_name);
    const action = actionFor(packId, actions, skippedPacks);
    const resultGroup = groupFor(action);
    const rowId = backgroundRowId(index, packId, row.pipeline_name, row.dest_format);
    const artifactKey = rowArtifactKey(runId, rowId);

    // A quality row scores or repairs a pipeline that is already deployed, so
    // it reads the pack's OWN uploaded sample and keeps the row's raw
    // destination family — exactly what the foreground repair/scorecard path
    // passes. Concretizing here would name a golden key the live pipeline was
    // never built against.
    const isQuality = resultGroup === 'quality';
    const ownSample = isQuality ? undefined : (row.sample || undefined);
    const sample = isQuality ? '' : resolveSample(samples, canonical, raw, ownSample);
    const destFormat = isQuality ? row.dest_format : resolveRowFormat(row, canonical, sample);

    // Skip is terminal before anything durable exists, and stays in the report —
    // a row that vanished from the results would read as work that succeeded.
    // A build row with no sample is NOT terminal: its first stage creates one.
    const buildable = !isQuality && action !== 'skip';
    const needsSample = buildable && !sample;
    const phase: BackgroundBatchRow['phase'] = action === 'skip' ? 'skipped' : 'queued';
    const message = action === 'skip'
      ? 'Skipped — existing pack left untouched.'
      : (needsSample ? SAMPLE_PENDING_MESSAGE : undefined);

    const manifestRow: BackgroundBatchRow = {
      rowId,
      order: 0, // assigned below, once build and quality rows are partitioned
      resultGroup,
      action,
      phase,
      attempt: 0,
      artifactKey,
      sourcetype: canonical,
      // The Splunk-native spelling the pipeline emits. Falls back to the RAW
      // CSV sourcetype, never the canonical one — the colon is the point.
      outputSourcetype: row.outputSourcetype || row.sourcetype,
      packName: row.pack_name,
      pipelineId: row.pipeline_name,
      destFormat,
      cimModel: row.dest_format === 'cim'
        ? (row.cimModel || cimModelForFormatKey(destFormat) || undefined)
        : row.cimModel,
      routeFilter: sanitizeRouteFilter(row.filter || `sourcetype=='${row.sourcetype}'`),
      ...(needsSample ? { needsSample: true } : {}),
      ...(message ? { message } : {}),
    };

    return {
      row: manifestRow,
      // A terminal row does no work, so it gets no document. Quality rows get
      // one because Task 7 resumes through the same artifact.
      artifact: phase === 'skipped'
        ? undefined
        : {
          key: artifactKey,
          value: needsSample
            ? {
              sampleEvents: '',
              // Generated under the FIRST lookup key — the raw channel for a
              // Windows source — so the events are the ones this row needs.
              sampleRequest: {
                sourcetype: sampleKeyOrder(canonical, raw)[0],
                grounding: sampleGroundingFor(canonical, sameSourceFormats.get(canonical) ?? [row.dest_format || '']),
              },
            }
            : {
            sampleEvents: sample,
            // Omitted rather than defaulted: the score event's `sample_tier`
            // saying nothing is honest, saying the wrong tier is not. A row's
            // own sample is `uploaded` whatever pre-flight recorded.
            ...(ownSample
              ? {
                  sampleTier: 'uploaded',
                  sampleSourceMode: BATCH_ROW_SAMPLE_SOURCE_MODE,
                  ...(row.sampleSanitised ? { sampleSanitised: true } : {}),
                }
              : resolveBy(tiers, canonical, raw)
                ? { sampleTier: resolveBy(tiers, canonical, raw) }
                : {}),
            ...(resolveBy(prepareMs, canonical, raw, ownSample) != null
              ? { prepareMs: resolveBy(prepareMs, canonical, raw, ownSample) }
              : {}),
            },
        },
      packOrder: packFirstSeen.get(packId) ?? index,
      index,
    };
  });

  const sortRows = (group: BackgroundBatchRow['resultGroup']) => drafts
    .filter(d => d.row.resultGroup === group)
    .sort((a, b) => (a.packOrder - b.packOrder) || (a.index - b.index));

  // Build (and skip) rows first, quality rows after all of them: Repair and
  // Scorecard read LIVE pipelines, so they can only be meaningful once the
  // generated config has been committed and deployed.
  const ordered = [...sortRows('build'), ...sortRows('quality')];
  ordered.forEach((draft, position) => { draft.row.order = position; });

  return {
    checkpoint: {
      runId,
      workerGroup,
      // 'starting' until the schedule exists — the run is not yet executable,
      // and a tick that found 'running' with no schedule would look healthy.
      status: 'starting',
      ai,
      deployStatus: 'not-needed',
      rows: ordered.map(d => d.row),
      createdAt: now,
      updatedAt: now,
    },
    artifacts: ordered.map(d => d.artifact).filter((a): a is BackgroundArtifactWrite => !!a),
  };
}
