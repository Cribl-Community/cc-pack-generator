import { useState, useEffect, useLayoutEffect, useRef, Fragment, type ReactNode, type CSSProperties } from 'react';
import goatImg from './assets/goat-header.webp';
import goatGrazeImg from './assets/cribl-goat-graze.webp';
import type { WizardState, SourceMode, DestFormat } from './types';
import { buildPack, toKebab, getPipelineId, getSampleName, getParserFieldNames, hasGoldenFormatPath, goldenPathMatchesSample, sampleFingerprint, fingerprintsMatch, scoreValueCoverage, scoreSchemaMappingFromExtraction, getBlockingContractErrors, canonicalizeSourcetype, getParserForSourcetype, getDatatypeParserFunctions, matchDatatypeParserBySample, matchGoldenSourceBySample, matchJsonSignature, recommendDestFormatsForSample, asimSchemaOptions, ocsfSchemaOptions, concretizeAsimFormat, concretizeCimFormat, concretizeOcsfFormat, isCimFormat, isOcsfFormat, isOcsfScoredFormat, isCefFormat, cimModelForFormatKey, inferDataClass, describeSourcetype, recognizeSourcetype, recognizeCefSource, getSupportedSourcetypeCatalog, searchSupportedSourcetypes, getFamilyTokenVariants, getMultiFormatSpec, buildSampleGroundingContext, explainValueCoverageGaps, shapeMappedEventForDisplay, type MultiFormatSpec, type SampleGrounding, type ContractLintFinding, type CoverageGapDetail } from './pack-builder';
import { generateSamples, hasBuiltInSamples, SOURCETYPES } from './ai-samples';
import { listGroups, listPacks, listPackPipelines, getPackPipeline, getPackSample, uploadPackSample, liveCapture, downloadSample, listGroupAndPackSamples, downloadPackSample, isSanitisedLibrarySampleName, aiValidate, aiSamples, aiAdvise, aiMapping, aiParse, detectSourcetypeApi, deploy, aiAvailable, fetchPublicSamples, fetchHybridSamples, validatePipeline, previewPipeline, previewPipelineProfile, repairPipeline, getGoldenPipeline, getGoldenPart, fetchReferenceAvailability, fetchReferenceSample, extendResolvedSample, fetchReferenceLookups, healLookup, auditDatatypes, ensureDatatypeOverlay, logPipelineScore, checkLakeExportHealth, checkAiHealth, repairQuality, fetchAvailableGoldens, importGoldens, sendLakeTestEvent, testGoldenAccess, testSanitisedSampleAccess, listWorkers, backgroundGroupBlockReason, listLakeDatasets, listSearchDatasets, listSearchDatatypes, deploySearchDatatype, attachSearchDatatypes, deploySearchDashboard, listOutputs, ensureLakeOutput, setMasterRoutes, createDemoDatagen, scanDemo, cleanupDemo, patchPipeline, commitDeploy, getCriblCreds, testCriblCreds, saveCriblCreds, getRunMode, fetchPushableGoldens, pushGoldens, fetchSampleLibrarySummary, saveBatchCheckpoint, loadBatchCheckpoint, clearBatchCheckpoint, analyzeBuildTrace, type PushableGolden, type AvailableGolden, type WorkerHealth, type LakeDataset, type SearchDataset, type SearchDatatype, type DemoScanResult, type DemoOutput, type BatchCheckpoint } from './api';
import { buildPostProcessFunctions, postProcessLookupsFor, postProcessSampleEvents, getPostProcessPair, postProcessSchemaOptions, POSTPROCESS_SOURCE_FORMATS, POSTPROCESS_DEST_FORMATS, isNoPairPostProcessDestination, postProcessFamilyOf } from './postprocess-builder';
import { isRawPassthroughDestination } from './postprocess-optimization';
import { parseOcsfGuidance } from './ocsf-schema';
import { classifyXsiamSampleFormat, resolveXsiamForBuild } from './xsiam-builder';
import { getRequiredXsiamSampleFormat } from './xsiam-cef-samples';
import { describeSampleFormat, flattenEventsToLines, GENERATED_SAMPLE_COUNT, SAMPLE_EXTEND_FLOOR, sampleFormatMatchesVariant, sampleVariantsPresent, type SampleFormatDescription } from './sample-library';
import { aiSampleSnippet, sampleNeedsSanitising, UnsanitisedSampleError } from './sample-sanitise';
import { goldenWireFormatForSample } from './golden-variant';
import { sampleGenerationAttemptModes } from './ai-budget';
// Several megabytes of reference data and golden bodies. Neither is needed to paint
// the wizard, so each knowledge area is pulled in on demand rather than blocking startup.
const loadBundledData = () => import('./bundled-data');
const loadBundledGoldens = () => import('./bundled-goldens');
import { seedGoldenDefaultsSafely } from './golden-bundle-loader';
import goldenSourcetypeNameList from '../config/golden-sourcetype-names.json';
import { setBundledDataLoader, setBundledGoldensLoader } from './api';
// Registers the ONE real loaders for every `bundled()`/`bundledGoldens()` call
// site in api.ts — see that file's injected-loader declaration for why this
// can't be a direct `import()` there. App.tsx is the browser entry; the
// "Batch — Background" Backend Function (backend/run-batch-step.ts) never
// imports it, so its bundle never sees `bundled-data.ts`/`bundled-goldens.ts`
// (and the 11+ MB config/golden-pipelines.json behind the latter) at all.
setBundledDataLoader(loadBundledData);
setBundledGoldensLoader(loadBundledGoldens);
import { readRowSample, type RowSampleReading } from './batch-probe';
import { batchSampleConflictMessage, batchSampleKey, batchSampleSourcetype, findBatchSampleConflicts, fitBatchRowSample, isRowSampleKey, BATCH_ROW_SAMPLE_SOURCE_MODE } from './batch-row-sample';
import {
  batchGateOpen, confirmDeclared, confirmGateRow, confirmSettled, confirmMatchingRows, declarableAsIs, editGateDraft,
  addAiSuggestion, formatConfirmedBatchCsv, isGateRowValidated, needsAiDetection,
  openGateRow, readBatchSourcetypeColumns, revealSuggestions, suggestionLabel,
  type BatchGateRow,
} from './batch-preflight-gate';
import { buildCounts, foregroundRail, isSettled, needsYou, packCards, timedRows } from './batch-build-view';
import { actionTally, CONFLICT_ACTIONS, packHint, packScore, scoreTone, type ConflictAction, type ConflictPipe } from './batch-confirm-view';
import { goldenImportSummary, goldenUpdateNotice, leaveDecision } from './golden-availability';
import { canConfirmInline, checkTiles, preflightBusyView, decisionQueue, explainCheckRow, scopedQueue, selectionAfterRemove, sampleActionLabel, sampleNote, stepperFor, type CheckRowFacts, type Rich } from './batch-check-view';
import { forecastSamples, sampleForecastIsWeak, sampleForecastLabel, type StoreLookup } from './sample-forecast';
import { estimateBatch, loadRowTimings, measuredTimeLeft, recordBatchTimings, rowBuildPath, saveRowTimings, formatDuration, formatRoughRange } from './batch-estimate';
import { applyRowPatch, batchPhaseLabel, createAsyncCache, isBatchPhaseTerminal, preflightSampleTier, runPackGroups, batchRunChoices, groupPickBlock, BATCH_FOREGROUND_CONCURRENCY, BATCH_BACKGROUND_MAX_ROWS, type BatchPhase } from './batch-runtime';
import {
  backgroundBatchSupported, dismissBatchBackgroundRun, loadActiveBatchBackgroundRun,
  killBatchBackgroundRun, loadBatchBackgroundRun, loadBatchBackgroundRowArtifact, startBatchBackgroundRun, stopBatchBackgroundRun,
} from './api';
import { buildBackgroundManifest, summarizeBackgroundSamples } from './background-manifest';
import {
  backgroundReadFailure,
  backgroundStatusPresentation,
  type BackgroundPollOutcome,
} from './background-batch-runtime';
import {
  BACKGROUND_DISMISS_FAILED, BACKGROUND_READ_OK, BACKGROUND_STOPPING_LABEL,
  backgroundReportAvailability, buildBackgroundRunView, buildBackgroundRowScorecard, foldBackgroundRead, formatScore,
  type BackgroundReadState, type BackgroundRowScorecard, type BackgroundRowView, type BackgroundRunView,
} from './background-progress-view';
import { KILL_CONFIRM_LABEL, KILL_LABEL, killForegroundResults } from './batch-kill';
import type { BackgroundBatchCheckpoint } from './background-batch';
import { backgroundAiSnapshot } from './settings-store';
import { identifyUniqueNames, mapSettledWithConcurrency, preflightCount, preflightRowMatches, preflightSampleMatches, PREFLIGHT_FILTER_LABEL, samplesStillToResolve, type PreflightFilter, type PreflightFilterRow } from './preflight-filter';
import { averageStageScores, inferFromPipelineId, resolveDetectedSourcetype, splitPipelineFunctions } from './pipeline-stages';
import { buildTraceJson, describeStoredGoldens, summarizeBuildTraceForAi, type BuildTrace } from './build-trace';
import { batchResultRecord, batchResultsCsv, batchResultsJson } from './batch-results';
import { parseBatchCsv } from './batch-csv';
import { formatFunctionTypes, functionComposition } from './function-composition';
import { optimizePipelineStages, type OptimizeGoal, type OptimizeStageResult } from './optimize-pipeline';
import { applyDeterministicScore, generateBestPack, KNOWN_PARSER_SOURCETYPES, resolveDestFormat as resolveDestFmt } from './pack-orchestrator';
import { resolveBatchCommit, resolveConflictRepair, runPostDeployQuality, type DeployedPipelineRef as DeployedPipeline } from './quality-flow';
import {
  buildStagedPipeline, resolveParseFunctions, scoreStage, extractParsedFieldNames,
  type ExpStageId, type ExpStageResult, type ExpStageStats, type PreparedExtraction,
} from './staged-build';
import type { DatatypeAudit } from './api';
import type { AiParseFunctions, ValidationReport, ReferenceAvailability, PreDeployResult, CriblPipelineProfile } from './api';

// How much work the "what format is this sample?" labelling of the worker-group
// list may cost: at most this many visible rows are downloaded, and only files
// small enough that a background fetch is unnoticeable.
const SAMPLE_FORMAT_SNIFF_LIMIT = 12;
const SAMPLE_FORMAT_SNIFF_MAX_BYTES = 1_000_000;

function downloadTextFile(content: string, fileName: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[^a-z0-9._-]+/gi, '-');
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBuildTrace(trace: BuildTrace | BuildTrace[], fileStem: string): void {
  downloadTextFile(buildTraceJson(trace), `${fileStem}-build-trace.json`, 'application/json');
}

// Batch-level exports. The traces stay in memory only (never in the resume
// checkpoint — they carry whole sample bodies), so a resumed run exports the
// rows it rebuilt with traces and the rest from their on-screen results.
function downloadBatchResults(results: BatchResult[], traces: Record<number, BuildTrace>, format: 'csv' | 'json', workerGroup: string): void {
  const records = results.map((result, i) => batchResultRecord(result, traces[i], i));
  const exportedAt = new Date().toISOString();
  const stem = `batch-results-${exportedAt.slice(0, 19).replace(/[:T]/g, '')}`;
  if (format === 'csv') downloadTextFile(batchResultsCsv(records), `${stem}.csv`, 'text/csv');
  else downloadTextFile(batchResultsJson(records, { workerGroup, buildNumber: BUILD_NUMBER, exportedAt }), `${stem}.json`, 'application/json');
}

function BuildTracePanel({ traces }: { traces: BuildTrace[] }) {
  if (traces.length === 0) return null;
  return (
    <details className="build-trace-panel">
      <summary>Build trace ({traces.length} pipeline{traces.length === 1 ? '' : 's'})</summary>
      <div className="build-trace-head">
        <p>Contains the exact sample events, candidate decisions, stage scores, output previews, and final pipeline functions. Review before sharing.</p>
        <button className="secondary-btn" onClick={() => downloadBuildTrace(
          traces.length === 1 ? traces[0] : traces,
          traces.length === 1 ? traces[0].context.pipelineId : traces[0].context.packId,
        )}>Download JSON</button>
      </div>
      {traces.map(trace => (
        <details className="build-trace-entry" key={trace.traceId}>
          <summary>
            <code>{trace.context.pipelineId}</code>
            <span className={`build-trace-status status-${trace.status}`}>{trace.status}</span>
          </summary>
          <pre>{buildTraceJson(trace)}</pre>
        </details>
      ))}
    </details>
  );
}

function TraceAiPanel({ traces, buttonLabel = 'Analyze trace with AI', buttonClassName = 'secondary-btn' }: {
  traces: BuildTrace[];
  buttonLabel?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (traces.length === 0) return null;

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const summary = summarizeBuildTraceForAi(traces);
      const text = await analyzeBuildTrace(summary, comment);
      setResponse(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button className={buttonClassName} onClick={() => setOpen(true)}>{buttonLabel}</button>
      {open && (
        <div className="modal-backdrop trace-ai-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel trace-ai-panel" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>AI trace analysis</h3>
              <button className="close-btn" onClick={() => setOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              <p className="step-desc">
                Describe what looks wrong with this pack. The AI will read the build trace ({traces.length} pipeline{traces.length === 1 ? '' : 's'}) alongside your comment and explain whether the trace shows a reason for it.
              </p>
              <textarea
                className="trace-ai-comment"
                rows={4}
                placeholder="e.g. dest_ip is always empty in the output, or the score seems too low for a JSON source..."
                value={comment}
                onChange={e => setComment(e.target.value)}
                disabled={loading}
              />
              <button className="btn-primary trace-ai-run" onClick={() => void runAnalysis()} disabled={loading}>
                {loading ? 'Analyzing...' : 'Analyze'}
              </button>
              {error && <div className="error-box">{error}</div>}
              {response && (
                <div className="trace-ai-response">
                  <h4>Analysis</h4>
                  <pre>{response}</pre>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Stable key for an existing sample. Pack samples share ids/names with worker-group
// samples across packs, so the pack id must be part of the key used for React keys,
// format-sniff dedup and the format-badge lookup — id alone would collide.
const sampleKey = (s: { id: string; packId?: string }): string => (s.packId ? `${s.packId}::${s.id}` : s.id);

// Publishing, not reading. Reading the pool is public and needs nothing configured;
// writing needs a server-side token, which only exists outside the iframe.
function goldenSharingConfigured(q: QualitySettings): boolean {
  return !!(q.shareGoldens && q.goldenRepo && getRunMode() === 'standalone');
}
import type { AiMappingResult, AiProgressCallback } from './ai-client';
import { loadSettingsAsync, loadQualitySettings, loadQualitySettingsAsync, saveQualitySettings, saveLakeToken, saveGoldenReadToken, saveSanitisedSampleToken, aiDesignSearchDashboard, aiParallelism, isCriblAiActive, type QualitySettings } from './ai-client';
import { buildNativeDashboard, buildVizlabDashboard, type DashboardStyle } from './dashboard-builder';
import { buildSearchDatatype, inferSearchDatatypeFields } from './search-datatype-builder';
import { sanitisedSampleRepoError } from './sanitised-sample-github';
import { getAvailableSources, getPublicSource } from './sample-sources';
import { isSentinelIngestionTable, resolveSentinelTable, sentinelDestinationSuggestions } from './sentinel-knowledge';
import { cimModelSuggestions, cimModelPickerOptions, resolveCimModel } from './cim-knowledge';
import AiSettingsModal from './AiSettings';
import FlowDestination from './FlowDestination';
import { WIZARD_MODES, MENU_MODES, wizardSteps, canJumpToStep, isBusyStep, type WizardMode } from './wizard-steps';
import { EMPTY_FLOW_PP, flowBuildFormat, flowDestOptions, flowReductionToggles, flowSummary, ppEffectiveFormat, ppOutputLabel, ppOutputsToBuild, ppPackIdFor, type FlowPpState, type FlowPpOutput, flowBlockedReason, flowPackCheck, ppPackCheck, FLOW_ROUTE_FILTER, flowPackId, flowDefaultPackName, flowSourceLabel, ppPackNameFor, flowFormatInfo, flowBuildPercent, flowBuildCounts, type FlowLiveFormat, type FlowLivePp, type FlowBuildPhase, flowModelPick, flowCreep, flowRunningActivity, upstreamSampleEvents } from './flow-builder';
import {
  DEMO_EVENTS_PER_SEC, DEMO_LAKE_OUTPUT, DEMO_OCSF_REPLAY_ID, demoDefaultCells, demoEventsPerSecond, demoMergeCells, demoPpPackId, demoTargets,
  demoFailureReason, ocsfReplayLine, planDemoFlow, type DemoCell, type DemoPlan,
} from './demo-flow';
import { SampleLibraryModal } from './sample-library-panel';
import { TOOL_AREAS, toolTabs, toolLink, resolveToolPage, sampleLibraryView, settingsHealth, type ToolPage, type ToolLink, type SettingsTab, type SamplesTab } from './tool-pages';
import { DOC_OPEN_MESSAGE, type AppDocId } from './doc-ids';
import { SanitizeWizard, type LibrarySample, type SamplePick } from './sanitize-wizard';
import { ScoringReport, buildBatchReportHtml, downloadHtmlFile, type BatchReportPack, type ReportFormatVM, type ReportStageSource } from './ScoringReport';
import { buildImproveReportHtml, improveReportFilename, type ImproveReportRow } from './improve-report';
import { cachedVisualizerAvailability, criblInstanceBaseUrl, pipelineVisualizerUrl, probePipelineVisualizer } from './pipeline-visualizer-link';
import { PipelineVisualizerLink } from './PipelineVisualizerLink';
import { foregroundReportAvailability, groupForegroundReportRows, stagesFromArtifact, stagesFromBuilt, type ForegroundReportRow } from './background-run-report';

import { auditSchemaConformance, isSchemaConformanceFormat } from './schema-conformance';

// Sourcetypes with a stored golden. The catalog recogniser does not know every
// one of them (google_workspace, squid_proxy…), but a declared name that has a
// golden IS a known source: it must not be reported as unrecognized.
const STORED_GOLDEN_NAMES = new Set((goldenSourcetypeNameList as string[]).map(n => canonicalizeSourcetype(n)));
const hasStoredGolden = (name: string) => STORED_GOLDEN_NAMES.has(canonicalizeSourcetype(name));

// The two in-app documents — the User guide and the Technical reference — open in a
// new tab from a Blob URL, so they work in BOTH standalone and iframe (no server route /
// filesystem). One opener serves both.
//
// Loaded on demand: building the reference means importing the golden pipelines, the
// parser catalogue and the sample corpus, then computing its statistics over all of it
// at module scope. Statically imported, every user paid for a page almost none of them open.
async function loadAppDocHtml(doc: AppDocId): Promise<string> {
  if (doc === 'guide') return (await import('./user-guide')).USER_GUIDE_HTML;
  return (await import('./scoring-doc')).SCORING_DOC_HTML;
}

const APP_DOC_TITLES: Record<AppDocId, string> = { guide: 'User guide', technical: 'Technical reference' };
const APP_DOC_DOWNLOADS: Record<AppDocId, string> = {
  guide: 'pack-generator-user-guide.html',
  technical: 'pack-generator-onboarding-and-scoring.html',
};

// Blob URLs stay valid while their tab is open: revoking on a timer blanked a tab that
// was reloaded, and broke Download / Print in one left open. They are revoked once the
// tab is closed (polled — a cross-document `unload` is not observable from here) and are
// freed anyway when this document unloads.
const openDocTabs = new Map<Window, string[]>();
let docTabPoll: ReturnType<typeof setInterval> | undefined;
function trackDocTab(tab: Window, url: string) {
  openDocTabs.set(tab, [...(openDocTabs.get(tab) ?? []), url]);
  if (docTabPoll !== undefined) return;
  docTabPoll = setInterval(() => {
    for (const [w, urls] of openDocTabs) {
      if (!w.closed) continue;
      urls.forEach(u => URL.revokeObjectURL(u));
      openDocTabs.delete(w);
    }
    if (openDocTabs.size === 0) { clearInterval(docTabPoll); docTabPoll = undefined; }
  }, 5000);
}

// A cross-link in one document ("see the User guide") asks this window to load the
// other document into the same tab: a blob page has no stable URL for its sibling.
let docLinksListening = false;
function listenForDocLinks() {
  if (docLinksListening) return;
  docLinksListening = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== window.location.origin) return;
    const data = ev.data as { type?: unknown; doc?: unknown; hash?: unknown } | null;
    if (!data || data.type !== DOC_OPEN_MESSAGE) return;
    if (data.doc !== 'guide' && data.doc !== 'technical') return;
    const tab = ev.source as Window | null;
    if (!tab || !openDocTabs.has(tab)) return;
    const hash = typeof data.hash === 'string' && /^#[\w-]*$/.test(data.hash) ? data.hash : '';
    const doc = data.doc;
    void loadAppDocHtml(doc).then(html => {
      if (tab.closed) return;
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      trackDocTab(tab, url);
      tab.location.replace(url + hash);
    });
  });
}

async function openAppDoc(doc: AppDocId) {
  /*
   * Opened synchronously, BEFORE the await, and deliberately WITHOUT `noopener`.
   *
   * `noopener` was the bug. Per spec, `window.open` returns null whenever it is set, so the
   * handle this line exists to capture was ALWAYS null and the real open always happened
   * after an await, by which point the click that authorised it has expired and the
   * browser blocks it as a popup. Reverse tabnabbing is what `noopener` defends against,
   * and it buys nothing here: the tab only ever receives a blob of HTML this app built.
   * The opener handle is also what cross-links between the two documents post back to.
   */
  const tab = window.open('', '_blank');
  if (tab) {
    // Something to look at while the document is built.
    tab.document.write('<!doctype html><meta charset="utf-8"><title>Building…</title>'
      + '<p style="font:14px/1.6 -apple-system,system-ui,sans-serif;color:#595959;margin:40px">'
      + `Building the ${APP_DOC_TITLES[doc]}…</p>`);
    tab.document.close();
  }

  const html = await loadAppDocHtml(doc);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));

  if (tab && !tab.closed) {
    listenForDocLinks();
    trackDocTab(tab, url);
    tab.location.replace(url);
  } else {
    /* Popups are blocked, so opening another one would be blocked in exactly the same way.
       A download is not popup-blocked, so the reader ends up with the document instead of
       with nothing. The URL is freed when this document unloads. */
    const a = document.createElement('a');
    a.href = url;
    a.download = APP_DOC_DOWNLOADS[doc];
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

/** Settings → Quality "Reference" and the rail's "Technical reference". */
const openScoringDoc = () => openAppDoc('technical');
/** The rail's "User guide". */
const openUserGuide = () => openAppDoc('guide');

// Run work after the browser has finished the startup burst. Used for the mount-time
// probes that only feed status badges: fired immediately they compete with the AI health
// check for the browser's per-host connection budget, which is the one probe the user is
// actually waiting on. `requestIdleCallback` is not in Safari, hence the timeout fallback.
function whenIdle(fn: () => void, timeout = 2000) {
  const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => void);
  if (ric) ric(fn, { timeout });
  else setTimeout(fn, 1);
}

// The Cribl goat grazing its way along a progress track. Reusable progress bar:
//  • pct === undefined → indeterminate (goat roams back and forth, for "working…" states)
//  • pct 0..100        → determinate (fill + goat at the real percent, % bubble above)
// Ticks on its own so a one-second clock re-renders this span, not the
// 500-row check screen around it.
function ElapsedSince({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - since) / 1000));
  return <>{secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`}</>;
}

function GoatBar({ pct, label }: { pct?: number; label?: string }) {
  const det = typeof pct === 'number';
  const v = det ? Math.max(0, Math.min(100, pct!)) : 0;
  return (
    <div
      className={det ? `goatbar det${v >= 100 ? ' full' : ''}` : 'goatbar indet'}
      style={det ? ({ ['--pct' as string]: v }) : undefined}
      role="progressbar"
      aria-label={label || 'Working'}
      aria-valuemin={det ? 0 : undefined}
      aria-valuemax={det ? 100 : undefined}
      aria-valuenow={det ? Math.round(v) : undefined}
    >
      <div className="gb-track"><div className="gb-fill" /></div>
      <div className="gb-grass" />
      <div className="gb-rider">
        {det && <span className="gb-bubble">{Math.round(v)}%</span>}
        <div className="gb-face">
          <img className="gb-goat" src={goatGrazeImg} alt="" aria-hidden="true" />
          <span className="gb-crumbs" aria-hidden="true"><i>1</i><i>0</i><i>1</i><i>0</i></span>
        </div>
      </div>
    </div>
  );
}

// m:ss since `since` (ms epoch), ticking on its own so the parent doesn't re-render.
function Elapsed({ since, stop }: { since: number; stop?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (stop || !since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since, stop]);
  const sec = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return <>{fmtClock(sec)}</>;
}

const fmtClock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// Build pack flow: goat bar + "what is running now" line. Ticks on its own
// (twice a second) so a long AI/scoring step still visibly moves: the bar creeps
// through the running step (flowCreep), the step shows its own timer, and a
// hint appears when the log has been quiet for a while.
function FlowBuildLive({ formats, pps, phase, lastLog, logCount, error }: {
  formats: FlowLiveFormat<ExpStageResult>[]; pps: FlowLivePp[]; phase: FlowBuildPhase;
  lastLog: string; logCount: number; error: string;
}) {
  const act = flowRunningActivity(formats, pps, phase);
  const stop = !!error || phase === 'done';
  const [now, setNow] = useState(() => Date.now());
  const stepAt = useRef({ key: '', at: Date.now() });
  const logAt = useRef({ n: -1, at: Date.now() });
  if (stepAt.current.key !== act.key) stepAt.current = { key: act.key, at: Date.now() };
  if (logAt.current.n !== logCount) logAt.current = { n: logCount, at: Date.now() };
  useEffect(() => {
    if (stop) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [stop]);
  const stepSec = Math.max(0, Math.floor((now - stepAt.current.at) / 1000));
  const quietSec = Math.max(0, Math.floor((now - logAt.current.at) / 1000));
  // Never step backwards: a finished step can't read lower than the creep that preceded it.
  const maxPct = useRef(0);
  const pct = Math.max(maxPct.current, flowBuildPercent(formats, pps, phase, flowCreep((now - stepAt.current.at) / 1000)));
  maxPct.current = pct;
  return (
    <>
      <GoatBar pct={pct} label={`Building pack flow — ${pct}%`} />
      <div className={`fb-now${error ? ' err' : ''}${phase === 'done' ? ' ok' : ''}`} role="status" aria-live="polite">
        <span className={error || phase === 'done' ? 'fb-pulse' : 'fb-spin'} aria-hidden="true" />
        <div className="fb-now-main">
          <div className="fb-now-title">
            <b>{error ? 'Build stopped' : act.title}</b>
            <span className="fb-now-what">{error || act.what}</span>
            {!stop && <span className="fb-now-time">{fmtClock(stepSec)}</span>}
          </div>
          {!error && lastLog && <div className="fb-now-text">{lastLog}</div>}
          {!stop && quietSec >= 15 && (
            <div className="fb-now-hint">Still working: no new output for {quietSec}s. AI extraction, mapping and scoring can take a minute or two per step.</div>
          )}
        </div>
      </div>
    </>
  );
}

function AiProgress({ messages }: { messages: string[] }) {
  const [index, setIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setIndex(0);
    setElapsed(0);
  }, [messages]);

  useEffect(() => {
    const msgInterval = setInterval(() => {
      setIndex((i) => (i + 1) % messages.length);
    }, 2500);
    const timeInterval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => { clearInterval(msgInterval); clearInterval(timeInterval); };
  }, [messages]);

  return (
    <div className="ai-progress">
      <GoatBar label="AI analysis in progress" />
      <div className="ai-progress-content">
        <div className="ai-spinner" />
        <span className="ai-progress-msg">{messages[index]}</span>
        <span className="ai-progress-time">{elapsed}s</span>
      </div>
    </div>
  );
}

const STEP_ICONS: Record<string, string> = {
  researching: '\u{1F50D}',
  generating: '\u{2699}️',
  analyzing: '\u{1F9E0}',
  mapping: '\u{1F517}',
  done: '\u{2705}',
  alldone: '\u{2705}',
};

function AiStepProgress({ steps }: { steps: { step: string; detail: string; time: number }[] }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const currentStep = steps[steps.length - 1];
  const baseStepLast = currentStep?.step.includes(':') ? currentStep.step.split(':').pop()! : currentStep?.step;
  const isDone = baseStepLast === 'done' || baseStepLast === 'alldone';

  return (
    <div className="ai-progress">
      <GoatBar pct={isDone ? 100 : undefined} label="AI analysis in progress" />
      <div className="ai-step-list">
        {steps.map((s, i) => {
          const baseStep = s.step.includes(':') ? s.step.split(':').pop()! : s.step;
          const isLast = i === steps.length - 1;
          const isActive = isLast && !isDone;
          return (
            <div key={i} className={`ai-step-item ${isActive ? 'active' : ''}`}>
              <span className="ai-step-icon">{STEP_ICONS[baseStep] || '\u{25CB}'}</span>
              <span className="ai-step-detail">{s.detail}</span>
              {isActive && <span className="ai-spinner" style={{ width: 12, height: 12, borderWidth: 2, marginLeft: 8 }} />}
            </div>
          );
        })}
      </div>
      <div className="ai-progress-content" style={{ borderTop: 'none', paddingTop: 4 }}>
        <span className="ai-progress-time">{elapsed}s elapsed</span>
      </div>
    </div>
  );
}

const BAND_META: Record<string, { icon: string; label: string; cls: string }> = {
  good: { icon: '✅', label: 'Good', cls: 'band-good' },
  warn: { icon: '⚠️', label: 'Needs review', cls: 'band-warn' },
  fail: { icon: '❌', label: 'Broken', cls: 'band-fail' },
};

// @deprecated (build 687) — the on-demand schema-validation report block was
// removed from all scoring screens (done / batch-done / experiment-done),
// superseded by the unified <ScoringReport>. This component + its supporting
// state (validationReports, validatingPipelines, runValidation, repairSelected…)
// are retained for now and scheduled for removal in a follow-up cleanup.
// Schema validation report panel — was shown on the done/batch-done screens.
function ValidationPanel({
  pipelines, reports, validating, repairing, repairSelection, error,
  onRun, onToggleRepair, onRepairSelected,
}: {
  pipelines: DeployedPipeline[];
  reports: Record<string, ValidationReport | null>;
  validating: boolean;
  repairing: boolean;
  repairSelection: Set<string>;
  error: string;
  onRun: () => void;
  onToggleRepair: (id: string) => void;
  onRepairSelected: () => void;
}) {
  const hasReports = Object.keys(reports).length > 0;
  const failing = pipelines.filter(p => { const r = reports[p.pipelineId]; return r && r.band !== 'good'; });

  return (
    <div className="validation-panel">
      <div className="validation-header">
        <h3>Pipeline Quality Check</h3>
        <button className="validate-btn" onClick={() => onRun()} disabled={validating || repairing || pipelines.length === 0}>
          {validating ? 'Running…' : hasReports ? 'Re-run check' : 'Run schema validation'}
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}

      {/* Schema Validation Reports */}
      {Object.keys(reports).length > 0 && (
        <div className="validation-section">
          <h4 className="validation-section-title">Schema Validation</h4>
          {pipelines.map(p => {
            const r = reports[p.pipelineId];
            if (!r) return null;
            const meta = BAND_META[r.band];
            const canRepair = r.band !== 'good';
            return (
              <div key={p.pipelineId} className={`validation-card ${meta.cls}`}>
                <div className="validation-card-head">
                  {canRepair && (
                    <input type="checkbox" checked={repairSelection.has(p.pipelineId)} onChange={() => onToggleRepair(p.pipelineId)} disabled={repairing} title="Select for repair" />
                  )}
                  <strong className="validation-pl">{p.pipelineId}</strong>
                  <span className="validation-fmt">{p.destFormat}</span>
                  <span className={`validation-score ${meta.cls}`}>{meta.icon} {r.score}/100 · {meta.label}</span>
                  {r.scoreSource === 'schema-validated' && <span className="validation-scoresrc" title="Deterministic score: real output diffed against the format's golden schema — no AI judge">schema-validated</span>}
                </div>
                <div className="validation-body">
                  {r.summary && <p className="score-why">{r.summary}</p>}
                  <div className="validation-checks">
                    <span className={r.sampleFormatOk ? 'check-ok' : 'check-bad'}>{r.sampleFormatOk ? '✓' : '✗'} Sample format {r.sampleFormatNote ? `— ${r.sampleFormatNote}` : ''}</span>
                    <span className={r.outputFormatOk ? 'check-ok' : 'check-bad'}>{r.outputFormatOk ? '✓' : '✗'} Output format ({r.outputCount} events)</span>
                  </div>
                  {r.missingFields.length > 0 && <div className="validation-fields"><strong>Missing:</strong> {r.missingFields.join(', ')}</div>}
                  {r.emptyFields.length > 0 && <div className="validation-fields"><strong>Empty:</strong> {r.emptyFields.join(', ')}</div>}
                  {r.findings.length > 0 && (
                    <ul className="validation-findings">
                      {r.findings.map((f, i) => (
                        <li key={i} className={`finding-${f.severity}`}>
                          <strong>{f.severity}</strong> · <code>{f.field}</code>
                          {' '}
                          <span
                            className={f.pointImpact ? 'finding-impact-scored' : 'finding-impact-advisory'}
                            title={f.pointImpact ? 'Points this finding cost against the displayed score' : "Advisory — didn't change the displayed score (e.g. flags something the deterministic schema check doesn't measure)"}
                          >
                            {f.pointImpact ? `[-${f.pointImpact} pts]` : '[no score impact]'}
                          </span>
                          {' '}— {f.issue}{f.example ? ` (${f.example})` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
          {failing.length > 0 && (
            <div className="validation-repair-bar">
              <span>{repairSelection.size} of {failing.length} improvable pipeline{failing.length > 1 ? 's' : ''} selected</span>
              <button className="repair-btn" onClick={onRepairSelected} disabled={repairing || repairSelection.size === 0} title="Iteratively fix the findings and missing fields on the selected cards until the score peaks">
                {repairing ? 'Improving…' : `Improve selected (${repairSelection.size})`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Spinner when running and no reports yet */}
      {validating && Object.keys(reports).length === 0 && (
        <div className="validation-card">
          <div className="validation-card-head">
            <span className="ai-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
            <span style={{ marginLeft: 8 }}>Running checks…</span>
          </div>
        </div>
      )}
    </div>
  );
}
// @deprecated (build 687) keep-alive — see the note on ValidationPanel above.
void ValidationPanel;

// NOTE: the deprecated single-shot 'new' (classic) mode was removed — its entry
// point is gone and every step it used is shared with 'add-pipeline'/'experiment'
// (nothing exclusive was lost). The deploy-time create-vs-add flag is a SEPARATE
// inline `'new' | 'add-pipeline'` type on buildStagedPipeline/deploy — unrelated.
// 'flow' = "Build pack flow (including post-processing)": a copy of the
// 'experiment' (Create new pack) wizard whose destination step is the bottom-up
// flow canvas, and whose build also creates the post-processing packs.
type PackMode = 'add-pipeline' | 'batch' | 'demo' | 'experiment' | 'post-process' | 'flow';
type Step = 'mode' | 'select-group' | 'select-pack' | 'select-action' | 'select-pipeline' | 'optimize-goals' | 'optimize-sample' | 'optimize-running' | 'optimize-done' | 'name' | 'source' | 'destination' | 'ai-analysis' | 'options' | 'review' | 'deploying' | 'done' | 'batch-upload' | 'batch-preflight' | 'batch-running' | 'batch-done' | 'batch-bg-running' | 'demo-group' | 'demo-sources' | 'demo-destinations' | 'demo-routing' | 'demo-deploying' | 'demo-done' | 'demo-cleanup' | 'demo-cleanup-done' | 'experiment-setup' | 'experiment-running' | 'experiment-done' | 'pp-formats';

// One selected source in the demo builder.
interface DemoSource {
  sourcetype: string;       // canonical sourcetype
  allowCodeFunctions: boolean;
}

// Result of building one demo combination, for the done screen.
interface DemoResult {
  sourcetype: string;
  /** Flow format key (main pack pipeline) or `pp:<fmt>` (post-processing pack). */
  format: string;
  kind: 'main' | 'pp';
  label: string;
  status: 'pending' | 'running' | 'success' | 'error';
  phase?: BatchPhase;              // truthful per-combination phase (shared with batch UI)
  score?: number | null;          // null = N/A (e.g. a passthrough raw copy — nothing to score)
  // Per-stage scores from the 3-stage builder (null = N/A, e.g. mapping for JSON).
  stageScores?: { extraction: number | null; mapping: number | null; optimization: number | null };
  packId?: string;
  pipelineId?: string;
  message?: string;
}

interface BatchRow {
  sourcetype: string;
  // The Splunk-native sourcetype string EXACTLY as the user typed it in the CSV
  // (e.g. `cisco:asa`, `infoblox:dns`). `sourcetype` gets overwritten with the
  // canonical/underscore form during pre-flight (needed for recognition + sample
  // lookup), which loses the colon Splunk expects on the emitted `sourcetype`
  // field. This preserves the original so the mapping builder emits the correct
  // source-native name. Captured at parse, never canonicalized.
  outputSourcetype?: string;
  pack_name: string;
  route_name: string;
  filter: string;
  pipeline_name: string;
  dest_format: string;
  // When dest_format is 'sentinel' the user must pick a table here; when 'cim'
  // they pick a data model. Set from the CSV if a concrete table/model was named,
  // else chosen in the batch-upload preview before Next is allowed.
  sentinelTable?: string;
  cimModel?: string;
  // Set when the sourcetype string is structurally invalid (see
  // validateSourcetypeString). The row still shows in the preview so the user
  // can correct it inline; "Next" is blocked until every flag is cleared.
  sourcetypeError?: string;
  // The row's own events, one per line, chosen in the pre-flight sample picker
  // (fitBatchRowSample bounds them). Ahead of every store tier; the format is
  // read from it, never named. Builds with sourceMode 'paste'.
  sample?: string;
  // True when the picker returned events that may reach the AI: a sanitised
  // result, a saved (sanitised) sample, or a library sample. Threaded to staged
  // builds so the privacy gate can use AI.
  sampleSanitised?: boolean;
  // What the picker chose, for the Sample column ("Library sample · 24 events").
  // Set with or without `sample`: a library pick for the declared name leaves
  // `sample` empty so the normal resolution (and its extension) still runs.
  sampleChoice?: string;
  // One line about that choice: trimmed, nothing replaced, library save result.
  sampleNote?: string;
}

// Sample-aware schema suggestion attached to a parked batch/demo row: the format
// was chosen before any sample existed; once the real sample was sniffed it
// clearly implied a different data class. The row waits (non-blocking) for the
// user to Switch or Keep. Shared by batch and demo flows.
interface SchemaSuggestion {
  current: string;      // destFmt the row was going to build with
  suggested: string;    // sample-inferred best-fit format
  dataClass: string;    // inferred data class (e.g. 'endpoint')
  confidence: number;   // 0..1
  signals: string[];    // top evidence strings
}

interface BatchResult {
  row: BatchRow;
  // 'awaiting-confirmation' = parked after the post-sample schema re-check; the
  // main batch loop moved on, this row waits for a Switch/Keep decision.
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'awaiting-confirmation' | 'awaiting-sample';
  schemaSuggestion?: SchemaSuggestion;
  message?: string;
  score?: number | null;          // quality-gate score of the deployed pipeline (null = N/A, e.g. passthrough)
  report?: PreDeployResult | null; // full validation report behind the score (clickable)
  phase?: BatchPhase;              // truthful current phase: preparation, deploy, score, repair
  // Per-stage scores from the 3-stage builder (null = N/A / not yet run).
  stageScores?: { extraction: number | null; mapping: number | null; optimization: number | null };
  // Full per-stage detail for the inline "Show" report (source, reasons, in/out).
  stageReport?: { stage: string; source: string; score: number | null; reasons: string[]; outEvent?: any }[];
  // Provenance + timing, so a batch result explains itself without a live-org
  // post-mortem. sampleTier = which tier supplied the sample ('none' when the
  // row parked); sampleReason = why, verbatim from the failing tier.
  sampleTier?: 'preflight' | 'reference' | 'ai-generated' | 'bundled' | 'uploaded' | 'none';
  sampleReason?: string;
  timings?: { prepareMs?: number; buildMs?: number; deployMs?: number; totalMs?: number };
  // Improve ran a repair on the LIVE pipeline after the build. The row's build
  // trace (and the function counts exported from it) then describes the
  // pipeline as built, which the repair may have changed.
  repairedAfterBuild?: boolean;
}

const BATCH_REQUIRED_FIELDS = ['sourcetype', 'pack_name', 'pipeline_name', 'dest_format'] as const;
const VALID_DEST_FORMATS = ['nextgen', 'ocsf', 'cef', 'commonsecuritylog', 'cim', 'ecs', 'asim', 'chronicle', 'json', 'xsiam', 'passthrough', 'sentinel'];

// Structural validity of a sourcetype STRING for the batch flow. This is NOT
// "has a golden parser" (most sourcetypes legitimately use AI) — it's "can this
// string be safely used as a Splunk sourcetype and inside a Cribl `sourcetype==`
// filter without breaking generation". Returns a reason when invalid, else null.
// The user can fix the flagged value inline before running the batch.
function validateSourcetypeString(st: string): string | null {
  const s = (st || '').trim();
  if (!s) return 'empty';
  if (s.length > 256) return 'too long (max 256)';
  // A single-quote/backslash/newline would break the generated
  // `sourcetype=='...'` filter expression (Cribl jsExpression).
  if (/['"\\\n\r]/.test(s)) return "contains a quote, backslash, or newline";
  // Whitespace inside a sourcetype is almost always a paste/column error.
  if (/\s/.test(s)) return 'contains whitespace';
  // Real Splunk sourcetypes are printable ASCII (letters, digits, and the
  // separators : _ - . / are all common). Reject control/other chars.
  if (!/^[A-Za-z0-9:_\-./]+$/.test(s)) return 'contains invalid characters';
  return null;
}

// Extract parsed field names from AI-generated parse functions, so the mapping
// step can be told which fields exist after parsing.

// --- Shared generation core (used by ALL entry points) -----------------------
// Generate Pack, Add Pipeline, and Batch must all produce the same quality of
// pack: identical extraction, functions, field mapping, quality-gate + repair,
// and auto-promote behavior. The only legitimate difference between them is the
// SAMPLE SOURCE (user-provided vs AI-generated) and the DEPLOY target (new pack
// vs existing pack vs many packs). Everything from "we have a sample" through
// "we have the best-scoring pipeline" lives here so no path can silently drift.

// STEP 0 — generating a sample is one policy, shared by every autonomous flow.
// The demo escalated `fast` → `balanced`; the batch pre-flight, the batch build path
// and the per-row Rerun each made a single `fast` attempt, so one slow or unlucky
// call cost a whole row a "No sample available" for a source the wizard handles.
// `sampleGenerationAttemptModes()` (ai-budget.ts) owns the escalation; this owns the
// loop and the reason string. It never throws — callers decide whether an empty
// result is fatal or just the next tier down.
async function generateSampleEvents(opts: {
  sourcetype: string;
  count?: number;
  grounding?: SampleGrounding | null;
  /** Optional progress sink (demo/batch logs). Messages are already indented. */
  log?: (message: string) => void;
}): Promise<{ events: string; lastReason: string; attempts: number; mode: string }> {
  const { sourcetype, grounding, log } = opts;
  const count = opts.count ?? GENERATED_SAMPLE_COUNT;
  const modes = sampleGenerationAttemptModes();
  let lastReason = 'AI produced no events';
  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    const started = Date.now();
    try {
      const result = await aiSamples(sourcetype, count, mode, undefined, grounding || undefined);
      if (result.events.length > 0) {
        return { events: result.events.join('\n'), lastReason: '', attempts: i + 1, mode };
      }
      lastReason = `${mode} attempt returned no usable events`;
    } catch (e: any) {
      const why = e?.message?.slice(0, 140) || 'AI sample generation failed';
      lastReason = `${why} (after ${Math.round((Date.now() - started) / 1000)}s, ${mode})`;
    }
    log?.(i === modes.length - 1
      ? `  ⚠ AI sample generation failed: ${lastReason}`
      : `  ${lastReason} — retrying with ${modes[i + 1]}…`);
  }
  return { events: '', lastReason, attempts: modes.length, mode: modes[modes.length - 1] };
}

// STEP 1 — resolve the parse stage once per source: replay a verified recipe if
// the sample structurally matches, else AI-generate a parser for custom
// sourcetypes, else use the built-in parser's known field contract. Mapping is
// NEVER generated blind — it always gets the real parsed field names.

interface AiReduction {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  reduction?: number;
}

interface AiAdvice {
  summary: string;
  parseStrategy: string;
  mappingNotes: string;
  reductionOpportunities: string[];
  risks: string[];
  pipelineSteps: string[];
  reductions?: AiReduction[];
}

interface WorkerGroup {
  id: string;
  name: string;
  type: string;
}

interface ExistingPack {
  id: string;
  displayName: string;
  version: string;
}

function logContractBlock(findings: ContractLintFinding[] | undefined, log: (msg: string) => void): boolean {
  const errors = getBlockingContractErrors(findings);
  if (errors.length === 0) return false;
  log(`✗ Deploy blocked: ${errors.length} contract error(s) — fix parser/extraction issues before deploying:`);
  for (const f of errors.slice(0, 12)) {
    log(`   [error] ${f.stage}: ${f.hint}`);
  }
  return true;
}

const DEST_OPTIONS: { value: DestFormat; label: string; description: string }[] = [
  { value: 'nextgen', label: 'CrowdStrike NG SIEM (vendor parser)', description: 'The original event, byte for byte, for the NG SIEM connector’s vendor parser — only _raw is sent (one connector per parser).' },
  { value: 'ocsf', label: 'OCSF 1.9', description: 'Open Cybersecurity Schema Framework — security lake, Amazon Security Lake, Cribl Lake' },
  { value: 'cef', label: 'CEF', description: 'Common Event Format — CEF:0|Vendor|Product|Version|ID|Name|Severity|key=value extensions' },
  { value: 'sentinel', label: 'Microsoft Sentinel', description: 'Microsoft Sentinel — choose the native table below (CommonSecurityLog, SecurityEvent, ASim…).' },
  { value: 'cim', label: 'Splunk CIM', description: 'Splunk Common Information Model — Network Traffic, Authentication, Endpoint data models' },
  { value: 'ecs', label: 'Elastic ECS', description: 'Elastic Common Schema — field mapping for Elasticsearch, Kibana, and Elastic SIEM' },
  { value: 'asim', label: 'Microsoft Sentinel ASIM', description: 'Advanced Security Information Model — normalized tables (Network, Auth, Process)' },
  { value: 'chronicle', label: 'Google Chronicle UDM', description: 'Google Chronicle Unified Data Model — for Chronicle SIEM ingestion' },
  { value: 'xsiam', label: 'Cortex XSIAM', description: 'Palo Alto Cortex XSIAM — passthrough with __sourceIdentifier tagging; XSIAM parses vendor format natively' },
  { value: 'passthrough', label: 'Passthrough (raw copy)', description: 'No transformation — forward events exactly as received (_raw preserved). For a Lake/destination that just wants a raw copy of the data.' },
  { value: 'json', label: 'Clean JSON', description: 'Structured JSON with normalized field names — for Cribl Lake, S3, or any JSON destination' },
  // Manual/custom destination entry removed (build 687) — destinations must be a
  // known schema so the pipeline can be built and scored deterministically.
];

// Optimize flow only learns known schemas — Custom / Other and Passthrough
// (no transform to learn) are not offered there.
// Build pack flow picker: Lake options first, then the analytics tools A→Z
// (incl. the flow-only Splunk/Elastic raw + JSON splits). The classic wizard keeps DEST_OPTIONS.
const FLOW_DEST_OPTIONS = flowDestOptions();
const OPTIMIZE_DEST_OPTIONS = DEST_OPTIONS.filter(option => option.value !== 'manual' && option.value !== 'passthrough');

/** Map a concrete build destFormat (pipeline id / resolveDestFmt) back to the
 *  optimize UI family card + Sentinel/CIM/ASIM sub-pick — same shape as the
 *  pack-builder destination step. */
function optimizeDestFromConcrete(destFormat: string): {
  family: DestFormat | '';
  sentinelTable?: string;
  cimModel?: string;
  asimSchema?: string;
  ocsfSchema?: string;
} {
  const df = String(destFormat || '').trim();
  if (!df) return { family: '' };
  if (df === 'asim' || df.startsWith('asim#')) {
    return { family: 'asim', asimSchema: df === 'asim' ? 'auto' : df };
  }
  if (df === 'cim' || df.startsWith('cim#')) {
    return { family: 'cim', cimModel: cimModelForFormatKey(df) || 'Network_Traffic' };
  }
  if (df === 'ocsf' || df.startsWith('ocsf#')) {
    return { family: 'ocsf', ocsfSchema: df === 'ocsf' ? 'auto' : df };
  }
  // NG SIEM has no OCSF class; a legacy `nextgen#<class>` is the same raw-fidelity card.
  if (df === 'nextgen' || df.startsWith('nextgen#')) return { family: 'nextgen' };
  const sentinelProbe = df.toLowerCase() === 'commonsecuritylog' ? 'CommonSecurityLog' : df;
  const sentinel = resolveSentinelTable(sentinelProbe);
  if (sentinel) return { family: 'sentinel', sentinelTable: sentinel.name };
  if (OPTIMIZE_DEST_OPTIONS.some(o => o.value === df)) return { family: df as DestFormat };
  return { family: '' };
}

const initialState: WizardState = {
  packName: '',
  displayName: '',
  sourceMode: '',
  sampleEvents: '',
  destFormat: 'ocsf',
  destFormats: [],
  manualFormat: '',
  routeFilter: 'true',
  workerGroup: 'default',
};

// Classify a deploy-log line into a color group so the terminal visually
// separates stages. Each pipeline block ([n/N] …) cycles a color so a new
// pipeline is obviously a new section.
function logLineClass(line: string): string {
  if (/^\s+\[error\]/.test(line)) return 'log-error';       // contract-lint detail
  if (/^\s+\[warning\]/.test(line)) return 'log-quality';   // contract-lint detail
  if (/^ERROR|failed|⚠/i.test(line)) return 'log-error';
  if (/^✓|Committed:|Deployed version:/.test(line)) return 'log-success';
  const seq = line.match(/^\[(\d+)\/\d+\]/);
  if (seq) return `log-pipe log-pipe-${(Number(seq[1]) - 1) % 4}`; // per-pipeline color
  if (/^\[/.test(line)) return 'log-quality';       // [label] quality-gate lines
  if (/lookup|Self-healed|Bundled|Prepared|coverage/i.test(line)) return 'log-lookup';
  if (/^(Mode:|Pack:|Formats:|Worker group:)/.test(line)) return 'log-setup';
  return 'log-line-default';
}

// Live activity banner for the deploying screen — makes long AI steps (quality
// gate, targeted remaps) visibly busy so the UI never looks hung. Shows a
// spinner, the current step, elapsed time, and a "still working" note once a
// single step runs long.
function DeployActivity({ latest, lineCount }: { latest: string; lineCount: number }) {
  const [elapsed, setElapsed] = useState(0);
  const [stepElapsed, setStepElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const stepStartRef = useRef(Date.now());

  // Reset the per-step timer whenever a new log line arrives.
  useEffect(() => { stepStartRef.current = Date.now(); setStepElapsed(0); }, [lineCount]);
  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      setStepElapsed(Math.floor((Date.now() - stepStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="deploy-activity">
      <span className="ai-spinner" style={{ width: 18, height: 18, borderWidth: 3 }} />
      <div className="deploy-activity-text">
        <strong>{latest}</strong>
        <span className="deploy-activity-meta">
          {mmss(elapsed)} elapsed
          {stepElapsed >= 12 && <span className="deploy-activity-wait"> · this step is taking a while (AI analysis, ~{stepElapsed}s) — still working…</span>}
        </span>
      </div>
    </div>
  );
}

// Where an import lands differs by run mode, and the difference is worth stating:
// standalone edits the repo's own parser library, while an install running inside
// Cribl can only keep its imports for itself.
function describeDatatypeStore(storedIn: DatatypeAudit['storedIn']): string {
  if (storedIn === 'config') return 'Imports are written to the app parser library (config/datatype-parsers.json).';
  if (storedIn === 'browser') return 'Imports are kept in this browser — the app key-value store was not writable, so they will not follow you to another browser.';
  return 'Imports are saved to this app installation and layered over the built-in parser library.';
}

// Cribl Search datatype coverage checker — audits which stock datatypes the app
// has imported vs. what's live in Search, and can import new ones.
function DatatypesModal({ open, onClose, embedded }: { open: boolean; onClose: () => void; embedded?: boolean }) {
  const [audit, setAudit] = useState<DatatypeAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [goldenStats, setGoldenStats] = useState<{ local: number; repo: number; available: number } | null>(null);

  const loadGoldenStats = async () => {
    const local = await (await loadBundledGoldens()).countLocalGoldens();
    const result = await fetchAvailableGoldens();
    const repoTotal = result.total || (result.available?.length || 0) + local;
    setGoldenStats({ local, repo: repoTotal, available: result.available?.length || 0 });
  };

  const run = async (apply = false) => {
    if (apply) setApplying(true); else setLoading(true);
    setError('');
    try {
      const r = await auditDatatypes(apply);
      if (r.error) setError(r.error); else setAudit(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Audit failed');
    } finally {
      setLoading(false); setApplying(false);
    }
  };

  useEffect(() => { if (open && !audit) void run(false); if (open) void loadGoldenStats(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  if (!open) return null;

  return (
    <div className={embedded ? 'tp-embed' : 'modal-backdrop'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'tp-embed-panel' : 'modal-panel datatypes-modal'} onClick={e => e.stopPropagation()}>
        {!embedded && (
        <div className="modal-header">
          <h3>Cribl Search Datatype Coverage</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        )}
        <div className="modal-body">
        <p className="step-desc">Compares the stock datatypes in your Search group against the parsers this app has imported. New datatypes can be imported as source parsers.</p>
        {loading && <div className="dt-loading"><span className="ai-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Checking Search datatypes…</div>}
        {error && <div className="error-box">{error}</div>}
        {audit && !loading && (
          <>
            <div className="dt-summary">
              <span><strong>{audit.liveUsable}</strong> live</span>
              <span><strong>{audit.imported}</strong> imported</span>
              <span><strong>{audit.pickerCount}</strong> in picker</span>
            </div>
            <p className="field-hint" style={{ marginTop: 4 }}>{describeDatatypeStore(audit.storedIn)}</p>
            <div className="dt-section">
              <h4>New in Search — not yet imported ({audit.newInSearch.length})</h4>
              {audit.newInSearch.length === 0
                ? <p className="dt-empty">✓ In sync — nothing new.</p>
                : <div className="dt-chips">{audit.newInSearch.map(id => <code key={id} className="dt-chip dt-new">{id}</code>)}</div>}
            </div>
            {(audit.changed?.length ?? 0) > 0 && (
              <div className="dt-section">
                <h4>Changed upstream — parser differs from stored ({audit.changed.length})</h4>
                <div className="dt-chips">{audit.changed.map(id => <code key={id} className="dt-chip dt-new">{id}</code>)}</div>
              </div>
            )}
            {audit.stale.length > 0 && (
              <div className="dt-section">
                <h4>Stale — in app, gone from Search ({audit.stale.length})</h4>
                <div className="dt-chips">{audit.stale.map(id => <code key={id} className="dt-chip dt-stale">{id}</code>)}</div>
              </div>
            )}
            <details className="dt-section">
              <summary>Imported but not selectable in the wizard picker ({audit.notInPicker.length})</summary>
              <div className="dt-chips">{audit.notInPicker.map(id => <code key={id} className="dt-chip">{id}</code>)}</div>
            </details>
            {(audit.appliedIds.length > 0 || (audit.updatedIds?.length ?? 0) > 0 || (audit.removedIds?.length ?? 0) > 0) && (
              <div className="advice-box">✓ Synced: {audit.appliedIds.length} new, {audit.updatedIds?.length ?? 0} updated, {audit.removedIds?.length ?? 0} removed.{audit.appliedIds.length ? ` Added: ${audit.appliedIds.join(', ')}.` : ''}{audit.removedIds?.length ? ` Removed: ${audit.removedIds.join(', ')}.` : ''} {describeDatatypeStore(audit.storedIn)}</div>
            )}
          </>
        )}

        {goldenStats && (
          <>
            <div style={{ borderTop: '1px solid #e8e8e8', margin: '16px 0 8px' }} />
            <h4 style={{ margin: '0 0 8px' }}>Golden Pipeline Coverage</h4>
            <div className="dt-summary">
              <span><strong>{goldenStats.local}</strong> local</span>
              <span><strong>{goldenStats.repo}</strong> in repo</span>
              {goldenStats.available > 0 && <span style={{ color: '#d46b08' }}><strong>{goldenStats.available}</strong> new/upgrades</span>}
            </div>
            <p className="field-hint" style={{ marginTop: 4 }}>
              Local = golden pipelines stored in this instance. Repo = total in the shared GitHub repo.
              {goldenStats.available > 0 && ' Import new/upgraded goldens on the Goldens tab.'}
            </p>
          </>
        )}

        <div className="nav" style={{ marginTop: 16 }}>
          <button className="back" onClick={() => { run(false); loadGoldenStats(); }} disabled={loading || applying}>Re-check</button>
          {(() => {
            const pending = (audit?.newInSearch.length || 0) + (audit?.changed?.length || 0) + (audit?.stale.length || 0);
            return (
              <button
                onClick={() => run(true)}
                disabled={loading || applying || !audit || pending === 0}
                title={audit && pending === 0 ? 'In sync — nothing to apply' : 'Sync: import new, update changed, remove stale parsers'}
              >
                {applying ? 'Syncing…' : `Sync (${audit?.newInSearch.length || 0} new · ${audit?.changed?.length || 0} changed · ${audit?.stale.length || 0} stale)`}
              </button>
            );
          })()}
        </div>
        </div>
      </div>
    </div>
  );
}

// Distinct, accessible highlight colors assigned to extracted fields in order.
const JOURNEY_COLORS = ['#0958d9', '#722ed1', '#d46b08', '#389e0d', '#c41d7f', '#1d39c4', '#d48806', '#08979c', '#7cb305', '#597ef7', '#eb2f96', '#0891b2'];

// Best-effort: locate each extracted value inside the raw line and split it into
// colored segments. Verbatim values (src_ip, uri, status) light up; derived or
// reshaped values (an epoch _time) simply won't match and stay un-highlighted.
function journeyRawSegments(raw: string, fields: { name: string; value: string; color: string }[]): { text: string; color?: string; name?: string }[] {
  const matches: { start: number; end: number; color: string; name: string }[] = [];
  // Longer values first so a short token can't claim a slot inside a long one.
  for (const f of [...fields].sort((a, b) => b.value.length - a.value.length)) {
    if (f.value.length < 2) continue;
    const idx = raw.indexOf(f.value);
    if (idx >= 0) matches.push({ start: idx, end: idx + f.value.length, color: f.color, name: f.name });
  }
  matches.sort((a, b) => a.start - b.start);
  const segs: { text: string; color?: string; name?: string }[] = [];
  let pos = 0;
  for (const m of matches) {
    if (m.start < pos) continue; // overlap — keep the earlier/longer claim
    if (m.start > pos) segs.push({ text: raw.slice(pos, m.start) });
    segs.push({ text: raw.slice(m.start, m.end), color: m.color, name: m.name });
    pos = m.end;
  }
  if (pos < raw.length) segs.push({ text: raw.slice(pos) });
  return segs;
}

// The optional "Event journey" visualization: renders one sample event's path
// through extraction → mapping → output shaping, reading only the debug data the
// scoring cards already carry. Pure presentation; no new scoring.
// @deprecated (build 687) — the experiment-done screen now shows the unified
// <ScoringReport> automatically (which absorbs this journey's vertical stage
// flow + live pipeline profile), so nothing opens this modal any more. Its
// render remains wired but is unreachable; retained for a follow-up cleanup.
interface JourneyProfileArgs { workerGroup: string; packId: string; pipelineId: string; sampleName: string; }
function JourneyModal({ format, stages, profileArgs, onClose }: { format: string; stages: ExpStageResult[]; profileArgs?: JourneyProfileArgs; onClose: () => void }) {
  const [linked, setLinked] = useState(true);
  const [hl, setHl] = useState<string | null>(null);
  // Real Cribl Pipeline Profile — fetched lazily against the live deployed
  // pipeline (the "Pipeline Profile" tab in Cribl's preview diagnostics). null
  // while loading / unavailable; the section degrades to derived sample stats.
  const [profile, setProfile] = useState<CriblPipelineProfile | null>(null);
  const [profileState, setProfileState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  useEffect(() => {
    if (!profileArgs?.pipelineId) return;
    let live = true;
    setProfileState('loading');
    previewPipelineProfile(profileArgs)
      .then(p => { if (!live) return; setProfile(p); setProfileState(p ? 'done' : 'error'); })
      .catch(() => { if (live) setProfileState('error'); });
    return () => { live = false; };
    // Depend on the primitive identifiers, not the profileArgs object (a fresh
    // object every render would re-fire the fetch on each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileArgs?.workerGroup, profileArgs?.packId, profileArgs?.pipelineId, profileArgs?.sampleName]);
  const ext = stages.find(s => s.stage === 'extraction');
  const map = stages.find(s => s.stage === 'mapping');
  const opt = stages.find(s => s.stage === 'optimization');

  const rawLine = ext?.debug?.sampleRaw || '';
  const fieldEntries = Object.entries(ext?.debug?.extractedFields || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([name, v], i) => ({ name, value: typeof v === 'string' ? v : JSON.stringify(v), color: JOURNEY_COLORS[i % JOURNEY_COLORS.length] }));
  const colorOf = (name: string) => fieldEntries.find(f => f.name === name)?.color;
  const segs = rawLine ? journeyRawSegments(rawLine, fieldEntries) : [];
  // Golden/schematizer mappings carry an empty `from` — the real source field is
  // buried in the coalescing expr (e.g. "src_ip || srcaddr || srcip"). Recover it
  // for display: prefer whichever candidate actually produced a value, else the
  // primary (first) candidate the expression falls back through.
  const extractedNames = fieldEntries.map(f => f.name);
  const EXPR_STOPWORDS = new Set(['null', 'true', 'false', 'undefined', 'Number', 'String', 'Boolean', 'Date', 'Math', 'JSON', 'parseInt', 'parseFloat', 'parse', 'toString', 'now', 'length']);
  const resolveFrom = (m: { from: string; to: string; expr: string }): string => {
    if (m.from) return m.from;
    const idents = (m.expr || '').match(/[A-Za-z_$][\w$]*/g) || [];
    const cands = idents.filter(t => !EXPR_STOPWORDS.has(t));
    return cands.find(c => extractedNames.includes(c)) || cands[0] || '';
  };
  const mappings = map?.debug?.mappings || [];
  const opts = opt?.debug?.appliedOptimizations || [];
  const beforeEv = map?.debug?.outputEvent;
  const afterEv = opt?.debug?.outputEvent;
  const overall = [ext?.score, map?.score].filter((n): n is number => typeof n === 'number');
  const overallScore = overall.length ? Math.round(overall.reduce((a, b) => a + b, 0) / overall.length) : null;
  const bandOf = (b?: string) => b || 'na';
  const fmtEv = (e: any) => e == null ? '—' : (typeof e === 'string' ? e : JSON.stringify(e, null, 2));
  const enter = (name?: string) => { if (linked && name) setHl(name); };
  const leave = () => setHl(null);

  // ---- Pipeline statistics (size / _raw / per-step duration) ----------------
  const statOf = (s?: ExpStageResult) => s?.debug?.stats;
  const finalStats = statOf(opt) || statOf(map) || statOf(ext);   // last stage that actually ran
  const bytesIn = statOf(ext)?.bytesIn;
  const bytesOut = finalStats?.bytesOut;
  const rawIn = statOf(ext)?.rawBytesIn;
  const rawOut = finalStats?.rawBytesOut;
  const evCount = statOf(ext)?.events;
  const fmtBytes = (n?: number) => n == null ? '—' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
  const deltaPct = (from?: number, to?: number) => (from == null || to == null || from === 0) ? null : Math.round((1 - to / from) * 100);
  const sizePct = deltaPct(bytesIn, bytesOut);
  const rawPct = deltaPct(rawIn, rawOut);
  const hasStats = bytesIn != null || finalStats != null;
  const Delta = ({ p }: { p: number | null }) => p == null ? null : <span className={`journey-delta ${p >= 0 ? 'down' : 'up'}`}>{p >= 0 ? `−${p}%` : `+${-p}%`}</span>;
  // Cribl pipeline profile — real per-function process time (ms) as shown in the
  // Cribl UI. `duration` is the Summary Total; per-function % is of that total.
  const fns = profile?.functions || [];
  const profTotal = profile?.duration;
  const profBytesIn = fns[0]?.bytesIn;
  const profBytesOut = fns.length ? fns[fns.length - 1].bytesOut : undefined;
  const profEventsIn = fns[0]?.eventsIn;
  const profEventsOut = fns.length ? fns[fns.length - 1].eventsOut : undefined;
  const fmtProfMs = (n?: number) => n == null ? '—' : n < 1 ? `${n.toFixed(3)} ms` : `${n.toFixed(2)} ms`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel journey-panel" onClick={e => e.stopPropagation()}>
        <div className="journey-banner">
          <div>
            <h3>Event journey</h3>
            <p>{format.toUpperCase()} · how one event is transformed, stage by stage</p>
          </div>
          <label className="journey-switch"><input type="checkbox" checked={linked} onChange={e => setLinked(e.target.checked)} /> Linked highlight</label>
          {overallScore != null && <div className="journey-overall"><div className="n">{overallScore}</div><div className="l">Overall</div></div>}
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="journey-body">

          {/* STAGE 0 — RAW */}
          <section className="journey-stage band-na">
            <div className="journey-shead"><span className="journey-step">0</span><strong>Raw event</strong><span className="journey-sub">one sample line, as ingested</span><span className="spacer" /><span className="journey-pill na">INPUT</span></div>
            <div className="journey-sbody">
              <div className="journey-raw">
                {segs.length ? segs.map((s, i) => s.color
                  ? <span key={i} className={`journey-tok${hl === s.name ? ' hl' : ''}`} style={{ background: s.color + '33', color: '#fff', boxShadow: hl === s.name ? `0 0 0 2px #0f1021, 0 0 0 4px ${s.color}` : undefined }} onMouseEnter={() => enter(s.name)} onMouseLeave={leave}>{s.text}</span>
                  : <span key={i}>{s.text}</span>)
                  : <span className="journey-dim">No sample event captured for this build.</span>}
              </div>
            </div>
          </section>
          <div className="journey-flow">↓</div>

          {/* STAGE 1 — EXTRACTION */}
          <section className={`journey-stage band-${bandOf(ext?.band)}`}>
            <div className="journey-shead"><span className="journey-step">1</span><strong>Extraction</strong><span className="journey-sub">each part of the line pulled into a named field</span><span className="spacer" /><span className={`journey-pill ${bandOf(ext?.band)}`}>{ext?.score ?? 'N/A'}</span></div>
            <div className="journey-sbody">
              {ext?.reasons?.[0] && <p className="journey-reason">{ext.reasons[0]}</p>}
              <div className="journey-chips">
                {fieldEntries.length ? fieldEntries.map(f => (
                  <span key={f.name} className={`journey-chip${hl === f.name ? ' hl' : ''}`} style={{ borderColor: f.color + '55', background: f.color + '12', color: f.color }} onMouseEnter={() => enter(f.name)} onMouseLeave={leave}>
                    <span className="k">{f.name}</span><span className="v">{f.value.length > 40 ? f.value.slice(0, 40) + '…' : f.value}</span>
                  </span>
                )) : <span className="journey-dim">No extracted fields recorded.</span>}
              </div>
            </div>
          </section>
          <div className="journey-flow">↓</div>

          {/* STAGE 2 — MAPPING */}
          <section className={`journey-stage band-${bandOf(map?.band)}`}>
            <div className="journey-shead"><span className="journey-step">2</span><strong>Mapping / remap</strong><span className="journey-sub">canonical fields → {format.toUpperCase()} schema</span><span className="spacer" /><span className={`journey-pill ${bandOf(map?.band)}`}>{map?.score ?? 'N/A'}</span></div>
            <div className="journey-sbody">
              {map?.reasons?.[0] && <p className="journey-reason">{map.reasons[0]}</p>}
              {mappings.length ? mappings.map((m, i) => {
                const from = resolveFrom(m);
                const showExpr = m.expr && m.expr !== from && m.expr !== m.to;
                return (
                  <div key={i} className={`journey-maprow${hl === from ? ' hl' : ''}`} onMouseEnter={() => enter(from)} onMouseLeave={leave}>
                    <span className="journey-chip" style={{ borderColor: (colorOf(from) || '#98a2b3') + '55', background: (colorOf(from) || '#98a2b3') + '12', color: colorOf(from) || '#667085' }}><span className="k">{from || '—'}</span></span>
                    <span className="journey-arrow">→</span>
                    <span className="journey-to"><span className="col">{m.to}</span>{showExpr && <span className="expr" title={m.expr}>{m.expr}</span>}</span>
                  </div>
                );
              }) : <span className="journey-dim">No field mappings recorded (e.g. JSON passthrough).</span>}
              {(map?.debug?.unmappedFields?.length ?? 0) > 0 && (
                <div className="journey-note">Kept, not dropped: <b>{map!.debug!.unmappedFields!.join(', ')}</b> ride along inside <code>_raw</code>.</div>
              )}
            </div>
          </section>
          <div className="journey-flow">↓</div>

          {/* STAGE 3 — OUTPUT SHAPING */}
          <section className={`journey-stage band-${bandOf(opt?.band)}`}>
            <div className="journey-shead"><span className="journey-step">3</span><strong>Output shaping</strong><span className="journey-sub">apply the destination envelope and cleanup</span><span className="spacer" /><span className={`journey-pill ${bandOf(opt?.band)}`}>{opt?.score ?? 'N/A'}</span></div>
            <div className="journey-sbody">
              {(beforeEv != null || afterEv != null) && (
                <div className="journey-ba">
                  <div className="journey-ev"><span className="tag">before</span>{fmtEv(beforeEv)}</div>
                  <div className="mid">→</div>
                  <div className="journey-ev"><span className="tag">after</span>{fmtEv(afterEv)}</div>
                </div>
              )}
              <div className="journey-optlist">
                {opts.length ? opts.map((o, i) => (
                  <div key={i} className="journey-opt"><span className="dot" /><span className="txt"><b>{o.label}</b> — {o.description}</span>{o.reduction ? <span className="red">~{o.reduction}%</span> : null}</div>
                )) : <div className="journey-dim">Destination-required shaping only; no raw-field reduction rules.</div>}
              </div>
            </div>
          </section>

          {/* PIPELINE STATISTICS — real Cribl pipeline profile + sample sizes */}
          {(hasStats || profileArgs) && (
            <section className="journey-stage journey-stats band-na">
              <div className="journey-shead"><span className="journey-step">Σ</span><strong>Pipeline statistics</strong><span className="journey-sub">live Cribl pipeline profile</span></div>
              <div className="journey-sbody">
                <div className="journey-stat-grid">
                  {profile ? (
                    <>
                      <div className="journey-stat"><span className="l">Pipeline process time</span><span className="v journey-strong">{fmtProfMs(profTotal)}</span></div>
                      <div className="journey-stat"><span className="l">Throughput (bytes)</span><span className="v">{fmtBytes(profBytesIn)} → {fmtBytes(profBytesOut)} <Delta p={deltaPct(profBytesIn, profBytesOut)} /></span></div>
                      <div className="journey-stat"><span className="l">Events in → out</span><span className="v">{profEventsIn ?? '—'} → {profEventsOut ?? '—'}</span></div>
                      {profile.cpu && <div className="journey-stat"><span className="l">CPU (user / system)</span><span className="v">{fmtProfMs(profile.cpu.user)} / {fmtProfMs(profile.cpu.system)}</span></div>}
                    </>
                  ) : (
                    <div className="journey-stat"><span className="l">Pipeline process time</span><span className="v journey-dim">{profileState === 'loading' ? 'measuring in Cribl…' : profileState === 'error' ? 'unavailable' : '—'}</span></div>
                  )}
                </div>

                {profile && fns.length > 0 && (
                  <table className="journey-steptime">
                    <thead><tr><th>Function</th><th>Events in → out</th><th>Bytes in → out</th><th>Process time</th><th>%</th></tr></thead>
                    <tbody>
                      {fns.map((f, i) => {
                        const pct = profTotal ? Math.round((f.duration / profTotal) * 100) : null;
                        return (
                          <tr key={i}>
                            <td><code>{f.func}</code></td>
                            <td>{f.eventsIn} → {f.eventsOut}</td>
                            <td>{fmtBytes(f.bytesIn)} → {fmtBytes(f.bytesOut)}</td>
                            <td>{fmtProfMs(f.duration)}</td>
                            <td>{pct == null ? '—' : `${pct}%`}</td>
                          </tr>
                        );
                      })}
                      <tr className="journey-steptime-total">
                        <td><strong>Summary total</strong></td>
                        <td>{profEventsIn ?? '—'} → {profEventsOut ?? '—'}</td>
                        <td>{fmtBytes(profBytesIn)} → {fmtBytes(profBytesOut)}</td>
                        <td><strong>{fmtProfMs(profTotal)}</strong></td>
                        <td>100%</td>
                      </tr>
                    </tbody>
                  </table>
                )}

                {hasStats && (
                  <div className="journey-stat-grid" style={{ marginTop: 12 }}>
                    <div className="journey-stat"><span className="l">Sample event size in → out</span><span className="v">{fmtBytes(bytesIn)} → {fmtBytes(bytesOut)} <Delta p={sizePct} /></span></div>
                    <div className="journey-stat"><span className="l">Sample _raw before → after</span><span className="v">{fmtBytes(rawIn)} → {fmtBytes(rawOut)} <Delta p={rawPct} /></span></div>
                    <div className="journey-stat"><span className="l">Sample events measured</span><span className="v">{evCount ?? '—'}</span></div>
                  </div>
                )}

                <p className="journey-statnote">
                  {profile
                    ? 'Per-function process time, bytes and events are the live Cribl Pipeline Profile — the same numbers as Cribl’s preview diagnostics “Pipeline Profile” tab (cpuProfile over the pack sample). Sample sizes below are the serialized preview events (up to 8).'
                    : profileState === 'error'
                      ? 'Live Cribl pipeline profile is unavailable (the deployed pipeline or its sample could not be profiled). Sample sizes below are the serialized preview events (up to 8).'
                      : 'Sizes are the serialized preview events (up to 8).'}
                </p>
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

function App() {
  const [step, setStep] = useState<Step>('mode');
  const [packMode, setPackMode] = useState<PackMode>('experiment');
  // Post-processing (OCSF → SIEM format) source/dest format selection. v1 offers
  // only ocsf → cef; the registry (postprocess-builder.ts) is keyed to extend.
  const [ppSourceFormat, setPpSourceFormat] = useState('ocsf');
  const [ppDestFormat, setPpDestFormat] = useState('cef');
  // Concrete sub-schema within the destination family (e.g. `cim#authentication`,
  // `asim#dns`, `chronicle#endpoint`). '' = the family's base/default schema.
  const [ppSchema, setPpSchema] = useState('');
  // "Build pack flow" destination-screen choices (flow-builder.ts). Per-card
  // Optimize: CIM → cim_keep_unmapped, and every mapped non-OCSF card → the
  // source's noise drops (srcopt_*); OCSF keep-raw → ocsf_keep_raw → raw_data.
  const [flowOptimize, setFlowOptimize] = useState<Record<string, boolean>>({});
  const [flowSrcRules, setFlowSrcRules] = useState<Record<string, boolean>>({});
  // OCSF "Keep original _raw" is on by default in Build pack flow.
  const [flowOcsfKeepRaw, setFlowOcsfKeepRaw] = useState(true);
  // Flow screen: the user chose to overwrite the existing pack of that name.
  const [flowOverwrite, setFlowOverwrite] = useState(false);
  // Same choice for the post-processing packs (ppPackCheck).
  const [flowPpOverwrite, setFlowPpOverwrite] = useState(false);
  // Build pack flow: the pack name follows "<source> to <destinations>" until the user types their own.
  const [flowNameEdited, setFlowNameEdited] = useState(false);
  const [flowPp, setFlowPp] = useState<FlowPpState>(EMPTY_FLOW_PP);
  const [flowPpResults, setFlowPpResults] = useState<{ label: string; packId: string; pipelineId: string; optimize: boolean; error?: string; destFormat?: string; stages?: ExpStageResult[] }[]>([]);
  const [state, setState] = useState<WizardState>(initialState);
  const [sourcetype, setSourcetype] = useState('');
  const [customSourcetype, setCustomSourcetype] = useState('');
  const [isCustomSourcetype, setIsCustomSourcetype] = useState(false);
  const [sourcetypeFilter, setSourcetypeFilter] = useState('');
  const [reductionToggles, setReductionToggles] = useState<Record<string, boolean>>({});
  const [allowCodeFunctions, setAllowCodeFunctions] = useState(false);
  const [createDatagen, setCreateDatagen] = useState(false);
  const [autoValidate, setAutoValidate] = useState(false);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const deployLogRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [sampleRepairNotice, setSampleRepairNotice] = useState('');
  const [aiAdvice, setAiAdvice] = useState<AiAdvice | null>(null);
  // Sample-aware schema advice (interactive wizard / add-pipeline): after the
  // sample exists, sniff the events themselves and — only when the sample's
  // inferred data class clearly disagrees with the chosen format's class —
  // surface a non-blocking "consider format X" card. null = no advice to show.
  const [sampleSchemaAdvice, setSampleSchemaAdvice] = useState<ReturnType<typeof recommendDestFormatsForSample> | null>(null);
  const [aiMappings, setAiMappings] = useState<AiMappingResult | null>(null);
  const [aiMappingsPerFormat, setAiMappingsPerFormat] = useState<Record<string, AiMappingResult | null>>({});
  const [aiParseFns, setAiParseFns] = useState<AiParseFunctions | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [validationHint, setValidationHint] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationSuggestions, setValidationSuggestions] = useState<string[]>([]);
  const [customConfirmed, setCustomConfirmed] = useState(false);
  // Sourcetype-search matches shown ONLY after a Confirm attempt that didn't
  // resolve to an exact/known source (not live-as-you-type). Clicking one fills
  // the textbox; the user presses Confirm again for the final check.
  const [stMatches, setStMatches] = useState<{ name: string; golden: boolean; description: string }[]>([]);
  // Recognition metadata captured at Confirm (vendor/product/log-family/format/
  // typical fields) — reused to GROUND sample generation so the AI matches the
  // real product instead of only seeing the bare sourcetype string.
  const [recognitionMeta, setRecognitionMeta] = useState<{ vendor?: string; product?: string; logFamily?: string; logFormat?: string; typicalFields?: string[] } | null>(null);
  // Multi-format confirmation: when the resolved source commonly emits more than
  // one wire format (Zscaler JSON/KV/CEF, Corelight JSON/TSV) and we don't have a
  // real reference sample, ask the user which format before generating so we
  // don't guess wrong. null = not a multi-format source (no picker shown).
  const [multiFormatSpec, setMultiFormatSpec] = useState<MultiFormatSpec | null>(null);
  const [confirmedFormat, setConfirmedFormat] = useState<string>('');
  const [workerGroups, setWorkerGroups] = useState<WorkerGroup[]>([]);
  const [existingPacks, setExistingPacks] = useState<ExistingPack[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [selectedPackId, setSelectedPackId] = useState('');
  const [addImproveAction, setAddImproveAction] = useState<'add' | 'optimize' | null>(null);
  const [optimizePipelineId, setOptimizePipelineId] = useState('');
  const [optimizeGoals, setOptimizeGoals] = useState({
    sample: false,
    extraction: false,
    mapping: false,
    optimization: false,
  });
  const [optimizeGuidance, setOptimizeGuidance] = useState('');
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  const [optimizeError, setOptimizeError] = useState('');
  const [optimizeLog, setOptimizeLog] = useState<string[]>([]);
  const [optimizeResults, setOptimizeResults] = useState<OptimizeStageResult[]>([]);
  const [optimizeScores, setOptimizeScores] = useState<{
    before: number | null;
    after: number | null;
    changed: boolean;
    beforeDetail?: { totalValues: number; coveredValues: number; lostValues: string[]; gaps?: CoverageGapDetail };
    afterDetail?: { totalValues: number; coveredValues: number; lostValues: string[]; gaps?: CoverageGapDetail };
    sampleRaw?: string;
    beforeOutput?: Record<string, any> | null;
    afterOutput?: Record<string, any> | null;
    beforeStages?: {
      extraction: { score: number | null; band: string; reason: string; output?: Record<string, any> | null; events?: any[] };
      mapping: { score: number | null; band: string; reason: string; output?: Record<string, any> | null; events?: any[] };
    };
    afterStages?: {
      extraction: { score: number | null; band: string; reason: string; output?: Record<string, any> | null; events?: any[] };
      mapping: { score: number | null; band: string; reason: string; output?: Record<string, any> | null; events?: any[] };
    };
  } | null>(null);
  const [optimizePhase, setOptimizePhase] = useState<'idle' | 'scoring' | 'optimizing'>('idle');
  // Ask once whether the separate Pipeline Visualizer app is installed, so the
  // static batch reports (which cannot probe) know whether to bake its links in.
  useEffect(() => { void probePipelineVisualizer(); }, []);
  const [optimizeStatus, setOptimizeStatus] = useState('');
  const [packPipelines, setPackPipelines] = useState<{ id: string; description?: string }[]>([]);
  const [packPipelinesLoading, setPackPipelinesLoading] = useState(false);
  const [packPipelinesError, setPackPipelinesError] = useState('');
  const [packsLoading, setPacksLoading] = useState(false);
  const [groupsError, setGroupsError] = useState('');
  const [packsError, setPacksError] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [packFilter, setPackFilter] = useState('');
  // AI sample generation offers ONE tier — a focused, high-fidelity ("quality
  // over quantity") set grounded on the real vendor format. The old fast/balanced/
  // thorough tiers only changed event COUNT (100/250/500), not quality (the prompt
  // was identical), so they're collapsed to a single light request capped at 2 MB.
  const sampleCount = 100;
  const generateMode = 'fast';
  const [sampleSourceId, setSampleSourceId] = useState<string>('');
  const [captureFilter, setCaptureFilter] = useState('');
  const [captureMaxEvents, setCaptureMaxEvents] = useState(100);
  const [captureDuration, setCaptureDuration] = useState(10);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [existingSamples, setExistingSamples] = useState<{ id: string; name: string; size: number; numEvents: number; packId?: string; packName?: string }[]>([]);
  const [sampleSearchFilter, setSampleSearchFilter] = useState('');
  // Wire format of each worker-group sample, sniffed in the background so the list
  // can SHOW it. Picking a sample is picking a format — the pack is built around
  // whatever shape the sample has — so a Zscaler CEF sample and a Zscaler key=value
  // sample produce completely different pipelines. `'busy'` = being fetched,
  // `'unknown'` = too large to sniff or the download failed.
  const [sampleFormats, setSampleFormats] = useState<Record<string, SampleFormatDescription | 'busy' | 'unknown'>>({});
  const sampleFormatAttempted = useRef<Set<string>>(new Set());
  const [existingSampleLabel, setExistingSampleLabel] = useState('');
  // Local pseudonymisation of the sample. Sanitising runs in the SanitizeWizard modal
  // (the same flow as the Sample Library); this screen only opens it and receives the
  // result. `sanitisePrev` backs the single-level undo and is never persisted — the
  // un-sanitised original must not outlive the tab.
  const [sanitiseModalOpen, setSanitiseModalOpen] = useState(false);
  const [sanitisePrev, setSanitisePrev] = useState<string | null>(null);
  // Non-blocking advisory from the sanitise wizard (apply mode is advisory, not the strict
  // library gate): e.g. the sanitised events no longer parse cleanly against the source's
  // declared wire format. Shown under the "sanitised" banner; cleared on undo / mode change.
  const [sanitiseWarning, setSanitiseWarning] = useState<string | null>(null);
  const [samplesListLoading, setSamplesListLoading] = useState(false);
  const [detectedSourcetype, setDetectedSourcetype] = useState('');
  const sourcetypeSelectionOrigin = useRef<'none' | 'auto' | 'user'>('none');
  const [detectConfidence, setDetectConfidence] = useState('');
  const [detectReason, setDetectReason] = useState('');
  const [detecting, setDetecting] = useState(false);
  // Settings and Samples are pages over the wizard, not pop-ups: the wizard stays
  // mounted (hidden) underneath, so a run and its choices survive a visit.
  const [toolPage, setToolPage] = useState<ToolPage | null>(null);
  // The rail's Documentation entry is a disclosure: User guide / Technical reference.
  const [docsOpen, setDocsOpen] = useState(false);
  // Bumped on an AI settings save: the header's AI probe re-runs on it.
  const [aiSettingsRev, setAiSettingsRev] = useState(0);
  const [sampleLibSummary, setSampleLibSummary] = useState<{ staged: number; probes: number; library: number; rejected: number; shadowed: number } | null>(null);
  const [aiStatus, setAiStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  const [aiStatusMsg, setAiStatusMsg] = useState('');
  const [lakeExportActive, setLakeExportActive] = useState<boolean | null>(null);
  const [lakeExportMsg, setLakeExportMsg] = useState('');
  // Session-scoped score-logging tally. Surfaced in the settings status area so a
  // run can never again silently drop every completion event (empty dataset) with
  // no signal — the batch review found the dataset empty only by going to look.
  const [scoreLogTally, setScoreLogTally] = useState<{ logged: number; dropped: number; lastReason: string }>({ logged: 0, dropped: 0, lastReason: '' });
  const [qForm, setQForm] = useState<QualitySettings>(() => loadQualitySettings());
  const [qSaveMsg, setQSaveMsg] = useState('');
  const [lakeTestMsg, setLakeTestMsg] = useState('');
  const [ghTestMsg, setGhTestMsg] = useState('');
  const [sampleGhTestMsg, setSampleGhTestMsg] = useState('');
  // Cribl Cloud connection (standalone .env creds, editable in Settings).
  const [credForm, setCredForm] = useState({ org: '', clientId: '', clientSecret: '', userEmail: '' });
  const [credHasSecret, setCredHasSecret] = useState(false);
  const [credTestMsg, setCredTestMsg] = useState('');
  const [credBusy, setCredBusy] = useState(false);
  const [availableGoldens, setAvailableGoldens] = useState<AvailableGolden[]>([]);
  const [goldenImporting, setGoldenImporting] = useState(false);
  const [goldenImportMsg, setGoldenImportMsg] = useState<null | { tone: 'ok' | 'warn' | 'error'; text: string }>(null);
  // Local goldens that are new to / beat the shared pool (reverse of import).
  const [pushableGoldens, setPushableGoldens] = useState<PushableGolden[]>([]);
  const [goldenPushing, setGoldenPushing] = useState(false);
  const [goldenPushResult, setGoldenPushResult] = useState<string>('');
  const [batchRows, setBatchRows] = useState<BatchRow[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  // Latest build trace per batch row index — the staged builder publishes one
  // after every stage. In memory only: never in the resume checkpoint.
  const [batchTraces, setBatchTraces] = useState<Record<number, BuildTrace>>({});
  // Full build detail per row built in THIS tab, for the whole-run scoring
  // report. Kept out of BatchResult on purpose: results are checkpointed to App
  // KV under a ~100 KB cap, and stages carry sample and output events.
  const batchReportStages = useRef<Record<number, { stages: ExpStageResult[]; destFormat: string }>>({});
  const setBatchTrace = (i: number, trace: BuildTrace | null) => setBatchTraces(prev => {
    const next = { ...prev };
    if (trace) next[i] = trace; else delete next[i];
    return next;
  });
  const [batchError, setBatchError] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchConflicts, setBatchConflicts] = useState<string[]>([]);
  const [batchEditingRow, setBatchEditingRow] = useState<number | null>(null);
  // Batch redesign (batch-redesign.css): file name on the File screen, the
  // Check screen's pinned-panel row and tile filter, the Results filter,
  // report drawer row and Export menu.
  const [batchFileName, setBatchFileName] = useState('');
  const [checkSel, setCheckSel] = useState<number | null>(null);
  // Set by a row's ✎ button: the side panel opens on that row with the name field focused.
  const [checkEditFocus, setCheckEditFocus] = useState<number | null>(null);
  const [checkWeakerOpen, setCheckWeakerOpen] = useState(false);
  // Busy bar's elapsed clock and the "Check finished" notice that follows it.
  const [checkBusySince, setCheckBusySince] = useState<number | null>(null);
  const [checkDoneNotice, setCheckDoneNotice] = useState(false);
  const [checkTile, setCheckTile] = useState<'all' | 'ok' | 'warn' | 'err' | 'ai'>('all');
  const [resultsFilter, setResultsFilter] = useState<'all' | 'improve' | 'failed'>('all');
  const [resultsSel, setResultsSel] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Wall-clock of the in-tab run, for "took X" on Results.
  const [batchRunSpan, setBatchRunSpan] = useState<{ start: number; end?: number } | null>(null);
  const [batchSkipPacks, setBatchSkipPacks] = useState<Set<string>>(new Set());
  const [batchConflictActions, setBatchConflictActions] = useState<Map<string, ConflictAction>>(new Map());
  const [batchConflictScores, setBatchConflictScores] = useState<Map<string, ConflictPipe[]>>(new Map());
  // Rows whose pack_name values differ only by case/punctuation and therefore
  // share ONE kebab-cased pack id — they will be merged into a single pack.
  const [batchPackIdCollisions, setBatchPackIdCollisions] = useState<{ packId: string; names: string[] }[]>([]);
  const [batchConfirmReady, setBatchConfirmReady] = useState(false);
  // Which batch row's score report is open (index), null = closed.
  const [batchScoreOpen, setBatchScoreOpen] = useState<number | null>(null);
  // Rows currently running an action (improve/rerun/show). A Set so up to
  // MAX_ROW_ACTIONS run concurrently without blocking the whole list.
  const [batchRowBusy, setBatchRowBusy] = useState<Set<number>>(new Set());
  // Cribl AI serves one call at a time (src/ai-client.ts), so on Cribl AI every
  // AI-driven pool — row actions, batch rows, pre-flight model work — runs 1 wide.
  const MAX_ROW_ACTIONS = aiParallelism(4);
  const batchConcurrency = aiParallelism(BATCH_FOREGROUND_CONCURRENCY);
  // Ref-based stop signal (mirrors preflightAbort): stops new rows from
  // starting, does not cancel a call already in flight. Reset at the top of
  // every run so a previous run's stop can't leak into a new one.
  const batchStopRequested = useRef(false);
  // Kill (src/batch-kill.ts): bumped by Kill so a run abandoned mid-request can
  // never write to the screen — or reach the group commit — when it wakes up.
  const batchRunGen = useRef(0);
  // Two-press confirm for Kill (the sandboxed iframe has no window.confirm):
  // 'fg' / 'bg' = armed for that run mode, null = not armed.
  const [killArmed, setKillArmed] = useState<'fg' | 'bg' | null>(null);
  const [batchBgKilling, setBatchBgKilling] = useState(false);
  const [batchStopping, setBatchStopping] = useState(false);
  // A checkpoint found on mount from a run that never reached 'done' (tab
  // closed/reloaded mid-batch) — offered back as Resume/Discard.
  const [batchResumeCheckpoint, setBatchResumeCheckpoint] = useState<BatchCheckpoint | null>(null);
  // Set by handleResumeBatch; consumed by an effect once the state restore
  // (batchRows/batchConflictActions/batchSkipPacks) it depends on has committed —
  // handleBatchDeploy reads those via closure, so it must run AFTER that render.
  const [pendingResumeRun, setPendingResumeRun] = useState<{ workerGroup: string; results: BatchResult[] } | null>(null);

  // --- "Batch — Background" (build 715): same packMode==='batch', same CSV
  // upload/pre-flight/conflict screens — this flag only forks the flow at the
  // point where the foreground engine would call handleBatchDeploy. See the
  // parked plan for why: a genuinely different execution model (server-side,
  // no browser tab needed) with its own platform-maturity risk, kept fully
  // separable from the proven foreground engine. iframe-only — Backend
  // Functions don't exist in the local standalone dev server.
  const [batchBackground, setBatchBackground] = useState(false);
  // Ready-to-start: the to-generate sample list is collapsed until asked for.
  const [batchSamplesExpanded, setBatchSamplesExpanded] = useState(false);
  const [batchBgCheckpoint, setBatchBgCheckpoint] = useState<BackgroundBatchCheckpoint | null>(null);
  // Start failures ONLY. Every one of them happens before the progress screen
  // exists, so this renders beside the Start button — which is also why a poll
  // or a dismiss must not borrow it: "Could not start the background run" is
  // the wrong sentence for a run that started an hour ago.
  const [batchBgError, setBatchBgError] = useState('');
  // What the last read of the durable manifest found. `missing` is its own
  // state: a run whose document is gone is neither working nor finished.
  const [batchBgRead, setBatchBgRead] = useState<BackgroundReadState>(BACKGROUND_READ_OK);
  // A dismiss whose durable cleanup did not complete — the run is still there,
  // so the screen stays and says so.
  const [batchBgNotice, setBatchBgNotice] = useState('');
  const [batchBgStopping, setBatchBgStopping] = useState(false);
  const [batchBgDismissing, setBatchBgDismissing] = useState(false);
  // Building the whole-run scoring report reads one artifact per row, so it is
  // async and gets its own busy flag + error rather than blocking the screen.
  const [batchReportBusy, setBatchReportBusy] = useState(false);
  const [batchReportError, setBatchReportError] = useState('');
  // The mount read happens once. Without a retry, one unlucky read left the
  // banner saying "could not check" until the operator reloaded the app.
  const [batchBgRetrying, setBatchBgRetrying] = useState(false);
  // Start writes a run, N artifacts, a schedule and a kickoff. A second click
  // during that transaction starts a SECOND run against the same packs.
  const [batchBgStarting, setBatchBgStarting] = useState(false);
  // Progress of the sample generation Start runs before the handoff.
  const [batchBgPrep, setBatchBgPrep] = useState('');
  // What the poll loop last saw, so it can reconcile a failed read against it
  // without closing over the state (which would restart the interval on every
  // tick that reports progress).
  const batchBgLatest = useRef<BackgroundBatchCheckpoint | null>(null);
  // The row whose scorecard is expanded, and its fetched detail. The scorecard
  // is the row's UNBOUNDED artifact (findings, per-stage reasons), kept out of
  // the polled manifest and read only on demand — one open row at a time.
  const [bgScorecardRowId, setBgScorecardRowId] = useState<string | null>(null);
  const [bgScorecard, setBgScorecard] =
    useState<{ loading: boolean; error: string; card: BackgroundRowScorecard | null }>(
      { loading: false, error: '', card: null });
  // Fences a stale fetch: opening row B while A is in flight must not let A's
  // late answer paint into B's card.
  const bgScorecardReq = useRef(0);

  // --- Batch pre-flight state ---
  type PreflightPhase = 'sourcetype' | 'samples' | 'done';
  interface PreflightSourcetypeRow {
    index: number;
    original: string;
    canonical: string;
    status: 'green' | 'yellow' | 'red';
    suggestion?: string;
    override?: string;
    accepted: boolean;
    // Recognition (build 397): how we identified the source, and whether it's
    // safe to build. 'recognized' = deterministic parser/golden/data-class match;
    // 'ai-classified' = AI confirmed a real source (buildable via AI at build);
    // 'unknown' = unrecognizable → BLOCKS the build until resolved/removed.
    recognized: 'recognized' | 'ai-classified' | 'unknown';
    tier: 'exact' | 'alias' | 'fuzzy' | 'hint' | 'ai-name' | 'ai-content' | 'none';
    confidence: 'high' | 'medium' | 'low' | 'none';
    reason?: string;       // why unknown / AI clarification
    // Recognition metadata (spec Phases 3-4): what the source IS, independent of
    // whether we have a golden path. Populated by the recognizer's metadata/hint
    // tiers and surfaced in the UI so we never show "Unknown" for an identifiable
    // vendor/product/log-family.
    recStatus?: 'exact' | 'alias' | 'catalogue_gap' | 'needs_confirmation' | 'unresolved';
    vendor?: string;
    product?: string;
    logFamily?: string;
    description?: string;
    // Enriched validation bundle (build 412): when a source isn't in the catalog
    // we validate it with the AI model (its own training knowledge, no web access)
    // and collect a description + log-format hint at the SAME time. Reused later to
    // ground AI sample-generation / parsing so we don't ask the model twice.
    logFormat?: string;      // e.g. "syslog RFC5424", "key=value", "JSON", "CEF"
    typicalFields?: string[];
    evidence?: string;     // why we recognized it (pack/pipeline agreement, hint…)
    canonicalDisplay?: string; // colon-form spelling preserved for display
    autoApplied?: boolean; // canonical was auto-corrected from a high-confidence match
    // needsConfirm: a recommendation was INFERRED (medium fuzzy / AI suggestion)
    // and pre-filled into the Recognition column as an editable red field. The row
    // is NOT blocking (the guess resolves to a supported name) but is visually
    // flagged so the user can confirm-by-doing-nothing or edit. Distinct from
    // 'unknown' (no supported match → blocks the build).
    needsConfirm?: boolean;
    // notSecurity: the name is Splunk/OS internal data (stash, ps, splunkd), not a
    // log source. The row is unknown and is never sent to the AI to be "confirmed".
    notSecurity?: string;
    // aiChecking: the AI escalation is CURRENTLY working on this row. Until it
    // answers, the row is neither recognized nor a settled failure — rendering it
    // as red/✕ (its deterministic state) made a whole screen look broken while
    // the check was still in flight, so it renders as "checking…" instead.
    aiChecking?: boolean;
    // Live text in the Recognition-column editable field (needsConfirm/unknown
    // rows). Pre-filled with the recommended name; recognized live as the user
    // types (like the generate-pack sourcetype entry). undefined = not editing.
    input?: string;
    // Schema advice, embedded in the sourcetype check (build 410): for
    // schema-format destinations (cim/sentinel/ocsf/asim) the recommended
    // model/table is DERIVED from the resolved sourcetype and shown inline on
    // this row. Recomputed whenever the sourcetype changes ("when changed,
    // re-advise"). schemaModel = recommendation; schemaOverride = user pick.
    destFormat?: string;
    schemaModel?: string;
    schemaOverride?: string;
    schemaDataClass?: string;
    schemaAlts?: string[];
    // The row's picked sample (BatchRow.sample), carried so the sample
    // key (preflightSampleKeyOf) and the offline reading of it survive renames.
    rowSample?: string;
  }
  interface PreflightSampleRow {
    sourcetype: string;
    status: 'pending' | 'loading' | 'found' | 'generated' | 'failed' | 'skipped';
    eventCount: number;
    source: 'reference' | 'ai' | 'uploaded' | 'bundled' | '';
    /** Why a row has no sample — shown in the table, so "skipped" is never mute. */
    reason?: string;
    /**
     * Real, but below SAMPLE_EXTEND_FLOOR — enough to look fine and not enough to
     * measure. Set by the store sweep, cleared when extension succeeds; a row still
     * carrying it at the end was deferred to build time or could not be extended.
     */
    thin?: boolean;
  }
  const [preflightPhase, setPreflightPhase] = useState<PreflightPhase>('sourcetype');
  const [preflightSourcetypes, setPreflightSourcetypes] = useState<PreflightSourcetypeRow[]>([]);
  // One gate row per batch row, same index. A row is not validated until the
  // user confirms a sourcetype; a sample row confirms only after sanitise-or-keep.
  // Download and both Next buttons stay disabled until every row is confirmed.
  const [preflightGate, setPreflightGate] = useState<BatchGateRow[]>([]);
  // Base sourcetypes that already have a stored golden (the name list, not the
  // pipeline bodies). Passed into every suggestion list.
  const preflightGoldenNames = useRef<string[]>([]);
  // Row currently open in the sample picker (the shared sanitizer's pick mode).
  const [batchPickIndex, setBatchPickIndex] = useState<number | null>(null);
  // Rows whose samples would overwrite each other's pack sample (checked on Next).
  const [preflightSampleConflicts, setPreflightSampleConflicts] = useState<string[]>([]);
  // Rows whose Detect has fallen through to the model and is still in flight.
  const [preflightGateDetecting, setPreflightGateDetecting] = useState<Set<number>>(new Set());
  const [preflightSamples, setPreflightSamples] = useState<PreflightSampleRow[]>([]);
  const [preflightRunning, setPreflightRunning] = useState(false);
  // What the pre-flight is busy with RIGHT NOW, so the screen can say so. The long
  // wait is the AI escalation (seconds per unrecognized name) and sample
  // resolution; the only spinner used to sit UNDER a 500-row table, off-screen, so
  // the screen read as frozen while work was in flight. `total: 0` = indeterminate.
  const [preflightProgress, setPreflightProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  // Which slice of the pre-flight table is on screen. EVERY counter in the summary
  // line is a filter: clicking "12 to confirm" or "3 without a sample" shows only
  // those rows (and only those), the same affordance the red "Check unknown
  // records" button already gave the blocking rows — which is now just the
  // 'unknown' value of this one state. `null` = show every row.
  // The predicates live in src/preflight-filter.ts and are used to COUNT as well
  // as to filter, so a counter can never promise a set the filter doesn't show.
  const [preflightFilter, setPreflightFilter] = useState<PreflightFilter | null>(null);
  // Sample rows are keyed by the RESOLVED sourcetype, so several batch rows can
  // share one — a sample filter can therefore show more rows than the counter says.
  // A row with its own `sample` cell is keyed by that sample instead
  // (batchSampleKey), so it never shares a store sample, or another row's cell.
  // `PreflightSampleRow.sourcetype` holds this key.
  // A Windows channel keeps its RAW name (batchSampleSourcetype): several channels
  // share one canonical parser but not one event set.
  const preflightSampleKeyOf = (row: PreflightSourcetypeRow): string => {
    // The raw spelling lives on the batch row (`outputSourcetype`), which a
    // corrected CSV keeps when it differs from the canonical column. An
    // override is a name the user picked instead, so it wins.
    const src = batchRows[row.index];
    const raw = row.override || src?.outputSourcetype || row.original;
    return batchSampleKey(batchSampleSourcetype(raw, row.override || row.canonical), row.rowSample);
  };
  const preflightSampleFor = (row: PreflightFilterRow): PreflightSampleRow | undefined =>
    preflightSamples.find(s => s.sourcetype === preflightSampleKeyOf(row as PreflightSourcetypeRow));
  // What each row's own sample says, offline (format, the source its content
  // names, the source-expectation guard). Memoized per (sourcetype, sample): the
  // datatype matcher is too slow to rerun for every row on every render.
  const rowSampleReadings = useRef<Map<string, RowSampleReading>>(new Map());
  const readRowSampleMemo = (sourcetype: string, sample: string): RowSampleReading | null => {
    const key = `${sourcetype}\u0000${sample}`;
    let reading = rowSampleReadings.current.get(key);
    if (!reading) {
      try { reading = readRowSample(sourcetype, sample); } catch { return null; }
      rowSampleReadings.current.set(key, reading);
    }
    return reading;
  };
  const rowSampleReadingFor = (row: PreflightSourcetypeRow): RowSampleReading | null =>
    row.rowSample ? readRowSampleMemo(row.override || row.canonical, row.rowSample) : null;
  const preflightRowsIn = (filter: PreflightFilter): PreflightSourcetypeRow[] =>
    preflightSourcetypes.filter(r => preflightRowMatches(r, filter, preflightSampleFor));
  const preflightSampleCache = useRef<Map<string, string>>(new Map());
  // The stores' answer per (key, required format): the check screen looks every
  // key up to say where its sample will come from, and the sample pass behind
  // Next reads the same answer instead of fetching it again.
  const preflightStoreCache = useRef<Map<string, { events: unknown[]; source: 'reference' | 'bundled' } | null>>(new Map());
  // Event counts per sample key, for the Sample column's forecast (null = nothing stored).
  const [preflightStoreLookups, setPreflightStoreLookups] = useState<Record<string, StoreLookup | null>>({});
  const preflightStoreInFlight = useRef<Set<string>>(new Set());
  // The XSIAM CEF requirement of every row that builds as this sourcetype.
  const preflightRequiredFormat = (sourcetype: string): string | undefined => {
    const canonical = canonicalizeSourcetype(sourcetype);
    const destinations = preflightSourcetypes
      .filter(row => canonicalizeSourcetype(row.override || row.canonical) === canonical)
      .map(row => row.destFormat || '');
    return getRequiredXsiamSampleFormat(canonical, destinations);
  };
  // Pass 1 of the sample pass: reference, then bundled, `extend: false` (no model
  // call). Shared by the forecast and runPreflightPhase2 so both read one answer.
  const lookupStoreSample = async (sourcetype: string, requiredFormat: string | undefined) => {
    const cacheKey = `${sourcetype}\u0000${requiredFormat || ''}`;
    if (preflightStoreCache.current.has(cacheKey)) return preflightStoreCache.current.get(cacheKey)!;
    let hit: { events: unknown[]; source: 'reference' | 'bundled' } | null = null;
    try {
      const ref = await fetchReferenceSample(sourcetype, requiredFormat, { extend: false });
      if (ref.available && Array.isArray(ref.events) && ref.events.length > 0) hit = { events: ref.events, source: 'reference' };
    } catch { /* no reference sample available */ }
    if (!hit) {
      try {
        const bundled = await (await loadBundledData()).getBundledSample(sourcetype, requiredFormat);
        if (bundled.available && Array.isArray(bundled.events) && bundled.events.length > 0) hit = { events: bundled.events, source: 'bundled' };
      } catch { /* no bundled sample either */ }
    }
    preflightStoreCache.current.set(cacheKey, hit);
    return hit;
  };
  // WHERE each pre-flight sample came from (reference / bundled / ai-generated), so a
  // build that reuses it can still name the real tier instead of just "preflight".
  const preflightSampleOrigin = useRef<Map<string, string>>(new Map());
  // Sample generation/extension the check screen queued for the batch run: the
  // run does it first, as a visible stage, instead of the check screen stalling on it.
  const deferredSampleWork = useRef<{ generate: number; extend: number; tasks: Array<() => Promise<void>> } | null>(null);
  const batchSampleSkip = useRef(false);
  const [batchSamplePrep, setBatchSamplePrep] = useState<{ done: number; total: number; generate: number; extend: number; since: number } | null>(null);
  // How long that resolution took. A background build cannot measure it — the
  // work happened here — so carrying it is the only way its score event can
  // report `prepare_ms` the way a foreground build's does.
  const preflightSamplePrepareMs = useRef<Map<string, number>>(new Map());
  // Set true when the user chooses to stop waiting on phase-2 sample resolution.
  // Sample generation/extension is minutes of model time per source (bounded by the
  // proxy deadline, but 3-at-a-time over many sources still means a long tail), and
  // while it runs the whole screen is busy — Next is disabled and every Remove
  // control is hidden. This lets the user bail: unfinished rows fall back to "sample
  // at build time" (which never blocks the build), the busy banner clears, and any
  // in-flight call that finishes later is a free bonus rather than something waited on.
  const preflightAbort = useRef(false);
  // Supported-sourcetype catalog (names only) used to GROUND the AI resolver so
  // it maps customer labels to a name the app can build, never inventing one.
  // getSupportedSourcetypeCatalog() is internally memoized — cheap to re-call.
  const supportedCatalogNames = (): string[] => getSupportedSourcetypeCatalog().map(c => c.name);

  // Shared sourcetype confirmation for ALL interactive entry points (create pack,
  // create demo, create pipeline). Runs the improved LOCAL recognizer first
  // (instant, offline — same engine as batch preflight: aliases, hints, rotation
  // strip, glued prefixes) and only escalates to AI when the catalog can't place
  // the name. Always yields a CONFIRMED canonical or a list of suggestions to pick
  // from — never silently accepts an unrecognized label.
  //   ok            → resolved to a real supported/recognized source (use canonical)
  //   suggestions[] → couldn't confirm; user must pick one of these (or refine)
  //   hint          → human explanation to show alongside the suggestions
  type RecMeta = { vendor?: string; product?: string; logFamily?: string; description?: string; logFormat?: string; typicalFields?: string[] };
  type ConfirmResult = { ok: boolean; canonical: string; suggestions: string[]; hint: string; meta?: RecMeta };
  // A bare vendor/family label ("sap", "juniper", "cisco") must never auto-confirm
  // while the supported catalog carries concrete variants — the user has to say
  // WHICH product's logs they have. Without this, "sap" silently became whichever
  // variant the AI guessed first (sap_audit), "juniper" built generically on an
  // unbuildable vendor token, and "cisco"/"windows"/"aws" looked fully recognized
  // off a prefix-matched partial parser — in every case showing the user no choice.
  // The rule itself lives in pack-builder (getFamilyTokenVariants) so the batch
  // preflight applies exactly the same test.
  const ambiguousCatalogVariants = (input: string): string[] => getFamilyTokenVariants(input);
  const ambiguousVendorHint = (input: string) =>
    `"${input}" names a vendor or product family, not a specific log source. Pick which logs you have below, or refine the name and Confirm again.`;

  const confirmSourcetype = async (raw: string): Promise<ConfirmResult> => {
    const input = (raw || '').trim();
    if (!input) return { ok: false, canonical: '', suggestions: [], hint: 'Enter a sourcetype.' };
    // 1) Local recognizer — exact/alias/high-confidence-fuzzy all confirm instantly;
    //    a catalogue_gap (recognized vendor/product, no golden) also confirms — it
    //    builds via AI on its own name.
    const rec = recognizeSourcetype(input);
    const recMeta: RecMeta = { vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily, description: rec.description };
    if (rec.status === 'exact' || rec.status === 'alias' || (rec.tier === 'fuzzy' && rec.confidence === 'high')) {
      // An 'exact' hit on a bare family token is an artifact of prefix-matched
      // parser lookup, not a real source — gate it. An ALIAS or a typo correction
      // is a curated redirect to a concrete name, so it is always honoured.
      const familyVariants = rec.status === 'exact' && rec.canonical === rec.normalized
        ? ambiguousCatalogVariants(input)
        : [];
      if (familyVariants.length) {
        return { ok: false, canonical: '', suggestions: familyVariants, hint: ambiguousVendorHint(input) };
      }
      return { ok: true, canonical: rec.canonical, suggestions: [], hint: '', meta: recMeta };
    }
    if (rec.status === 'catalogue_gap') {
      // A curated hint identified the vendor but the label may still be a family
      // token with concrete supported children ("juniper" → junos/netscreen/srx).
      const familyVariants = ambiguousCatalogVariants(input);
      if (familyVariants.length) {
        return { ok: false, canonical: '', suggestions: familyVariants, hint: ambiguousVendorHint(input) };
      }
      return { ok: true, canonical: rec.canonical, suggestions: [], hint: '', meta: recMeta };
    }
    // A medium-confidence fuzzy match becomes a single suggestion to confirm.
    const localSuggestions: string[] = [];
    if (rec.suggestion) localSuggestions.push(normalizeSourcetypeName(rec.suggestion));
    // 2) Not confirmed locally → escalate to AI for grounded suggestions.
    try {
      const result = await aiValidate(input, '', supportedCatalogNames());
      // The AI validator enriches a real source with description/logFormat/
      // typicalFields — carry it through so sample generation can ground on it.
      const aiMeta: RecMeta = {
        ...recMeta,
        description: recMeta.description || (result.description || '').trim() || undefined,
        logFormat: (result.logFormat || '').trim() || undefined,
        typicalFields: Array.isArray(result.typicalFields) && result.typicalFields.length ? result.typicalFields.slice(0, 16) : undefined,
      };
      // AI mapped it to a supported name (and didn't flag ambiguity) → confirm.
      // But a single confident suggestion for a FAMILY token is still just the
      // model's pick among several ("sap" → sap_audit): offer the whole set with
      // the AI's choice first instead of silently adopting it.
      if (result.valid && !result.clarification && result.suggestion && !/[,;]/.test(result.suggestion)) {
        const aiPick = normalizeSourcetypeName(result.suggestion);
        const familyVariants = ambiguousCatalogVariants(input);
        if (familyVariants.length) {
          const ordered = [aiPick, ...familyVariants.filter(v => v !== aiPick)];
          return { ok: false, canonical: '', suggestions: ordered, hint: ambiguousVendorHint(input) };
        }
        return { ok: true, canonical: aiPick, suggestions: [], hint: '', meta: aiMeta };
      }
      const suggestions = [...localSuggestions];
      if (result.suggestion) {
        result.suggestion.split(/[,;]/).map((s: string) => normalizeSourcetypeName(s)).filter(Boolean)
          .forEach((s: string) => { if (!suggestions.includes(s)) suggestions.push(s); });
      }
      // Before accepting a real source on its OWN name, check the supported
      // catalog for specific variants of this label. A bare vendor/family token
      // like "sap" is isRealSource=true but has 7 supported sap_* variants
      // (sap_audit, sap_hana, sap_erp…) — accepting "sap" on its own name would
      // silently skip that choice and fall to generic AI. If the catalog has
      // matches, surface them for the user to pick instead of auto-confirming.
      const catalogMatches = searchSupportedSourcetypes(input).map(m => m.name);
      // AI recognized it as a REAL source with no golden (isRealSource) AND the
      // catalog has no specific variant to offer → confirm on its own name (build
      // via AI), like a hint (aws:waf, cloudflare:dns — genuinely unsupported).
      if (suggestions.length === 0 && result.isRealSource && catalogMatches.length === 0) {
        return { ok: true, canonical: canonicalizeSourcetype(normalizeSourcetypeName(input)), suggestions: [], hint: '', meta: aiMeta };
      }
      // Fold in catalog variants so the picker below shows them (deduped).
      catalogMatches.forEach(m => { if (!suggestions.includes(m)) suggestions.push(m); });
      const hint = result.clarification
        || (suggestions.length ? 'Not an exact match — pick the closest supported sourcetype below, or refine the name.'
                               : 'Could not identify this sourcetype. Try a supported name (vendor_product).');
      return { ok: false, canonical: '', suggestions, hint };
    } catch {
      // AI unavailable: fall back to any local fuzzy suggestion; else accept
      // optimistically (offline can't disprove a real source).
      if (localSuggestions.length) return { ok: false, canonical: '', suggestions: localSuggestions, hint: 'Not an exact match — pick the closest, or refine the name.' };
      return { ok: true, canonical: canonicalizeSourcetype(normalizeSourcetypeName(input)), suggestions: [], hint: '' };
    }
  };

  const [aiSteps, setAiSteps] = useState<{ step: string; detail: string; time: number }[]>([]);
  const [aiAnalysisSteps, setAiAnalysisSteps] = useState<{ step: string; detail: string; time: number }[]>([]);
  // Deployed pipelines available for schema validation (set at deploy time by
  // both the interactive and batch paths).
  const [deployedPipelines, setDeployedPipelines] = useState<DeployedPipeline[]>([]);
  const [validationReports, setValidationReports] = useState<Record<string, ValidationReport | null>>({});
  const [validatingPipelines, setValidatingPipelines] = useState(false);
  const [repairSelection, setRepairSelection] = useState<Set<string>>(new Set());
  const [repairing, setRepairing] = useState(false);
  const [validationError, setValidationError] = useState('');
  // Reference knowledge extracted from professional dispensary packs.
  const [referenceAvailability, setReferenceAvailability] = useState<Record<string, ReferenceAvailability>>({});
  const [refSampleLoading, setRefSampleLoading] = useState(false);
  // --- Demo environment builder ---
  const [workerHealth, setWorkerHealth] = useState<Record<string, WorkerHealth>>({});
  const [workerHealthLoading, setWorkerHealthLoading] = useState(false);
  // A group with zero workers is ABSENT from the /master/workers aggregate, so
  // an empty map is indistinguishable from "not fetched yet" until this is set.
  // The background group picker must not grey out every tile before the health
  // fetch returns, so it gates on this rather than on the map being non-empty.
  const [workerHealthLoaded, setWorkerHealthLoaded] = useState(false);
  const [demoSources, setDemoSources] = useState<DemoSource[]>([]);
  const [demoSourceInput, setDemoSourceInput] = useState('');
  const [demoSourceValidating, setDemoSourceValidating] = useState(false);
  const [demoSourceHint, setDemoSourceHint] = useState('');
  const [demoSourceSuggestions, setDemoSourceSuggestions] = useState<string[]>([]);
  // Demo search matches — shown after an "Add source" attempt that didn't
  // resolve (on Confirm, not as-you-type). Clicking one fills the input.
  const [demoStMatches, setDemoStMatches] = useState<{ name: string; golden: boolean; description: string }[]>([]);
  // Demo destinations = the Build pack flow canvas (docs/demo-ocsf-flow-design-v2-2026-10-02.html):
  // Flow format keys for the main packs, optional post-processing behind OCSF.
  const [demoDestFormats, setDemoDestFormats] = useState<string[]>([]);
  const [demoPp, setDemoPp] = useState<FlowPpState>(EMPTY_FLOW_PP);
  const [demoOptimize, setDemoOptimize] = useState<Record<string, boolean>>({});
  const [demoOcsfKeepRaw, setDemoOcsfKeepRaw] = useState(false);
  const [demoCells, setDemoCells] = useState<DemoCell[]>([]);
  // A Lake dataset makes "Cribl Lake" (@lake) an output choice on the routing screen.
  const [demoLakeSelected, setDemoLakeSelected] = useState(false);
  const [demoLakeDatasets, setDemoLakeDatasets] = useState<LakeDataset[]>([]);
  const [demoLakeDataset, setDemoLakeDataset] = useState('');
  const [demoLakeLoading, setDemoLakeLoading] = useState(false);
  const [demoCreateDashboard, setDemoCreateDashboard] = useState(false);
  const [demoDashboardDatasets, setDemoDashboardDatasets] = useState<SearchDataset[]>([]);
  const [demoDashboardDataset, setDemoDashboardDataset] = useState('');
  const [demoDashboardStyle, setDemoDashboardStyle] = useState<DashboardStyle>('native');
  const [demoDashboardLoading, setDemoDashboardLoading] = useState(false);
  const [, setDemoDashboardLoadError] = useState('');
  const [demoSearchDatatypes, setDemoSearchDatatypes] = useState<SearchDatatype[]>([]);
  const [demoSearchDatatypesLoading, setDemoSearchDatatypesLoading] = useState(false);
  const [, setDemoSearchDatatypesError] = useState('');
  const [demoDatatypeSelections, setDemoDatatypeSelections] = useState<Record<string, string>>({});
  const [demoDashboardResult, setDemoDashboardResult] = useState<{ id?: string; name?: string; kpiCount?: number; datatypeIds?: string[]; error?: string } | null>(null);
  const [demoOutputs, setDemoOutputs] = useState<DemoOutput[]>([]);
  const [demoLog, setDemoLog] = useState<string[]>([]);
  const [demoResults, setDemoResults] = useState<DemoResult[]>([]);
  const [demoError, setDemoError] = useState('');
  const [demoSummary, setDemoSummary] = useState<{ datagenIds: string[]; group: string; routeCount: number; lakeOutput?: string; replay: boolean; eventsPerSec: number } | null>(null);
  // --- Experimental 3-stage build ---
  const [expStages, setExpStages] = useState<ExpStageResult[]>([]);
  const [expPerFormatStages, setExpPerFormatStages] = useState<{ format: string; pipelineId: string; stages: ExpStageResult[] }[]>([]);
  const [expBuildTraces, setExpBuildTraces] = useState<BuildTrace[]>([]);
  const [expLog, setExpLog] = useState<string[]>([]);
  // Build pack flow's Build screen: live per-format / per-post-processing-pack progress.
  const [expLive, setExpLive] = useState<FlowLiveFormat<ExpStageResult>[]>([]);
  const [expPpLive, setExpPpLive] = useState<FlowLivePp[]>([]);
  const [expPhase, setExpPhase] = useState<FlowBuildPhase>('prep');
  const [expStartedAt, setExpStartedAt] = useState(0);
  const [expError, setExpError] = useState('');
  const [expPackId, setExpPackId] = useState('');
  // Click-to-enlarge event viewer for the 3-stage report cards (the inline
  // previews are tiny — this opens the full event in a modal).
  const [eventModal, setEventModal] = useState<{ title: string; body: string } | null>(null);
  const [journeyModal, setJourneyModal] = useState<{ format: string; stages: ExpStageResult[]; profileArgs?: JourneyProfileArgs } | null>(null);
  // --- Demo cleanup ---
  const [demoScan, setDemoScan] = useState<DemoScanResult | null>(null);
  const [demoScanLoading, setDemoScanLoading] = useState(false);
  const [demoCleanupSel, setDemoCleanupSel] = useState<{ routes: Set<string>; datagens: Set<string>; packs: Set<string>; outputs: Set<string> }>({ routes: new Set(), datagens: new Set(), packs: new Set(), outputs: new Set() });
  const [demoCleaning, setDemoCleaning] = useState(false);
  const [demoCleanupResult, setDemoCleanupResult] = useState<{ routes: string[]; datagens: string[]; packs: string[]; outputs: string[]; errors: string[] } | null>(null);
  const DEMO_MAX_SOURCES = 5;
  const DEMO_MAX_FORMATS = 3;

  /**
   * Any change to the sample events invalidates the sanitised mark.
   *
   * The mark is what the AI-snippet guard trusts, so it must never outlive the exact
   * text it was granted for. A new upload, a re-capture or one edited character in the
   * paste box all mean un-reviewed content, and letting a stale `true` survive would
   * send raw customer data to a model vendor with the guard reporting success.
   */
  const update = (partial: Partial<WizardState>) => setState((s) => {
    const next = { ...s, ...partial };
    if (partial.sampleEvents !== undefined && partial.sampleEvents !== s.sampleEvents
        && partial.sampleSanitised === undefined) {
      next.sampleSanitised = false;
    }
    return next;
  });

  // Reset all wizard content back to a clean slate for "Start Again".
  // Deliberately preserves cross-run infrastructure/connection state:
  // the fetched workerGroups list, settings modal open-ness, and AI
  // connection status (aiStatus/aiStatusMsg) — those are not part of a run.
  const resetAll = () => {
    setState(initialState);
    setStep('mode');
    setPackMode('experiment');
    setFlowOptimize({});
    setFlowSrcRules({});
    setFlowOcsfKeepRaw(true);
    setFlowOverwrite(false);
    setFlowPpOverwrite(false);
    setFlowNameEdited(false);
    setFlowPp(EMPTY_FLOW_PP);
    setFlowPpResults([]);
    setSourcetype('');
    setCustomSourcetype('');
    setIsCustomSourcetype(false);
    setSourcetypeFilter('');
    setReductionToggles({});
    setAllowCodeFunctions(false);
    setCreateDatagen(false);
    setAutoValidate(false);
    setDeployLog([]);
    setError('');
    setAiAdvice(null);
    setAiMappings(null);
    setAiMappingsPerFormat({});
    setAiParseFns(null);
    setAiLoading(false);
    setAiError('');
    setSamplesLoading(false);
    setValidationHint('');
    setValidating(false);
    setValidationSuggestions([]);
    setCustomConfirmed(false);
    setExistingPacks([]);
    setSelectedGroup('');
    setSelectedPackId('');
    setAddImproveAction(null);
    setOptimizePipelineId('');
    setOptimizeGoals({ sample: false, extraction: false, mapping: false, optimization: false });
    setOptimizeGuidance('');
    setOptimizeBusy(false);
    setOptimizeError('');
    setOptimizeLog([]);
    setOptimizeResults([]);
    setOptimizeScores(null);
    setOptimizePhase('idle');
    setOptimizeStatus('');
    setPackPipelines([]);
    setPackPipelinesLoading(false);
    setPackPipelinesError('');
    setPacksLoading(false);
    setGroupsError('');
    setPacksError('');
    setGroupFilter('');
    setPackFilter('');
    setSampleSourceId('');
    setCaptureFilter('');
    setCaptureMaxEvents(100);
    setCaptureDuration(10);
    setCaptureLoading(false);
    setExistingSamples([]);
    setSampleSearchFilter('');
    setExistingSampleLabel('');
    setSamplesListLoading(false);
    setDetectedSourcetype('');
    sourcetypeSelectionOrigin.current = 'none';
    setDetectConfidence('');
    setDetectReason('');
    setDetecting(false);
    setBatchRows([]);
    setBatchResults([]);
    setBatchTraces({});
    batchReportStages.current = {};
    setBatchError('');
    setBatchRunning(false);
    setBatchConflicts([]);
    setBatchSkipPacks(new Set());
    setBatchConfirmReady(false);
    setBatchBackground(false);
    setBatchBgError('');
    setBatchBgNotice('');
    setBatchBgRead(BACKGROUND_READ_OK);
    setBatchBgStopping(false);
    setBatchBgStarting(false);
    setBatchBgDismissing(false);
    setBatchBgRetrying(false);
    // Deliberately NOT clearing batchBgCheckpoint here — a background run
    // keeps going on the server regardless of what this session does, so
    // "Start Again" must not make it look like there's nothing left to check.
    // `handleDismissBatchBackground` is the one place that clears it, and it
    // clears it only after the durable delete has actually come back.
    setAiSteps([]);
    setAiAnalysisSteps([]);
    setDeployedPipelines([]);
    setValidationReports({});
    setValidatingPipelines(false);
    setRepairSelection(new Set());
    setRepairing(false);
    setValidationError('');
    setDemoSources([]);
    setDemoSourceInput('');
    setDemoSourceHint('');
    setDemoSourceSuggestions([]);
    setDemoDestFormats([]);
    setDemoPp(EMPTY_FLOW_PP);
    setDemoOptimize({});
    setDemoOcsfKeepRaw(false);
    setDemoCells([]);
    setDemoLakeSelected(false);
    setDemoLakeDataset('');
    setDemoCreateDashboard(false);
    setDemoDashboardDatasets([]);
    setDemoDashboardDataset('');
    setDemoDashboardStyle('native');
    setDemoDashboardLoading(false);
    setDemoDashboardResult(null);
    setDemoOutputs([]);
    setDemoLog([]);
    setDemoResults([]);
    setDemoError('');
    setDemoSummary(null);
    setExpStages([]);
    setExpPerFormatStages([]);
    setExpBuildTraces([]);
    setExpLog([]);
    setExpLive([]);
    setExpPpLive([]);
    setExpPhase('prep');
    setExpError('');
    setExpPackId('');
    setDemoScan(null);
    setDemoCleanupSel({ routes: new Set(), datagens: new Set(), packs: new Set(), outputs: new Set() });
    setDemoCleaning(false);
    setDemoCleanupResult(null);
  };

  useEffect(() => {
    if (deployLogRef.current) {
      deployLogRef.current.scrollTop = deployLogRef.current.scrollHeight;
    }
  }, [deployLog]);

  // Seed bundled golden pipelines into localStorage on first load or after upgrade.
  //
  // Iframe only, and deferred to idle even there. The seeded `golden::*` entries are the
  // iframe's golden store; standalone keeps goldens in the backend file store and every
  // reader of these keys is behind an iframe check, so seeding them there wrote hundreds
  // of entries that nothing ever read — and pulling the bundled golden set in to do it
  // dragged multi-megabyte JSON onto the startup path for no one's benefit.
  useEffect(() => {
    if (getRunMode() !== 'iframe') return;
    whenIdle(() => { void seedGoldenDefaultsSafely(loadBundledGoldens, BUILD_NUMBER); });
  }, []);

  // New-version detector: poll version.json (emitted next to the static bundle)
  // and surface a reload banner when the DEPLOYED build is newer than the one
  // this tab loaded. A reload then actually pulls the new code (same pattern as
  // the goldens badge). `import.meta.env.BASE_URL` respects `base: './'` so it
  // resolves relative to wherever the host serves the app (iframe or standalone).
  const [newBuild, setNewBuild] = useState<number | null>(null);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const url = `${import.meta.env.BASE_URL}version.json?t=${Date.now()}`;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return;
        const v = await r.json();
        if (!stop && typeof v.build === 'number' && v.build > BUILD_NUMBER) setNewBuild(v.build);
      } catch { /* offline / not deployed yet — ignore */ }
    };
    check();
    const id = setInterval(check, 60_000);   // hourly would also do; 60s is cheap (tiny JSON)
    return () => { stop = true; clearInterval(id); };
  }, []);

  // Re-hydrate quality settings form once platform settings load (iframe persistence)
  useEffect(() => {
    (async () => {
      const q = await loadQualitySettingsAsync();
      setQForm(q);
    })();
  }, []);

  // Datatype parsers imported by THIS install (iframe Sync) live in the app KV
  // store, not in the bundle — install them before anything builds a pipeline, or
  // an imported sourcetype resolves to no parser at all.
  useEffect(() => { void ensureDatatypeOverlay(); }, []);

  // A batch run that never reached 'done' (tab closed/reloaded mid-batch) left a
  // checkpoint behind — offer it back rather than silently losing the progress.
  useEffect(() => {
    void loadBatchCheckpoint().then(cp => {
      if (cp && cp.status !== 'done') setBatchResumeCheckpoint(cp);
    });
  }, []);

  // handleBatchDeploy reads batchRows/batchConflictActions/batchSkipPacks from
  // closure, so a resume must wait for the restore in handleResumeBatch to
  // commit before calling it — this effect is that wait.
  useEffect(() => {
    if (!pendingResumeRun) return;
    const { workerGroup, results } = pendingResumeRun;
    setPendingResumeRun(null);
    void handleBatchDeploy(workerGroup, results);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResumeRun]);

  useEffect(() => { batchBgLatest.current = batchBgCheckpoint; }, [batchBgCheckpoint]);

  // The active-pointer read, as ONE function: the mount effect below runs it,
  // and the banner's Retry runs the same one. A retry that re-implemented the
  // read could classify the same failure differently from the read it is
  // retrying, which is how a screen ends up arguing with itself.
  //
  // The failure is CLASSIFIED here, at the only place that still holds the
  // error object: transient (ask again in a moment) versus permanent — a
  // corrupt document or a refusal, where asking again changes nothing and the
  // only remaining move is cleanup. `backgroundRunIdOf` recovers which run that
  // was, since a corrupt manifest yields no checkpoint to take the id from.
  const refreshActiveBackgroundRun = async () => {
    let outcome: BackgroundPollOutcome;
    try {
      outcome = { ok: true, checkpoint: await loadActiveBatchBackgroundRun() };
    } catch (e) {
      // This read asks for "whatever is active", so the run id comes back on
      // the error itself — the failed read knew which run it resolved.
      outcome = backgroundReadFailure(e);
    }
    // Through the same fold as the poll, against the same last-known state: on
    // mount there is nothing known yet, so an empty answer is simply "no run",
    // but a Retry runs while the screen may hold a perfectly good checkpoint
    // and must not throw it away by folding against a hard null.
    const next = foldBackgroundRead(batchBgLatest.current, outcome);
    setBatchBgCheckpoint(next.checkpoint);
    setBatchBgRead(next.read);
  };

  // A background batch keeps running whether or not this tab is open — on
  // mount, check whether one is already in flight so reopening the app finds
  // it instead of showing no trace it ever started. A read that fails here is
  // reported: "no run" and "could not ask" look identical on screen otherwise,
  // and only one of them means it is safe to start another.
  useEffect(() => {
    void refreshActiveBackgroundRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetryBackgroundRead = async () => {
    if (batchBgRetrying) return;
    setBatchBgRetrying(true);
    try {
      await refreshActiveBackgroundRun();
    } finally {
      setBatchBgRetrying(false);
    }
  };

  // Expand/collapse one row's scorecard, fetching its artifact on open. The
  // detail is refetched every time it opens rather than cached: a running row's
  // scorecard grows as stages checkpoint, so a stale cache would show a row two
  // stages behind where it actually is.
  const toggleBgScorecard = async (r: BackgroundRowView) => {
    if (bgScorecardRowId === r.rowId) {
      setBgScorecardRowId(null);
      setBgScorecard({ loading: false, error: '', card: null });
      return;
    }
    const req = ++bgScorecardReq.current;
    setBgScorecardRowId(r.rowId);
    setBgScorecard({ loading: true, error: '', card: null });
    try {
      const artifact = await loadBatchBackgroundRowArtifact(r.artifactKey);
      if (bgScorecardReq.current !== req) return;
      setBgScorecard({ loading: false, error: '', card: buildBackgroundRowScorecard(artifact) });
    } catch (e) {
      if (bgScorecardReq.current !== req) return;
      setBgScorecard({ loading: false, error: e instanceof Error ? e.message : String(e), card: null });
    }
  };

  // Polls the checkpoint while the progress screen is open. Stops once the run
  // reaches a state it will never leave on its own — the dismiss handler
  // deletes the KV key, so a poll after that would report the finished run as
  // unreadable.
  useEffect(() => {
    if (step !== 'batch-bg-running') return;
    // Status alone decides this, and status alone is what re-subscribes the
    // loop — polling a run that will never move again only reports it as
    // unreadable once the dismiss handler deletes its key.
    if (!backgroundStatusPresentation(batchBgCheckpoint?.status).active) return;
    const runId = batchBgCheckpoint?.runId;
    if (!runId) return;
    let stopped = false;
    const poll = async () => {
      // By run id, never "whatever is active": a dismissed-and-restarted run
      // must not have its progress reported under the run this screen opened on.
      let outcome: BackgroundPollOutcome;
      try {
        outcome = { ok: true, checkpoint: await loadBatchBackgroundRun(runId) };
      } catch (e) {
        // Classified exactly as the mount read classifies it: a document that
        // corrupts while this screen is open is the same dead end as one found
        // on reopening, and the operator needs the same way out of it.
        outcome = backgroundReadFailure(e, runId);
      }
      if (stopped) return;
      // Through a ref, not the closure: the loop must reconcile against the
      // last state it actually saw without re-subscribing (and restarting the
      // interval) on every tick that changes the checkpoint.
      const next = foldBackgroundRead(batchBgLatest.current, outcome);
      setBatchBgCheckpoint(next.checkpoint);
      setBatchBgRead(next.read);
    };
    void poll();
    const id = setInterval(poll, 4000);
    return () => { stopped = true; clearInterval(id); };
  }, [step, batchBgCheckpoint?.runId, batchBgCheckpoint?.status]);

  // Load reference-data availability once on mount so sourcetype tiles can show
  // a badge when professional pack knowledge (samples/fields/transforms) exists.
  // Idle-deferred: the badge decorates the sourcetype tiles, which are two steps past
  // the mode picker the app opens on, and standalone answers it by reading and merging
  // the whole reference catalogue server-side.
  useEffect(() => {
    whenIdle(() => void (async () => {
      try {
        const { availability } = await fetchReferenceAvailability();
        setReferenceAvailability(availability || {});
      } catch { /* reference data is optional — degrade silently */ }
    })());
  }, []);

  // AI reachability. This is the probe the user is actually waiting on — it is a real
  // round trip to the selected model — so it is the one startup request NOT deferred, and
  // the badge-feeding probes around it are pushed to idle so they cannot occupy the
  // browser's per-host connection budget ahead of it.
  //
  // Re-runs after the AI settings are SAVED, never when the tab opens: opening it changed
  // no configuration, so the probe could only repeat what the header already showed. Repeat
  // probes are also served from checkAiHealth's cache unless the model or endpoint moved.
  useEffect(() => {
    (async () => {
      await loadSettingsAsync();
      if (!aiAvailable()) {
        setAiStatus('error');
        setAiStatusMsg('AI not configured — open Settings to add your API key.');
        return;
      }
      setAiStatus('checking');
      // Fast startup probe: verify BOTH that AI is reachable AND that the
      // SELECTED model actually returns text. A reasoning model (sonnet-5+)
      // that returns only an empty thinking block, or a mis-set model id, will
      // 200 here but produce empty samples/parse everywhere — catch it now.
      const health = await checkAiHealth();
      if (health.reachable && health.modelOk) {
        setAiStatus('ok');
        setAiStatusMsg(`AI ready — model ${health.model} responding (${health.latencyMs}ms)`);
      } else if (health.reachable && !health.modelOk) {
        setAiStatus('error');
        setAiStatusMsg(`Model "${health.model}" reachable but returned no usable text — ${health.error || 'check the model id in Settings.'}`);
      } else {
        setAiStatus('error');
        setAiStatusMsg(health.error || 'AI endpoint unreachable.');
      }
    })();
  }, [aiSettingsRev]);

  // Sample-library badge: counts only (`?summary=1`). The full payload carries every
  // event of every staged sample — the right thing for the review screen, the wrong
  // thing to pull on every app start. Returns null in the iframe, where the disk-backed
  // library does not exist, and the tile stays hidden.
  useEffect(() => {
    if (getRunMode() !== 'standalone') return;
    whenIdle(() => void fetchSampleLibrarySummary().then(s => setSampleLibSummary(s)));
  }, []);

  const lakeActiveRef = useRef<boolean | null>(null);
  // Idle-deferred: resolving the export config can mean an OAuth exchange plus a probe
  // write to the lake, and all it decides is one dot on the export settings button.
  useEffect(() => {
    whenIdle(() => void (async () => {
      const health = await checkLakeExportHealth();
      setLakeExportActive(health.active);
      setLakeExportMsg(health.message);
      lakeActiveRef.current = health.active;
    })());
  }, []);

  // Startup: check the shared golden pool for new/upgrade pipelines to import
  // (mirrors the Search datatype coverage checker). Standalone + token only.
  // Both directions read the same shared-pool index, so they go out together rather than
  // one after the other — awaiting in sequence made the import/publish badges cost two
  // full GitHub round trips before either appeared.
  const refreshAvailableGoldens = async () => {
    const [r, p] = await Promise.all([
      fetchAvailableGoldens(),
      fetchPushableGoldens(),   // reverse direction: local goldens that beat the shared pool
    ]);
    setAvailableGoldens(r.available || []);
    setPushableGoldens(p.pushable || []);
  };
  // Idle-deferred: two network round trips feeding the import/publish badges.
  useEffect(() => { whenIdle(() => void refreshAvailableGoldens()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // One import-all for Settings → Goldens and the home-screen notice.
  const importAllGoldens = async () => {
    setGoldenImporting(true);
    try {
      setGoldenImportMsg(goldenImportSummary(await importGoldens(availableGoldens.map(g => g.key))));
      await refreshAvailableGoldens();
    } catch (e) {
      setGoldenImportMsg({ tone: 'error', text: `Import failed — ${e instanceof Error ? e.message : String(e)}` });
    } finally { setGoldenImporting(false); }
  };

  const maybeLogScore: typeof logPipelineScore = async (data) => {
    // Send the completion event whenever scoring is (or becomes) reachable.
    // The startup health check can be stale — e.g. the user pasted the scoring
    // token AFTER page load, or the probe hadn't finished — which used to make
    // this a silent no-op and drop every scorecard. If the cached state isn't
    // active, re-probe once before giving up so a later-configured token works
    // without a reload. Every outcome is tallied so a dropped run is visible.
    if (!lakeActiveRef.current) {
      let reason = lakeExportMsg;
      try {
        const health = await checkLakeExportHealth();
        lakeActiveRef.current = health.active;
        setLakeExportActive(health.active);
        setLakeExportMsg(health.message);
        reason = health.message;
      } catch { /* leave as-is */ }
      if (!lakeActiveRef.current) {
        setScoreLogTally(t => ({ logged: t.logged, dropped: t.dropped + 1, lastReason: reason || 'score logging inactive' }));
        return { ok: false, reason };
      }
    }
    const res = await logPipelineScore(data);
    setScoreLogTally(t => res.ok
      ? { logged: t.logged + 1, dropped: t.dropped, lastReason: t.lastReason }
      : { logged: t.logged, dropped: t.dropped + 1, lastReason: res.reason || t.lastReason });
    return res;
  };

  const fetchWorkerGroups = async () => {
    setGroupsError('');
    try {
      const groups = await listGroups();
      setWorkerGroups(groups);
    } catch (err: unknown) {
      setGroupsError(err instanceof Error ? err.message : 'Failed to load worker groups');
    }
  };

  const fetchPacks = async (group: string) => {
    setPacksLoading(true);
    setPacksError('');
    setExistingPacks([]);
    try {
      const packs = await listPacks(group);
      setExistingPacks(packs);
    } catch (err: unknown) {
      setPacksError(err instanceof Error ? err.message : 'Failed to load packs');
    }
    setPacksLoading(false);
  };

  useEffect(() => {
    if ((step === 'select-group' || step === 'select-pack') && workerGroups.length === 0) {
      fetchWorkerGroups();
    }
    // A background batch runs its Backend Function on the chosen group's
    // workers, and Cribl AI runs every preview and score there, so in both the
    // picker greys out groups with none connected. Load the health when that
    // picker opens; other flows don't need it.
    if (step === 'select-group' && ((packMode === 'batch' && batchBackground) || isCriblAiActive())) {
      void refreshWorkerHealth();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Where this batch may run (batchRunChoices): outside Cribl only this tab;
  // background up to BATCH_BACKGROUND_MAX_ROWS pipelines. On the Where-it-runs
  // step, move the selection off a choice that is not allowed, so Start always
  // matches a card.
  const batchRun = batchRunChoices({ inCribl: backgroundBatchSupported(), criblAi: isCriblAiActive(), rows: batchRows.length });
  useEffect(() => {
    if (step !== 'select-group' || packMode !== 'batch') return;
    if (batchBackground && !batchRun.background.ok && batchRun.foreground.ok) setBatchBackground(false);
    else if (!batchBackground && !batchRun.foreground.ok && batchRun.background.ok) { setBatchBackground(true); void refreshWorkerHealth(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, packMode, batchBackground, batchRun.foreground.ok, batchRun.background.ok]);

  // The Check screen's side panel is pinned to the viewport's right edge, from
  // just under the step bar to the bottom, so it stays beside the row the user
  // is deciding on however far the table scrolls. The bar's height varies
  // (it wraps on narrow screens), so it is measured, not assumed.
  useLayoutEffect(() => {
    if (step !== 'batch-preflight' || checkSel == null) return;
    const place = () => {
      const bar = document.querySelector('.pg-stepbar') ?? document.querySelector('.pg-topbar');
      const top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
      document.documentElement.style.setProperty('--bx-side-top', `${top}px`);
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [step, checkSel]);
  useEffect(() => {
    if (step !== 'batch-preflight') setCheckSel(null);
    if (step !== 'batch-done') { setResultsSel(null); setExportOpen(false); }
  }, [step]);

  // --- Demo environment builder ---------------------------------------------

  // Refresh only per-group worker health, leaving the group list untouched.
  // Used by the background batch picker, which already has the groups and just
  // needs to know which of them have a worker that can run its Backend Function.
  const refreshWorkerHealth = async () => {
    const health = await listWorkers().catch(() => null);
    if (health) {
      setWorkerHealth(health);
      setWorkerHealthLoaded(true);
    }
  };

  // Load worker groups + per-group worker health for the demo group picker.
  const fetchDemoGroupHealth = async () => {
    setGroupsError('');
    setWorkerHealthLoading(true);
    try {
      const [groups, health] = await Promise.all([
        workerGroups.length > 0 ? Promise.resolve(workerGroups) : listGroups(),
        listWorkers().catch(() => ({} as Record<string, WorkerHealth>)),
      ]);
      if (workerGroups.length === 0) setWorkerGroups(groups);
      setWorkerHealth(health);
      setWorkerHealthLoaded(true);
    } catch (err: unknown) {
      setGroupsError(err instanceof Error ? err.message : 'Failed to load worker groups');
    } finally {
      setWorkerHealthLoading(false);
    }
  };

  const refreshDemoLakeDatasets = async () => {
    setDemoLakeLoading(true);
    try {
      const datasets = await listLakeDatasets();
      setDemoLakeDatasets(datasets);
      if (demoLakeDataset && !datasets.some(dataset => dataset.id === demoLakeDataset)) setDemoLakeDataset('');
    } catch {
      setDemoLakeDatasets([]);
    } finally {
      setDemoLakeLoading(false);
    }
  };

  const refreshDemoSearchDatatypes = async () => {
    setDemoSearchDatatypesLoading(true);
    setDemoSearchDatatypesError('');
    try {
      const datatypes = await listSearchDatatypes();
      setDemoSearchDatatypes(datatypes);
      const available = new Set(datatypes.map(datatype => datatype.id));
      setDemoDatatypeSelections(previous => Object.fromEntries(Object.entries(previous).filter(([, id]) => !id || available.has(id))));
    } catch (error) {
      setDemoSearchDatatypes([]);
      setDemoSearchDatatypesError(error instanceof Error ? error.message : 'Failed to load Search datatypes.');
    } finally {
      setDemoSearchDatatypesLoading(false);
    }
  };

  const refreshDemoSearchDatasets = async () => {
    setDemoDashboardLoading(true);
    setDemoDashboardLoadError('');
    try {
      const datasets = await listSearchDatasets();
      setDemoDashboardDatasets(datasets);
      if (demoDashboardDataset && !datasets.some(dataset => dataset.id === demoDashboardDataset)) setDemoDashboardDataset('');
      if (!demoDashboardDataset) {
        const preferred = datasets.find(dataset => dataset.id === demoLakeDataset)?.id || datasets[0]?.id || '';
        if (preferred) setDemoDashboardDataset(preferred);
      }
    } catch (error) {
      setDemoDashboardDatasets([]);
      setDemoDashboardLoadError(error instanceof Error ? error.message : 'Failed to load Search datasets.');
    } finally {
      setDemoDashboardLoading(false);
    }
  };

  useEffect(() => {
    if (step === 'demo-group') fetchDemoGroupHealth();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (step === 'demo-destinations' && demoLakeSelected && demoLakeDatasets.length === 0 && !demoLakeLoading) {
      void refreshDemoLakeDatasets();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, demoLakeSelected]);

  useEffect(() => {
    if (step === 'demo-destinations' && demoCreateDashboard && demoDashboardDatasets.length === 0 && !demoDashboardLoading) {
      void refreshDemoSearchDatasets();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, demoCreateDashboard]);

  useEffect(() => {
    if (step === 'demo-destinations' && demoCreateDashboard && demoSearchDatatypes.length === 0 && !demoSearchDatatypesLoading) {
      void refreshDemoSearchDatatypes();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, demoCreateDashboard]);

  // Load active destinations for the routing table's per-row output picker.
  useEffect(() => {
    if (step === 'demo-routing' && selectedGroup && demoOutputs.length === 0) {
      listOutputs(selectedGroup).then(setDemoOutputs).catch(() => setDemoOutputs([]));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedGroup]);

  // Once sample resolution finishes, REFINE the inline schema advice with the
  // real sample (ocsf/asim data-class inference is sample-driven; cim/sentinel
  // stay name-based). The schema advice already lives on each sourcetype row —
  // there is no separate schema phase.
  useEffect(() => {
    if (step !== 'batch-preflight' || preflightPhase !== 'samples' || preflightRunning) return;
    // 'failed' counts as settled too — a source whose generation failed is not a
    // reason to withhold the schema advice for the ones that resolved.
    if (preflightSamples.length > 0 && preflightSamples.every(s => s.status !== 'pending' && s.status !== 'loading')) {
      refineSchemaAdviceFromSamples();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, preflightPhase, preflightRunning, preflightSamples]);

  // Validate + add a source to the demo list (reuses aiValidate like the wizard).
  const addDemoSource = async () => {
    const raw = demoSourceInput.trim();
    if (!raw) return;
    setDemoSourceHint('');
    setDemoSourceSuggestions([]);
    setDemoStMatches([]);
    if (demoSources.length >= DEMO_MAX_SOURCES) {
      setDemoSourceHint(`Maximum ${DEMO_MAX_SOURCES} sources.`);
      return;
    }
    const canonical = canonicalizeSourcetype(normalizeSourcetypeName(raw));
    if (demoSources.some(s => s.sourcetype === canonical)) {
      setDemoSourceHint('Already added.');
      return;
    }
    setDemoSourceValidating(true);
    try {
      // Local recognizer first (instant, offline), then AI fallback — same engine
      // as batch preflight. Add the CONFIRMED canonical (dedup against it).
      const res = await confirmSourcetype(raw);
      if (!res.ok) {
        // Not an exact match — run the catalog search NOW and show matches.
        const matches = searchSupportedSourcetypes(raw).filter(m => !demoSources.some(s => s.sourcetype === m.name));
        setDemoStMatches(matches);
        setDemoSourceHint(matches.length
          ? `No exact match for "${raw}". Click a supported sourcetype below, or refine the name and Add again.`
          : res.hint);
        setDemoSourceSuggestions(res.suggestions.filter(s => !matches.some(m => m.name === s)));
        return;
      }
      const confirmed = res.canonical || canonical;
      if (demoSources.some(s => s.sourcetype === confirmed)) { setDemoSourceHint('Already added.'); return; }
      setDemoSources(prev => [...prev, { sourcetype: confirmed, allowCodeFunctions: false }]);
      setDemoSourceInput('');
    } catch {
      // AI unavailable — accept optimistically (same as wizard validateSourcetype).
      setDemoSources(prev => [...prev, { sourcetype: canonical, allowCodeFunctions: false }]);
      setDemoSourceInput('');
    } finally {
      setDemoSourceValidating(false);
    }
  };

  const addDemoSourceDirect = (st: string) => {
    const canonical = canonicalizeSourcetype(normalizeSourcetypeName(st));
    if (!canonical || demoSources.some(s => s.sourcetype === canonical) || demoSources.length >= DEMO_MAX_SOURCES) return;
    setDemoSources(prev => [...prev, { sourcetype: canonical, allowCodeFunctions: false }]);
    setDemoSourceInput('');
    setDemoSourceHint('');
    setDemoSourceSuggestions([]);
    setDemoStMatches([]);
  };

  // The demo plan for the current screens: same inputs on the routing screen,
  // the Create button and the build, so what is shown is what gets created.
  const currentDemoPlan = (): DemoPlan => planDemoFlow({
    sources: demoSources.map(src => src.sourcetype), destFormats: demoDestFormats, pp: demoPp, cells: demoCells,
  });

  // Resolve sample events for a source — prefer a real reference, fall back to AI.
  const resolveDemoSampleEvents = async (sourcetype: string, log: (m: string) => void): Promise<string> => {
    const requiredFormat = getRequiredXsiamSampleFormat(sourcetype, demoDestFormats);
    try {
      const ref = await fetchReferenceSample(
        sourcetype,
        requiredFormat,
        requiredFormat ? { extend: false } : undefined,
      );
      if (ref.available && Array.isArray(ref.events) && ref.events.length > 0) {
        log(`  Using reference sample (${ref.events.length} events${requiredFormat ? `, required ${requiredFormat.toUpperCase()}` : ''})`);
        return flattenEventsToLines(ref.events);
      }
    } catch { /* fall through to AI */ }
    // AI generation with a bounded retry. The backend times out a stalled
    // Bedrock call at 90s (reasoning models are slow/variable under load), which
    // surfaces here as a throw OR an empty events array — retry once on EITHER.
    log('  No reference — generating AI samples…');
    // Ground on recognition metadata; pick the most-common format for a
    // multi-format source (demo is autonomous — no mid-flow prompt) and flag it.
    const rec = recognizeSourcetype(sourcetype);
    const mfSpec = getMultiFormatSpec(sourcetype);
    const chosenFmt = requiredFormat || (mfSpec ? (mfSpec.formats[0]?.id || undefined) : undefined);
    if (requiredFormat) log(`  XSIAM requires ${requiredFormat.toUpperCase()} — generating that variant.`);
    else if (mfSpec && chosenFmt) log(`  ⚠︎ ${sourcetype} is multi-format — assuming "${mfSpec.formats[0].label}".`);
    const grounding = buildSampleGroundingContext({ vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily }, sourcetype, chosenFmt);
    const gen = await generateSampleEvents({ sourcetype, grounding, log });
    if (gen.events) return gen.events;
    // Throw rather than return empty: the caller has to be able to say WHY this
    // source produced nothing. It used to be swallowed, so a demo that failed for
    // a rejected API key reported only "check AI/Tailscale connectivity".
    throw new Error(gen.lastReason);
  };

  // Orchestrator (design v2): every source is a Build pack flow. One main pack
  // per source (one pipeline per format, lane filters inside), optional OCSF →
  // post-processing packs fed by the OCSF replay datagen, one lane
  // datagen per format, then the isolated demo route block. Everything is built
  // deferred; setMasterRoutes' single commit + deploy makes it all live at once.
  const handleCreateDemo = async () => {
    setDemoError('');
    setDemoLog([]);
    setDemoResults([]);
    setDemoSummary(null);
    setDemoDashboardResult(null);
    setStep('demo-deploying');
    const group = selectedGroup;
    const dlog = (msg: string) => setDemoLog(prev => [...prev, msg]);

    try {
      const plan = currentDemoPlan();
      if (plan.packs.length === 0) { setDemoError('No routes enabled — nothing to create.'); setStep('demo-routing'); return; }

      const baseToggles = { drop_noise: true, remove_null_fields: true, compact_output: true, field_cleanup: true };
      const reductionToggles = flowReductionToggles(baseToggles, demoOptimize, demoOcsfKeepRaw, {}, demoDestFormats);
      // Per-stage golden thresholds + sharing, shared with the 3-stage builder.
      const demoQ = loadQualitySettings();
      const demoThresholds = { extraction: demoQ.expExtractionThreshold ?? 80, mapping: demoQ.expMappingThreshold ?? 80, optimization: demoQ.expOptimizationThreshold ?? 80 };
      const demoShareOn = goldenSharingConfigured(demoQ);
      const fmtLabel = (fmt: string) => flowFormatInfo(fmt).label;

      // Seed the result list up-front so every pipeline and post pack shows a live phase.
      const results: DemoResult[] = [
        ...plan.packs.flatMap(pk => pk.pipelines.map(pl => ({
          sourcetype: pk.sourcetype, format: pl.fmt, kind: 'main' as const,
          label: pl.fmt === 'ocsf' && !plan.routes.some(r => r.sourcetype === pk.sourcetype && r.kind === 'main' && r.target === 'ocsf') ? `${fmtLabel('ocsf')} (feeds post-processing)` : fmtLabel(pl.fmt),
          status: 'pending' as const, phase: 'queued' as BatchPhase,
        }))),
        ...plan.ppPacks.map(pp => ({
          sourcetype: pp.sourcetype, format: pp.target, kind: 'pp' as const,
          label: `OCSF → ${ppOutputLabel(pp.output)}`, status: 'pending' as const, phase: 'queued' as BatchPhase,
        })),
      ];
      const idxOf = (st: string, fmt: string) => results.findIndex(r => r.sourcetype === st && r.format === fmt);
      const patchResult = (i: number, patch: Partial<DemoResult>) => {
        if (i < 0) return;
        results[i] = { ...results[i], ...patch };
        setDemoResults([...results]);
      };
      setDemoResults([...results]);

      // Sample choice and extraction preparation are separate sealed stages.
      // Resolve the sample first so format/schema decisions cannot trigger parser
      // generation; resolve extraction later and cache it once per source sample.
      const sampleCache = createAsyncCache<string, string>();
      const extractionPrepCache = createAsyncCache<string, {
        aiParseFns: Awaited<ReturnType<typeof resolveParseFunctions>>['aiParseFns'];
        parsedFieldNames: string[];
        referenceLookups: Awaited<ReturnType<typeof fetchReferenceLookups>>;
      }>();
      const resolveSourceSample = (sourcetype: string, log: (m: string) => void) => {
        const cached = sampleCache.getOrCreate(sourcetype, () => resolveDemoSampleEvents(sourcetype, log));
        if (cached.reused) log(`Reusing resolved ${sourcetype} sample.`);
        return cached.value;
      };
      const resolveSourceExtraction = (sourcetype: string, sampleEvents: string, log: (m: string) => void) => {
        const cacheKey = `${sourcetype}::${JSON.stringify(sampleFingerprint(sampleEvents))}`;
        const cached = extractionPrepCache.getOrCreate(cacheKey, async () => {
          const [parseResult, referenceLookups] = await Promise.all([
            resolveParseFunctions({ sourcetype, sampleEvents, log, model: loadQualitySettings().normalModel }),
            fetchReferenceLookups(sourcetype).catch(() => []),
          ]);
          return { aiParseFns: parseResult.aiParseFns, parsedFieldNames: parseResult.parsedFieldNames, referenceLookups };
        });
        if (cached.reused) log(`Reusing prepared ${sourcetype} extraction and lookups.`);
        return cached.value;
      };

      // 1. Resolve sample events per source (via the cache — shared with the pack
      //    builds below so each source is prepared exactly once).
      dlog(`Preparing ${demoSources.length} source(s)…`);
      const eventsBySource: Record<string, string> = {};
      const sampleFailures: Record<string, string> = {};
      for (const src of demoSources) {
        dlog(`• ${src.sourcetype}`);
        results.forEach((r, k) => { if (r.sourcetype === src.sourcetype) patchResult(k, { status: 'running', phase: 'preparing', message: 'Preparing source data…' }); });
        try {
          eventsBySource[src.sourcetype] = await resolveSourceSample(src.sourcetype, dlog);
        } catch (e) {
          eventsBySource[src.sourcetype] = '';
          sampleFailures[src.sourcetype] = e instanceof Error ? e.message : 'unknown error';
        }
      }
      if (!demoSources.some(src => eventsBySource[src.sourcetype])) {
        // Name the real reason per source. Tailscale is a standalone concept — in
        // the iframe the model is called from the browser, so pointing there sent
        // people to check a VPN that has nothing to do with the failure.
        const failed = demoSources.map(src => `${src.sourcetype}: ${sampleFailures[src.sourcetype] || 'no sample available'}`);
        const hint = getRunMode() === 'iframe'
          ? 'AI runs in your browser here — check the API key and model in Settings.'
          : 'Check AI/Tailscale connectivity and retry.';
        throw new Error(`Could not obtain sample events for any source. ${failed.join('; ')}. ${hint}`);
      }

      // 2. Main packs — one per source, one pipeline per format (OCSF last), the
      //    Build pack flow loop: first pipeline creates the pack, the rest are
      //    added; extraction is reused per class. Each pipeline's route inside the
      //    pack is its lane filter, so the master route picks the pipeline by input.
      const built = new Set<string>();                       // `${st}::${fmt}`
      const ocsfBySource = new Map<string, DeployedPipeline>();
      const scoresOf = (stages: { stage: string; score: number | null }[]) => {
        const at = (k: string) => stages.find(x => x.stage === k)?.score ?? null;
        return { extraction: at('extraction'), mapping: at('mapping'), optimization: at('optimization') };
      };
      for (const pk of plan.packs) {
        const st = pk.sourcetype;
        const src = demoSources.find(x => x.sourcetype === st);
        const sampleEvents = eventsBySource[st];
        if (!sampleEvents) {
          const why = `No sample: ${sampleFailures[st] || 'none available'}`;
          results.forEach((r, k) => { if (r.sourcetype === st) patchResult(k, { status: 'error', phase: 'done', message: why }); });
          dlog(`  ✗ [${st}] ${why} — nothing built for this source.`);
          continue;
        }
        const prep = await resolveSourceExtraction(st, sampleEvents, dlog);
        const packageJson = {
          version: '1.0.0', author: 'Cribl Pack Generator (demo)', tags: { streamtags: [] }, exports: [],
          displayName: `[DEMO] ${st}`, name: pk.packId,
          description: `[DEMO] ${st} to ${pk.pipelines.map(pl => fmtLabel(pl.fmt)).join(', ')} — one pipeline per format, picked by the demo lane datagen.`,
        };
        const extractionByClass = new Map<'mapped' | 'raw', PreparedExtraction>();
        const extractionClassOf = (f: string): 'mapped' | 'raw' =>
          ['json', 'manual', 'raw', 'raw_fields', 'passthrough', ''].includes(flowBuildFormat(f)) ? 'raw' : 'mapped';
        let firstBuilt = false;
        dlog(`[${st}] Building pack ${pk.packId} (${pk.pipelines.length} pipeline${pk.pipelines.length > 1 ? 's' : ''})…`);
        for (const pl of pk.pipelines) {
          const ri = idxOf(st, pl.fmt);
          // The demo has no per-format table / model / class picker: resolve each
          // Flow key to the concrete golden-keyed format from this source's sample
          // ('sentinel' → commonsecuritylog, asim/cim/ocsf → the sample's class).
          let buildFmt = flowBuildFormat(pl.fmt);
          if (buildFmt === 'sentinel') buildFmt = 'commonsecuritylog';
          buildFmt = concretizeAsimFormat(buildFmt as DestFormat, st, sampleEvents);
          buildFmt = concretizeCimFormat(buildFmt as DestFormat, st, sampleEvents);
          buildFmt = concretizeOcsfFormat(buildFmt as DestFormat, st, sampleEvents);
          if (buildFmt !== flowBuildFormat(pl.fmt)) dlog(`  [${st}] ${fmtLabel(pl.fmt)} → ${buildFmt} (concrete golden format).`);
          patchResult(ri, { status: 'running', phase: 'building', message: `Building ${pl.pipelineId} (3-stage)…` });
          try {
            const out = await buildStagedPipeline({
              sourcetype: st, destFormat: buildFmt, sampleEvents, group, packId: pk.packId, pipelineId: pl.pipelineId,
              packageJson, reductionToggles, thresholds: demoThresholds, shareOn: demoShareOn,
              origin: 'demo', mode: firstBuilt ? 'add-pipeline' : 'new', uploadSample: !firstBuilt,
              routeFilter: pl.routeFilter, destinationKey: pl.fmt,
              preparedExtraction: extractionByClass.get(extractionClassOf(pl.fmt)) ?? null,
              allFormats: pk.pipelines.map(x => x.fmt),
              allowCode: src?.allowCodeFunctions, log: dlog, logScore: maybeLogScore,
              preparedParseFns: prep.aiParseFns?.functions,
              onStage: (r) => patchResult(ri, { phase: r.stage === 'optimization' ? 'scoring' : 'building', message: `${r.stage}: ${r.score ?? 'n/a'}` }),
            });
            if (!out) {
              patchResult(ri, { status: 'error', phase: 'done', message: 'No sample events — nothing built.' });
              dlog(`  ⚠ [${st} to ${fmtLabel(pl.fmt)}] no sample — skipped.`);
              continue;
            }
            firstBuilt = true;
            built.add(`${st}::${pl.fmt}`);
            if (out.extractionForReuse && !extractionByClass.has(out.extractionForReuse.extractionClass)) {
              extractionByClass.set(out.extractionForReuse.extractionClass, out.extractionForReuse);
            }
            if (isOcsfScoredFormat(buildFmt)) {  // NG SIEM ships raw, never OCSF to post-process
              ocsfBySource.set(st, { pipelineId: pl.pipelineId, destFormat: buildFmt, sourcetype: st, packId: pk.packId, workerGroup: group, sampleName: getSampleName(st) });
            }
            const stageScores = scoresOf(out.stages);
            // null (N/A) when there is nothing to score — e.g. a passthrough raw
            // copy. Never coerce that to 0: a 0 reads as a failed build.
            // NG SIEM: the optimization stage grades what the destination receives
            // (raw fidelity) and decides the overall — see averageStageScores.
            const score = averageStageScores(stageScores.extraction, stageScores.mapping, out.stages.find(x => x.stage === 'optimization'));
            patchResult(ri, { status: 'success', phase: 'done', score, stageScores, packId: pk.packId, pipelineId: pl.pipelineId, message: `score ${score ?? 'N/A'}` });
            dlog(`✓ [${st} to ${fmtLabel(pl.fmt)}] ${pl.pipelineId} — extraction ${stageScores.extraction ?? 'n/a'} · mapping ${stageScores.mapping ?? 'n/a'} · output shaping ${stageScores.optimization ?? 'n/a'}.`);
          } catch (err) {
            patchResult(ri, { status: 'error', phase: 'done', message: err instanceof Error ? err.message : 'build failed' });
            dlog(`  ✗ [${st} to ${fmtLabel(pl.fmt)}] ${err instanceof Error ? err.message : 'failed'} (no route written).`);
          }
        }
      }

      // 3. OCSF → post-processing. The post packs' sample AND the replay feed are
      //    the OCSF pipeline's own preview output, so the replay datagen sends
      //    exactly what the live chain would deliver (the curated OCSF set only
      //    when that preview returns nothing).
      const ppOk = new Set<string>();                        // `${st}::${target}`
      const replaySources: { sourcetype: string; events: string[] }[] = [];
      for (const st of [...new Set(plan.ppPacks.map(pp => pp.sourcetype))]) {
        const mine = plan.ppPacks.filter(pp => pp.sourcetype === st);
        const upstream = ocsfBySource.get(st);
        if (!upstream) {
          mine.forEach(pp => patchResult(idxOf(st, pp.target), { status: 'error', phase: 'done', message: 'Skipped: the OCSF pipeline was not built' }));
          dlog(`⚠ [${st}] OCSF pipeline was not built — skipping its post-processing packs (they read its output).`);
          continue;
        }
        const upstreamEvents = await upstreamOcsfOutputEvents(upstream, dlog);
        if (plan.replaySourcetypes.includes(st)) {
          const recorded = upstreamEvents.length
            ? upstreamEvents
            : postProcessSampleEvents('ocsf').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Record<string, unknown>[];
          if (recorded.length) replaySources.push({ sourcetype: st, events: recorded.map(ocsfReplayLine) });
        }
        const ppResults = await buildFlowPostProcessPacks(
          mine.map(pp => pp.output), group, dlog,
          (i, p) => {
            const status = p.state === 'running' ? 'running' : p.state === 'error' ? 'error' : p.state === 'done' ? 'success' : null;
            if (status) patchResult(idxOf(st, mine[i].target), { status, phase: status === 'running' ? 'building' : 'done', ...(p.error ? { message: p.error } : {}) });
          },
          undefined,
          {
            sourcetype: st, upstreamEvents,
            packIdFor: o => demoPpPackId(st, ppEffectiveFormat(o)),
            displayNameFor: o => `[DEMO] ${st} OCSF to ${ppOutputLabel(o)}`,
          },
        );
        ppResults.forEach((r, i) => {
          if (r.error) return;
          ppOk.add(`${st}::${mine[i].target}`);
          patchResult(idxOf(st, mine[i].target), { packId: r.packId, pipelineId: r.pipelineId, message: r.optimize ? 'optimized by category' : 'full copy' });
        });
      }

      // 4. Datagens: one lane per main-pack format (only sources whose pipeline
      //    was built), plus the OCSF replay. Inactive until the deploy below.
      const datagenIds: string[] = [];
      for (const lane of plan.lanes) {
        const members = lane.sourcetypes.filter(st => built.has(`${st}::${lane.fmt}`) && eventsBySource[st]);
        if (!members.length) continue;
        const dg = await createDemoDatagen(group, members.map(st => ({ sourcetype: st, events: eventsBySource[st].split('\n').filter(Boolean) })), { datagenId: lane.id, eventsPerSec: DEMO_EVENTS_PER_SEC });
        datagenIds.push(dg.datagenId);
        dlog(`✓ Lane datagen "${dg.datagenId}" (${fmtLabel(lane.fmt)}): ${members.join(', ')} at ${DEMO_EVENTS_PER_SEC} ev/s each.`);
      }
      const replayed = replaySources.filter(r => plan.ppPacks.some(pp => pp.sourcetype === r.sourcetype && ppOk.has(`${r.sourcetype}::${pp.target}`)));
      if (replayed.length) {
        const dg = await createDemoDatagen(group, replayed, { datagenId: DEMO_OCSF_REPLAY_ID, eventsPerSec: DEMO_EVENTS_PER_SEC });
        datagenIds.push(dg.datagenId);
        dlog(`✓ OCSF replay datagen "${dg.datagenId}": ${replayed.map(r => `${r.sourcetype} (${r.events.length} recorded event${r.events.length === 1 ? '' : 's'})`).join(', ')}.`);
      }
      if (!datagenIds.length) throw new Error('Nothing was built — no datagen or route was created. See the log above.');

      // 5. "Cribl Lake" outputs resolve to the demo dataset's cribl_lake output.
      let lakeOutputId: string | null = null;
      if (plan.routes.some(r => r.output === DEMO_LAKE_OUTPUT)) {
        dlog(`Ensuring Cribl Lake output → dataset "${demoLakeDataset}"…`);
        lakeOutputId = await ensureLakeOutput(group, demoLakeDataset);
        dlog(`✓ Lake output: ${lakeOutputId}`);
      }

      // 6. The demo route block, one commented group per source, then the
      //    terminator. Cribl keys each comment by its position in the COMBINED
      //    comments+routes list — addComment() computes that index.
      const demoRouteBlock: any[] = [];
      const demoComments: { comment: string; index: number }[] = [];
      const addComment = (comment: string) => demoComments.push({ comment, index: demoRouteBlock.length + demoComments.length });
      const live = plan.routes.filter(r => r.kind === 'pp' ? ppOk.has(`${r.sourcetype}::${r.target}`) : built.has(`${r.sourcetype}::${r.target}`));
      for (const src of demoSources) {
        const mine = live.filter(r => r.sourcetype === src.sourcetype);
        if (!mine.length) continue;
        const outs = [...new Set(mine.map(r => (r.output === DEMO_LAKE_OUTPUT ? 'Cribl Lake' : r.output)))];
        addComment(`[DEMO] ${src.sourcetype} — ${mine.map(r => r.name.replace(`[DEMO] ${src.sourcetype} `, '')).join(', ')}; sends to ${outs.join(' / ')}`);
        for (const r of mine) {
          const output = r.output === DEMO_LAKE_OUTPUT ? lakeOutputId : r.output;
          demoRouteBlock.push({
            id: r.id, name: r.name, filter: sanitizeFilter(r.filter), pipeline: r.pipeline, output,
            final: false, disabled: false,
            description: `[DEMO] ${r.name.replace('[DEMO] ', '')}; sends to ${output}`,
            clones: [], enableOutputExpression: false,
          });
        }
      }
      addComment('[DEMO] Terminator — drop all demo data so it never reaches the production routes below');
      demoRouteBlock.push({
        id: 'demo_terminator',
        name: '[DEMO] terminator - drop demo data',
        filter: plan.terminatorFilter,
        pipeline: 'devnull', output: 'devnull',
        final: true, disabled: false,
        description: '[DEMO] Final catch-all so demo events never reach production routes.',
        clones: [], enableOutputExpression: false,
      });

      // 6b. Write the demo block on TOP of the master table — the one commit +
      //     deploy that makes the packs, datagens and routes live together.
      dlog(`Writing ${demoRouteBlock.length} demo route(s) + ${demoComments.length} comment(s) on top of the master routing table…`);
      const routeResult = await setMasterRoutes(group, demoRouteBlock, demoComments);
      dlog(`✓ Routing table updated (${routeResult.demoCount} demo of ${routeResult.routeCount} total). Committed ${routeResult.commit}.`);

      // 7. Optional Search experience. Reuse the exact processing samples and
      // parser field contracts prepared above; the target dataset may be empty.
      if (demoCreateDashboard) {
        const searchDatasetId = demoLakeSelected
          ? (demoDashboardDatasets.some(dataset => dataset.id === demoLakeDataset) ? demoLakeDataset : '')
          : demoDashboardDataset;
        dlog('Resolving selected Search Datatypes and sample-generated Datatype v1 parsers…');
        try {
          if (!searchDatasetId) throw new Error(demoLakeSelected
            ? `Lake dataset "${demoLakeDataset}" is not available as a federated Search v1 dataset.`
            : 'No federated Search v1 dataset was selected.');
          const dashboardSources = [];
          const datatypeIds: string[] = [];
          for (const src of demoSources) {
            const sampleEvents = eventsBySource[src.sourcetype] || await resolveSourceSample(src.sourcetype, dlog);
            const prep = await resolveSourceExtraction(src.sourcetype, sampleEvents, dlog);
            const selectedDatatypeId = demoDatatypeSelections[src.sourcetype] || '';
            if (selectedDatatypeId) {
              const selectedDatatype = demoSearchDatatypes.find(datatype => datatype.id === selectedDatatypeId);
              if (!selectedDatatype) throw new Error(`Selected Search Datatype "${selectedDatatypeId}" is no longer available. Refresh the datatype list and choose again.`);
              const fieldNames = inferSearchDatatypeFields(selectedDatatype, sampleEvents);
              datatypeIds.push(selectedDatatype.id);
              dashboardSources.push({ sourcetype: src.sourcetype, sampleEvents, parsedFieldNames: fieldNames });
              dlog(`✓ Reusing existing Datatype ${selectedDatatype.id} for ${src.sourcetype} (${fieldNames.length} dashboard field(s) inferred).`);
              continue;
            }
            const searchParser = getDatatypeParserFunctions(src.sourcetype);
            const parserFunctions = prep.aiParseFns?.functions || searchParser?.functions || getParserForSourcetype(src.sourcetype, false) || [];
            const datatype = buildSearchDatatype(src.sourcetype, sampleEvents, parserFunctions, prep.parsedFieldNames);
            const deployedDatatype = await deploySearchDatatype(datatype as unknown as Record<string, unknown>);
            datatypeIds.push(deployedDatatype.id);
            dashboardSources.push({ sourcetype: src.sourcetype, sampleEvents, parsedFieldNames: prep.parsedFieldNames });
            dlog(`✓ Datatype ${deployedDatatype.id} ${deployedDatatype.updated ? 'updated' : 'created'} (${datatype.dataFormat}, ${prep.parsedFieldNames.length} parsed field(s)).`);
          }
          const uniqueDatatypeIds = [...new Set(datatypeIds)];
          try {
            await attachSearchDatatypes(searchDatasetId, uniqueDatatypeIds);
          } catch (error) {
            throw new Error(`Datatype attachment failed: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
          dlog(`✓ Attached ${uniqueDatatypeIds.length} Datatype v1 parser(s) to federated dataset "${searchDatasetId}".`);
          dlog('Asking AI to select KPIs from the prepared samples and datatype output fields…');
          const plan = await aiDesignSearchDashboard(searchDatasetId, dashboardSources, demoDashboardStyle);
          dlog(`${plan.selectionMode === 'sample-fallback' ? '⚠ AI was unreachable; sample analysis selected' : '✓ AI selected'} ${plan.kpis.length} KPI(s): ${plan.kpis.map(k => k.title).join(', ')}.`);
          const dashboard = demoDashboardStyle === 'vizlab'
            ? buildVizlabDashboard(searchDatasetId, plan)
            : buildNativeDashboard(searchDatasetId, plan);
          let deployedDashboard;
          try {
            deployedDashboard = await deploySearchDashboard(dashboard);
          } catch (error) {
            throw new Error(`Dashboard API deployment failed: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
          setDemoDashboardResult({ id: deployedDashboard.id, name: deployedDashboard.name, kpiCount: plan.kpis.length, datatypeIds: uniqueDatatypeIds });
          dlog(`✓ ${demoDashboardStyle === 'vizlab' ? 'Viz-Lab' : 'Cribl Search'} dashboard "${deployedDashboard.name}" ${deployedDashboard.updated ? 'updated' : 'created'}.`);
        } catch (dashboardErr) {
          const message = dashboardErr instanceof Error ? dashboardErr.message : 'Dashboard creation failed';
          setDemoDashboardResult({ error: message });
          dlog(`⚠ Demo data flow is live, but the optional dashboard was not deployed: ${message}`);
        }
      }

      setDemoSummary({
        datagenIds, group, routeCount: routeResult.demoCount, lakeOutput: lakeOutputId || undefined,
        replay: plan.ppPacks.length > 0,
        eventsPerSec: demoEventsPerSecond(plan),
      });
      dlog('✓ Demo environment is live — data is flowing.');
      setStep('demo-done');
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : 'Demo creation failed');
      dlog(`✗ ${err instanceof Error ? err.message : 'failed'}`);
    }
  };

  // ===== Experimental 3-stage build/score =====================================
  // Wrap an arbitrary function list into a Cribl pipeline conf (mirrors
  // buildPipelineConfWithMappings' output shape).

  // Compute the experiment pack id the same way the orchestrator does.
  // Pack id — SAME convention as the normal generate flow: the user-typed pack
  // name, kebab-cased. Falls back to a sourcetype/format id only when no name was
  // given. No "exp-" prefix — the 3-stage build produces a real pack the user
  // named, so it appears under exactly that name.
  const expPackIdFor = (sourcetype: string, destFormat: string, nameOverride?: string) => {
    const name = (nameOverride ?? state.packName).trim();
    if (name) return packMode === 'flow' ? flowPackId(name) : toKebab(name);
    const DEST_SHORT: Record<string, string> = { commonsecuritylog: 'csl', chronicle: 'udm', nextgen: 'ngsiem' };
    return toKebab(`${sourcetype} ${DEST_SHORT[destFormat] || destFormat}`);
  };

  const runOptimizePipeline = async () => {
    setOptimizeBusy(true);
    setOptimizeError('');
    setOptimizeLog([]);
    setOptimizeResults([]);
    setOptimizeScores(null);
    setOptimizePhase('scoring');
    setOptimizeStatus('Loading pipeline and sample…');
    const log = (message: string) => setOptimizeLog(current => [...current, message]);
    const averageStageTotal = (
      ext: number | null | undefined,
      map: number | null | undefined,
    ): number | null => {
      const parts = [ext, map].filter((n): n is number => n != null && Number.isFinite(n));
      if (!parts.length) return null;
      return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
    };
    let baselineConf: any = null;
    let temporaryPatchApplied = false;
    const optimizeStart = Math.floor(Date.now() / 1000);

    try {
      const pipeline = await getPackPipeline(selectedGroup, selectedPackId, optimizePipelineId);
      baselineConf = pipeline.conf || {};
      const baselineFunctions = Array.isArray(baselineConf.functions) ? baselineConf.functions : [];
      const inferred = inferFromPipelineId(optimizePipelineId);
      // Prefer the confirmed wizard sourcetype over a raw pipeline-id parse
      // (`palo_alto_to_cim` → "palo_alto" has no CSV parser). Always canonicalize.
      const sourcetype = canonicalizeSourcetype(
        (effectiveSourcetype.trim() || inferred?.sourcetype || ''),
      );
      // Prefer the wizard family + model/table pick (same resolveDestFmt as build),
      // then fall back to the concrete format inferred from the pipeline id.
      const family = state.destFormats[0] || '';
      const fromUi = family ? resolveDestFmt(family, state) : '';
      const destFormat = fromUi || inferred?.destFormat || '';
      if (!sourcetype || !destFormat) throw new Error('Confirm the pipeline sourcetype and destination format before optimizing.');
      // Additional guidance naming an OCSF class (class_uid=3003, "Authorize
      // Session") retargets the mapping; scoring keeps the deployed format so
      // the before/after numbers stay comparable.
      const guidedOcsf = isOcsfScoredFormat(destFormat) ? parseOcsfGuidance(optimizeGuidance) : null;

      const useUpdatedSample = optimizeGoals.sample && Boolean(state.sampleEvents.trim());
      let sampleEvents = useUpdatedSample ? state.sampleEvents.trim() : '';
      // New packs store ONE sample per sourcetype; older packs stored one per
      // pipeline (`<pipelineId>_sample.log`). Read prefers the new name and falls
      // back to the legacy one so optimizing a pre-existing pack still works.
      const stableSampleName = getSampleName(sourcetype);
      const legacySampleName = `${optimizePipelineId}_sample.log`;
      let sampleName = '';
      let sampleChanged = false;
      if (sampleEvents) {
        sampleName = stableSampleName;
      } else {
        let packSample = await getPackSample(selectedGroup, selectedPackId, stableSampleName);
        if (!packSample?.events?.length) packSample = await getPackSample(selectedGroup, selectedPackId, legacySampleName);
        sampleEvents = (packSample?.events || []).join('\n').trim();
        sampleName = packSample?.name || '';
      }
      if (!sampleEvents || !sampleName) {
        throw new Error(`No sample available for "${stableSampleName}" — tick “New or updated sample” or upload one first.`);
      }

      const quality = loadQualitySettings();
      let aiSnippet: string;
      try {
        // Pack-resident samples are already on the leader — sanitising them is
        // optional. Only a freshly supplied sample (optimizeGoals.sample) is
        // gated by Require sanitised samples.
        aiSnippet = aiSampleSnippet({
          sampleEvents,
          sourceMode: useUpdatedSample ? state.sourceMode : 'pack',
          sanitised: useUpdatedSample ? state.sampleSanitised : true,
          required: useUpdatedSample && quality.requireSanitisedSamples,
          lines: 15,
        });
      } catch (error) {
        if (error instanceof UnsanitisedSampleError) {
          setOptimizeError(error.message);
          return;
        }
        throw error;
      }

      if (useUpdatedSample) {
        const events = sampleEvents.split('\n').map(line => line.trim()).filter(Boolean);
        const uploaded = await uploadPackSample(selectedGroup, selectedPackId, sampleName, events);
        if (!uploaded) throw new Error('The updated sample could not be uploaded.');
        sampleChanged = true;
        log(`Uploaded ${events.length} updated sample event(s).`);
      }

      const rawEvents = sampleEvents.split('\n').filter(Boolean).slice(0, 8);
      const sampleRaw = rawEvents[0] || '';
      const scoreCache = new Map<string, number | null>();
      const scoreCurrentPreview = async () => {
        const output = await previewPipeline({
          workerGroup: selectedGroup,
          packId: selectedPackId,
          pipelineId: optimizePipelineId,
          sourcetype,
          destFormat,
          sampleName,
          includeAi: false,
        });
        return { coverage: scoreValueCoverage(rawEvents, output), output };
      };
      // Score extraction and mapping separately — extraction = sample values in
      // named fields; mapping = dest schema filled from what extraction delivered.
      const scoreExtMapStages = async (functions: any[]) => {
        const split = splitPipelineFunctions(functions);
        const extOnly = split.extraction;
        const throughMap = [...split.extraction, ...split.mapping];
        await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, { ...baselineConf, functions: extOnly });
        temporaryPatchApplied = true;
        const extOut = await previewPipeline({
          workerGroup: selectedGroup, packId: selectedPackId, pipelineId: optimizePipelineId,
          sourcetype, destFormat, sampleName, includeAi: false,
        });
        const sExt = scoreStage('extraction', destFormat, sourcetype, rawEvents, extOut, []);
        await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, { ...baselineConf, functions: throughMap });
        const mapOut = await previewPipeline({
          workerGroup: selectedGroup, packId: selectedPackId, pipelineId: optimizePipelineId,
          sourcetype, destFormat, sampleName, includeAi: false,
        });
        const sMap = scoreStage('mapping', destFormat, sourcetype, rawEvents, mapOut, extOut);
        return {
          extraction: {
            score: sExt.score,
            band: sExt.band,
            reason: sExt.reasons[0] || '',
            output: (extOut[0] as Record<string, any> | undefined) || null,
            events: extOut,
          },
          mapping: {
            score: sMap.score,
            band: sMap.band,
            reason: sMap.reasons[0] || '',
            output: (mapOut[0] as Record<string, any> | undefined) || null,
            events: mapOut,
          },
        };
      };

      // Phase 1 — score the live pipeline first and paint it, so the user can
      // compare before/after once optimization finishes.
      log('Phase 1/2 — Scoring the live pipeline (this is not stuck)…');
      setOptimizeStatus('Scoring final output coverage (diagnostic)…');
      const baselineKey = JSON.stringify(baselineFunctions);
      const baselinePreview = await scoreCurrentPreview();
      const baselineCoverage = baselinePreview.coverage;
      const beforeOutput = (baselinePreview.output?.[0] as Record<string, any> | undefined) || null;
      log('Scoring extraction and mapping as separate stages…');
      setOptimizeStatus('Scoring extraction (parse only)…');
      const beforeStages = await scoreExtMapStages(baselineFunctions);
      // Restore the full live pipeline before AI optimize candidates run.
      await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, baselineConf);
      temporaryPatchApplied = false;
      const baselineTotal = averageStageTotal(beforeStages.extraction.score, beforeStages.mapping.score);
      // Cache the user-facing total (avg of stages) for best-wins / deploy compare.
      if (baselineTotal != null) scoreCache.set(baselineKey, baselineTotal);
      log(`Extraction ${beforeStages.extraction.score ?? 'n/a'}/100 · Mapping ${beforeStages.mapping.score ?? 'n/a'}/100 · Total (avg) ${baselineTotal ?? 'n/a'}/100`);
      log(`(Diagnostic sample→final coverage was ${baselineCoverage.score}/100 — not used as the total.)`);
      const beforeGaps = explainValueCoverageGaps(
        rawEvents,
        beforeStages.extraction.events || [],
        baselinePreview.output || [],
      );
      if (beforeGaps.droppedFields.length) {
        log(`Extracted but not kept in destination: ${beforeGaps.droppedFields.slice(0, 12).join(', ')}${beforeGaps.droppedFields.length > 12 ? '…' : ''}`);
      }
      if (beforeGaps.notExtracted.length) {
        log(`Never extracted: ${beforeGaps.notExtracted.slice(0, 8).map(g => g.value).join(', ')}${beforeGaps.notExtracted.length > 8 ? '…' : ''}`);
      }
      setOptimizeScores({
        before: baselineTotal,
        after: null,
        changed: false,
        sampleRaw,
        beforeOutput,
        afterOutput: null,
        beforeStages,
        beforeDetail: {
          totalValues: baselineCoverage.totalValues,
          coveredValues: baselineCoverage.coveredValues,
          lostValues: baselineCoverage.lostValues || [],
          gaps: beforeGaps,
        },
      });
      log(`Baseline total = average of extraction + mapping: ${baselineTotal ?? 'n/a'}.`);
      log(`Extraction: ${beforeStages.extraction.reason}`);
      log(`Mapping: ${beforeStages.mapping.reason}`);
      setOptimizeStatus('Baseline score ready — starting improvements…');
      // Yield so React paints the baseline scoreboard before AI work starts.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      // Phase 2 — optimize against that baseline.
      setOptimizePhase('optimizing');
      log('Phase 2/2 — Starting improvements…');
      const goals = (Object.entries(optimizeGoals) as [OptimizeGoal, boolean][])
        .filter(([goal, enabled]) => enabled && goal !== 'sample')
        .map(([goal]) => goal);
      const result = await optimizePipelineStages({
        workerGroup: selectedGroup,
        packId: selectedPackId,
        pipelineId: optimizePipelineId,
        sourcetype,
        destFormat,
        sampleEvents: aiSnippet,
        cimFlat: isCimFormat(destFormat) && (reductionToggles['cim_flat'] ?? false),
        baselineFunctions,
        goals,
        guidance: optimizeGuidance.trim() || undefined,
        guidedOcsf,
        thresholds: {
          extraction: quality.expExtractionThreshold ?? 80,
          mapping: quality.expMappingThreshold ?? 80,
          optimization: quality.expOptimizationThreshold ?? 80,
        },
        log,
        onStatus: setOptimizeStatus,
        onStage: stage => setOptimizeResults(current => [...current, stage]),
        scoreFns: async (functions, stage) => {
          const key = `${stage}:${JSON.stringify(functions)}`;
          if (scoreCache.has(key)) return scoreCache.get(key) ?? null;
          setOptimizeStatus(
            stage === 'extraction' ? 'Scoring extraction candidate…'
              : stage === 'mapping' ? 'Scoring mapping candidate…'
                : 'Scoring improvement candidate (avg of extraction + mapping)…',
          );
          await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, { ...baselineConf, functions });
          temporaryPatchApplied = true;
          const stages = await scoreExtMapStages(functions);
          // Restore full functions after stage-only previews.
          await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, { ...baselineConf, functions });
          let score: number | null;
          if (stage === 'extraction') score = stages.extraction.score;
          else if (stage === 'mapping') score = stages.mapping.score;
          else score = averageStageTotal(stages.extraction.score, stages.mapping.score);
          scoreCache.set(key, score);
          return score;
        },
      });

      const improved = result.stageResults.some(r => r.kept === 'new');
      let afterDetail: {
        totalValues: number;
        coveredValues: number;
        lostValues: string[];
        gaps?: CoverageGapDetail;
      } = {
        totalValues: baselineCoverage.totalValues,
        coveredValues: baselineCoverage.coveredValues,
        lostValues: baselineCoverage.lostValues || [],
        gaps: beforeGaps,
      };
      let afterOutput: Record<string, any> | null = beforeOutput;
      let afterStages = beforeStages;
      let afterTotal = baselineTotal;
      if (improved) {
        setOptimizeStatus('Deploying the winning pipeline…');
        await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, { ...baselineConf, functions: result.finalFunctions });
        await commitDeploy(selectedGroup, `Improve pipeline ${optimizePipelineId} in ${selectedPackId}`);
        log('Deployed the winning pipeline.');
        const afterPreview = await scoreCurrentPreview();
        afterOutput = (afterPreview.output?.[0] as Record<string, any> | undefined) || null;
        log('Re-scoring extraction and mapping on the winning pipeline…');
        setOptimizeStatus('Re-scoring extraction and mapping on the winner…');
        afterStages = await scoreExtMapStages(result.finalFunctions);
        // Restore full winning functions (stage scoring left through-map only).
        await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, { ...baselineConf, functions: result.finalFunctions });
        temporaryPatchApplied = false;
        afterTotal = averageStageTotal(afterStages.extraction.score, afterStages.mapping.score);
        const afterGaps = explainValueCoverageGaps(
          rawEvents,
          afterStages.extraction.events || [],
          afterPreview.output || [],
        );
        afterDetail = {
          totalValues: afterPreview.coverage.totalValues,
          coveredValues: afterPreview.coverage.coveredValues,
          lostValues: afterPreview.coverage.lostValues || [],
          gaps: afterGaps,
        };
        log(`After — Extraction ${afterStages.extraction.score ?? 'n/a'}/100 · Mapping ${afterStages.mapping.score ?? 'n/a'}/100 · Total (avg) ${afterTotal ?? 'n/a'}/100`);
        log(`Extraction: ${afterStages.extraction.reason}`);
        log(`Mapping: ${afterStages.mapping.reason}`);
        if (afterGaps.droppedFields.length) {
          log(`Extracted but not kept: ${afterGaps.droppedFields.slice(0, 12).join(', ')}${afterGaps.droppedFields.length > 12 ? '…' : ''}`);
        }
      } else {
        if (temporaryPatchApplied) {
          await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, baselineConf);
          log('Restored the original pipeline after candidate scoring.');
        }
        if (sampleChanged) {
          await commitDeploy(selectedGroup, `Update sample for pipeline ${optimizePipelineId} in ${selectedPackId}`);
          log('No function candidate beat the baseline; committed the updated sample only.');
        } else {
          log('No candidate beat the baseline; skipped the final PATCH and deploy.');
        }
      }
      setOptimizeScores({
        before: baselineTotal,
        after: afterTotal ?? baselineTotal,
        changed: improved || sampleChanged,
        sampleRaw,
        beforeOutput,
        afterOutput,
        beforeStages,
        afterStages: improved ? afterStages : beforeStages,
        beforeDetail: {
          totalValues: baselineCoverage.totalValues,
          coveredValues: baselineCoverage.coveredValues,
          lostValues: baselineCoverage.lostValues || [],
          gaps: beforeGaps,
        },
        afterDetail,
      });
      setOptimizeStatus('');
      const deploymentScore = afterTotal ?? baselineTotal;
      if (improved || sampleChanged) {
        void maybeLogScore({
          sourcetype,
          pack_id: selectedPackId,
          pipeline_id: optimizePipelineId,
          dest_format: destFormat,
          score: deploymentScore ?? 0,
          sample_name: sampleName,
          model_used: '',
          tokens_input: 0,
          tokens_output: 0,
          worker_group: selectedGroup,
          is_golden_path: false,
          generation_mode: 'optimize',
          findings_count: 0,
          status: 'success',
          deploy_message: improved
            ? `Improved pipeline (${baselineTotal ?? '?'} → ${afterTotal ?? '?'})`
            : 'Updated pipeline sample only',
          flow: 'normal',
          builder: 'staged',
          first_score: baselineTotal,
          final_score: deploymentScore,
          deployment_score: deploymentScore,
          extraction_score: afterStages.extraction.score,
          mapping_score: afterStages.mapping.score,
          optimization_score: averageStageTotal(afterStages.extraction.score, afterStages.mapping.score),
          start_time: optimizeStart,
          end_time: Math.floor(Date.now() / 1000),
        });
      }
      setStep('optimize-done');
    } catch (error) {
      if (temporaryPatchApplied && baselineConf) {
        try {
          await patchPipeline(selectedPackId, optimizePipelineId, selectedGroup, baselineConf);
          log('Restored the original pipeline after the improvement error.');
        } catch {
          log('Warning: could not restore the original pipeline after candidate scoring.');
        }
      }
      setOptimizeError(error instanceof Error ? error.message : String(error));
    } finally {
      setOptimizeBusy(false);
      setOptimizePhase('idle');
      setOptimizeStatus('');
    }
  };

  // Pre-flight: if the pack already exists, ask the user (overwrite / rename /
  // cancel) before deploying. Otherwise start the run directly. nameOverride
  // lets the conflict-rename path pass the new name without waiting for the
  // async state update to land.
  const startExperiment = async (nameOverride?: string) => {
    // The existing-pack conflict is now surfaced INLINE on the Pack Details
    // (name) screen, where the user either renamed or chose to continue
    // (overwrite). No separate pre-flight dialog here — just run.
    setExpError('');
    void runStagedExperiment(nameOverride);
  };

  // Orchestrator: build + deploy + score each stage independently.
  const runStagedExperiment = async (nameOverride?: string) => {
    setExpError('');
    setExpLog([]);
    setExpBuildTraces([]);
    setStep('experiment-running');
    const xlog = (m: string) => setExpLog(prev => [...prev, m]);
    const runStart = Math.floor(Date.now() / 1000);  // for the completion event (success OR error)
    const group = selectedGroup || state.workerGroup;
    const sourcetype = effectiveSourcetype;
    // ALL selected formats → one pipeline each in the SAME pack (first creates it,
    // the rest are added). resolveDestFmt maps 'sentinel'→table, 'manual'→custom.
    const allFormats = (state.destFormats.length ? state.destFormats : [state.destFormat]).map(f => resolveDestFmt(f, state));
    const destFormat = allFormats[0];   // first drives pack id/name + the report cards
    // A stage scoring at/above this is "good enough" — as soon as a candidate
    // (Search / golden / pack / AI) clears it, stop trying more candidates for
    // that stage and move on. >89 (≥90) is fine; e.g. a golden extraction at 90
    // means we don't bother scoring the lower-priority options and go straight
    // to mapping. Also skips the AI-improvement pass for that stage.
    const SATISFIED = 90;
    // Pack id MUST match the pre-flight check (startExperiment → expPackIdFor),
    // which honors the user-typed name (exp-<packName>, e.g. "aaa"→exp-aaa) and
    // otherwise falls back to exp-<sourcetype>-<destshort>. Deriving a different
    // id here than the pre-flight meant the deployed pack was named
    // exp-<sourcetype>-<destshort> while the user searched for "aaa".
    const packId = expPackIdFor(sourcetype, destFormat, nameOverride);
    // Pipeline id — SAME convention as the normal flow: descriptive
    // <sourcetype>_to_<destFormat>, INDEPENDENT of the pack name. Deriving it
    // from the pack name (old behaviour) made the pipeline take the pack's name
    // and could collide with an existing pipeline of that name.
    const pipelineId = getPipelineId(sourcetype, destFormat);
    setExpPackId(packId);
    // Independent per-stage golden thresholds (default 80, changeable in Settings).
    const q = loadQualitySettings();
    const thr = { extraction: q.expExtractionThreshold ?? 80, mapping: q.expMappingThreshold ?? 80, optimization: q.expOptimizationThreshold ?? 80 };
    // Whether golden sharing is configured — sub-parts publish to the shared pool
    // alongside the local save when on (create-only, per-stage threshold as the bar).
    const shareOn = goldenSharingConfigured(q);
    // Build pack flow: the destination screen's per-card Full fidelity/Optimize,
    // the noise-drop rule checkboxes and OCSF keep-original-_raw become build
    // toggles. OCSF is never optimized in the main pack.
    const buildToggles = packMode === 'flow'
      ? flowReductionToggles(reductionToggles, flowOptimize, flowOcsfKeepRaw, flowSrcRules, state.destFormats)
      : reductionToggles;
    setFlowPpResults([]);

    const init: ExpStageResult[] = [
      { stage: 'extraction', status: 'pending', score: null, band: 'na', source: 'none', reasons: [] },
      { stage: 'mapping', status: 'pending', score: null, band: 'na', source: 'none', reasons: [] },
      { stage: 'optimization', status: 'pending', score: null, band: 'na', source: 'none', reasons: [] },
    ];
    setExpStages(init);
    const results = [...init];
    // Live model for the flow Build screen: `live[curFi]` mirrors `results`.
    const live: FlowLiveFormat<ExpStageResult>[] = allFormats.map((fmt, fi) => ({
      fmt, label: flowFormatInfo(state.destFormats[fi] ?? fmt).label, pipelineId: getPipelineId(sourcetype, fmt),
      state: 'queued', stages: init.map(st => ({ ...st })),
    }));
    let curFi = -1;
    const pushLive = () => setExpLive(live.map(l => ({ ...l })));
    const setLive = (fi: number, p: Partial<FlowLiveFormat<ExpStageResult>>) => { live[fi] = { ...live[fi], ...p }; pushLive(); };
    const plannedPp = packMode === 'flow' ? ppOutputsToBuild(state.destFormats, flowPp) : [];
    const ppLive: FlowLivePp[] = plannedPp.map(o => ({ packId: ppPackIdFor(flowPp.name, effectiveSourcetype, o), label: ppOutputLabel(o), optimize: o.optimize, state: 'queued' }));
    const setPpLive = (i: number, p: Partial<FlowLivePp>) => { ppLive[i] = { ...ppLive[i], ...p }; setExpPpLive([...ppLive]); };
    setExpPpLive([...ppLive]);
    pushLive();
    setExpPhase('prep');
    setExpStartedAt(Date.now());
    const patch = (i: number, p: Partial<ExpStageResult>) => {
      results[i] = { ...results[i], ...p }; setExpStages([...results]);
      if (curFi >= 0) setLive(curFi, { stages: [...results] });
    };

    try {
      const stLabel = sourcetype.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      // Build pack flow: display name and description are the pack name itself.
      const flowName = packMode === 'flow' ? state.packName.trim() : '';
      const expDisplayName = (flowName || state.displayName || state.packName || packId).trim();
      const expPackageJson = {
        version: '1.0.0', author: 'Cribl Pack Generator (3-stage experiment)',
        tags: { streamtags: [] }, exports: [],
        displayName: expDisplayName, name: packId,
        description: flowName || state.description?.trim() || `Staged pipeline: extract ${stLabel} events, map to ${destFormat.toUpperCase()}, and apply destination output shaping.`,
      };
      const idx: Record<ExpStageId, number> = { extraction: 0, mapping: 1, optimization: 2 };
      // Map each stage result from the shared builder onto the report cards.
      const onStage = (r: { stage: ExpStageId; source: ExpStageResult['source']; score: number | null; band: ExpStageResult['band']; reasons: string[]; out: any[]; detail?: { from: string; to: string; expr: string }[]; appliedOptimizations?: { label: string; description: string; reduction?: number }[]; stats?: ExpStageStats }) => {
        const debug: ExpStageResult['debug'] = { outputEvent: r.out[0], stats: r.stats };
        if (r.stage === 'extraction') {
          debug.sampleRaw = state.sampleEvents.trim().split('\n').filter(Boolean)[0];
          debug.extractedFields = r.out[0] ? Object.fromEntries(Object.entries(r.out[0]).filter(([k]) => k !== '_raw')) : {};
        } else if (r.stage === 'mapping') {
          debug.mappings = r.detail; debug.schemaFieldCount = (r.detail || []).length;
        } else if (r.stage === 'optimization') {
          debug.appliedOptimizations = r.appliedOptimizations;
        }
        patch(idx[r.stage], { status: r.score === null && r.stage === 'mapping' ? 'skipped' : 'done', score: r.score, band: r.band, source: r.source, reasons: r.reasons, debug });
        // The next stage starts right away: show it running (the Build screen's bar and timer follow it).
        const next = results.findIndex(st => st.status === 'pending');
        if (next > idx[r.stage]) patch(next, { status: 'running' });
      };
      // Build one pipeline per selected format INTO THE SAME PACK. The first
      // creates the pack (mode:'new'); each subsequent format is added
      // (mode:'add-pipeline'). Scores are tracked per pipeline.
      const deployed: DeployedPipeline[] = [];
      const perFormat: { format: string; pipelineId: string; stages: ExpStageResult[] }[] = [];
      if (allFormats.length > 1) xlog(`Building ${allFormats.length} pipelines (one per format: ${allFormats.join(', ')}) into pack ${packId}…`);
      // Resolve the AI parse ONCE for this source (not per format) — extraction is
      // destination-independent, so re-running it per format wasted an AI call
      // each time AND (for unknown sources with no static parser) let each format
      // fall to a JSON-serde fallback that scored 0. buildStagedPipeline reuses
      // these as the top extraction candidate for every format.
      let expPreparedFns: any[] | undefined;
      try {
        const parse = await resolveParseFunctions({ sourcetype, sampleEvents: state.sampleEvents, log: xlog, model: loadQualitySettings().normalModel, sourceMode: state.sourceMode, sanitised: state.sampleSanitised });
        expPreparedFns = parse.aiParseFns?.functions;
      } catch { /* known sources / no sample → builder resolves per format as before */ }
      // Extraction is destination-independent WITHIN an extraction class (mapped
      // schema vs raw/json — Hard Rule 10). Cache the first successful extraction
      // per class and hand it to sibling formats of the SAME class so we neither
      // re-run the candidate loop / AI nor re-upload the shared sample. Keyed by
      // class because a CIM parser emits canonical names a raw/json dest wouldn't want.
      const expExtractionByClass = new Map<'mapped' | 'raw', PreparedExtraction>();
      const extractionClassOf = (f: string): 'mapped' | 'raw' =>
        ['json', 'manual', 'raw', 'raw_fields', 'passthrough', ''].includes(flowBuildFormat(f)) ? 'raw' : 'mapped';
      let firstBuilt = false;
      for (let fi = 0; fi < allFormats.length; fi++) {
        const fmt = allFormats[fi];
        const plId = getPipelineId(sourcetype, fmt);
        const expPreparedExtraction = expExtractionByClass.get(extractionClassOf(fmt)) ?? null;
        if (allFormats.length > 1) xlog(`[${fi + 1}/${allFormats.length}] ${fmt.toUpperCase()} → pipeline ${plId}`);
        // Reset the stage cards for this format's live progress display.
        setExpStages([...init]); results.splice(0, results.length, ...init.map(s => ({ ...s })));
        curFi = fi; setExpPhase('build'); setLive(fi, { state: 'running' });
        patch(0, { status: 'running', message: `Building extraction (${fmt})…` });
        // Flow-only keys (Splunk/Elastic raw + JSON) build as their base format
        // but keep their own pipeline id, so e.g. Splunk raw and Elastic raw coexist.
        const buildFmt = flowBuildFormat(fmt);
        const built = await buildStagedPipeline({
          sourcetype, destFormat: buildFmt, sampleEvents: state.sampleEvents, group, packId, pipelineId: plId,
          packageJson: expPackageJson, reductionToggles: buildToggles, thresholds: thr, shareOn, satisfied: SATISFIED,
          origin: 'create', mode: firstBuilt ? 'add-pipeline' : 'new', preparedParseFns: expPreparedFns,
          // Single sourcetype across all formats → the first pipeline uploads the
          // shared `<sourcetype>_sample.log`; siblings reference it, don't re-upload.
          uploadSample: !firstBuilt,
          // The destination this pipeline feeds (`splunk_raw` builds as
          // passthrough) — selects the Splunk host/source/sourcetype contract.
          destinationKey: fmt,
          preparedExtraction: expPreparedExtraction, allFormats, allowCode: allowCodeFunctions, cimModel: state.cimModel, log: xlog, logScore: maybeLogScore, onStage,
          sampleSourceMode: state.sourceMode,
          sampleSanitised: state.sampleSanitised,
          sampleReason: existingSampleLabel || undefined,
          // Build pack flow: the main pack takes every event its route sends in.
          ...(packMode === 'flow' ? { routeFilter: FLOW_ROUTE_FILTER } : {}),
          onTrace: trace => setExpBuildTraces(prev => [
            ...prev.filter(item => item.context.pipelineId !== trace.context.pipelineId),
            trace,
          ]),
        });
        if (!built) {
          if (!firstBuilt) { setExpError('No sample events — go back and provide a sample.'); setStep(packMode === 'flow' ? 'destination' : 'experiment-setup'); return; }
          xlog(`⚠ ${fmt} produced no pipeline — skipped.`); setLive(fi, { state: 'skipped' }); continue;
        }
        firstBuilt = true;
        // A stage the builder never reported (nothing to do for this format) ends as n/a, not "running".
        setLive(fi, { state: 'done', stages: live[fi].stages.map(st => (st.status === 'running' || st.status === 'pending' ? { ...st, status: 'skipped' } : st)) });
        // Cache this format's extraction for reuse by later formats of the same
        // class (only the FIRST of a class populates it — first-writer-wins).
        if (built.extractionForReuse) {
          const cls = built.extractionForReuse.extractionClass;
          if (!expExtractionByClass.has(cls)) expExtractionByClass.set(cls, built.extractionForReuse);
        }
        deployed.push({ pipelineId: plId, destFormat: buildFmt, sourcetype, packId, workerGroup: group, sampleName: getSampleName(sourcetype) });
        perFormat.push({ format: fmt, pipelineId: plId, stages: results.map(s => ({ ...s })) });
      }
      if (!firstBuilt) { setExpError('No pipeline could be built.'); setStep(packMode === 'flow' ? 'destination' : 'experiment-setup'); return; }
      setExpPerFormatStages(perFormat);

      // Build pack flow: the post-processing packs, deferred like the main pack
      // so the ONE commit+deploy below makes everything live together.
      if (packMode === 'flow') {
        const ppOuts = ppOutputsToBuild(state.destFormats, flowPp);
        if (ppOuts.length) setExpPhase('post');
        if (ppOuts.length && !deployed.some(d => isOcsfFormat(d.destFormat))) {
          xlog('⚠ OCSF pipeline was not built — skipping the post-processing packs (they read its output).');
          ppLive.forEach((_, i) => setPpLive(i, { state: 'skipped', error: 'Skipped: no OCSF pipeline' }));
          setFlowPpResults(ppOuts.map(o => ({ label: ppOutputLabel(o), packId: ppPackIdFor(flowPp.name, effectiveSourcetype, o), pipelineId: '', optimize: o.optimize, error: 'Skipped: no OCSF pipeline' })));
        } else if (ppOuts.length) {
          const ppResults = await buildFlowPostProcessPacks(ppOuts, group, xlog, setPpLive, deployed.find(d => isOcsfFormat(d.destFormat)));
          setFlowPpResults(ppResults);
          // Successful + scored post-process packs get their own tab in the
          // same <ScoringReport> as the main pipeline's formats (one array,
          // one report) — only the pass/fail list stays separate for packs
          // that errored or couldn't be scored (no upstream sample to score against).
          for (const r of ppResults) {
            if (r.error || !r.stages) continue;
            setExpPerFormatStages(prev => [...prev, { format: r.destFormat || r.label, pipelineId: r.pipelineId, stages: r.stages! }]);
            deployed.push({ pipelineId: r.pipelineId, destFormat: r.destFormat || 'ocsf', sourcetype: 'ocsf', packId: r.packId, workerGroup: group, sampleName: getSampleName('ocsf') });
          }
        }
      }

      // Single commit + deploy at the end — every pipeline was built/patched with
      // deferDeploy, so this is the ONE cycle that makes them all live.
      try {
        setExpPhase('deploy');
        xlog('Committing + deploying the pack (once)…');
        await commitDeploy(group, `Deploy 3-stage pack ${packId}`);
        xlog(`✓ Pack ${packId} deployed on ${group} (${deployed.length} pipeline${deployed.length > 1 ? 's' : ''}).`);
      } catch (e) {
        xlog(`⚠ Final deploy failed: ${e instanceof Error ? e.message : 'unknown'} — pack is built; redeploy the group in Cribl.`);
      }
      setExpPhase('done');
      xlog('✓ 3-stage experiment complete.');
      // Expose ALL deployed pipelines to the on-demand "Pipeline Quality Check".
      setDeployedPipelines(deployed);
      setValidationReports({});
      setRepairSelection(new Set());
      setValidationError('');
      setStep('experiment-done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Experiment failed';
      setExpError(msg);
      xlog(`✗ ${msg}`);
      if (curFi >= 0 && live[curFi].state === 'running') setLive(curFi, { state: 'error' });
      // Emit a completion event for the FAILURE too — so a scorecard is sent
      // whether the process ends in success or error (not only the happy path).
      // Use whatever partial per-stage scores were captured before the throw.
      const ex = results.find(s => s.stage === 'extraction');
      const mp = results.find(s => s.stage === 'mapping');
      const op = results.find(s => s.stage === 'optimization');
      void maybeLogScore({
        sourcetype, pack_id: packId, pipeline_id: pipelineId, dest_format: destFormat,
        score: 0, sample_name: getSampleName(sourcetype), model_used: '', tokens_input: 0, tokens_output: 0,
        worker_group: group, is_golden_path: false, generation_mode: 'staged', findings_count: 0,
        status: 'error', deploy_message: `3-stage build failed (create): ${msg}`.slice(0, 300),
        flow: 'normal', builder: 'staged', build_mode: 'new', origin: 'create',
        first_score: 0, final_score: 0, deployment_score: 0,
        extraction_score: ex?.score ?? null, mapping_score: mp?.score ?? null, optimization_score: op?.score ?? null,
        extraction_source: ex?.source, mapping_source: mp?.source, optimization_source: op?.source,
        start_time: runStart, end_time: Math.floor(Date.now() / 1000),
      });
    }
  };

  // Scan the selected group for existing demo artifacts and open the cleanup step.
  const openDemoCleanup = async () => {
    setDemoError('');
    setDemoScan(null);
    setDemoCleanupResult(null);
    setDemoCleanupSel({ routes: new Set(), datagens: new Set(), packs: new Set(), outputs: new Set() });
    setDemoScanLoading(true);
    setStep('demo-cleanup');
    try {
      const scan = await scanDemo(selectedGroup);
      setDemoScan(scan);
      // Pre-select everything found — the common case is "remove it all".
      setDemoCleanupSel({
        routes: new Set(scan.routes.map(r => r.id)),
        datagens: new Set(scan.datagens.map(d => d.id)),
        packs: new Set(scan.packs.map(p => p.id)),
        outputs: new Set((scan.outputs || []).map(o => o.id)),
      });
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : 'Failed to scan for demo artifacts');
    } finally {
      setDemoScanLoading(false);
    }
  };

  const toggleCleanupSel = (kind: 'routes' | 'datagens' | 'packs' | 'outputs', id: string) => {
    setDemoCleanupSel(prev => {
      const next = new Set(prev[kind]);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...prev, [kind]: next };
    });
  };

  // Remove the selected demo artifacts in sequence (routes → datagen → packs).
  const runDemoCleanup = async () => {
    if (!demoScan) return;
    setDemoCleaning(true);
    setDemoError('');
    try {
      const result = await cleanupDemo(selectedGroup, {
        routeIds: [...demoCleanupSel.routes],
        datagenIds: [...demoCleanupSel.datagens],
        packIds: [...demoCleanupSel.packs],
        outputIds: [...demoCleanupSel.outputs],
      });
      setDemoCleanupResult({ ...result.removed, errors: result.errors });
      setStep('demo-cleanup-done');
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setDemoCleaning(false);
    }
  };

  const effectiveSourcetype = isCustomSourcetype ? customSourcetype : sourcetype;
  const flowAutoName = flowDefaultPackName(effectiveSourcetype, state.destFormats);
  useEffect(() => {
    if (packMode === 'flow' && !flowNameEdited && effectiveSourcetype && state.packName !== flowAutoName) {
      setState(prev => ({ ...prev, packName: flowAutoName }));
    }
  }, [packMode, flowNameEdited, effectiveSourcetype, flowAutoName, state.packName]);

  // Derive the multi-format picker + baseline recognition metadata from the
  // effective sourcetype. Most multi-format sources (fortinet, zscaler,
  // checkpoint) are picked from the catalog — not custom-confirmed — so the
  // picker can't rely on applyRecognition alone. This effect fills the gap: it
  // computes the format spec for ANY selected source, and seeds recognitionMeta
  // from the local recognizer UNLESS applyRecognition already enriched THIS exact
  // source with richer AI metadata (tracked via recognitionForRef).
  useEffect(() => {
    const st = effectiveSourcetype.trim();
    if (!st) { setMultiFormatSpec(null); setConfirmedFormat(''); setRecognitionMeta(null); return; }
    const spec = getMultiFormatSpec(st);
    setMultiFormatSpec(spec);
    setConfirmedFormat(prev => spec ? (spec.formats.some(f => f.id === prev) ? prev : (spec.formats[0]?.id || '')) : '');
    if (recognitionForRef.current !== st) {
      const rec = recognizeSourcetype(st);
      setRecognitionMeta({ vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSourcetype]);

  // Auto-repair XML events that were incorrectly broken on newlines instead of
  // <Event> boundaries (Windows Event Log XML has newlines inside ScriptBlockText).
  const repairXmlEventBreaking = (content: string): string => {
    if (!content.includes('<Event')) return content;
    const lines = content.split('\n');
    const eventStarts = lines.filter(l => /^\s*<Event[\s>]/.test(l)).length;
    if (eventStarts < 2 || eventStarts >= lines.length * 0.5) return content;
    const concatenated = lines.join('');
    const events = concatenated.split(/(?=<Event[\s>])/).filter(e => e.trim());
    if (events.length >= eventStarts) {
      setSampleRepairNotice(`XML event boundaries repaired: ${lines.length} line fragments reassembled into ${events.length} complete events.`);
      return events.join('\n');
    }
    return content;
  };

  // Shared sample-file reader used by both the file <input> and the drag-drop
  // zone, so dropping a file behaves identically to browsing to one (including
  // the JSON-array _raw extraction below).
  const readSampleFile = (file: File) => {
    setSampleRepairNotice('');
    const reader = new FileReader();
    reader.onload = () => {
      let content = reader.result as string;
      // If the file is a JSON array, extract _raw from each event
      const trimmed = content.trim();
      if (trimmed.startsWith('[')) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr) && arr.length > 0) {
            content = arr.map((evt: any) => {
              if (typeof evt === 'string') return evt;
              if (evt._raw) return evt._raw;
              return JSON.stringify(evt);
            }).join('\n');
          }
        } catch { /* not valid JSON array, use as-is */ }
      }
      content = repairXmlEventBreaking(content);
      update({ sampleEvents: content });
      // Explicit rather than read from state: this runs in the same tick as the update
      // above, and the privacy gate must not be decided by a stale `sourceMode`.
      detectSourcetype(content, { sourceMode: 'upload', sanitised: false });
    };
    reader.readAsText(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readSampleFile(file);
  };

  // --- Local pseudonymisation of the sample -------------------------------------
  // Uploaded / worker-group / pasted / captured events are customer data, and this app
  // puts sample lines into AI prompts. Sanitising happens in the SanitizeWizard modal
  // (the same flow as the Sample Library): the reviewer opens it, reviews and applies the
  // replacements entirely in the browser, and the sanitised events are handed back here
  // via `onApplySanitised`. No request is made — the wizard runs the local sanitiser only.

  // The wizard hands back the sanitised events. Snapshot the current sample first so the
  // banner's Undo can restore it, then load the sanitised text and mark the sample clean.
  // The wizard may also have corrected the sourcetype; adopt it so the pack is built for
  // the sourcetype the reviewer confirmed.
  const onApplySanitised = (events: string[], sanitisedSourcetype: string, warning?: string | null) => {
    setSanitisePrev(state.sampleEvents);
    setSanitiseWarning(warning || null);
    update({ sampleEvents: events.join('\n'), sampleSanitised: true });
    const st = (sanitisedSourcetype || '').trim();
    if (st && st !== effectiveSourcetype) {
      sourcetypeSelectionOrigin.current = 'user';
      setCustomSourcetype(st);
      setIsCustomSourcetype(true);
    }
    setSanitiseModalOpen(false);
  };

  const undoSanitise = () => {
    if (sanitisePrev === null) return;
    update({ sampleEvents: sanitisePrev, sampleSanitised: false });
    setSanitisePrev(null);
    setSanitiseWarning(null);
  };

  // AI / reference / library samples never need sanitising. If the user switches into one
  // of those modes after sanitising a customer paste, drop the undo snapshot and the
  // sanitised flag so the banner cannot linger on data that is already clean.
  useEffect(() => {
    if (sampleNeedsSanitising(state.sourceMode)) return;
    if (sanitisePrev !== null) setSanitisePrev(null);
    if (sanitiseWarning !== null) setSanitiseWarning(null);
  }, [state.sourceMode]); // eslint-disable-line react-hooks/exhaustive-deps — clear only on mode change

  // Cribl sourcetype naming convention: lowercase, underscore-separated, alphanumeric only.
  const normalizeSourcetypeName = (s: string) =>
    s.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');

  // On a successful confirm, capture the recognition metadata and decide whether
  // this source needs a format-picker (multi-format vendors). Shared by every
  // interactive confirm path so grounding + the picker behave identically.
  // Tracks the sourcetype that applyRecognition last enriched (with AI-supplied
  // description/logFormat/typicalFields). The derived effect below keys off this
  // so it doesn't overwrite the richer confirm-time metadata for that source.
  const recognitionForRef = useRef<string>('');
  const applyRecognition = (canonical: string, meta?: { vendor?: string; product?: string; logFamily?: string; logFormat?: string; typicalFields?: string[] }) => {
    // When a match was picked directly (no AI meta), re-run the local recognizer
    // so we still ground on vendor/product/log-family.
    let effectiveMeta = meta;
    if (!effectiveMeta && canonical) {
      const rec = recognizeSourcetype(canonical);
      effectiveMeta = { vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily };
    }
    recognitionForRef.current = canonical;
    setRecognitionMeta(effectiveMeta || null);
    const spec = getMultiFormatSpec(canonical);
    setMultiFormatSpec(spec);
    setConfirmedFormat(spec ? (spec.formats[0]?.id || '') : '');
  };

  const validateSourcetype = async (st: string) => {
    setValidationHint('');
    setValidationSuggestions([]);
    setStMatches([]);
    setCustomConfirmed(false);
    if (!st.trim()) return;
    setValidating(true);
    try {
      // Local recognizer first (instant, offline), then AI fallback for
      // suggestions — same engine as batch preflight.
      const res = await confirmSourcetype(st);
      if (res.ok) {
        // Adopt the confirmed canonical so the rest of the wizard builds the
        // recognized source (e.g. an alias like "pan_traffic" → palo_alto_traffic).
        const finalCanonical = res.canonical || customSourcetype;
        if (res.canonical && res.canonical !== customSourcetype) setCustomSourcetype(res.canonical);
        applyRecognition(finalCanonical, res.meta);
        setCustomConfirmed(true);
      } else {
        // Not an exact match — run the catalog search NOW (on Confirm, not
        // as-you-type) and show the matches to pick from.
        const matches = searchSupportedSourcetypes(st);
        setStMatches(matches);
        // Prefer the confirm result's own hint — it carries the specific reason
        // (e.g. "sap" is a vendor family, pick which logs you have).
        setValidationHint(res.hint
          || (matches.length
            ? `No exact match for "${st}". Pick a supported sourcetype below, or refine the name and Confirm again.`
            : `No supported sourcetype matches "${st}". Refine the name (vendor_product) and Confirm again.`));
        setValidationSuggestions(res.suggestions.filter(s => !matches.some(m => m.name === s)));
        setCustomConfirmed(false);
      }
    } catch {
      setCustomConfirmed(true);
    } finally {
      setValidating(false);
    }
  };

  // (Legacy custom-destination validation helpers removed — Sentinel is now a
  // first-class card with a table sub-selector; no free-text custom entry.)

  const fetchAiSamples = async (st: string) => {
    setSamplesLoading(true);
    setAiSteps([]);
    update({ sampleEvents: '' });

    const onProgress: AiProgressCallback = (step, detail) => {
      setAiSteps(prev => {
        const last = prev[prev.length - 1];
        if (last && last.step === step) {
          return [...prev.slice(0, -1), { step, detail: detail || step, time: Date.now() }];
        }
        return [...prev, { step, detail: detail || step, time: Date.now() }];
      });
    };

    // Ground AI generation on the recognition metadata + any user-confirmed
    // wire format so the model emits events that match the REAL product.
    const grounding: SampleGrounding | undefined = buildSampleGroundingContext(recognitionMeta || undefined, st, confirmedFormat || undefined);

    try {
      const source = getPublicSource(st, sampleSourceId);
      if (sampleSourceId === 'built-in') {
        const events = generateSamples(st);
        update({ sampleEvents: repairXmlEventBreaking(events) });
        onProgress('done', `Loaded ${events.split('\n').filter(Boolean).length} built-in events without AI.`);
      } else if (sampleSourceId === 'hybrid' && source === undefined) {
        const sources = getAvailableSources(st, hasBuiltInSamples(st));
        const publicSource = sources.find(s => s.type === 'public');
        if (publicSource?.url) {
          onProgress('generating', `Fetching public samples and augmenting with AI...`);
          const data = await fetchHybridSamples(publicSource.url, publicSource.format || 'text', st, sampleCount);
          update({ sampleEvents: repairXmlEventBreaking(data.events.join('\n')) });
          onProgress('done', data.cached
            ? `Reused ${data.events.length} saved hybrid events.`
            : `Loaded and saved ${data.events.length} events (hybrid public + AI).`);
        } else {
          const data = await aiSamples(st, sampleCount, generateMode, onProgress, grounding);
          update({ sampleEvents: data.events.join('\n') });
        }
      } else if (source?.type === 'public' && source.url) {
        onProgress('generating', `Fetching public sample dataset for ${st}...`);
        const data = await fetchPublicSamples(source.url, source.format || 'text', sampleCount);
        update({ sampleEvents: repairXmlEventBreaking(data.events.join('\n')) });
        onProgress('done', `Loaded ${data.events.length} events from public dataset.`);
      } else {
        const data = await aiSamples(st, sampleCount, generateMode, onProgress, grounding);
        update({ sampleEvents: data.events.join('\n') });
      }
    } catch {
      update({ sampleEvents: generateSamples(st) });
      onProgress('done', 'Fell back to built-in sample templates.');
    } finally {
      setSamplesLoading(false);
    }
  };

  // Load a real reference sample (from the professional-pack sample library).
  // An explicitly selected reference must never silently turn into AI data.
  const fetchReferenceSampleEvents = async (st: string, format?: string) => {
    setRefSampleLoading(true);
    setError('');
    setSampleRepairNotice('');
    update({ sampleEvents: '' });
    try {
      // A selected format is exact: do not extend a Palo/contract sample with AI,
      // and do not let a native KVP catalog entry shadow the requested CEF sample.
      const data = await fetchReferenceSample(st, format, format ? { extend: false } : undefined);
      if (data.available && data.events && data.events.length > 0) {
        setSampleSourceId('reference');
        if (format) setConfirmedFormat(format);
        update({ sampleEvents: repairXmlEventBreaking(flattenEventsToLines(data.events)) });
      } else {
        setSampleSourceId('ai-generate');
        setError('This reference sample is not available in the current build. Select AI-generated samples or provide your own events.');
      }
    } catch (err) {
      setSampleSourceId('ai-generate');
      setError(`Could not load the reference sample: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setRefSampleLoading(false);
    }
  };

  const fetchLiveCapture = async () => {
    const group = selectedGroup || state.workerGroup;
    if (!group) return;
    setCaptureLoading(true);
    setError('');
    setSampleRepairNotice('');
    update({ sampleEvents: '' });
    try {
      const data = await liveCapture(group, captureFilter || 'true', captureMaxEvents, captureDuration * 1000);
      if (data.events && data.events.length > 0) {
        const joined = repairXmlEventBreaking(data.events.join('\n'));
        update({ sampleEvents: joined });
        detectSourcetype(joined, { sourceMode: 'live-capture', sanitised: false });
      } else {
        setError(`No events matched the filter "${captureFilter || 'true'}" during the ${captureDuration}s capture window. Ensure traffic is actively flowing and the filter matches your data.`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Live capture failed';
      setError(message);
    } finally {
      setCaptureLoading(false);
    }
  };

  // Label the worker-group sample list with each sample's wire format. Downloads
  // are sequential and capped (SAMPLE_FORMAT_SNIFF_LIMIT visible rows,
  // SAMPLE_FORMAT_SNIFF_MAX_BYTES per file) so listing 200 samples cannot turn into
  // 200 concurrent content fetches; anything skipped is shown as "format unknown"
  // rather than silently left blank. Results are keyed by sample id and remembered
  // for the session, so filtering the list does not re-download.
  useEffect(() => {
    if (state.sourceMode !== 'existing' || existingSamples.length === 0) return;
    const group = selectedGroup || state.workerGroup;
    if (!group) return;
    const needle = sampleSearchFilter.toLowerCase();
    const todo = existingSamples
      .filter(s => s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle) || (s.packName || '').toLowerCase().includes(needle))
      .filter(s => !sampleFormatAttempted.current.has(sampleKey(s)))
      .slice(0, SAMPLE_FORMAT_SNIFF_LIMIT);
    if (todo.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const s of todo) {
        if (cancelled) return;
        const key = sampleKey(s);
        sampleFormatAttempted.current.add(key);
        if (s.size > SAMPLE_FORMAT_SNIFF_MAX_BYTES) {
          setSampleFormats(prev => ({ ...prev, [key]: 'unknown' }));
          continue;
        }
        setSampleFormats(prev => ({ ...prev, [key]: 'busy' }));
        try {
          const data = s.packId
            ? await downloadPackSample(group, s.packId, s.id)
            : await downloadSample(group, s.id);
          // Same flattening the loader applies, so the badge describes the events as
          // the pipeline will see them (a pretty-printed JSON sample is JSON, not text).
          const desc = describeSampleFormat(flattenEventsToLines(data.events || []).split('\n').filter(Boolean));
          if (!cancelled) setSampleFormats(prev => ({ ...prev, [key]: desc }));
        } catch {
          if (!cancelled) setSampleFormats(prev => ({ ...prev, [key]: 'unknown' }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sourceMode, existingSamples, sampleSearchFilter, selectedGroup, state.workerGroup]);

  // Optimize goals: check the (inferred or typed) sourcetype when the step is
  // entered so aliases canonicalize and Next stays gated on a confirmed name.
  useEffect(() => {
    if (step !== 'optimize-goals') return;
    const st = (customSourcetype || sourcetype).trim();
    if (!st || customConfirmed) return;
    void validateSourcetype(st);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, optimizePipelineId]);

  // Same idea for the recommended "reference sample" option: it is offered as real
  // vendor events, and which of the source's formats those events are in decides the
  // whole pack. One fetch per chosen sourcetype, cached under `ref:<sourcetype>`; the
  // events are re-fetched (and cached by the API layer) if the user picks it.
  useEffect(() => {
    const st = effectiveSourcetype.trim();
    if (state.sourceMode !== 'ai-generate' || state.sampleEvents || !st) return;
    if (!referenceAvailability[st]?.hasSamples) return;
    const key = `ref:${st}`;
    if (sampleFormatAttempted.current.has(key)) return;
    sampleFormatAttempted.current.add(key);
    let cancelled = false;
    void (async () => {
      setSampleFormats(prev => ({ ...prev, [key]: 'busy' }));
      try {
        // extend:false — labelling a sample must never trigger a 60-240s AI extension.
        const data = await fetchReferenceSample(st, undefined, { extend: false });
        // Reference events arrive as {_raw} objects (and sometimes pretty-printed
        // JSON), so classify exactly what the loader would put on screen — a raw
        // String(event) reads every source as "[object Object]" free text.
        const lines = flattenEventsToLines(data?.events || []).split('\n').filter(Boolean);
        if (!cancelled) setSampleFormats(prev => ({ ...prev, [key]: lines.length ? describeSampleFormat(lines) : 'unknown' }));
      } catch {
        if (!cancelled) setSampleFormats(prev => ({ ...prev, [key]: 'unknown' }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSourcetype, state.sourceMode, state.sampleEvents, referenceAvailability]);

  // A loaded sample is the ground truth about the wire format, so adopt its variant.
  // Without this, a multi-format source kept the recognizer's default (the FIRST
  // listed variant) even when the events on screen were plainly another one, and that
  // default is what grounds later sample generation and format hints.
  useEffect(() => {
    if (!state.sampleEvents || !multiFormatSpec) return;
    const desc = describeSampleFormat(state.sampleEvents.split('\n').slice(0, 50));
    const match = multiFormatSpec.formats.find(f => sampleFormatMatchesVariant(desc, f.id));
    if (match && match.id !== confirmedFormat) setConfirmedFormat(match.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sampleEvents, multiFormatSpec]);

  const fetchExistingSamples = async () => {
    const group = selectedGroup || state.workerGroup;
    if (!group) return;
    setSamplesListLoading(true);
    try {
      // Worker-group system samples AND samples inside installed packs in this group
      // (iframe only; standalone/proxy dev falls back to group samples).
      const samples = await listGroupAndPackSamples(group);
      // Sample ids are per worker group — forget what we sniffed for another one.
      sampleFormatAttempted.current = new Set();
      setSampleFormats({});
      setExistingSamples(samples);
    } catch { /* ignore */ }
    setSamplesListLoading(false);
  };

  const loadExistingSample = async (sampleId: string, sampleName?: string, packId?: string) => {
    const group = selectedGroup || state.workerGroup;
    if (!group) return;
    setExistingSampleLabel(sampleName || sampleId);
    setSamplesLoading(true);
    setError('');
    setSampleRepairNotice('');
    update({ sampleEvents: '' });
    try {
      const data = packId
        ? await downloadPackSample(group, packId, sampleId)
        : await downloadSample(group, sampleId);
      if (data.events && data.events.length > 0) {
        const joined = repairXmlEventBreaking(data.events.join('\n'));
        // A `sanitised__*` record IS the sanitised library (its events only exist
        // because they passed the library's strict gates), so loading one back must
        // not ask for sanitising a second time — that nag was the reason a library
        // sample looked blocked in the wizard. Everything else on a worker group is
        // treated as customer estate data, which is the safe default.
        const alreadyClean = isSanitisedLibrarySampleName(sampleName || '');
        update({ sampleEvents: joined, sampleSanitised: alreadyClean });
        if (alreadyClean) setSanitisePrev(null);
        detectSourcetype(joined, { sourceMode: 'existing', sanitised: alreadyClean });
      } else {
        setError('Sample file is empty.');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load sample';
      setError(message);
    } finally {
      setSamplesLoading(false);
    }
  };

  /**
   * Identify the sourcetype — locally first, and never at the cost of the privacy rule.
   *
   * This runs the instant a sample loads, which makes it the earliest point at which raw
   * customer events could leave the browser. Two consequences shape it:
   *
   * 1. LOCAL FIRST. Matching the sample against the stock datatype parsers costs nothing,
   *    sends nothing, and settles the common formats outright. Asking a model to name a
   *    format the repo can already recognise was always the wrong order.
   * 2. THE AI FALLBACK IS GATED. Un-sanitised uploads, worker-group samples, pastes and
   *    captures do not get sent, because "no customer data reaches the provider" cannot
   *    have an exception for the one call that happens before the user sees the button.
   *    Detection resumes on demand once the sample has been sanitised.
   */
  const detectSourcetype = async (events: string, opts: { sourceMode?: string; sanitised?: boolean } = {}) => {
    setDetecting(true);
    setDetectedSourcetype('');
    setDetectConfidence('');
    setDetectReason('');

    const adopt = (name: string, confidence: string, reason: string) => {
      setDetectedSourcetype(name);
      setDetectConfidence(confidence);
      const decision = resolveDetectedSourcetype(
        effectiveSourcetype,
        name,
        sourcetypeSelectionOrigin.current === 'user',
      );
      if (!decision.adopt) {
        setDetectReason(`${reason}${reason ? ' ' : ''}Suggested "${name}"; keeping your selected sourcetype "${decision.selected}".`);
        return;
      }
      setDetectReason(reason);
      sourcetypeSelectionOrigin.current = 'auto';
      const known = SOURCETYPES.find(s => s.value === name);
      if (known) {
        setSourcetype(name);
        setIsCustomSourcetype(false);
      } else {
        setCustomSourcetype(name);
        setIsCustomSourcetype(true);
      }
    };

    // Tier 0 — format first. A CEF sample (bare or syslog-framed) names its own
    // source in the header, so the vendor is READ, never guessed from extension
    // keys by a vendor datatype regex (framed Infoblox CEF used to match the
    // VMware NSX syslog parser at 100%). `recognizeCefSource` adopts the vendor's
    // sourcetype only where its parser reads CEF (FortiGate, Check Point); every
    // other vendor builds as generic `cef`.
    try {
      const cefSource = recognizeCefSource(events);
      if (cefSource) {
        adopt(cefSource.sourcetype, 'high', `Recognised locally: ${cefSource.reason}`);
        setDetecting(false);
        return;
      }
    } catch { /* a local recogniser fault must not stop the AI path below */ }

    // Tier 1 — offline. `matchDatatypeParserBySample` only answers above a high bar, so a
    // result here is a parser that clearly fits this content rather than a best guess.
    try {
      const match = matchDatatypeParserBySample(events);
      if (match) {
        const rec = recognizeSourcetype(match.parserKey);
        const name = rec.canonical || match.parserKey;
        const fmt = describeSampleFormat(events);
        adopt(name,
          match.confidence >= 0.9 ? 'high' : match.confidence >= 0.75 ? 'medium' : 'low',
          `Recognised locally: the ${fmt.label} content matches the ${match.parserKey} parser (${match.method} match, ${Math.round(match.confidence * 100)}%). No data left your browser.`);
        setDetecting(false);
        return;
      }
    } catch { /* a local recogniser fault must not stop the AI path below */ }

    // Tier 1b — offline JSON key signature. Every JSON datatype parser is a bare
    // `json` serde declaring only fields:["_raw"], so Tier 1's field-overlap signal
    // can never name a SPECIFIC JSON source: an O365 Unified Audit Log fell through
    // to the AI gate below and, for real estate events, stopped at "not recognised".
    // This names well-known JSON feeds from their top-level keys, still 100% offline.
    try {
      const sig = matchJsonSignature(events);
      if (sig) {
        const rec = recognizeSourcetype(sig.sourcetype);
        adopt(rec.canonical || sig.sourcetype, 'high',
          `Recognised locally: ${sig.description} — identified by its JSON key signature (${sig.matched.join(', ')}). No data left your browser.`);
        setDetecting(false);
        return;
      }
    } catch { /* a local recogniser fault must not stop the AI path below */ }

    // Tier 1c — offline distinctive-signature match. Some golden sources
    // fingerprint as keyless `unstructured` (so Tier 1's field/regex-parser
    // signals can't name them) yet carry a raw marker unique enough to identify
    // on sight — the SAP SAL binary TLV export is the case: its file is usually
    // named only by a numeric timestamp, so it reached the AI gate and stopped
    // at "not recognised". Adopts only on an unambiguous single match.
    try {
      const golden = matchGoldenSourceBySample(events);
      if (golden) {
        const rec = recognizeSourcetype(golden.sourcetype);
        adopt(rec.canonical || golden.sourcetype, 'high',
          `Recognised locally: ${golden.description} — identified by its distinctive raw signature. No data left your browser.`);
        setDetecting(false);
        return;
      }
    } catch { /* a local recogniser fault must not stop the AI path below */ }

    // Tier 2 — the model. Only for data that is allowed to reach it.
    const sourceMode = opts.sourceMode ?? state.sourceMode;
    const sanitised = opts.sanitised ?? state.sampleSanitised;
    if (loadQualitySettings().requireSanitisedSamples && sampleNeedsSanitising(sourceMode) && events.trim() && !sanitised) {
      setDetectReason('Not recognised locally, and these are real events from your estate — so they were NOT sent to the AI provider for identification. Sanitise the sample below (it happens in your browser), then press “Detect sourcetype”. You can also just type or pick the sourcetype.');
      setDetectConfidence('none');
      setDetecting(false);
      return;
    }

    try {
      const data = await detectSourcetypeApi(events);
      if (data.sourcetype) {
        adopt(data.sourcetype, data.confidence || 'medium', data.reason || '');
      } else {
        // No sourcetype came back. Distinguish "AI unavailable" (Tailscale down,
        // AI not configured, backend error) from a genuine no-match so the user
        // isn't left thinking a valid file was unrecognized. The API surfaces
        // this via confidence 'none' + a reason string.
        setDetectReason(data.reason || 'Sourcetype could not be auto-detected.');
      }
    } catch (err) {
      // Don't swallow — show why so an AI-unreachable moment isn't mistaken for
      // an unrecognized file.
      setDetectReason(`Detection failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    setDetecting(false);
  };

  const handleSelectSourcetype = (value: string) => {
    sourcetypeSelectionOrigin.current = 'user';
    setSourcetype(value);
    setIsCustomSourcetype(false);
    setReductionToggles({});
    setValidationHint('');
    update({ sampleEvents: '' });
    // Auto-select best sample source — prefer a real reference sample when the
    // professional-pack library has one, otherwise fall back to public/AI.
    if (referenceAvailability[value]?.hasSamples) {
      setSampleSourceId('reference');
    } else {
      const sources = getAvailableSources(value, hasBuiltInSamples(value));
      setSampleSourceId(sources[0]?.id || 'ai-generate');
    }
  };

  const handleSelectOther = () => {
    sourcetypeSelectionOrigin.current = 'user';
    setSourcetype('');
    setIsCustomSourcetype(true);
    setReductionToggles({});
    update({ sampleEvents: '' });
    setSampleSourceId('ai-generate');
  };

  const packId = toKebab(state.packName);

  const canProceedName = state.packName.trim().length > 0;
  const canProceedSource = state.sampleEvents.trim().length > 0 && effectiveSourcetype.trim().length > 0 && !samplesLoading;

  // formatsOverride lets a caller (e.g. the sample-advice "Add" button) run
  // analysis for a format set that hasn't flushed to state yet — setState is
  // async, so reading state.destFormats right after setState would be stale.
  const fetchAiAdvice = async (formatsOverride?: DestFormat[]) => {
    setAiLoading(true);
    setAiError('');
    setAiAdvice(null);
    setAiMappings(null);
    setAiMappingsPerFormat({});
    setAiParseFns(null);
    setAiAnalysisSteps([]);
    setSampleSchemaAdvice(null);

    const formats = formatsOverride && formatsOverride.length > 0
      ? formatsOverride
      : state.destFormats.length > 0 ? state.destFormats : [state.destFormat];
    let sampleSnippet: string;
    try {
      sampleSnippet = aiSampleSnippet({
        sampleEvents: state.sampleEvents, sourceMode: state.sourceMode,
        sanitised: state.sampleSanitised, required: loadQualitySettings().requireSanitisedSamples,
      });
    } catch (e) {
      // Fail loudly and early, before any provider call: an empty snippet would make the
      // model answer confidently about nothing and quietly produce a worthless pack.
      setAiError(e instanceof Error ? e.message : String(e));
      setAiLoading(false);
      return;
    }

    // Sample-aware schema advice: only suggest sub-type changes WITHIN the same
    // format family (e.g. sentinel table swap, CIM model swap). Never suggest
    // switching the output format entirely (CIM → OCSF) — user chose deliberately.
    try {
      const rec = recommendDestFormatsForSample(effectiveSourcetype, state.sampleEvents);
      const chosen = formats.map(f => resolveDestFmt(f, state));
      const sameFamily = chosen.some(c => c === rec.primary || (c === 'sentinel' && rec.primary === 'sentinel') || (c === 'cim' && rec.primary === 'cim'));
      if (rec.inference.disagrees && !chosen.includes(rec.primary) && sameFamily) {
        setSampleSchemaAdvice(rec);
      }
    } catch { /* advice is best-effort — never block analysis */ }

    const addStep = (key: string, detail: string) => {
      setAiAnalysisSteps(prev => {
        const idx = prev.findIndex(s => s.step === key);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { step: key, detail, time: Date.now() };
          return updated;
        }
        return [...prev, { step: key, detail, time: Date.now() }];
      });
    };

    try {
      // Run advice for first format (pipeline strategy applies to all)
      const firstFmt = resolveDestFmt(formats[0], state);
      addStep('advise:researching', `Researching ${effectiveSourcetype} format and ${firstFmt} schema...`);

      const advice = await aiAdvise(effectiveSourcetype, firstFmt, sampleSnippet, allowCodeFunctions, (step, detail) => {
        addStep(`advise:${step}`, detail || step);
      });
      setAiAdvice(advice);
      if (advice?.reductions && advice.reductions.length > 0) {
        const defaults: Record<string, boolean> = {};
        for (const opt of advice.reductions) {
          defaults[opt.id] = opt.defaultEnabled;
        }
        setReductionToggles(defaults);
      }

      // STEP 1 — SOURCE EXTRACTION FIRST. Determine the exact field names the
      // parse stage will produce BEFORE generating any destination mapping. The
      // mapping stage must map FROM these real fields — never invent names.
      //   - Custom sourcetypes: AI generates the parser, we read its capture
      //     groups.
      //   - Built-in-parser sourcetypes: we know the parser's output contract
      //     from getParserFieldNames() (e.g. ASA emits src_ip/dest_ip/asa_code,
      //     NOT the CEF-native src/dst that the mapping used to hallucinate).
      // Either way, aiMapping is NEVER called blind.
      let parsedFieldNames: string[] = [];
      // AUTO-PROMOTE REPLAY: if this custom source already has a verified recipe
      // (parse fns + mapping) from a prior passing run, replay it deterministically
      // and skip AI entirely — a custom source that once passed is now built-in
      // quality. The build-time contract + extraction gates catch any sample drift.
      let replayedParse: AiParseFunctions | null = null;
      // Only replay when the CURRENT sample structurally matches the sample the
      // recipe was verified against — a mismatched key-set means it's a different
      // source wearing the same label, so regenerate with AI instead.
      const currentFingerprint = sampleFingerprint(state.sampleEvents);
      // Recipes are filed per wire format too (golden-variant.ts): a CEF sample
      // never replays a recipe proven on the source's key=value feed.
      const currentWire = goldenWireFormatForSample(state.sampleEvents);
      if (!KNOWN_PARSER_SOURCETYPES.includes(effectiveSourcetype)) {
        try {
          const firstGoldenRec = await getGoldenPipeline(effectiveSourcetype, resolveDestFmt(formats[0], state), currentWire);
          if (firstGoldenRec?.recipe?.parseFunctions && fingerprintsMatch(firstGoldenRec.recipe.fingerprint, currentFingerprint)) {
            replayedParse = { functions: firstGoldenRec.recipe.parseFunctions } as AiParseFunctions;
          } else if (firstGoldenRec?.recipe?.parseFunctions) {
            addStep('parse', `Step 1 — a verified ${effectiveSourcetype} recipe exists but this sample's structure differs; regenerating with AI.`);
          }
        } catch { /* store unavailable — fall through to AI */ }
      }

      if (replayedParse) {
        setAiParseFns(replayedParse);
        parsedFieldNames = extractParsedFieldNames(replayedParse);
        addStep('parse', `Step 1 — replaying verified ${effectiveSourcetype} parser (auto-promoted, no AI) — extracts: ${parsedFieldNames.slice(0, 8).join(', ')}…`);
      } else if (!KNOWN_PARSER_SOURCETYPES.includes(effectiveSourcetype)) {
        // Content recognition is allowed to suggest the sourcetype earlier, but
        // once selected it must not silently replace this source contract.
        addStep('parse', `Step 1 — extracting fields from ${effectiveSourcetype} source...`);
        const parseFns = await aiParse(effectiveSourcetype, sampleSnippet, (step) => {
          if (step === 'done') addStep('parse', 'Parse functions generated.');
        });
        if (parseFns && parseFns.functions && parseFns.functions.length > 0) {
          setAiParseFns(parseFns);
          addStep('parse', `${parseFns.functions.length} parse function(s) generated — extracts: ${extractParsedFieldNames(parseFns).slice(0, 8).join(', ')}…`);
          parsedFieldNames = extractParsedFieldNames(parseFns);
        }
      } else {
        setAiParseFns(null);
        parsedFieldNames = getParserFieldNames(effectiveSourcetype);
        if (parsedFieldNames.length > 0) {
          addStep('parse', `Step 1 — built-in ${effectiveSourcetype} parser extracts: ${parsedFieldNames.slice(0, 8).join(', ')}…`);
        }
      }

      // Run mappings for each destination format sequentially with progress
      const mappingsMap: Record<string, AiMappingResult | null> = {};
      for (let i = 0; i < formats.length; i++) {
        const fmt = resolveDestFmt(formats[i], state);
        const fmtLabel = DEST_OPTIONS.find(d => d.value === formats[i])?.label || fmt;
        // Replay a verified mapping recipe for this format only when the sample
        // structurally matches the one it was proven against.
        let replayMapping: AiMappingResult | null = null;
        if (!KNOWN_PARSER_SOURCETYPES.includes(effectiveSourcetype)) {
          try {
            const rec = await getGoldenPipeline(effectiveSourcetype, fmt, currentWire);
            if (rec?.recipe?.mappings && fingerprintsMatch(rec.recipe.fingerprint, currentFingerprint)) {
              replayMapping = rec.recipe.mappings;
            }
          } catch { /* fall through to AI */ }
        }

        let mappings: AiMappingResult | null;
        const fmtDest = formats[i];
        const fmtGolden = hasGoldenFormatPath(effectiveSourcetype, fmtDest, state.sampleEvents)
          && goldenPathMatchesSample(effectiveSourcetype, fmtDest, state.sampleEvents);
        if (replayMapping) {
          mappings = replayMapping;
          addStep(`mapping:${fmt}`, `[${i + 1}/${formats.length}] ${fmtLabel} — replaying verified mappings (auto-promoted, no AI).`);
        } else if (fmtGolden) {
          mappings = null;
          addStep(`mapping:${fmt}`, `[${i + 1}/${formats.length}] ${fmtLabel} — deterministic golden mapping (no AI).`);
        } else {
          addStep(`mapping:${fmt}`, `[${i + 1}/${formats.length}] Generating field mappings for ${fmtLabel}...`);
          mappings = await aiMapping(effectiveSourcetype, fmt, sampleSnippet, (step) => {
            if (step === 'done') {
              addStep(`mapping:${fmt}`, `[${i + 1}/${formats.length}] ${fmtLabel} mappings ready.`);
            }
          }, parsedFieldNames.length > 0 ? parsedFieldNames : undefined, undefined, loadQualitySettings().normalModel);
        }

        mappingsMap[formats[i]] = mappings;
        setAiMappingsPerFormat({ ...mappingsMap });

        // Set first format's mappings as the primary (for backward compat)
        if (i === 0 && mappings && mappings.mappings && mappings.mappings.length > 0) {
          setAiMappings(mappings);
        }
      }

      addStep('alldone', `All ${formats.length} destination${formats.length > 1 ? 's' : ''} analyzed.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'AI analysis unavailable';
      setAiError(message);
    } finally {
      setAiLoading(false);
    }
  };

  // --- Batch pre-flight logic ---

  const resetPreflightState = () => {
    setPreflightPhase('sourcetype');
    setPreflightSourcetypes([]);
    setPreflightGate([]);
    preflightGoldenNames.current = [];
    setBatchPickIndex(null);
    setPreflightSampleConflicts([]);
    setPreflightGateDetecting(new Set());
    setPreflightSamples([]);
    setPreflightRunning(false);
    setPreflightProgress(null);
    setPreflightFilter(null);
    preflightSampleCache.current.clear();
    deferredSampleWork.current = null;
    preflightStoreCache.current.clear();
    preflightStoreInFlight.current = new Set();
    setPreflightStoreLookups({});
    preflightSampleOrigin.current.clear();
    preflightSamplePrepareMs.current.clear();
    preflightAbort.current = false;
  };

  // Schema advice DERIVED from a resolved sourcetype + destination format. Used
  // inline in the sourcetype-check table: computed when a row is recognized and
  // recomputed whenever the sourcetype changes ("when checked → advice; when
  // changed → re-advise"). Sample is optional — name-based advice works without
  // it (cim/sentinel), and inferDataClass tolerates an empty sample for
  // ocsf/asim (falls back to the static per-sourcetype data class).
  const adviseSchema = (
    sourcetype: string,
    destFormat: string | undefined,
    opts?: { sample?: string; csvModel?: string },
  ): { schemaModel?: string; schemaDataClass?: string; schemaAlts?: string[] } => {
    if (!destFormat || !['cim', 'ocsf', 'asim', 'ecs', 'sentinel'].includes(destFormat)) return {};
    const sample = opts?.sample || '';
    if (destFormat === 'cim') {
      // Prefer the data-class golden model (same as concretizeCimFormat / buildPack)
      // over bare keyword suggestions — those used to put linux_audit on Change.
      const fromClass = cimModelForFormatKey(concretizeCimFormat('cim', sourcetype, sample));
      const alts = cimModelSuggestions(sourcetype);
      const ranked = fromClass
        ? [fromClass, ...alts.filter(m => m !== fromClass)]
        : alts;
      return { schemaModel: opts?.csvModel || ranked[0], schemaAlts: ranked, schemaDataClass: undefined };
    }
    if (destFormat === 'sentinel') {
      const alts = sentinelDestinationSuggestions(sourcetype);
      return { schemaModel: opts?.csvModel || alts[0], schemaAlts: alts, schemaDataClass: undefined };
    }
    const inference = inferDataClass(sourcetype, sample);
    if (destFormat === 'ocsf') {
      return { schemaModel: inference.dataClass !== 'generic' ? inference.dataClass : undefined, schemaDataClass: inference.dataClass };
    }
    if (destFormat === 'asim') {
      return { schemaModel: inference.dataClass !== 'generic' ? `asim#${inference.dataClass}` : undefined, schemaDataClass: inference.dataClass };
    }
    // ecs — no per-model pick; the format itself is the target.
    return { schemaDataClass: inference.dataClass };
  };

  // Yield to the browser so React can commit AND paint before we grab the main
  // thread again. rAF fires before the next paint; the nested timeout resolves
  // after it — the standard "let the user actually see this" pair. Without it a
  // long synchronous loop holds the thread and the previous screen stays frozen.
  const yieldToPaint = () => new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });

  // Phase 1 — DETERMINISTIC recognition (no AI). Tiers exact/alias/fuzzy resolve
  // most rows instantly. A high-confidence fuzzy match auto-applies its canonical
  // (per the "auto-apply high-confidence" decision); medium fuzzy is a suggestion.
  // Rows the recognizer can't place (tier 'none') are marked 'unknown' and will be
  // escalated to AI in runPreflightRecognitionAi.
  const recognizePreflightRow = (row: BatchRow, index: number): PreflightSourcetypeRow => {
    let rec;
    try {
      // Pass configuration evidence (dest_format feeds the squashed CamelCase
      // tier's terminal dest-token strip). pack_name/pipeline_name are carried
      // for context only — they are GENERATED from the sourcetype so they can't
      // independently confirm it. Sources the catalog can't place fall through
      // to AI model validation in runPreflightRecognitionAi.
      rec = recognizeSourcetype(row.sourcetype, {
        packName: row.pack_name,
        pipelineName: row.pipeline_name,
        destFormat: row.dest_format,
      });
    } catch (e) {
      console.warn(`[preflight] Error recognizing "${row.sourcetype}":`, e);
      rec = {
        original: row.sourcetype, normalized: '', canonical: canonicalizeSourcetype(row.sourcetype),
        canonicalDisplay: row.sourcetype, tier: 'none' as const, status: 'unresolved' as const,
        known: false, hasGolden: false, confidence: 'none' as const, score: 20,
      };
    }

    // green = golden path, yellow = recognized/AI-handled (build via AI, no
    // golden), red = unknown (blocks). Only the 'unresolved' status blocks the
    // build; catalog-unresolved names are escalated to AI validation next.
    let status: 'green' | 'yellow' | 'red';
    let recognized: 'recognized' | 'ai-classified' | 'unknown';
    let canonical = rec.canonical;
    let suggestion: string | undefined;
    let autoApplied = false;
    let needsConfirm = false;
    let storedGoldenOnly = false;

    // A bare vendor/family token resolves LOCALLY (prefix-matched parser makes
    // "cisco"/"windows" look exact; a curated hint makes "juniper" a
    // catalogue_gap), so it never reached the AI-escalation guard below and was
    // accepted as recognized — building one generic pack for a whole product
    // line. Block it here with the concrete variants, exactly as that guard does.
    // A stored golden under exactly this name outranks the rule: someone built
    // and tested it as written (juniper), so it is a source, not a family.
    const familyVariants = rec.status === 'alias' || hasStoredGolden(row.sourcetype) ? [] : getFamilyTokenVariants(row.sourcetype);

    if (familyVariants.length) {
      recognized = 'unknown';
      status = 'red';
      suggestion = familyVariants[0];
    } else if (rec.status !== 'exact' && hasStoredGolden(row.sourcetype)) {
      // The declared name itself has a stored golden: recognized as written,
      // never re-mapped to an alias (syslog → linux_syslog), a fuzzy neighbour
      // or sent to the AI. The golden was built and tested under this name.
      recognized = 'recognized';
      status = 'green';
      canonical = canonicalizeSourcetype(row.sourcetype);
      storedGoldenOnly = true;
    } else if (rec.status === 'exact' || rec.status === 'alias') {
      recognized = 'recognized';
      status = rec.hasGolden || hasStoredGolden(rec.canonical) ? 'green' : 'yellow';
      suggestion = rec.status === 'alias' ? rec.canonical : undefined;
    } else if (rec.status === 'catalogue_gap') {
      // A curated hint identifies the vendor/product/log-family; we just have no
      // golden. Recognized, NON-blocking — build via AI on its own name. But a
      // hint names the VENDOR, not the source (stash read as Atlassian, ivanti_ps
      // as an appliance log), so it waits for an explicit OK instead of being
      // confirmed as settled.
      recognized = 'ai-classified';
      status = 'yellow';
      needsConfirm = true;
    } else if (rec.tier === 'fuzzy' && rec.confidence === 'high') {
      // Single-typo, unambiguous → pre-fill the matched canonical. Still a rename
      // (https_access → apache_access), so the batch asks before using it.
      recognized = 'recognized';
      status = 'yellow';
      autoApplied = true;
      needsConfirm = true;
      canonical = rec.suggestion || rec.canonical;
      suggestion = canonical;
    } else if (rec.tier === 'fuzzy') {
      // Medium confidence (needs_confirmation) → PRE-ADOPT the recommendation
      // (it resolves to a real supported name). Shown as a pre-filled editable
      // field the user can confirm-by-doing-nothing or change. NON-blocking.
      recognized = 'recognized';
      needsConfirm = true;
      canonical = rec.suggestion || rec.canonical;
      suggestion = canonical;
      let hasGolden = false;
      try { hasGolden = getParserFieldNames(canonical).length > 0 && ['cim', 'ocsf', 'cef', 'ecs'].some(fmt => hasGoldenFormatPath(canonical, fmt)); } catch { /* keep */ }
      status = hasGolden ? 'green' : 'yellow';
    } else {
      // Nothing identifies it (unresolved) → unknown, blocking. AI escalation
      // may later supply a recommendation or confirm a real source.
      recognized = 'unknown';
      status = 'red';
    }

    // The row brought its own sample: an unplaceable name (or a bare family
    // token) is read from the sample's content instead, offline, the way the
    // wizard reads a pasted sample. Pre-filled for the user to confirm, never
    // auto-applied — the content decides the candidate, the user the name.
    let contentReason: string | undefined;
    if (recognized === 'unknown' && row.sample) {
      const detected = readRowSampleMemo(canonical, row.sample)?.detected;
      const buildable = detected && getSupportedSourcetypeCatalog().some(c => canonicalizeSourcetype(c.name) === canonicalizeSourcetype(detected));
      if (buildable) {
        canonical = canonicalizeSourcetype(detected!);
        suggestion = canonical;
        recognized = 'recognized';
        needsConfirm = true;
        let hasGolden = false;
        try { hasGolden = getParserFieldNames(canonical).length > 0 && ['cim', 'ocsf', 'cef', 'ecs'].some(fmt => hasGoldenFormatPath(canonical, fmt)); } catch { /* keep */ }
        status = hasGolden ? 'green' : 'yellow';
        contentReason = `Your sample's content names "${canonical}".`;
      }
    }

    // Schema advice derived from the just-resolved sourcetype (name-based;
    // sample not yet available in Phase 1). Only meaningful for a recognized
    // row — an unknown row has no reliable sourcetype to advise from yet.
    const csvModel = row.dest_format === 'cim' ? row.cimModel
      : row.dest_format === 'sentinel' ? row.sentinelTable : undefined;
    // A row's own sample is here already, so its advice is sample-driven now.
    const schema = recognized !== 'unknown'
      ? adviseSchema(canonical, row.dest_format, { csvModel, sample: row.sample })
      : {};

    return {
      index,
      original: row.sourcetype,
      rowSample: row.sample,
      canonical,
      canonicalDisplay: rec.canonicalDisplay || row.sourcetype,
      status,
      suggestion,
      accepted: recognized !== 'unknown',
      recognized,
      tier: rec.tier,
      destFormat: row.dest_format,
      schemaModel: schema.schemaModel,
      schemaDataClass: schema.schemaDataClass,
      schemaAlts: schema.schemaAlts,
      recStatus: rec.status,
      vendor: rec.vendor,
      product: rec.product,
      logFamily: rec.logFamily,
      description: storedGoldenOnly ? 'Stored golden: tested parser and mapping' : rec.description,
      evidence: rec.evidence,
      confidence: rec.confidence,
      notSecurity: recognized === 'unknown' ? rec.nonEvent : undefined,
      reason: contentReason ?? (familyVariants.length
        ? `Ambiguous — pick a specific variant: ${familyVariants.slice(0, 6).join(', ')}.`
        : recognized === 'unknown' && rec.nonEvent
          ? `Not a log source: ${rec.nonEvent}.`
        : recognized === 'unknown'
          ? (rec.suggestion ? `Did you mean "${rec.suggestion}"?` : 'Sourcetype not recognized')
          : undefined),
      autoApplied,
      needsConfirm,
    };
  };

  // Run Phase 1 in chunks so the screen paints while it works. MEASURED cost of
  // the recognition itself on a 542-row batch: 43 ms typical, 257 ms if every row
  // is unresolvable (full fuzzy scan per row) — a hitch, not the multi-second
  // freeze; that one is the AI escalation that follows. What this buys is that the
  // pre-flight screen appears IMMEDIATELY with its busy banner and a table that
  // fills in, instead of the browser holding the previous screen until phase 1 and
  // the first 500-row render are both done.
  //
  // Yield at most ~8 times regardless of batch size: each intermediate flush
  // re-renders the whole (growing) table, so a fixed small chunk would do more
  // total work than it saves. Batches under the floor flush once, at the end.
  const runPreflightPhase1 = async (rows: BatchRow[]): Promise<PreflightSourcetypeRow[]> => {
    const out: PreflightSourcetypeRow[] = [];
    const chunk = Math.max(50, Math.ceil(rows.length / 8));
    setPreflightProgress({ done: 0, total: rows.length, label: 'Checking sourcetypes' });
    for (let i = 0; i < rows.length; i++) {
      out.push(recognizePreflightRow(rows[i], i));
      if (out.length % chunk === 0 || i === rows.length - 1) {
        // Stream what we have into the table, then let the browser draw it.
        setPreflightSourcetypes(out.slice());
        setPreflightProgress({ done: out.length, total: rows.length, label: 'Checking sourcetypes' });
        await yieldToPaint();
      }
    }
    return out;
  };

  // Phase 1b — AI escalation for rows the deterministic recognizer couldn't place.
  // Dedupes to unique unknown NAMES (the ~542-row batch collapses to a handful),
  // runs aiValidate once per unique name (cached), and — only when the name is
  // still unclear AND a sample exists — escalates to content classification.
  // High-confidence AI results auto-apply their canonical; ambiguous ones stay
  // 'unknown' (blocking). Never throws; an AI error leaves the row 'unknown'.
  const runPreflightRecognitionAi = async (current: PreflightSourcetypeRow[]) => {
    // Splunk/OS internal names are known NOT to be log sources; the model would
    // happily "confirm" ps or stash as real, so they are never escalated.
    const unknowns = current.filter(r => r.recognized === 'unknown' && !r.notSecurity);
    if (unknowns.length === 0) {
      // Nothing to escalate. Clear the busy state unconditionally — the caller may
      // have set it before calling, and a stuck spinner is worse than none.
      setPreflightRunning(false);
      setPreflightProgress(null);
      return;
    }
    setPreflightRunning(true);
    // Mark the rows the AI is about to look at. Their deterministic verdict is
    // 'unknown'/red, but that isn't the answer yet — rendering it as one made the
    // screen look like a wall of failures while the check was still running.
    const pendingNames = new Set(unknowns.map(r => r.original));
    setPreflightSourcetypes(prev => prev.map(r =>
      r.recognized === 'unknown' && pendingNames.has(r.original) ? { ...r, aiChecking: true } : r));

    // Dedupe by ORIGINAL name → resolution, so repeats cost nothing.
    // `kind` distinguishes: 'mapped' = AI mapped it to a supported catalog name
    // (pre-adopt as the canonical); 'ai-own' = AI confirmed a real, identifiable
    // source that has no golden path — build via AI on its OWN name (never
    // force-mapped to a wrong canonical), non-blocking. null = unidentifiable.
    type IdentifiedSource = { canonical: string; tier: 'ai-name'; confidence: 'high' | 'medium' | 'low'; kind: 'mapped' | 'ai-own'; reason?: string; description?: string; logFormat?: string; typicalFields?: string[] };
    const catalog = supportedCatalogNames();
    // Hard guard: an AI result is only usable if it maps to a name we can ACTUALLY
    // build (in the supported catalog). A suggestion outside the catalog — or the
    // AI just echoing back an unsupported original — must NOT be pre-adopted;
    // those rows stay 'unknown' (blocking) so they surface in the top bar for the
    // user to correct or remove. This enforces the "don't force-map unbuildable"
    // discipline: abstain → editable field, never a fake recognition.
    const catalogSet = new Set(catalog.map(n => canonicalizeSourcetype(n)));
    const isBuildable = (name: string) => catalogSet.has(canonicalizeSourcetype(name));

    const resolved = await identifyUniqueNames<IdentifiedSource>(unknowns.map(r => r.original), {
      concurrency: PREFLIGHT_MODEL_CONCURRENCY,
      // A bare vendor/family token never needs the AI: we already know the
      // concrete supported variants, and the model reliably picks ONE of them
      // ("sap" → sap_audit). Keep the row blocking and skip the call.
      isFamilyToken: name => getFamilyTokenVariants(name).length > 0,
      identify: async name => {
        const res = await aiValidate(name, '', catalog);
        // aiValidate returns { valid, sourcetypeOk, suggestion, clarification,
        // isRealSource, description, logFormat, typicalFields }. The enrichment
        // fields (build 412) are the model's own knowledge of the source — reused
        // downstream to ground AI sample-generation / parsing, so we never ask twice.
        const enrich = {
          description: (res?.description || '').trim() || undefined,
          logFormat: (res?.logFormat || '').trim() || undefined,
          typicalFields: Array.isArray(res?.typicalFields) ? res!.typicalFields.slice(0, 24) : undefined,
        };
        const suggestion = (res?.suggestion || '').trim();
        const suggCanon = suggestion ? canonicalizeSourcetype(suggestion) : '';
        // A bare vendor/family token (sap, juniper, okta) is isRealSource=true but
        // the catalog carries specific supported variants (sap_audit, sap_hana…).
        // Auto-adopting it on its own name would skip that choice and fall to
        // generic AI — so if the catalog has buildable variants, keep the row
        // blocking with those as suggestions instead of an ai-own accept.
        const catalogVariants = searchSupportedSourcetypes(name).map(m => m.name).filter(isBuildable);
        if (suggCanon && isBuildable(suggCanon)) {
          // AI mapped it to a real supported name. High if it was confident the
          // source is valid, else medium (still a catalog name → non-blocking).
          return { canonical: suggCanon, tier: 'ai-name', confidence: res?.sourcetypeOk ? 'high' : 'medium', kind: 'mapped', reason: res?.sourcetypeOk ? undefined : (res?.clarification || undefined), ...enrich };
        } else if (res?.isRealSource && catalogVariants.length > 0) {
          // Real source, but ambiguous against specific supported variants → do
          // NOT auto-accept on the bare name; stay unknown (blocking) and surface
          // the variants so the user picks the right one.
          return null;
        } else if (res?.isRealSource) {
          // AI CONFIRMED this is a real, identifiable source (aws:waf,
          // juniper:junos:firewall, citrix:netscaler…) but we have no golden path
          // and no better catalog target. Build via AI on its OWN name — do NOT
          // force-map it to a wrong canonical. Non-blocking (⚡ AI path).
          return { canonical: canonicalizeSourcetype(name), tier: 'ai-name', confidence: 'medium', kind: 'ai-own', reason: res?.clarification || undefined, ...enrich };
        }
        // AI says gibberish / too generic to name a product → stays unknown
        // (blocking) for the user to correct or remove.
        return null;
      },
      onProgress: ({ done, total, name }) => {
        // Count DISTINCT names, not rows. Every resolution, skip, or failure
        // advances once; clear each name's checking rows as it settles.
        setPreflightProgress({ done, total, label: 'Identifying unrecognized sources with AI' });
        if (name) {
        // One name settled (resolved OR failed) — the count must move either way,
        // otherwise a failing model leaves the bar stuck and we're back to
        // "looks frozen". Clear this name's rows from the checking state as we go
        // so long batches show progress row-by-row, not all at the end.
          setPreflightSourcetypes(prev => prev.map(r => r.original === name && r.aiChecking ? { ...r, aiChecking: false } : r));
        }
      }
    });

    // The explicit return type keeps the literal unions ('green' | 'yellow', …)
    // that the setState contextual typing used to supply — chaining a second .map
    // below removes that context, which would widen them to `string`.
    setPreflightSourcetypes(prev => prev.map((r): PreflightSourcetypeRow => {
      if (r.recognized !== 'unknown') return r;
      const ai = resolved.get(r.original);
      if (!ai) {
        // Ambiguous bare vendor/family token with specific supported variants →
        // point the user at them instead of the generic "couldn't identify".
        const variants = searchSupportedSourcetypes(r.original).map(m => m.name).slice(0, 6);
        if (variants.length > 0) {
          return { ...r, suggestion: variants[0], reason: `Ambiguous — pick a specific variant: ${variants.join(', ')}.` };
        }
        return { ...r, reason: r.reason || 'AI could not identify this source — fix the name or remove the row.' };
      }
      // The AI resolved a sourcetype for this row — re-advise the schema from it.
      const aiSchema = adviseSchema(ai.canonical, r.destFormat, { sample: r.rowSample || preflightSampleCache.current.get(ai.canonical) || '' });
      if (ai.kind === 'ai-own') {
        // Confirmed-real source with no golden target: keep its OWN name, build
        // via AI. Recognized + non-blocking, but flagged so the user sees it's an
        // AI-built (not golden) source. Not editable-red — it's a valid source.
        return {
          ...r, canonical: ai.canonical, override: ai.canonical, status: 'yellow',
          recognized: 'ai-classified', tier: 'hint', recStatus: 'catalogue_gap', confidence: 'medium',
          suggestion: undefined, needsConfirm: false, accepted: true,
          evidence: r.evidence || 'AI confirmed a real source — no golden path',
          reason: ai.reason || 'Recognized source — no golden path; will build via AI on its sample.',
          // The catalog's "Unknown source type" contradicts AI's verdict.
          description: ai.description || 'Real source, confirmed by AI · builds via AI',
          logFormat: ai.logFormat, typicalFields: ai.typicalFields,
          ...aiSchema,
        };
      }
      if (ai.confidence === 'high') {
        // Auto-apply the AI canonical; check if it now has a golden/known path.
        let status: 'green' | 'yellow' = 'yellow';
        try {
          if (getParserFieldNames(ai.canonical).length > 0 && ['cim', 'ocsf', 'cef', 'ecs'].some(fmt => hasGoldenFormatPath(ai.canonical, fmt))) status = 'green';
        } catch { /* keep yellow */ }
        return {
          ...r, canonical: ai.canonical, override: ai.canonical, status,
          recognized: 'ai-classified', tier: 'ai-name', confidence: 'high',
          suggestion: ai.canonical, autoApplied: true, accepted: true, reason: undefined,
          description: ai.description || r.description,
          logFormat: ai.logFormat, typicalFields: ai.typicalFields,
          ...aiSchema,
        };
      }
      // Medium/low → PRE-ADOPT the AI recommendation into the editable red field
      // (it's grounded in the supported catalog, so it's a buildable name). The
      // row is non-blocking; the user confirms by doing nothing or edits it.
      let status: 'green' | 'yellow' = 'yellow';
      try { if (getParserFieldNames(ai.canonical).length > 0 && ['cim', 'ocsf', 'cef', 'ecs'].some(fmt => hasGoldenFormatPath(ai.canonical, fmt))) status = 'green'; } catch { /* keep */ }
      return {
        ...r, canonical: ai.canonical, override: ai.canonical, status,
        recognized: 'ai-classified', tier: 'ai-name', confidence: ai.confidence,
        suggestion: ai.canonical, needsConfirm: true, accepted: true,
        reason: ai.reason || undefined,
        description: ai.description || r.description,
        logFormat: ai.logFormat, typicalFields: ai.typicalFields,
        ...aiSchema,
      };
    // Belt-and-braces: no row may be left in the checking state once the phase is
    // over, whatever branch produced it (the per-name `finally` above normally
    // clears it, but a row whose name never made it into `resolved` would stick).
    }).map(r => r.aiChecking ? { ...r, aiChecking: false } : r));

    setPreflightRunning(false);
    setPreflightProgress(null);
  };

  // Sources we will spend MODEL time on in ONE pre-flight pass — generating a
  // missing sample or extending a thin one. Beyond this the remainder is left to
  // build time (prepareSource still generates and extends, one row at a time)
  // rather than silently dropped — a 500-row batch of unknown sources would
  // otherwise spend hours in pre-flight before writing anything.
  const PREFLIGHT_MODEL_CAP = 40;
  // Generation and extension are each minutes of model time per source; the stores
  // are milliseconds. Keep the store sweep wide and the model pass narrow.
  const PREFLIGHT_MODEL_CONCURRENCY = aiParallelism(3);

  // `allKeys`: every key of the batch. Settled rows among them that are not in
  // `sampleKeys` are kept as they are, so a partial run never wipes them.
  const runPreflightPhase2 = async (sampleKeys: string[], allKeys: readonly string[] = sampleKeys) => {
    const unique = [...new Set(sampleKeys)];
    // A row that brought its own `sample` cell is keyed by that sample, not its
    // sourcetype (preflightSampleKeyOf). Its events are the answer: no store
    // lookup, no generation. The sourcetype it builds as comes from its row.
    const rowSampleOwners = new Map<string, PreflightSourcetypeRow>();
    for (const row of preflightSourcetypes) {
      const key = preflightSampleKeyOf(row);
      if (isRowSampleKey(key) && !rowSampleOwners.has(key)) rowSampleOwners.set(key, row);
    }
    const sourcetypeOf = (key: string): string => {
      const owner = rowSampleOwners.get(key);
      return owner ? owner.override || owner.canonical : key;
    };
    // Pass 1 = the stores ONLY (reference + bundled, read with `extend: false`, no
    // AI, milliseconds). Pass 2 spends model time: it GENERATES a sample for
    // whatever the stores don't have — 39 of the 73 rows in the build-446 batch
    // reached build time with no sample and stopped there, one by one, each after
    // its own failed generation — and EXTENDS the thin ones. Doing it here means the
    // batch knows what it has before it writes anything, the result is shared by
    // every row with that sourcetype, and a source that still can't get a sample
    // says why on this screen instead of failing halfway through the run.
    //
    // Pass 1 must not extend. It used to, by omission: `fetchReferenceSample`
    // defaults to `extend: true`, and 442 of the 638 harvested docs are below
    // SAMPLE_EXTEND_FLOOR, so a screen labelled "Resolving samples" was firing up to
    // 10 concurrent 60-240s model calls while presenting itself as a store lookup.
    // Same total work in the worst case, but now it is named, capped and throttled.
    preflightAbort.current = false;
    const keep = new Set(allKeys);
    setPreflightSamples(prev => [
      ...prev.filter(s => keep.has(s.sourcetype) && !unique.includes(s.sourcetype)),
      ...unique.map((st): PreflightSampleRow => ({ sourcetype: st, status: 'pending', eventCount: 0, source: '' })),
    ]);
    setPreflightRunning(true);
    setPreflightProgress({ done: 0, total: unique.length, label: 'Resolving samples' });

    const patchSample = (sourcetype: string, patch: Partial<PreflightSampleRow>) => {
      setPreflightSamples(prev => prev.map(s => s.sourcetype === sourcetype ? { ...s, ...patch } : s));
    };

    const requiredFormatFor = preflightRequiredFormat;

    const semaphore = { running: 0, queue: [] as (() => void)[] };
    const MAX_CONCURRENT = 10;
    const withSemaphore = async (fn: () => Promise<void>) => {
      if (semaphore.running >= MAX_CONCURRENT) {
        await new Promise<void>(resolve => { semaphore.queue.push(resolve); });
      }
      semaphore.running++;
      try { await fn(); } finally {
        semaphore.running--;
        if (semaphore.queue.length > 0) semaphore.queue.shift()!();
      }
    };

    const unresolved: string[] = [];
    const thin: string[] = [];
    await Promise.allSettled(unique.map(sourcetype => withSemaphore(async () => {
      // The user chose to stop waiting — don't flip a queued row back to 'loading'
      // (the skip handler just marked the unfinished ones 'skipped') or count it.
      if (preflightAbort.current) return;
      patchSample(sourcetype, { status: 'loading' });
      // Every exit from the body below (found / thin / bundled / skipped / throw)
      // counts as one resolved sourcetype, so the header counter tracks the table.
      try {
        const outcome = await resolveOneSample(sourcetype);
        if (outcome === 'none') unresolved.push(sourcetype);
        else if (outcome === 'thin') thin.push(sourcetype);
      } finally {
        if (!preflightAbort.current) setPreflightProgress(p => (p ? { ...p, done: Math.min(p.done + 1, p.total) } : p));
      }
    })));

    // Skipped during the store sweep: leave the busy screen alone (the skip handler
    // already cleared it) and don't spend model time on pass 2.
    if (preflightAbort.current) return;

    // Pass 2 = model time, on ONE budget. Generation goes first: a source with no
    // sample at all cannot be built, while a thin source builds and merely can't be
    // measured. Anything past the cap is left to build time, and says so.
    const toGenerate = unresolved.slice(0, PREFLIGHT_MODEL_CAP);
    for (const st of unresolved.slice(PREFLIGHT_MODEL_CAP)) {
      patchSample(st, { status: 'skipped', reason: `generated at build time (over the ${PREFLIGHT_MODEL_CAP}-source pre-flight model-time cap)` });
    }
    const toExtend = thin.slice(0, Math.max(0, PREFLIGHT_MODEL_CAP - toGenerate.length));
    for (const st of thin.slice(toExtend.length)) {
      // A row's own sample is never extended at build time — it builds as uploaded.
      const n = (preflightSampleCache.current.get(st) || '').split('\n').filter(l => l.trim()).length;
      patchSample(st, {
        reason: isRowSampleKey(st)
          ? `your own ${n} event${n === 1 ? '' : 's'}, not extended (over the ${PREFLIGHT_MODEL_CAP}-source pre-flight model-time cap)`
          : `real but thin — extended at build time (over the ${PREFLIGHT_MODEL_CAP}-source pre-flight model-time cap)`,
      });
    }
    // The model work does NOT run here any more. It is minutes per source, and
    // on this screen it looked like the check had stalled with nothing to show
    // for it. It is handed to the batch run, which does it first, as its own
    // visible "Creating samples" stage, before any pack builds
    // (runDeferredSampleWork). The results land in the same cache the build reads.
    const tasks: Array<() => Promise<void>> = [
      ...toGenerate.map(st => () => generateOneSample(st)),
      ...toExtend.map(st => () => extendOneSample(st)),
    ];
    // Appended, not replaced: Back → change one row's sample → Next resolves only
    // that row, and must not drop the work already queued for the others.
    if (tasks.length > 0) {
      const prev = deferredSampleWork.current;
      deferredSampleWork.current = {
        generate: (prev?.generate ?? 0) + toGenerate.length,
        extend: (prev?.extend ?? 0) + toExtend.length,
        tasks: [...(prev?.tasks ?? []), ...tasks],
      };
    }

    // The skip handler owns the busy-screen teardown when the user bailed; don't
    // fight it here.
    if (preflightAbort.current) return;
    setPreflightRunning(false);
    setPreflightProgress(null);

    /**
     * What the STORES hold for this sourcetype — no model calls, no extension.
     * `found` = enough events to build from; `thin` = real but below
     * SAMPLE_EXTEND_FLOOR, so pass 2 should top it up; `none` = nothing stored.
     */
    async function resolveOneSample(sourcetype: string): Promise<'found' | 'thin' | 'none'> {
      const resolveStarted = Date.now();
      const keep = (events: unknown[], source: PreflightSampleRow['source']): 'found' | 'thin' => {
        const lines = flattenEventsToLines(events);
        preflightSampleCache.current.set(sourcetype, lines);
        preflightSampleOrigin.current.set(sourcetype, source);
        preflightSamplePrepareMs.current.set(sourcetype, Date.now() - resolveStarted);
        const isThin = events.length < SAMPLE_EXTEND_FLOOR;
        const n = `${events.length} event${events.length === 1 ? '' : 's'}`;
        // A CSV sample is authoritative: use exactly what the user supplied.
        // It can be thin for score confidence, but it is never "missing" and we
        // do not silently append generated events to it. Library samples may be
        // extended below; uploaded samples always stop here.
        const keepThin = source === 'uploaded' && isThin;
        patchSample(sourcetype, {
          status: 'found', eventCount: events.length, source, thin: isThin,
          reason: !isThin ? ''
            : keepThin ? `the ${n} you chose — used as chosen; thin only means its score will be less representative`
            : `only ${events.length} real event${events.length === 1 ? '' : 's'} in the store — queued for extension`,
        });
        return isThin && !keepThin ? 'thin' : 'found';
      };
      const owner = rowSampleOwners.get(sourcetype);
      if (owner?.rowSample) return keep(owner.rowSample.split('\n').filter(l => l.trim()), 'uploaded');
      // `extend: false` (inside lookupStoreSample) is load-bearing: this is the
      // store sweep, and the header says so. Extension happens in pass 2, where it
      // is counted and capped. The check screen's forecast usually already asked.
      const hit = await lookupStoreSample(sourcetype, requiredFormatFor(sourcetype));
      if (hit) return keep(hit.events, hit.source);
      patchSample(sourcetype, { status: 'skipped', eventCount: 0, source: '', thin: false });
      return 'none';
    }

    /**
     * Top a thin store sample up, through the SAME extension the build path uses.
     * A failure is not an error here — the real events stay cached and the row keeps
     * its thin marker, exactly as if the cap had deferred it.
     */
    async function extendOneSample(sourcetype: string) {
      const real = (preflightSampleCache.current.get(sourcetype) || '').split('\n').filter(l => l.trim());
      if (real.length === 0) return;
      const origin = preflightSampleOrigin.current.get(sourcetype) || 'reference';
      const started = Date.now();
      // A row sample's cache key is its content; the source it extends as is its row's.
      const buildAs = sourcetypeOf(sourcetype);
      try {
        const ext = await extendResolvedSample(buildAs, real, requiredFormatFor(buildAs));
        const events = Array.isArray(ext.events) ? ext.events : [];
        if (events.length > real.length) {
          preflightSampleCache.current.set(sourcetype, flattenEventsToLines(events));
          preflightSampleOrigin.current.set(sourcetype, origin);
          // Extension is the expensive half of resolving this sample — add it
          // to the store read rather than replacing it.
          preflightSamplePrepareMs.current.set(
            sourcetype,
            (preflightSamplePrepareMs.current.get(sourcetype) || 0) + (Date.now() - started),
          );
          patchSample(sourcetype, {
            status: 'found', eventCount: events.length, thin: false,
            reason: `${real.length} real + ${events.length - real.length} generated event${events.length - real.length === 1 ? '' : 's'}`,
          });
          return;
        }
        // Extension declined (the guard rejected every candidate, or the call timed
        // out). Naming that beats a row that silently stays at 2 events.
        patchSample(sourcetype, {
          thin: true,
          reason: ext.extensionNote || `could not be extended past ${real.length} real event${real.length === 1 ? '' : 's'}`,
        });
      } catch (e: any) {
        patchSample(sourcetype, {
          thin: true,
          reason: `${real.length} real event${real.length === 1 ? '' : 's'}; extension failed (${e?.message?.slice(0, 90) || 'unknown error'}, after ${Math.round((Date.now() - started) / 1000)}s)`,
        });
      }
    }

    async function generateOneSample(sourcetype: string) {
      // Each task marks its own row busy: an extension keeps its real event count on
      // screen while it runs, so only generation flips to the loading state.
      patchSample(sourcetype, { status: 'loading' });
      // Same grounding the build path uses: recognition metadata, and for a
      // multi-format source the most common format (a batch can't ask).
      const rec = recognizeSourcetype(sourcetype);
      const mfSpec = getMultiFormatSpec(sourcetype);
      const requiredFormat = requiredFormatFor(sourcetype);
      const grounding = buildSampleGroundingContext(
        { vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily },
        sourcetype,
        requiredFormat || (mfSpec ? (mfSpec.formats[0]?.id || undefined) : undefined),
      );
      const started = Date.now();
      // Same escalation the demo uses (fast → balanced): one attempt used to lose the
      // row to a single slow call.
      const gen = await generateSampleEvents({ sourcetype, grounding });
      if (gen.events) {
        preflightSampleCache.current.set(sourcetype, gen.events);
        preflightSampleOrigin.current.set(sourcetype, 'ai-generated');
        preflightSamplePrepareMs.current.set(sourcetype, Date.now() - started);
        patchSample(sourcetype, {
          status: 'generated', eventCount: gen.events.split('\n').length, source: 'ai', reason: '',
        });
      } else {
        // The reason is the point: this used to surface as a bare "upload a sample"
        // on a batch row minutes later, with the real cause (usually a timeout)
        // nowhere on screen.
        patchSample(sourcetype, {
          status: 'failed', eventCount: 0, source: '',
          reason: `${gen.lastReason} (${gen.attempts} attempt${gen.attempts === 1 ? '' : 's'}, ${Math.round((Date.now() - started) / 1000)}s total)`,
        });
      }
    }
  };

  // Refine the inline per-row schema advice using the resolved sample AND the
  // final resolved sourcetype (content-classify may have changed it). ocsf/asim
  // advice is sample-driven; cim/sentinel stay name-based but pick up the
  // updated sourcetype. A user's inline pick (schemaOverride) is never clobbered.
  const refineSchemaAdviceFromSamples = () => {
    setPreflightSourcetypes(prev => prev.map(r => {
      if (!r.destFormat || !['cim', 'ocsf', 'asim', 'ecs', 'sentinel'].includes(r.destFormat)) return r;
      if (r.schemaOverride) return r; // user already picked — leave it
      const st = r.override || r.canonical;
      const sample = preflightSampleCache.current.get(preflightSampleKeyOf(r)) || r.rowSample || '';
      const schema = adviseSchema(st, r.destFormat, { sample });
      return { ...r, schemaModel: schema.schemaModel, schemaDataClass: schema.schemaDataClass, schemaAlts: schema.schemaAlts };
    }));
  };

  const applyPreflightResults = () => {
    setBatchRows(prev => prev.map((row, i) => {
      const stRow = preflightSourcetypes.find(r => r.index === i);
      const confirmed = preflightGate[i]?.confirmed;
      const newSt = confirmed?.sourcetype || stRow?.override || stRow?.canonical || row.sourcetype;
      // The resolved model/table (recognition-derived, or a user override picked
      // inline in the sourcetype table) writes back to the format-specific field
      // so the build uses it.
      const resolvedModel = stRow?.schemaOverride || stRow?.schemaModel;
      // A confirmed row carries the spelling the user actually chose. Otherwise
      // the emitted name stays the CSV's raw value unless they overrode it.
      const nativeOut = confirmed?.outputSourcetype || stRow?.override || row.outputSourcetype || row.sourcetype;
      const next = { ...row, sourcetype: newSt, outputSourcetype: nativeOut };
      const gatedSample = preflightGate[i]?.sample;
      if (gatedSample) next.sample = gatedSample;
      if (row.dest_format === 'cim') next.cimModel = resolvedModel || row.cimModel;
      else if (row.dest_format === 'sentinel') next.sentinelTable = resolvedModel || row.sentinelTable;
      return next;
    }));
  };

  const startPreflight = async (rows?: BatchRow[]) => {
    resetPreflightState();
    // Accept rows directly (from the file parser, before setBatchRows has
    // flushed) so recognition can run in the same tick the file is validated —
    // the upload preview and the sourcetype-check screen are one flow now.
    const source = rows || batchRows;
    // Busy BEFORE the first chunk: the caller switches to this step in the same
    // tick, so this is what the user sees on arrival instead of a static table.
    setPreflightRunning(true);
    setPreflightProgress({ done: 0, total: source.length, label: 'Checking sourcetypes' });
    const goldenNames = goldenSourcetypeNameList;
    preflightGoldenNames.current = goldenNames;
    // A row back from an earlier pre-flight keeps its picked sample and whether
    // it was sanitised; a fresh upload has neither. A declared name that is
    // already an exact or alias hit (and that its sample, if any, does not
    // contradict) is confirmed straight away — the same rule as "Accept
    // declared names", so only suggested, changed or unknown names ask.
    const openedGates = source.map(r => {
      const gate = openGateRow({ sourcetype: r.sourcetype, sample: r.sample, goldenNames });
      return confirmDeclared(gate.sample && r.sampleSanitised ? { ...gate, sanitised: true } : gate);
    });
    setPreflightGate(openedGates);
    // A sample picked in an earlier pre-flight is already resolved. Put it in
    // the same cache/status model the library resolver uses so this ONE
    // pre-flight screen shows it as the
    // sample that will build, rather than making phase 2 "rediscover" it.
    const provided = source.flatMap(row => {
      const sample = row.sample?.trim() || '';
      if (!sample) return [];
      const key = batchSampleKey(row.sourcetype, sample);
      const events = sample.split('\n').filter(line => line.trim());
      preflightSampleCache.current.set(key, sample);
      preflightSampleOrigin.current.set(key, 'uploaded');
      preflightSamplePrepareMs.current.set(key, 0);
      return [{
        sourcetype: key,
        status: 'found' as const,
        eventCount: events.length,
        source: 'uploaded' as const,
        thin: events.length < SAMPLE_EXTEND_FLOOR,
        reason: `the ${events.length} event${events.length === 1 ? '' : 's'} you chose — used as chosen`,
      }];
    });
    setPreflightSamples(provided);
    const results = await runPreflightPhase1(source);
    setPreflightSourcetypes(results);
    syncPreflightFromGate(openedGates);
    // Escalate deterministic-unknowns to AI name classification. Stay "running"
    // straight through — the two phases are one wait from the user's side.
    if (results.some(r => r.recognized === 'unknown')) {
      await runPreflightRecognitionAi(results);
    } else {
      setPreflightRunning(false);
      setPreflightProgress(null);
    }
  };

  // Re-run AI classification on the current (possibly user-edited) rows — used by
  // the "Re-check with AI" button after inline edits.
  const recheckUnknownsWithAi = () => {
    runPreflightRecognitionAi(preflightSourcetypes);
  };

  // Drop a set of preflight rows (by their batchRows index) from BOTH the
  // preflight table AND the underlying batchRows, then re-sequence the surviving
  // rows' indices so `PreflightSourcetypeRow.index` keeps mapping 1:1 to the
  // batchRows array position (applyPreflightResults relies on this). Used by
  // "Remove all unrecognized" (bulk) and the per-row remove in the stepper.
  const removePreflightRows = (dropIndices: number[]) => {
    const drop = new Set(dropIndices);
    if (drop.size === 0) return;
    setBatchRows(prev => prev.filter((_, i) => !drop.has(i)));
    setPreflightGate(prev => prev.filter((_, i) => !drop.has(i)));
    setPreflightSourcetypes(prev => {
      let next = 0;
      const kept = prev.filter(r => !drop.has(r.index)).map(r => ({ ...r, index: next++ }));
      // Leave the filtered "unknowns only" view automatically once nothing is
      // left to fix, so the user drops back to the full table. Only that filter —
      // the other counter filters aren't about rows being removed.
      if (!kept.some(r => r.recognized === 'unknown')) setPreflightFilter(f => (f === 'unknown' ? null : f));
      // Drop sample rows no surviving batch row still points at, so the sample
      // counters ("N without a sample", "N too thin") don't keep counting a
      // sourcetype that has just been removed from the batch. Sample rows are keyed
      // by resolved sourcetype and shared across rows, so a sample is only orphaned
      // once EVERY row using it is gone.
      const stillUsed = new Set(kept.map(preflightSampleKeyOf));
      setPreflightSamples(samples => samples.filter(s => stillUsed.has(s.sourcetype)));
      return kept;
    });
  };

  // Stop waiting on phase-2 sample resolution. Rows still being resolved fall back
  // to build-time generation (a non-blocking state), the busy banner clears, and the
  // user regains the Next button and every per-row control. In-flight model calls are
  // not cancellable, but their results are ignored once this is set (see
  // runPreflightPhase2), so a late completion cannot re-open the busy screen.
  const skipPreflightSampleResolution = () => {
    preflightAbort.current = true;
    setPreflightRunning(false);
    setPreflightProgress(null);
    setPreflightSamples(prev => prev.map(s =>
      s.status === 'pending' || s.status === 'loading'
        ? { ...s, status: 'skipped', eventCount: 0, source: '', thin: false, reason: 'sample resolution skipped — generated at build time' }
        : s));
  };

  // Remove every still-unknown (blocking) row in one click.
  const removeAllUnknownPreflightRows = () => {
    removePreflightRows(preflightSourcetypes.filter(r => r.recognized === 'unknown').map(r => r.index));
  };

  // Remove every row whose sample came back missing (✕) or too thin to measure (⚠︎)
  // in one click — the batch equivalent of the per-row "Remove from batch" on those
  // sample cells. Sample rows are keyed by resolved sourcetype, so this matches a
  // batch row against its sample row the same way the table does.
  const removeAllUnresolvedSamplePreflightRows = () => {
    const bad = new Set(
      preflightSamples
        .filter(s => s.status === 'failed' || (s.thin && s.source !== 'uploaded'))
        .map(s => s.sourcetype),
    );
    if (bad.size === 0) return;
    removePreflightRows(
      preflightSourcetypes.filter(r => bad.has(preflightSampleKeyOf(r))).map(r => r.index),
    );
  };

  const completeBatchPreflight = async () => {
    if (!batchGateOpen(preflightGate) || preflightGate.length !== preflightSourcetypes.length) return;
    // A pack stores ONE <sourcetype>_sample.log. Two rows of one pack that
    // confirmed the same sourcetype with different samples would overwrite it.
    const conflicts = findBatchSampleConflicts(batchRows.map((row, i) => ({
      pack_name: row.pack_name,
      sourcetype: preflightGate[i]?.confirmed?.sourcetype || row.sourcetype,
      sample: preflightGate[i]?.sample || '',
    })));
    setPreflightSampleConflicts(conflicts.map(batchSampleConflictMessage));
    if (conflicts.length > 0) return;
    setPreflightPhase('samples');
    // Supplied samples are used as-is. Rows without one look through the library
    // tiers (a store read) before this button moves to worker-group selection;
    // generation and extension are queued for the batch run's first stage.
    const keys = preflightSourcetypes.map(preflightSampleKeyOf);
    // Only what is not settled yet: after "Continue without waiting" the skipped
    // samples generate at build time, so Next goes straight on.
    const todo = samplesStillToResolve(keys, preflightSamples);
    if (todo.length > 0) {
      await runPreflightPhase2(todo, keys);
      // Skipped mid-run: this (first) click must not advance on its own once the
      // in-flight calls land. The user's next click on Next does.
      if (preflightAbort.current) return;
    }
    refineSchemaAdviceFromSamples();
    applyPreflightResults();
    setStep('select-group');
    fetchWorkerGroups();
  };

  // Write a confirmed gate back onto the recognition row so sample resolution
  // and the build use the name the user chose. Confirming the declared name
  // leaves `override` unset, so a Windows channel stays on `outputSourcetype`.
  const syncPreflightFromGate = (gates: BatchGateRow[]) => {
    setPreflightSourcetypes(prev => prev.map(r => {
      const g = gates[r.index];
      const confirmed = g?.confirmed;
      if (!confirmed) return r;
      const sameDeclared = canonicalizeSourcetype(confirmed.sourcetype) === canonicalizeSourcetype(r.original)
        && canonicalizeSourcetype(confirmed.outputSourcetype) === canonicalizeSourcetype(r.original);
      let status: PreflightSourcetypeRow['status'] = 'yellow';
      try {
        if (hasStoredGolden(confirmed.sourcetype) || (getParserFieldNames(confirmed.sourcetype).length > 0
          && ['cim', 'ocsf', 'cef', 'ecs'].some(fmt => hasGoldenFormatPath(confirmed.sourcetype, fmt)))) status = 'green';
      } catch { /* a new name builds via AI */ }
      const schema = adviseSchema(confirmed.sourcetype, r.destFormat, { sample: g.sample || r.rowSample });
      return {
        ...r,
        canonical: confirmed.sourcetype,
        override: sameDeclared ? undefined : confirmed.sourcetype,
        recognized: 'recognized',
        accepted: true,
        needsConfirm: false,
        notSecurity: undefined,
        status,
        input: undefined,
        reason: undefined,
        rowSample: g.sample || r.rowSample,
        ...schema,
      };
    }));
  };

  const confirmPreflightGate = (index: number, name: string) => {
    const current = preflightGate[index];
    if (!current) return;
    const next = confirmGateRow(current, name);
    if (!next.confirmed) return;
    const gates = preflightGate.map((g, i) => i === index ? next : g);
    setPreflightGate(gates);
    syncPreflightFromGate(gates);
  };

  // Once pre-flight settles (after the catalog pass, and again after the AI
  // pass), a row that ended on the name the file gives is confirmed without
  // asking: confirming it would change nothing. Renames still wait for an OK.
  useEffect(() => {
    if (preflightRunning || preflightGate.length === 0) return;
    const next = preflightGate.map((g, i) => {
      const r = preflightSourcetypes.find(x => x.index === i);
      if (!r || r.recognized === 'unknown' || r.needsConfirm || r.aiChecking) return g;
      return confirmSettled(g, r.override || r.canonical);
    });
    if (next.every((g, i) => g === preflightGate[i])) return;
    setPreflightGate(next);
    syncPreflightFromGate(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflightRunning, preflightSourcetypes, preflightGate]);

  // Look every sample key up in the stores while the check screen is open, so the
  // Sample column can say where each row's sample will come from before Next.
  // Store reads only (milliseconds); the answers are cached for the sample pass.
  useEffect(() => {
    // Runs during the name check too (store reads don't compete with it), so the
    // column is filled by the time names settle; only the sample pass owns the stores.
    if (step !== 'batch-preflight' || (preflightRunning && preflightPhase === 'samples') || preflightSourcetypes.length === 0) return;
    const todo = [...new Set(preflightSourcetypes.map(preflightSampleKeyOf))]
      .filter(k => !isRowSampleKey(k) && !(k in preflightStoreLookups) && !preflightStoreInFlight.current.has(k));
    if (todo.length === 0) return;
    todo.forEach(k => preflightStoreInFlight.current.add(k));
    const inFlight = preflightStoreInFlight.current;
    // Flushed on a short timer: one state update per key re-renders a 500-row
    // screen 500 times, and flushing by index held finished answers back behind
    // slower ones, so the column lagged far behind the lookups.
    let pending: Record<string, StoreLookup | null> = {};
    let timer: number | null = null;
    const flush = () => {
      if (timer != null) { window.clearTimeout(timer); timer = null; }
      const batch = pending;
      pending = {};
      // A reset (new upload) replaced the in-flight set; these answers are stale.
      if (inFlight !== preflightStoreInFlight.current || Object.keys(batch).length === 0) return;
      setPreflightStoreLookups(prev => ({ ...prev, ...batch }));
    };
    void mapSettledWithConcurrency(todo, 8, async (key) => {
      const hit = await lookupStoreSample(key, preflightRequiredFormat(key));
      pending[key] = hit ? { events: hit.events.length, source: hit.source } : null;
      if (timer == null) timer = window.setTimeout(flush, 250);
    }).then(() => {
      flush();
      todo.forEach(k => inFlight.delete(k));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, preflightRunning, preflightPhase, preflightSourcetypes, preflightStoreLookups]);

  // Start time for the busy bar's elapsed clock; a short notice when it ends, because the
  // busy bar disappearing is easy to miss on a screen the user scrolled down.
  const preflightWasRunning = useRef(false);
  useEffect(() => {
    if (preflightRunning) {
      if (!preflightWasRunning.current) { setCheckBusySince(Date.now()); setCheckDoneNotice(false); }
      preflightWasRunning.current = true;
      return;
    }
    if (!preflightWasRunning.current) { setCheckDoneNotice(false); return; }
    preflightWasRunning.current = false;
    setCheckBusySince(null);
    if (step !== 'batch-preflight') return;
    setCheckDoneNotice(true);
    const t = window.setTimeout(() => setCheckDoneNotice(false), 8000);
    return () => window.clearTimeout(t);
  }, [preflightRunning, step]);

  // One explicit click for rows where only the vendor is known: the user has seen
  // the count and the vendor list, so it is a decision, not a silent settle.
  const confirmGateRowsAsWritten = (indices: readonly number[]) => {
    const pick = new Set(indices);
    const gates = preflightGate.map((g, i) => pick.has(i) && !g.confirmed && g.draft ? confirmGateRow(g, g.draft) : g);
    setPreflightGate(gates);
    syncPreflightFromGate(gates);
  };

  const confirmDeclaredGateRows = () => {
    const gates = confirmMatchingRows(preflightGate);
    setPreflightGate(gates);
    syncPreflightFromGate(gates);
  };

  // "Detect sourcetype" runs the SAME ladder as the single-pack wizard's button
  // (handleDetectSourcetype): CEF header, then the datatype parser match, then
  // the JSON key signature — all offline — and only when those name nothing does
  // it ask the model. A row sample is the user's own data (source mode paste),
  // so the wizard's privacy rule applies unchanged: with "Require sanitised
  // samples" on, an un-sanitised row is never sent, and says so.
  const detectPreflightSourcetype = async (index: number) => {
    const current = preflightGate[index];
    if (!current) return;
    const offline = revealSuggestions(
      { ...current, confirmed: null },
      undefined,
      current.sample ? 'Detected locally from the sample as pasted.' : 'Detected locally from the declared name.',
      preflightGoldenNames.current,
    );
    setPreflightGate(prev => prev.map((g, i) => i === index ? offline : g));
    if (!needsAiDetection(offline)) return;

    if (loadQualitySettings().requireSanitisedSamples
      && sampleNeedsSanitising(BATCH_ROW_SAMPLE_SOURCE_MODE)
      && !offline.sanitised) {
      setPreflightGate(prev => prev.map((g, i) => i === index
        ? { ...g, note: 'Nothing recognised it locally, and these are your own events — so they were NOT sent to the AI provider. Sanitize the sample first, or type the name.' }
        : g));
      return;
    }

    setPreflightGateDetecting(prev => new Set(prev).add(index));
    try {
      const res = await detectSourcetypeApi(offline.sample);
      setPreflightGate(prev => prev.map((g, i) => i !== index ? g : (res.sourcetype
        ? addAiSuggestion(g, res.sourcetype, (res.confidence as 'high' | 'medium' | 'low') || 'medium',
          res.reason || `AI read the sample as ${res.sourcetype}.`)
        : { ...g, note: res.reason || 'Nothing recognised this sample — type the sourcetype.' })));
    } catch (err) {
      setPreflightGate(prev => prev.map((g, i) => i === index
        ? { ...g, note: `Detection failed: ${err instanceof Error ? err.message : 'unknown error'}` }
        : g));
    } finally {
      setPreflightGateDetecting(prev => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  // The library sample the picker offers a row: the store sample for the name it
  // would build as right now, read exactly like the phase-2 store sweep (no
  // extension, no model call). Pushed into the picker: the sanitizer module
  // cannot reach the reference or bundled stores itself.
  const batchLibrarySampleName = (index: number): string => {
    const gate = preflightGate[index];
    const src = batchRows[index];
    const canonical = canonicalizeSourcetype(gate?.draft || gate?.declared || src?.sourcetype || '');
    return batchSampleSourcetype(src?.outputSourcetype || gate?.declared || src?.sourcetype, canonical);
  };
  const loadBatchLibrarySample = async (index: number): Promise<LibrarySample | null> => {
    const name = batchLibrarySampleName(index);
    if (!name) return null;
    const stRow = preflightSourcetypes.find(r => r.index === index);
    const requiredFormat = getRequiredXsiamSampleFormat(canonicalizeSourcetype(name), [stRow?.destFormat || batchRows[index]?.dest_format || '']);
    try {
      const ref = await fetchReferenceSample(name, requiredFormat, { extend: false });
      if (ref.available && Array.isArray(ref.events) && ref.events.length > 0) {
        return { events: flattenEventsToLines(ref.events).split('\n').filter(l => l.trim()), label: `reference · ${name}`, sourcetype: name };
      }
    } catch { /* no reference sample */ }
    try {
      const bundled = await (await loadBundledData()).getBundledSample(name, requiredFormat);
      if (bundled.available && Array.isArray(bundled.events) && bundled.events.length > 0) {
        return { events: flattenEventsToLines(bundled.events).split('\n').filter(l => l.trim()), label: `bundled · ${name}`, sourcetype: name };
      }
    } catch { /* no bundled sample either */ }
    return null;
  };

  // The picker's answer for one row. The sample comes first, then the sourcetype it
  // names is confirmed — the user can still edit and re-save the name afterwards.
  // Rows of the same pack and declared sourcetype share one <st>_sample.log, so
  // they take the same pick (findBatchSampleConflicts would refuse them otherwise).
  const applyBatchPickedSample = (pick: SamplePick) => {
    const index = batchPickIndex;
    setBatchPickIndex(null);
    if (index == null || !batchRows[index] || !preflightGate[index]) return;
    const declaredOf = (i: number) => canonicalizeSourcetype(preflightGate[i]?.declared || batchRows[i]?.sourcetype || '');
    const packOf = (i: number) => toKebab(batchRows[i]?.pack_name || '');
    const affected = new Set(batchRows.flatMap((_, i) =>
      i === index || (packOf(i) === packOf(index) && declaredOf(i) === declaredOf(index)) ? [i] : []));

    // A library pick for the very name it would build as needs no pinning: the
    // normal resolution returns the same events and may still extend a thin one.
    const libraryName = batchLibrarySampleName(index);
    const unpinned = pick.origin === 'library' && canonicalizeSourcetype(pick.sourcetype) === canonicalizeSourcetype(libraryName);
    const fitted = unpinned ? { text: '', kept: pick.events.length, total: pick.events.length } : fitBatchRowSample(pick.events);
    if (!unpinned && !fitted.text) {
      setPreflightGate(prev => prev.map((g, i) => i === index
        ? { ...g, note: `That sample cannot be used: ${'error' in fitted && fitted.error ? fitted.error : 'it has no events'}.` }
        : g));
      return;
    }
    const text = fitted.text;
    const count = unpinned ? pick.events.length : fitted.kept;
    const choice = `${pick.origin === 'library' ? 'Library sample' : pick.origin === 'saved' ? 'Saved sample' : 'Your events'} · ${count} event${count === 1 ? '' : 's'}`;
    const notes = [
      fitted.kept < fitted.total ? `Kept the first ${fitted.kept} of ${fitted.total} events.` : '',
      pick.warning || '',
      pick.libraryNote || '',
    ].filter(Boolean);
    const note = notes.join(' ') || undefined;

    const gates = preflightGate.map((g, i) => {
      if (!affected.has(i)) return g;
      const read = revealSuggestions({ ...g, confirmed: null }, text, note, preflightGoldenNames.current);
      return { ...confirmGateRow(read, pick.sourcetype), sanitised: !!text && pick.sanitised };
    });
    setPreflightGate(gates);
    syncPreflightFromGate(gates);
    // After the sync: it keeps an old row sample when the gate has none, and an
    // unpinned library pick must drop it.
    setPreflightSourcetypes(prev => prev.map(r => affected.has(r.index) ? { ...r, rowSample: text || undefined } : r));
    setBatchRows(rows => rows.map((row, i) => affected.has(i)
      ? { ...row, sample: text || undefined, sampleSanitised: !!text && pick.sanitised, sampleChoice: choice, sampleNote: note }
      : row));
    if (text) {
      // Same cache/status model as the library resolver, so the row shows the
      // sample that will build without phase 2 having to rediscover it.
      const key = batchSampleKey('', text);
      preflightSampleCache.current.set(key, text);
      preflightSampleOrigin.current.set(key, 'uploaded');
      preflightSamplePrepareMs.current.set(key, 0);
      setPreflightSamples(prev => [
        ...prev.filter(s => s.sourcetype !== key),
        {
          sourcetype: key, status: 'found', eventCount: count, source: 'uploaded',
          thin: count < SAMPLE_EXTEND_FLOOR,
          reason: `the ${count} event${count === 1 ? '' : 's'} you chose — used as chosen`,
        },
      ]);
    }
    rowSampleReadings.current.clear();
  };

  const downloadConfirmedBatchCsv = () => {
    if (!batchGateOpen(preflightGate)) return;
    const csv = formatConfirmedBatchCsv(batchRows, preflightGate);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'batch-confirmed.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleBatchFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBatchError('');
    setBatchRows([]);
    setBatchFileName(file.name);

    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      try {
        let rows: any[];
        // Read-time problems per data row (a quoted cell holding a line break),
        // merged into the per-row validation below so the row is named.
        let readErrors: Record<number, string[]> = {};

        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(content);
          rows = Array.isArray(parsed) ? parsed : [parsed];
        } else {
          const csv = parseBatchCsv(content);
          if (csv.fileErrors.length > 0) {
            setBatchError(csv.fileErrors.join('\n'));
            return;
          }
          if (csv.rows.length < 1) {
            setBatchError('CSV file must have a header row and at least one data row.');
            return;
          }
          rows = csv.rows;
          readErrors = csv.rowErrors;
        }

        // Validate required fields exist
        const firstRow = rows[0] || {};
        const missingFields = BATCH_REQUIRED_FIELDS.filter(f => !(f in firstRow));
        if (missingFields.length > 0) {
          setBatchError(`Missing required fields: ${missingFields.join(', ')}. Check that your file has these column headers.`);
          return;
        }

        // Validate each row
        const errors: string[] = [];
        const validRows: BatchRow[] = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const rowNum = i + 1;
          const rowErrors: string[] = [...(readErrors[i] || [])];

          // Sourcetype validity is a SOFT flag: keep the row in the preview so
          // the user can correct it inline (a blank one is still a hard error —
          // there's nothing to edit). Non-empty-but-invalid → flag, don't block-parse.
          const names = readBatchSourcetypeColumns(row);
          const stTrimmed = names.sourcetype;
          const stError = validateSourcetypeString(stTrimmed);
          if (!stTrimmed) rowErrors.push('sourcetype is empty');
          if (!row.pack_name?.trim()) rowErrors.push('pack_name is empty');
          if (!row.pipeline_name?.trim()) rowErrors.push('pipeline_name is empty');

          // Resolve dest_format. Besides the base formats, a row may name a
          // specific Microsoft Sentinel TABLE (e.g. CommonSecurityLog,
          // ASimNetworkSessionLogs) or a Splunk CIM data MODEL (e.g.
          // Network_Traffic) directly — normalize those to
          // dest_format='sentinel'/'cim' + the concrete table/model. A bare
          // 'sentinel'/'cim' means "choose in the preview".
          let destFormat = ''; let sentinelTable: string | undefined; let cimModel: string | undefined;
          const rawDest = (row.dest_format || '').trim();
          const rawLower = rawDest.toLowerCase();
          const cimByName = row.cim_model || row.cimModel;   // optional CSV columns
          const tblByName = row.sentinel_table || row.sentinelTable;
          if (!rawDest) rowErrors.push('dest_format is empty');
          else if (/^(sentinel|microsoft sentinel|azure sentinel)$/i.test(rawLower)) {
            destFormat = 'sentinel';
            // Only honor an EXPLICIT sentinel_table CSV column here. Do NOT derive
            // a table from the raw sourcetype string — the sourcetype hasn't been
            // recognized yet (that's Phase 1). The table recommendation is computed
            // inline on each row from the RESOLVED sourcetype (adviseSchema). A bare
            // 'sentinel' with no explicit table stays empty → advised after checking.
            const t = (tblByName || '').trim();
            if (t && resolveSentinelTable(t)) sentinelTable = resolveSentinelTable(t)!.name;
          } else if (resolveSentinelTable(rawDest)) {
            // A concrete Sentinel table named directly in dest_format.
            destFormat = 'sentinel'; sentinelTable = resolveSentinelTable(rawDest)!.name;
          } else if (rawLower === 'cim' || rawLower === 'splunk cim') {
            destFormat = 'cim';
            // Only honor an EXPLICIT cim_model CSV column. The CIM data-model
            // recommendation is derived from the sourcetype, so it MUST wait until
            // the sourcetype is recognized (Phase 1) — adviseSchema computes it
            // inline on the row from the resolved name. A bare 'cim' → advised after.
            const m = (cimByName || '').trim();
            if (m && resolveCimModel(m)) cimModel = resolveCimModel(m)!.name;
          } else if (resolveCimModel(rawDest)) {
            destFormat = 'cim'; cimModel = resolveCimModel(rawDest)!.name;
          } else if (VALID_DEST_FORMATS.includes(rawLower)) {
            destFormat = rawLower;
          } else {
            rowErrors.push(`dest_format "${row.dest_format}" is invalid — a base format (${VALID_DEST_FORMATS.join(', ')}), a Sentinel table, or a CIM data model`);
          }
          if (sentinelTable && !isSentinelIngestionTable(sentinelTable)) {
            rowErrors.push(`Sentinel table ${sentinelTable} is not writable by the Logs Ingestion API (the Cribl Sentinel destination) — pick an ASim* or other API-capable table`);
          }

          if (rowErrors.length > 0) {
            errors.push(`Row ${rowNum}: ${rowErrors.join('; ')}`);
          } else {
            validRows.push({
              sourcetype: stTrimmed,
              // The CSV's own spelling. A corrected file may name the canonical
              // sourcetype in that column and keep the channel (`WinEventLog:System`)
              // in output_sourcetype; a file with only sourcetype uses that cell.
              outputSourcetype: names.outputSourcetype,
              pack_name: row.pack_name.trim(),
              route_name: (row.route_name || '').trim(),
              filter: (row.filter || '').trim(),
              pipeline_name: row.pipeline_name.trim(),
              dest_format: destFormat,
              sentinelTable, cimModel,
              sourcetypeError: stError || undefined,
            });
          }
        }
        if (errors.length > 0) {
          // Row-level problems (bad dest_format, missing required fields) → stay on
          // the upload screen so the user can see the preview and fix/remove rows.
          setBatchError(`Validation errors:\n${errors.join('\n')}`);
          if (validRows.length > 0) {
            setBatchRows(validRows);
          }
        } else {
          // File is clean and records parsed — go STRAIGHT into pre-flight and
          // recognize sourcetypes in the same step (no separate preview screen).
          // Inline-invalid sourcetypes still surface there as editable red rows.
          setBatchRows(validRows);
          setStep('batch-preflight');
          startPreflight(validRows);
        }
      } catch (err) {
        setBatchError(`Failed to parse file: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };
    reader.readAsText(file);
  };

  const sanitizeFilter = (filter: string): string => {
    return filter
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"');
  };

  // Two CSV rows whose pack_name differs only by case/punctuation collapse to ONE
  // pack: `toKebab` lowercases, so `WinEventLog_CIM` and `Wineventlog_CIM` both
  // become `wineventlog-cim`. That silently merges two intended packs into one
  // (and in build 446 pushed the second row down the add-pipeline path, where it
  // then failed). Surface it before the batch runs — the merge may well be what
  // the operator wants, but it should be a choice.
  const findPackIdCollisions = (rows: BatchRow[]): { packId: string; names: string[] }[] => {
    const byId = new Map<string, Set<string>>();
    for (const r of rows) {
      const id = toKebab(r.pack_name);
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id)!.add(r.pack_name);
    }
    return [...byId.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([packId, names]) => ({ packId, names: [...names] }));
  };

  const checkBatchConflicts = async (workerGroup: string) => {
    setBatchPackIdCollisions(findPackIdCollisions(batchRows));
    try {
      const existingPacks = await listPacks(workerGroup);
      const existingIds = new Set(existingPacks.map(p => p.id));
      const batchPackIds = [...new Set(batchRows.map(r => toKebab(r.pack_name)))];
      const conflicts = batchPackIds.filter(id => existingIds.has(id));

      if (conflicts.length > 0) {
        setBatchConflicts(conflicts);
        setBatchSkipPacks(new Set());
        setBatchConflictActions(new Map());
        // The stored golden's score per pipeline of each existing pack, whole
        // and per part (extraction, mapping), so a weak part is visible
        // before choosing an action. Unknown stays null, shown as "—".
        const scores = new Map<string, ConflictPipe[]>();
        const orNull = (p: Promise<{ score: number } | null>) => p.then(g => g?.score ?? null).catch(() => null);
        await Promise.all(conflicts.map(async packId => {
          const rows = batchRows.filter(r => toKebab(r.pack_name) === packId);
          scores.set(packId, await Promise.all(rows.map(async row => {
            const rowFmt = row.dest_format === 'sentinel'
              ? ((row.sentinelTable || '').toLowerCase() === 'commonsecuritylog' ? 'commonsecuritylog' : (row.sentinelTable || row.dest_format))
              : row.dest_format;
            const st = canonicalizeSourcetype(row.sourcetype);
            const [overall, extraction, mapping] = await Promise.all([
              orNull(getGoldenPipeline(st, rowFmt)),
              orNull(getGoldenPart('extraction', st, rowFmt)),
              orNull(getGoldenPart('mapping', st, rowFmt)),
            ]);
            return { pipeline: row.pipeline_name, sourcetype: row.sourcetype, dest: rowFmt, scores: { overall, extraction, mapping } };
          })));
        }));
        setBatchConflictScores(scores);
      } else {
        setBatchConflicts([]);
      }
    } catch {
      setBatchConflicts([]);
    }
    setBatchConfirmReady(true);
  };

  // Concurrency-safe row helpers: functional updates so multiple row actions
  // running at once (up to MAX_ROW_ACTIONS) never clobber each other's writes.
  const patchRow = (i: number, partial: Partial<BatchResult>) =>
    setBatchResults(prev => applyRowPatch(prev, i, partial));
  const rowBusyCount = () => batchRowBusy.size;
  const markRowBusy = (i: number) => setBatchRowBusy(prev => new Set(prev).add(i));
  const markRowFree = (i: number) => setBatchRowBusy(prev => { const n = new Set(prev); n.delete(i); return n; });

  // Improve ONE already-deployed batch row: re-run the post-deploy repair flow
  // against its live pipeline and update the row's score/report in place.
  const improveBatchRow = async (i: number, workerGroup: string) => {
    const r = batchResults[i];
    if (!r || r.status !== 'success' || batchRowBusy.has(i) || rowBusyCount() >= MAX_ROW_ACTIONS) return;
    markRowBusy(i);
    patchRow(i, { phase: 'repairing', message: 'Improving live pipeline…' });
    try {
      const st = canonicalizeSourcetype(r.row.sourcetype);
      const destFmt = r.row.dest_format;
      const packId = toKebab(r.row.pack_name);
      const res = await repairQuality({
        workerGroup, packId, pipelineId: r.row.pipeline_name,
        sourcetype: st, destFormat: destFmt, sampleName: getSampleName(st),
        onProgress: (m) => patchRow(i, { message: m }),
      });
      if (res?.unresolved) {
        // Nothing was committed (repairQuality refuses its own commit too), so
        // the candidate is only PATCHed — recoverable, but only by hand.
        patchRow(i, { phase: 'done', score: null, repairedAfterBuild: true,
          message: `Unverified repair left on the pipeline — ${res.error || 'rollback failed'}. Not deployed; manual recovery required.` });
      } else if (res) {
        patchRow(i, { phase: 'done', score: res.finalScore, ...(res.flow === 'repair' ? { repairedAfterBuild: true } : {}),
          message: `Improved — ${res.flow} flow, score ${res.finalScore}${res.stored ? ` (stored ${res.storedValue})` : ''}` });
      } else {
        patchRow(i, { phase: 'done', message: 'Improve unavailable (scoring failed).' });
      }
    } catch (err) {
      patchRow(i, { phase: 'done', message: err instanceof Error ? err.message : 'Improve failed' });
    } finally { markRowFree(i); }
  };

  // Show ONE row's score report — lazily fetch it if not already stored
  // (post-deploy logging doesn't attach the report to the row). Opens the modal.
  const showBatchRow = async (i: number) => {
    const r = batchResults[i];
    if (!r) return;
    setBatchScoreOpen(i);
    if (r.stageReport?.length) return;  // 3-stage report is already on the row
    if (r.report) return;  // already have it
    if (batchRowBusy.has(i) || rowBusyCount() >= MAX_ROW_ACTIONS) return;
    markRowBusy(i);
    try {
      // Run the validate + the NEW value-coverage scoring model
      // (applyDeterministicScore → scoreAuthoritative) so the inline report's
      // score/findings match the rest of the app, not the raw AI-judge estimate.
      const raw = await validatePipeline({
        workerGroup: selectedGroup, packId: toKebab(r.row.pack_name), pipelineId: r.row.pipeline_name,
        sourcetype: canonicalizeSourcetype(r.row.sourcetype), destFormat: r.row.dest_format,
        sampleName: getSampleName(canonicalizeSourcetype(r.row.sourcetype)),
      });
      if (raw) patchRow(i, { report: applyDeterministicScore(raw) as unknown as PreDeployResult });
    } catch { /* report stays unavailable */ }
    finally { markRowFree(i); }
  };

  // Rerun ONE failed batch row from scratch (re-deploy just that row).
  const rerunBatchRow = async (i: number, workerGroup: string, overrideRow?: BatchRow) => {
    if (batchRowBusy.has(i) || rowBusyCount() >= MAX_ROW_ACTIONS) return;
    markRowBusy(i);
    // overrideRow lets a schema-resolution pass supply the (possibly re-formatted)
    // row without waiting for the async patchRow state flush.
    const row = overrideRow ?? batchResults[i].row;
    patchRow(i, { status: 'running', phase: 'preparing', message: 'Rerunning…', repairedAfterBuild: false });
    setBatchTrace(i, null);
    try {
      const destFormat = row.dest_format as DestFormat;
      const packId = toKebab(row.pack_name);
      const canonicalSourcetype = canonicalizeSourcetype(row.sourcetype);
      // Windows XML channels canonicalize to windows_security for the parser, but
      // each channel carries a distinct event set — keep the RAW channel string for
      // SAMPLE resolution so System/Application/DNS-Client/PowerShell/Defender each
      // get their own reference sample (not the same 4624 Security record). Pre-flight
      // has already canonicalized `sourcetype`; the raw name survives as outputSourcetype.
      const sampleSourcetype = batchSampleSourcetype(row.outputSourcetype || row.sourcetype, canonicalSourcetype);
      const requiredFormat = getRequiredXsiamSampleFormat(canonicalSourcetype, [destFormat]);
      const routeFilter = sanitizeFilter(row.filter || `sourcetype=='${row.sourcetype}'`);
      const batchState: WizardState = {
        packName: row.pack_name, displayName: row.pack_name, sourceMode: 'ai-generate',
        sampleEvents: '', destFormat, destFormats: [destFormat], manualFormat: '',
        routeFilter, workerGroup,
      };
      const rlog = (msg: string) => patchRow(i, { message: msg });
      let sampleEvents = '';
      let rerunSampleWhy = 'no reference, generated, or bundled sample for this sourcetype';
      // Which tier fed THIS rerun — the row's tier from the original run is
      // stale once the rerun resolves (or is handed) a different sample.
      let rerunTier: NonNullable<BatchResult['sampleTier']> = 'none';
      const sampleOverride = (row as BatchRow & { __sampleOverride?: string }).__sampleOverride;
      // A file uploaded for this row, else the row's own CSV sample: both are the
      // user's events, so both carry a source mode the privacy gate can see.
      let rerunSourceMode: string | undefined;
      if (sampleOverride) {
        sampleEvents = sampleOverride;
        rerunTier = 'uploaded';
        rerunSourceMode = 'upload';
      } else if (row.sample) {
        sampleEvents = preflightSampleCache.current.get(batchSampleKey(canonicalSourcetype, row.sample)) || row.sample;
        rerunTier = 'uploaded';
        rerunSourceMode = BATCH_ROW_SAMPLE_SOURCE_MODE;
      } else {
        try {
          const ref = await fetchReferenceSample(
            sampleSourcetype,
            requiredFormat,
            requiredFormat ? { extend: false } : undefined,
          );
          if (ref.available && Array.isArray(ref.events) && ref.events.length > 0) { sampleEvents = flattenEventsToLines(ref.events); rerunTier = 'reference'; }
        } catch { /* fall through */ }
        if (!sampleEvents) {
          const rec = recognizeSourcetype(canonicalSourcetype);
          const grounding = requiredFormat
            ? buildSampleGroundingContext(
                { vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily },
                canonicalSourcetype,
                requiredFormat,
              )
            : undefined;
          const gen = await generateSampleEvents({ sourcetype: canonicalSourcetype, grounding });
          if (gen.events) { sampleEvents = gen.events; rerunTier = 'ai-generated'; }
          else rerunSampleWhy = `AI generation failed: ${gen.lastReason}`;
        }
        if (!sampleEvents) {
          try {
            const bundled = await (await loadBundledData()).getBundledSample(sampleSourcetype, requiredFormat);
            if (bundled.available && Array.isArray(bundled.events) && bundled.events.length > 0) { sampleEvents = flattenEventsToLines(bundled.events); rerunTier = 'bundled'; }
          } catch { /* none */ }
        }
      }
      if (!sampleEvents.trim()) {
        // Same rule as the batch path: name the cause, don't just ask for a file.
        patchRow(i, {
          status: 'awaiting-sample', phase: 'done', sampleTier: 'none', sampleReason: rerunSampleWhy,
          message: `No sample: ${rerunSampleWhy} — upload a sample file or skip this row.`,
        });
        return;
      }
      batchState.sampleEvents = sampleEvents;
      const destFmt = destFormat === 'manual' ? (batchState.manualFormat || 'json') : destFormat;
      // Existing pack? add-pipeline, else new.
      let mode: 'new' | 'add-pipeline' = 'new';
      try { const packs = await listPacks(workerGroup); if (packs.some(p => p.id === packId)) mode = 'add-pipeline'; } catch { /* assume new */ }
      // Rerun via the SAME 3-stage builder as the batch (deferred build + own
      // commit here, since this runs outside the batch's single group commit).
      const rerunQ = loadQualitySettings();
      const rerunThresholds = { extraction: rerunQ.expExtractionThreshold ?? 80, mapping: rerunQ.expMappingThreshold ?? 80, optimization: rerunQ.expOptimizationThreshold ?? 80 };
      const rerunShareOn = goldenSharingConfigured(rerunQ);
      const liveScores: { extraction: number | null; mapping: number | null; optimization: number | null } = { extraction: null, mapping: null, optimization: null };
      const built = await buildStagedPipeline({
        sourcetype: canonicalSourcetype, outputSourcetype: row.outputSourcetype || row.sourcetype, destFormat: destFmt, sampleEvents,
        group: workerGroup, packId, pipelineId: row.pipeline_name,
        packageJson: { version: '1.0.0', author: 'Cribl Pack Generator (batch)', tags: { streamtags: [] }, exports: [], displayName: row.pack_name, name: packId, description: `${canonicalSourcetype} to ${destFmt.toUpperCase()} (3-stage).` },
        reductionToggles: { drop_noise: false, remove_null_fields: true, compact_output: false, field_cleanup: true },
        thresholds: rerunThresholds, shareOn: rerunShareOn, mode, routeFilter, origin: 'batch', log: rlog, logScore: maybeLogScore,
        sampleTier: rerunTier, sampleReason: `via ${rerunTier} (rerun)`, sampleSourceMode: rerunSourceMode,
        sampleSanitised: row.sampleSanitised,
        onTrace: trace => setBatchTrace(i, trace),
        onStage: (r) => { liveScores[r.stage] = r.score; patchRow(i, { phase: r.stage === 'optimization' ? 'scoring' : 'building', stageScores: { ...liveScores }, message: `${r.stage} ${r.score ?? 'n/a'}` }); },
      });
      if (!built) { patchRow(i, { status: 'error', phase: 'done', message: 'No sample events — nothing built.' }); return; }
      // Rerun deploys deferred → commit this group now (a single row).
      await commitDeploy(workerGroup, `Rerun ${packId}`).catch(() => {});
      const mS = built.stages.find(s => s.stage === 'mapping'), eS = built.stages.find(s => s.stage === 'extraction'), oS = built.stages.find(s => s.stage === 'optimization');
      const stageScores = { extraction: eS?.score ?? null, mapping: mS?.score ?? null, optimization: oS?.score ?? null };
      const stageReport = built.stages.map(s => ({ stage: s.stage, source: s.source, score: s.score, reasons: s.reasons, outEvent: s.out?.[0] }));
      batchReportStages.current[i] = { stages: stagesFromBuilt(built.stages, sampleEvents), destFormat: destFmt };
      // null (N/A) stays null — a passthrough raw copy has nothing to score; 0
      // would misreport it as a failed build. Display falls back to stage pills.
      const finalScore = averageStageScores(eS?.score, mS?.score, oS);
      patchRow(i, { status: 'success', phase: 'done', score: finalScore, stageScores, stageReport, sampleTier: rerunTier, sampleReason: `via ${rerunTier} (rerun)`, message: `Rerun OK — E ${stageScores.extraction ?? 'n/a'} · M ${stageScores.mapping ?? 'n/a'} · S ${stageScores.optimization ?? 'n/a'}`, report: null });
    } catch (err) {
      patchRow(i, { status: 'error', phase: 'done', message: err instanceof Error ? err.message : 'Rerun failed' });
    } finally { markRowFree(i); }
  };

  // Hidden file input for batch row sample uploads.
  const batchSampleInputRef = useRef<HTMLInputElement>(null);
  const batchSampleTargetRow = useRef<number>(-1);

  const handleBatchSampleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || batchSampleTargetRow.current < 0) return;
    const i = batchSampleTargetRow.current;
    batchSampleTargetRow.current = -1;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      if (!text.trim()) { patchRow(i, { status: 'error', phase: 'done', message: 'Uploaded file is empty.' }); return; }
      patchRow(i, { status: 'running', phase: 'preparing', message: 'Sample uploaded — building…' });
      const row = batchResults[i]?.row;
      if (!row) return;
      const modifiedRow = { ...row, __sampleOverride: text } as BatchRow & { __sampleOverride?: string };
      rerunBatchRow(i, selectedGroup, modifiedRow);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const triggerBatchSampleUpload = (i: number) => {
    batchSampleTargetRow.current = i;
    batchSampleInputRef.current?.click();
  };

  const skipBatchRow = (i: number) => {
    patchRow(i, { status: 'skipped', phase: 'done', message: 'Skipped — no sample available.' });
  };

  // Resolve a parked (awaiting-confirmation) batch row: either SWITCH to the
  // sample-suggested format or KEEP the CSV choice, then build+deploy just that
  // row via the same per-row machinery as Rerun (deferred build + its own single
  // commit). Runs in the independent per-row action pool, so it never blocks the
  // rest of the batch — other rows keep processing / stay resolvable meanwhile.
  const resolveBatchSchemaRow = async (i: number, useSuggested: boolean, workerGroup: string) => {
    const r = batchResults[i];
    if (!r || r.status !== 'awaiting-confirmation' || !r.schemaSuggestion) return;
    const nextFmt = useSuggested ? r.schemaSuggestion.suggested : r.schemaSuggestion.current;
    // Fold the decision into the row: rerunBatchRow builds from this row, so a
    // Switch just rewrites its dest_format. Clear the suggestion + flip to running
    // first, and pass the updated row explicitly (state flush is async).
    const nextRow = { ...r.row, dest_format: nextFmt };
    patchRow(i, {
      row: nextRow, status: 'running', phase: 'preparing', schemaSuggestion: undefined,
      message: useSuggested ? `Switching to ${nextFmt.toUpperCase()}…` : `Keeping ${nextFmt.toUpperCase()}…`,
    });
    await rerunBatchRow(i, workerGroup, nextRow);
  };

  // The batch run's "Creating samples" stage (see handleBatchDeploy). Returns as
  // soon as `leave()` turns true (Skip, Stop, Kill) without waiting on calls in
  // flight; their late results only fill the cache.
  const runQueuedSampleStage = async (
    sampleWork: { generate: number; extend: number; tasks: Array<() => Promise<void>> },
    leave: () => boolean,
  ) => {
    batchSampleSkip.current = false;
    setBatchSamplePrep({ done: 0, total: sampleWork.tasks.length, generate: sampleWork.generate, extend: sampleWork.extend, since: Date.now() });
    const work = mapSettledWithConcurrency(sampleWork.tasks, PREFLIGHT_MODEL_CONCURRENCY, async run => {
      if (leave()) return;
      try { await run(); } finally {
        setBatchSamplePrep(p => (p ? { ...p, done: Math.min(p.done + 1, p.total) } : p));
      }
    });
    let poll = 0;
    const left = new Promise<void>(resolve => { poll = window.setInterval(() => { if (leave()) resolve(); }, 300); });
    await Promise.race([work, left]);
    window.clearInterval(poll);
    setBatchSamplePrep(null);
  };

  const handleBatchDeploy = async (workerGroup: string, resumeResults?: BatchResult[]) => {
    // On Cribl AI a group with no connected worker fails every row as a bare
    // "Request timeout". Re-read health here too — a resumed checkpoint never
    // passes the picker — and send the user back to it, where the reason shows.
    if (isCriblAiActive()) {
      const health = await listWorkers().catch(() => null);
      if (health) { setWorkerHealth(health); setWorkerHealthLoaded(true); }
      if (groupPickBlock({ group: workerGroup, background: false, criblAi: true, health })) {
        setSelectedGroup(workerGroup);
        setStep('select-group');
        return;
      }
    }
    setBatchConflicts([]);
    setBatchConfirmReady(false);
    setBatchRunning(true);
    setBatchStopping(false);
    batchStopRequested.current = false;
    setKillArmed(null);
    const runGen = ++batchRunGen.current;
    const killed = () => batchRunGen.current !== runGen;
    setBatchRunSpan({ start: Date.now() });
    setStep('batch-running');
    // The checkpoint stores each row's CSV sample once, on batchRows (see
    // persistCheckpoint) — put it back on the resumed result rows.
    const results: BatchResult[] = resumeResults
      ? batchRows.map((row, i) => (resumeResults[i]
        ? { ...resumeResults[i], row: { ...resumeResults[i].row, sample: row.sample } }
        : { row, status: 'pending' as const, phase: 'queued' }))
      : batchRows.map(row => ({ row, status: 'pending' as const, phase: 'queued' }));
    setBatchResults([...results]);
    // A fresh run replaces every row; a resumed one keeps the traces this
    // session still holds for rows it will not rebuild.
    if (!resumeResults) { setBatchTraces({}); batchReportStages.current = {}; }

    // Stage 1 of the run: the samples the check screen queued (generation first,
    // then extension of thin ones, on the pre-flight model budget). Done before any
    // pack builds, so every row starts with its sample, and shown as its own stage
    // on this screen. "Skip" or Stop moves on at once; a sample still in flight
    // lands in the cache late and is harmless, and a row without one generates
    // its own at build time, as before.
    const sampleWork = resumeResults ? null : deferredSampleWork.current;
    if (sampleWork) {
      deferredSampleWork.current = null;
      await runQueuedSampleStage(sampleWork, () => batchSampleSkip.current || batchStopRequested.current || killed());
      if (killed()) return;
    }

    // Checkpoint so a closed/reloaded panel can offer Resume instead of losing
    // the run — best effort, fire-and-forget (never blocks the batch itself).
    const checkpointRunId = crypto.randomUUID();
    const checkpointStartedAt = Date.now();
    const persistCheckpoint = (status: BatchCheckpoint['status']) => {
      void saveBatchCheckpoint({
        runId: checkpointRunId,
        workerGroup,
        batchRows,
        // A row's CSV sample (up to 64 KB) is already on batchRows; a second copy
        // per result would double the document against App KV's ~100 KB cap.
        results: results.map(r => (r.row.sample ? { ...r, row: { ...r.row, sample: undefined } } : r)),
        conflictActions: [...batchConflictActions.entries()],
        skipPacks: [...batchSkipPacks],
        status,
        startedAt: checkpointStartedAt,
        updatedAt: Date.now(),
      });
    };

    // Write ONE row: the local array (the run's own logic reads `results[i].row`
    // and builds `deployed` from it) plus a functional per-index state patch.
    // Never `setBatchResults([...results])` — that whole-array overwrite reverts
    // any Improve/Rerun a user started on another row while the batch runs, and
    // the more rows are in flight the more often it happens. Every commit also
    // refreshes the checkpoint above.
    const commitRow = (i: number, partial: Partial<BatchResult>) => {
      if (killed()) return;
      results[i] = { ...results[i], ...partial };
      setBatchResults(prev => applyRowPatch(prev, i, partial));
      persistCheckpoint(batchStopRequested.current ? 'stopping' : 'running');
    };

    const deployed: DeployedPipeline[] = [];
    // Per-stage golden thresholds + sharing, shared with the 3-stage builder.
    const batchQ = loadQualitySettings();
    const batchThresholds = { extraction: batchQ.expExtractionThreshold ?? 80, mapping: batchQ.expMappingThreshold ?? 80, optimization: batchQ.expOptimizationThreshold ?? 80 };
    const batchShareOn = goldenSharingConfigured(batchQ);
    // Batch builds are deferred (no per-row commit); commit+deploy the group ONCE
    // after all rows are built.
    // On resume, rows already 'success' were deployed (deferred) in the
    // interrupted run but may never have reached the final commit+deploy below —
    // recording that up front means this run still commits them even if every
    // remaining row is skipped/already-done.
    let needsCommit = resumeResults ? resumeResults.some(r => r.status === 'success') : false;
    // Pipelines an Improve row left holding an unverified repair candidate.
    // Run-level, not row-level: the commit below is shared by every row.
    const batchUnresolved: string[] = [];
    type PreparedSample = {
      sampleEvents: string;
      // WHICH tier actually supplied the sample, and — when none did — why. The
      // build-446 batch parked 39 rows on a generic "No sample available" that
      // hid a 90s AI-generation timeout; a row must carry its own provenance.
      sampleTier: 'preflight' | 'uploaded' | 'reference' | 'ai-generated' | 'bundled' | 'none';
      sampleReason: string;
      prepMs: number;
    };
    type PreparedSource = PreparedSample & {
      aiParseFunctions: AiParseFunctions | null;
      parsedFieldNames: string[];
      referenceLookups: Awaited<ReturnType<typeof fetchReferenceLookups>>;
    };
    const samplePreparationCache = createAsyncCache<string, PreparedSample>();
    const extractionPreparationCache = createAsyncCache<string, Omit<PreparedSource, keyof PreparedSample>>();
    const requiredFormatFor = (sourcetype: string): string | undefined => {
      const canonical = canonicalizeSourcetype(sourcetype);
      const destinations = batchRows
        .filter(row => canonicalizeSourcetype(row.sourcetype) === canonical)
        .map(row => row.dest_format);
      return getRequiredXsiamSampleFormat(canonical, destinations);
    };

    // Resolve only the sample here. Parser and lookup resolution happen after
    // this stage has sealed its output.
    const resolveSourceSample = (
      sourcetype: string,
      log: (msg: string) => void,
      sampleSourcetype?: string,
      rowSample?: string,
    ) => {
      // The row's own `sample` cell is the sample: no store tier is asked, and
      // nothing is generated in its place. Cached by its text, not the sourcetype,
      // so two rows with different lines never share one.
      if (rowSample) return resolveRowSample(sourcetype, rowSample, log);
      // Sample resolution can use a channel-bearing raw sourcetype (Windows XML
      // channels canonicalize to windows_security for the parser but each channel
      // has a distinct event set); parser resolution stays on the canonical name.
      // Fold the sample sourcetype into the cache key so two channels that share a
      // canonical parser (System vs Application) don't collide on one sample.
      const sampleSt = sampleSourcetype || sourcetype;
      const requiredFormat = requiredFormatFor(sourcetype);
      const sourceCacheKey = sampleSt === sourcetype ? sourcetype : `${sourcetype}::${sampleSt}`;
      const cacheKey = requiredFormat ? `${sourceCacheKey}::${requiredFormat}` : sourceCacheKey;
      const cached = samplePreparationCache.getOrCreate(cacheKey, async () => {
        const prepStarted = Date.now();
        let sampleEvents = '';
        let sampleTier: PreparedSource['sampleTier'] = 'none';
        // Every tier that declines records WHY, so a row with no sample can name
        // the failure instead of asking for an upload with no explanation.
        const tierFailures: string[] = [];
        // Check pre-flight cache first
        const preflightCached = preflightSampleCache.current.get(sampleSt) || preflightSampleCache.current.get(sourcetype);
        // Name the tier the pre-flight actually used — "preflight" alone hides
        // whether this is a real vendor log or a generated one, which is the first
        // thing you want to know when the row scores badly.
        const preflightOrigin = preflightSampleOrigin.current.get(sampleSt) || preflightSampleOrigin.current.get(sourcetype) || '';
        // A SUB-FLOOR pre-flight sample must not short-circuit the ladder. Pre-flight
        // extends at most PREFLIGHT_MODEL_CAP sources, so past the cap this cache
        // holds the raw 1-2 line store hit, and returning here would hand the build a
        // sample that looks fine and extracts almost nothing measurable. Go through
        // the reference tier (which extends) and keep this as the fallback.
        const preflightCount = preflightCached ? preflightCached.split('\n').filter(l => l.trim()).length : 0;
        const preflightThin = preflightCount > 0 && preflightCount < SAMPLE_EXTEND_FLOOR;
        if (preflightCached && !preflightThin) {
          sampleEvents = preflightCached;
          // The ORIGIN, not the cache it came out of — the same word the
          // background runner records for the same sample.
          sampleTier = preflightSampleTier(preflightOrigin);
          log(`Using pre-flight resolved sample (${preflightCount} events${preflightOrigin ? `, ${preflightOrigin}` : ''}).`);
        } else if (preflightThin) {
          log(`Pre-flight found only ${preflightCount} real ${sourcetype} event(s) — asking the reference tier to extend it.`);
        }
        if (!sampleEvents) {
          try {
            const ref = await fetchReferenceSample(
              sampleSt,
              requiredFormat,
              requiredFormat ? { extend: false } : undefined,
            );
            if (ref.available && Array.isArray(ref.events) && ref.events.length > 0) {
              sampleEvents = flattenEventsToLines(ref.events);
              sampleTier = 'reference';
              log(`Prepared ${ref.events.length} reference events (${ref.pack || 'bundled'}${ref.extensionNote ? `; ${ref.extensionNote}` : ''}).`);
            } else {
              tierFailures.push(`no reference sample for ${sampleSt}`);
            }
          } catch (e: any) {
            tierFailures.push(`reference lookup failed (${e?.message?.slice(0, 60) || 'error'})`);
          }
        }
        // The thin pre-flight sample is still REAL, and real beats generated: only
        // fall past it to generation if the reference tier had nothing (a
        // bundled-origin sample the reference endpoint doesn't serve).
        if (!sampleEvents && preflightThin && preflightCached) {
          sampleEvents = preflightCached;
          sampleTier = preflightSampleTier(preflightOrigin);
          log(`Using the ${preflightCount}-event pre-flight sample${preflightOrigin ? ` (${preflightOrigin})` : ''} — it could not be extended, and real beats generated.`);
        }
        if (!sampleEvents) {
          log(`No reference sample — generating ${GENERATED_SAMPLE_COUNT} ${sourcetype} events once for this batch…`);
          // Ground generation on recognition metadata. For a multi-format source
          // (Zscaler JSON/KV/CEF, Corelight JSON/TSV) with no reference sample, we
          // can't ask the user mid-batch — pick the MOST COMMON format (formats[0])
          // and flag the assumption so it's visible and correctable.
          const rec = recognizeSourcetype(sourcetype);
          const mfSpec = getMultiFormatSpec(sourcetype);
          const chosenFmt = requiredFormat || (mfSpec ? (mfSpec.formats[0]?.id || undefined) : undefined);
          if (requiredFormat) {
            log(`XSIAM requires ${requiredFormat.toUpperCase()} — generating that variant.`);
          } else if (mfSpec && chosenFmt) {
            log(`⚠︎ ${sourcetype} can emit multiple formats — assuming "${mfSpec.formats[0].label}" (most common). Rerun with a reference sample or the interactive wizard to pick another.`);
          }
          const grounding = buildSampleGroundingContext(
            { vendor: rec.vendor, product: rec.product, logFamily: rec.logFamily },
            sourcetype,
            chosenFmt,
          );
          const aiStarted = Date.now();
          const gen = await generateSampleEvents({ sourcetype, grounding, log });
          if (gen.events) {
            sampleEvents = gen.events;
            sampleTier = 'ai-generated';
            log(`Prepared ${gen.events.split('\n').length} generated events${gen.attempts > 1 ? ` (attempt ${gen.attempts}, ${gen.mode})` : ''}.`);
          } else {
            // Keep the REAL cause. Measured generation is 45-87s against a 90s
            // ceiling, so under batch load this is usually a timeout — but the
            // row used to show only 'No sample available'.
            tierFailures.push(`AI generation failed after ${Math.round((Date.now() - aiStarted) / 1000)}s (${gen.attempts} attempts): ${gen.lastReason}`);
            log('Trying bundled source-samples…');
          }
        }
        if (!sampleEvents) {
          try {
            const bundled = await (await loadBundledData()).getBundledSample(sampleSt, requiredFormat);
            if (bundled.available && Array.isArray(bundled.events) && bundled.events.length > 0) {
              sampleEvents = flattenEventsToLines(bundled.events);
              sampleTier = 'bundled';
              log(`Using ${bundled.events.length} bundled source-sample events.`);
            } else {
              tierFailures.push(`no bundled source-sample for ${sampleSt}`);
            }
          } catch (e: any) {
            tierFailures.push(`bundled lookup failed (${e?.message?.slice(0, 60) || 'error'})`);
          }
        }
        return {
          sampleEvents,
          sampleTier,
          sampleReason: sampleEvents
            ? `via ${sampleTier}${sampleTier === 'preflight' && preflightOrigin ? ` (${preflightOrigin})` : ''}`
            : (tierFailures.join('; ') || 'no sample source available'),
          prepMs: Date.now() - prepStarted,
        };
      });
      if (cached.reused) log(`Reusing resolved ${sourcetype} sample.`);
      return cached.value;
    };

    const resolveRowSample = (sourcetype: string, rowSample: string, log: (msg: string) => void) => {
      const key = batchSampleKey(sourcetype, rowSample);
      const cached = samplePreparationCache.getOrCreate(key, async () => {
        const prepStarted = Date.now();
        const own = rowSample.split('\n').filter(l => l.trim());
        // The pre-flight may have extended it already (same key).
        let sampleEvents = preflightSampleCache.current.get(key) || own.join('\n');
        let count = sampleEvents.split('\n').filter(l => l.trim()).length;
        let note = count > own.length ? `, extended in pre-flight to ${count}` : '';
        // Past the pre-flight's model cap a thin row sample is still thin. Extend
        // it here, as the reference tier does for a thin store sample — but only
        // when the user's events may go to the AI provider.
        if (count < SAMPLE_EXTEND_FLOOR) {
          if (loadQualitySettings().requireSanitisedSamples) {
            note = ', not extended: "Require sanitised samples" is on';
          } else {
            try {
              const ext = await extendResolvedSample(sourcetype, own, requiredFormatFor(sourcetype));
              const events = Array.isArray(ext.events) ? ext.events : [];
              if (events.length > count) {
                sampleEvents = flattenEventsToLines(events);
                count = events.length;
                note = `, extended to ${count}`;
              } else if (ext.extensionNote) {
                note = `, ${ext.extensionNote}`;
              }
            } catch (e: any) {
              note = `, extension failed (${e?.message?.slice(0, 60) || 'error'})`;
            }
          }
        }
        log(`Using your sample from the CSV (${own.length} event${own.length === 1 ? '' : 's'}${note}).`);
        return {
          sampleEvents,
          sampleTier: 'uploaded' as const,
          sampleReason: `via uploaded (CSV sample cell, ${own.length} event${own.length === 1 ? '' : 's'}${note})`,
          prepMs: (preflightSamplePrepareMs.current.get(key) || 0) + (Date.now() - prepStarted),
        };
      });
      if (cached.reused) log(`Reusing your ${sourcetype} sample from the CSV.`);
      return cached.value;
    };

    const resolveSourceExtraction = (
      sourcetype: string,
      preparedSample: PreparedSample,
      log: (msg: string) => void,
      sourceMode?: string,
    ): Promise<PreparedSource> => {
      // The source mode is part of the key: the same structure from the user's own
      // events may be refused the AI parse that a store sample of it is given.
      const cacheKey = `${sourcetype}::${sourceMode || ''}::${JSON.stringify(sampleFingerprint(preparedSample.sampleEvents))}`;
      const cached = extractionPreparationCache.getOrCreate(cacheKey, async () => {
        const [parseResult, referenceLookups] = await Promise.all([
          resolveParseFunctions({
            sourcetype,
            sampleEvents: preparedSample.sampleEvents,
            log,
            model: loadQualitySettings().normalModel,
            sourceMode,
          }),
          fetchReferenceLookups(sourcetype).catch(() => []),
        ]);
        return {
          aiParseFunctions: parseResult.aiParseFns,
          parsedFieldNames: parseResult.parsedFieldNames,
          referenceLookups,
        };
      });
      if (cached.reused) log(`Reusing prepared ${sourcetype} extraction and lookups.`);
      return cached.value.then(extraction => ({ ...preparedSample, ...extraction }));
    };

    const processRow = async (i: number, mode: 'new' | 'add-pipeline') => {
      // Resume: this row already settled in the interrupted run — its state is
      // already correct, don't redo the work or overwrite its message.
      const existingStatus = results[i].status;
      if (existingStatus === 'success' || existingStatus === 'error' || existingStatus === 'skipped') return;
      if (killed()) return;
      // Stop requested: leave every row that hasn't started yet as skipped, and
      // don't start any new work. Already-running rows are not cancelled.
      if (batchStopRequested.current) {
        commitRow(i, { status: 'skipped', phase: 'done', message: 'Stopped by user' });
        return;
      }
      commitRow(i, { status: 'running', phase: 'preparing', message: 'Preparing source data…' });
      setBatchTrace(i, null);

      try {
        const row = results[i].row;
        const destFormat = row.dest_format as DestFormat;
        const packId = toKebab(row.pack_name);
        const canonicalSourcetype = canonicalizeSourcetype(row.sourcetype);

        const conflictAction = batchConflictActions.get(packId);
        if (batchSkipPacks.has(packId)) {
          if (conflictAction === 'repair') {
            // Run repair flow on the existing pipeline
            commitRow(i, { status: 'running', phase: 'repairing', message: 'Improving existing pipeline…' });
            try {
              const res = await repairQuality({
                workerGroup, packId, pipelineId: row.pipeline_name,
                sourcetype: canonicalSourcetype, destFormat: row.dest_format,
                sampleName: getSampleName(canonicalSourcetype),
                // A commit is per WORKER GROUP: this row committing for itself
                // would deploy every other row's work too — including a
                // candidate another row stranded. The run owns the commit.
                deferCommit: true,
                onProgress: (m) => commitRow(i, { message: m }),
              });
              const outcome = resolveConflictRepair(res);
              // The repair failed AND the rollback failed: this pipeline may be
              // running a candidate nobody verified. The run's single group
              // commit would make it live, so it is blocked for the whole batch
              // (resolveBatchCommit) and a human has to look at this pipeline.
              if (outcome.unresolved) {
                batchUnresolved.push(row.pipeline_name);
                commitRow(i, { status: 'error', phase: 'done', score: null,
                  message: `Unverified repair left on the pipeline — ${res?.error?.slice(0, 60) || 'rollback failed'}. Nothing committed; manual recovery required.` });
                return;
              }
              // A repair PATCHed the live pipeline; the deferred group commit
              // below is what deploys it.
              if (outcome.needsCommit) needsCommit = true;
              // A repair that could not be measured leaves the row UNSCORED
              // (Hard Rule 32) — a 0 reads as "this pipeline extracts nothing".
              if (!res || res.finalScore == null) {
                commitRow(i, { status: 'skipped', phase: 'done', score: null,
                  message: `Not scored — ${res?.error || 'live scoring unavailable'}` });
                return;
              }
              const score = res.finalScore;
              if (res.error) {
                // It failed AND it measured: the repair broke and the pipeline
                // was put back at a configuration that really scored this. Both
                // halves are reported — dropping either one is a lie.
                commitRow(i, { status: 'error', phase: 'done', score,
                  message: `Repair failed (${res.error.slice(0, 60)}) — left at score ${score}` });
                return;
              }
              commitRow(i, { status: 'success', phase: 'done', score, message: `Improved — score ${score}${res.stored ? ' (golden)' : ''}` });
            } catch (e: any) {
              commitRow(i, { status: 'error', phase: 'done', message: `Improve failed: ${e.message?.slice(0, 80)}` });
            }
            return;
          }
          if (conflictAction === 'scorecard') {
            // Just score the existing pipeline — no changes
            commitRow(i, { status: 'running', phase: 'scoring', message: 'Scoring existing pipeline…' });
            try {
              const res = await repairQuality({
                workerGroup, packId, pipelineId: row.pipeline_name,
                sourcetype: canonicalSourcetype, destFormat: row.dest_format,
                sampleName: getSampleName(canonicalSourcetype),
                // READ-ONLY, at any score. Not a threshold nothing can reach —
                // that ran the full repair loop on a pack the operator asked
                // only to measure (see repairQuality's dryRun).
                dryRun: true,
                onProgress: (m) => commitRow(i, { message: m }),
              });
              const score = res?.finalScore ?? null;
              if (!res || score == null) {
                // The pipeline was read, not measured. Reporting that as a
                // successful score of 0 is the Rule 32 failure one layer up.
                // (A scorecard writes nothing, so it has no half-done state to
                // report: no score means no measurement.)
                commitRow(i, { status: 'skipped', phase: 'done', score: null, report: res?.report || null,
                  message: `Not scored — ${res?.error || 'live scoring unavailable'}` });
                return;
              }
              commitRow(i, { status: 'success', phase: 'done', score, report: res.report || null, message: `Score: ${score}` });
            } catch (e: any) {
              commitRow(i, { status: 'error', phase: 'done', message: `Scoring failed: ${e.message?.slice(0, 80)}` });
            }
            return;
          }
          // Default: skip
          commitRow(i, { status: 'skipped', phase: 'done', message: 'Skipped (pack exists)' });
          void maybeLogScore({
            sourcetype: canonicalSourcetype,
            pack_id: packId,
            pipeline_id: row.pipeline_name,
            dest_format: row.dest_format,
            score: 0,
            sample_name: '',
            model_used: '',
            tokens_input: 0,
            tokens_output: 0,
            worker_group: workerGroup,
            is_golden_path: false,
            generation_mode: '',
            findings_count: 0,
            status: 'skipped',
            deploy_message: 'Skipped (pack exists)',
          });
          return;
        }

        const routeFilter = sanitizeFilter(row.filter || `sourcetype=='${row.sourcetype}'`);

        const batchState: WizardState = {
          packName: row.pack_name,
          displayName: row.pack_name,
          sourceMode: 'ai-generate',
          sampleEvents: '',
          destFormat,
          destFormats: [destFormat],
          manualFormat: '',
          routeFilter,
          workerGroup,
        };

        // Resolve the row's build destFormat: 'sentinel' → chosen table
        // (CommonSecurityLog → 'commonsecuritylog' golden path), else itself.
        // Bare cim/asim/ocsf stay bare until we have a sample (concretized below).
        let destFmt = resolveDestFmt(destFormat, {
          sentinelTable: row.sentinelTable,
          manualFormat: batchState.manualFormat,
          cimModel: row.cimModel,
        });
        const batchLog = (msg: string) => commitRow(i, { message: msg });
        // Preserve the raw Windows channel for sample resolution (canonical parser,
        // channel-specific sample). `sourcetype` is canonical after pre-flight; the raw
        // name survives as outputSourcetype.
        const sampleSourcetype = batchSampleSourcetype(row.outputSourcetype || row.sourcetype, canonicalSourcetype);
        const rowStarted = Date.now();
        // A row's own sample is the user's data: it carries the paste source mode,
        // so "Require sanitised samples" keeps it out of every AI prompt.
        const rowSourceMode = row.sample ? BATCH_ROW_SAMPLE_SOURCE_MODE : undefined;
        const preparedSample = await resolveSourceSample(canonicalSourcetype, batchLog, sampleSourcetype, row.sample);
        const prepared = await resolveSourceExtraction(canonicalSourcetype, preparedSample, batchLog, rowSourceMode);
        const { sampleEvents } = prepared;
        commitRow(i, {
          sampleTier: prepared.sampleTier,
          sampleReason: prepared.sampleReason,
          timings: { ...(results[i].timings || {}), prepareMs: prepared.prepMs },
        });
        if (!sampleEvents.trim()) {
          // Name the cause on the row. 'No sample available — upload a file' was
          // true but useless: it hid a 90s AI timeout behind an operator action.
          commitRow(i, {
            status: 'awaiting-sample', phase: 'done',
            message: `No sample: ${prepared.sampleReason} — upload a sample file or skip this row.`,
          });
          // Log parked rows too — otherwise "39 of 73 needed a sample" is
          // invisible to the scores dataset and the fix can't be measured.
          // 'skipped' (not 'error'): the row is awaiting operator input and
          // produced no pack; sample_tier='none' is the precise filter.
          void maybeLogScore({
            sourcetype: canonicalSourcetype, pack_id: packId, pipeline_id: row.pipeline_name, dest_format: destFmt,
            score: 0, sample_name: '', model_used: '', tokens_input: 0, tokens_output: 0,
            worker_group: workerGroup, is_golden_path: false, generation_mode: 'staged', findings_count: 0,
            status: 'skipped', deploy_message: `awaiting-sample: ${prepared.sampleReason}`,
            builder: 'staged', build_mode: mode, origin: 'batch',
            sample_tier: 'none', sample_reason: prepared.sampleReason, prepare_ms: prepared.prepMs,
          });
          return;
        }
        batchState.sampleEvents = sampleEvents;

        // Concretize bare schema families once the sample is known — same keys
        // buildPack / interactive resolveDestFmt use. Always re-run for the
        // CSV family so a preflight model + sample agree on one golden key.
        if (destFormat === 'cim') {
          destFmt = concretizeCimFormat('cim', canonicalSourcetype, sampleEvents, row.cimModel);
        } else if (destFormat === 'asim') {
          destFmt = concretizeAsimFormat('asim', canonicalSourcetype, sampleEvents);
        } else if (destFormat === 'ocsf' || destFormat === 'nextgen') {
          destFmt = concretizeOcsfFormat(destFormat, canonicalSourcetype, sampleEvents);
        }
        const batchCimModel = destFormat === 'cim'
          ? (row.cimModel || cimModelForFormatKey(destFmt) || undefined)
          : row.cimModel;

        // POST-SAMPLE SCHEMA RE-CHECK: only suggest sub-type changes WITHIN the
        // same format family (e.g. sentinel table A → B, CIM model X → Y). Never
        // suggest switching output format entirely (CIM → OCSF) — the user chose
        // the format deliberately in the CSV; cross-format advice just blocks the batch.
        if (destFmt === 'sentinel' || destFmt === 'cim') {
          // Sub-type suggestions within sentinel/CIM are handled by the preview
          // table (sentinelTable / cimModel selectors), not here. No parking needed.
        }

        commitRow(i, { phase: 'building', message: `Building ${row.pipeline_name} (3-stage) from prepared ${canonicalSourcetype} data…` });
        const buildStarted = Date.now();

        // Build with the 3-stage best-score-wins engine (same as demo + Create
        // new pack). Deferred: the pack is created/patched but not committed —
        // one group commit+deploy runs after all rows (Phase 1b below).
        const batchPackageJson = {
          version: '1.0.0', author: 'Cribl Pack Generator (batch)', tags: { streamtags: [] }, exports: [],
          displayName: row.pack_name, name: packId,
          description: `${canonicalSourcetype} to ${destFmt.toUpperCase()} (3-stage).`,
        };
        // Live per-stage progress: show which stage is building + its score as
        // each completes (extraction → mapping → output shaping).
        const liveScores: { extraction: number | null; mapping: number | null; optimization: number | null } = { extraction: null, mapping: null, optimization: null };
        const built = await buildStagedPipeline({
          sourcetype: canonicalSourcetype, outputSourcetype: row.outputSourcetype || row.sourcetype, destFormat: destFmt, sampleEvents,
          group: workerGroup, packId, pipelineId: row.pipeline_name, packageJson: batchPackageJson,
          reductionToggles: { drop_noise: false, remove_null_fields: true, compact_output: false, field_cleanup: true },
          thresholds: batchThresholds, shareOn: batchShareOn, mode, routeFilter, origin: 'batch', cimModel: batchCimModel, log: batchLog, logScore: maybeLogScore,
          preparedParseFns: prepared.aiParseFunctions?.functions,
          sampleTier: prepared.sampleTier, sampleReason: prepared.sampleReason, prepareMs: prepared.prepMs,
          sampleSourceMode: rowSourceMode,
          sampleSanitised: row.sampleSanitised,
          onTrace: trace => setBatchTrace(i, trace),
          onStage: (r) => {
            liveScores[r.stage] = r.score;
            commitRow(i, { phase: r.stage === 'optimization' ? 'scoring' : 'building', stageScores: { ...liveScores },
              message: `${r.stage} ${r.score ?? 'n/a'}${r.source && r.source !== 'none' ? ' (' + r.source + ')' : ''}` });
          },
        });
        if (!built) {
          commitRow(i, { status: 'error', phase: 'done', message: 'No sample events — provide a sample for this sourcetype (upload or AI-generate), then Rerun.' });
          void maybeLogScore({
            sourcetype: canonicalSourcetype, pack_id: packId, pipeline_id: row.pipeline_name, dest_format: destFmt,
            score: 0, sample_name: getSampleName(canonicalSourcetype), model_used: '', tokens_input: 0, tokens_output: 0,
            worker_group: workerGroup, is_golden_path: false, generation_mode: 'staged', findings_count: 0,
            status: 'error', deploy_message: 'No sample events for this sourcetype', flow: 'normal',
            builder: 'staged', build_mode: mode, origin: 'batch', first_score: 0, final_score: 0, deployment_score: 0,
          });
          return;
        }
        const deployedPipeline = { pipelineId: row.pipeline_name, destFormat: destFmt, sourcetype: canonicalSourcetype, packId, workerGroup, sampleName: getSampleName(canonicalSourcetype) };
        deployed.push(deployedPipeline);
        needsCommit = true;
        const modeLabel = mode === 'new' ? 'Pack created' : 'Pipeline added';
        // Overall score is the extraction+mapping average. Scoring already
        // happened inside the builder.
        const mapStage = built.stages.find(s => s.stage === 'mapping');
        const extStage = built.stages.find(s => s.stage === 'extraction');
        const optStage = built.stages.find(s => s.stage === 'optimization');
        const stageScores = { extraction: extStage?.score ?? null, mapping: mapStage?.score ?? null, optimization: optStage?.score ?? null };
        const stageReport = built.stages.map(s => ({ stage: s.stage, source: s.source, score: s.score, reasons: s.reasons, outEvent: s.out?.[0] }));
        batchReportStages.current[i] = { stages: stagesFromBuilt(built.stages, sampleEvents), destFormat: destFmt };
        // null (N/A) stays null — a passthrough raw copy has nothing to score; 0
        // would misreport it as a failed build. Display falls back to stage pills.
        const score = averageStageScores(extStage?.score, mapStage?.score, optStage);
        commitRow(i, {
          status: 'success', phase: 'done', score, stageScores, stageReport,
          timings: { ...(results[i].timings || {}), buildMs: Date.now() - buildStarted, totalMs: Date.now() - rowStarted },
          message: `${modeLabel}: E ${stageScores.extraction ?? 'n/a'} · M ${stageScores.mapping ?? 'n/a'} · S ${stageScores.optimization ?? 'n/a'}`,
        });
      } catch (err) {
        const msg = err instanceof Error
          ? (err.message || err.toString() || `${err.name || 'Error'} (no message)`)
          : (typeof err === 'string' ? err : JSON.stringify(err) || 'Unknown error');
        console.error(`[batch] row ${i + 1} (${results[i].row.pipeline_name}) failed:`, err);
        commitRow(i, { status: 'error', phase: 'done', message: msg });
        const errRow = results[i].row;
        void maybeLogScore({
          sourcetype: canonicalizeSourcetype(errRow.sourcetype),
          pack_id: toKebab(errRow.pack_name),
          pipeline_id: errRow.pipeline_name,
          dest_format: errRow.dest_format,
          score: 0,
          sample_name: '',
          model_used: loadQualitySettings().normalModel,
          tokens_input: 0,
          tokens_output: 0,
          worker_group: workerGroup,
          is_golden_path: false,
          generation_mode: 'ai',
          findings_count: 0,
          status: 'error',
          deploy_message: msg,
        });
      }
    };

    // Group rows by pack ID — rows within the same pack must run sequentially
    // (first creates the pack, subsequent ones add pipelines).
    const packGroups = new Map<string, number[]>();
    for (let i = 0; i < batchRows.length; i++) {
      const packId = toKebab(batchRows[i].pack_name);
      if (!packGroups.has(packId)) packGroups.set(packId, []);
      packGroups.get(packId)!.push(i);
    }

    // One runner for both cases: `concurrency: 1` IS the sequential path (pack
    // groups keep the CSV's row order, so a 1-slot run visits rows in order and
    // the old separate `createdPacks` bookkeeping is redundant — the group itself
    // records which row creates the pack). Slot release lives in `runPackGroups`
    // so a row that rejects cannot strand the batch before its commit+deploy.
    const groupQueues = [...packGroups.values()];
    const groupFailures = await runPackGroups(groupQueues, batchConcurrency, processRow);
    // Killed while rows were in flight: Kill already settled the screen, and the
    // promise is that nothing gets committed.
    if (killed()) return;
    if (groupFailures.length) {
      console.error('[batch] pack group(s) aborted:', groupFailures);
    }

    // Phase 1b: single commit+deploy. Every row built its pack deferred (the
    // 3-stage builder already scored + stored golden sub-parts), so one group
    // commit makes all packs + routes live in a single cycle — no per-row deploy
    // churn and no separate scoring pass (scoring happened inside each build).
    //
    // …unless a row is holding an unverified repair candidate: one shared commit
    // means one bad pipeline would go live with all the good packs.
    const commitDecision = resolveBatchCommit({ needsCommit, unresolved: batchUnresolved });
    if (commitDecision.error) setBatchError(commitDecision.error);
    if (commitDecision.commit) {
      try {
        await commitDeploy(workerGroup, `Deploy ${deployed.length} batch pack(s)`);
      } catch (e) {
        console.warn('[batch] final commit-deploy failed:', e);
        setBatchError(`Pipelines were created but commit+deploy failed — they are NOT live on the worker group. Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Save how long each finished row took, per build path, so the next
    // batch's estimate is measured (src/batch-estimate.ts), never guessed.
    saveRowTimings(recordBatchTimings(loadRowTimings(), results
      .filter(r => r.status === 'success' && r.timings?.totalMs)
      .map(r => ({ path: rowBuildPath(r.stageReport?.map(x => x.source), 'ai'), totalMs: r.timings!.totalMs! }))));
    setBatchRunSpan(span => span ? { ...span, end: Date.now() } : span);

    // The run is over either way (finished or user-stopped) — nothing left to
    // offer as Resume.
    void clearBatchCheckpoint();
    setBatchStopping(false);
    setDeployedPipelines(deployed);
    setValidationReports({});
    setRepairSelection(new Set());
    setValidationError('');
    setBatchRunning(false);
  };

  const handleStopBatch = () => {
    batchStopRequested.current = true;
    setBatchStopping(true);
  };

  // Kill: end the foreground run NOW, without waiting for rows in flight. The
  // generation bump detaches the hung run from the screen; its rows are settled
  // as killed and nothing is committed (see src/batch-kill.ts).
  const handleKillBatch = () => {
    if (killArmed !== 'fg') { setKillArmed('fg'); return; }
    setKillArmed(null);
    batchRunGen.current++;
    batchStopRequested.current = true;
    setBatchResults(prev => killForegroundResults(prev));
    setBatchRunSpan(span => span ? { ...span, end: Date.now() } : span);
    setBatchError('Batch killed — rows that were still running were abandoned and nothing was committed. Their packs may hold uncommitted config on the worker group.');
    void clearBatchCheckpoint();
    setBatchStopping(false);
    setBatchRunning(false);
  };

  // Restores the state handleBatchDeploy reads from closure (batchRows,
  // batchConflictActions, batchSkipPacks), then hands off to the
  // pendingResumeRun effect, which fires once that restore has committed.
  const handleResumeBatch = () => {
    const cp = batchResumeCheckpoint;
    if (!cp) return;
    setBatchResumeCheckpoint(null);
    setBatchRows(cp.batchRows as BatchRow[]);
    setBatchConflictActions(new Map(cp.conflictActions as [string, ConflictAction][]));
    setBatchSkipPacks(new Set(cp.skipPacks));
    setSelectedGroup(cp.workerGroup);
    setPendingResumeRun({ workerGroup: cp.workerGroup, results: cp.results as BatchResult[] });
  };

  const handleDiscardResume = () => {
    setBatchResumeCheckpoint(null);
    void clearBatchCheckpoint();
  };

  // The handoff. Everything the background runner will ever know is decided
  // here, from the SAME batchRows, pre-flight samples and conflict answers the
  // foreground engine reads — `buildBackgroundManifest` owns that translation
  // so the contract is a value, not a callback. This handler only gathers the
  // inputs, refuses a provider a Backend Function cannot use, and starts the
  // run.
  const handleStartBackgroundBatch = async (workerGroup: string) => {
    if (batchBgStarting) return;
    setBatchBgError('');
    // A run that could not be read, and a dismissal that did not complete, both
    // belong to the run that is ending here. Carrying either into the next one
    // describes a fault in a run that has not made a single request yet.
    setBatchBgRead(BACKGROUND_READ_OK);
    setBatchBgNotice('');
    if (batchRows.length > BATCH_BACKGROUND_MAX_ROWS) {
      setBatchBgError(`A background run takes at most ${BATCH_BACKGROUND_MAX_ROWS} pipelines; this file has ${batchRows.length}.`);
      return;
    }
    setBatchBgStarting(true);
    try {
      // A background run executes its Backend Function on the target group's
      // workers. A group with none connected cannot service the invocation, so
      // the kickoff would otherwise sit for the full ~30s bridge timeout and
      // return a bare "Request timeout" with no subject. Refuse up front, named.
      // A failed health read is not proof of absence — degrade to the old
      // behaviour (let it start) rather than block on a transient error.
      const health = await listWorkers().catch(() => null);
      const blockReason = backgroundGroupBlockReason(workerGroup, health);
      if (blockReason) {
        setBatchBgError(blockReason);
        return;
      }
      const [ai, quality] = await Promise.all([loadSettingsAsync(), loadQualitySettingsAsync()]);
      // Before anything durable exists: a run on credentials only this browser
      // holds would fail every stage server-side, one row per minute.
      const snapshot = backgroundAiSnapshot(ai, quality);
      if (!snapshot.ok) {
        setBatchBgError(snapshot.reason);
        return;
      }
      // No sample generation here: a row no store could supply is queued with
      // `needsSample`, and its first background stage creates and verifies one
      // (Cribl AI). Start only writes the manifest — the tab can close at once.
      const { checkpoint, artifacts } = buildBackgroundManifest({
        runId: crypto.randomUUID(),
        workerGroup,
        rows: batchRows,
        samples: preflightSampleCache.current,
        tiers: preflightSampleOrigin.current,
        prepareMs: preflightSamplePrepareMs.current,
        actions: batchConflictActions,
        skippedPacks: batchSkipPacks,
        ai: snapshot.snapshot,
        now: Date.now(),
      });
      await startBatchBackgroundRun(checkpoint, artifacts);
      // Only here. Every way this can fail — an ineligible provider, an active
      // run, a KV or schedule refusal — leaves the operator on this screen with
      // the reason next to the button they pressed, not on a progress screen
      // polling a run that was never created.
      setBatchBgCheckpoint({ ...checkpoint, status: 'running' });
      setStep('batch-bg-running');
    } catch (e) {
      setBatchBgError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchBgPrep('');
      setBatchBgStarting(false);
    }
  };

  // Stop writes ONE durable flag and nothing else. The runner re-reads the
  // status before every stage and before every save, so the next scheduled tick
  // is what winds the run down — invoking the worker from here would start a
  // second long call alongside the one that may already be mid-stage.
  const handleStopBatchBackground = async () => {
    const runId = batchBgCheckpoint?.runId;
    if (!runId || batchBgStopping) return;
    setBatchBgStopping(true);
    try {
      await stopBatchBackgroundRun(runId);
      // The reload is the same read the poll does, folded the same way: a
      // reload that comes back empty must leave the run on screen rather than
      // blanking it, because the run itself is still winding down. Its own
      // try/catch, because Stop has already SUCCEEDED by this point — a reload
      // that failed is an unreadable run, not an unconfirmed stop.
      let outcome: BackgroundPollOutcome;
      try {
        outcome = { ok: true, checkpoint: await loadBatchBackgroundRun(runId) };
      } catch (e) {
        outcome = backgroundReadFailure(e, runId);
      }
      const reloaded = foldBackgroundRead(batchBgCheckpoint, outcome);
      setBatchBgCheckpoint(reloaded.checkpoint);
      setBatchBgRead(reloaded.read);
    } catch (e) {
      setBatchBgRead({
        status: 'unavailable',
        message: `Stop was not confirmed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      // Always: a Stop that failed must leave a button the operator can press
      // again, not one stuck reading "Stopping…" forever.
      setBatchBgStopping(false);
    }
  };

  // The one way out of a run that will never move again — finished, failed,
  // parked (legacy manifests only, since the runner performs its own quality
  // rows), or gone from KV entirely. It clears the active pointer as well as
  // the manifest, so the next Start is not refused by a run nobody is waiting
  // on.
  //
  // The durable delete is AWAITED BEFORE the screen resets. Clearing first read
  // as success: a delete that failed left the run on the server, the operator
  // was returned to the mode screen believing it was gone, and it reappeared on
  // the next mount — or refused their next Start.
  // Kill: for when Stop does not land (a hung invocation holds the lease, so
  // every tick answers busy). Removes the schedule and writes the run terminal
  // from here, without waiting for a tick.
  const handleKillBatchBackground = async () => {
    const runId = batchBgCheckpoint?.runId;
    if (!runId || batchBgKilling) return;
    if (killArmed !== 'bg') { setKillArmed('bg'); return; }
    setKillArmed(null);
    setBatchBgKilling(true);
    try {
      const killed = await killBatchBackgroundRun(runId);
      if (killed) setBatchBgCheckpoint(killed);
      setBatchBgRead(BACKGROUND_READ_OK);
    } catch (e) {
      setBatchBgRead({
        status: 'unavailable',
        message: `Kill was not confirmed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBatchBgKilling(false);
    }
  };

  const handleDismissBatchBackground = async () => {
    // A corrupt manifest found at mount produces no checkpoint at all, so the
    // run id the failed READ carried is the only thing naming what to clean up.
    const runId = batchBgCheckpoint?.runId || batchBgRead.runId;
    if (batchBgDismissing) return;
    setBatchBgNotice('');
    setBatchBgDismissing(true);
    try {
      // Nothing durable to clear when no run is recorded behind the screen —
      // every other path deletes first and resets second.
      if (runId) await dismissBatchBackgroundRun(runId);
      setBatchBgCheckpoint(null);
      setBatchBgRead(BACKGROUND_READ_OK);
      resetAll();
    } catch (e) {
      // Stay exactly where we are, and say what is true: the run is still
      // recorded. Neutral wording — this is not a failed Start.
      setBatchBgNotice(`${BACKGROUND_DISMISS_FAILED} (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBatchBgDismissing(false);
    }
  };

  // Build and download the whole-run scoring report — the SAME extended report
  // the single-pack flow downloads, one per-format page for every built row,
  // grouped by pack, with a summary index on top. Each row's build detail is
  // reconstructed from its persisted artifact (compression is what keeps those
  // artifacts under the App KV limit, so this report has data to read); live
  // pipeline profiles are omitted, so the statistics block degrades gracefully.
  // `onlyPack` scopes it to one pack — the per-row button in the result list.
  const handleViewBatchReport = async (run: BackgroundRunView, onlyPack?: string) => {
    if (batchReportBusy) return;
    setBatchReportError('');
    setBatchReportBusy(true);
    try {
      // Only rows that actually produced build output — a quality row or a
      // queued/failed-before-extraction row has no format page to render.
      const buildRows = run.groups
        .flatMap(g => g.rows)
        .filter(r => r.group === 'build' && r.artifactKey)
        .filter(r => onlyPack == null || (r.packName || r.pipelineId || 'pack') === onlyPack);
      if (buildRows.length === 0) {
        setBatchReportError('No built rows in this run have a scorecard to report.');
        return;
      }
      // One pack section per pack name, in first-seen (CSV) order; each built
      // format under it becomes a page.
      const packOrder: string[] = [];
      const byPack = new Map<string, BatchReportPack>();
      for (const r of buildRows) {
        const packId = r.packName || r.pipelineId || 'pack';
        if (!byPack.has(packId)) {
          packOrder.push(packId);
          // The declared source, not the canonical parser key: an FTD
          // pack canonicalizes to cisco_asa and read as an ASA pack.
          byPack.set(packId, { packId, sourcetype: r.declaredSourcetype, data: [] });
        }
        const pack = byPack.get(packId)!;
        try {
          const artifact = await loadBatchBackgroundRowArtifact(r.artifactKey);
          const stages = stagesFromArtifact(artifact);
          if (stages.length === 0) continue;
          pack.data.push(buildReportFormatVM(stages, r.destFormat, r.pipelineId, undefined, r.sourcetype));
        } catch (e) {
          // A single unreadable row degrades to a named error inside its pack
          // rather than failing the whole report.
          pack.error = e instanceof Error ? e.message : String(e);
        }
      }
      const packs = packOrder.map(id => byPack.get(id)!).filter(p => p.data.length > 0 || p.error);
      if (packs.length === 0) {
        setBatchReportError('None of this run’s built rows had a readable scorecard.');
        return;
      }
      openBatchReportHtml(buildBatchReportHtml(packs, { workerGroup: run.workerGroup, runId: run.runId, visualizerBaseUrl: criblInstanceBaseUrl(), visualizerAvailability: cachedVisualizerAvailability() }), [run.runId || 'run', onlyPack].filter(Boolean).join('-'));
    } catch (e) {
      setBatchReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchReportBusy(false);
    }
  };

  // Open the report in a new tab to VIEW it. A popup blocker can refuse the
  // window (it is a user gesture, so this is rare) — fall back to a download
  // so the report is never lost. The blob URL stays alive for the session.
  const openBatchReportHtml = (html: string, name: string) => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const win = window.open(url, '_blank');
    if (!win) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch-scoring-report-${name}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    // Not revoked: the tab may reload or follow an in-page link long after a
    // timer would fire, and one report blob per click is cheap.
  };

  // The rows of the run in this tab that the whole-run report can read.
  const foregroundReportRows = (): ForegroundReportRow[] => batchResults.map((r, i) => {
    const kept = r.status === 'success' ? batchReportStages.current[i] : undefined;
    return {
      packName: r.row.pack_name, sourcetype: r.row.sourcetype, pipelineId: r.row.pipeline_name,
      destFormat: kept?.destFormat || r.row.dest_format, stages: kept?.stages || [],
    };
  });

  // The same whole-run report as the background screen, for a run built in
  // this tab — read from the in-memory build detail, no App KV round-trip.
  const handleViewForegroundBatchReport = () => {
    if (batchReportBusy) return;
    setBatchReportError('');
    setBatchReportBusy(true);
    try {
      const groups = groupForegroundReportRows(foregroundReportRows());
      if (groups.length === 0) {
        setBatchReportError('No row of this run built in this tab, so there is no scorecard to report.');
        return;
      }
      const packs: BatchReportPack[] = groups.map(g => ({
        packId: g.packId, sourcetype: g.sourcetype,
        data: g.rows.map(r => buildReportFormatVM(r.stages, r.destFormat, r.pipelineId, undefined, r.sourcetype)),
      }));
      openBatchReportHtml(buildBatchReportHtml(packs, { workerGroup: selectedGroup, visualizerBaseUrl: criblInstanceBaseUrl(), visualizerAvailability: cachedVisualizerAvailability() }), selectedGroup || 'run');
    } catch (e) {
      setBatchReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchReportBusy(false);
    }
  };

  // Run schema validation across all deployed pipelines.
  // Accepts an explicit list so the auto-validate-after-deploy path can pass the
  // freshly-deployed pipelines without waiting for setState to flush.
  const runValidation = async (pipelines?: DeployedPipeline[]) => {
    const targets = pipelines ?? deployedPipelines;
    setValidatingPipelines(true);
    setValidationError('');
    setRepairSelection(new Set());
    setValidationReports({});
    const schemaResults: Record<string, ValidationReport | null> = {};
    try {
      for (const dp of targets) {
        try {
          const report = await validatePipeline({
            workerGroup: dp.workerGroup,
            packId: dp.packId,
            pipelineId: dp.pipelineId,
            sourcetype: dp.sourcetype,
            destFormat: dp.destFormat,
            sampleName: dp.sampleName,
          });
          if (report === null) {
            setValidationError('Validation unavailable — configure AI in Settings, or run the dev backend.');
            break;
          }
          schemaResults[dp.pipelineId] = applyDeterministicScore(report);
          setValidationReports({ ...schemaResults });
        } catch (err: unknown) {
          schemaResults[dp.pipelineId] = null;
          setValidationReports({ ...schemaResults });
          if (!validationError) setValidationError(err instanceof Error ? err.message : 'Validation failed');
        }
      }
    } finally {
      setValidatingPipelines(false);
    }
  };

  // Repair the selected pipelines using their validation findings, then re-validate them.
  // Improve the selected pipelines by ITERATING on the exact findings in their
  // scoring cards: repair → re-validate → repair again, until the score reaches
  // the target, stops improving, or we hit the round cap. Keeps the best-scoring
  // version so a bad round can't regress the card. This drives the visible
  // findings/missingFields to zero rather than a single one-shot nudge.
  const IMPROVE_TARGET = 95;
  const IMPROVE_MAX_ROUNDS = 4;
  const repairSelected = async () => {
    if (repairSelection.size === 0) return;
    setRepairing(true);
    setValidationError('');
    try {
      const reports = { ...validationReports };
      for (const dp of deployedPipelines) {
        if (!repairSelection.has(dp.pipelineId)) continue;
        let current = reports[dp.pipelineId];
        if (!current) continue;
        let bestScore = current.score;
        for (let round = 0; round < IMPROVE_MAX_ROUNDS; round++) {
          // Stop when the card is already good enough or has no actionable items.
          if (current.score >= IMPROVE_TARGET) break;
          const actionable = (current.findings?.length || 0) + (current.missingFields?.length || 0);
          if (actionable === 0) break;
          try {
            await repairPipeline({
              workerGroup: dp.workerGroup,
              packId: dp.packId,
              pipelineId: dp.pipelineId,
              sourcetype: dp.sourcetype,
              destFormat: dp.destFormat,
              sampleName: dp.sampleName,
              findings: current.findings,
              lessons: current.lessons,
              missingFields: current.missingFields,
              emptyFields: current.emptyFields,
            });
            const fresh = await validatePipeline({
              workerGroup: dp.workerGroup,
              packId: dp.packId,
              pipelineId: dp.pipelineId,
              sourcetype: dp.sourcetype,
              destFormat: dp.destFormat,
              sampleName: dp.sampleName,
            });
            if (!fresh) break; // validation unavailable — stop this pipeline
            const scored = applyDeterministicScore(fresh);
            // Keep the better report; stop if a round didn't improve the score.
            const improved = scored.score > bestScore;
            if (scored.score >= bestScore) { reports[dp.pipelineId] = scored; bestScore = scored.score; }
            setValidationReports({ ...reports });
            current = scored;
            if (!improved) break; // plateaued — further rounds unlikely to help
          } catch (err: unknown) {
            if (!validationError) setValidationError(err instanceof Error ? err.message : 'Improve failed');
            break;
          }
        }
      }
      setRepairSelection(new Set());
    } finally {
      setRepairing(false);
    }
  };

  const toggleRepair = (pipelineId: string) => {
    setRepairSelection(prev => {
      const next = new Set(prev);
      if (next.has(pipelineId)) next.delete(pipelineId); else next.add(pipelineId);
      return next;
    });
  };

  // @deprecated (build 687) keep-alive: the schema-validation report block was
  // removed from every scoring screen (superseded by <ScoringReport>), so these
  // handlers/state are no longer rendered. Retained (per request) for a follow-up
  // cleanup; this reference silences noUnusedLocals until then.
  void [validatingPipelines, repairing, repairSelected, toggleRepair];

  // A batch row's build trace, on both the running and done screens: download
  // it, or hand it to the AI analysis the single-pack wizard already offers.
  const renderBatchTraceActions = (i: number) => {
    const trace = batchTraces[i];
    if (!trace) return null;
    return (
      <>
        <button className="batch-act-btn"
          title={`Download this row's build trace (${trace.status}) — sample events, candidate decisions, stage scores and final functions. Review before sharing.`}
          onClick={() => downloadBuildTrace(trace, trace.context.pipelineId)}>
          Trace
        </button>
        <TraceAiPanel traces={[trace]} buttonLabel="Analyze" buttonClassName="batch-act-btn" />
      </>
    );
  };

  // Flags the function usage an expert reviewer looks for first: more than one
  // Parser or regex_extract in the built pipeline.
  const renderBatchFunctionFlags = (i: number) => {
    const fns = batchTraces[i]?.finalFunctions;
    if (!fns) return null;
    const c = functionComposition(fns);
    const flags = [
      c.multiParser ? `${c.serde}× Parser` : '',
      c.multiRegex ? `${c.regexExtract}× regex` : '',
    ].filter(Boolean);
    if (flags.length === 0) return null;
    return (
      <span className="batch-fn-flag" title={`Built pipeline: ${formatFunctionTypes(c.byType)}${batchResults[i]?.repairedAfterBuild ? ' (before Improve)' : ''}`}>
        {flags.join(' · ')}
      </span>
    );
  };

  // "Open in Pipeline Visualizer" link for one batch row's pack/pipeline — same
  // base-URL resolution as the single-pack <ScoringReport> (criblInstanceBaseUrl,
  // null outside iframe mode, in which case this renders nothing).
  const renderVisualizerLink = (i: number) => {
    const r = batchResults[i];
    const base = criblInstanceBaseUrl();
    if (!r || !base || !selectedGroup || !r.row.pipeline_name) return null;
    const href = pipelineVisualizerUrl(base, selectedGroup, toKebab(r.row.pack_name), r.row.pipeline_name);
    return (
      <PipelineVisualizerLink className="batch-score-visualizer" href={href} align="left" title={`Open ${r.row.pack_name} in the Pipeline Visualizer`}>
        🔗
      </PipelineVisualizerLink>
    );
  };

  // Inline score report for one batch row — rendered directly under the row
  // (both the running and done screens). Shows a loading/unavailable state until
  // showBatchRow() has fetched the report.
  const renderInlineReport = (i: number) => {
    const r = batchResults[i];
    if (!r) return null;
    const rep = r.report;
    const band = (r.score ?? 0) >= 85 ? 'good' : (r.score ?? 0) >= 60 ? 'warn' : 'fail';
    // Prefer the 3-stage report (per-stage source/score/reasons + output event)
    // over the old single validation report.
    if (r.stageReport && r.stageReport.length) {
      const srcLabel = (s: string) => s === 'search' ? '🔍 Search' : s === 'golden' ? '🏆 golden' : s === 'copilot' ? '🐐 Copilot' : s === 'ai' ? '🤖 AI' : s === 'static' ? '⚙ built-in' : '—';
      const pb = (s: number | null) => s == null ? 'na' : s >= 85 ? 'good' : s >= 60 ? 'warn' : 'fail';
      return (
        <div className="batch-score-report batch-score-inline" role="dialog">
          <div className="batch-score-report-head">
            <strong>{r.row.pipeline_name}</strong>
            {renderVisualizerLink(i)}
            <button className="batch-score-close" onClick={() => setBatchScoreOpen(null)}>✕</button>
          </div>
          {r.stageReport.map((st, k) => (
            <div key={k} style={{ borderTop: k ? '1px solid #f0f0f0' : 'none', paddingTop: k ? 8 : 0, marginTop: k ? 8 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ textTransform: 'capitalize' }}>{st.stage}</strong>
                <span className={`batch-score-pill score-${pb(st.score)}`}>{st.score == null ? 'N/A' : `${st.score}/100`}</span>
                <span style={{ fontSize: 11, color: '#722ed1' }}>{srcLabel(st.source)}</span>
              </div>
              {st.reasons?.[0] && <p className="score-why" style={{ marginTop: 4 }}>{st.reasons[0]}</p>}
              {st.outEvent && <pre className="exp-dbg-pre" style={{ maxHeight: 90, marginTop: 4 }}>{JSON.stringify(Object.fromEntries(Object.entries(st.outEvent).filter(([kk]) => kk !== '_raw').slice(0, 12)), null, 0)}</pre>}
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="batch-score-report batch-score-inline" role="dialog">
        <div className="batch-score-report-head">
          <strong>{r.row.pipeline_name}</strong>
          {r.score != null && <span className={`batch-score-pill score-${band}`}>{r.score}/100</span>}
          {renderVisualizerLink(i)}
          <button className="batch-score-close" onClick={() => setBatchScoreOpen(null)}>✕</button>
        </div>
        {!rep && <p className="batch-score-summary">{batchRowBusy.has(i) ? 'Loading score report…' : 'No score report available.'}</p>}
        {rep && (<>
          {rep.summary && <p className="batch-score-summary">{rep.summary}</p>}
          {rep.missingFields && rep.missingFields.length > 0 && (
            <div className="validation-fields"><strong>Missing:</strong> {rep.missingFields.join(', ')}</div>
          )}
          {rep.emptyFields && rep.emptyFields.length > 0 && (
            <div className="validation-fields"><strong>Empty:</strong> {rep.emptyFields.join(', ')}</div>
          )}
          {rep.findings && rep.findings.length > 0 && (
            <ul className="validation-findings">
              {rep.findings.map((f, k) => (
                <li key={k} className={`finding-${f.severity}`}><strong>{f.severity}</strong> · <code>{f.field}</code> — {f.issue}</li>
              ))}
            </ul>
          )}
          {(!rep.findings || rep.findings.length === 0) && (!rep.missingFields || rep.missingFields.length === 0) && (
            <p className="batch-score-clean">No issues — every source field the sample supplied was mapped correctly.</p>
          )}
        </>)}
      </div>
    );
  };

  // ---- shell: left rail + step pills (wizard-steps.ts owns the sequences) ----
  const wizardStepList = step === 'mode' ? [] : wizardSteps(packMode as WizardMode, {
    addImproveAction: addImproveAction === 'optimize' ? 'optimize' : addImproveAction ? 'add' : null,
    optimizeSample: !!optimizeGoals.sample,
    batchBackground,
    demoCleanup: step === 'demo-cleanup' || step === 'demo-cleanup-done',
  });
  const currentStepLabel = wizardStepList.find(w => w[0] === step)?.[1] || '';
  // A background batch keeps running server-side, so leaving its status screen is safe.
  const railLocked = isBusyStep(step) && step !== 'batch-bg-running';
  const RESULT_STEPS: Step[] = ['experiment-done', 'done', 'batch-done', 'demo-done', 'demo-cleanup-done', 'optimize-done', 'batch-bg-running'];
  // Leaving a run asks in the app (leaveAsk), never window.confirm: the sandboxed
  // iframe can ignore it, and it then returns false — Home did nothing.
  const [leaveAsk, setLeaveAsk] = useState<null | (() => void)>(null);
  const guardLeave = (go: () => void) => {
    const d = leaveDecision(step, { locked: railLocked, safeSteps: RESULT_STEPS });
    if (d === 'go') go();
    else if (d === 'ask') setLeaveAsk(() => go);
  };

  // ── Settings / Samples pages ──
  const prepQualityForm = () => {
    setQForm(loadQualitySettings()); setQSaveMsg(''); setLakeTestMsg(''); setGhTestMsg(''); setSampleGhTestMsg(''); setCredTestMsg('');
    if (getRunMode() === 'standalone') {
      void getCriblCreds().then(c => {
        if (c) {
          setCredForm({ org: c.org, clientId: c.clientId, clientSecret: '', userEmail: c.userEmail });
          setCredHasSecret(c.hasSecret);
          setQForm(prev => ({ ...prev, goldenTokenSet: prev.goldenTokenSet || c.hasGoldenReadToken, sanitisedSampleTokenSet: prev.sanitisedSampleTokenSet || c.hasSanitisedSampleToken }));
        }
      });
    }
  };
  // Re-read the sample counts on leaving Samples: a review session usually promotes or
  // rejects, and a badge still showing the pre-review queue reads as "nothing was written".
  const leaveSamples = () => { void fetchSampleLibrarySummary().then(setSampleLibSummary); };
  const openTool = (page: ToolPage) => {
    const next = resolveToolPage(page, getRunMode());
    // Load the form once on the way in — not per tab, or switching tabs would drop edits.
    if (!toolPage) prepQualityForm();
    else setQSaveMsg('');
    if (toolPage?.area === 'samples' && next.area !== 'samples') leaveSamples();
    setToolPage(next);
  };
  const openToolLink = (link: ToolLink) => openTool(toolLink(link, getRunMode()));
  const closeTool = () => {
    if (toolPage?.area === 'samples') leaveSamples();
    setToolPage(null);
  };
  // One form behind the Connection, Quality, Goldens and Sharing tabs: Save on any of
  // them validates and stores the whole thing, so edits on two tabs cannot half-save.
  const saveQualityForm = async () => {
            const t = Number(qForm.qualityThreshold);
            if (!(t >= 1 && t <= 100)) { setQSaveMsg('Threshold must be 1–100.'); return; }
            if (qForm.lakeUrl.trim() && !qForm.lakeUrl.trim().startsWith('http')) { setQSaveMsg('Scoring URL must be a full http(s) link (or blank for the default worker group).'); return; }
            if (qForm.shareGoldens && !/^[\w.-]+\/[\w.-]+$/.test(qForm.goldenRepo.trim())) { setQSaveMsg('Golden repo must be owner/repo.'); return; }
            if (qForm.shareGoldens && getRunMode() === 'iframe') {
              setQSaveMsg('Publishing goldens runs outside the Cribl UI only. Reading the shared pool needs nothing configured and is already on.');
              return;
            }
            const sampleRepoError = qForm.shareSanitisedSamples
              ? sanitisedSampleRepoError(qForm.sanitisedSampleRepo, qForm.sanitisedSampleBranch, qForm.goldenRepo)
              : null;
            if (sampleRepoError) {
              setQSaveMsg(sampleRepoError); return;
            }
            setQSaveMsg('Saving…');
            try {
              if (qForm.lakeToken.trim()) await saveLakeToken(qForm.lakeToken);
              if (qForm.goldenToken.trim()) await saveGoldenReadToken(qForm.goldenToken);
              if (qForm.sanitisedSampleToken.trim()) await saveSanitisedSampleToken(qForm.sanitisedSampleToken);
              const saved = {
                ...qForm,
                qualityThreshold: t,
                lakeToken: '',
                lakeTokenSet: qForm.lakeTokenSet || !!qForm.lakeToken.trim(),
                goldenToken: '',
                goldenTokenSet: qForm.goldenTokenSet || !!qForm.goldenToken.trim(),
                sanitisedSampleToken: '',
                sanitisedSampleTokenSet: qForm.sanitisedSampleTokenSet || !!qForm.sanitisedSampleToken.trim(),
              };
              saveQualitySettings(saved);
              setQForm(saved);
              await refreshAvailableGoldens();
              void checkLakeExportHealth().then(h => { setLakeExportActive(h.active); setLakeExportMsg(h.message); lakeActiveRef.current = h.active; });
              setQSaveMsg('Saved.');
            } catch (err) {
              setQSaveMsg(err instanceof Error ? err.message : 'GitHub credential save failed.');
            }
  };
  // Always lands on a clean home screen: resets even when step is already 'mode'
  // (some Back buttons set it without resetAll) and re-checks the shared goldens.
  const goHome = () => {
    closeTool();
    guardLeave(() => {
      resetAll();
      window.scrollTo({ top: 0 });
      void refreshAvailableGoldens();
    });
  };
  // Start a mode straight from the rail or a home card: same entry steps as the old home Next button.
  const startMode = (m: WizardMode, opts?: { background?: boolean }) => {
    guardLeave(() => {
      closeTool();
      if (step !== 'mode') resetAll();
      setPackMode(m);
      if (m === 'add-pipeline') setAddImproveAction(null);
      if (m === 'batch') setBatchBackground(!!opts?.background);
      setStep(m === 'batch' ? 'batch-upload' : m === 'demo' ? 'demo-group' : 'select-group');
    });
  };


  // Settings and Samples: one page each, a tab list on the left, the pane on the right.
  const renderToolPage = () => {
    if (!toolPage) return null;
    const runMode = getRunMode();
    const area = TOOL_AREAS[toolPage.area];
    const tabs = toolTabs(toolPage.area, runMode);
    const backTo = step === 'mode' ? 'Home' : (WIZARD_MODES.find(m => m.id === packMode)?.name || 'the wizard');
    const tabDot = (id: string): 'ok' | 'error' | 'checking' | null =>
      id === 'ai' ? aiStatus
      : id === 'connection' ? (lakeExportActive === true ? 'ok' : lakeExportActive === false ? 'error' : 'checking')
      : null;
    const tabCount = (id: string): number | null =>
      id === 'goldens' ? (availableGoldens.length + pushableGoldens.length) || null
      : id === 'review' && runMode === 'standalone' && sampleLibSummary ? sampleLibSummary.staged || null
      : null;
    const saveBar = (
      <div className="tp-actions">
        {qSaveMsg && <span className={`tp-msg${qSaveMsg.startsWith('Saved') ? ' ok' : qSaveMsg === 'Saving…' ? '' : ' bad'}`}>{qSaveMsg.startsWith('Saved') ? '✓ ' : ''}{qSaveMsg}</span>}
        <button className="btn-primary" onClick={() => void saveQualityForm()}>Save</button>
      </div>
    );
    const sampleView = toolPage.area === 'samples' ? sampleLibraryView(toolPage.tab) : null;
    const hasSampleToken = !!(runMode === 'standalone'
      && loadQualitySettings().shareSanitisedSamples
      && loadQualitySettings().sanitisedSampleRepo
      && loadQualitySettings().sanitisedSampleTokenSet
      && !sanitisedSampleRepoError(
        loadQualitySettings().sanitisedSampleRepo,
        loadQualitySettings().sanitisedSampleBranch,
        loadQualitySettings().goldenRepo,
      ));
    let pane: React.ReactNode = null;
    if (toolPage.area === 'settings') {
      const t: SettingsTab = toolPage.tab;
      if (t === 'ai') pane = <AiSettingsModal open embedded onClose={closeTool} onSaved={() => setAiSettingsRev(r => r + 1)} />;
      else if (t === 'datatypes') pane = <DatatypesModal open embedded onClose={closeTool} />;
      else if (t === 'connection') pane = (<>
              {getRunMode() === 'standalone' && (
                <div className="field-group" >
                  <label className="field-label">Cribl Cloud connection</label>
                  <p className="field-hint" style={{ marginTop: 0 }}>
                    OAuth2 client credentials for your org. Create at Cribl Cloud → Settings → API Credentials → Add (Client Credentials). Saved to <code>.env</code> for next time.
                  </p>
                  <span className="field-hint" style={{ display: 'block', margin: '6px 0 3px' }}>Org URL</span>
                  <input className="field-input" type="text" placeholder="https://main-yourorg-hash.cribl.cloud"
                    value={credForm.org} onChange={e => setCredForm({ ...credForm, org: e.target.value })} />
                  <span className="field-hint" style={{ display: 'block', margin: '8px 0 3px' }}>Client ID</span>
                  <input className="field-input" type="text" autoComplete="off" value={credForm.clientId}
                    onChange={e => setCredForm({ ...credForm, clientId: e.target.value })} />
                  <span className="field-hint" style={{ display: 'block', margin: '8px 0 3px' }}>Client Secret</span>
                  <input className="field-input" type="password" autoComplete="off"
                    placeholder={credHasSecret ? '•••••••• (stored — leave blank to keep)' : ''}
                    value={credForm.clientSecret} onChange={e => setCredForm({ ...credForm, clientSecret: e.target.value })} />
                  <span className="field-hint" style={{ display: 'block', margin: '8px 0 3px' }}>Your email (for score logging)</span>
                  <input className="field-input" type="text" placeholder="you@company.com"
                    value={credForm.userEmail} onChange={e => setCredForm({ ...credForm, userEmail: e.target.value })} />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
                    <button className="btn-secondary" disabled={credBusy} onClick={async () => {
                      setCredBusy(true); setCredTestMsg('Testing…');
                      const r = await testCriblCreds(credForm.org, credForm.clientId, credForm.clientSecret);
                      setCredTestMsg(r.message); setCredBusy(false);
                    }}>Test connection</button>
                    <button className="btn-primary" disabled={credBusy || !credForm.org.trim() || !credForm.clientId.trim()} onClick={async () => {
                      setCredBusy(true); setCredTestMsg('Saving…');
                      const t = await testCriblCreds(credForm.org, credForm.clientId, credForm.clientSecret);
                      if (!t.ok) { setCredTestMsg(`Not saved — ${t.message}`); setCredBusy(false); return; }
                      const s = await saveCriblCreds(credForm.org, credForm.clientId, credForm.clientSecret, credForm.userEmail);
                      setCredTestMsg(s.saved ? '✓ Saved to .env — connection verified.' : `Save failed: ${s.message || 'unknown'}`);
                      if (s.saved) setCredHasSecret(true);
                      setCredBusy(false);
                    }}>Test &amp; Save</button>
                    {credTestMsg && <span style={{ fontSize: 12, color: credTestMsg.startsWith('✓') ? '#52c41a' : credTestMsg.includes('Testing') || credTestMsg.includes('Saving') ? '#8c8c8c' : '#cf1322' }}>{credTestMsg}</span>}
                  </div>
                </div>
              )}

              <h4 className="tp-sec">Score logging</h4>
              {getRunMode() === 'standalone' && (
              <p style={{ margin: '0 0 12px' }}>
                <strong>Status: </strong>
                <span style={{ color: lakeExportActive ? '#52c41a' : '#cf1322' }}>
                  {lakeExportActive ? 'Active' : 'Inactive'}
                </span>
                <span style={{ color: '#8c8c8c', fontSize: 12 }}> — {lakeExportMsg || 'scores logged after each deploy'}</span>
              </p>
              )}

              {getRunMode() === 'standalone' && (<>
              <div className="field-group">
                <label className="field-label">Stream worker-group URL (for scoring)</label>
                <input className="field-input" type="text" value={qForm.lakeUrl}
                  onChange={e => setQForm({ ...qForm, lakeUrl: e.target.value })}
                  placeholder="http://selab.main.<org>.cribl.cloud:443" />
                <p className="field-hint">Scoring events are sent to this Stream worker-group HTTP source (which forwards to Lake/S3). Leave blank to use the default worker group.</p>
              </div>

              <div className="field-group">
                <label className="field-label">Scoring token (Bearer)</label>
                <input className="field-input" type="password" autoComplete="off" value={qForm.lakeToken}
                  placeholder={qForm.lakeTokenSet ? '•••••••• (stored — leave blank to keep)' : ''}
                  onChange={e => setQForm({ ...qForm, lakeToken: e.target.value })} />
                <p className="field-hint">Enter the token once — stored like the other keys. Without it, scoring events can't be sent.</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}
                    title="Sends a real test event (datetime, username, version, test:true) — verify it lands in your dataset/S3"
                    onClick={async () => { setLakeTestMsg('Sending test event…'); const r = await sendLakeTestEvent(qForm.lakeUrl, qForm.lakeToken); setLakeTestMsg((r.active ? '✓ ' : '✗ ') + r.message); }}>
                    Send test event
                  </button>
                  {lakeTestMsg && <span style={{ fontSize: 12, color: lakeTestMsg.startsWith('✓') ? '#389e0d' : lakeTestMsg.includes('Sending') ? '#595959' : '#cf1322' }}>{lakeTestMsg}</span>}
                </div>
              </div>
              </>)}


        {saveBar}
      </>);
      else if (t === 'quality') pane = (<>
              <div className="field-group">
                <label className="field-label">Golden thresholds (per stage)</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <span className="field-hint" style={{ display: 'block', marginBottom: 3 }}>Extraction</span>
                    <input className="field-input" type="number" min={1} max={100} value={qForm.expExtractionThreshold ?? 80}
                      onChange={e => setQForm({ ...qForm, expExtractionThreshold: Number(e.target.value) })} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <span className="field-hint" style={{ display: 'block', marginBottom: 3 }}>Mapping</span>
                    <input className="field-input" type="number" min={1} max={100} value={qForm.expMappingThreshold ?? 80}
                      onChange={e => setQForm({ ...qForm, expMappingThreshold: Number(e.target.value) })} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <span className="field-hint" style={{ display: 'block', marginBottom: 3 }}>Output shaping</span>
                    <input className="field-input" type="number" min={1} max={100} value={qForm.expOptimizationThreshold ?? 80}
                      onChange={e => setQForm({ ...qForm, expOptimizationThreshold: Number(e.target.value) })} />
                  </div>
                </div>
                <p className="field-hint">Extraction and mapping store reusable golden sub-parts. Output shaping is regenerated from the destination contract.</p>
              </div>

              <div className="field-group">
                <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={!!qForm.dropEmptyJsonFields} style={{ width: 'auto' }}
                    onChange={e => setQForm({ ...qForm, dropEmptyJsonFields: e.target.checked })} />
                  Drop null and blank fields when parsing JSON
                </label>
                <p className="field-hint" style={{ marginTop: 4 }}>
                  New builds give each JSON Parser a filter that leaves out fields whose value is null or empty text
                  (0 and false are kept). Applies to top-level fields only; nested objects are left as they are.
                </p>
              </div>

              {(scoreLogTally.logged > 0 || scoreLogTally.dropped > 0) && (
              <p style={{ margin: '0 0 12px', fontSize: 12 }}>
                <strong>This session: </strong>
                <span style={{ color: '#52c41a' }}>{scoreLogTally.logged} logged</span>
                {scoreLogTally.dropped > 0 && (
                  <span style={{ color: '#cf1322' }}> · {scoreLogTally.dropped} dropped{scoreLogTally.lastReason ? ` — ${scoreLogTally.lastReason}` : ''}</span>
                )}
              </p>
              )}

              <h4 className="tp-sec">Reference</h4>
              <div className="tp-row">
                <button className="btn-secondary" onClick={() => void openScoringDoc()} title="Open the technical reference (onboarding & scoring) in a new tab">
                  Technical reference
                </button>
                <span className="field-hint">Onboarding a new source, the golden→Search→AI sequence, every export format, how scoring works, and knowledge-base stats. The User guide is under Documentation in the left rail.</span>
              </div>

        {saveBar}
      </>);
      else if (t === 'goldens') pane = (<>
              <h4 className="tp-sec">Shared golden knowledge</h4>
              <p className="field-hint" style={{ marginTop: 0 }}>
                {getRunMode() === 'iframe'
                  ? 'Golden pipelines sync through the Cribl external proxy when an encrypted KV token is configured. Bundled goldens remain available without one.'
                  : 'Sync verified golden pipelines with collaborators via a private GitHub repo. Import (read-only): fine-grained PAT with Contents:Read. Publish: Contents:Read+Write.'
                }
              </p>

              {getRunMode() === 'iframe' && (
                <p className="field-hint" style={{ marginTop: 0 }}>
                  The token is saved only in encrypted Cribl KV and injected by the proxy; it is never added to the client bundle.
                </p>
              )}

              <div className="field-group">
                <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={qForm.shareGoldens} style={{ width: 'auto' }}
                    onChange={e => setQForm({ ...qForm, shareGoldens: e.target.checked })} />
                  Publish my golden pipelines (score &gt; 80, first-writer-wins)
                </label>
              </div>

              {(getRunMode() === 'standalone' || qForm.shareGoldens) && (
              <>
              <div className="field-group">
                <label className="field-label">GitHub repo (owner/repo)</label>
                <input className="field-input" type="text" value={qForm.goldenRepo}
                  onChange={e => setQForm({ ...qForm, goldenRepo: e.target.value })} placeholder="wvdlinde-cribl/cribl-pack-goldens" />
              </div>

              <div className="field-group">
                <label className="field-label">GitHub token — only for publishing</label>
                <input className="field-input" type="password" autoComplete="off" value={qForm.goldenToken}
                  placeholder={qForm.goldenTokenSet ? '•••••••• (stored — leave blank to keep)' : ''}
                  disabled={getRunMode() === 'iframe'}
                  onChange={e => setQForm({ ...qForm, goldenToken: e.target.value })} />
                <p className="field-hint">{getRunMode() === 'iframe'
                  ? 'Reading the shared goldens needs no credential — the pool is public. Publishing runs outside the Cribl UI only, so there is nothing to enter here.'
                  : 'Reading the shared goldens needs no credential — the pool is public. A token is only needed to publish: fine-grained PAT with Contents:Read and Write, saved server-side as GOLDEN_READ_TOKEN.'}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={async () => { setGhTestMsg('Testing…'); const r = await testGoldenAccess(qForm.goldenRepo, qForm.goldenBranch, qForm.goldenToken); setGhTestMsg((r.ok ? '✓ ' : '✗ ') + r.message); }}>
                    Test GitHub access
                  </button>
                  {ghTestMsg && <span style={{ fontSize: 12, color: ghTestMsg.startsWith('✓') ? '#389e0d' : ghTestMsg === 'Testing…' ? '#595959' : '#cf1322' }}>{ghTestMsg}</span>}
                </div>
                {/* GitHub allows 5,000 requests/hour and counts them PER USER — every token
                    that user owns draws on the same pool. Worth stating here, because the
                    number is not per-app and this screen is where the token is entered. */}
                <p className="field-hint" style={{ marginTop: 8 }}>
                  GitHub allows <b>5,000 requests/hour per user account</b>, shared by every token you own. Golden sync is built to sit far inside that:
                  startup reads the pool manifest <b>once</b> (usually free — unchanged content costs no quota), and an import of the whole pool is
                  ~7 batched requests instead of one per golden. If the budget is nearly gone, the Test button above says so and sync fails with the
                  reset time rather than retrying.
                </p>
              </div>
              </>
              )}

        {saveBar}
        <h4 className="tp-sec">Sync with the shared pool</h4>
        <p className="step-desc">Verified golden pipelines shared by collaborators. Importing writes them into your local knowledge store (kept only if better than what you have).</p>
              {availableGoldens.length === 0 && pushableGoldens.length === 0 && <p className="dt-empty">✓ In sync — nothing to import or publish.</p>}
              {availableGoldens.length > 0 && <p className="field-label" style={{ marginBottom: 6 }}>⬇ Available to import ({availableGoldens.length})</p>}
              {availableGoldens.map(g => (
                <div key={g.key} className="dt-section" style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code className="dt-chip dt-new">{g.key}</code>
                    {g.part && (
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#722ed1', background: '#f9f0ff', border: '1px solid #d3adf7', borderRadius: 4, padding: '1px 6px' }} title="Experimental 3-stage sub-part golden">
                        {g.part} · exp
                      </span>
                    )}
                    <span style={{ fontSize: 12, fontWeight: 600, color: g.status === 'upgrade' ? '#d46b08' : '#389e0d' }}>
                      {g.status === 'upgrade' ? `upgrade: local ${g.localScore} → ${g.score}` : `new · score ${g.score}`}
                    </span>
                    <span style={{ fontSize: 11, color: '#8c8c8c', marginLeft: 'auto' }}>{g.author}{g.updated_at ? ` · ${g.updated_at.slice(0, 10)}` : ''}</span>
                  </div>
                </div>
              ))}
              {pushableGoldens.length > 0 && (
                <p className="field-label" style={{ margin: '14px 0 6px' }}>⬆ Ready to publish ({pushableGoldens.length})</p>
              )}
              {pushableGoldens.map(g => (
                <div key={g.key} className="dt-section" style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code className="dt-chip dt-new">{g.key}</code>
                    {g.part && (
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#722ed1', background: '#f9f0ff', border: '1px solid #d3adf7', borderRadius: 4, padding: '1px 6px' }} title="Experimental 3-stage sub-part golden">
                        {g.part} · exp
                      </span>
                    )}
                    <span style={{ fontSize: 12, fontWeight: 600, color: g.status === 'upgrade' ? '#d46b08' : '#389e0d' }}>
                      {g.status === 'upgrade' ? `upgrade: shared ${g.remoteScore} → local ${g.score}` : `new · score ${g.score}`}
                    </span>
                  </div>
                </div>
              ))}
              {goldenPushResult && <p className="field-hint" style={{ marginTop: 10, color: '#389e0d' }}>{goldenPushResult}</p>}
        {(availableGoldens.length > 0 || pushableGoldens.length > 0) && (
          <div className="tp-actions">
                {pushableGoldens.length > 0 && (
                  <button className="btn-secondary" disabled={goldenPushing} onClick={async () => {
                    setGoldenPushing(true);
                    setGoldenPushResult('');
                    try {
                      const r = await pushGoldens(pushableGoldens.map(g => g.key));
                      if (r.error) { setGoldenPushResult(`⚠ ${r.error}`); }
                      else {
                        // Surface WHY rows were skipped — a bare count hid a 403
                        // ("Resource not accessible by personal access token", the
                        // fine-grained-PAT-missing-Contents:write case) behind
                        // "skipped 2" with no way to tell it from a benign skip.
                        const reasons = [...new Set((r.skipped || []).map(s => s.reason).filter(Boolean))];
                        const skipDetail = r.skipped.length && reasons.length ? ` (${reasons.join('; ')})` : '';
                        setGoldenPushResult(`Published ${r.pushed.length} new, upgraded ${r.upgraded.length}, skipped ${r.skipped.length}${skipDetail}.`);
                        await refreshAvailableGoldens();
                      }
                    } finally { setGoldenPushing(false); }
                  }}>{goldenPushing ? 'Publishing…' : `Publish ${pushableGoldens.length} local`}</button>
                )}
                {availableGoldens.length > 0 && (
                  <button className="btn-primary" disabled={goldenImporting} onClick={() => void importAllGoldens()}>{goldenImporting ? 'Importing…' : `Import all (${availableGoldens.length})`}</button>
                )}
                {goldenImportMsg && <div className={`ai-banner ${goldenImportMsg.tone === 'ok' ? 'ai-banner-ok' : 'ai-banner-error'} pg-golden-import-msg`} role={goldenImportMsg.tone === 'ok' ? 'status' : 'alert'}><span>{goldenImportMsg.text}</span><button onClick={() => setGoldenImportMsg(null)} aria-label="Dismiss">✕</button></div>}
          </div>
        )}
      </>);
    } else {
      const t: SamplesTab = toolPage.tab;
      if (t === 'sharing') pane = (<>
              <div className="field-group">
                <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={qForm.requireSanitisedSamples} style={{ width: 'auto' }}
                    onChange={e => setQForm({ ...qForm, requireSanitisedSamples: e.target.checked })} />
                  Require sanitised samples before any AI call
                </label>
                <p className="field-hint" style={{ marginTop: 4 }}>
                  Uploaded, worker-group, pasted and captured events are real data from your estate.
                  With this on, the AI steps refuse to run until you have replaced hostnames, usernames
                  and IP addresses using Sanitize (here, or “Sanitize sample” on the source step) — which happens entirely
                  in your browser. Reference and AI-generated samples are unaffected.
                </p>
              </div>

              {getRunMode() === 'standalone' && (
                <div className="field-group" >
                  <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={qForm.shareSanitisedSamples} style={{ width: 'auto' }}
                      onChange={e => setQForm({ ...qForm, shareSanitisedSamples: e.target.checked })} />
                    Publish sanitised samples to a separate shared pool
                  </label>
                  <p className="field-hint">This repository must be separate from the goldens-only pool.</p>
                  <span className="field-hint">Sample repo (owner/repo)</span>
                  <input className="field-input" value={qForm.sanitisedSampleRepo}
                    onChange={e => setQForm({ ...qForm, sanitisedSampleRepo: e.target.value })}
                    placeholder="owner/cribl-pack-sanitised-samples" />
                  <span className="field-hint" style={{ display: 'block', marginTop: 8 }}>Branch</span>
                  <input className="field-input" value={qForm.sanitisedSampleBranch}
                    onChange={e => setQForm({ ...qForm, sanitisedSampleBranch: e.target.value })}
                    placeholder="shared-sanitised-samples" />
                  <span className="field-hint" style={{ display: 'block', marginTop: 8 }}>Dedicated sample-repo token</span>
                  <input className="field-input" type="password" autoComplete="off" value={qForm.sanitisedSampleToken}
                    placeholder={qForm.sanitisedSampleTokenSet ? '•••••••• (stored — leave blank to keep)' : ''}
                    onChange={e => setQForm({ ...qForm, sanitisedSampleToken: e.target.value })} />
                  <p className="field-hint">Saved server-side as <code>SANITISED_SAMPLE_TOKEN</code>; never shared with the golden publisher.</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button className="btn-secondary" disabled={!qForm.sanitisedSampleTokenSet}
                      onClick={async () => {
                        setSampleGhTestMsg('Testing saved token…');
                        const checked = await testSanitisedSampleAccess(
                          qForm.sanitisedSampleRepo, qForm.sanitisedSampleBranch, qForm.goldenRepo,
                        );
                        setSampleGhTestMsg(`${checked.ok ? '✓' : '✗'} ${checked.message}`);
                      }}>Test saved sample-repo access</button>
                    {sampleGhTestMsg && <span className="field-hint">{sampleGhTestMsg}</span>}
                  </div>
                </div>
              )}

        {saveBar}
      </>);
    }
    return (
      <div className="tp-page">
        <div className="tp-head">
          <div>
            <h2>{area.title}</h2>
            <p>{area.desc}</p>
          </div>
          <button type="button" className="btn-secondary" onClick={closeTool}>← Back to {backTo}</button>
        </div>
        <div className="tp-body">
          <nav className="tp-tabs" aria-label={`${area.title} sections`}>
            {tabs.map(tb => {
              const dot = tabDot(tb.id);
              const count = tabCount(tb.id);
              return (
                <button key={tb.id} type="button" className={`tp-tab${toolPage.tab === tb.id ? ' on' : ''}`}
                  aria-current={toolPage.tab === tb.id ? 'page' : undefined}
                  onClick={() => openTool({ area: toolPage.area, tab: tb.id } as ToolPage)}>
                  <span className="tp-ti" aria-hidden="true">{tb.icon}</span>
                  <span className="tp-tl"><b>{tb.label}</b><small>{tb.desc}</small></span>
                  {count != null && <span className="tp-count">{count}</span>}
                  {dot && <span className={`tp-dot ${dot}`} title={dot === 'ok' ? 'Working' : dot === 'error' ? 'Needs attention' : 'Checking…'} />}
                </button>
              );
            })}
          </nav>
          <section className="tp-pane">
            <h3 className="tp-pane-h">{tabs.find(tb => tb.id === toolPage.tab)?.label}</h3>
            {/* One Sample Library for its three tabs, so switching between them keeps its loaded state. */}
            {sampleView ? (
              <SampleLibraryModal
                open
                embedded
                view={sampleView}
                onClose={closeTool}
                runMode={runMode}
                hasToken={hasSampleToken}
                repo={loadQualitySettings().sanitisedSampleRepo}
                onOpenSettings={() => openToolLink('sample-sharing')}
              />
            ) : pane}
          </section>
        </div>
      </div>
    );
  };

  // Build pack flow's Build screen (it has no Review step, so the plan is shown
  // here and fills in live): header, goat progress, per-pack cards, deploy, log.
  const renderFlowBuildScreen = () => {
    const chk = flowPackCheck(state.packName, existingPacks, flowOverwrite);
    const group = selectedGroup || state.workerGroup;
    const n = flowBuildCounts(expLive, expPpLive);
    const failed = !!expError;
    const stateWord: Record<string, string> = { queued: 'Queued', running: 'Building', done: 'Done', skipped: 'Skipped', error: 'Failed' };
    const stageWord: Record<string, string> = { extraction: 'Extract', mapping: 'Map', optimization: 'Shape' };
    const deployState = expPhase === 'done' ? 'done' : expPhase === 'deploy' ? (failed ? 'error' : 'running') : 'queued';
    return (
      <div className={`fb-screen${failed ? ' fb-failed' : ''}`}>
        <div className="fb-head">
          <div className="fb-head-main">
            <div className="fb-eyebrow">{failed ? 'Build stopped' : expPhase === 'done' ? 'Built' : 'Building'} · Build pack flow</div>
            <h2>{state.packName.trim() || chk.id}</h2>
            <div className="fb-id">
              <code>{expPackId || chk.id}</code>
              <span className={`fb-tag${chk.existing ? ' over' : ''}`}>{chk.existing ? `overwrites${chk.existing.version ? ` v${chk.existing.version}` : ''}` : 'new pack'}</span>
              <span className="fb-chip-meta">group <code>{group}</code></span>
              <span className="fb-chip-meta">route filter <code>{FLOW_ROUTE_FILTER}</code></span>
            </div>
          </div>
          <div className="fb-stats">
            <div><b><Elapsed since={expStartedAt} stop={failed || expPhase === 'done'} /></b><span>elapsed</span></div>
            <div><b>{n.pipelinesDone}/{n.pipelines}</b><span>pipelines</span></div>
            {n.pps > 0 && <div><b>{n.ppDone}/{n.pps}</b><span>post-processing</span></div>}
          </div>
        </div>

        <FlowBuildLive formats={expLive} pps={expPpLive} phase={expPhase} lastLog={expLog[expLog.length - 1] || ''} logCount={expLog.length} error={expError} />

        <div className={`fb-plan${expPpLive.length ? ' two' : ''}`}>
          <section className="fb-col">
            <h3>Main pack <small>{expLive.length} pipeline{expLive.length === 1 ? '' : 's'}</small></h3>
            {expLive.map(l => (
              <div key={l.pipelineId} className={`fb-card fb-${l.state}`}>
                <div className="fb-card-h">
                  <span className="fb-dot" aria-hidden="true" />
                  <b>{l.label}</b>
                  <code>{l.pipelineId}</code>
                  <span className="fb-state">{stateWord[l.state]}</span>
                </div>
                <div className="fb-stages">
                  {l.stages.map(st => (
                    <span key={st.stage} className={`fb-stage fb-${st.status}`} title={st.message || st.stage}>
                      <i aria-hidden="true" />{stageWord[st.stage] ?? st.stage}
                      {st.status === 'done' && <em>{st.score === null ? 'n/a' : st.score}</em>}
                      {st.status === 'skipped' && <em>n/a</em>}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </section>
          {expPpLive.length > 0 && (
            <section className="fb-col">
              <h3>Post-processing <small>reads the OCSF output</small></h3>
              {expPpLive.map(p => (
                <div key={p.packId} className={`fb-card fb-${p.state}`}>
                  <div className="fb-card-h">
                    <span className="fb-dot" aria-hidden="true" />
                    <b>{p.label}</b>
                    <code>{p.packId}</code>
                    {existingPacks.some(e => e.id.toLowerCase() === p.packId) && <span className="fb-tag over">overwrites</span>}
                    <span className="fb-state">{stateWord[p.state]}</span>
                  </div>
                  <div className="fb-sub">{p.error ? <span className="fb-err">{p.error}</span> : p.optimize ? 'Optimized by category' : 'Full copy'}</div>
                </div>
              ))}
            </section>
          )}
        </div>

        <div className={`fb-deploy fb-${deployState}`}>
          <span className="fb-dot" aria-hidden="true" />
          <b>Commit &amp; deploy</b>
          <span className="fb-sub">one deploy makes {n.pps ? 'every pack' : 'the pack'} live on <code>{group}</code></span>
          <span className="fb-state">{stateWord[deployState]}</span>
        </div>

        <details className="fb-log" open={failed || undefined}>
          <summary>Build log <small>{expLog.length} line{expLog.length === 1 ? '' : 's'}</small></summary>
          <div className="deploy-log" ref={deployLogRef}>
            {expLog.map((line, i) => <div key={i} className="demo-log-line">{line}</div>)}
          </div>
        </details>
        {failed && <div className="error-box" style={{ marginTop: 12 }}><span>{expError}</span><button onClick={() => setStep('destination')}>Back</button></div>}
      </div>
    );
  };

  const StepNav = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
    <div className="nav" style={style}>
      {step !== 'mode' && (
        <button
          type="button"
          className="session-restart"
          onClick={resetAll}
          title="Restart session and return to the main menu"
        >
          Restart
        </button>
      )}
      <div className="nav-actions">{children}</div>
    </div>
  );

  const formatOptimizeEvent = (e: any) => {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    // Destructured only to OMIT them from `rest` — hence the `_` prefix on the one name
    // that is not already `__`-prefixed, so the unused-vars rule reads it as deliberate.
    const {
      __criblEventType, __ctrlFields, __final, __cloneCount, __id, cribl_pipe: _cribl_pipe, __packId,
      ...rest
    } = e;
    return JSON.stringify(rest, null, 2);
  };

  // After a successful parse, the original _raw (and the intermediate CSV payload
  // field the serde read) are redundant — every value already lives as a KV.
  // Keep _raw only when extraction produced nothing useful to show.
  const shapeExtractionForDisplay = (ev: any): any => {
    if (!ev || typeof ev !== 'object') return ev;
    const out: Record<string, any> = {};
    let namedCount = 0;
    for (const [k, v] of Object.entries(ev)) {
      if (k === '_raw' || k.startsWith('__') || k.startsWith('cribl')) continue;
      if (/csv_payload$/i.test(k) || /__payload$/i.test(k)) continue;
      out[k] = v;
      if (k !== '_time' && v != null && v !== '') namedCount++;
    }
    if (namedCount === 0 && typeof ev._raw === 'string') return { _raw: ev._raw };
    return out;
  };

  // ---- Unified scoring report (build 687) -----------------------------------
  // Transform the experiment's per-stage results (ExpStageResult[]) into the
  // pure-presentation view model the <ScoringReport> component renders. All
  // shaping (event display, dropped/added-field diff, format-conformance badge)
  // lives here so ScoringReport.tsx needs no pack-builder imports.
  const EXPR_STOPWORDS = new Set(['null', 'true', 'false', 'undefined', 'Number', 'String', 'Boolean', 'Date', 'Math', 'JSON', 'parseInt', 'parseFloat', 'parse', 'toString', 'now', 'length']);

  // Deterministic output-format conformance for the Output-event ✓/⚠ badge.
  // null = no conformance check applies to this format (no badge shown).
  const evaluateFormatConformance = (format: string, ev: any): { valid: boolean | null; note: string } => {
    const base = (format || '').split('#')[0].toLowerCase();
    // CEF / ArcSight / CommonSecurityLog → wire-format header on _raw.
    if (isCefFormat(format) || base === 'commonsecuritylog') {
      const raw = typeof ev === 'string' ? ev : (ev && typeof ev._raw === 'string' ? ev._raw : '');
      if (!raw) return { valid: false, note: 'No CEF _raw string produced.' };
      const ok = /^CEF:\d\|/.test(raw);
      return { valid: ok, note: ok ? 'Valid CEF header (CEF:0|…, pipe-delimited).' : 'Output does not start with a CEF:0|… header.' };
    }
    // OCSF → required class_uid/category_uid + time.
    if (isOcsfFormat(format)) {
      if (!ev || typeof ev !== 'object') return { valid: false, note: 'OCSF output is not a JSON object.' };
      const hasClass = ev.class_uid != null || ev.category_uid != null;
      const hasTime = ev.time != null;
      if (hasClass && hasTime) return { valid: true, note: 'OCSF class_uid/category_uid and time present.' };
      const miss = [!hasClass && 'class_uid/category_uid', !hasTime && 'time'].filter(Boolean).join(', ');
      return { valid: false, note: `Missing required OCSF field(s): ${miss}.` };
    }
    // CIM / ASIM / ECS / Chronicle / JSON → deterministic schema-conformance audit.
    if (isSchemaConformanceFormat(format)) {
      const audit = auditSchemaConformance(format, ev == null ? [] : [ev]);
      if (!audit.applicable) return { valid: null, note: '' };
      const ok = audit.score >= 85;
      return { valid: ok, note: audit.reasons?.[0] || (ok ? 'Output conforms to the destination schema shape.' : 'Output does not fully conform to the destination schema.') };
    }
    return { valid: null, note: '' };
  };

  const buildReportFormatVM = (
    stages: ExpStageResult[],
    format: string,
    pipelineId: string,
    profileArgs?: ReportFormatVM['profileArgs'],
    // A batch renders many rows, each with its OWN sourcetype — pass it here so
    // the output-event shaping uses the row's source, not the single-pack UI's
    // `effectiveSourcetype`. Omitted (single-pack path) it falls back to that.
    sourcetypeOverride?: string,
  ): ReportFormatVM => {
    const ext = stages.find(s => s.stage === 'extraction');
    const map = stages.find(s => s.stage === 'mapping');
    const opt = stages.find(s => s.stage === 'optimization');
    const formatLabel = format.toUpperCase();

    const rawLine = ext?.debug?.sampleRaw || '';
    const extractedFields = Object.entries(ext?.debug?.extractedFields || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([name, v]) => ({ name, value: typeof v === 'string' ? v : JSON.stringify(v) }));
    const extractedNames = extractedFields.map(f => f.name);

    // Golden/schematizer mappings carry an empty `from` — recover the real source
    // field from the coalescing expr (same logic as the Event Journey modal).
    const resolveFrom = (m: { from: string; to: string; expr: string }): string => {
      if (m.from) return m.from;
      const idents = (m.expr || '').match(/[A-Za-z_$][\w$]*/g) || [];
      const cands = idents.filter(t => !EXPR_STOPWORDS.has(t));
      return cands.find(c => extractedNames.includes(c)) || cands[0] || '';
    };
    const mappings = (map?.debug?.mappings || []).map(m => ({ from: resolveFrom(m), to: m.to, expr: m.expr }));
    const mappedFrom = new Set(mappings.map(m => m.from).filter(Boolean));
    const unmappedRideAlong = map?.debug?.unmappedFields || [];
    const rideAlong = new Set(unmappedRideAlong);
    // Extracted-but-not-mapped-and-not-ride-along = dropped.
    const droppedFields = extractedNames.filter(n => !mappedFrom.has(n) && !rideAlong.has(n));

    // Final output event (last stage that produced one), shaped for display.
    const sentinelCols = resolveSentinelTable(format)?.table.columns.map(c => c.name) || null;
    const rawOut = opt?.debug?.outputEvent ?? map?.debug?.outputEvent ?? ext?.debug?.outputEvent;
    let outObj: any = rawOut;
    if (rawOut && typeof rawOut === 'object') {
      if (sentinelCols) {
        const cols = new Set(sentinelCols);
        const o: Record<string, any> = {};
        if (rawOut._time !== undefined) o._time = rawOut._time;
        for (const col of sentinelCols) if (rawOut[col] !== undefined) o[col] = rawOut[col];
        if (Object.keys(o).length <= 1 && typeof rawOut._raw === 'string') {
          try {
            const parsed = JSON.parse(rawOut._raw);
            if (parsed && typeof parsed === 'object') { for (const [k, v] of Object.entries(parsed)) if (cols.has(k) || k === '_time' || k === 'TimeGenerated') o[k] = v; }
          } catch { /* */ }
        }
        outObj = Object.keys(o).length > 1 ? o : (typeof rawOut._raw === 'string' ? rawOut._raw : rawOut);
      } else {
        outObj = shapeMappedEventForDisplay(format, rawOut, sourcetypeOverride || effectiveSourcetype || undefined, typeof rawLine === 'string' ? rawLine : undefined);
      }
    }
    const outputEvent = typeof outObj === 'string' ? outObj : JSON.stringify(outObj ?? {}, null, 2);

    // Added / enrichment fields = top-level output keys not sourced from an
    // extracted field (best-effort; skips internal + _raw).
    const addedFields: string[] = [];
    if (outObj && typeof outObj === 'object') {
      const mappedTargets = new Set(mappings.map(m => (m.to || '').split(/[.[]/)[0]));
      for (const k of Object.keys(outObj)) {
        if (k === '_raw' || k === '_time' || k.startsWith('__') || k.startsWith('cribl')) continue;
        if (mappedTargets.has(k) || extractedNames.includes(k)) continue;
        const v = (outObj as any)[k];
        addedFields.push(v == null || typeof v === 'object' ? k : `${k} = ${typeof v === 'string' ? v.slice(0, 24) : v}`);
      }
    }

    const conf = evaluateFormatConformance(format, outObj);

    // Sample stats from per-stage measured stats.
    const finalStats = opt?.debug?.stats || map?.debug?.stats || ext?.debug?.stats;
    const sampleStats = (ext?.debug?.stats || finalStats) ? {
      bytesIn: ext?.debug?.stats?.bytesIn,
      bytesOut: finalStats?.bytesOut,
      rawIn: ext?.debug?.stats?.rawBytesIn,
      rawOut: finalStats?.rawBytesOut,
      measured: ext?.debug?.stats?.events,
    } : undefined;

    // Per-stage measurements — the fallback statistics table when no live
    // pipeline profile is fetched (every batch-run page). Each stage's persisted
    // `stats` carries the same numbers Cribl's profile would.
    const stageStat = (label: string, s?: ExpStageResult) => {
      const st = s?.debug?.stats;
      if (!st) return null;
      return { label, durationMs: st.durationMs, events: st.events, bytesIn: st.bytesIn, bytesOut: st.bytesOut };
    };
    const stageStats = [
      stageStat('Extraction', ext),
      stageStat('Mapping', map),
      stageStat('Optimization', opt),
    ].filter((s): s is NonNullable<typeof s> => s != null);

    const stageScore = (s?: ExpStageResult): { v: number | null; src: ReportStageSource } =>
      ({ v: s?.score ?? null, src: (s?.source ?? 'none') as ReportStageSource });
    const present = [ext?.score, map?.score, opt?.score].filter((n): n is number => typeof n === 'number');
    const average = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
    const band: ReportFormatVM['band'] = average == null ? 'na' : average >= 85 ? 'good' : average >= 60 ? 'warn' : 'fail';

    return {
      format, formatLabel, pipelineId, band, average,
      scores: { extraction: stageScore(ext), mapping: stageScore(map), optimization: stageScore(opt) },
      extractionReason: ext?.reasons?.[0],
      mappingReason: map?.reasons?.[0],
      rawLine: typeof rawLine === 'string' ? rawLine : String(rawLine ?? ''),
      extractedFields, mappings, droppedFields, addedFields, unmappedRideAlong,
      outputEvent, formatValid: conf.valid, formatNote: conf.note,
      appliedOptimizations: opt?.debug?.appliedOptimizations || [],
      sampleStats, stageStats: stageStats.length ? stageStats : undefined, profileArgs,
    };
  };

  const optimizeDestCtx = (() => {
    const inferred = optimizePipelineId ? inferFromPipelineId(optimizePipelineId) : null;
    const family = state.destFormats[0] || '';
    const fromUi = family ? resolveDestFmt(family, state) : '';
    return {
      destFormat: fromUi || inferred?.destFormat || state.destFormat || 'cim',
      sourcetype: canonicalizeSourcetype(effectiveSourcetype.trim() || inferred?.sourcetype || ''),
    };
  })();

  // "⬇ Download report" on Improvement Complete: the same panels as
  // renderOptimizeScoreReport below, shaped the same way, as a standalone page.
  const downloadImproveReport = () => {
    if (!optimizeScores) return;
    const fmt = formatOptimizeEvent;
    const stageLabel: Record<string, string> = { sample: 'Sample', extraction: 'Extraction', mapping: 'Mapping', optimization: 'Output shaping' };
    const sampleRaw = typeof optimizeScores.sampleRaw === 'string' ? optimizeScores.sampleRaw : undefined;
    const toRow = (
      label: string,
      stages: NonNullable<typeof optimizeScores.beforeStages> | undefined,
      overall: number | null | undefined,
      detail?: { totalValues: number; coveredValues: number },
    ): ImproveReportRow => {
      const extBody = shapeExtractionForDisplay(stages?.extraction?.output);
      const mapBody = stages?.mapping?.output != null
        ? shapeMappedEventForDisplay(optimizeDestCtx.destFormat, stages.mapping.output, optimizeDestCtx.sourcetype, sampleRaw)
        : null;
      return {
        label, overall: overall ?? null,
        extraction: { score: stages?.extraction?.score ?? null, reason: stages?.extraction?.reason, body: extBody != null ? fmt(extBody) : null },
        mapping: { score: stages?.mapping?.score ?? null, reason: stages?.mapping?.reason, body: mapBody != null ? fmt(mapBody) : null },
        coverage: detail ? { coveredValues: detail.coveredValues, totalValues: detail.totalValues } : undefined,
      };
    };
    const rows = [toRow('Current', optimizeScores.beforeStages, optimizeScores.before, optimizeScores.beforeDetail)];
    if (optimizeScores.after != null) {
      rows.push(toRow('After improvements', optimizeScores.afterStages || optimizeScores.beforeStages, optimizeScores.after, optimizeScores.afterDetail));
    }
    const gaps = optimizeScores.beforeDetail?.gaps;
    const html = buildImproveReportHtml({
      packId: selectedPackId || undefined, pipelineId: optimizePipelineId || undefined, workerGroup: selectedGroup || undefined,
      destFormat: optimizeDestCtx.destFormat, sourcetype: optimizeDestCtx.sourcetype || undefined,
      changed: !!optimizeScores.changed,
      sample: optimizeScores.sampleRaw != null ? fmt(optimizeScores.sampleRaw) : null,
      rows,
      tried: optimizeResults.map(r => ({ stage: stageLabel[r.stage] || r.stage, kept: r.kept, score: r.score, summary: r.guidanceNote ? `${r.summary || ''} ${r.guidanceNote}`.trim() : r.summary })),
      gaps: gaps ? { notMapped: gaps.notMapped, notExtracted: gaps.notExtracted, droppedFieldCount: gaps.droppedFields.length } : undefined,
    });
    downloadHtmlFile(html, improveReportFilename(optimizePipelineId));
  };

  const renderOptimizeScoreReport = () => {
    if (!optimizeScores) return null;
    const fmt = formatOptimizeEvent;
    const stageLabel: Record<string, string> = {
      sample: 'Sample',
      extraction: 'Extraction',
      mapping: 'Mapping',
      optimization: 'Output shaping',
    };
    const bandOf = (n: number | null | undefined) =>
      n == null ? 'na' : n >= 85 ? 'good' : n >= 60 ? 'warn' : 'fail';

    const renderIoRow = (
      when: 'Current' | 'After improvements',
      stages: NonNullable<typeof optimizeScores.beforeStages> | undefined,
      overall: number | null | undefined,
      detail?: { totalValues: number; coveredValues: number },
    ) => {
      const ext = stages?.extraction;
      const map = stages?.mapping;
      const sampleBody = optimizeScores.sampleRaw;
      const extBody = shapeExtractionForDisplay(ext?.output);
      const mapBody = map?.output != null
        ? shapeMappedEventForDisplay(
          optimizeDestCtx.destFormat,
          map.output,
          optimizeDestCtx.sourcetype,
          typeof optimizeScores.sampleRaw === 'string' ? optimizeScores.sampleRaw : undefined,
        )
        : null;
      return (
        <div className="optimize-report-panel">
          <div className="optimize-report-head">
            <strong>{when}</strong>
            {overall != null && (
              <span className={`exp-score score-${bandOf(overall)}`} title="Average of extraction + mapping stage scores">
                {overall}<small>/100</small>
              </span>
            )}
          </div>
          {stages && (
            <div className="optimize-report-meta">
              Total = average of extraction ({stages.extraction.score ?? 'n/a'}) and mapping ({stages.mapping.score ?? 'n/a'})
            </div>
          )}
          {detail && (
            <div className="optimize-report-meta optimize-report-meta-dim">
              Diagnostic only — sample→final coverage: {detail.coveredValues}/{detail.totalValues} (not the total above)
            </div>
          )}
          <div className="optimize-io-row">
            <div className="optimize-io-card">
              <div className="optimize-io-card-head">
                <span className="optimize-io-title">1. Sample (original)</span>
              </div>
              <p className="score-why">Raw event from the sample file — input to the pipeline.</p>
              {sampleBody != null ? (
                <pre
                  className="exp-dbg-pre exp-dbg-clickable"
                  title="Click to view full event"
                  onClick={() => setEventModal({ title: `${when} — Sample`, body: fmt(sampleBody) })}
                >{fmt(sampleBody)}</pre>
              ) : (
                <div className="optimize-io-empty">No sample loaded</div>
              )}
            </div>

            <div className={`optimize-io-card band-${bandOf(ext?.score)}`}>
              <div className="optimize-io-card-head">
                <span className="optimize-io-title">2. After extraction</span>
                <span className={`exp-score score-${bandOf(ext?.score)}`}>
                  {ext?.score == null ? 'N/A' : ext.score}<small>{ext?.score == null ? '' : '/100'}</small>
                </span>
              </div>
              {ext?.reason && <p className="score-why">{ext.reason}</p>}
              {extBody != null ? (
                <pre
                  className="exp-dbg-pre exp-dbg-clickable"
                  title="Click to view full event"
                  onClick={() => setEventModal({ title: `${when} — After extraction`, body: fmt(extBody) })}
                >{fmt(extBody)}</pre>
              ) : (
                <div className="optimize-io-empty">Extraction output not available yet</div>
              )}
            </div>

            <div className={`optimize-io-card band-${bandOf(map?.score)}`}>
              <div className="optimize-io-card-head">
                <span className="optimize-io-title">3. After mapping</span>
                <span className={`exp-score score-${bandOf(map?.score)}`}>
                  {map?.score == null ? 'N/A' : map.score}<small>{map?.score == null ? '' : '/100'}</small>
                </span>
              </div>
              {map?.reason && <p className="score-why">{map.reason}</p>}
              {!map?.reason && (
                <p className="score-why">Destination-schema fields only — vendor leftovers from extraction are hidden here.</p>
              )}
              {mapBody != null ? (
                <pre
                  className="exp-dbg-pre exp-dbg-clickable"
                  title="Click to view full event"
                  onClick={() => setEventModal({ title: `${when} — After mapping`, body: fmt(mapBody) })}
                >{fmt(mapBody)}</pre>
              ) : (
                <div className="optimize-io-empty">Mapping output not available yet</div>
              )}
            </div>
          </div>
        </div>
      );
    };

    return (
      <div className="optimize-report">
        {renderIoRow(
          'Current',
          optimizeScores.beforeStages,
          optimizeScores.before,
          optimizeScores.beforeDetail,
        )}

        {optimizeScores.after != null && renderIoRow(
          'After improvements',
          optimizeScores.afterStages || optimizeScores.beforeStages,
          optimizeScores.after,
          optimizeScores.afterDetail,
        )}

        {optimizeResults.length > 0 && (
          <div className="optimize-changes">
            <div className="optimize-report-head"><strong>What was tried</strong></div>
            <ul className="optimize-change-list">
              {optimizeResults.map(result => (
                <li key={result.stage} className={result.kept === 'new' ? 'kept-new' : 'kept-baseline'}>
                  <span className="optimize-change-stage">{stageLabel[result.stage] || result.stage}</span>
                  <span className="optimize-change-kept">{result.kept === 'new' ? 'Improved' : 'Baseline kept'}</span>
                  {result.score != null && <span className="optimize-change-score">{result.score}/100</span>}
                  {result.summary && <span className="optimize-change-summary">{result.summary}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {optimizeScores.beforeDetail?.gaps && (optimizeScores.beforeDetail.gaps.notMapped.length > 0 || optimizeScores.beforeDetail.gaps.notExtracted.length > 0) && (
          <div className="optimize-coverage-note">
            <p>
              Gaps below explain the overall score: values extracted but dropped by the destination keep-list,
              versus values that never became named fields.
            </p>
            <div className="optimize-gap-lists">
              {optimizeScores.beforeDetail.gaps.notMapped.length > 0 && (
                <div className="optimize-gap-block">
                  <div className="optimize-gap-title">Extracted but not kept in the destination ({optimizeScores.beforeDetail.gaps.droppedFields.length || optimizeScores.beforeDetail.gaps.notMapped.length} fields)</div>
                  <ul className="optimize-gap-ul">
                    {optimizeScores.beforeDetail.gaps.notMapped.slice(0, 25).map((g, i) => (
                      <li key={`nm-${i}`}><code className="optimize-gap-field">{g.field}</code> = <code className="optimize-gap-value">{g.value}</code></li>
                    ))}
                  </ul>
                </div>
              )}
              {optimizeScores.beforeDetail.gaps.notExtracted.length > 0 && (
                <div className="optimize-gap-block">
                  <div className="optimize-gap-title">Never extracted from the sample ({optimizeScores.beforeDetail.gaps.notExtracted.length} values)</div>
                  <ul className="optimize-gap-ul">
                    {optimizeScores.beforeDetail.gaps.notExtracted.slice(0, 15).map((g, i) => (
                      <li key={`ne-${i}`}><code className="optimize-gap-value">{g.value}</code></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderStep = () => {
    switch (step) {
      case 'mode':
        return (
          <div className="step">
            <header className="pg-hero" aria-label="Cribl Pack Generator">
              <div className="pg-hero-main">
                <img src={goatImg} alt="Cribl Goat" className="pg-hero-goat" />
                <div>
                  <span className="bx-pill teal">✦ AI-powered</span>
                  <h1 className="pg-hero-title">Cribl Pack Generator</h1>
                  <p className="pg-hero-sub">Build, configure and deploy Stream packs in minutes, guided by AI at every step.</p>
                </div>
              </div>
              <aside className="pg-hero-control" aria-label="AI drafts, you decide">
                <h4>AI drafts, you decide · before production</h4>
                <ul>
                  <li><i aria-hidden="true">✓</i>Inspect the pipeline steps</li>
                  <li><i aria-hidden="true">✓</i>Verify the field mappings</li>
                  <li><i aria-hidden="true">✓</i>Test with real data</li>
                </ul>
              </aside>
            </header>

            <h2>What would you like to do?</h2>
            <p className="step-desc">Pick a mode to start. You can switch mode any time from the left rail.</p>
            {goldenUpdateNotice(availableGoldens) && (
              <div className="ai-banner ai-banner-ok pg-golden-notice" role="status">
                <span>⬇ <b>Newer goldens to import.</b> {goldenUpdateNotice(availableGoldens)} Import them so every build starts from the best tested pipeline.</span>
                <button className="banner-primary" disabled={goldenImporting} onClick={() => void importAllGoldens()}>
                  {goldenImporting ? 'Importing…' : `Import all (${availableGoldens.length})`}
                </button>
                <button onClick={() => openTool({ area: 'settings', tab: 'goldens' })}>Review</button>
              </div>
            )}
            {goldenImportMsg && <div className={`ai-banner ${goldenImportMsg.tone === 'ok' ? 'ai-banner-ok' : 'ai-banner-error'} pg-golden-import-msg`} role={goldenImportMsg.tone === 'ok' ? 'status' : 'alert'}><span>{goldenImportMsg.text}</span><button onClick={() => setGoldenImportMsg(null)} aria-label="Dismiss">✕</button></div>}
            <div className="mode-grid pg-mode-grid">
              {MENU_MODES.map(m => (
                <button key={m.id} type="button" className="mode-card pg-mode-card" onClick={() => startMode(m.id)}>
                  <span className="ic" aria-hidden="true">{m.icon}</span>
                  <strong>{m.title}{m.badge && <span className="pg-badge">{m.badge}</span>}</strong>
                  <span>{m.desc}</span>
                  <span className="go">Start →</span>
                </button>
              ))}
              {backgroundBatchSupported() && (
                <button type="button" className="mode-card pg-mode-card" onClick={() => startMode('batch', { background: true })}>
                  <span className="ic" aria-hidden="true">☁</span>
                  <strong>Batch create — Background</strong>
                  <span>Same as Batch create, but runs server-side — you can close this tab. Up to {BATCH_BACKGROUND_MAX_ROWS} pipelines. Samples are resolved here before it starts; a source with no sample is skipped with a note to use regular Batch.</span>
                  <span className="go">Start →</span>
                </button>
              )}
            </div>
          </div>
        );

      case 'select-group': {
        const selectedGroupBlock = selectedGroup ? groupPickBlock({
          group: selectedGroup, background: packMode === 'batch' && batchBackground,
          criblAi: isCriblAiActive(), health: workerHealthLoaded ? workerHealth : null,
        }) : null;
        return (
          <div className="step">
            <h2>{packMode === 'batch' ? 'Where it runs' : 'Select Worker Group'}</h2>
            <p className="step-desc">{packMode === 'batch' ? 'Choose how the batch runs, then the worker group' : 'Choose the worker group'} where {packMode === 'batch' ? `your ${batchRows.length} pipelines will be deployed` : packMode === 'experiment' || packMode === 'flow' ? 'your new pack will be deployed' : 'the pack lives'}.</p>

            {packMode === 'batch' && (
              <div className="bx" style={{ marginBottom: 18 }}>
                {/* In this tab always runs batchConcurrency rows (1 on Cribl AI) at a
                    time and background always one row per tick — nothing to tune,
                    so there is nothing to ask. */}
                <div className="bx-where pg-run-where" role="radiogroup" aria-label="Run where">
                  <div role="radio" aria-checked={!batchBackground} aria-disabled={!batchRun.foreground.ok || undefined} tabIndex={0}
                    className={`bx-card${!batchBackground ? ' sel' : ''}${batchRun.foreground.ok ? '' : ' off'}`}
                    title={batchRun.foreground.reason}
                    onClick={() => { if (batchRun.foreground.ok) setBatchBackground(false); }}
                    onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && batchRun.foreground.ok) setBatchBackground(false); }}>
                    <div className="bx-ic">⚡</div>
                    <h3>In this tab · {batchConcurrency === 1 ? 'one row' : `${batchConcurrency} rows`} at a time</h3>
                    <p>{batchRun.foreground.ok ? 'The fastest way to run a batch.' : batchRun.foreground.reason}</p>
                    <ul>
                      <li>Keep this tab open while it runs</li>
                      <li>Checkpoints let an interrupted run resume</li>
                      <li>Can ask you for a sample or schema choice mid-run</li>
                    </ul>
                  </div>
                  <div role="radio" aria-checked={batchBackground} aria-disabled={!batchRun.background.ok || undefined} tabIndex={0}
                    className={`bx-card${batchBackground ? ' sel' : ''}${batchRun.background.ok ? '' : ' off'}`}
                    title={batchRun.background.reason}
                    onClick={() => { if (!batchRun.background.ok) return; setBatchBackground(true); void refreshWorkerHealth(); }}
                    onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && batchRun.background.ok) { setBatchBackground(true); void refreshWorkerHealth(); } }}>
                    <div className="bx-ic v">☾</div>
                    <h3>In the background · 1 row at a time</h3>
                    <p>{batchRun.background.ok ? 'Runs server-side on the worker group.' : batchRun.background.reason}</p>
                    <ul>
                      <li>You can close this tab and come back later</li>
                      <li>Up to {BATCH_BACKGROUND_MAX_ROWS} pipelines per file</li>
                      <li>One row per minute on the group's workers</li>
                      <li>Rows without a resolved sample are skipped</li>
                    </ul>
                  </div>
                </div>
                <div className="bx-section-h">Worker group<span className="bx-grow" /></div>
              </div>
            )}

            {workerGroups.length > 0 ? (
              <>
                <input
                  type="text"
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                  placeholder="Search worker groups..."
                  className="tile-search"
                />
                {(['stream', 'edge'] as const).map((type) => {
                  const groups = workerGroups
                    .filter((g) => g.type === type && (g.name || g.id).toLowerCase().includes(groupFilter.toLowerCase()))
                    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
                  if (groups.length === 0) return null;
                  return (
                    <div key={type} className="tile-group">
                      <span className="tile-group-label">{type === 'stream' ? 'Stream' : 'Edge (Fleet)'}</span>
                      <div className="tile-grid">
                        {groups.map((g) => {
                          // A group with no connected worker is unselectable for a
                          // background batch and whenever Cribl AI is in use — but
                          // only once the health fetch has returned, since an
                          // unloaded map has every group absent.
                          const blockWhy = groupPickBlock({
                            group: g.id, background: packMode === 'batch' && batchBackground,
                            criblAi: isCriblAiActive(), health: workerHealthLoaded ? workerHealth : null,
                          });
                          const noWorkers = blockWhy !== null;
                          return (
                          <div
                            key={g.id}
                            className={`tile${selectedGroup === g.id ? ' tile-selected' : ''}${noWorkers ? ' tile-disabled' : ''}`}
                            title={blockWhy ?? undefined}
                            aria-disabled={noWorkers || undefined}
                            onClick={() => {
                              if (noWorkers) return;
                              setSelectedGroup(g.id);
                              update({ workerGroup: g.id });
                              setGroupFilter('');
                              if (packMode === 'batch') {
                                checkBatchConflicts(g.id);
                              } else if (packMode === 'flow') {
                                // Build pack flow has no Name step: the pack is named on
                                // the Flow screen, which warns there if it already exists.
                                void fetchPacks(g.id);
                                setFlowOverwrite(false);
                                setFlowPpOverwrite(false);
                                setStep('source');
                              } else if (packMode === 'experiment' || packMode === 'post-process') {
                                // Load existing packs so the name screen can warn
                                // inline if the entered name already exists.
                                void fetchPacks(g.id);
                                setStep('name');
                              } else {
                                fetchPacks(g.id);
                                setSelectedPackId('');
                                setPackFilter('');
                                setStep('select-pack');
                              }
                            }}
                          >
                            <span className="tile-icon">{type === 'edge' ? '\u{1F4E1}' : '\u{2699}'}</span>
                            <strong className="tile-name">{g.name || g.id}</strong>
                            <span className="tile-meta">
                              <span className={`type-badge type-${type}`}>{type === 'stream' ? 'Stream' : 'Edge (Fleet)'}</span>
                              {noWorkers && <span className="tile-warning">no active workers</span>}
                            </span>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </>
            ) : groupsError ? (
              <div className="error-box">
                <span>Could not load worker groups: {groupsError}</span>
                <button onClick={fetchWorkerGroups}>Retry</button>
              </div>
            ) : (
              <div className="ai-loading">
                <div className="ai-spinner" />
                <span>Loading worker groups...</span>
              </div>
            )}

            {batchConfirmReady && (() => {
              // Recap + a MEASURED estimate: per-path averages of rows this
              // browser built before (src/batch-estimate.ts). With none yet it
              // says so instead of guessing.
              const runRows = preflightSourcetypes.filter(r => batchConflictActions.get(toKebab(batchRows[r.index]?.pack_name || '')) !== 'skip');
              const golden = runRows.filter(r => r.status === 'green').length;
              const ai = runRows.length - golden;
              const est = estimateBatch(loadRowTimings(), { golden, ai }, { concurrency: batchConcurrency, background: batchBackground });
              const packs = new Set(batchRows.map(r => toKebab(r.pack_name))).size;
              const genCount = batchRows.filter(r => !batchSkipPacks.has(toKebab(r.pack_name))).length;
              const repairCount = batchRows.filter(r => batchConflictActions.get(toKebab(r.pack_name)) === 'repair').length;
              const scorecardCount = batchRows.filter(r => batchConflictActions.get(toKebab(r.pack_name)) === 'scorecard').length;
              const parts: string[] = [];
              if (genCount > 0) parts.push(`generate ${genCount}`);
              if (repairCount > 0) parts.push(`repair ${repairCount}`);
              if (scorecardCount > 0) parts.push(`score ${scorecardCount}`);
              const setAction = (packId: string, a: ConflictAction) => {
                setBatchSkipPacks(prev => { const n = new Set(prev); if (a === 'overwrite') n.delete(packId); else n.add(packId); return n; });
                setBatchConflictActions(prev => { const n = new Map(prev); n.set(packId, a); return n; });
              };
              const setAll = (a: ConflictAction) => {
                setBatchSkipPacks(a === 'overwrite' ? new Set() : new Set(batchConflicts));
                setBatchConflictActions(new Map(batchConflicts.map(id => [id, a])));
              };
              const allSame = batchConflicts.length > 0 && batchConflicts.every(id => (batchConflictActions.get(id) || 'overwrite') === (batchConflictActions.get(batchConflicts[0]) || 'overwrite'))
                ? (batchConflictActions.get(batchConflicts[0]) || 'overwrite') : null;
              const cell = (n: number | null) => <span className={scoreTone(n)}>{n ?? '—'}</span>;
              return (
                <div className="bx bx-confirm">
                  <div className="bx-confirm-h">
                    <h3>Ready to start</h3>
                    <span className="bx-muted">
                      <strong>{parts.join(', ')}</strong> pipeline{genCount + repairCount + scorecardCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="bx-recap">
                    <div><span>Packs</span><b>{packs}</b></div>
                    <div><span>Pipelines</span><b>{batchRows.length}</b></div>
                    <div><span>★ Golden · ✦ AI</span><b>{golden} · {ai}</b></div>
                    <div><span>Group</span><b>{selectedGroup}</b></div>
                    <div><span>Runs</span><b>{batchBackground ? 'Background' : 'This tab'}</b><small className="bx-recap-sub">{batchBackground ? 1 : batchConcurrency} at a time</small></div>
                    <div><span>Estimate</span><b>{est.label}</b></div>
                  </div>
                  <p className="bx-recap-note">ⓘ {est.detail}{est.measured ? ' An estimate, not a promise: AI response times vary.' : ''}</p>

                  {batchBackground && (() => {
                    // Rows with no sample get one created as their first
                    // background stage. Name those sources before Start, so the
                    // extra run time is not a surprise in the report.
                    // The manifest builder's own resolution, not a second copy of
                    // it: a screen that disagreed with the builder would promise
                    // a build it then parks (or the reverse).
                    const sum = summarizeBackgroundSamples(batchRows, preflightSampleCache.current, batchConflictActions, batchSkipPacks);
                    if (sum.needed === 0) return null;
                    const pctReady = Math.round((sum.ready / sum.needed) * 100);
                    // Rough by design: a sample stage takes ~2–4 min of AI time, and
                    // the runner works one stage at a time — so this is time added to
                    // the background run, not time anyone waits in this tab.
                    const addedTime = formatRoughRange(sum.toGenerate * 2 * 60_000, sum.toGenerate * 4 * 60_000);
                    const CHIP_LIMIT = 24;
                    let budget = batchSamplesExpanded ? Infinity : CHIP_LIMIT;
                    const shown = sum.groups.map(g => {
                      const take = g.sourcetypes.slice(0, Math.max(0, budget));
                      budget -= take.length;
                      return { ...g, take };
                    }).filter(g => g.take.length > 0);
                    const hidden = sum.toGenerate - shown.reduce((n, g) => n + g.take.length, 0);
                    return (
                      <section className="bx-samples" aria-label="Samples">
                        <div className="bx-samples-h">
                          <b>Samples</b>
                          <span className={`bx-pill ${sum.toGenerate ? 'warn' : 'good'}`}>
                            {sum.toGenerate ? `${sum.ready} of ${sum.needed} ready` : 'All ready'}
                          </span>
                        </div>
                        <div className="bx-meter" role="img" aria-label={`${sum.ready} of ${sum.needed} rows have a sample`}>
                          <span className="ready" style={{ width: `${pctReady}%` }} />
                          {sum.toGenerate > 0 && <span className="todo" style={{ width: `${100 - pctReady}%` }} />}
                        </div>
                        <div className="bx-meter-legend">
                          <span><i className="ready" />{sum.ready} ready — build{sum.ready === 1 ? 's' : ''} straight away</span>
                          {sum.toGenerate > 0 && <span><i className="todo" />{sum.toGenerate} sample{sum.toGenerate === 1 ? '' : 's'} created in the background</span>}
                        </div>
                        {sum.toGenerate > 0 && (
                          <>
                            <p className="bx-samples-lead">
                              <b>You can close this tab after Start.</b> For these sources, creating the sample is
                              the first step of each pack: Cribl AI generates it in the background, and it is used only
                              if it passes the source's parser check. One that fails twice ends that row, with the
                              reason in the report. Adds roughly {addedTime} to the background run.
                            </p>
                            <div className="bx-sample-groups">
                              {shown.map(g => (
                                <div className="bx-sample-group" key={g.format}>
                                  <div className="bx-sample-group-h">
                                    <span>→ {g.format}</span>
                                    <span className="bx-count">{g.sourcetypes.length}</span>
                                  </div>
                                  <div className="bx-chip-grid">
                                    {g.take.map(st => <code className="bx-st-chip" key={st}>{st}</code>)}
                                  </div>
                                </div>
                              ))}
                            </div>
                            {(hidden > 0 || batchSamplesExpanded) && sum.toGenerate > CHIP_LIMIT && (
                              <button type="button" className="bx-link bx-samples-toggle" onClick={() => setBatchSamplesExpanded(v => !v)}>
                                {batchSamplesExpanded ? 'Show fewer' : `Show all ${sum.toGenerate}`}
                              </button>
                            )}
                          </>
                        )}
                      </section>
                    );
                  })()}

                  {batchPackIdCollisions.length > 0 && (
                    <div className="bx-notice err col batch-collision-warning" style={{ marginTop: 14 }}>
                      <b>⚠︎ {batchPackIdCollisions.length} pack name{batchPackIdCollisions.length !== 1 ? 's' : ''} collapse to the same pack id</b>
                      <span>
                        Pack ids are lower-cased, so these rows will be merged into ONE pack
                        (the first row creates it, the rest add pipelines to it). Rename a
                        pack_name in the CSV if you want separate packs.
                      </span>
                      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                        {batchPackIdCollisions.map(c => (
                          <li key={c.packId}>
                            <code>{c.packId}</code> ← {c.names.join(', ')}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {batchConflicts.length > 0 && (
                    <>
                      <div className="bx-section-h">
                        {batchConflicts.length} pack{batchConflicts.length !== 1 ? 's' : ''} already in {selectedGroup}
                        <span className="bx-grow" />
                        <span className="bx-tally">{actionTally(batchConflicts, batchConflictActions)}</span>
                      </div>
                      <div className="bx-confirm-all">
                        <span>Apply to all</span>
                        <div className="bx-seg">
                          {CONFLICT_ACTIONS.map(a => (
                            <button key={a.key} className={`bx-seg-opt${allSame === a.key ? ' on' : ''}`} title={a.hint} onClick={() => setAll(a.key)}>{a.label} all</button>
                          ))}
                        </div>
                        <span className="bx-muted bx-confirm-legend">
                          {CONFLICT_ACTIONS.map(a => <span key={a.key}><b>{a.label}</b> {a.hint.toLowerCase()}</span>)}
                        </span>
                      </div>
                      <table className="bx-t bx-conflicts">
                        <thead>
                          <tr>
                            <th>Pack</th>
                            <th>Pipeline</th>
                            <th title="The stored golden's score for the whole pipeline">Overall</th>
                            <th title="Stored golden: extraction part (parser)">Extraction</th>
                            <th title="Stored golden: mapping part (to the destination schema)">Mapping</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {batchConflicts.map(packId => {
                            const pipes = batchConflictScores.get(packId) || [];
                            const lines = pipes.length ? pipes : [{ pipeline: '', sourcetype: '', dest: '', scores: { overall: null, extraction: null, mapping: null } }];
                            const action = batchConflictActions.get(packId) || 'overwrite';
                            const headline = packScore(pipes);
                            return lines.map((p, li) => (
                              <tr key={`${packId}-${li}`} className={`bx-crow${li < lines.length - 1 ? ' cont' : ''}`}>
                                {li === 0 && (
                                  <td rowSpan={lines.length}>
                                    <div className="bx-conflict-pack">
                                      <span className={`bx-score ${scoreTone(headline)}`}>{headline ?? '?'}</span>
                                      <div>
                                        <code>{packId}</code>
                                        <small>
                                          {packHint(pipes)}
                                        </small>
                                      </div>
                                    </div>
                                  </td>
                                )}
                                <td>
                                  {p.pipeline ? <><b>{p.pipeline}</b><span className="sub2"><code>{p.sourcetype}</code> → {p.dest}</span></> : <span className="bx-muted">—</span>}
                                </td>
                                <td className="bx-ems">{cell(p.scores.overall)}</td>
                                <td className="bx-ems">{cell(p.scores.extraction)}</td>
                                <td className="bx-ems">{cell(p.scores.mapping)}</td>
                                {li === 0 && (
                                  <td rowSpan={lines.length}>
                                    <div className="bx-seg">
                                      {CONFLICT_ACTIONS.map(a => (
                                        <button key={a.key} title={a.hint} className={`bx-seg-opt${action === a.key ? ' on' : ''}`} onClick={() => setAction(packId, a.key)}>{a.label}</button>
                                      ))}
                                    </div>
                                  </td>
                                )}
                              </tr>
                            ));
                          })}
                        </tbody>
                      </table>
                      <p className="bx-recap-note">Scores are the stored golden's: <b>Overall</b> for the whole pipeline, <b>Extraction</b> for the parser, <b>Mapping</b> for the schema mapping. Output shaping has no stored part, so it is only scored when the pack is built or scorecarded.</p>
                    </>
                  )}

                  <div className="bx-confirm-nav">
                    <button className="bx-btn sm" onClick={() => { setBatchConfirmReady(false); setBatchConflicts([]); }}>Cancel</button>
                  </div>
                </div>
              );
            })()}

            {/* Every way a background Start can fail does so BEFORE the progress
                screen exists — an ineligible provider, a run already active, a
                KV or schedule refusal. So the reason belongs here, beside the
                button that was pressed. */}
            {batchBackground && batchBgError && (
              <div className="error-box" role="alert">
                <strong>Could not start the background run:</strong> {batchBgError}
              </div>
            )}

            {selectedGroupBlock && (
              <div className="error-box pg-group-block" role="alert">
                <strong>{selectedGroup} can’t be used:</strong> {selectedGroupBlock} Pick a group with at least one active worker.
              </div>
            )}

            <StepNav>
              <button className="back" onClick={() => setStep(packMode === 'batch' ? 'batch-preflight' : 'mode')}>Back</button>
              {/* Lives only here, in the sticky nav — the conflict box (one row per
                  existing pack) can scroll well past the viewport, so this is the
                  one reachable Start regardless of scroll position. */}
              {batchConfirmReady && (
                <button
                  className="confirm-btn"
                  disabled={!!selectedGroupBlock || (batchBackground && batchBgStarting) || !(batchBackground ? batchRun.background.ok : batchRun.foreground.ok)}
                  onClick={() => batchBackground ? handleStartBackgroundBatch(selectedGroup) : handleBatchDeploy(selectedGroup)}
                >
                  {batchBackground
                    ? (batchBgStarting ? (batchBgPrep || 'Starting…') : 'Start in background')
                    : `Start (${batchRows.length - batchRows.filter(r => batchConflictActions.get(toKebab(r.pack_name)) === 'skip').length} pipelines)`}
                </button>
              )}
            </StepNav>
          </div>
        );
      }

      case 'select-pack':
        return (
          <div className="step">
            <h2>Select Pack</h2>
            <p className="step-desc">Choose the pack in <strong>{selectedGroup}</strong> where you want to add the new pipeline.</p>

            {packsLoading ? (
              <div className="ai-loading">
                <div className="ai-spinner" />
                <span>Loading packs...</span>
              </div>
            ) : packsError ? (
              <div className="error-box">
                <span>Could not load packs: {packsError}</span>
                <button onClick={() => fetchPacks(selectedGroup)}>Retry</button>
              </div>
            ) : existingPacks.length > 0 ? (
              <>
                <input
                  type="text"
                  value={packFilter}
                  onChange={(e) => setPackFilter(e.target.value)}
                  placeholder="Search packs..."
                  className="tile-search"
                />
                <div className="tile-grid">
                  {existingPacks
                    .filter((p) => (p.displayName || p.id).toLowerCase().includes(packFilter.toLowerCase()))
                    .sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id))
                    .map((p) => (
                    <div
                      key={p.id}
                      className={selectedPackId === p.id ? 'tile active' : 'tile'}
                      onClick={() => setSelectedPackId(p.id)}
                    >
                      <span className="tile-icon">&#128230;</span>
                      <strong className="tile-name">{p.displayName || p.id}</strong>
                      <span className="tile-meta">v{p.version}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="advice-box">
                <strong>No packs found</strong> in worker group <code>{selectedGroup}</code>. Consider creating a new pack instead.
              </div>
            )}

            <StepNav>
              <button className="back" onClick={() => { setSelectedGroup(''); setGroupFilter(''); setStep('select-group'); }}>Back</button>
              <button
                disabled={!selectedPackId}
                onClick={() => { setAddImproveAction(null); setStep('select-action'); }}
              >
                Next: Choose Action
              </button>
            </StepNav>
          </div>
        );

      case 'select-action':
        return (
          <div className="step mode-fork">
            <h2>Add or improve?</h2>
            <p className="step-desc">Choose what you want to do in <strong>{selectedPackId}</strong>.</p>
            <div className="mode-grid">
              <div
                className={addImproveAction === 'add' ? 'mode-card active' : 'mode-card'}
                onClick={() => setAddImproveAction('add')}
              >
                <strong>Add a new pipeline</strong>
                <span>Build a pipeline from sample data and add a route to this pack.</span>
              </div>
              <div
                className={addImproveAction === 'optimize' ? 'mode-card active' : 'mode-card'}
                onClick={() => setAddImproveAction('optimize')}
              >
                <strong>Improve an existing pipeline</strong>
                <span>Choose a deployed pipeline, set improvement goals, and optionally provide a fresh sample.</span>
              </div>
            </div>
            <StepNav>
              <button className="back" onClick={() => setStep('select-pack')}>Back</button>
              <button
                disabled={!addImproveAction || packPipelinesLoading}
                onClick={async () => {
                  if (addImproveAction === 'add') {
                    setStep('source');
                    return;
                  }
                  setPackPipelinesLoading(true);
                  setPackPipelinesError('');
                  setOptimizePipelineId('');
                  try {
                    setPackPipelines(await listPackPipelines(selectedGroup, selectedPackId));
                    setStep('select-pipeline');
                  } catch (err: unknown) {
                    setPackPipelinesError(err instanceof Error ? err.message : 'Failed to list pipelines');
                  } finally {
                    setPackPipelinesLoading(false);
                  }
                }}
              >
                {packPipelinesLoading ? 'Loading pipelines…' : addImproveAction === 'optimize' ? 'Next: Select Pipeline' : 'Next: Source Data'}
              </button>
            </StepNav>
            {packPipelinesError && <div className="error-box">{packPipelinesError}</div>}
          </div>
        );

      case 'select-pipeline':
        return (
          <div className="step">
            <h2>Select Pipeline</h2>
            <p className="step-desc">Choose the pipeline in <strong>{selectedPackId}</strong> that you want to improve.</p>
            {packPipelines.length > 0 ? (
              <div className="tile-grid">
                {packPipelines.map((pipeline) => (
                  <div
                    key={pipeline.id}
                    className={optimizePipelineId === pipeline.id ? 'tile active' : 'tile'}
                    onClick={() => {
                      setOptimizePipelineId(pipeline.id);
                      setCustomSourcetype('');
                      setIsCustomSourcetype(true);
                      setCustomConfirmed(false);
                      setValidationHint('');
                      setValidationSuggestions([]);
                      setStMatches([]);
                      const inferred = inferFromPipelineId(pipeline.id);
                      if (!inferred) {
                        update({ destFormats: [], sentinelTable: undefined, cimModel: undefined, asimSchema: undefined, ocsfSchema: undefined });
                        return;
                      }
                      setCustomSourcetype(inferred.sourcetype);
                      setIsCustomSourcetype(true);
                      const mapped = optimizeDestFromConcrete(inferred.destFormat);
                      if (!mapped.family) {
                        update({ destFormats: [], sentinelTable: undefined, cimModel: undefined, asimSchema: undefined, ocsfSchema: undefined });
                        return;
                      }
                      update({
                        destFormats: [mapped.family],
                        sentinelTable: mapped.sentinelTable,
                        cimModel: mapped.cimModel,
                        asimSchema: mapped.asimSchema,
                        ocsfSchema: mapped.ocsfSchema,
                      });
                    }}
                  >
                    <span className="tile-icon">⚙️</span>
                    <strong className="tile-name">{pipeline.id}</strong>
                    {pipeline.description && <span className="tile-meta">{pipeline.description}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="advice-box">No pipelines were found in this pack.</div>
            )}
            <StepNav>
              <button className="back" onClick={() => setStep('select-action')}>Back</button>
              <button disabled={!optimizePipelineId} onClick={() => setStep('optimize-goals')}>Next: Improvement Goals</button>
            </StepNav>
          </div>
        );

      case 'optimize-goals': {
        const inferred = inferFromPipelineId(optimizePipelineId);
        const mappedInferred = inferred ? optimizeDestFromConcrete(inferred.destFormat) : { family: '' as const };
        const inferredDestKnown = !!mappedInferred.family;
        const needsConfirmation = !inferred || !inferredDestKnown;
        const hasGoal = Object.values(optimizeGoals).some(Boolean);
        const destValue = state.destFormats[0] === 'manual' ? '' : (state.destFormats[0] || '');
        const sentinelSelected = destValue === 'sentinel';
        const cimSelected = destValue === 'cim';
        const asimSelected = destValue === 'asim';
        const ocsfSelected = destValue === 'ocsf';
        const sentinelRecs = effectiveSourcetype ? sentinelDestinationSuggestions(effectiveSourcetype) : [];
        const cimRecs = effectiveSourcetype ? cimModelPickerOptions(effectiveSourcetype) : [];
        const cimSuggested = effectiveSourcetype ? new Set(cimModelSuggestions(effectiveSourcetype)) : new Set<string>();
        const asimOpts = asimSchemaOptions();
        const ocsfOpts = ocsfSchemaOptions();
        const asimRecommended = effectiveSourcetype
          ? concretizeAsimFormat('asim', effectiveSourcetype, state.sampleEvents)
          : 'asim';
        const ocsfRecommended = effectiveSourcetype
          ? concretizeOcsfFormat('ocsf', effectiveSourcetype, state.sampleEvents)
          : 'ocsf#network';
        const modelReady = sentinelSelected ? !!state.sentinelTable
          : cimSelected ? !!state.cimModel
          : asimSelected ? !!state.asimSchema
          : ocsfSelected ? !!state.ocsfSchema
          : true;
        const contextReady = !!effectiveSourcetype.trim() && customConfirmed && !!destValue && modelReady;
        if (sentinelSelected && !state.sentinelTable && sentinelRecs.length) {
          setTimeout(() => update({ sentinelTable: sentinelRecs[0] }), 0);
        }
        if (cimSelected && !state.cimModel && cimRecs.length) {
          setTimeout(() => update({ cimModel: cimRecs[0] }), 0);
        }
        if (asimSelected && !state.asimSchema) {
          setTimeout(() => update({ asimSchema: 'auto' }), 0);
        }
        if (ocsfSelected && !state.ocsfSchema) {
          setTimeout(() => update({ ocsfSchema: 'auto' }), 0);
        }
        return (
          <div className="step">
            <h2>Improvement Goals</h2>
            <p className="step-desc">Choose what should be reassessed for <code>{optimizePipelineId}</code>.</p>
            <div className={`optimize-inference${needsConfirmation ? '' : ' optimize-inference-ok'}`}>
              <strong>{needsConfirmation ? 'Confirm pipeline context' : 'Pipeline context'}</strong>
              <p className="field-hint">
                {needsConfirmation
                  ? 'The pipeline ID does not identify a known source and destination pair — set them below before continuing.'
                  : <>Inferred from <code>{optimizePipelineId}</code> — change only if this is wrong.</>}
              </p>
              <div className="optimize-confirm-grid">
                <label className="optimize-context-field">
                  <span>Sourcetype</span>
                  <div className="custom-input-inline">
                    <input
                      type="text"
                      value={effectiveSourcetype}
                      onChange={(e) => {
                        setCustomSourcetype(normalizeSourcetypeName(e.target.value));
                        setIsCustomSourcetype(true);
                        setCustomConfirmed(false);
                        setValidationHint('');
                        setValidationSuggestions([]);
                        setStMatches([]);
                      }}
                      onBlur={() => { if (effectiveSourcetype.trim() && !customConfirmed) void validateSourcetype(effectiveSourcetype); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && effectiveSourcetype.trim()) void validateSourcetype(effectiveSourcetype); }}
                      placeholder="e.g. cisco_asa"
                      disabled={validating}
                    />
                    <button
                      type="button"
                      className="confirm-btn"
                      disabled={!effectiveSourcetype.trim() || validating}
                      onClick={() => void validateSourcetype(effectiveSourcetype)}
                    >
                      {validating ? 'Checking...' : 'Confirm'}
                    </button>
                  </div>
                </label>
                <label className="optimize-context-field">
                  <span>Destination format</span>
                  <select
                    value={destValue}
                    onChange={(e) => {
                      const next = e.target.value as DestFormat | '';
                      const patch: Record<string, any> = {
                        destFormats: next ? [next] : [],
                        sentinelTable: undefined,
                        cimModel: undefined,
                        asimSchema: undefined,
                        ocsfSchema: undefined,
                      };
                      if (next === 'sentinel' && effectiveSourcetype) {
                        const recs = sentinelDestinationSuggestions(effectiveSourcetype);
                        if (recs[0]) patch.sentinelTable = recs[0];
                      }
                      if (next === 'cim' && effectiveSourcetype) {
                        const recs = cimModelPickerOptions(effectiveSourcetype);
                        if (recs[0]) patch.cimModel = recs[0];
                      }
                      if (next === 'asim') patch.asimSchema = 'auto';
                      if (next === 'ocsf') patch.ocsfSchema = 'auto';
                      update(patch);
                    }}
                  >
                    <option value="">Select a format…</option>
                    {OPTIMIZE_DEST_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              {sentinelSelected && (
                <div className="dest-suboption dest-suboption-sentinel" style={{ marginTop: 12 }}>
                  <div className="dest-suboption-head">
                    <strong>Microsoft Sentinel — table</strong>
                    {state.sentinelTable && <span className="dest-suboption-chosen">✓ {state.sentinelTable} · {resolveSentinelTable(state.sentinelTable)?.table.columns.length || 0} columns</span>}
                  </div>
                  <div className="dest-suboption-btns">
                    {sentinelRecs.map(tbl => (
                      <button key={tbl} type="button" className={`dest-pill${state.sentinelTable === tbl ? ' active' : ''}`}
                        onClick={() => update({ sentinelTable: tbl })}>{tbl}</button>
                    ))}
                  </div>
                </div>
              )}
              {cimSelected && (
                <div className="dest-suboption dest-suboption-cim" style={{ marginTop: 12 }}>
                  <div className="dest-suboption-head">
                    <strong>Splunk CIM — data model</strong>
                    {state.cimModel && <span className="dest-suboption-chosen">✓ {state.cimModel.replace(/_/g, ' ')}</span>}
                  </div>
                  <div className="dest-suboption-btns">
                    {cimRecs.map(m => (
                      <button key={m} type="button" className={`dest-pill${state.cimModel === m ? ' active' : ''}${cimSuggested.has(m) ? ' dest-pill-recommended' : ''}`}
                        title={cimSuggested.has(m) ? 'Recommended for this source' : undefined}
                        onClick={() => update({ cimModel: m })}>{m.replace(/_/g, ' ')}{cimSuggested.has(m) ? ' ★' : ''}</button>
                    ))}
                  </div>
                </div>
              )}
              {asimSelected && (
                <div className="dest-suboption dest-suboption-sentinel" style={{ marginTop: 12 }}>
                  <div className="dest-suboption-head">
                    <strong>Microsoft Sentinel ASIM — schema</strong>
                    {(() => {
                      const chosen = (!state.asimSchema || state.asimSchema === 'auto') ? asimRecommended : state.asimSchema;
                      const opt = asimOpts.find(o => o.key === chosen);
                      return <span className="dest-suboption-chosen">✓ {opt?.table || 'ASimNetworkSessionLogs'}{(!state.asimSchema || state.asimSchema === 'auto') ? ' · auto from data' : ''}</span>;
                    })()}
                  </div>
                  <div className="dest-suboption-btns">
                    <button type="button" className={`dest-pill${(!state.asimSchema || state.asimSchema === 'auto') ? ' active' : ''}`}
                      onClick={() => update({ asimSchema: 'auto' })}
                      title="Pick the ASIM schema automatically from the sourcetype and sample data class">
                      Auto{asimRecommended !== 'asim' ? ` (${asimOpts.find(o => o.key === asimRecommended)?.label || 'Network'})` : ' (Network)'}
                    </button>
                    {asimOpts.map(o => (
                      <button key={o.key} type="button" className={`dest-pill${state.asimSchema === o.key ? ' active' : ''}`}
                        onClick={() => update({ asimSchema: o.key })}
                        title={o.table}>{o.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {ocsfSelected && (
                <div className="dest-suboption dest-suboption-cim" style={{ marginTop: 12 }}>
                  <div className="dest-suboption-head">
                    <strong>OCSF — class</strong>
                    {(() => {
                      const chosen = (!state.ocsfSchema || state.ocsfSchema === 'auto') ? ocsfRecommended : state.ocsfSchema;
                      const ocsfKey = chosen.startsWith('nextgen#') ? `ocsf#${chosen.slice('nextgen#'.length)}` : chosen === 'nextgen' ? 'ocsf#network' : chosen;
                      const opt = ocsfOpts.find(o => o.key === ocsfKey) || ocsfOpts.find(o => o.key === chosen);
                      return <span className="dest-suboption-chosen">✓ {opt ? `${opt.label} (${opt.classUid})` : chosen}{(!state.ocsfSchema || state.ocsfSchema === 'auto') ? ' · auto from data' : ''}</span>;
                    })()}
                  </div>
                  <div className="dest-suboption-btns">
                    <button type="button" className={`dest-pill${(!state.ocsfSchema || state.ocsfSchema === 'auto') ? ' active' : ''}`}
                      onClick={() => update({ ocsfSchema: 'auto' })}
                      title="Pick the OCSF class automatically from the sourcetype and sample data class">
                      Auto{(() => {
                        const k = ocsfRecommended.startsWith('nextgen#') ? `ocsf#${ocsfRecommended.slice('nextgen#'.length)}` : ocsfRecommended === 'nextgen' ? 'ocsf#network' : ocsfRecommended;
                        const opt = ocsfOpts.find(o => o.key === k);
                        return opt ? ` (${opt.label})` : '';
                      })()}
                    </button>
                    {ocsfOpts.map(o => (
                      <button key={o.key} type="button" className={`dest-pill${state.ocsfSchema === o.key ? ' active' : ''}`}
                        onClick={() => update({ ocsfSchema: o.key })}
                        title={`class_uid ${o.classUid}`}>{o.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {validating && <div className="validation-loading">Validating sourcetype...</div>}
              {customConfirmed && effectiveSourcetype.trim() && !validating && (
                <div className="optimize-st-ok">Recognized sourcetype: <code>{effectiveSourcetype}</code></div>
              )}
              {!customConfirmed && !validating && stMatches.length > 0 && (
                <div className="st-search-matches">
                  <span className="st-search-label">Pick a supported sourcetype, or refine the name and Confirm again:</span>
                  <div className="st-search-list">
                    {stMatches.map((m) => (
                      <button
                        key={m.name}
                        type="button"
                        className={m.name === customSourcetype ? 'st-search-item active' : 'st-search-item'}
                        title={m.description || m.name}
                        onClick={() => { setCustomSourcetype(m.name); setStMatches([]); setValidationHint(''); setValidationSuggestions([]); applyRecognition(m.name); setCustomConfirmed(true); }}
                      >
                        {m.golden && <span className="st-search-star">{'★'}</span>}
                        <span className="st-search-name">{m.name}</span>
                        {m.description && <span className="st-search-desc">{m.description}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {validationHint && validationSuggestions.length > 0 && (
                <div className="validation-suggestions">
                  <span className="validation-hint">{validationHint}</span>
                  <div className="suggestion-options">
                    {validationSuggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={s === customSourcetype ? 'suggestion-btn active' : 'suggestion-btn'}
                        onClick={() => { setCustomSourcetype(s); setValidationHint(''); setValidationSuggestions([]); applyRecognition(s); setCustomConfirmed(true); }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {validationHint && validationSuggestions.length === 0 && !customConfirmed && (
                <div className="validation-hint">{validationHint}</div>
              )}
            </div>
            <div className="optimize-goals">
              {([
                ['sample', 'New or updated sample', 'Provide current events to verify the pipeline against. Also selects extraction and mapping.'],
                ['extraction', 'Improve extraction', 'Reassess parsing and source-field coverage. Also selects mapping because new fields change what mapping can do.'],
                ['mapping', 'Improve mapping', 'Reassess destination field mapping and schema coverage.'],
              ] as const).map(([goal, label, description]) => {
                const order = ['sample', 'extraction', 'mapping'] as const;
                const idx = order.indexOf(goal);
                // Downstream stages are locked while any parent is checked — uncheck
                // the parent first to edit lower goals independently.
                const lockedByUpstream = order.slice(0, idx).some(g => optimizeGoals[g]);
                return (
                <label className={`optimize-goal${lockedByUpstream ? ' optimize-goal-locked' : ''}`} key={goal}>
                  <input
                    type="checkbox"
                    checked={optimizeGoals[goal]}
                    disabled={lockedByUpstream}
                    onChange={(e) => {
                      if (lockedByUpstream) return;
                      const checked = e.target.checked;
                      setOptimizeGoals(current => {
                        const next = { ...current };
                        if (checked) {
                          // Checking a stage also selects everything downstream —
                          // sample/extraction changes invalidate later stages.
                          for (let i = idx; i < order.length; i++) next[order[i]] = true;
                        } else {
                          next[goal] = false;
                        }
                        return next;
                      });
                    }}
                  />
                  <span><strong>{label}</strong><small>{description}</small></span>
                </label>
                );
              })}
            </div>
            <div className="optimize-guidance">
              <label>Additional guidance <span className="hint">(optional)</span></label>
              <textarea
                value={optimizeGuidance}
                onChange={(e) => setOptimizeGuidance(e.target.value)}
                placeholder="Optional: e.g. keep vendor_action, fix _time, do not drop ACL names"
                rows={8}
              />
            </div>
            <StepNav>
              <button className="back" onClick={() => setStep('select-pipeline')}>Back</button>
              <button disabled={!hasGoal || !contextReady || validating} onClick={() => setStep(optimizeGoals.sample ? 'optimize-sample' : 'optimize-running')}>
                {optimizeGoals.sample ? 'Next: Sample Data' : 'Review Improvements'}
              </button>
            </StepNav>
          </div>
        );
      }

      case 'name': {
        // Inline existing-pack check: warn right here (at naming time) instead of
        // after the build starts. packId is the kebab-cased pack name; compare it
        // to the packs already on the selected group.
        const nameConflict = !!packId && existingPacks.some(p => p.id === packId);
        return (
          <div className="step">
            <h2>Pack Details</h2>
            <div className="field">
              <label>Pack Name <span className="hint">(will become ID: <code>{packId || '...'}</code>)</span></label>
              <input
                type="text"
                className={nameConflict ? 'input-warn' : undefined}
                value={state.packName}
                onChange={(e) => update({ packName: e.target.value })}
                placeholder="e.g. Windows PowerShell OCSF"
              />
              {nameConflict && (
                <div className="name-conflict-note">
                  <span className="name-conflict-icon" aria-hidden="true">⚠</span>
                  <span>
                    A pack named <code>{packId}</code> already exists on <code>{selectedGroup || state.workerGroup}</code>.
                    Change the name above to create a new one, or <strong>continue</strong> to overwrite it.
                  </span>
                </div>
              )}
            </div>
            <div className="field">
              <label>Display Name <span className="hint">(optional, defaults to Pack Name)</span></label>
              <input
                type="text"
                value={state.displayName}
                onChange={(e) => update({ displayName: e.target.value })}
                placeholder="e.g. Windows PowerShell to OCSF 1.9"
              />
            </div>
            <div className="field">
              <label>Route Filter <span className="hint">(which events to process)</span></label>
              <input
                type="text"
                value={state.routeFilter}
                onChange={(e) => update({ routeFilter: e.target.value })}
                placeholder={`e.g. sourcetype=='${packId || 'syslog'}'`}
              />
            </div>
            <div className="advice-box">
              <strong>Tip:</strong> The route filter, pipeline functions, and sample data can all be modified after creation in the Cribl UI. The pack name/ID cannot be changed once deployed. Deploying to worker group <code>{state.workerGroup}</code>.
            </div>
            <StepNav>
              <button className="back" onClick={() => setStep('select-group')}>Back</button>
              <button disabled={!canProceedName} onClick={() => setStep(packMode === 'post-process' ? 'pp-formats' : 'source')}>{nameConflict ? 'Continue (overwrite)' : packMode === 'post-process' ? 'Next: Formats' : 'Next: Source Data'}</button>
            </StepNav>
          </div>
        );
      }

      case 'pp-formats': {
        const ppPair = getPostProcessPair(ppSourceFormat, ppDestFormat);
        const ppSampleLines = postProcessSampleEvents(ppSourceFormat).split('\n').filter(Boolean);
        const ppSchemaOpts = postProcessSchemaOptions(ppDestFormat);
        // Concrete golden format to build/deploy: the chosen sub-schema, else the
        // family default (bare `cim`/`asim`/`chronicle`, or a standalone format).
        const ppEffectiveFormat = (ppSchema && ppSchemaOpts.some(o => o.key === ppSchema)) ? ppSchema : ppDestFormat;
        return (
          <div className="step">
            <h2>Post-Processing Formats</h2>
            <p className="step-desc">
              Transform events that are <strong>already normalized</strong> into a SIEM wire format on the way out.
              Deploys a self-contained pack you can attach as a destination <em>post-processing pipeline</em> — the class
              dictionary ships as an editable in-pack lookup, so you can add classes and severities later without code.
            </p>

            <div className="field">
              <label>Source format <span className="hint">(the schema your events are already in)</span></label>
              <div className="mode-grid">
                {POSTPROCESS_SOURCE_FORMATS.map(f => (
                  <div
                    key={f.value}
                    className={ppSourceFormat === f.value ? 'mode-card active' : 'mode-card'}
                    onClick={() => setPpSourceFormat(f.value)}
                  >
                    <strong>{f.label}</strong>
                    <span>{f.description}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Destination format <span className="hint">(the SIEM format to emit)</span></label>
              <div className="mode-grid">
                {POSTPROCESS_DEST_FORMATS.map(f => (
                  <div
                    key={f.value}
                    className={ppDestFormat === f.value ? 'mode-card active' : 'mode-card'}
                    onClick={() => { setPpDestFormat(f.value); setPpSchema(''); }}
                  >
                    <strong>{f.label}</strong>
                    <span>{f.description}</span>
                  </div>
                ))}
              </div>
            </div>

            {ppSchemaOpts.length > 0 && (
              <div className="field">
                <label>
                  {ppDestFormat === 'cim' ? 'Splunk CIM data model' : ppDestFormat === 'asim' ? 'ASIM schema' : 'Chronicle event class'}
                  <span className="hint">(which {ppDestFormat === 'cim' ? 'data model' : ppDestFormat === 'asim' ? 'ASim table' : 'UDM class'} to emit)</span>
                </label>
                <div className="mode-grid">
                  {ppSchemaOpts.map(o => (
                    <div
                      key={o.key}
                      className={ppEffectiveFormat === o.key ? 'mode-card active' : 'mode-card'}
                      onClick={() => setPpSchema(o.key)}
                    >
                      <strong>{o.label}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {ppPair ? (
              <div className="advice-box">
                <strong>{ppPair.label}</strong>
                <p style={{ marginTop: 6, marginBottom: 0 }}>{ppPair.description}</p>
              </div>
            ) : isNoPairPostProcessDestination(ppDestFormat) ? (
              <div className="advice-box">
                <strong>{POSTPROCESS_DEST_FORMATS.find(f => f.value === postProcessFamilyOf(ppDestFormat))?.label ?? ppDestFormat}</strong>
                <p style={{ marginTop: 6, marginBottom: 0 }}>
                  {POSTPROCESS_DEST_FORMATS.find(f => f.value === postProcessFamilyOf(ppDestFormat))?.description
                    ?? 'No field mapping — only event-scope optimization (drop/sample/suppress) is applied.'}
                </p>
              </div>
            ) : (
              <div className="error-box">No transform is available for {ppSourceFormat} → {ppDestFormat} yet.</div>
            )}

            <div className="field">
              <label>Route Filter <span className="hint">(which events this pipeline processes — default all)</span></label>
              <input
                type="text"
                value={state.routeFilter}
                onChange={(e) => update({ routeFilter: e.target.value })}
                placeholder="true"
              />
              <p className="step-desc" style={{ marginTop: 6, marginBottom: 0 }}>
                Default: <code>true</code> — a post-processing pipeline usually processes every event sent to the destination.
              </p>
            </div>

            <div className="field">
              <label>Curated {ppSourceFormat.toUpperCase()} sample <span className="hint">({ppSampleLines.length} events — used to preview the transform in the pack)</span></label>
              <pre className="batch-example" style={{ maxHeight: 180, overflow: 'auto' }}>{ppSampleLines.slice(0, 3).map(l => l.length > 300 ? l.slice(0, 300) + '…' : l).join('\n')}</pre>
            </div>

            {error && <div className="error-box">{error}</div>}
            <StepNav>
              <button className="back" onClick={() => setStep('name')}>Back</button>
              <button className="deploy-btn" disabled={!ppPair && !isNoPairPostProcessDestination(ppDestFormat)} onClick={handlePostProcessDeploy}>Deploy Pack</button>
            </StepNav>
          </div>
        );
      }

      case 'optimize-sample':
      case 'source': {
        const categoryIcons: Record<string, string> = {
          'Network Security': '\u{1F6E1}',
          'Endpoint': '\u{1F5A5}',
          'Cloud': '\u{2601}',
          'Identity': '\u{1F511}',
          'Proxy': '\u{1F310}',
          'Web': '\u{1F4C4}',
          'Other': '\u{270F}',
        };
        const filteredSourcetypes = SOURCETYPES.filter((s) =>
          s.label.toLowerCase().includes(sourcetypeFilter.toLowerCase()) ||
          s.category.toLowerCase().includes(sourcetypeFilter.toLowerCase())
        );
        const filteredExistingSamples = existingSamples.filter(s =>
          s.name.toLowerCase().includes(sampleSearchFilter.toLowerCase()) ||
          s.id.toLowerCase().includes(sampleSearchFilter.toLowerCase()) ||
          (s.packName || '').toLowerCase().includes(sampleSearchFilter.toLowerCase())
        );
        const activeWorkerGroup = selectedGroup || state.workerGroup;

        return (
          <div className="step">
            <h2>{step === 'optimize-sample' ? 'Improvement Sample' : 'Source Data'}</h2>
            <p className="step-desc">
              {step === 'optimize-sample'
                ? `Provide current events for ${optimizePipelineId}. The same local sanitisation controls used when adding a pipeline are available below.`
                : 'Provide sample events first — the sourcetype will be auto-detected.'}
            </p>

            <div className="field">
              <label>How do you want to provide sample events?</label>
              <div className="tile-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                <div
                  className={state.sourceMode === 'upload' ? 'tile active' : 'tile'}
                  onClick={() => { update({ sourceMode: 'upload' as SourceMode, sampleEvents: '' }); setDetectedSourcetype(''); setExistingSampleLabel(''); }}
                >
                  <span className="tile-icon">{'\u{1F4C1}'}</span>
                  <strong className="tile-name">Upload file</strong>
                  <span className="tile-meta">JSON, log, txt, csv</span>
                </div>
                <div
                  className={state.sourceMode === 'existing' ? 'tile active' : 'tile'}
                  onClick={() => {
                    update({ sourceMode: 'existing' as SourceMode, sampleEvents: '' });
                    setDetectedSourcetype('');
                    setExistingSampleLabel('');
                    if (activeWorkerGroup) void fetchExistingSamples();
                  }}
                >
                  <span className="tile-icon">{'\u{1F4BE}'}</span>
                  <strong className="tile-name">Group sample</strong>
                  <span className="tile-meta">Pick from {activeWorkerGroup || 'worker group'}</span>
                </div>
                <div
                  className={state.sourceMode === 'paste' ? 'tile active' : 'tile'}
                  onClick={() => { update({ sourceMode: 'paste' as SourceMode, sampleEvents: '' }); setDetectedSourcetype(''); setExistingSampleLabel(''); }}
                >
                  <span className="tile-icon">{'\u{1F4CB}'}</span>
                  <strong className="tile-name">Paste events</strong>
                  <span className="tile-meta">One per line or JSON</span>
                </div>
                <div
                  className={state.sourceMode === 'live-capture' ? 'tile active' : 'tile'}
                  onClick={() => { update({ sourceMode: 'live-capture' as SourceMode, sampleEvents: '' }); setDetectedSourcetype(''); setCaptureFilter('true'); setExistingSampleLabel(''); }}
                >
                  <span className="tile-icon">{'\u{1F4E1}'}</span>
                  <strong className="tile-name">Live capture</strong>
                  <span className="tile-meta">Capture from worker group</span>
                </div>
                <div
                  className={state.sourceMode === 'ai-generate' ? 'tile active' : 'tile'}
                  onClick={() => { update({ sourceMode: 'ai-generate' as SourceMode, sampleEvents: '' }); setDetectedSourcetype(''); setExistingSampleLabel(''); }}
                >
                  <span className="tile-icon">{'\u{2728}'}</span>
                  <strong className="tile-name">AI-generate</strong>
                  <span className="tile-meta">Pick sourcetype first</span>
                </div>
              </div>
            </div>

            {/* Upload mode */}
            {state.sourceMode === 'upload' && !state.sampleEvents && (
              <div className="field">
                <label
                  className="upload-zone"
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
                  onDragLeave={(e) => { e.currentTarget.classList.remove('dragover'); }}
                  onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) readSampleFile(f); }}
                >
                  <input type="file" accept=".json,.log,.txt,.csv" onChange={handleFileUpload} style={{ display: 'none' }} />
                  <span className="upload-zone-icon">{'\u{2B06}\u{FE0F}'}</span>
                  <strong>Drop file here or click to browse</strong>
                  <span className="upload-zone-hint">JSON, log, txt, csv — one event per line</span>
                </label>
              </div>
            )}

            {/* Existing worker-group sample */}
            {state.sourceMode === 'existing' && !state.sampleEvents && (
              <div className="field existing-samples-section">
                {!activeWorkerGroup ? (
                  <div className="advice-box">Select a worker group first, then return here to pick a sample.</div>
                ) : (
                  <>
                    <label className="existing-samples-label">
                      Samples in worker group <code>{activeWorkerGroup}</code> (including samples inside installed packs)
                      {samplesListLoading && <span className="ai-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
                    </label>
                    {existingSamples.length === 0 && !samplesListLoading && (
                      <button className="load-samples-btn" onClick={fetchExistingSamples}>Load samples</button>
                    )}
                    {existingSamples.length > 0 && (
                      <>
                        <input
                          type="text"
                          value={sampleSearchFilter}
                          onChange={(e) => setSampleSearchFilter(e.target.value)}
                          placeholder="Search samples..."
                          className="tile-search"
                        />
                        <p className="gen-tier-note" style={{ marginTop: 6, marginBottom: 6 }}>
                          The badge shows each sample's <b>wire format</b>. The pack is built around the format of the
                          sample you pick, so choose the one your feed really emits — a CEF sample for a key=value feed
                          produces a pipeline that extracts nothing in production.
                        </p>
                        <div className="tile-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', maxHeight: 220 }}>
                          {filteredExistingSamples.map(s => {
                            const fmt = sampleFormats[sampleKey(s)];
                            return (
                              <div key={sampleKey(s)} className="tile" onClick={() => loadExistingSample(s.id, s.name, s.packId)}>
                                <span className="tile-icon">{s.packId ? '\u{1F4E6}' : '\u{1F4C4}'}</span>
                                <strong className="tile-name">{s.name}</strong>
                                {s.packName && <span className="tile-meta" title={`From pack ${s.packName}`} style={{ opacity: 0.75 }}>{'\u{1F4E6}'} {s.packName}</span>}
                                <span className="tile-meta">{s.numEvents} events &middot; {Math.round(s.size / 1024)}KB</span>
                                {fmt === 'busy' ? (
                                  <span className="sample-format-badge sample-format-pending">reading format…</span>
                                ) : (!fmt || fmt === 'unknown') ? (
                                  <span
                                    className="sample-format-badge sample-format-pending"
                                    title={s.size > SAMPLE_FORMAT_SNIFF_MAX_BYTES
                                      ? 'Too large to inspect in the background — the format is shown once the sample is loaded.'
                                      : 'Format not inspected yet — it is shown once the sample is loaded.'}
                                  >format unknown</span>
                                ) : (
                                  <span
                                    className={fmt.mixed ? 'sample-format-badge sample-format-mixed' : 'sample-format-badge'}
                                    title={fmt.detail}
                                  >{fmt.label}{fmt.mixed ? ' · mixed' : ''}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {filteredExistingSamples.length === 0 && (
                          <p className="step-desc" style={{ marginTop: 8 }}>No samples match your search.</p>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Paste mode */}
            {state.sourceMode === 'paste' && (
              <div className="field">
                <label>Paste sample events <span className="hint">(one event per line, or JSON array)</span></label>
                <textarea
                  className="paste-area"
                  value={state.sampleEvents}
                  onChange={(e) => { setSampleRepairNotice(''); update({ sampleEvents: e.target.value }); }}
                  onBlur={() => { if (state.sampleEvents.trim() && !detectedSourcetype && !detecting) { const repaired = repairXmlEventBreaking(state.sampleEvents); if (repaired !== state.sampleEvents) update({ sampleEvents: repaired }); detectSourcetype(repaired, { sourceMode: 'paste' }); } }}
                  placeholder={"Paste your events here, one per line...\n\nExample:\n<166>%ASA-6-302013: Built inbound TCP connection...\n<166>%ASA-4-106023: Deny tcp src outside:10.1.1.1..."}
                  rows={10}
                />
                {state.sampleEvents.trim() && !detectedSourcetype && !detecting && (
                  <button className="confirm-btn" style={{ marginTop: 8 }} onClick={() => detectSourcetype(state.sampleEvents, { sourceMode: 'paste' })}>Detect sourcetype</button>
                )}
              </div>
            )}

            {/* Live capture mode */}
            {state.sourceMode === 'live-capture' && !captureLoading && !state.sampleEvents && (
              <div className="ai-generate-options">
                <label>Live capture settings</label>
                <p className="gen-tier-note" style={{ marginTop: 0, marginBottom: 12 }}>
                  Captures real events flowing through the selected worker group. Ensure traffic is actively being processed.
                </p>
                <div className="field" style={{ marginBottom: 12 }}>
                  <label>Filter expression <span className="hint">(Cribl filter syntax)</span></label>
                  <input
                    type="text"
                    value={captureFilter}
                    onChange={(e) => setCaptureFilter(e.target.value)}
                    placeholder="true for all events, or sourcetype=='cisco_asa'"
                  />
                </div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Max events</label>
                    <input
                      type="text"
                      value={captureMaxEvents}
                      onChange={(e) => setCaptureMaxEvents(Math.min(500, Math.max(1, Number(e.target.value) || 100)))}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Duration (seconds)</label>
                    <input
                      type="text"
                      value={captureDuration}
                      onChange={(e) => setCaptureDuration(Math.min(30, Math.max(1, Number(e.target.value) || 10)))}
                    />
                  </div>
                </div>
                <button
                  className="confirm-btn"
                  onClick={fetchLiveCapture}
                  disabled={!(selectedGroup || state.workerGroup)}
                >
                  Start capture ({captureMaxEvents} events, {captureDuration}s)
                </button>
              </div>
            )}

            {captureLoading && (
              <AiProgress messages={[
                'Starting live capture on worker group...',
                'Waiting for events to flow through...',
                'Capturing matching events...',
                'Collecting results...',
              ]} />
            )}

            {state.sourceMode === 'live-capture' && !captureLoading && error && (
              <div className={error.startsWith('No events matched') ? 'advice-box' : 'error-box'}>
                {error}
                <div style={{ marginTop: 8 }}>
                  <button className="confirm-btn" onClick={fetchLiveCapture}>Retry capture</button>
                </div>
              </div>
            )}

            {/* AI-generate: sourcetype picker first */}
            {state.sourceMode === 'ai-generate' && !state.sampleEvents && (
              <>
                <div className="field">
                  <label>Select sourcetype to generate events for</label>
                  <input
                    type="text"
                    value={sourcetypeFilter}
                    onChange={(e) => setSourcetypeFilter(e.target.value)}
                    placeholder="Search sourcetypes..."
                    className="tile-search"
                  />
                  <div className="tile-grid">
                    {filteredSourcetypes.map((s) => {
                      const ref = referenceAvailability[s.value];
                      const hasRef = ref && (ref.hasSamples || ref.fields > 0);
                      return (
                        <div
                          key={s.value}
                          className={s.value === '__custom__'
                            ? (isCustomSourcetype ? 'tile tile-custom active' : 'tile tile-custom')
                            : (!isCustomSourcetype && sourcetype === s.value ? 'tile active' : 'tile')}
                          onClick={() => s.value === '__custom__' ? handleSelectOther() : handleSelectSourcetype(s.value)}
                        >
                          {hasRef && (
                            <span
                              className="tile-ref-badge"
                              title={`Reference data from professional pack${ref.pack ? ` "${ref.pack}"` : ''}: ${ref.hasSamples ? `${ref.sampleEvents} real sample events, ` : ''}${ref.fields} known fields${ref.transformations.length ? `, maps to ${ref.transformations.join('/').toUpperCase()}` : ''}`}
                            >
                              {ref.hasSamples ? `${'\u{2B50}'} sample` : `${'\u{1F4DA}'} mappings`}
                            </span>
                          )}
                          <span className="tile-icon">{s.value === '__custom__' ? '\u{270F}' : (categoryIcons[s.category] || '\u{1F4E6}')}</span>
                          <strong className="tile-name">{s.label}</strong>
                          <span className="tile-meta">{s.category}</span>
                        </div>
                      );
                    })}
                  </div>
                  {isCustomSourcetype && (
                    <div className="custom-input-row">
                      <div className="custom-input-inline">
                        <input
                          type="text"
                          value={customSourcetype}
                          onChange={(e) => { setCustomSourcetype(normalizeSourcetypeName(e.target.value)); setCustomConfirmed(false); setValidationHint(''); setValidationSuggestions([]); setStMatches([]); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' && customSourcetype.trim()) validateSourcetype(customSourcetype); }}
                          placeholder="e.g. cisco_meraki"
                          disabled={validating}
                        />
                        <button
                          className="confirm-btn"
                          disabled={!customSourcetype.trim() || validating}
                          onClick={() => validateSourcetype(customSourcetype)}
                        >
                          {validating ? 'Checking...' : 'Confirm'}
                        </button>
                      </div>
                      <div className="format-hint">Use snake_case format: vendor_product (e.g. cisco_asa, palo_alto_traffic)</div>
                      {!customConfirmed && !validating && stMatches.length > 0 && (
                        <div className="st-search-matches">
                          <span className="st-search-label">Pick a supported sourcetype to use it directly, or refine the name yourself and Confirm again:</span>
                          <div className="st-search-list">
                            {stMatches.map((m) => (
                              <button
                                key={m.name}
                                className={m.name === customSourcetype ? 'st-search-item active' : 'st-search-item'}
                                title={m.description || m.name}
                                onClick={() => { setCustomSourcetype(m.name); setStMatches([]); setValidationHint(''); setValidationSuggestions([]); applyRecognition(m.name); setCustomConfirmed(true); }}
                              >
                                {m.golden && <span className="st-search-star">{'★'}</span>}
                                <span className="st-search-name">{m.name}</span>
                                {m.description && <span className="st-search-desc">{m.description}</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {validating && (
                        <div className="validation-loading">Validating sourcetype...</div>
                      )}
                      {validationHint && validationSuggestions.length > 0 && (
                        <div className="validation-suggestions">
                          <span className="validation-hint">{validationHint}</span>
                          <div className="suggestion-options">
                            {validationSuggestions.map((s) => (
                              <button
                                key={s}
                                className={s === customSourcetype ? 'suggestion-btn active' : 'suggestion-btn'}
                                onClick={() => { setCustomSourcetype(s); setValidationHint(''); setValidationSuggestions([]); applyRecognition(s); setCustomConfirmed(true); }}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {validationHint && validationSuggestions.length === 0 && (
                        <div className="validation-hint">{validationHint}</div>
                      )}
                    </div>
                  )}
                </div>

                {effectiveSourcetype && !samplesLoading && (!isCustomSourcetype || customConfirmed) && (
                  <div className="ai-generate-options">
                    <label>Sample source</label>
                    <div className="source-picker">
                      {referenceAvailability[effectiveSourcetype]?.hasSamples && (
                        <div
                          className={sampleSourceId === 'reference' ? 'source-option source-option-ref active' : 'source-option source-option-ref'}
                          onClick={() => setSampleSourceId('reference')}
                        >
                          <span className="source-option-icon">{'\u{2B50}'}</span>
                          <div className="source-option-text">
                            <strong>Reference sample (recommended)</strong>
                            <span className="source-option-desc">Real events from the official Cribl pack{referenceAvailability[effectiveSourcetype].pack ? ` "${referenceAvailability[effectiveSourcetype].pack}"` : ''} — exact vendor format, no AI guessing</span>
                            <span className="source-option-meta">{referenceAvailability[effectiveSourcetype].sampleEvents} real events available</span>
                            {(() => {
                              const fmt = sampleFormats[`ref:${effectiveSourcetype}`];
                              if (fmt === 'busy') return <span className="sample-format-badge sample-format-pending">reading format…</span>;
                              if (!fmt || fmt === 'unknown') return null;
                              return (
                                <span
                                  className={fmt.mixed ? 'sample-format-badge sample-format-mixed' : 'sample-format-badge'}
                                  title={fmt.detail}
                                >{fmt.label}{fmt.mixed ? ' · mixed' : ''}</span>
                              );
                            })()}
                          </div>
                        </div>
                      )}
                      {getAvailableSources(effectiveSourcetype, hasBuiltInSamples(effectiveSourcetype)).map((src) => (
                        <div
                          key={src.id}
                          className={sampleSourceId === src.id ? 'source-option active' : 'source-option'}
                          onClick={() => setSampleSourceId(src.id)}
                        >
                          <span className="source-option-icon">{src.icon}</span>
                          <div className="source-option-text">
                            <strong>{src.label}</strong>
                            <span className="source-option-desc">{src.description}</span>
                            {src.eventCount && <span className="source-option-meta">{src.eventCount} events available</span>}
                          </div>
                        </div>
                      ))}
                    </div>

                    {(sampleSourceId === 'ai-generate' || sampleSourceId === 'hybrid') && multiFormatSpec && (
                      <div className="multi-format-picker">
                        <label style={{ marginTop: 16 }}>Which format does your data use?</label>
                        <p className="gen-tier-note" style={{ marginTop: 4 }}>{multiFormatSpec.note} Pick the one your feed emits so the generated samples match — a wrong guess produces unparseable events.</p>
                        <div className="format-options">
                          {multiFormatSpec.formats.map((f) => (
                            <button
                              key={f.id}
                              className={confirmedFormat === f.id ? 'format-option active' : 'format-option'}
                              onClick={() => setConfirmedFormat(f.id)}
                            >
                              {f.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {(sampleSourceId === 'ai-generate' || sampleSourceId === 'hybrid') && (
                      <>
                        <label style={{ marginTop: 16 }}>AI generation</label>
                        <div className="generate-tiers">
                          <div className="gen-tier active">
                            <span className="gen-tier-icon">{'\u{2728}'}</span>
                            <strong>Quality sample</strong>
                            <span className="gen-tier-desc">A focused, high-fidelity set of diverse events grounded on the real vendor format — event types, severities, and edge cases. Quality over volume.</span>
                            <span className="gen-tier-meta">up to 2 MB</span>
                          </div>
                        </div>
                      </>
                    )}

                    <p className="gen-tier-note">Cribl sample files are capped at 2 MB. Event count is adjusted if the generated data exceeds this limit.</p>
                    <button
                      className="confirm-btn"
                      disabled={!sampleSourceId}
                      onClick={() => sampleSourceId === 'reference' ? fetchReferenceSampleEvents(effectiveSourcetype) : fetchAiSamples(effectiveSourcetype)}
                      style={{ marginTop: 10 }}
                    >
                      {sampleSourceId === 'reference' ? 'Load reference sample' :
                       sampleSourceId === 'built-in' ? 'Load built-in sample' :
                       sampleSourceId === 'ai-generate' ? 'Generate quality sample' :
                       sampleSourceId === 'hybrid' ? 'Fetch & generate quality sample' :
                       sampleSourceId ? 'Fetch sample events' : 'Select a source above'}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Loading indicators */}
            {refSampleLoading && !samplesLoading && (
              <AiProgress messages={[
                'Loading real sample events from reference pack...',
                'Preparing vendor-format events...',
              ]} />
            )}
            {samplesLoading && (
              aiSteps.length > 0
                ? <AiStepProgress steps={aiSteps} />
                : <AiProgress messages={[
                    'Preparing sample generation...',
                  ]} />
            )}
            {state.sourceMode === 'ai-generate' && !samplesLoading && !refSampleLoading && error && (
              <div className="error-box">{error}</div>
            )}

            {/* Preview + sourcetype confirmation */}
            {state.sampleEvents && !samplesLoading && (
              <>
                {sampleRepairNotice && (
                  <div className="sample-repair-notice">
                    <span className="repair-icon">{'\u{1F527}'}</span> {sampleRepairNotice}
                  </div>
                )}
                {/* Sanitise — only for customer-estate samples (upload / paste / live /
                    worker-group). AI-generated and reference/library events are already
                    synthetic or public, so the banner must not appear or nag on those.
                    It sits ABOVE the preview so a real sample is flagged the moment it
                    loads, and folds the "required" warning and the "done" confirmation
                    into one block instead of a loose stack of boxes. */}
                {sampleNeedsSanitising(state.sourceMode) && (() => {
                  const required = !state.sampleSanitised && loadQualitySettings().requireSanitisedSamples;
                  const cls = state.sampleSanitised ? 'sanitise-banner done'
                    : required ? 'sanitise-banner req' : 'sanitise-banner';
                  return (
                    <div className={cls}>
                      <span className="sanitise-banner-icon">{state.sampleSanitised ? '✅' : '\u{1F6E1}\u{FE0F}'}</span>
                      <div className="sanitise-banner-text">
                        <div className="sanitise-banner-title">
                          {state.sampleSanitised ? 'Sample sanitised locally' : 'Sanitize this sample'}
                          {required && <span className="sanitise-banner-chip">Required before AI steps</span>}
                        </div>
                        <div className="sanitise-banner-desc">
                          {state.sampleSanitised
                            ? (isSanitisedLibrarySampleName(existingSampleLabel)
                                ? 'This is a sanitised library sample — its identities were already replaced when it was saved, so there is nothing left to sanitise.'
                                : 'Identities were replaced with consistent stand-ins. Nothing was sent anywhere to do it.')
                            : required
                              ? 'These are real events from your estate, and sending un-sanitised data to the AI provider is turned off — the AI steps will not run until you sanitise. It happens entirely in your browser: no upload, no AI call.'
                              : 'Replace hostnames, usernames and IP addresses with consistent stand-ins — entirely in your browser. No upload, no AI call.'}
                        </div>
                        {/* Action is left-aligned under the text, so it lines up with every
                            other button in the wizard rather than floating off to the right. */}
                        {/* Advisory only: the sanitised events still load and the pack can be
                            built, but they no longer parse cleanly against the source's declared
                            wire format. The user decides — Undo restores the original, or narrow
                            the picks and re-sanitise from the wizard. */}
                        {state.sampleSanitised && sanitiseWarning && (
                          <div className="sanitise-banner-warn">
                            ⚠️ {sanitiseWarning} You can still build with it, or Undo and narrow the picks that changed the format.
                          </div>
                        )}
                        {state.sampleSanitised
                          ? (sanitisePrev !== null && (
                              <button className="btn-link sanitise-banner-action" onClick={undoSanitise}>Undo sanitise</button>
                            ))
                          : (
                            <div className="sanitise-banner-actions">
                              <button className="confirm-btn sanitise-banner-action" onClick={() => setSanitiseModalOpen(true)}
                                title="Replace hostnames, usernames and IP addresses with consistent stand-ins. Runs entirely in your browser — nothing is sent anywhere.">
                                Sanitize sample
                              </button>
                              {/* A worker group also holds samples this app itself put there —
                                  generated or library-derived events with no identities in them.
                                  Sanitising those a second time is pure friction, but the app
                                  cannot prove provenance from a plain sample file, so the escape
                                  is an explicit human assertion rather than a silent default. */}
                              {state.sourceMode === 'existing' && (
                                <button className="btn-link sanitise-banner-action"
                                  onClick={() => update({ sampleSanitised: true })}
                                  title="Use this sample as-is. Only do this for events you know are synthetic or already sanitised — generated samples, reference data, or a sanitised library entry.">
                                  These events are already synthetic — skip
                                </button>
                              )}
                            </div>
                          )}
                      </div>
                    </div>
                  );
                })()}

                <div className="preview-box">
                  <label>
                    Preview ({state.sampleEvents.split('\n').filter(Boolean).length} events)
                    {state.sampleSanitised && <span className="sl-sanitised-badge">sanitised</span>}
                  </label>
                  <textarea readOnly value={state.sampleEvents.split('\n').slice(0, 5).join('\n') + '\n...'} />
                </div>


                {/* What format did we actually get? The pack is built around it, so it
                    is stated explicitly for EVERY sample source — uploaded, pasted,
                    worker-group, reference, vendor or AI-generated. */}
                {(() => {
                  const fmt = describeSampleFormat(state.sampleEvents.split('\n').slice(0, 50));
                  if (fmt.id === 'empty') return null;
                  const variant = multiFormatSpec
                    ? multiFormatSpec.formats.find(f => sampleFormatMatchesVariant(fmt, f.id)) || null
                    : null;
                  const unmatched = !!multiFormatSpec && !variant;
                  // A mixed sample can carry TWO of this source's variants (the Corelight
                  // reference sample is syslog-framed JSON plus Zeek TSV). Building for one
                  // silently drops the others, so name them instead of just saying "mixed".
                  const present = multiFormatSpec && fmt.mixed
                    ? sampleVariantsPresent(state.sampleEvents.split('\n'), multiFormatSpec.formats.map(f => f.id))
                    : [];
                  const presentLabels = present
                    .map(id => multiFormatSpec!.formats.find(f => f.id === id)?.label || id);
                  return (
                    <div className={unmatched || fmt.mixed ? 'sample-format-line sample-format-line-warn' : 'sample-format-line'}>
                      <span className="sample-format-badge">{fmt.label}</span>
                      <span className="sample-format-text">
                        {fmt.detail}
                        {variant && ` This is the “${variant.label}” variant of this source — the pack will be built for it.`}
                        {presentLabels.length > 1 && ` These events carry ${presentLabels.length} of this source's variants (${presentLabels.join(' + ')}) — a pack built for one will not extract the others, so use a single-format sample if you can.`}
                        {unmatched && ` This source also ships as ${multiFormatSpec!.formats.map(f => f.label).join(' / ')}, and these events match none of them — check the sample before building.`}
                      </span>
                    </div>
                  );
                })()}

                {/* Sourcetype detection/confirmation for non-AI modes */}
                {state.sourceMode !== 'ai-generate' && (
                  <div className="field" style={{ marginTop: 16 }}>
                    {detecting && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0' }}>
                        <span className="ai-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                        <span style={{ fontSize: 13, color: '#595959' }}>Detecting sourcetype...</span>
                      </div>
                    )}
                    {detectedSourcetype && !detecting && (
                      <div className="ai-generate-options">
                        <label>Detected sourcetype</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                          <code style={{ fontSize: 15, fontWeight: 600, padding: '4px 10px', background: '#e6fafa', borderRadius: 4 }}>{detectedSourcetype}</code>
                          <span className={`type-badge type-${detectConfidence === 'high' ? 'stream' : detectConfidence === 'medium' ? 'edge' : 'outpost'}`}>{detectConfidence} confidence</span>
                        </div>
                        {detectReason && <p className="gen-tier-note" style={{ marginTop: 0, marginBottom: 12 }}>{detectReason}</p>}
                        {/* Detection already set this as the active sourcetype (canProceedSource
                            is satisfied) — so there is no "Confirm" to press. This row only exists
                            to OVERRIDE it: type a different name and "Use this" commits the change. */}
                        <label style={{ fontSize: 12, color: '#8c8c8c', fontWeight: 400 }}>Not right? Enter the correct sourcetype:</label>
                        <div className="custom-input-row" style={{ marginTop: 6 }}>
                          <div className="custom-input-inline">
                            <input
                              type="text"
                              value={isCustomSourcetype ? customSourcetype : sourcetype}
                              onChange={(e) => { sourcetypeSelectionOrigin.current = 'user'; setCustomSourcetype(e.target.value); setIsCustomSourcetype(true); }}
                              placeholder="Override sourcetype..."
                            />
                            <button
                              className="confirm-btn"
                              disabled={!(isCustomSourcetype ? customSourcetype.trim() : sourcetype)}
                              onClick={() => { sourcetypeSelectionOrigin.current = 'user'; setReductionToggles({}); }}
                            >
                              Use this
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {!detectedSourcetype && !detecting && (
                      <div className="ai-generate-options">
                        <label>Sourcetype could not be auto-detected</label>
                        {detectReason && <p className="gen-tier-note" style={{ marginTop: 0, marginBottom: 10, color: '#d4380d' }}>{detectReason}</p>}
                        {/* The way back after the privacy gate stopped detection. Without this
                            the only route is to retype the sourcetype by hand, which reads as a
                            dead end rather than a step that is now unblocked. */}
                        {state.sampleSanitised && state.sampleEvents.trim() && (
                          <button className="btn-secondary" style={{ marginBottom: 10 }}
                            onClick={() => detectSourcetype(state.sampleEvents, { sanitised: true })}>
                            Detect sourcetype now the sample is sanitised
                          </button>
                        )}
                        <p className="gen-tier-note" style={{ marginTop: 0, marginBottom: 10 }}>Enter the sourcetype manually:</p>
                        <div className="custom-input-inline">
                          <input
                            type="text"
                            value={customSourcetype}
                              onChange={(e) => { sourcetypeSelectionOrigin.current = 'user'; setCustomSourcetype(e.target.value); setIsCustomSourcetype(true); setStMatches([]); setValidationHint(''); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' && customSourcetype.trim()) validateSourcetype(customSourcetype); }}
                            placeholder="e.g. cisco_asa, palo_alto_traffic"
                            disabled={validating}
                          />
                          <button
                            className="confirm-btn"
                            disabled={!customSourcetype.trim() || validating}
                            onClick={() => { setIsCustomSourcetype(true); setReductionToggles({}); void validateSourcetype(customSourcetype); }}
                          >
                            {validating ? 'Checking...' : 'Confirm'}
                          </button>
                        </div>
                        {validationHint && <p className="gen-tier-note" style={{ marginTop: 8, marginBottom: 0 }}>{validationHint}</p>}
                        {!validating && stMatches.length > 0 && (
                          <div className="st-search-matches">
                            <span className="st-search-label">Pick a supported sourcetype to use it directly, or refine the name yourself and Confirm again:</span>
                            <div className="st-search-list">
                              {stMatches.map((m) => (
                                <button
                                  key={m.name}
                                  className={m.name === customSourcetype ? 'st-search-item active' : 'st-search-item'}
                                  title={m.description || m.name}
                                  onClick={() => { setCustomSourcetype(m.name); setIsCustomSourcetype(true); setReductionToggles({}); setStMatches([]); setValidationHint(''); applyRecognition(m.name); setCustomConfirmed(true); }}
                                >
                                  {m.golden && <span className="st-search-star">{'★'}</span>}
                                  <span className="st-search-name">{m.name}</span>
                                  {m.description && <span className="st-search-desc">{m.description}</span>}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {(packMode === 'experiment' || packMode === 'flow' || packMode === 'add-pipeline') && canProceedSource && (
              <div className="code-function-toggle" style={{ marginTop: 16 }}>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={allowCodeFunctions}
                    onChange={(e) => setAllowCodeFunctions(e.target.checked)}
                  />
                  <span className="toggle-switch" />
                  <div className="option-info">
                    <strong>Allow Code functions</strong>
                    <span>{allowCodeFunctions
                      ? 'Enabled — the parser may use a JavaScript Code function for complex parsing (e.g. Windows XML EventData). Off by default.'
                      : 'Disabled — the pipeline uses only regex / eval / serde (recommended). Enable only if a source needs Code-function parsing.'}</span>
                  </div>
                </label>
              </div>
            )}

            <StepNav>
              <button className="back" onClick={() => setStep(step === 'optimize-sample' ? 'optimize-goals' : packMode === 'flow' ? 'select-group' : packMode === 'experiment' ? 'name' : 'select-action')}>Back</button>
              <button disabled={!canProceedSource} onClick={() => {
                setStep(step === 'optimize-sample' ? 'optimize-running' : 'destination');
              }}>
                {step === 'optimize-sample' ? 'Review Improvements' : packMode === 'flow' ? 'Next: Flow' : 'Next: Destination Format'}
              </button>
            </StepNav>
          </div>
        );
      }

      case 'optimize-running': {
        const phaseLabel = optimizePhase === 'scoring'
          ? 'Phase 1 — Scoring current pipeline'
          : optimizePhase === 'optimizing'
            ? 'Phase 2 — Improving pipeline'
            : 'Ready to Improve';
        const statusLine = optimizeStatus
          || (optimizeBusy
            ? (optimizePhase === 'scoring' ? 'Working on the baseline score…' : 'Working on improvements…')
            : '');
        return (
          <div className="step">
            <h2>{optimizeBusy ? phaseLabel : 'Ready to Improve'}</h2>
            <p className="step-desc">
              Two phases: first the live pipeline is scored (extraction + mapping, with total = their average).
              Then each selected goal is improved and scored with the same stage metrics — this can take a few minutes.
            </p>
            <div className="review-grid">
              <div className="review-item"><span>Pack</span><code>{selectedPackId}</code></div>
              <div className="review-item"><span>Pipeline</span><code>{optimizePipelineId}</code></div>
              <div className="review-item"><span>Destination</span><code>{(() => {
                const fam = state.destFormats[0];
                const label = DEST_OPTIONS.find(d => d.value === fam)?.label || fam || optimizeDestCtx.destFormat;
                if (fam === 'sentinel') return `${label} → ${state.sentinelTable || 'table'}`;
                if (fam === 'cim') return `${label} → ${(state.cimModel || 'model').replace(/_/g, ' ')}`;
                if (fam === 'asim') {
                  const sch = (!state.asimSchema || state.asimSchema === 'auto') ? 'auto' : state.asimSchema;
                  return `${label} → ${sch}`;
                }
                if (fam === 'ocsf') {
                  const sch = (!state.ocsfSchema || state.ocsfSchema === 'auto') ? 'auto' : state.ocsfSchema;
                  const opt = ocsfSchemaOptions().find(o => o.key === sch);
                  return `${label} → ${opt ? opt.label : sch}`;
                }
                return label;
              })()}</code></div>
              <div className="review-item"><span>Goals</span><strong>{Object.entries(optimizeGoals).filter(([, enabled]) => enabled).map(([goal]) => goal).join(', ')}</strong></div>
              {optimizeGuidance && <div className="review-item"><span>Guidance</span><strong>{optimizeGuidance}</strong></div>}
            </div>
            {optimizeBusy && (
              <div className="optimize-progress" role="status" aria-live="polite">
                <GoatBar label={phaseLabel} />
                <ol className="optimize-progress-steps">
                  <li className={optimizePhase === 'scoring' ? 'active' : (optimizePhase === 'optimizing' || optimizeScores ? 'done' : '')}>
                    <strong>1. Score baseline</strong>
                    <span>Preview + extraction score + mapping score → total average</span>
                  </li>
                  <li className={optimizePhase === 'optimizing' ? 'active' : ''}>
                    <strong>2. Improve selected stages</strong>
                    <span>Try a better candidate per goal, keep only if it beats the baseline</span>
                  </li>
                </ol>
                {statusLine && <div className="optimize-progress-now">{statusLine}</div>}
              </div>
            )}
            {renderOptimizeScoreReport()}
            {optimizeLog.length > 0 && (
              <div className="deploy-log">
                {optimizeLog.map((line, index) => <div key={index}>{line}</div>)}
              </div>
            )}
            {optimizeError && <div className="error-box">{optimizeError}</div>}
            <StepNav>
              <button className="back" disabled={optimizeBusy} onClick={() => setStep(optimizeGoals.sample ? 'optimize-sample' : 'optimize-goals')}>Back</button>
              <button disabled={optimizeBusy} onClick={() => void runOptimizePipeline()}>
                {optimizeBusy
                  ? (optimizePhase === 'scoring' ? 'Scoring…' : 'Improving…')
                  : optimizeError ? 'Try Again' : 'Score & Improve'}
              </button>
            </StepNav>
          </div>
        );
      }

      case 'optimize-done': {
        return (
          <div className="step">
            <h2>Improvement Complete</h2>
            <p className="step-desc">{optimizeScores?.changed
              ? 'The improved pipeline or updated sample has been committed and deployed. Compare before/after samples and the changes below.'
              : 'No candidate beat the deployed baseline, so no pipeline change was committed. The before report still shows how the live pipeline scores today.'}</p>
            {optimizeResults.filter(r => r.guidanceNote).map(r => (
              <div key={`guidance-${r.stage}`} className="advice-box">{r.guidanceNote}</div>
            ))}
            {renderOptimizeScoreReport()}
            {optimizeResults.length === 0 && (
              <div className="advice-box">No stage produced a better candidate than the baseline — before and after stay the same.</div>
            )}
            {optimizeLog.length > 0 && (
              <div className="deploy-log">
                {optimizeLog.map((line, index) => <div key={index}>{line}</div>)}
              </div>
            )}
            <StepNav>
              {optimizeScores && (
                <button className="btn-secondary" onClick={downloadImproveReport} title="Download this before/after result as a standalone HTML report">⬇ Download report</button>
              )}
              <button onClick={() => setStep('mode')}>Return Home</button>
            </StepNav>
          </div>
        );
      }

      case 'destination': {
        // Independent bottom selectors, each shown only when its format is picked.
        // Recommendation PILLS from the sourcetype live inside these selectors
        // (not on the page); the user clicks one to choose the table / model.
        const sentinelSelected = state.destFormats.includes('sentinel');
        const cimSelected = state.destFormats.includes('cim');
        const asimSelected = state.destFormats.includes('asim');
        const ocsfSelected = state.destFormats.includes('ocsf');
        const xsiamSelected = state.destFormats.includes('xsiam');
        const xsiamResolution = xsiamSelected && effectiveSourcetype
          ? resolveXsiamForBuild(effectiveSourcetype, state.sampleEvents)
          : null;
        const xsiamRequiredFormat = xsiamResolution?.requiredInputFormat || null;
        const xsiamDetectedFormat = xsiamSelected ? classifyXsiamSampleFormat(state.sampleEvents) : null;
        const xsiamFormatBlocked = xsiamRequiredFormat?.enforcement === 'fail'
          && xsiamDetectedFormat !== xsiamRequiredFormat.format;
        const sentinelRecs = effectiveSourcetype ? sentinelDestinationSuggestions(effectiveSourcetype) : [];
        const cimRecs = effectiveSourcetype ? cimModelPickerOptions(effectiveSourcetype) : [];
        const cimSuggested = effectiveSourcetype ? new Set(cimModelSuggestions(effectiveSourcetype)) : new Set<string>();
        const asimOpts = asimSchemaOptions();
        const ocsfOpts = ocsfSchemaOptions();
        // Recommended ASIM schema = the concrete asim#<dataClass> the sourcetype +
        // sample resolve to (the "sourcetype-sample advice"). Falls back to network.
        const asimRecommended = effectiveSourcetype
          ? concretizeAsimFormat('asim', effectiveSourcetype, state.sampleEvents)
          : 'asim';
        const ocsfRecommended = effectiveSourcetype
          ? concretizeOcsfFormat('ocsf', effectiveSourcetype, state.sampleEvents)
          : 'ocsf#network';
        if (sentinelSelected && !state.sentinelTable && sentinelRecs.length) setTimeout(() => update({ sentinelTable: sentinelRecs[0] }), 0);
        if (cimSelected && !state.cimModel && cimRecs.length) setTimeout(() => update({ cimModel: cimRecs[0] }), 0);
        if (asimSelected && !state.asimSchema) setTimeout(() => update({ asimSchema: 'auto' }), 0);
        if (ocsfSelected && !state.ocsfSchema) setTimeout(() => update({ ocsfSchema: 'auto' }), 0);
        return (
          <div className="step">
            {packMode === 'flow' ? (
              <>
                <h2>Name the pack and choose where the data goes</h2>
                <p className="step-desc">Add each destination. Every format becomes a pipeline in the pack; OCSF can feed post-processing packs for more SIEMs. The main pack is never optimized; only post-processing outputs set to “Optimize by category” are.</p>
                <FlowDestination
                  sourcetype={effectiveSourcetype}
                  sampleEvents={state.sampleEvents}
                  eventCount={state.sampleEvents.split('\n').filter(l => l.trim()).length}
                  destOptions={FLOW_DEST_OPTIONS}
                  destFormats={state.destFormats}
                  onAddDests={(fmts) => {
                    // One update for the whole batch: the picker adds several at once,
                    // and separate update() calls would each start from the same state.
                    const added = fmts.filter(f => !state.destFormats.includes(f as DestFormat)) as DestFormat[];
                    if (!added.length) return;
                    const next = [...state.destFormats, ...added];
                    const patch: Record<string, any> = { destFormats: next, destFormat: next[0] as DestFormat };
                    for (const fmt of added) {
                      if (fmt === 'sentinel' && !state.sentinelTable && sentinelRecs.length) patch.sentinelTable = sentinelRecs[0];
                      if (fmt === 'cim' && !state.cimModel && cimRecs.length) patch.cimModel = cimRecs[0];
                      if (fmt === 'asim' && !state.asimSchema) patch.asimSchema = 'auto';
                      if (fmt === 'ocsf' && !state.ocsfSchema) patch.ocsfSchema = 'auto';
                    }
                    update(patch);
                  }}
                  onRemoveDest={(fmt) => {
                    const next = state.destFormats.filter(f => f !== fmt);
                    update({ destFormats: next, destFormat: (next[0] as DestFormat) || '' as DestFormat });
                  }}
                  optimize={flowOptimize}
                  onOptimize={(fmt, v) => setFlowOptimize(o => ({ ...o, [fmt]: v }))}
                  srcRules={flowSrcRules}
                  onSrcRule={(id, v) => setFlowSrcRules(r => ({ ...r, [id]: v }))}
                  ocsfKeepRaw={flowOcsfKeepRaw}
                  onOcsfKeepRaw={setFlowOcsfKeepRaw}
                  pp={flowPp}
                  onPpChange={setFlowPp}
                  defaultPpName={flowSourceLabel(effectiveSourcetype)}
                  pack={{
                    name: state.packName, group: selectedGroup || state.workerGroup,
                    existing: existingPacks, loading: packsLoading, overwrite: flowOverwrite,
                    onName: v => { setFlowNameEdited(true); update({ packName: v }); }, onOverwrite: setFlowOverwrite,
                    defaultName: flowAutoName, onResetName: () => { setFlowNameEdited(false); setFlowOverwrite(false); },
                    ppOverwrite: flowPpOverwrite, onPpOverwrite: setFlowPpOverwrite,
                  }}
                  models={Object.fromEntries(state.destFormats.map(f => [f, flowModelPick(f, {
                    sentinelTables: sentinelRecs, cimModels: cimRecs, cimSuggested,
                    asim: asimOpts, asimRecommended, ocsf: ocsfOpts, ocsfRecommended,
                  })]))}
                  modelValues={{ sentinelTable: state.sentinelTable, cimModel: state.cimModel, asimSchema: state.asimSchema, ocsfSchema: state.ocsfSchema }}
                  onModel={(field, v) => update({ [field]: v })}
                />
                {state.destFormats.length > 0 && (
                  <div className="fd-summary">
                    <div className="h">What will be built</div>
                    {flowSummary({ sourcetype: effectiveSourcetype, destFormats: state.destFormats, optimize: flowOptimize, ocsfKeepRaw: flowOcsfKeepRaw, pp: flowPp }).map((l, i) => <p key={i}>{l}</p>)}
                  </div>
                )}
              </>
            ) : (<>
            <h2>Destination Format</h2>
            <p className="step-desc">Select one or more output schemas. Each selected format creates its own pipeline in the pack.</p>
            <div className="dest-grid">
              {DEST_OPTIONS.map((opt) => {
                const isSelected = state.destFormats.includes(opt.value);
                return (
                  <div
                    key={opt.value}
                    className={`dest-card${opt.value === 'sentinel' ? ' dest-card-sentinel' : ''}${opt.value === 'manual' ? ' dest-card-custom' : ''}${isSelected ? ' active' : ''}`}
                    onClick={() => {
                      const next = isSelected
                        ? state.destFormats.filter(f => f !== opt.value)
                        : [...state.destFormats, opt.value];
                      const patch: Record<string, any> = { destFormats: next, destFormat: (next[0] as DestFormat) || '' as DestFormat };
                      if (!isSelected && opt.value === 'sentinel' && !state.sentinelTable && sentinelRecs.length) patch.sentinelTable = sentinelRecs[0];
                      if (!isSelected && opt.value === 'cim' && !state.cimModel && cimRecs.length) patch.cimModel = cimRecs[0];
                      if (!isSelected && opt.value === 'asim' && !state.asimSchema) patch.asimSchema = 'auto';
                      if (!isSelected && opt.value === 'ocsf' && !state.ocsfSchema) patch.ocsfSchema = 'auto';
                      update(patch);
                    }}
                  >
                    {isSelected && <span className="dest-check">✓</span>}
                    {opt.value === 'manual' && <span className="dest-custom-icon">✏️</span>}
                    <strong>{opt.label}</strong>
                    <span>{opt.description}</span>
                  </div>
                );
              })}
            </div>
            {state.destFormats.length > 1 && (
              <p className="step-desc" style={{ marginTop: 8 }}>
                <strong>{state.destFormats.length} formats selected</strong> — {state.destFormats.length} pipelines will be created in the pack.
              </p>
            )}
            </>)}
            {/* Bottom selectors — auto-defaults to first recommendation; user can override.
                Build pack flow picks these inside each destination card instead. */}
            {sentinelSelected && packMode !== 'flow' && (
              <div className="dest-suboption dest-suboption-sentinel">
                <div className="dest-suboption-head">
                  <strong>Microsoft Sentinel — recommended table for {effectiveSourcetype}</strong>
                  {state.sentinelTable && <span className="dest-suboption-chosen">✓ {state.sentinelTable} · {resolveSentinelTable(state.sentinelTable)?.table.columns.length || 0} columns</span>}
                </div>
                <div className="dest-suboption-btns">
                  {sentinelRecs.map(tbl => (
                    <button key={tbl} className={`dest-pill${state.sentinelTable === tbl ? ' active' : ''}`}
                      onClick={() => update({ sentinelTable: tbl })}>{tbl}</button>
                  ))}
                </div>
              </div>
            )}
            {cimSelected && packMode !== 'flow' && (
              <div className="dest-suboption dest-suboption-cim">
                <div className="dest-suboption-head">
                  <strong>Splunk CIM — data model for {effectiveSourcetype}</strong>
                  {state.cimModel && <span className="dest-suboption-chosen">✓ {state.cimModel.replace(/_/g, ' ')}</span>}
                </div>
                <div className="dest-suboption-btns">
                  {cimRecs.map(m => (
                    <button key={m} className={`dest-pill${state.cimModel === m ? ' active' : ''}${cimSuggested.has(m) ? ' dest-pill-recommended' : ''}`}
                      title={cimSuggested.has(m) ? 'Recommended for this source' : undefined}
                      onClick={() => update({ cimModel: m })}>{m.replace(/_/g, ' ')}{cimSuggested.has(m) ? ' ★' : ''}</button>
                  ))}
                </div>
              </div>
            )}
            {asimSelected && packMode !== 'flow' && (
              <div className="dest-suboption dest-suboption-sentinel">
                <div className="dest-suboption-head">
                  <strong>Microsoft Sentinel ASIM — schema for {effectiveSourcetype}</strong>
                  {(() => {
                    const chosen = (!state.asimSchema || state.asimSchema === 'auto') ? asimRecommended : state.asimSchema;
                    const opt = asimOpts.find(o => o.key === chosen);
                    return <span className="dest-suboption-chosen">✓ {opt?.table || 'ASimNetworkSessionLogs'}{(!state.asimSchema || state.asimSchema === 'auto') ? ' · auto from data' : ''}</span>;
                  })()}
                </div>
                <div className="dest-suboption-btns">
                  <button className={`dest-pill${(!state.asimSchema || state.asimSchema === 'auto') ? ' active' : ''}`}
                    onClick={() => update({ asimSchema: 'auto' })}
                    title="Pick the ASIM schema automatically from the sourcetype and sample data class">
                    Auto{asimRecommended !== 'asim' ? ` (${asimOpts.find(o => o.key === asimRecommended)?.label || 'Network'})` : ' (Network)'}
                  </button>
                  {asimOpts.map(o => (
                    <button key={o.key} className={`dest-pill${state.asimSchema === o.key ? ' active' : ''}`}
                      onClick={() => update({ asimSchema: o.key })}
                      title={o.table}>
                      {o.label}{o.key === asimRecommended ? ' ★' : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {ocsfSelected && packMode !== 'flow' && (
              <div className="dest-suboption dest-suboption-cim">
                <div className="dest-suboption-head">
                  <strong>OCSF — class for {effectiveSourcetype}</strong>
                  {(() => {
                    const chosen = (!state.ocsfSchema || state.ocsfSchema === 'auto') ? ocsfRecommended : state.ocsfSchema;
                    const ocsfKey = chosen.startsWith('nextgen#') ? `ocsf#${chosen.slice('nextgen#'.length)}` : chosen === 'nextgen' || chosen === 'ocsf' ? 'ocsf#network' : chosen;
                    const opt = ocsfOpts.find(o => o.key === ocsfKey);
                    return <span className="dest-suboption-chosen">✓ {opt ? `${opt.label} (${opt.classUid})` : chosen}{(!state.ocsfSchema || state.ocsfSchema === 'auto') ? ' · auto from data' : ''}</span>;
                  })()}
                </div>
                <div className="dest-suboption-btns">
                  <button className={`dest-pill${(!state.ocsfSchema || state.ocsfSchema === 'auto') ? ' active' : ''}`}
                    onClick={() => update({ ocsfSchema: 'auto' })}
                    title="Pick the OCSF class automatically from the sourcetype and sample data class">
                    Auto{(() => {
                      const k = ocsfRecommended.startsWith('nextgen#') ? `ocsf#${ocsfRecommended.slice('nextgen#'.length)}` : ocsfRecommended === 'nextgen' || ocsfRecommended === 'ocsf' ? 'ocsf#network' : ocsfRecommended;
                      const opt = ocsfOpts.find(o => o.key === k);
                      return opt ? ` (${opt.label})` : '';
                    })()}
                  </button>
                  {ocsfOpts.map(o => (
                    <button key={o.key} className={`dest-pill${state.ocsfSchema === o.key ? ' active' : ''}`}
                      onClick={() => update({ ocsfSchema: o.key })}
                      title={`class_uid ${o.classUid}`}>
                      {o.label}{(() => {
                        const rec = ocsfRecommended.startsWith('nextgen#') ? `ocsf#${ocsfRecommended.slice('nextgen#'.length)}` : ocsfRecommended;
                        return o.key === rec ? ' ★' : '';
                      })()}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {xsiamSelected && xsiamRequiredFormat && (
              <div className="dest-suboption dest-suboption-sentinel">
                <div className="dest-suboption-head">
                  <strong>Cortex XSIAM — required input format for {effectiveSourcetype}</strong>
                  <span className="dest-suboption-chosen">
                    {xsiamFormatBlocked
                      ? `Required ${xsiamRequiredFormat.format.toUpperCase()} · current sample is ${(xsiamDetectedFormat || 'unknown').toUpperCase()}`
                      : `✓ ${(xsiamDetectedFormat || xsiamRequiredFormat.format).toUpperCase()} sample selected`}
                  </span>
                </div>
                <p className="field-hint" style={{ marginTop: 6 }}>
                  XSIAM parses this vendor format natively; the pipeline preserves <code>_raw</code>.
                  {' '}{xsiamRequiredFormat.evidence}
                </p>
                {xsiamRequiredFormat.format === 'cef' && xsiamFormatBlocked && (
                  <button
                    className="dest-pill dest-pill-recommended"
                    disabled={refSampleLoading}
                    onClick={() => void fetchReferenceSampleEvents(effectiveSourcetype, 'cef')}
                  >
                    {refSampleLoading ? 'Loading CEF sample…' : 'Use XSIAM CEF sample ★'}
                  </button>
                )}
              </div>
            )}
            <StepNav>
              <button className="back" onClick={() => setStep('source')}>Back</button>
              {(() => {
                // Each selector must be completed before Next: Sentinel needs a
                // table, CIM needs a model.
                const blocked = state.destFormats.length === 0
                  || (sentinelSelected && !state.sentinelTable)
                  || (cimSelected && !state.cimModel)
                  || (asimSelected && !state.asimSchema)
                  || (ocsfSelected && !state.ocsfSchema)
                  || xsiamFormatBlocked;
                // Resolve the FIRST selected format to a concrete build format:
                // 'sentinel'→chosen table (CSL→'commonsecuritylog' golden path).
                const firstDest = resolveDestFmt(state.destFormats[0], state);
                if (packMode === 'experiment' || packMode === 'flow') {
                  const flowBlock = packMode === 'flow'
                    ? flowPackCheck(state.packName, existingPacks, flowOverwrite).blocked
                      || ppPackCheck(flowPp.name, effectiveSourcetype, state.destFormats, flowPp, existingPacks, flowPpOverwrite).blocked
                      || flowBlockedReason(state.destFormats, flowPp)
                    : null;
                  return (
                    <>
                      {flowBlock && <span className="step-desc" role="status">{flowBlock}</span>}
                      {/* Flow has no Review step: Build pack starts the staged build,
                          whose screen opens with the short summary. */}
                      <button disabled={blocked || !!flowBlock || (packMode === 'flow' && packsLoading)} onClick={() => {
                        update({ destFormat: firstDest as DestFormat });
                        if (packMode === 'flow') void startExperiment();
                        else setStep('experiment-setup');
                      }}>
                        {packMode === 'flow' ? 'Build pack' : 'Next: Build plan'}
                      </button>
                    </>
                  );
                }
                return (
                  <button disabled={blocked} onClick={() => { fetchAiAdvice(); setStep('ai-analysis'); }}>
                    Next: AI Analysis
                  </button>
                );
              })()}
            </StepNav>
          </div>
        );
      }

      case 'ai-analysis':
        return (
          <div className="step">
            <h2>AI Pipeline Analysis</h2>
            <p className="step-desc">AI is analyzing the best approach for <strong>{SOURCETYPES.find(s => s.value === effectiveSourcetype)?.label || effectiveSourcetype}</strong> → <strong>{state.destFormat === 'manual' ? state.manualFormat : DEST_OPTIONS.find(d => d.value === state.destFormat)?.label}</strong></p>

            {aiLoading && (
              aiAnalysisSteps.length > 0
                ? <AiStepProgress steps={aiAnalysisSteps} />
                : <AiProgress messages={['Starting analysis...']} />
            )}

            {aiError && (
              <div className="advice-box">
                <strong>AI analysis unavailable:</strong> {aiError}
                <p style={{ marginTop: 8, fontSize: 12, color: '#595959' }}>You can still proceed — the pipeline will be generated using built-in rules without AI recommendations.</p>
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  {!aiAvailable() && (
                    <button className="generate-btn" onClick={() => openToolLink('configure-ai')}>Configure AI</button>
                  )}
                  <button className="generate-btn" onClick={() => fetchAiAdvice()}>Retry</button>
                  <button className="confirm-btn" onClick={() => setStep('options')}>Skip &amp; continue</button>
                </div>
              </div>
            )}

            {sampleSchemaAdvice && (() => {
              const rec = sampleSchemaAdvice;
              const recLabel = DEST_OPTIONS.find(d => d.value === rec.primary)?.label || rec.primary.toUpperCase();
              const chosen = (state.destFormats.length > 0 ? state.destFormats : [state.destFormat]).map(f => resolveDestFmt(f, state));
              const chosenLabels = chosen.map(f => DEST_OPTIONS.find(d => d.value === f)?.label || f.toUpperCase()).join(', ');
              const already = state.destFormats.includes(rec.primary as DestFormat);
              return (
                <div className="advice-box" style={{ borderLeft: '3px solid #d48806', background: '#fffbe6' }}>
                  <strong>💡 Sample-based schema suggestion</strong>
                  <p style={{ marginTop: 6 }}>
                    Your sample looks like <strong>{rec.dataClass.replace('_', ' ')}</strong> data
                    {' '}(≈{Math.round(rec.inference.confidence * 100)}% confidence, OCSF {rec.ocsfClass}).
                    Based on the events themselves, <strong>{recLabel}</strong> may fit better than your current choice ({chosenLabels}).
                  </p>
                  {rec.inference.signals.length > 0 && (
                    <p style={{ marginTop: 4, fontSize: 12, color: '#595959' }}>
                      Signals: {rec.inference.signals.slice(0, 3).join('; ')}
                    </p>
                  )}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    {!already && (
                      <button className="generate-btn" onClick={() => {
                        const nextFormats = [...state.destFormats.filter(f => f !== rec.primary), rec.primary as DestFormat];
                        setState(s => ({ ...s, destFormats: nextFormats }));
                        setSampleSchemaAdvice(null);
                        fetchAiAdvice(nextFormats);
                      }}>Add {recLabel}</button>
                    )}
                    <button className="confirm-btn" onClick={() => setSampleSchemaAdvice(null)}>Keep my choice</button>
                  </div>
                </div>
              );
            })()}

            {aiAdvice && (
              <div className="ai-advice">
                <div className="ai-section">
                  <strong>Summary</strong>
                  <p>{aiAdvice.summary}</p>
                </div>

                <div className="ai-section">
                  <strong>Parse Strategy</strong>
                  <p>{aiAdvice.parseStrategy}</p>
                </div>

                <div className="ai-section">
                  <strong>Mapping Notes</strong>
                  <p>{aiAdvice.mappingNotes}</p>
                </div>

                {aiAdvice.pipelineSteps.length > 0 && (
                  <div className="ai-section">
                    <strong>Recommended Pipeline Steps</strong>
                    <ol className="ai-steps">
                      {aiAdvice.pipelineSteps.map((step, i) => <li key={i}>{step}</li>)}
                    </ol>
                  </div>
                )}

                {aiAdvice.reductionOpportunities.length > 0 && (
                  <div className="ai-section">
                    <strong>Reduction Opportunities</strong>
                    <ul className="ai-list">
                      {aiAdvice.reductionOpportunities.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}

                {aiAdvice.risks.length > 0 && (
                  <div className="ai-section ai-risks">
                    <strong>Risks & Gotchas</strong>
                    <ul className="ai-list">
                      {aiAdvice.risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}

                {Object.keys(aiMappingsPerFormat).length > 0 && (
                  <div className="ai-section ai-mappings-info">
                    <strong>Pipelines — one per destination ({Object.keys(aiMappingsPerFormat).length})</strong>
                    <div className="pipe-report-grid">
                      {Object.entries(aiMappingsPerFormat).map(([fmt, m]) => {
                        const label = DEST_OPTIONS.find(d => d.value === fmt)?.label || fmt;
                        const pid = getPipelineId(effectiveSourcetype, fmt);
                        if (!m) return (
                          <div key={fmt} className="pipe-report pipe-report-fail">
                            <div className="pipe-report-head"><span className="pipe-report-name">{label}</span><span className="fmt-status fmt-fail">unavailable</span></div>
                            <code className="pipe-report-id">{pid}</code>
                          </div>
                        );
                        const top = m.mappings.slice(0, 4);
                        return (
                          <div key={fmt} className="pipe-report">
                            <div className="pipe-report-head"><span className="pipe-report-name">{label}</span><span className="fmt-status">{m.mappings.length} fields</span></div>
                            <code className="pipe-report-id">{pid}</code>
                            <div className="pipe-report-fields">
                              {top.map((mp, j) => <span key={j} className="pipe-field"><b>{mp.destField}</b> ← {mp.expression.length > 28 ? mp.expression.slice(0, 25) + '…' : mp.expression}</span>)}
                              {m.mappings.length > 4 && <span className="pipe-field pipe-field-more">+{m.mappings.length - 4} more</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {aiMappings && Object.keys(aiMappingsPerFormat).length === 0 && (
                  <div className="ai-section ai-mappings-info">
                    <strong>Field Mappings</strong>
                    <p>{aiMappings.mappings.length} field mappings generated from your sample data.</p>
                  </div>
                )}
              </div>
            )}

            <StepNav>
              <button className="back" onClick={() => setStep('destination')}>Back</button>
              <button
                disabled={aiLoading}
                onClick={() => setStep('options')}
              >
                {aiAdvice ? 'Next: Pipeline Options' : aiLoading ? 'Analyzing...' : 'Skip & Continue'}
              </button>
            </StepNav>
          </div>
        );

      case 'options':
        return (
          <div className="step">
            <h2>Pipeline Options</h2>
            <p className="step-desc">Destination output settings. Event reduction is available only in the OCSF Post-Processing flow, where rules operate on normalized OCSF fields.</p>

            {isCimFormat(state.destFormat) && (
              <div className="options-list" style={{ marginTop: 12 }}>
                <div className="option-row">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={reductionToggles['cim_keep_unmapped'] ?? true}
                      onChange={(e) => setReductionToggles((prev) => ({ ...prev, cim_keep_unmapped: e.target.checked }))}
                    />
                    <span className="toggle-switch" />
                    <div className="option-info">
                      <strong>Keep unmapped source fields in _raw</strong>
                      <span>Preserve extracted fields that have no CIM mapping inside the rebuilt _raw JSON, so no source data is lost. Turn off for a strict CIM-only _raw.</span>
                    </div>
                  </label>
                </div>
                <div className="option-row">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={reductionToggles['cim_flat'] ?? false}
                      onChange={(e) => setReductionToggles((prev) => ({ ...prev, cim_flat: e.target.checked }))}
                    />
                    <span className="toggle-switch" />
                    <div className="option-info">
                      <strong>Emit CIM fields as top-level (flat) fields</strong>
                      <span>Output the mapped CIM fields as indexed top-level fields instead of the default Splunk-HEC shape (metadata top-level, fields folded into _raw JSON). Use for destinations that index flat fields directly.</span>
                    </div>
                  </label>
                </div>
              </div>
            )}

            <div className="advice-box">
              <strong>OCSF optimization:</strong> Use Post-Processing to apply reviewed OCSF-field rules. Raw sourcetype-specific reduction rules are no longer generated.
            </div>

            <StepNav>
              <button className="back" onClick={() => setStep('ai-analysis')}>Back</button>
              <button onClick={() => setStep('review')}>Review &amp; Deploy</button>
            </StepNav>
          </div>
        );

      case 'review':
        return (
          <div className="step">
            <h2>Review</h2>
            <div className="review-grid">
              <div className="review-item"><span>Pack ID</span><code>{packMode === 'add-pipeline' ? selectedPackId : packId}</code></div>
              <div className="review-item"><span>{state.destFormats.length > 1 ? 'Pipelines' : 'Pipeline'}</span><code>{state.destFormats.map(f => getPipelineId(effectiveSourcetype, f)).join(', ')}</code></div>
              <div className="review-item"><span>Worker Group</span><code>{packMode === 'add-pipeline' ? selectedGroup : state.workerGroup}</code></div>
              <div className="review-item"><span>Sourcetype</span><code>{SOURCETYPES.find(s => s.value === effectiveSourcetype)?.label || effectiveSourcetype}</code></div>
              <div className="review-item"><span>Sample Source</span><code>{
                state.sourceMode === 'upload' ? 'Uploaded file'
                : state.sourceMode === 'existing' ? (existingSampleLabel ? `Worker group: ${existingSampleLabel}` : 'Worker group sample')
                : state.sourceMode === 'paste' ? 'Pasted events'
                : state.sourceMode === 'live-capture' ? 'Live capture'
                : sampleSourceId === 'reference' ? 'Reference sample (from pack)'
                : sampleSourceId === 'built-in' ? 'Built-in sample (no AI)'
                : sampleSourceId === 'hybrid' ? 'Hybrid: public + AI (quality sample)'
                : (sampleSourceId && sampleSourceId !== 'ai-generate') ? 'Public dataset'
                : 'AI-generated (quality sample)'
              }</code></div>
              <div className="review-item"><span>Sample in pack</span><code>Yes — included automatically</code></div>
              <div className="review-item"><span>{state.destFormats.length > 1 ? 'Destinations' : 'Destination'}</span><code>{state.destFormats.map(f => f === 'sentinel' ? (state.sentinelTable || 'Sentinel') : f === 'manual' ? state.manualFormat : DEST_OPTIONS.find(d => d.value === f)?.label).join(', ')}</code></div>
              <div className="review-item"><span>Sample Events</span><code>{state.sampleEvents.split('\n').filter(Boolean).length} events</code></div>
              <div className="review-item"><span>Optimization</span><code>OCSF Post-Processing only</code></div>
            </div>
            <div className="field">
              <label>Route Filter <span className="hint">(which events should this pipeline process?)</span></label>
              <input
                type="text"
                value={state.routeFilter}
                onChange={(e) => update({ routeFilter: e.target.value })}
                placeholder={`sourcetype=='${effectiveSourcetype}'`}
              />
              <p className="step-desc" style={{ marginTop: 6, marginBottom: 0 }}>
                Default: <code>{`sourcetype=='${effectiveSourcetype}'`}</code>
              </p>
            </div>
            <div className="code-function-toggle">
              <label className="slider-label">
                <span className="slider-text">
                  <strong>Allow Code functions</strong>
                  <span className="slider-hint">{allowCodeFunctions
                    ? 'Code functions enabled — uses JavaScript for complex parsing (e.g. XML EventData extraction)'
                    : 'Code functions disabled — pipeline will use only regex/eval/serde (some parsing may be limited)'
                  }</span>
                </span>
                <input
                  type="checkbox"
                  checked={allowCodeFunctions}
                  onChange={(e) => setAllowCodeFunctions(e.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>
            <div className="code-function-toggle">
              <label className="slider-label">
                <span className="slider-text">
                  <strong>Create Datagen source</strong>
                  <span className="slider-hint">{createDatagen
                    ? 'A datagen source will be created using the sample data — disabled by default, enable in Cribl UI to generate test events'
                    : 'No datagen source — pack will only contain the pipeline and route'
                  }</span>
                </span>
                <input
                  type="checkbox"
                  checked={createDatagen}
                  onChange={(e) => setCreateDatagen(e.target.checked)}
                />
                <span className="slider" />
              </label>
              {createDatagen && (
                <div className="warning-box">
                  <strong>Note:</strong> The datagen file will be uploaded to the worker group (not inside the pack). The datagen source is created at group level referencing this file.
                </div>
              )}
            </div>
            <div className="code-function-toggle">
              <label className="slider-label">
                <span className="slider-text">
                  <strong>Validate after deploy</strong>
                  <span className="slider-hint">{autoValidate
                    ? 'Each pipeline’s output will be scored against its target schema automatically once deployed'
                    : 'Skip automatic validation — you can still run it manually from the results screen'
                  }</span>
                </span>
                <input
                  type="checkbox"
                  checked={autoValidate}
                  onChange={(e) => setAutoValidate(e.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>
            <div className="advice-box">
              <strong>After deployment you can modify:</strong> Pipeline functions (enable/disable reduction steps), route filter, sample data, output expressions. <br/>
              <strong>Cannot be changed without re-deploy:</strong> Pack ID, worker group.
            </div>
            {error && <div className="error-box">{error}</div>}
            <StepNav>
              <button className="back" onClick={() => setStep('options')}>Back</button>
              <button className="deploy-btn" onClick={handleDeploy}>Deploy Pack</button>
            </StepNav>
          </div>
        );

      case 'deploying':
        return (
          <div className="step">
            <h2>Deploying…</h2>
            <DeployActivity latest={deployLog[deployLog.length - 1] || 'Starting…'} lineCount={deployLog.length} />
            <div className="deploy-log" ref={deployLogRef}>
              {deployLog.map((line, i) => <div key={i} className={`log-line ${logLineClass(line)}`}>{line}</div>)}
            </div>
          </div>
        );

      case 'done':
        return (
          <div className="step">
            <div className="celebrate-goat">
              <img src={goatImg} alt="Celebrating Cribl Goat" className="celebrate-goat-img" />
              <span className="celebrate-badge">Added!</span>
            </div>
            <h2>{packMode === 'post-process' ? 'Post-Processing Pack Deployed!' : 'Pipeline Added!'}</h2>
            {packMode === 'post-process' ? (() => {
              const ppSchemaOptsDone = postProcessSchemaOptions(ppDestFormat);
              const ppEffectiveFormatDone = (ppSchema && ppSchemaOptsDone.some(o => o.key === ppSchema)) ? ppSchema : ppDestFormat;
              const hasLookup = ppDestFormat === 'cef' || ppDestFormat === 'arcsight';
              return (
              <div className="success-box">
                <p>Pack <code>{packId}</code> (pipeline <code>{getPipelineId(ppSourceFormat, ppEffectiveFormatDone)}</code>) has been deployed to worker group <code>{state.workerGroup}</code>.</p>
                <p>Attach it as a <strong>post-processing pipeline</strong> on your {ppDestFormat.toUpperCase()} destination.{hasLookup ? ' The class dictionary lookup is editable inside the pack — add classes and severities without changing code.' : ''}</p>
              </div>
              );
            })() : (
              <div className="success-box">
                <p>Pipeline <code>{getPipelineId(effectiveSourcetype, state.destFormat)}</code> has been added to pack <code>{selectedPackId}</code> in worker group <code>{selectedGroup}</code>.</p>
                <p>You can now view and edit it in the Cribl UI under Packs.</p>
              </div>
            )}
            <div className="deploy-log" ref={deployLogRef}>
              {deployLog.map((line, i) => <div key={i} className={`log-line ${logLineClass(line)}`}>{line}</div>)}
            </div>
            {/* Schema-validation report block removed (build 687) — superseded by
                the unified scoring report. ValidationPanel is @deprecated. */}
            <StepNav>
              <button onClick={resetAll}>
                Start Again
              </button>
            </StepNav>
          </div>
        );

      case 'batch-upload': {
        // The Splunk CIM data model / Sentinel table is DERIVED from the
        // sourcetype, so it's chosen AFTER recognition (pre-flight Phase 3),
        // never here — this screen only shows what the file contained.
        const setRowChoice = (i: number, patch: Partial<BatchRow>) =>
          setBatchRows(prev => prev.map((r, j) => j === i ? { ...r, ...patch } : r));
        const badRows = batchRows.filter(r => r.sourcetypeError).length;
        const packNames = [...new Set(batchRows.map(r => r.pack_name))];
        const destLabel = (row: BatchRow) => row.dest_format === 'sentinel'
          ? `Microsoft Sentinel${row.sentinelTable ? ` → ${row.sentinelTable}` : ' — table chosen after recognition'}`
          : row.dest_format === 'cim'
            ? `Splunk CIM${row.cimModel ? ` → ${row.cimModel.replace(/_/g, ' ')}` : ' — model chosen after recognition'}`
            : row.dest_format;
        const fileInput = <input type="file" accept=".csv,.json" onChange={(e) => handleBatchFileUpload(e)} style={{ display: 'none' }} />;
        return (
          <div className="step bx">
            <h2>Batch create · Upload your file</h2>
            <p className="step-desc">One row per pipeline. Rows with the same pack name become one pack. You choose samples in the next step, so the file has no sample column.</p>

            {batchError && <div className="bx-notice err" style={{ marginBottom: 14 }}>{batchError}</div>}

            {batchRows.length === 0 ? (
              <>
                {/* What the file needs first (columns + examples), then the
                    upload as the last thing on the screen. */}
                <div className="bx-up bx-up-info">
                  <div className="bx-card">
                    <h3>Columns</h3>
                    <div className="bx-cols batch-fields-table">
                      <div className="bx-col"><code>sourcetype</code><span className="req">Required</span><span className="d">Log source type, e.g. <code>cisco_asa</code>, <code>windows_security</code>. Checked against known sourcetypes in the next step.</span></div>
                      <div className="bx-col"><code>pack_name</code><span className="req">Required</span><span className="d">Pack identifier, kebab-cased (e.g. "Cisco ASA Logs"). Same name = same pack.</span></div>
                      <div className="bx-col"><code>pipeline_name</code><span className="req">Required</span><span className="d">Pipeline ID within the pack, e.g. <code>cisco_asa_to_cef</code>.</span></div>
                      <div className="bx-col"><code>dest_format</code><span className="req">Required</span><span className="d">A base format (nextgen, ocsf, cef, cim, ecs, asim, chronicle, json, xsiam), <code>sentinel</code> or a Sentinel table (CommonSecurityLog…), or a CIM data model (Network_Traffic…). For bare <code>sentinel</code> or <code>cim</code> the table/model is recommended in the check, from the recognized sourcetype.</span></div>
                      <div className="bx-col"><code>route_name</code><span className="req o">Optional</span><span className="d">Display name for the route. Default: pipeline name + " Route".</span></div>
                      <div className="bx-col"><code>filter</code><span className="req o">Optional</span><span className="d">Route filter expression. Default: <code>sourcetype=='&lt;sourcetype&gt;'</code>.</span></div>
                    </div>
                    <p className="field-hint" style={{ marginTop: 10 }}>No sample column: you choose each row's sample in the check, before its sourcetype is confirmed.</p>
                  </div>
                  <div>
                    <div className="bx-section-h">CSV example<span className="bx-grow" /></div>
                    <pre className="bx-example batch-example">{`sourcetype,pack_name,pipeline_name,dest_format,route_name,filter
cisco_asa,Cisco ASA Pack,cisco_asa_to_cef,cef,ASA Route,sourcetype=='cisco_asa'
windows_security,Windows Security,win_sec_to_ocsf,ocsf,,
palo_alto_traffic,Palo Alto Traffic,pa_traffic_to_ecs,ecs,,
fortinet_fortigate,FortiGate CEF,fgt_cef_to_ocsf,ocsf,,`}</pre>
                    <div className="bx-section-h">JSON example<span className="bx-grow" /></div>
                    <pre className="bx-example batch-example">{`[
  {"sourcetype":"cisco_asa","pack_name":"Cisco ASA Pack","pipeline_name":"cisco_asa_to_cef","dest_format":"cef"},
  {"sourcetype":"windows_security","pack_name":"Windows Security","pipeline_name":"win_sec_to_ocsf","dest_format":"ocsf"}
]`}</pre>
                  </div>
                </div>
                <label className="bx-drop upload-zone bx-drop-bottom">
                  {fileInput}
                  <div className="big">{'\u{1F4C4}'}</div>
                  <b>Drop your CSV or JSON here, or click to browse</b>
                  <small>One row per pipeline · up to a few hundred rows</small>
                </label>
              </>
            ) : (
              <>
                <div className="bx-file">
                  <div className="fi">{'\u{1F4C4}'}</div>
                  <div>
                    <b>{batchFileName || 'Batch file'}</b>
                    <small>{batchRows.length} row{batchRows.length === 1 ? '' : 's'} read</small>
                  </div>
                  <label className="bx-btn sm ghost">{fileInput}Replace file</label>
                  <div className="bx-kpis">
                    <div className="bx-kpi"><b>{packNames.length}</b><span>packs</span></div>
                    <div className="bx-kpi"><b>{batchRows.length}</b><span>pipelines</span></div>
                    <div className={`bx-kpi${badRows ? ' bad' : ''}`}><b>{badRows}</b><span>to fix</span></div>
                  </div>
                </div>

                {badRows > 0 && (
                  <div className="bx-notice err batch-choice-warn" style={{ marginTop: 14 }}>
                    <b>{badRows} row{badRows === 1 ? ' has' : 's have'} an invalid sourcetype.</b>
                    <span>Fix it inline (click the sourcetype), or</span>
                    <button className="bx-btn sm danger batch-remove-invalid" onClick={() => setBatchRows(prev => prev.filter(r => !r.sourcetypeError))}>Remove all invalid rows</button>
                    <button className="bx-btn sm batch-remove-invalid" onClick={() => {
                      const el = document.querySelector('.batch-row-invalid');
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}>Jump to next invalid</button>
                  </div>
                )}

                <div className="bx-section-h">{packNames.length} pack{packNames.length === 1 ? '' : 's'} in this file<span className="bx-grow" /></div>
                <div className="bx-packs">
                  {packNames.map(name => {
                    const rows = batchRows.map((r, i) => ({ r, i })).filter(x => x.r.pack_name === name);
                    return (
                      <div key={name} className={`bx-pk${rows.some(x => x.r.sourcetypeError) ? ' bad' : ''}`}>
                        <div className="bx-pk-h"><b>{name}</b><small>{rows.length} pipeline{rows.length === 1 ? '' : 's'}</small></div>
                        {rows.map(({ r, i }) => (
                          <div key={i} className="bx-pl">
                            <b>{r.pipeline_name}</b>
                            <code>{r.sourcetype}</code><span className="bx-muted">→ {destLabel(r)}</span>
                            {r.sourcetypeError && <span className="bx-pill fail">invalid</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>

                <div className="bx-section-h">All rows<span className="bx-grow" /></div>
                <div className="batch-preview">
                  <table className="bx-t batch-upload-table">
                    <thead>
                      <tr><th>#</th><th>Pack</th><th>Pipeline</th><th>Sourcetype</th><th>Destination</th><th>Route · filter</th><th></th></tr>
                    </thead>
                    <tbody>
                      {batchRows.map((row, i) => (
                        <tr key={i} className={row.sourcetypeError ? 'bad batch-row-invalid' : ''}>
                          <td className="n">{i + 1}</td>
                          <td>{row.pack_name}</td>
                          <td>{row.pipeline_name}</td>
                          <td>
                            {batchEditingRow === i ? (
                              <div className="batch-st-fix" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                <input
                                  className="bx-input batch-st-input"
                                  style={{ width: 200 }}
                                  autoFocus
                                  value={row.sourcetype}
                                  title={row.sourcetypeError ? `Invalid sourcetype: ${row.sourcetypeError}` : 'Edit sourcetype'}
                                  onChange={e => {
                                    const v = e.target.value;
                                    setRowChoice(i, { sourcetype: v, sourcetypeError: validateSourcetypeString(v.trim()) || undefined });
                                  }}
                                  onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setBatchEditingRow(null); }}
                                />
                                <button className="bx-btn sm primary" onClick={() => setBatchEditingRow(null)}>Done</button>
                                {row.sourcetypeError && <span className="bx-pill fail">⚠ {row.sourcetypeError}</span>}
                              </div>
                            ) : (
                              <span
                                className={row.sourcetypeError ? 'batch-st-clickable preflight-fix' : 'batch-st-clickable'}
                                onClick={() => setBatchEditingRow(i)}
                                title="Click to edit"
                                style={{ cursor: 'pointer' }}
                              ><code>{row.sourcetype}</code>{row.sourcetypeError && <span className="bx-pill fail" style={{ marginLeft: 6 }}>✎ fix</span>}</span>
                            )}
                          </td>
                          <td>{destLabel(row)}</td>
                          <td>
                            {row.route_name || `${row.pipeline_name} Route`}
                            <span className="sub2"><code>{row.filter || `sourcetype=='${row.sourcetype}'`}</code></span>
                          </td>
                          <td><button className="bx-x batch-row-remove" title="Remove row" onClick={() => setBatchRows(prev => prev.filter((_, j) => j !== i))}>✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <StepNav>
              <button className="back" onClick={() => { setStep('mode'); setBatchRows([]); setBatchError(''); setBatchFileName(''); }}>Back</button>
              {/* Clean files jump straight to pre-flight from the parser. This
                  button is the recovery path: after fixing the flagged rows, the
                  user re-runs recognition on the corrected set. */}
              {batchRows.length > 0 && (
                <button
                  disabled={batchRows.some(r => r.sourcetypeError)}
                  onClick={() => { setBatchError(''); setStep('batch-preflight'); startPreflight(); }}
                >
                  Continue to check
                </button>
              )}
            </StepNav>
          </div>
        );
      }

      case 'batch-preflight': {
        const sourcetypeGateOpen = preflightSourcetypes.length > 0
          && preflightGate.length === preflightSourcetypes.length
          && batchGateOpen(preflightGate);
        const gateUnvalidated = preflightGate.filter(g => !isGateRowValidated(g)).length;
        const gateMatchable = preflightGate.filter(declarableAsIs).length;
        const patchStRow = (index: number, patch: Partial<PreflightSourcetypeRow>) =>
          setPreflightSourcetypes(prev => prev.map(r => r.index === index ? { ...r, ...patch } : r));
        const schemaOf = (row: PreflightSourcetypeRow) => (row.schemaOverride || row.schemaModel || '').replace(/^asim#/, '').replace(/_/g, ' ');
        const destOf = (row: PreflightSourcetypeRow) => {
          const fmt = row.destFormat || batchRows[row.index]?.dest_format || '';
          const model = schemaOf(row);
          return `${fmt.toUpperCase()}${model ? ` ${model}` : ''}`;
        };
        // One projection per row feeds the tiles, the needs box, the weaker
        // list, the table and the side panel (src/batch-check-view.ts), so they
        // can never disagree about which rows are open.
        // Rows whose DIFFERENT declared names resolve to one sample key share a
        // parser and a sample (fortigate_traffic/_utm/_web → fortinet_fortigate),
        // so their packs come out alike. A row's own sample has a key of its own.
        const sharedSampleNames = new Map<number, string[]>();
        {
          const byKey = new Map<string, PreflightSourcetypeRow[]>();
          for (const r of preflightSourcetypes) {
            if (r.recognized === 'unknown') continue;
            const key = preflightSampleKeyOf(r);
            if (isRowSampleKey(key)) continue;
            byKey.set(key, [...(byKey.get(key) ?? []), r]);
          }
          for (const group of byKey.values()) {
            for (const r of group) {
              const others = [...new Set(group
                .filter(o => canonicalizeSourcetype(o.original) !== canonicalizeSourcetype(r.original))
                .map(o => o.original))];
              if (others.length) sharedSampleNames.set(r.index, others);
            }
          }
        }
        // Where Next will get each sample from: the stores' answer, then the same
        // model budget the sample pass spends (src/sample-forecast.ts). Keys the
        // sample pass already settled are out of the budget, as they are behind Next.
        const sampleForecast = forecastSamples(
          samplesStillToResolve(preflightSourcetypes.map(preflightSampleKeyOf), preflightSamples),
          new Map(Object.entries(preflightStoreLookups)),
          {
            cap: PREFLIGHT_MODEL_CAP, floor: SAMPLE_EXTEND_FLOOR, aiReady: aiAvailable(), isOwn: isRowSampleKey,
            ownEvents: key => (preflightSourcetypes.find(r => preflightSampleKeyOf(r) === key)?.rowSample || '').split('\n').filter(l => l.trim()).length,
          },
        );
        const forecastOf = (row: PreflightSourcetypeRow) => sampleForecast.get(preflightSampleKeyOf(row));
        const factsOf = (row: PreflightSourcetypeRow): CheckRowFacts => {
          const gate = preflightGate[row.index];
          const src = batchRows[row.index];
          const s = preflightSampleFor(row);
          const own = !!gate?.sample?.trim();
          const state: CheckRowFacts['sample']['state'] = s
            ? s.status === 'found' ? 'found' : s.status === 'generated' ? 'generated' : s.status === 'failed' || s.status === 'skipped' ? 'missing'
              : s.status === 'pending' || s.status === 'loading' ? 'pending' : 'none'
            : own ? 'found'
            // Not resolved yet: a row Next leaves without a sample is missing now.
            : forecastOf(row)?.kind === 'ai-build' || forecastOf(row)?.kind === 'none' ? 'missing' : 'none';
          return {
            index: row.index,
            pack: src?.pack_name || '',
            declared: gate?.declared || row.original,
            sourcetype: gate ? (gate.confirmed?.sourcetype || gate.draft) : (row.override || row.canonical),
            confirmed: gate ? isGateRowValidated(gate) : row.recognized !== 'unknown',
            recognized: row.recognized,
            checking: !!row.aiChecking,
            needsConfirm: !!row.needsConfirm,
            vendorOnly: row.needsConfirm && row.recStatus === 'catalogue_gap'
              ? [row.vendor, row.product].filter(Boolean).join(' ') || row.description || 'a known vendor'
              : undefined,
            notSecurity: row.recognized === 'unknown' ? row.notSecurity : undefined,
            sharedWith: sharedSampleNames.get(row.index) ?? [],
            path: row.status === 'green' ? 'golden' : row.status === 'red' ? 'none' : 'ai',
            dest: destOf(row),
            sample: { state, events: s?.eventCount ?? 0, thin: !!s?.thin, own, sanitised: !!(gate?.sanitised || src?.sampleSanitised) },
          };
        };
        const facts = preflightSourcetypes.map(factsOf);
        const factsAt = new Map(facts.map(f => [f.index, f]));
        const explainAt = new Map(facts.map(f => [f.index, explainCheckRow(f)]));
        const queue = decisionQueue(facts);
        const tiles = checkTiles(facts);
        const weaker = facts.filter(f => explainAt.get(f.index)!.kind === 'ok' && sampleNote(f));
        const vendorOnlyOpen = facts.filter(f => f.vendorOnly && !f.confirmed && explainAt.get(f.index)!.kind === 'warn').map(f => f.index);
        const selRow = checkSel != null ? preflightSourcetypes.find(r => r.index === checkSel) : undefined;
        const rich = (r: Rich) => r.map((p, k) => typeof p === 'string' ? <Fragment key={k}>{p}</Fragment>
          : 'code' in p ? <code key={k}>{p.code}</code> : <b key={k}>{p.b}</b>);
        const mark = (kind: string, lg = false) => (
          <span className={`bx-mk ${kind}${lg ? ' lg' : ''}`}>{kind === 'ok' ? '✓' : kind === 'warn' ? '!' : kind === 'err' ? '✕' : <span className="bx-spin" />}</span>
        );
        const pathLabel = (f: CheckRowFacts) => f.checking ? <span className="bx-muted">…</span>
          : <span className={`bx-path ${f.path}`}>{f.path === 'golden' ? '★ Golden' : f.path === 'ai' ? '✦ AI' : '—'}</span>;
        const sampleCell = (f: CheckRowFacts, row: PreflightSourcetypeRow) => {
          const s = preflightSampleFor(row);
          const src = batchRows[row.index];
          if (src?.sampleChoice) return <span>{f.sample.sanitised && <span className="bx-pill teal" style={{ marginRight: 4 }}>Sanitized</span>}{src.sampleChoice}</span>;
          if (!s) {
            const fc = forecastOf(row);
            return <span className={sampleForecastIsWeak(fc) ? 'bx-muted' : ''}>{sampleForecastLabel(fc, PREFLIGHT_MODEL_CAP)}</span>;
          }
          return (
            <span className={s.status === 'failed' ? 'bx-path none' : s.thin ? 'bx-muted' : ''} title={s.reason || undefined}>
              {s.status === 'found' ? `${s.thin ? '⚠︎' : '✓'} ${s.eventCount} event${s.eventCount === 1 ? '' : 's'} (${s.source === 'uploaded' ? 'your sample' : s.source})`
                : s.status === 'generated' ? `✓ ${s.eventCount} events (generated)`
                : s.status === 'failed' ? '✕ no sample'
                : s.status === 'loading' ? '⏳…'
                : s.status === 'pending' ? '…' : 'AI at build'}
            </span>
          );
        };
        const tileMatch = (f: CheckRowFacts) => {
          const k = explainAt.get(f.index)!.kind;
          return checkTile === 'all' ? true : checkTile === 'ai' ? f.path === 'ai' : k === checkTile;
        };
        // A detail chip (preflightFilter) wins over a tile; choosing a tile clears it.
        const visibleRows = preflightFilter ? preflightRowsIn(preflightFilter) : preflightSourcetypes.filter(r => tileMatch(factsAt.get(r.index)!));
        const filtering = preflightFilter != null || checkTile !== 'all';
        const clearFilters = () => { setPreflightFilter(null); setCheckTile('all'); };
        const pickTile = (t: typeof checkTile) => { setPreflightFilter(null); setCheckTile(checkTile === t ? 'all' : t); };
        // A tile or chip scopes the decisions too: the box, "Start with the
        // first" and the stepper walk the rows the table shows first.
        const scope = scopedQueue(queue, filtering ? new Set(visibleRows.map(r => r.index)) : null);
        const openQ = scope.queue;
        const viewLabel = preflightFilter ? PREFLIGHT_FILTER_LABEL[preflightFilter]
          : ({ ok: 'ready', warn: 'to confirm', err: 'not recognized', ai: 'building via AI', all: '' } as Record<string, string>)[checkTile] || 'in this view';
        const count = (filter: PreflightFilter) => preflightCount(preflightSourcetypes, filter, preflightSampleFor);
        const sampleCount = (filter: PreflightFilter) => preflightSamples.filter(s => preflightSampleMatches(s, filter)).length;
        const unknownCount = preflightCount(preflightSourcetypes, 'unknown');
        // The finer recognition / sample counts stay as chips. Each one filters
        // the table to exactly the rows it counted (same shared predicate as
        // src/preflight-filter.ts); choosing one clears the tile filter.
        const counter = (filter: PreflightFilter, cls: string, text: string) => {
          const active = preflightFilter === filter;
          return (
            <button type="button" key={filter}
              className={`bx-fc ${cls}${active ? ' on' : ''}`}
              title={active ? 'Showing only these rows — click to show all records' : `Show only the rows ${PREFLIGHT_FILTER_LABEL[filter]}`}
              aria-pressed={active}
              onClick={() => setPreflightFilter(active ? null : filter)}
            >{text}</button>
          );
        };
        const confirmAndNext = (index: number) => {
          const gate = preflightGate[index];
          if (!gate || !confirmGateRow(gate, gate.draft).confirmed) return;
          const after = stepperFor(openQ, index).afterConfirm;
          confirmPreflightGate(index, gate.draft);
          setCheckSel(after);
        };
        const NEEDS_SHOWN = 6;
        return (
          <div className={`step bx${selRow ? ' bx-has-side' : ''}`}>
            <h2>Check sourcetypes and samples</h2>
            <p className="step-desc">Choose each row's sample first, then confirm the sourcetype it names. Click a row to see why it needs you, what to do and what happens to it in the build. ✎ changes a row's sourcetype and ⇪ chooses its sample (capture, upload, saved or library). The Sample column says where a row without a chosen sample gets one: the library, or AI, which creates the missing samples at the start of the batch run.</p>

            {/* Busy panel ABOVE the table and sticky to the top of the step: the
                table can be 500+ rows, and a small line under the tiles was missed
                — the screen read as finished (tiles say "Ready") while recognition
                or AI was still changing rows. The stage track says how far along
                the whole check is, not just the current pass. */}
            {preflightRunning && (() => {
              const v = preflightBusyView(preflightPhase, preflightProgress);
              return (
                <div className="bx-busy preflight-busy" role="status" aria-live="polite" aria-busy="true">
                  <div className="bx-busy-top">
                    <span className="bx-spin lg" aria-hidden />
                    <div className="bx-grow">
                      <div className="bx-busy-title">{v.title}…</div>
                      <div className="bx-busy-hint">{v.hint}</div>
                    </div>
                    <div className="bx-busy-count">
                      <b>{v.pct != null ? `${v.pct}%` : '…'}</b>
                      <span>{v.count}{checkBusySince != null && <> · <ElapsedSince since={checkBusySince} /></>}</span>
                    </div>
                  </div>
                  <div className={`bx-bar lg${v.pct != null ? '' : ' indeterminate'}`}><b style={v.pct != null ? { width: `${v.pct}%` } : undefined} /></div>
                  <ol className="bx-stages" aria-label="Check stages">
                    {v.stages.map((st, n) => (
                      <li key={st.id} className={st.state}><span className="dot">{st.state === 'done' ? '✓' : n + 1}</span>{st.label}</li>
                    ))}
                  </ol>
                  {/* Phase 2 generates/extends samples — minutes of model time per
                      source. Let the user stop waiting: unfinished sources fall
                      back to build-time generation, which never blocks the build. */}
                  {preflightPhase === 'samples' && (
                    <button className="bx-btn sm preflight-cancel-link" onClick={skipPreflightSampleResolution}>
                      Continue without waiting — generate the rest at build time
                    </button>
                  )}
                </div>
              );
            })()}
            {!preflightRunning && checkDoneNotice && (
              <div className={`bx-done preflight-done${openQ.length ? ' warn' : ''}`} role="status" aria-live="polite">
                <b>✓ Check finished.</b>{' '}
                {openQ.length
                  ? <>{openQ.length} {openQ.length === 1 ? 'row needs' : 'rows need'} a decision. <button type="button" className="bx-link" onClick={() => { setCheckDoneNotice(false); setCheckSel(openQ[0]); }}>Start with the first →</button></>
                  : <>Nothing needs a decision; press Next to continue.</>}
                <button type="button" className="bx-x" aria-label="Dismiss" onClick={() => setCheckDoneNotice(false)}>×</button>
              </div>
            )}

            {preflightSourcetypes.length > 0 && (
              <>
                {preflightRunning && <div className="bx-tiles-cap"><span className="bx-spin" aria-hidden /> Counts so far, still changing until the check finishes</div>}
                <div className={`bx-tiles${preflightRunning ? ' busy' : ''}`} title={preflightRunning ? 'Still counting: these numbers change until the check finishes' : undefined}>
                  <button type="button" className={`bx-tile all${checkTile === 'all' && !preflightFilter ? ' on' : ''}`} onClick={() => clearFilters()}><b>{tiles.all}</b><span>All rows</span></button>
                  <button type="button" className={`bx-tile ok${checkTile === 'ok' && !preflightFilter ? ' on' : ''}`} onClick={() => pickTile('ok')}><b>{tiles.ready}</b><span>Ready</span></button>
                  <button type="button" className={`bx-tile warn${checkTile === 'warn' && !preflightFilter ? ' on' : ''}`} onClick={() => pickTile('warn')}><b>{tiles.confirm}</b><span>To confirm</span></button>
                  <button type="button" className={`bx-tile err${checkTile === 'err' && !preflightFilter ? ' on' : ''}`} onClick={() => pickTile('err')}><b>{tiles.unknown}</b><span>Not recognized{tiles.checking ? ` · ${tiles.checking} checking` : ''}</span></button>
                  <button type="button" className={`bx-tile ai${checkTile === 'ai' && !preflightFilter ? ' on' : ''}`} onClick={() => pickTile('ai')}><b>{tiles.ai}</b><span>Build via ✦ AI</span></button>
                </div>

                <div className="bx-chips preflight-counters">
                  <span>Detail:</span>
                  {counter('recognized', '', `${count('recognized')} recognized`)}
                  {count('identified') > 0 && counter('identified', '', `${count('identified')} identified (build via AI)`)}
                  {/* No "to confirm" chip: the To confirm tile is that count. The chip
                      counted only AI-suggested names, so it disagreed with the tile. */}
                  {count('checking') > 0 && counter('checking', '', `${count('checking')} being identified…`)}
                  {unknownCount > 0 && counter('unknown', 'err', `${unknownCount} unknown (blocks build)`)}
                  {preflightSamples.length > 0 && !preflightRunning && (
                    <>
                      {sampleCount('sample-found') > 0 && counter('sample-found', '', `${sampleCount('sample-found')} samples found`)}
                      {sampleCount('sample-generated') > 0 && counter('sample-generated', '', `${sampleCount('sample-generated')} generated`)}
                      {sampleCount('sample-thin') > 0 && counter('sample-thin', 'warn', `${sampleCount('sample-thin')} thin ${sampleCount('sample-thin') === 1 ? 'sample' : 'samples'}`)}
                      {sampleCount('sample-missing') > 0 && counter('sample-missing', 'err', `${sampleCount('sample-missing')} without a sample (generated at build time)`)}
                    </>
                  )}
                </div>

                {/* Shown in BOTH phases — a row can be flagged unrecognized in the
                    samples step too — and it must be removable, not just visible. */}
                {unknownCount > 0 && !preflightRunning && (
                  <div className="bx-notice err" style={{ marginBottom: 12 }}>
                    <span><b>{unknownCount} unrecognized sourcetype{unknownCount > 1 ? 's' : ''}</b> block the build. Name them in the side panel, or:</span>
                    <button type="button" className="bx-btn sm" onClick={recheckUnknownsWithAi}>Re-check with AI</button>
                    {preflightFilter === 'unknown' ? (
                      <button type="button" className="bx-btn sm" onClick={() => setPreflightFilter(null)}>Show all records</button>
                    ) : (
                      <button type="button" className="bx-btn sm" onClick={() => setPreflightFilter('unknown')}>Check unknown records</button>
                    )}
                    <button type="button" className="bx-btn sm danger" onClick={removeAllUnknownPreflightRows}>Remove all unrecognized</button>
                  </div>
                )}

                {!preflightRunning && queue.length > 0 && (
                  <div className="bx-needs">
                    <div className="bx-needs-h">
                      <span className="bx-mk warn">!</span>
                      <h4>
                        {scope.scoped
                          ? <>{openQ.length} {viewLabel} row{openQ.length === 1 ? ' needs' : 's need'} a decision <span className="bx-muted">· {scope.total} in total</span></>
                          : <>{queue.length} row{queue.length === 1 ? ' needs' : 's need'} a decision before the build</>}
                      </h4>
                      <span className="bx-grow" />
                      {scope.scoped && <button type="button" className="bx-btn sm ghost" onClick={() => clearFilters()}>All decisions</button>}
                      {gateMatchable > 0 && (
                        <button type="button" className="bx-btn sm primary" onClick={confirmDeclaredGateRows}>
                          Accept {gateMatchable} declared {gateMatchable === 1 ? 'name that already matches' : 'names that already match'}
                        </button>
                      )}
                      {vendorOnlyOpen.length > 0 && (
                        <button type="button" className="bx-btn sm" onClick={() => confirmGateRowsAsWritten(vendorOnlyOpen)}
                          title="These names match a vendor hint only: no parser, no golden, built by AI from the sample">
                          Accept {vendorOnlyOpen.length} vendor-only {vendorOnlyOpen.length === 1 ? 'name' : 'names'} as written
                        </button>
                      )}
                      <button type="button" className="bx-btn sm" onClick={() => setCheckSel(openQ[0])}>Start with the first →</button>
                    </div>
                    {openQ.slice(0, NEEDS_SHOWN).map(i => {
                      const f = factsAt.get(i)!;
                      const ex = explainAt.get(i)!;
                      return (
                        <div key={i} className={`bx-nd click preflight-pending-row${checkSel === i ? ' sel' : ''}`} onClick={() => setCheckSel(i)}>
                          {mark(ex.kind)}
                          <span><b>Row {i + 1}</b>{f.pack ? ` · ${f.pack}` : ''} · {rich(ex.short)}</span>
                          <span className="acts">
                            <button type="button" className="bx-btn sm" onClick={e => { e.stopPropagation(); setBatchPickIndex(i); }} disabled={!preflightGate[i]}>⇪ {sampleActionLabel(f)}</button>
                            {canConfirmInline(ex.kind) && (() => {
                              const gate = preflightGate[i];
                              const ok = !!gate && confirmGateRow(gate, gate.draft).confirmed;
                              return (
                                <button type="button" className="bx-btn sm primary preflight-inline-confirm" disabled={!ok}
                                  title={ok ? `Confirm ${gate!.draft}` : 'Pick a sourcetype in Review first'}
                                  onClick={e => { e.stopPropagation(); if (ok) confirmPreflightGate(i, gate!.draft); }}>✓ Confirm</button>
                              );
                            })()}
                            <button type="button" className="bx-btn sm" onClick={e => { e.stopPropagation(); setCheckSel(i); }}>{ex.kind === 'err' ? 'Fix' : 'Review'} →</button>
                            <button type="button" className="bx-btn sm danger preflight-inline-remove" title="Remove this row from the batch"
                              onClick={e => { e.stopPropagation(); removePreflightRows([i]); setCheckSel(selectionAfterRemove(checkSel, i)); }}>Remove</button>
                          </span>
                        </div>
                      );
                    })}
                    {openQ.length > NEEDS_SHOWN && (
                      <div className="bx-nd">
                        <span className="bx-muted">+{openQ.length - NEEDS_SHOWN} more.</span>
                        {!filtering && <button type="button" className="bx-link" onClick={() => { setPreflightFilter(null); setCheckTile(tiles.unknown ? 'err' : 'warn'); }}>Show them in the table</button>}
                      </div>
                    )}
                    {weaker.length > 0 && (
                      <>
                        <div className="sub-h">Will build, but weaker</div>
                        {weaker.slice(0, NEEDS_SHOWN).map(f => {
                          const note = sampleNote(f)!;
                          return (
                            <div key={f.index} className="bx-nd click" onClick={() => setCheckSel(f.index)}>
                              <span className="bx-mk warn">~</span>
                              <span><b>Row {f.index + 1}</b>{f.pack ? ` · ${f.pack}` : ''} · {note.title}: <span className="bx-muted">{note.detail}</span></span>
                              <span className="acts">
                                <button type="button" className="bx-btn sm" disabled={!preflightGate[f.index]} onClick={e => { e.stopPropagation(); setBatchPickIndex(f.index); }}>⇪ {note.action}</button>
                              </span>
                            </div>
                          );
                        })}
                        {weaker.length > NEEDS_SHOWN && <div className="bx-nd"><span className="bx-muted">+{weaker.length - NEEDS_SHOWN} more.</span></div>}
                      </>
                    )}
                  </div>
                )}

                {!preflightRunning && queue.length === 0 && preflightGate.length > 0 && (
                  <div className="bx-ready batch-choice-info">
                    <span className="bx-mk ok lg">✓</span>
                    <div>
                      <b>{sourcetypeGateOpen ? 'Every row has a confirmed sourcetype.' : `${gateUnvalidated} ${gateUnvalidated === 1 ? 'row still needs' : 'rows still need'} a confirmed sourcetype.`}</b>
                      <div className="bx-muted" style={{ fontSize: 12 }}>
                        Press Next to choose the worker group. Download the corrected CSV to keep the confirmed names.
                      </div>
                    </div>
                    <span className="acts">
                      <button type="button" className="bx-btn sm" disabled={!sourcetypeGateOpen} onClick={downloadConfirmedBatchCsv}>Download corrected CSV</button>
                    </span>
                  </div>
                )}
                {/* Nothing here blocks the build, so it is one quiet line with a
                    count per reason, not a yellow wall of every row. The rows
                    stay one click away for whoever wants to improve them. */}
                {!preflightRunning && queue.length === 0 && weaker.length > 0 && (() => {
                  const byTitle = new Map<string, number>();
                  for (const f of weaker) { const t = sampleNote(f)!.title; byTitle.set(t, (byTitle.get(t) ?? 0) + 1); }
                  return (
                    <div className="bx-weaker preflight-weaker">
                      <div className="bx-weaker-h">
                        <span className="bx-muted">Optional improvements:</span>
                        {[...byTitle].map(([t, n]) => <span key={t} className="bx-weaker-c">{n} × {t.toLowerCase()}</span>)}
                        <span className="bx-grow" />
                        <button type="button" className="bx-link" onClick={() => setCheckWeakerOpen(o => !o)}>{checkWeakerOpen ? 'Hide rows' : `Show ${weaker.length} row${weaker.length === 1 ? '' : 's'}`}</button>
                      </div>
                      {checkWeakerOpen && weaker.map(f => {
                      const note = sampleNote(f)!;
                      return (
                        <div key={f.index} className="bx-nd click" onClick={() => setCheckSel(f.index)}>
                          <span><b>Row {f.index + 1}</b>{f.pack ? ` · ${f.pack}` : ''} · {note.title}: <span className="bx-muted">{note.detail}</span></span>
                          <span className="acts">
                            <button type="button" className="bx-btn sm" disabled={!preflightGate[f.index]} onClick={e => { e.stopPropagation(); setBatchPickIndex(f.index); }}>⇪ {note.action}</button>
                          </span>
                        </div>
                      );
                    })}
                    </div>
                  );
                })()}

                {/* Rows whose sample came back missing still build (generated at
                    build time) but the user may want them gone in one click. */}
                {preflightPhase === 'samples' && !preflightRunning && sampleCount('sample-missing') > 0 && (
                  <div className="bx-notice" style={{ marginBottom: 12 }}>
                    <span>{sampleCount('sample-missing')} sourcetype{sampleCount('sample-missing') > 1 ? 's' : ''} could not resolve a sample.</span>
                    <button className="bx-btn sm danger" onClick={removeAllUnresolvedSamplePreflightRows}>Remove all without a sample</button>
                  </div>
                )}

                <div className="bx-toolbar">
                  <b style={{ fontSize: 13 }}>{filtering ? `Showing ${visibleRows.length} of ${preflightSourcetypes.length} rows` : `${preflightSourcetypes.length} rows`}</b>
                  {preflightFilter && <span className="bx-muted">{PREFLIGHT_FILTER_LABEL[preflightFilter]}</span>}
                  {filtering && <button className="bx-link preflight-cancel-link" onClick={clearFilters}>Show all records</button>}
                  <span className="bx-grow" />
                  {queue.length > 0 && (
                    <button type="button" className="bx-btn sm" disabled={!sourcetypeGateOpen} onClick={downloadConfirmedBatchCsv}
                      title="Available once every row has a confirmed sourcetype">Download corrected CSV</button>
                  )}
                </div>
                <div className="bx-t-scroll">
                  <table className="bx-t batch-preflight-table">
                    <thead><tr><th></th><th>#</th><th>Pack · pipeline</th><th>Sample</th><th>Sourcetype</th><th>Destination</th><th>Build</th></tr></thead>
                    <tbody>
                      {/* A filter that now matches nothing must say so — an empty
                          table with no explanation reads as lost data. */}
                      {visibleRows.length === 0 && (
                        <tr><td colSpan={7}>
                          <span className="bx-muted">No rows {preflightFilter ? PREFLIGHT_FILTER_LABEL[preflightFilter] : 'in this view'} any more. </span>
                          <button className="bx-link" onClick={clearFilters}>Show all records</button>
                        </td></tr>
                      )}
                      {visibleRows.map(row => {
                        const f = factsAt.get(row.index)!;
                        const ex = explainAt.get(row.index)!;
                        const src = batchRows[row.index];
                        const declaredDiffers = f.declared && f.sourcetype && canonicalizeSourcetype(f.declared) !== canonicalizeSourcetype(f.sourcetype);
                        return (
                          <tr id={`preflight-row-${row.index}`} key={row.index}
                            className={`click${checkSel === row.index ? ' sel' : ''}`}
                            onClick={() => setCheckSel(checkSel === row.index ? null : row.index)}>
                            <td style={{ width: 26 }}>{mark(ex.kind)}</td>
                            <td className="n">{row.index + 1}</td>
                            <td>{src?.pack_name || '—'}<span className="sub2">{src?.pipeline_name}</span></td>
                            <td>
                              <span className="bx-cell-act">
                                {sampleCell(f, row)}
                                <button type="button" className="bx-ib preflight-row-sample-pick"
                                  title={`${sampleActionLabel(f)}: capture, upload, a saved sample or the library`}
                                  aria-label={`Choose the sample for row ${row.index + 1}`}
                                  disabled={preflightRunning || !preflightGate[row.index]}
                                  onClick={e => { e.stopPropagation(); setBatchPickIndex(row.index); }}>⇪</button>
                              </span>
                            </td>
                            <td>
                              <span className="bx-st">
                                {declaredDiffers && <span className="from">{f.declared}</span>}
                                <code>{f.sourcetype || f.declared || '—'}</code>
                                {row.autoApplied && <span title="Auto-corrected from a high-confidence match">⤳</span>}
                                <button type="button" className="bx-ib preflight-row-st-edit"
                                  title="Change this row's sourcetype"
                                  aria-label={`Change the sourcetype for row ${row.index + 1}`}
                                  disabled={!preflightGate[row.index] || !!row.aiChecking}
                                  onClick={e => { e.stopPropagation(); setCheckSel(row.index); setCheckEditFocus(row.index); }}>✎</button>
                              </span>
                              <span className="sub2">
                                {ex.kind === 'ok' ? (row.description || describeSourcetype(row.canonical)) : ex.title}
                                {row.recognized === 'unknown' && !row.aiChecking && (
                                  <span onClick={e => { e.stopPropagation(); setCheckSel(null); }}>
                                    {' · '}<button className="bx-link preflight-row-remove" title="Remove this record from the batch"
                                      onClick={() => removePreflightRows([row.index])}>Remove</button>
                                  </span>
                                )}
                              </span>
                            </td>
                            <td>{f.dest || '—'}</td>
                            <td>{pathLabel(f)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {preflightSampleConflicts.length > 0 && (
              <div className="bx-notice err" role="alert" style={{ marginTop: 10 }}>
                {preflightSampleConflicts.map(m => <div key={m}>⚠ {m}</div>)}
              </div>
            )}

            {selRow && (() => {
              const row = selRow;
              const i = row.index;
              const f = factsAt.get(i)!;
              const ex = explainAt.get(i)!;
              const gate = preflightGate[i];
              const src = batchRows[i];
              const sampleRow = preflightSampleFor(row);
              const note = sampleNote(f);
              const stp = stepperFor(openQ, i);
              const reading = rowSampleReadingFor(row);
              const st = row.override || row.canonical;
              const confirmable = !!gate && !!gate.draft.trim() && !preflightRunning;
              return (
                <aside className="bx-side" aria-label={`Row ${i + 1} decision`}>
                  <div className="bx-stepper">
                    {stp.position > 0
                      ? <>Decision <b>{stp.position}</b> of <b>{stp.total}</b></>
                      : openQ.length > 0 ? <>{openQ.length} decision{openQ.length === 1 ? '' : 's'} open{scope.scoped ? ` (${viewLabel})` : ''}</> : <>No open decisions</>}
                    <span className="bx-grow" />
                    <button type="button" aria-label="Previous decision" disabled={stp.prev == null} onClick={() => setCheckSel(stp.prev)}>‹</button>
                    <button type="button" aria-label="Next decision" disabled={stp.next == null && (stp.position > 0 || openQ.length === 0)}
                      onClick={() => setCheckSel(stp.next ?? openQ[0] ?? null)}>›</button>
                  </div>
                  <div className="bx-dr-h">
                    {mark(ex.kind, true)}
                    <div>
                      <b>{src?.pack_name || `Row ${i + 1}`}{src?.pipeline_name ? ` · ${src.pipeline_name}` : ''}</b>
                      <small>Row {i + 1} · file says <code>{f.declared || 'blank'}</code> · {f.dest || 'no destination'}</small>
                    </div>
                    <button type="button" className="x" aria-label="Close" onClick={() => setCheckSel(null)}>×</button>
                  </div>
                  <div className="bx-dr-b">
                    <div className={`bx-notice col${ex.kind === 'err' ? ' err' : ex.kind === 'ok' || ex.kind === 'checking' ? ' teal' : ''}`}>
                      <b>{ex.title}</b>
                      <span>{rich(ex.why)}</span>
                      {ex.todo.length > 0 && <ol>{ex.todo.map((t, k) => <li key={k}>{rich(t)}</li>)}</ol>}
                    </div>

                    {/* The sample comes first: its events are what the sourcetype
                        below is read from. Event bodies are never rendered here. */}
                    <div className="bx-dr-sec preflight-sample-cell">
                      <h4>1 · Sample
                        <button type="button" className="bx-link preflight-sample-pick" disabled={preflightRunning || !gate}
                          aria-label={`Choose the sample for row ${i + 1}`}
                          onClick={() => setBatchPickIndex(row.index)}>⇪ {sampleActionLabel(f)}</button>
                      </h4>
                      <dl className="bx-facts">
                        <dt>Source</dt>
                        <dd>{src?.sampleChoice || (sampleRow ? (sampleRow.status === 'generated' ? 'Generated' : sampleRow.status === 'failed' ? 'None found' : sampleRow.source === 'uploaded' ? 'Your sample' : sampleRow.source || '—') : sampleForecastLabel(forecastOf(row), PREFLIGHT_MODEL_CAP))}</dd>
                        {sampleRow && (sampleRow.status === 'found' || sampleRow.status === 'generated') && <><dt>Events</dt><dd>{sampleRow.eventCount}{sampleRow.thin ? ' (thin)' : ''}</dd></>}
                        {reading && <><dt>Format</dt><dd>{reading.wireLabel || 'unrecognised'}</dd></>}
                        {reading?.detected && <><dt>Content names</dt><dd>{reading.detected}{reading.detectedDiffers ? ` — the row stays ${st}` : ''}</dd></>}
                        {f.sample.own && <><dt>Sanitized</dt><dd>{f.sample.sanitised ? <span className="bx-pill teal preflight-sanitized-badge">Sanitized</span> : 'No'}</dd></>}
                      </dl>
                      {src?.sampleNote && <div className="bx-muted" style={{ fontSize: 12, marginTop: 6 }}>{src.sampleNote}</div>}
                      {sampleRow && (sampleRow.status === 'failed' || sampleRow.thin) && sampleRow.reason && <div className="bx-muted" style={{ fontSize: 12, marginTop: 6 }}>{sampleRow.reason}</div>}
                      {reading?.guard === 'mismatch' && (
                        <div className="bx-notice" style={{ marginTop: 8 }}>
                          Not the shape {st} expects: its built-in parser and golden path are refused for this sample, so {loadQualitySettings().requireSanitisedSamples ? 'it builds without its parser' : 'AI builds the parser'}.
                        </div>
                      )}
                      {reading && loadQualitySettings().requireSanitisedSamples && (
                        <div className="bx-muted" style={{ fontSize: 12, marginTop: 6 }} title='Samples → Sharing → "Require sanitised samples before any AI call" keeps your own events out of AI prompts.'>
                          Your own events: AI steps skipped.
                        </div>
                      )}
                      {note && <div className="bx-notice" style={{ marginTop: 8 }}><b>{note.title}.</b> {note.detail}</div>}
                      {!preflightRunning && sampleRow && (sampleRow.status === 'failed' || (sampleRow.thin && sampleRow.source !== 'uploaded')) && (
                        <button className="bx-link preflight-row-remove" style={{ marginTop: 6 }} title="Remove this record from the batch"
                          onClick={() => removePreflightRows([row.index])}>Remove from batch</button>
                      )}
                      <div className="bx-ev">🔒 Event content is hidden here. Open ⇪ {sampleActionLabel(f)} to look at or change the events.</div>
                    </div>

                    <div className="bx-dr-sec">
                      <h4>2 · Sourcetype</h4>
                      {gate ? (
                        <div className="preflight-canonical-editor">
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input
                              ref={el => {
                                // Opened by the row's ✎: put the cursor in the name, once.
                                if (el && checkEditFocus === i) { el.focus(); el.select(); setCheckEditFocus(null); }
                              }}
                              className="bx-input preflight-canonical-input"
                              value={gate.draft}
                              placeholder="canonical sourcetype"
                              aria-label={`Canonical sourcetype for row ${i + 1}`}
                              onChange={e => setPreflightGate(prev => prev.map((g, j) => j === i ? editGateDraft(g, e.target.value) : g))}
                              onKeyDown={e => { if (e.key === 'Enter') confirmAndNext(i); }}
                            />
                            <button type="button" className="bx-btn sm"
                              disabled={preflightRunning || preflightGateDetecting.has(i)}
                              onClick={() => { void detectPreflightSourcetype(i); }}>
                              {preflightGateDetecting.has(i) ? <><span className="bx-spin" /> asking AI…</> : 'Detect sourcetype'}
                            </button>
                            <button type="button" className="bx-btn sm" title="Confirm this name and stay on the row"
                              disabled={preflightRunning || !gate.draft.trim()}
                              onClick={() => confirmPreflightGate(i, gate.draft)}>
                              Save
                            </button>
                          </div>
                          <div className="bx-sugg preflight-suggestions" aria-label={`Sourcetype suggestions for row ${i + 1}`}>
                            <span className="bx-sugg-kind">Suggestions</span>
                            {gate.suggestions.length === 0 ? (
                              <span className="bx-muted" style={{ fontSize: 12 }}>
                                No close sourcetype name.{gate.sample ? ' Press Detect sourcetype to read the sample.' : ' Add a sample to read the name from it.'}
                              </span>
                            ) : (['from sample', 'AI (sample)', 'has a golden', 'close name', 'declared name'] as const).map(kind => {
                              const picks = gate.suggestions.filter(c => suggestionLabel(c.why) === kind);
                              if (picks.length === 0) return null;
                              const heading = kind === 'from sample' ? 'From the sample'
                                : kind === 'AI (sample)' ? 'AI read the sample'
                                : kind === 'has a golden' ? 'Has a golden'
                                : kind === 'close name' ? 'Close names' : 'Declared name';
                              return (
                                <Fragment key={kind}>
                                  <span className="bx-sugg-kind">{heading}</span>
                                  {picks.map(c => {
                                    const current = canonicalizeSourcetype(c.name) === canonicalizeSourcetype(gate.draft);
                                    return (
                                      <button type="button" key={`${kind}-${c.name}`}
                                        className={`bx-sg preflight-suggestion${current ? ' on' : ''}`}
                                        title={`${suggestionLabel(c.why)} · ${c.confidence}`}
                                        onClick={() => setPreflightGate(prev => prev.map((g, j) => j === i ? editGateDraft(g, c.name) : g))}>
                                        <span className="bx-grow">
                                          <code>{c.name}</code>
                                          <small>{c.hasGolden ? '★ tested golden: parser and mapping reused' : '✦ AI writes the parser and mapping'} · {c.confidence} confidence</small>
                                        </span>
                                        {current && <span className="bx-pill teal">chosen</span>}
                                      </button>
                                    );
                                  })}
                                </Fragment>
                              );
                            })}
                          </div>
                          <div style={{ fontSize: 12, marginTop: 8 }}>
                            {isGateRowValidated(gate)
                              ? <span className="bx-path golden">Saved: {gate.confirmed!.outputSourcetype}</span>
                              : <span className="bx-muted">{gate.note || (gate.sanitised ? 'Sanitized. The chosen sample is what this row will use.' : 'Pick a suggestion, or edit the name, then confirm.')}</span>}
                          </div>
                        </div>
                      ) : (
                        <code>{row.canonical}</code>
                      )}
                      <div style={{ fontSize: 12, marginTop: 8 }} className="bx-muted">
                        Recognition:{' '}
                        {row.aiChecking ? <><span className="bx-spin" /> checking…</>
                          : row.recognized === 'unknown' ? <span className="bx-path none" title={row.reason}>✕ Unrecognized</span>
                          : row.recStatus === 'catalogue_gap' ? <span title={row.description || row.evidence}>◆ {row.vendor && row.product ? `${row.vendor} ${row.product}` : row.product || row.vendor || 'Recognized'} (no golden)</span>
                          : <span>✓ {row.tier === 'exact' ? 'Exact' : row.tier === 'alias' ? 'Alias' : row.tier === 'ai-content' ? 'AI (sample)' : row.tier.startsWith('ai') ? 'AI (name)' : 'Fuzzy'}</span>}
                      </div>
                      {/* Schema advice, derived from the resolved sourcetype. cim /
                          sentinel offer alternative pills; ocsf/asim show the class. */}
                      {row.recognized !== 'unknown' && row.destFormat && ['cim', 'ocsf', 'asim', 'ecs', 'sentinel'].includes(row.destFormat) && (
                        <div style={{ fontSize: 12, marginTop: 8 }}>
                          <span className="bx-muted">Schema: </span>
                          <b>{row.destFormat.toUpperCase()}</b>{' '}
                          {schemaOf(row) || <span className="bx-muted">{row.destFormat === 'ocsf' || row.destFormat === 'asim' ? 'auto (from sample)' : 'generic'}</span>}
                          {row.schemaAlts && row.schemaAlts.length > 1 && (
                            <div className="bx-schema">
                              {row.schemaAlts.map(m => (
                                <button key={m} type="button" className={`bx-fc${(row.schemaOverride || row.schemaModel) === m ? ' on' : ''}`}
                                  title="Pick this schema model" onClick={() => patchStRow(i, { schemaOverride: m })}>
                                  {m.replace(/^asim#/, '').replace(/_/g, ' ')}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="bx-dr-sec">
                      <h4>What happens in the build</h4>
                      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{rich(ex.next)}</div>
                      {row.recognized !== 'unknown' && (row.description || describeSourcetype(row.canonical)) && (
                        <div className="bx-muted" style={{ fontSize: 12, marginTop: 6 }}>{row.description || describeSourcetype(row.canonical)}</div>
                      )}
                    </div>
                  </div>
                  <div className="bx-dr-f">
                    <button type="button" className="bx-btn sm danger" onClick={() => { removePreflightRows([i]); const a = stp.afterConfirm; setCheckSel(a == null ? null : a > i ? a - 1 : a); }}>Remove row</button>
                    <span className="bx-grow" />
                    {gate && !isGateRowValidated(gate) ? (
                      <button type="button" className="bx-btn primary" disabled={!confirmable} onClick={() => confirmAndNext(i)}>
                        Confirm {gate.draft.trim() ? <code style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }}>{gate.draft.trim()}</code> : ''} {stp.afterConfirm != null ? '& next →' : ''}
                      </button>
                    ) : (
                      <button type="button" className="bx-btn" onClick={() => setCheckSel(openQ[0] ?? null)}>{openQ.length ? 'Next decision →' : 'Close'}</button>
                    )}
                  </div>
                </aside>
              );
            })()}

            <StepNav>
              <button className="back" onClick={() => { setStep('batch-upload'); resetPreflightState(); setCheckSel(null); }}>Back</button>
              <button
                disabled={preflightRunning || preflightSourcetypes.some(r => r.recognized === 'unknown') || !sourcetypeGateOpen}
                title={preflightRunning ? 'Available when the check finishes' : sourcetypeGateOpen ? 'Uses the chosen samples; finds a library sample for rows without one, then continues' : 'Confirm a sourcetype for every row first'}
                className={preflightRunning ? 'bx-next-busy' : undefined}
                onClick={() => { setCheckSel(null); void completeBatchPreflight(); }}
              >{preflightRunning
                ? <><span className="bx-spin" aria-hidden /> {preflightBusyView(preflightPhase, preflightProgress).short}</>
                : 'Next: Select Worker Group'}</button>
            </StepNav>
          </div>
        );
      }

      case 'batch-running': {
        const counts = buildCounts(batchResults);
        const cards = packCards(batchResults, toKebab);
        const predictedPath = (r: BatchResult): 'golden' | 'ai' => {
          try { return hasGoldenFormatPath(r.row.sourcetype, r.row.dest_format) ? 'golden' : 'ai'; } catch { return 'ai'; }
        };
        const open = batchResults.filter(r => !isSettled(r) && !needsYou(r));
        const left = batchRunning ? measuredTimeLeft(
          timedRows(batchResults),
          { golden: open.filter(r => predictedPath(r) === 'golden').length, ai: open.filter(r => predictedPath(r) === 'ai').length },
          { concurrency: batchConcurrency, background: false },
          loadRowTimings(),
        ) : null;
        const now = batchResults.map((r, i) => ({ r, i })).filter(x => x.r.status === 'running' || (!isSettled(x.r) && !needsYou(x.r) && x.r.phase && x.r.phase !== 'queued'));
        const parked = batchResults.map((r, i) => ({ r, i })).filter(x => needsYou(x.r));
        const pb = (s: number | null | undefined) => s == null ? '' : s >= 85 ? 'good' : s >= 60 ? 'warn' : 'fail';
        const ems = (result: BatchResult) => {
          const ss = result.stageScores;
          if (!ss && result.status === 'success' && result.score == null) {
            const awaitingQuality = result.phase === 'deployed';
            const scoring = result.phase === 'scoring' || result.phase === 'repairing';
            return (
              <span className="bx-ems batch-score-pill batch-score-static" title={awaitingQuality ? 'Deployed; quality check queued' : 'Building…'}>
                {awaitingQuality ? 'queued' : scoring ? 'checking…' : 'building…'}
              </span>
            );
          }
          return (
            <span className="bx-ems demo-stage-scores">
              <span className={pb(ss?.extraction)} title="Extraction">E {ss?.extraction ?? '·'}</span>
              <span className={pb(ss?.mapping)} title="Mapping">M {ss?.mapping ?? '·'}</span>
              <span className={pb(ss?.optimization)} title="Output shaping">S {ss?.optimization ?? '·'}</span>
            </span>
          );
        };
        const rail = (result: BatchResult) => (
          <ol className="bx-rail" aria-label={`Stage: ${batchPhaseLabel(result.phase)}`}>
            {foregroundRail(result).map(s => (
              <li key={s.key} className={s.state === 'done' ? 'd' : s.state === 'active' ? 'a' : s.state === 'failed' ? 'x' : ''}
                data-state={s.state} aria-current={s.state === 'active' ? 'step' : undefined}>
                <span className="m" aria-hidden="true" />{s.label}
              </li>
            ))}
          </ol>
        );
        // Every per-row control of the old list, unchanged: Switch/Keep for a
        // parked schema choice, Upload sample/Skip for a parked sample, Rerun
        // on a failure (even mid-run: independent per-row action pool, ≤
        // MAX_ROW_ACTIONS), Improve/Show once the batch has finished, traces.
        const actions = (result: BatchResult, i: number) => (
          <span className="bx-ra batch-row-actions">
            {result.status === 'awaiting-confirmation' && result.schemaSuggestion && (
              <>
                <button className="bx-btn sm primary" disabled={batchRowBusy.has(i) || batchRowBusy.size >= MAX_ROW_ACTIONS}
                  title={`Build this pack as ${result.schemaSuggestion.suggested.toUpperCase()} (sample-suggested)`}
                  onClick={() => resolveBatchSchemaRow(i, true, selectedGroup)}>
                  {batchRowBusy.has(i) ? '…' : `Switch to ${result.schemaSuggestion.suggested.toUpperCase()}`}
                </button>
                <button className="bx-btn sm" disabled={batchRowBusy.has(i) || batchRowBusy.size >= MAX_ROW_ACTIONS}
                  title={`Keep the chosen ${result.schemaSuggestion.current.toUpperCase()} format`}
                  onClick={() => resolveBatchSchemaRow(i, false, selectedGroup)}>
                  Keep {result.schemaSuggestion.current.toUpperCase()}
                </button>
              </>
            )}
            {result.status === 'awaiting-sample' && (
              <>
                <button className="bx-btn sm primary" disabled={batchRowBusy.has(i)}
                  title="Upload a sample log file for this sourcetype"
                  onClick={() => triggerBatchSampleUpload(i)}>
                  ⇪ Add sample
                </button>
                <button className="bx-btn sm" disabled={batchRowBusy.has(i)}
                  title="Skip this row — no pack will be created"
                  onClick={() => skipBatchRow(i)}>
                  Skip
                </button>
              </>
            )}
            {result.status === 'error' && (
              <button className="bx-btn sm" disabled={batchRowBusy.has(i) || batchRowBusy.size >= MAX_ROW_ACTIONS}
                title="Rerun this pipeline from scratch (runs alongside the batch)"
                onClick={() => rerunBatchRow(i, selectedGroup)}>
                {batchRowBusy.has(i) ? '…' : 'Rerun'}
              </button>
            )}
            {!batchRunning && result.status === 'success' && result.score != null && (
              <>
                <button className="bx-btn sm" disabled={batchRowBusy.has(i) || (batchRowBusy.size >= MAX_ROW_ACTIONS && !batchRowBusy.has(i))}
                  title="Re-run the repair process on this pipeline"
                  onClick={() => improveBatchRow(i, selectedGroup)}>
                  {batchRowBusy.has(i) ? '…' : 'Improve'}
                </button>
                <button className="bx-btn sm" title="Show the score report"
                  onClick={() => batchScoreOpen === i ? setBatchScoreOpen(null) : void showBatchRow(i)}>
                  {batchScoreOpen === i ? 'Hide' : 'Show'}
                </button>
              </>
            )}
            {renderBatchTraceActions(i)}
          </span>
        );
        const packCount = cards.length;
        const fgReport = foregroundReportAvailability(foregroundReportRows(), batchRunning, counts);
        return (
          <div className="step bx">
            <div className="bx-fbh">
              <div className="bx-fbh-main">
                <span className="bx-pill teal">⚡ In this tab · {batchConcurrency} at a time</span>
                <h2>{batchRunning ? (batchSamplePrep ? 'Creating samples for' : 'Building') : 'Built'} {packCount} pack{packCount === 1 ? '' : 's'} into {selectedGroup}</h2>
                <p>Preparing, deploying and verifying {batchResults.length} pipeline{batchResults.length === 1 ? '' : 's'}. Keep this tab open; checkpoints let an interrupted run resume.</p>
              </div>
              <div className="bx-stats batch-stage-strip" aria-label="Batch progress by phase">
                <div><b>{counts.building}</b><span>building</span></div>
                <div className="g"><b>{counts.built}</b><span>built</span></div>
                <div className="a"><b>{counts.needYou}</b><span>need you</span></div>
                <div className="r"><b>{counts.failed}</b><span>failed</span></div>
                <div><b>{counts.queued}</b><span>queued</span></div>
              </div>
              {!batchRunning ? (
                <div className="bx-goat batch-progress batch-done-block" role="status">
                  {/* Finished: a still, celebrating goat instead of the bar, so
                      "done" can't be mistaken for "nearly done". */}
                  <span className="celebrate-goat batch-done-goat"><img className="celebrate-goat-img" src={goatImg} alt="Happy Cribl goat — batch finished" /></span>
                  <div className="batch-done-text">
                    <b>✓ Done</b>
                    <small>{counts.settled} / {counts.total} settled · {counts.built} built{counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''}{counts.failed > 0 ? ` · ${counts.failed} failed` : ''}{counts.needYou > 0 ? ` · ${counts.needYou} need you` : ''}</small>
                    {!fgReport.ok && <small className="batch-done-noreport">{fgReport.reason}</small>}
                  </div>
                  <div className="batch-done-actions">
                    <button type="button" className="bx-btn batch-fg-report-btn" disabled={!fgReport.ok || batchReportBusy}
                      title={fgReport.ok ? 'Open the scoring report for every pipeline built in this run' : fgReport.reason}
                      onClick={handleViewForegroundBatchReport}>
                      {batchReportBusy ? 'Building report…' : 'View scoring report'}
                    </button>
                    <button type="button" className="bx-btn primary" onClick={() => setStep('batch-done')}>Continue</button>
                  </div>
                  {batchReportError && <div className="error-box" role="alert">{batchReportError}</div>}
                </div>
              ) : (
              <div className="bx-goat batch-progress">
                {/* While the batch is running the goat grazes continuously
                    (indeterminate) — it doesn't track % done. */}
                <GoatBar label="Batch deployment in progress" />
                <small className="batch-progress-label" title={left?.basis}>
                  {counts.settled} / {counts.total} settled
                  {batchRunning && (left ? ` · ${left.label} (measured)` : ' · time left after the first rows')}
                </small>
                {batchRunning && (
                  <span className="batch-stop-row">
                    <button className="bx-btn sm danger" disabled={batchStopping} onClick={handleStopBatch}>
                      {batchStopping ? 'Stopping — finishing rows already in progress…' : '■ Stop'}
                    </button>
                    <button className="bx-btn sm danger" onClick={handleKillBatch}
                      title="End the run now without waiting for rows in flight. Nothing is committed.">
                      {killArmed === 'fg' ? KILL_CONFIRM_LABEL : KILL_LABEL}
                    </button>
                  </span>
                )}
              </div>
              )}
            </div>

            {/* Stage 1 of the run, before any pack builds: the samples the check
                screen queued. Same panel as the check screen's busy state, so
                "the app is working on it" looks the same everywhere. */}
            {batchRunning && batchSamplePrep && (() => {
              const p = batchSamplePrep;
              const pct = p.total > 0 && p.done > 0 ? Math.round((p.done / p.total) * 100) : null;
              const what = [
                p.generate > 0 ? `generating ${p.generate} sample${p.generate === 1 ? '' : 's'} with AI` : '',
                p.extend > 0 ? `extending ${p.extend} thin sample${p.extend === 1 ? '' : 's'}` : '',
              ].filter(Boolean).join(' and ');
              return (
                <div className="bx-busy batch-sample-stage" role="status" aria-live="polite" aria-busy="true">
                  <div className="bx-busy-top">
                    <span className="bx-spin lg" aria-hidden />
                    <div className="bx-grow">
                      <div className="bx-busy-title">Creating samples…</div>
                      <div className="bx-busy-hint">First {what}, so every pack builds from real-looking events. Packs start building when this is done. AI takes a minute or more per sample.</div>
                    </div>
                    <div className="bx-busy-count">
                      <b>{pct != null ? `${pct}%` : '…'}</b>
                      <span>{p.done} of {p.total} · <ElapsedSince since={p.since} /></span>
                    </div>
                  </div>
                  <div className={`bx-bar lg${pct != null ? '' : ' indeterminate'}`}><b style={pct != null ? { width: `${pct}%` } : undefined} /></div>
                  <ol className="bx-stages" aria-label="Run stages">
                    <li className="now"><span className="dot">1</span>Create samples</li>
                    <li className="todo"><span className="dot">2</span>Build, deploy and score {packCount} pack{packCount === 1 ? '' : 's'}</li>
                  </ol>
                  <button type="button" className="bx-btn sm batch-sample-skip" onClick={() => { batchSampleSkip.current = true; }}>
                    Start building now: rows without a sample generate their own
                  </button>
                </div>
              );
            })()}

            {batchRunning && now.length > 0 && (
              <div className="bx-now">
                <span className="pulse" />
                <span><b>Now:</b> <span className="what">{now.slice(0, batchConcurrency).map(x => `${x.r.row.pipeline_name || x.r.row.pack_name} (${batchPhaseLabel(x.r.phase).toLowerCase()})`).join(' · ')}</span></span>
              </div>
            )}

            {parked.length > 0 && (
              <div className="bx-needs">
                <div className="bx-needs-h">
                  <span className="bx-mk warn">!</span>
                  <h4>{parked.length} row{parked.length === 1 ? ' needs' : 's need'} you</h4>
                  <span className="bx-muted" style={{ fontSize: 12 }}>The rest of the batch keeps building meanwhile.</span>
                </div>
                {parked.map(({ r, i }) => (
                  <div key={i} className="bx-nd">
                    <span><b>Row {i + 1}</b> · {r.row.pack_name} · <code>{r.row.sourcetype}</code> · {r.status === 'awaiting-sample'
                      ? 'no sample could be found or generated'
                      : r.schemaSuggestion ? `the sample looks like ${r.schemaSuggestion.dataClass} data, which fits ${r.schemaSuggestion.suggested.toUpperCase()} better than ${r.schemaSuggestion.current.toUpperCase()}` : 'needs a decision'}</span>
                    <span className="acts">{actions(r, i)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="batch-results">
              {cards.map(card => (
                <div key={card.id} className={`bx-packcard ${card.state}`}>
                  <div className="bx-pc-h">
                    <b>{card.name}</b><code>{card.id}</code>
                    <span className="bx-muted" style={{ fontSize: 11.5 }}>{card.rows.length} pipeline{card.rows.length === 1 ? '' : 's'}</span>
                    <span className={`state ${card.state}`}>{card.stateLabel}</span>
                  </div>
                  {card.rows.map(i => {
                    const result = batchResults[i];
                    const failed = result.status === 'error';
                    return (
                      <div key={i}>
                        <div className={`bx-pr batch-result-row ${needsYou(result) ? 'batch-awaiting' : !isSettled(result) ? 'batch-running' : `batch-${result.status}`}`}>
                          <div className="nm">
                            <b>{i + 1}. {result.row.pipeline_name || result.row.pack_name}</b>
                            <small><code>{result.row.sourcetype}</code> → {result.row.dest_format.toUpperCase()}</small>
                            {result.message && <small className={`why${failed ? ' err' : ''}`} style={needsYou(result) || failed ? undefined : { color: 'var(--pg-muted)' }}>{result.message}</small>}
                          </div>
                          {result.status === 'skipped' ? <span className="bx-muted">Skipped</span> : rail(result)}
                          {ems(result)}
                          {actions(result, i)}
                        </div>
                        {batchScoreOpen === i && <div className="bx-row-detail">{renderInlineReport(i)}</div>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <details className="bx-logbox">
              <summary>Activity log ({batchResults.filter(r => r.message).length})</summary>
              <div className="bx-log">
                {batchResults.map((r, i) => r.message && (
                  <div key={i} className={r.status === 'error' ? 'err' : r.status === 'success' && r.phase === 'done' ? 'ok' : 'dim'}>
                    #{i + 1} {r.row.pack_name} · {r.status === 'error' ? 'failed' : batchPhaseLabel(r.phase).toLowerCase()} · {r.message}
                  </div>
                ))}
              </div>
            </details>

            {!batchRunning && (
              <StepNav>
                <button onClick={() => setStep('batch-done')}>Continue</button>
              </StepNav>
            )}
          </div>
        );
      }

      case 'batch-bg-running': {
        // The whole screen is one projection of the durable manifest — status,
        // affordances, counts, ordering and per-row phase all come from
        // `buildBackgroundRunView` so nothing rendered here can disagree with
        // what is actually in KV, and a read that failed cannot present itself
        // as progress.
        const run = buildBackgroundRunView(batchBgCheckpoint, { read: batchBgRead });
        const railFor = (r: typeof run.groups[number]['rows'][number]) => (
          <ol className="stage-rail" aria-label={`Stage ${r.railPosition} of ${r.railTotal} — ${r.phaseLabel}`}>
            {r.rail.map(s => (
              <li key={s.key} data-state={s.state} aria-current={s.state === 'active' ? 'step' : undefined}>
                <span className="stage-rail-mark" aria-hidden="true" />
                <span className="stage-rail-label">{s.label}</span>
              </li>
            ))}
          </ol>
        );
        return (
          <div className="step bx">
            <div className="bx-fbh">
            <div className="bx-fbh-main">
            <span className="bx-pill v">☾ In the background · 1 row at a time</span>
            <h2>{run.final ? 'Background batch — final report' : 'Background batch — progress'}</h2>
            <p className="step-desc">
              {run.runId
                ? <><strong>{run.statusLabel}</strong> against <strong>{run.workerGroup}</strong>.{' '}
                    {/* A vanished run says what it means once, in the error
                        region below — not twice. */}
                    {run.read.status === 'missing' || run.read.status === 'unreadable'
                      ? ''
                      : run.statusDetail}</>
                : 'No background run is recorded for this session.'}
            </p>
            </div>
            {run.runId && (() => {
              const rep = backgroundReportAvailability(run);
              return (
                <div className="bx-bgreport">
                  <button type="button" className="bx-btn primary" disabled={!rep.ok || batchReportBusy}
                    title={rep.ok ? `Open the scoring report for the ${rep.rows} built row${rep.rows === 1 ? '' : 's'}` : rep.reason}
                    onClick={() => void handleViewBatchReport(run)}>
                    {batchReportBusy ? 'Building report…' : 'View scoring report'}
                  </button>
                  {!rep.ok && <small>{rep.reason}</small>}
                </div>
              );
            })()}
            {run.runId && (
              <div className="bx-stats" aria-label="Background run tally">
                <div><b>{run.counts.running}</b><span>in flight</span></div>
                <div className="g"><b>{run.counts.succeeded}</b><span>built</span></div>
                <div className="r"><b>{run.counts.failed}</b><span>failed</span></div>
                <div><b>{run.counts.skipped}</b><span>skipped</span></div>
                <div><b>{Math.max(0, run.counts.total - run.counts.settled - run.counts.running)}</b><span>queued</span></div>
              </div>
            )}
            </div>

            {run.message && <div className="advice-box">{run.message}</div>}
            {/* A manifest that is gone is an error with a next step, not a run
                that is quietly still working. A read that merely failed is a
                notice: the run is very likely still ticking. */}
            {(run.read.status === 'missing' || run.read.status === 'unreadable')
              && <div className="error-box" role="alert">{run.read.message}</div>}
            {run.read.status === 'unavailable' && <div className="advice-box" role="status">{run.read.message}</div>}
            {batchBgNotice && <div className="error-box" role="alert">{batchBgNotice}</div>}

            <dl className="bg-run-meta bx-bgmeta">
              <div><dt>Status</dt><dd>{run.statusLabel}</dd></div>
              <div><dt>Last update</dt><dd>{run.lastUpdateLabel || '—'}</dd></div>
              <div><dt>Schedule</dt><dd>{run.schedule.label}</dd></div>
              <div><dt>Initial deployment</dt><dd data-state={run.deployment.state}>{run.deployment.label}</dd></div>
              <div><dt>Repair deployment</dt>
                <dd data-state={run.repairDeployment?.state ?? 'not-needed'}>
                  {run.repairDeployment ? run.repairDeployment.label : 'Not needed'}
                </dd>
              </div>
              <div><dt>Settled</dt><dd>{run.counts.settled} / {run.counts.total}</dd></div>
            </dl>

            <div className="bg-run-progress bx-goat">
              <label htmlFor="bg-run-progress-bar">{run.progressLabel}</label>
              {/* Rows settled, never "the run stopped moving" — a parked or
                  failed run used to render a full bar and read as finished.
                  The figure is the model's own: two places deciding what
                  "progress" means is how a bar and its label disagree. */}
              <progress id="bg-run-progress-bar" max={100} value={run.progressPct ?? 0} />
              <span className="bg-run-tally">
                {run.counts.succeeded} built · {run.counts.failed} failed · {run.counts.skipped} skipped
                {run.counts.running ? ` · ${run.counts.running} in flight` : ''}
              </span>
            </div>

            {/* An unreadable run keeps the control and disables it: the
                operator WILL look for Stop, and "this run cannot be read" is a
                better answer than an empty space. A missing run does not — its
                document is gone, so there is nothing left to stop. */}
            {(run.active || run.read.status === 'unreadable') && (
              <div className="batch-stop-row">
                <button className="bx-btn sm danger" disabled={batchBgStopping || !run.stoppable} onClick={handleStopBatchBackground}>
                  {batchBgStopping ? BACKGROUND_STOPPING_LABEL : run.stopLabel}
                </button>
                {run.killable && (
                  <button className="bx-btn sm danger" disabled={batchBgKilling} onClick={() => void handleKillBatchBackground()}
                    title="End the run now: removes its schedule and marks it finished without waiting for a tick. Nothing is committed.">
                    {batchBgKilling ? 'Killing…' : killArmed === 'bg' ? KILL_CONFIRM_LABEL : KILL_LABEL}
                  </button>
                )}
              </div>
            )}

            {run.groups.map(g => (
              <section key={g.id} className="bg-run-group bx-card">
                <h3>{g.title}</h3>
                <p className="bg-run-group-desc">{g.description}</p>
                <table className="bg-run-table bx-t">
                  <thead>
                    <tr>
                      <th scope="col" className="bg-run-col-idx">#</th>
                      <th scope="col">Pack</th>
                      <th scope="col">Stage</th>
                      {g.id === 'quality' ? (
                        <>
                          <th scope="col">First</th>
                          <th scope="col">Final</th>
                          <th scope="col">Rounds</th>
                          <th scope="col">Golden</th>
                        </>
                      ) : (
                        <>
                          <th scope="col">Extract</th>
                          <th scope="col">Map</th>
                          <th scope="col">Shape</th>
                          <th scope="col">Overall</th>
                        </>
                      )}
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map(r => (
                      <Fragment key={r.rowId}>
                      <tr data-state={r.state}>
                        <td className="bg-run-col-idx" data-label="#">{r.position}</td>
                        <th scope="row" className="bg-run-name">
                          <span className="bg-run-pack">{r.packName}</span>
                          {(() => {
                            const base = criblInstanceBaseUrl();
                            if (!base || !run.workerGroup || !r.pipelineId) return null;
                            const href = pipelineVisualizerUrl(base, run.workerGroup, toKebab(r.packName), r.pipelineId);
                            return (
                              <PipelineVisualizerLink className="batch-score-visualizer" href={href} align="left" title={`Open ${r.packName} in the Pipeline Visualizer`}>
                                🔗
                              </PipelineVisualizerLink>
                            );
                          })()}
                          <span className="bg-run-route">{r.sourcetype} → {r.destFormat} · {r.actionLabel}</span>
                        </th>
                        <td className="bg-run-stage" data-label="Stage">
                          {r.terminal
                            ? <span className="bg-run-outcome" data-state={r.state}>{r.phaseLabel}</span>
                            : railFor(r)}
                          {r.attemptLabel && <span className="bg-run-attempt">{r.attemptLabel}</span>}
                        </td>
                        {g.id === 'quality' ? (
                          <>
                            <td className="bg-run-score" data-label="First">{formatScore(r.quality?.firstScore)}</td>
                            <td className="bg-run-score" data-label="Final">{formatScore(r.quality?.finalScore)}</td>
                            <td className="bg-run-score" data-label="Rounds">{r.quality ? r.quality.rounds : 'N/A'}</td>
                            <td className="bg-run-score" data-label="Golden">
                              {r.quality?.stored ? formatScore(r.quality.storedValue) : '—'}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="bg-run-score" data-label="Extract">{formatScore(r.scores.extraction)}</td>
                            <td className="bg-run-score" data-label="Map">{formatScore(r.scores.mapping)}</td>
                            <td className="bg-run-score" data-label="Shape">{formatScore(r.scores.optimization)}</td>
                            <td className="bg-run-score bg-run-overall" data-label="Overall">{formatScore(r.scores.overall)}</td>
                          </>
                        )}
                        <td className="bg-run-notes" data-label="Notes">
                          {/* A completed build row offers the scoring report
                              scoped to its own pack in place of "Built" — shown
                              as soon as the row completes, mid-run too. */}
                          {g.id === 'build' && r.state === 'success' && r.artifactKey ? (
                            <button
                              type="button"
                              className="bx-btn sm bg-run-pack-report"
                              disabled={batchReportBusy}
                              title={`${r.message} — open the scoring report for ${r.packName || r.pipelineId}`}
                              onClick={() => void handleViewBatchReport(run, r.packName || r.pipelineId || 'pack')}
                            >
                              Pack report
                            </button>
                          ) : r.message}
                          {r.quality && r.quality.trialScores.length > 0 && (
                            <span className="bg-run-trials"> Trials: {r.quality.trialScores.map(t => formatScore(t)).join(' → ')}.</span>
                          )}
                          {/* `quality.error` restates `message` for a failed
                              quality row — printing both put the same sentence
                              in the cell twice. */}
                          {r.quality?.error && r.quality.error !== r.message && (
                            <span className="bg-run-trials"> {r.quality.error}</span>
                          )}
                          {/* The scorecard detail is the row's UNBOUNDED
                              artifact, fetched only when opened — never polled
                              with the manifest. Build rows no longer expose it:
                              the whole-run scoring report below covers them in
                              full, so a per-row toggle is redundant. Quality
                              (Repair/Scorecard) rows keep it — their findings
                              are NOT in that report. */}
                          {g.id !== 'build' && (
                            <button
                              type="button"
                              className="link-btn bg-run-scorecard-toggle"
                              aria-expanded={bgScorecardRowId === r.rowId}
                              onClick={() => void toggleBgScorecard(r)}
                            >
                              {bgScorecardRowId === r.rowId ? 'Hide scorecard' : 'Show scorecard'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {g.id !== 'build' && bgScorecardRowId === r.rowId && (
                        <tr className="bg-run-detail-row" data-state={r.state}>
                          <td colSpan={8}>
                            {bgScorecard.loading && <p className="bg-run-detail-loading">Loading scorecard…</p>}
                            {/* A read that failed is its own state, never a
                                silent empty card (Hard Rule 32). */}
                            {bgScorecard.error && (
                              <p className="error-box" role="alert">Could not read the scorecard: {bgScorecard.error}</p>
                            )}
                            {!bgScorecard.loading && !bgScorecard.error && bgScorecard.card && (
                              bgScorecard.card.empty
                                ? <p className="batch-score-clean">No detail recorded yet — this row has not checkpointed a stage.</p>
                                : <div className="bg-run-scorecard">
                                    {bgScorecard.card.stages.map(s => (
                                      <div key={s.key} className="bg-run-scorecard-stage" data-band={s.band}>
                                        <strong>{s.label}: {formatScore(s.score)}</strong>
                                        {s.reasons.length > 0 && (
                                          <ul>{s.reasons.map((why, i) => <li key={i}>{why}</li>)}</ul>
                                        )}
                                      </div>
                                    ))}
                                    {bgScorecard.card.missingFields.length > 0 && (
                                      <div className="validation-fields"><strong>Missing:</strong> {bgScorecard.card.missingFields.join(', ')}</div>
                                    )}
                                    {bgScorecard.card.emptyFields.length > 0 && (
                                      <div className="validation-fields"><strong>Empty:</strong> {bgScorecard.card.emptyFields.join(', ')}</div>
                                    )}
                                    {bgScorecard.card.findings.length > 0 && (
                                      <ul className="validation-findings">
                                        {bgScorecard.card.findings.map((f, i) => (
                                          <li key={i} className={`finding-${f.severity}`}>
                                            <strong>{f.severity}</strong>
                                            {f.field && <> · <code>{f.field}</code></>} — {f.issue}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}

            {batchReportError && <div className="error-box" role="alert">{batchReportError}</div>}

            {/* The two things an operator does on this screen — see the report,
                and clear the run — as prominent primary buttons in one nav bar
                (the same teal CTA style as the wizard's Next/Deploy). View
                report shows as soon as any build row has settled, so it works on
                a still-running run too; Dismiss appears once the run is
                terminal. Finished, failed, parked and vanished all get the same
                escape — without it a failed run leaves a standing banner the
                operator cannot clear and an active-run pointer that refuses the
                next Start. The delete is awaited before the screen resets. */}
            {(run.counts.succeeded > 0 || run.dismissible || !batchBgCheckpoint) && (
              <StepNav>
                {run.counts.succeeded > 0 && (
                  <button
                    type="button"
                    disabled={batchReportBusy}
                    onClick={() => void handleViewBatchReport(run)}
                  >
                    {batchReportBusy ? 'Building report…' : 'View report'}
                  </button>
                )}
                {(run.dismissible || !batchBgCheckpoint) && (
                  <button
                    type="button"
                    className="bg-run-dismiss"
                    disabled={batchBgDismissing}
                    onClick={() => void handleDismissBatchBackground()}
                  >
                    {batchBgDismissing
                      ? 'Clearing…'
                      : batchBgCheckpoint ? 'Dismiss this run and start again' : 'Start Again'}
                  </button>
                )}
              </StepNav>
            )}
          </div>
        );
      }

      case 'batch-done': {
        const successes = batchResults.filter(r => r.status === 'success').length;
        const failures = batchResults.filter(r => r.status === 'error').length;
        const skipped = batchResults.filter(r => r.status === 'skipped').length;
        const awaitingSamples = batchResults.filter(r => r.status === 'awaiting-sample').length;
        const uniquePacks = new Set(batchResults.filter(r => r.status === 'success').map(r => r.row.pack_name)).size;
        const copyBatchLog = () => {
          const lines = batchResults.map((r, i) => {
            const ss = r.stageScores;
            const scores = ss ? `E ${ss.extraction ?? '-'} · M ${ss.mapping ?? '-'} · S ${ss.optimization ?? '-'}` : r.score != null ? `Score ${r.score}` : '';
            const status = r.status === 'success' ? 'Done' : r.status === 'error' ? 'FAILED' : r.status === 'skipped' ? 'Skipped' : r.status;
            const msg = r.message || '';
            return `${i + 1}\t${r.row.pack_name}\t${r.row.sourcetype}\t${r.row.dest_format}\t${status}\t${scores}\t${msg}`;
          });
          const header = `#\tPack\tSourcetype\tDest\tStatus\tScores\tMessage`;
          const summary = `\n--- Summary ---\nGroup: ${selectedGroup}\nSuccess: ${successes} | Failed: ${failures} | Skipped: ${skipped} | Packs: ${uniquePacks}\nBuild: ${(window as any).__BUILD_NUMBER || ''}`;
          void navigator.clipboard.writeText([header, ...lines, summary].join('\n'));
        };
        const scored = batchResults.filter(r => r.status === 'success' && r.score != null);
        const avg = scored.length ? Math.round(scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length) : null;
        const below = batchResults.map((r, i) => ({ r, i })).filter(x => x.r.status === 'success' && x.r.score != null && x.r.score < 85).map(x => x.i);
        const band = (s: number | null | undefined) => s == null ? '' : s >= 85 ? 'good' : s >= 60 ? 'warn' : 'fail';
        const bandColor = (s: number) => s >= 85 ? 'var(--pg-green)' : s >= 60 ? 'var(--pg-amber-ink)' : 'var(--pg-red)';
        const took = batchRunSpan?.end ? formatDuration(batchRunSpan.end - batchRunSpan.start).replace(/^~/, '') : null;
        const shown = batchResults.map((r, i) => ({ r, i })).filter(({ r, i }) =>
          resultsFilter === 'improve' ? below.includes(i)
            : resultsFilter === 'failed' ? r.status === 'error' || r.status === 'awaiting-sample'
            : true);
        // Improve every row below 85 through the same per-row action pool as
        // the single Improve button: at most MAX_ROW_ACTIONS at once, counting
        // any row action that is already running.
        const improveAll = async (rows: number[]) => {
          const q = [...rows];
          const lanes = Math.min(q.length, Math.max(1, MAX_ROW_ACTIONS - batchRowBusy.size));
          await Promise.all(Array.from({ length: lanes }, async () => {
            while (q.length) await improveBatchRow(q.shift()!, selectedGroup);
          }));
        };
        const ems = (result: BatchResult) => {
          const ss = result.stageScores;
          if (!ss) return <span className="bx-muted">—</span>;
          return (
            <span className="bx-ems demo-stage-scores" title="Extraction · Mapping · Output shaping — click Show for detail">
              <span className={band(ss.extraction)}>E {ss.extraction ?? '·'}</span>
              <span className={band(ss.mapping)}>M {ss.mapping ?? '·'}</span>
              <span className={band(ss.optimization)}>S {ss.optimization ?? '·'}</span>
            </span>
          );
        };
        const scoreCell = (result: BatchResult, i: number) => {
          if (result.status === 'success' && result.score == null) {
            return <span className="batch-score-pill batch-score-static" title="Scoring in progress">scoring…</span>;
          }
          if (result.status !== 'success' || result.score == null) return <span className="bx-muted">—</span>;
          return (
            <button type="button" className={`bx-scorebar batch-score-pill score-${band(result.score)}`}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
              title="Show the score report"
              onClick={e => { e.stopPropagation(); if (batchScoreOpen === i) setBatchScoreOpen(null); else void showBatchRow(i); }}>
              <b>{result.score}</b>
              <span className="sb"><i style={{ width: `${result.score}%`, background: bandColor(result.score) }} /></span>
            </button>
          );
        };
        // Every row control of the old results list, unchanged.
        const actions = (result: BatchResult, i: number) => (
          <span className="bx-ra batch-row-actions" onClick={e => e.stopPropagation()}>
            {result.status === 'success' && result.score != null && (
              <>
                <button className="bx-btn sm" disabled={batchRowBusy.has(i) || (batchRowBusy.size >= MAX_ROW_ACTIONS && !batchRowBusy.has(i))}
                  title="Re-run the repair process on this pipeline"
                  onClick={() => improveBatchRow(i, selectedGroup)}>
                  {batchRowBusy.has(i) ? '…' : '✦ Improve'}
                </button>
                <button className="bx-btn sm"
                  title="Show the score report"
                  onClick={() => batchScoreOpen === i ? setBatchScoreOpen(null) : void showBatchRow(i)}>
                  {batchRowBusy.has(i) && batchScoreOpen === i ? '…' : batchScoreOpen === i ? 'Hide' : 'Show'}
                </button>
              </>
            )}
            {result.status === 'awaiting-sample' && (
              <>
                <button className="bx-btn sm primary" disabled={batchRowBusy.has(i)}
                  title="Upload a sample log file for this sourcetype"
                  onClick={() => triggerBatchSampleUpload(i)}>
                  ⇪ Upload sample
                </button>
                <button className="bx-btn sm" disabled={batchRowBusy.has(i)}
                  title="Skip this row — no pack will be created"
                  onClick={() => skipBatchRow(i)}>
                  Skip
                </button>
              </>
            )}
            {result.status === 'error' && (
              <button className="bx-btn sm" disabled={batchRowBusy.has(i) || batchRowBusy.size >= MAX_ROW_ACTIONS}
                title="Rerun this pipeline from scratch"
                onClick={() => rerunBatchRow(i, selectedGroup)}>
                {batchRowBusy.has(i) ? '…' : 'Rerun'}
              </button>
            )}
            {renderBatchTraceActions(i)}
          </span>
        );
        const sel = resultsSel != null ? batchResults[resultsSel] : undefined;
        const fgDoneReport = foregroundReportAvailability(foregroundReportRows(), false, { built: successes, skipped, failed: failures });
        return (
          <div className="step bx">
            <div className="bx-res-h">
              <span className="goatb"><img src={goatImg} alt="Celebrating Cribl Goat" /></span>
              <div style={{ flex: 1, minWidth: 260 }}>
                <h2>{failures === 0 && awaitingSamples === 0 ? 'Batch complete' : 'Batch finished, with rows to look at'}</h2>
                <p>
                  <strong>{uniquePacks}</strong> pack{uniquePacks !== 1 ? 's' : ''} deployed with <strong>{successes}</strong> pipeline{successes !== 1 ? 's' : ''}{failures > 0 ? `, ${failures} failed` : ''}{skipped > 0 ? `, ${skipped} skipped` : ''}{awaitingSamples > 0 ? `, ${awaitingSamples} awaiting sample` : ''}
                  {' '}into <code>{selectedGroup}</code>{took ? ` · took ${took}` : ''}.
                </p>
                {!fgDoneReport.ok && <p className="batch-done-noreport">{fgDoneReport.reason}</p>}
                {batchReportError && <div className="error-box" role="alert">{batchReportError}</div>}
              </div>
              <button type="button" className="bx-btn primary batch-fg-report-btn" disabled={!fgDoneReport.ok || batchReportBusy}
                title={fgDoneReport.ok ? 'Open the scoring report for every pipeline built in this run' : fgDoneReport.reason}
                onClick={handleViewForegroundBatchReport}>
                {batchReportBusy ? 'Building report…' : 'View scoring report'}
              </button>
              <div className="bx-menu batch-export-actions">
                <button className="bx-btn" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen(o => !o)}>Export ▾</button>
                {exportOpen && (
                  <div className="bx-menu-l" role="menu" onClick={() => setExportOpen(false)}>
                    <button role="menuitem" className="batch-copy-log-btn" onClick={copyBatchLog} title="Copy full results as tab-separated text">
                      Copy log to clipboard<small>Tab-separated, one line per pipeline</small>
                    </button>
                    <button role="menuitem" className="batch-copy-log-btn" onClick={() => downloadBatchResults(batchResults, batchTraces, 'csv', selectedGroup)}
                      title="One row per pipeline: stage scores and sources, reasons (incl. the OCSF check), sample tier and wire format, function counts (Parser / regex_extract / code, ungated extractors), timings">
                      Download results (CSV)<small>Scores, reasons, sample tier, function counts, timings</small>
                    </button>
                    <button role="menuitem" className="batch-copy-log-btn" onClick={() => downloadBatchResults(batchResults, batchTraces, 'json', selectedGroup)}
                      title="The same records as the CSV, as JSON">
                      Download results (JSON)<small>The same records as the CSV</small>
                    </button>
                    <button role="menuitem" className="batch-copy-log-btn" disabled={Object.keys(batchTraces).length === 0}
                      onClick={() => downloadBuildTrace(Object.keys(batchTraces).map(Number).sort((a, b) => a - b).map(k => batchTraces[k]), `batch-${selectedGroup}`)}
                      title="Every row's build trace in one file — sample events, candidate decisions, stage scores, final functions. Review before sharing.">
                      Download all traces (JSON)<small>Contains sample events. Review before sharing.</small>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="bx-rtiles">
              <div className="bx-rtile"><b>{uniquePacks}</b><span>packs built</span></div>
              <div className="bx-rtile">
                <b className="good">{successes}<small style={{ fontSize: 13, color: 'var(--pg-muted)' }}> / {batchResults.length}</small></b><span>pipelines deployed</span>
                <div className="meter"><i style={{ width: `${batchResults.length ? Math.round(successes / batchResults.length * 100) : 0}%` }} /></div>
              </div>
              <div className="bx-rtile"><b className={band(avg)}>{avg ?? '—'}</b><span>average score</span></div>
              <div className="bx-rtile"><b className={below.length ? 'warn' : ''}>{below.length}</b><span>below 85</span></div>
              <div className="bx-rtile"><b className={failures + awaitingSamples ? 'fail' : ''}>{failures + awaitingSamples}</b><span>failed or need a sample</span></div>
            </div>

            <div className="bx-toolbar">
              <div className="bx-chips" style={{ marginBottom: 0 }}>
                {([['all', `All ${batchResults.length}`, ''], ['improve', `Below 85 · ${below.length}`, 'warn'], ['failed', `Failed · ${failures + awaitingSamples}`, 'err']] as const).map(([k, label, tone]) => (
                  <button key={k} type="button" className={`bx-fc ${tone}${resultsFilter === k ? ' on' : ''}`} aria-pressed={resultsFilter === k}
                    onClick={() => setResultsFilter(k)}>{label}</button>
                ))}
              </div>
              <span style={{ flex: 1 }} />
              {below.length > 0 && (
                <button className="bx-btn primary" disabled={batchRowBusy.size >= MAX_ROW_ACTIONS}
                  title={`Re-run the repair process on every pipeline below 85, ${MAX_ROW_ACTIONS} at a time`}
                  onClick={() => void improveAll(below)}>
                  ✦ Improve all {below.length} below 85
                </button>
              )}
            </div>

            <div className={sel ? 'bx-split' : undefined}>
              <div className="bx-t-scroll">
                <table className="bx-t batch-results">
                  <thead><tr><th>#</th><th>Pack · pipeline</th><th>Score</th><th>E · M · S</th><th>Sample</th><th>Time</th><th></th></tr></thead>
                  <tbody>
                    {shown.map(({ r: result, i }) => {
                      const scoring = result.status === 'success' && result.score == null && !result.stageScores;
                      const rowClass = scoring ? 'batch-running' : result.status === 'awaiting-sample' ? 'batch-awaiting' : `batch-${result.status}`;
                      return (
                        <Fragment key={i}>
                          <tr className={`click batch-result-row ${rowClass}${resultsSel === i ? ' sel' : ''}${result.status === 'error' ? ' bad' : ''}`}
                            onClick={() => setResultsSel(resultsSel === i ? null : i)}>
                            <td className="n">{i + 1}</td>
                            <td>
                              <b>{result.row.pack_name}</b>{result.row.pipeline_name && <> · {result.row.pipeline_name}</>}
                              <span className="sub2">
                                <code>{result.row.sourcetype}</code> → {result.row.dest_format}
                                {' · '}{result.status === 'success' ? (scoring ? 'Scoring...' : 'Deployed') : result.status === 'error' ? 'Failed' : result.status === 'skipped' ? 'Skipped' : result.status === 'awaiting-sample' ? 'Needs sample' : result.status}
                              </span>
                              {result.message && <span className="sub2 batch-result-msg">{result.message}</span>}
                            </td>
                            <td>{scoreCell(result, i)}</td>
                            <td>{ems(result)}</td>
                            <td>
                              {/* Sample provenance + row cost, so a result explains
                                  itself without a live-org post-mortem. */}
                              {result.sampleTier && result.sampleTier !== 'none' ? (
                                <span className="bx-pill batch-sample-tier" title={`Sample source: ${result.sampleReason || result.sampleTier}`}>{result.sampleTier}</span>
                              ) : <span className="bx-muted">—</span>}
                              {renderBatchFunctionFlags(i)}
                            </td>
                            <td>
                              {result.timings?.totalMs != null ? (
                                <span className="batch-row-time" title={`prepare ${Math.round((result.timings.prepareMs || 0) / 1000)}s · build ${Math.round((result.timings.buildMs || 0) / 1000)}s`}>
                                  {Math.round(result.timings.totalMs / 1000)}s
                                </span>
                              ) : <span className="bx-muted">—</span>}
                            </td>
                            <td>{actions(result, i)}</td>
                          </tr>
                          {batchScoreOpen === i && (
                            <tr><td colSpan={7} className="bx-row-detail">{renderInlineReport(i)}</td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {shown.length === 0 && (
                      <tr><td colSpan={7} className="bx-muted" style={{ textAlign: 'center', padding: 18 }}>No rows match this filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {sel && resultsSel != null && (
                <aside className="bx-drawer" aria-label={`Row ${resultsSel + 1} report`}>
                  <div className="bx-dr-h">
                    <div style={{ flex: 1 }}>
                      <b>{sel.row.pack_name}{sel.row.pipeline_name ? ` · ${sel.row.pipeline_name}` : ''}</b>
                      <small style={{ display: 'block', color: 'var(--pg-muted)' }}><code>{sel.row.sourcetype}</code> → {sel.row.dest_format}</small>
                    </div>
                    <button className="bx-x" aria-label="Close" onClick={() => setResultsSel(null)}>×</button>
                  </div>
                  <div className="bx-dr-b">
                    <div className="bx-dr-sec">
                      {sel.status === 'success' && sel.score != null ? (
                        <div className="bx-big-score"><b style={{ color: bandColor(sel.score) }}>{sel.score}</b><span className="bx-muted">/ 100</span></div>
                      ) : (
                        <div className="bx-big-score"><b>—</b><span className="bx-muted">{sel.status === 'error' ? 'failed' : sel.status === 'skipped' ? 'skipped' : sel.status === 'awaiting-sample' ? 'needs a sample' : 'scoring…'}</span></div>
                      )}
                      <div style={{ marginTop: 8 }}>{ems(sel)}</div>
                      {sel.message && <p style={{ fontSize: 12.5, margin: '10px 0 0' }}>{sel.message}</p>}
                    </div>
                    <div className="bx-dr-sec">
                      <dl className="bx-facts">
                        <dt>Sample</dt><dd>{sel.sampleTier && sel.sampleTier !== 'none' ? (sel.sampleReason || sel.sampleTier) : '—'}</dd>
                        <dt>Time</dt><dd>{sel.timings?.totalMs != null
                          ? `${Math.round(sel.timings.totalMs / 1000)}s (prepare ${Math.round((sel.timings.prepareMs || 0) / 1000)}s · build ${Math.round((sel.timings.buildMs || 0) / 1000)}s)`
                          : '—'}</dd>
                        <dt>Repaired</dt><dd>{sel.repairedAfterBuild ? 'Yes, after the build' : 'No'}</dd>
                      </dl>
                    </div>
                  </div>
                  <div className="bx-dr-f">
                    {sel.status === 'success' && sel.score != null && (
                      <button className="bx-btn" onClick={() => batchScoreOpen === resultsSel ? setBatchScoreOpen(null) : void showBatchRow(resultsSel)}>
                        {batchScoreOpen === resultsSel ? 'Hide full report' : 'Open full report'}
                      </button>
                    )}
                    <span style={{ flex: 1 }} />
                    {actions(sel, resultsSel)}
                  </div>
                </aside>
              )}
            </div>

            {/* Schema-validation report block removed (build 687) — superseded by
                the unified scoring report. ValidationPanel is @deprecated. */}

            <StepNav>
              <button onClick={resetAll}>
                Start Again
              </button>
            </StepNav>
          </div>
        );
      }
      case 'demo-group':
        return (
          <div className="step">
            <h2>Create Demo Environment — Worker Group</h2>
            <p className="step-desc">Choose the Stream worker group to build the demo on. Groups with no active workers cannot run a demo.</p>
            {workerHealthLoading && workerGroups.length === 0 ? (
              <div className="ai-loading"><div className="ai-spinner" /><span>Loading worker groups &amp; health…</span></div>
            ) : groupsError ? (
              <div className="error-box"><span>Could not load worker groups: {groupsError}</span><button onClick={fetchDemoGroupHealth}>Retry</button></div>
            ) : (
              <>
                <input type="text" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} placeholder="Search worker groups..." className="tile-search" />
                <div className="tile-group">
                  <span className="tile-group-label">Stream</span>
                  <div className="tile-grid">
                    {workerGroups
                      .filter(g => g.type === 'stream' && (g.name || g.id).toLowerCase().includes(groupFilter.toLowerCase()))
                      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
                      .map(g => {
                        const h = workerHealth[g.id];
                        const active = (h?.healthy || 0) > 0;
                        return (
                          <div
                            key={g.id}
                            className={active ? 'tile' : 'tile tile-disabled'}
                            style={active ? undefined : { borderColor: '#d4380d', opacity: 0.7, cursor: 'not-allowed' }}
                            onClick={() => {
                              if (!active) return;
                              setSelectedGroup(g.id);
                              update({ workerGroup: g.id });
                              setGroupFilter('');
                              setStep('demo-sources');
                            }}
                          >
                            <span className="tile-icon">{'⚙'}</span>
                            <strong className="tile-name">{g.name || g.id}</strong>
                            <span className="tile-meta">
                              {active
                                ? <span className="type-badge type-stream">{h.healthy}/{h.total} worker{h.total !== 1 ? 's' : ''} active</span>
                                : <span style={{ color: '#d4380d', fontSize: 12, fontWeight: 600 }}>No active workers — deploy a worker to this group first</span>}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </>
            )}
            <StepNav>
              <button className="back" onClick={() => setStep('mode')}>Back</button>
            </StepNav>
          </div>
        );

      case 'demo-sources':
        return (
          <div className="step">
            <h2>Demo Sources</h2>
            <p className="step-desc">Add the customer's sourcetypes (min 1, max {DEMO_MAX_SOURCES}). Each is validated. Toggle code functions per source if needed.</p>
            <div className="demo-cleanup-inline">
              <span>Cleaning up instead? Scan <code>{selectedGroup}</code> for an earlier demo to remove.</span>
              <button className="secondary-btn" onClick={() => void openDemoCleanup()}>Clean up demo environment</button>
            </div>
            <div className="custom-input-inline">
              <input
                type="text"
                value={demoSourceInput}
                onChange={(e) => { setDemoSourceInput(e.target.value); setDemoStMatches([]); setDemoSourceHint(''); setDemoSourceSuggestions([]); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void addDemoSource(); }}
                placeholder="e.g. cisco_asa, palo_alto_traffic, crowdstrike_falcon"
                disabled={demoSources.length >= DEMO_MAX_SOURCES}
              />
              <button className="confirm-btn" disabled={!demoSourceInput.trim() || demoSourceValidating || demoSources.length >= DEMO_MAX_SOURCES} onClick={() => void addDemoSource()}>
                {demoSourceValidating ? 'Validating…' : 'Add source'}
              </button>
            </div>
            {!demoSourceValidating && demoStMatches.length > 0 && (
              <div className="st-search-matches">
                <span className="st-search-label">Click a supported sourcetype to add it directly, or refine the name yourself and Add again:</span>
                <div className="st-search-list">
                  {demoStMatches.map((m) => (
                    <button key={m.name} className="st-search-item" title={m.description || m.name} onClick={() => addDemoSourceDirect(m.name)}>
                      {m.golden && <span className="st-search-star">{'★'}</span>}
                      <span className="st-search-name">{m.name}</span>
                      {m.description && <span className="st-search-desc">{m.description}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {demoSourceHint && <p className="gen-tier-note" style={{ color: '#d4380d', marginTop: 8 }}>{demoSourceHint}</p>}
            {demoSourceSuggestions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {demoSourceSuggestions.map(s => (
                  <button key={s} className="confirm-btn" onClick={() => addDemoSourceDirect(s)}>{s}</button>
                ))}
              </div>
            )}
            {demoSources.length > 0 && (
              <>
                <div className="demo-section-label">Selected sources<span className="demo-count-pill">{demoSources.length} / {DEMO_MAX_SOURCES}</span></div>
                <div className="demo-source-list">
                  {demoSources.map((src, i) => (
                    <div key={src.sourcetype} className="demo-source-card">
                      <span className="demo-source-num">{i + 1}</span>
                      <div className="demo-source-body">
                        <div className="demo-source-name">{src.sourcetype}</div>
                        <div className="demo-source-sub">{src.allowCodeFunctions ? 'Code functions allowed for this source' : 'Standard parsing (regex + eval)'}</div>
                      </div>
                      <label className="demo-code-toggle">
                        <input
                          type="checkbox"
                          checked={src.allowCodeFunctions}
                          onChange={(e) => setDemoSources(prev => prev.map((s, j) => j === i ? { ...s, allowCodeFunctions: e.target.checked } : s))}
                        />
                        Allow code functions
                      </label>
                      <button className="demo-source-remove" title="Remove source" onClick={() => setDemoSources(prev => prev.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                </div>
              </>
            )}
            <StepNav>
              <button className="back" onClick={() => setStep('demo-group')}>Back</button>
              <button disabled={demoSources.length === 0} onClick={() => setStep('demo-destinations')}>Next: Destinations</button>
            </StepNav>
          </div>
        );

      case 'demo-destinations': {
        // Cribl Lake and the Search experience are off for now (panels removed;
        // demoLakeSelected / demoCreateDashboard stay false).
        const flowBlocked = flowBlockedReason(demoDestFormats, demoPp);
        const sourceNames = demoSources.map(src => src.sourcetype);
        const targets = demoTargets(demoDestFormats, demoPp);
        const lakeOn = demoLakeSelected && !!demoLakeDataset;
        // Per-source choices live here: the canvas is the menu of formats, the
        // matrix below picks which source takes which (e.g. after OCSF one source
        // to Splunk, another to Elastic). Kept choices survive format changes.
        const liveCells = demoMergeCells(demoCells, demoDefaultCells(sourceNames, targets, lakeOn))
          .map(c => (!lakeOn && c.output === DEMO_LAKE_OUTPUT ? { ...c, output: 'devnull' } : c));
        const toggleCell = (st: string, key: string, enabled: boolean) =>
          setDemoCells(liveCells.map(c => (c.sourcetype === st && c.target === key ? { ...c, enabled } : c)));
        const previewPlan = planDemoFlow({ sources: sourceNames, destFormats: demoDestFormats, pp: demoPp, cells: liveCells });
        return (
          <div className="step">
            <h2>Demo destinations</h2>
            <p className="step-desc">The same flow as Build pack, for every source: each source gets one main pack with a pipeline per format (up to {DEMO_MAX_FORMATS}). Add OCSF to put post-processing packs behind it for more SIEMs.</p>
            <FlowDestination
              sourcetype={sourceNames.length === 1 ? sourceNames[0] : `${sourceNames.length} sources`}
              eventCount={0}
              sourceNote={sourceNames.length === 1 ? 'one main pack' : `${sourceNames.join(', ')} · one main pack each, choose per source below`}
              destOptions={FLOW_DEST_OPTIONS}
              destFormats={demoDestFormats}
              onAddDests={(fmts) => {
                const added = fmts.filter(f => !demoDestFormats.includes(f));
                const room = Math.max(0, DEMO_MAX_FORMATS - demoDestFormats.length);
                if (added.length > room) setDemoError(`The demo takes up to ${DEMO_MAX_FORMATS} formats — added the first ${room}.`);
                else setDemoError('');
                if (room) setDemoDestFormats([...demoDestFormats, ...added.slice(0, room)]);
              }}
              onRemoveDest={(fmt) => { setDemoError(''); setDemoDestFormats(demoDestFormats.filter(f => f !== fmt)); }}
              optimize={demoOptimize}
              onOptimize={(fmt, v) => setDemoOptimize(o => ({ ...o, [fmt]: v }))}
              srcRules={{}}
              ocsfKeepRaw={demoOcsfKeepRaw}
              onOcsfKeepRaw={setDemoOcsfKeepRaw}
              pp={demoPp}
              onPpChange={setDemoPp}
              defaultPpName="Demo"
            />
            {demoError && <p className="demo-lake-warn">{demoError}</p>}

            {/* Sticky: the canvas above is tall, and these choices (plus Next) must
                stay on screen while formats are added. */}
            <div className="demo-dest-footer">
              {targets.length > 0 && (
                <>
                  <div className="demo-section-label">Per source</div>
                  <div className="demo-src-scroll">
                    <table className="demo-plan-table demo-src-matrix">
                      <thead>
                        <tr>
                          <th>Source</th>
                          {targets.map(t => <th key={t.key} className={t.kind}>{t.kind === 'pp' ? <>OCSF →<br />{t.label.replace('OCSF → ', '')}</> : t.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {sourceNames.map(st => (
                          <tr key={st}>
                            <td><code>{st}</code></td>
                            {targets.map(t => {
                              const cell = liveCells.find(c => c.sourcetype === st && c.target === t.key);
                              return (
                                <td key={t.key} className={t.kind}>
                                  <input type="checkbox" aria-label={`${st} to ${t.label}`} checked={!!cell?.enabled} onChange={(e) => toggleCell(st, t.key, e.target.checked)} />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="demo-dashboard-note">Post-processing reads each source's OCSF pipeline: a source with only post-processing on still gets an OCSF pipeline in its pack, just no OCSF route of its own. Every datagen sends {DEMO_EVENTS_PER_SEC} events/s per source.</p>
                </>
              )}
              <div className="demo-route-summary">
                <span><b>{demoSources.length}</b> source{demoSources.length !== 1 ? 's' : ''}</span>
                <span>→ <b>{previewPlan.packs.length + previewPlan.ppPacks.length}</b> pack{previewPlan.packs.length + previewPlan.ppPacks.length !== 1 ? 's' : ''} ({previewPlan.packs.length} main{previewPlan.ppPacks.length ? `, ${previewPlan.ppPacks.length} post-processing` : ''})</span>
                <span>· <b>{previewPlan.lanes.length + (previewPlan.replaySourcetypes.length ? 1 : 0)}</b> datagen{previewPlan.lanes.length + (previewPlan.replaySourcetypes.length ? 1 : 0) !== 1 ? 's' : ''}</span>
                <span style={{ marginLeft: 'auto', color: '#8c8c8c' }}>≈ {demoEventsPerSecond(previewPlan)} events/s</span>
              </div>
              <StepNav>
                <button className="back" onClick={() => setStep('demo-sources')}>Back</button>
                <button
                  disabled={!!flowBlocked || previewPlan.packs.length === 0}
                  title={flowBlocked || (previewPlan.packs.length === 0 ? 'Turn on at least one source × output.' : undefined)}
                  onClick={() => {
                    setDemoCells(liveCells);
                    setDemoError('');
                    setStep('demo-routing');
                  }}
                >Next: Routing</button>
              </StepNav>
            </div>
          </div>
        );
      }

      case 'demo-routing': {
        const plan = currentDemoPlan();
        const targets = demoTargets(demoDestFormats, demoPp);
        const lakeOn = demoLakeSelected && !!demoLakeDataset;
        const setCell = (st: string, key: string, patch: Partial<DemoCell>) =>
          setDemoCells(prev => prev.map(c => (c.sourcetype === st && c.target === key ? { ...c, ...patch } : c)));
        const enabledCount = demoCells.filter(c => c.enabled).length;
        const outLabel = (o: string) => (o === DEMO_LAKE_OUTPUT ? `Cribl Lake · ${demoLakeDataset}` : o);
        return (
          <div className="step">
            <h2>Demo routing</h2>
            <p className="step-desc">Choose where each source × output goes (turn one off here or on the previous screen). Each main-pack format has its own datagen (its lane), so a route into the pack runs only that format's pipeline. Post-processing reads the OCSF replay datagen. Every datagen sends {DEMO_EVENTS_PER_SEC} events/s per source. All demo routes sit on top of the routing table and end in a terminator, so real data is untouched.</p>
            <div className="demo-route-summary">
              <span><b>{enabledCount}</b> output{enabledCount !== 1 ? 's' : ''} on</span>
              {demoCells.length - enabledCount > 0 && <span style={{ color: '#fa8c16' }}><b>{demoCells.length - enabledCount}</b> off</span>}
              <span style={{ marginLeft: 'auto', color: '#8c8c8c' }}>≈ {demoEventsPerSecond(plan)} events/s</span>
            </div>
            <div className="demo-route-list">
              {demoSources.map(src => (
                <div key={src.sourcetype} className="demo-route-group">
                  <div className="demo-section-label">{src.sourcetype}</div>
                  {targets.map(t => {
                    const cell = demoCells.find(c => c.sourcetype === src.sourcetype && c.target === t.key);
                    if (!cell) return null;
                    return (
                      <div key={t.key} className={cell.enabled ? 'demo-route-card' : 'demo-route-card disabled'}>
                        <label className="demo-route-toggle">
                          <input type="checkbox" checked={cell.enabled} onChange={(e) => setCell(src.sourcetype, t.key, { enabled: e.target.checked })} />
                        </label>
                        <div className="demo-route-main">
                          <span className="demo-route-src">{t.kind === 'pp' ? 'post-processing' : 'main pack'}</span>
                          <span className="demo-route-arrow">→</span>
                          <span className={t.kind === 'pp' ? 'demo-route-fmt pp' : 'demo-route-fmt'}>{t.label}</span>
                        </div>
                        <label className="demo-route-dest">
                          <span className="demo-route-dest-lbl">Destination</span>
                          <select
                            className="demo-route-dest-sel"
                            value={cell.output}
                            disabled={!cell.enabled}
                            onChange={(e) => setCell(src.sourcetype, t.key, { output: e.target.value })}
                          >
                            <option value="devnull">devnull (default — discard)</option>
                            {lakeOn && <option value={DEMO_LAKE_OUTPUT}>{outLabel(DEMO_LAKE_OUTPUT)}</option>}
                            {demoOutputs.filter(o => o.id !== 'devnull').map(o => (
                              <option key={o.id} value={o.id}>{o.id} ({o.type})</option>
                            ))}
                          </select>
                        </label>
                        {!cell.enabled && <span className="demo-route-disabled-tag">Off — this output gets no route</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="demo-section-label">Routes that will be written</div>
            <table className="demo-plan-table">
              <thead><tr><th>Route</th><th>Filter</th><th>Pipeline</th><th>Output</th></tr></thead>
              <tbody>
                {plan.routes.map(r => (
                  <tr key={r.id} className={r.kind}>
                    <td>{r.name.replace('[DEMO] ', '')}</td>
                    <td><code>{r.filter}</code></td>
                    <td><code>{r.pipeline}</code></td>
                    <td>{outLabel(r.output)}</td>
                  </tr>
                ))}
                <tr className="term">
                  <td>terminator — drop demo data</td>
                  <td><code>{plan.terminatorFilter}</code></td>
                  <td><code>devnull</code></td>
                  <td>devnull · final</td>
                </tr>
              </tbody>
            </table>
            {demoError && <div className="error-box" style={{ marginTop: 12 }}><span>{demoError}</span></div>}
            <StepNav>
              <button className="back" onClick={() => setStep('demo-destinations')}>Back</button>
              <button disabled={plan.packs.length === 0} onClick={() => void handleCreateDemo()}>
                Create Demo Environment
              </button>
            </StepNav>
          </div>
        );
      }

      case 'demo-deploying':
        return (
          <div className="step">
            <div className="demo-build-head">
              {!demoError && <span className="demo-build-spinner" />}
              <h2 style={{ margin: 0 }}>Building Demo Environment…</h2>
            </div>
            <p className="step-desc">Building one main pack per source (full quality checks), then OCSF post-processing, the datagens, and the routing table on <code>{selectedGroup}</code>. One deploy at the end makes it all live.</p>
            {demoResults.length > 0 && (
              <>
                {(() => {
                  const done = demoResults.filter(r => isBatchPhaseTerminal(r.phase)).length;
                  return (
                    <div className="demo-progress">
                      <GoatBar pct={(done / demoResults.length) * 100} label="Demo build progress" />
                      <span className="demo-progress-label">{done} / {demoResults.length} pipelines and packs complete</span>
                    </div>
                  );
                })()}
                <div className="demo-phase-list">
                  {demoResults.map((r, i) => {
                    const active = r.status === 'running';
                    const cls = r.status === 'error' ? 'err' : r.status === 'success' ? 'ok' : active ? 'run' : 'wait';
                    return (
                      <div key={i} className={`demo-phase-row ${cls}`}>
                        {active && <span className="demo-build-spinner sm" />}
                        <span className="demo-phase-name">{r.sourcetype}</span>
                        <span className="demo-route-arrow">to</span>
                        <span className={r.kind === 'pp' ? 'demo-route-fmt pp' : 'demo-route-fmt'}>{r.label}</span>
                        <span className="demo-phase-status">{r.status === 'error' ? 'Failed' : r.status === 'success' ? (r.stageScores ? `E ${r.stageScores.extraction ?? 'n/a'} · M ${r.stageScores.mapping ?? 'n/a'} · S ${r.stageScores.optimization ?? 'n/a'}` : r.score != null ? `Done · ${r.score}/100` : 'Done') : batchPhaseLabel(r.phase)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <div className="deploy-log" ref={deployLogRef}>
              {demoLog.map((line, i) => {
                const cls = /^✓|deployed|active|Committed|is live/i.test(line) ? 'good'
                  : /^✗|⚠|error|fail/i.test(line) ? 'bad'
                  : /^(Preparing|Creating|Ensuring|Writing|Building|Reusing|\[)/.test(line) || line.startsWith('•') ? 'head' : '';
                return <div key={i} className={`demo-log-line ${cls}`}>{line}</div>;
              })}
            </div>
            {demoError && <div className="error-box" style={{ marginTop: 12 }}><span>{demoError}</span><button onClick={() => setStep('demo-routing')}>Back to routing</button></div>}
          </div>
        );

      case 'demo-done': {
        const ok = demoResults.filter(r => r.status === 'success').length;
        const failed = demoResults.filter(r => r.status === 'error').length;
        return (
          <div className="step">
            <div className="celebrate-goat">
              <img src={goatImg} alt="Celebrating Cribl Goat" className="celebrate-goat-img" />
              <span className="celebrate-badge">Demo Ready!</span>
            </div>
            <h2>Demo Environment Live</h2>
            <div className="success-box">
              <p><strong>{ok}</strong> pipeline{ok !== 1 ? 's' : ''} and pack{ok !== 1 ? 's' : ''} deployed{failed > 0 ? `, ${failed} failed` : ''} on <code>{demoSummary?.group}</code>.</p>
              <p>Active datagens: {demoSummary?.datagenIds.map((id, i) => <span key={id}>{i > 0 && ', '}<code>{id}</code></span>)} — ≈ {demoSummary?.eventsPerSec} events/s from {demoSources.length} sourcetype(s).</p>
              {demoSummary?.replay && <p>Post-processing is fed by the OCSF replay datagen <code>{DEMO_OCSF_REPLAY_ID}</code> (recorded from each source's OCSF pipeline output).</p>}
              <p><strong>{demoSummary?.routeCount}</strong> isolated demo route(s) written on top of the routing table (final — real data untouched).</p>
              {demoSummary?.lakeOutput && <p>Cribl Lake output: <code>{demoSummary.lakeOutput}</code> → dataset <code>{demoLakeDataset}</code>.</p>}
              {demoDashboardResult?.name && <p>{demoDashboardStyle === 'vizlab' ? 'Viz-Lab' : 'Cribl Search'} dashboard: <strong>{demoDashboardResult.name}</strong> with {demoDashboardResult.kpiCount} AI-selected KPI(s) and {demoDashboardResult.datatypeIds?.length || 0} Datatype v1 parser(s).</p>}
              {demoDashboardResult?.error && <p className="demo-dashboard-error">Optional dashboard not deployed: {demoDashboardResult.error}</p>}
            </div>
            <div className="batch-results">
              {demoResults.map((r, i) => {
                const pillBand = (s: number | null | undefined) => s == null ? '' : s >= 85 ? 'good' : s >= 60 ? 'warn' : 'fail';
                const ss = r.stageScores;
                return (
                  <div key={i} className={`batch-result-row batch-${r.status}`}>
                    <span className="batch-result-idx">{i + 1}</span>
                    <span className="batch-result-name">{r.sourcetype}</span>
                    <span className="batch-result-detail">→ {r.label}{r.packId ? ` · ${r.packId}` : ''}</span>
                    <span className="batch-result-status">{r.status === 'success' ? 'Deployed' : 'Failed'}</span>
                    {demoFailureReason(r) && <span className="sub2 batch-result-msg" title={demoFailureReason(r) ?? ''}>{demoFailureReason(r)}</span>}
                    {/* Per-stage scores (Extraction · Mapping · Output shaping) —
                        same as the 3-stage build. Post-processing packs are
                        deterministic maps: no staged scores. */}
                    {ss ? (
                      <span className="demo-stage-scores">
                        <span className={`stage-pill score-${pillBand(ss.extraction)}`} title="Extraction">E {ss.extraction ?? 'n/a'}</span>
                        <span className={`stage-pill score-${pillBand(ss.mapping)}`} title="Mapping">M {ss.mapping ?? 'n/a'}</span>
                        <span className={`stage-pill score-${pillBand(ss.optimization)}`} title="Output shaping">S {ss.optimization ?? 'n/a'}</span>
                      </span>
                    ) : (r.score != null && <span className={`batch-score-pill score-${pillBand(r.score)}`}>{r.score}/100</span>)}
                  </div>
                );
              })}
            </div>
            <StepNav>
              <button onClick={resetAll}>Start Again</button>
            </StepNav>
          </div>
        );
      }

      case 'demo-cleanup': {
        const totalFound = demoScan ? demoScan.routes.length + demoScan.datagens.length + demoScan.packs.length + (demoScan.outputs?.length || 0) : 0;
        const totalSel = demoCleanupSel.routes.size + demoCleanupSel.datagens.size + demoCleanupSel.packs.size + demoCleanupSel.outputs.size;
        return (
          <div className="step">
            <h2>Clean Up Demo Environment</h2>
            <p className="step-desc">Demo artifacts found on <code>{selectedGroup}</code>. Select what to remove. Removal runs in sequence: <strong>routing → datagen → packs → Lake outputs</strong>. Only selected items (and their route comments) are removed.</p>
            {demoScanLoading ? (
              <div className="ai-loading"><div className="ai-spinner" /><span>Scanning worker group…</span></div>
            ) : demoError ? (
              <div className="error-box"><span>{demoError}</span><button onClick={() => void openDemoCleanup()}>Retry</button></div>
            ) : totalFound === 0 ? (
              <div className="success-box"><p>No demo artifacts found on this worker group. Nothing to clean up.</p></div>
            ) : (
              <>
                {(['routes', 'datagens', 'packs', 'outputs'] as const).map((kind) => {
                  const items = (demoScan ? demoScan[kind] : []) || [];
                  if (items.length === 0) return null;
                  const label = kind === 'routes' ? 'Routing' : kind === 'datagens' ? 'Datagen sources' : kind === 'packs' ? 'Packs' : 'Cribl Lake outputs';
                  const step = kind === 'routes' ? '1' : kind === 'datagens' ? '2' : kind === 'packs' ? '3' : '4';
                  return (
                    <div key={kind} className="demo-cleanup-group">
                      <div className="demo-section-label"><span className="demo-seq-num">{step}</span>{label}<span className="demo-count-pill">{(demoCleanupSel[kind] as Set<string>).size} / {items.length}</span></div>
                      {items.map((it: any) => (
                        <label key={it.id} className={(demoCleanupSel[kind] as Set<string>).has(it.id) ? 'demo-cleanup-row sel' : 'demo-cleanup-row'}>
                          <input type="checkbox" checked={(demoCleanupSel[kind] as Set<string>).has(it.id)} onChange={() => toggleCleanupSel(kind, it.id)} />
                          <span className="demo-cleanup-name">{it.name || it.displayName || it.id}</span>
                          <span className="demo-cleanup-meta">
                            {kind === 'routes' && `${it.pipeline} → ${it.output}`}
                            {kind === 'datagens' && `${it.sampleCount} sample${it.sampleCount !== 1 ? 's' : ''}`}
                            {kind === 'packs' && it.version}
                            {kind === 'outputs' && `${it.type} → ${it.destPath}`}
                          </span>
                          <code className="demo-cleanup-id">{it.id}</code>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </>
            )}
            <StepNav>
              <button className="back" onClick={() => setStep('demo-sources')}>Back</button>
              <button className="danger-btn" disabled={totalSel === 0 || demoCleaning} onClick={() => void runDemoCleanup()}>
                {demoCleaning ? 'Removing…' : `Remove ${totalSel} selected`}
              </button>
            </StepNav>
          </div>
        );
      }

      case 'demo-cleanup-done': {
        const r = demoCleanupResult;
        const total = r ? r.routes.length + r.datagens.length + r.packs.length + (r.outputs?.length || 0) : 0;
        return (
          <div className="step">
            <div className="celebrate-goat">
              <img src={goatImg} alt="Cribl Goat" className="celebrate-goat-img" />
              <span className="celebrate-badge">Cleaned Up</span>
            </div>
            <h2>Demo Cleanup Complete</h2>
            <div className="success-box">
              <p><strong>{total}</strong> artifact{total !== 1 ? 's' : ''} removed from <code>{selectedGroup}</code>, in sequence (routing → datagen → packs → Lake outputs).</p>
              {r && r.routes.length > 0 && <p>Routes: {r.routes.join(', ')}</p>}
              {r && r.datagens.length > 0 && <p>Datagens: {r.datagens.join(', ')}</p>}
              {r && r.packs.length > 0 && <p>Packs: {r.packs.join(', ')}</p>}
              {r && r.outputs && r.outputs.length > 0 && <p>Lake outputs: {r.outputs.join(', ')}</p>}
            </div>
            {r && r.errors.length > 0 && (
              <div className="error-box"><span>Some items could not be removed:</span><ul>{r.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
            )}
            <StepNav>
              <button onClick={resetAll}>Start Again</button>
            </StepNav>
          </div>
        );
      }

      case 'experiment-setup': {
        const df = state.destFormat === 'manual' ? (state.manualFormat || 'json') : state.destFormat;
        const isSchema = !['json', 'manual', 'raw', 'raw_fields', 'passthrough', ''].includes(flowBuildFormat(df));
        return (
          <div className="step">
            <h2>{packMode === 'flow' ? 'Review & build the pack flow' : 'Create New Pack'}</h2>
            <p className="step-desc">Builds and scores extraction and mapping independently, then applies destination-required output shaping.</p>
            {packMode === 'flow' && (
              <div style={{ margin: '12px 0 18px' }}>
                <FlowDestination readOnly sourcetype={effectiveSourcetype} sampleEvents={state.sampleEvents}
                  eventCount={state.sampleEvents.split('\n').filter(l => l.trim()).length}
                  destOptions={FLOW_DEST_OPTIONS} destFormats={state.destFormats}
                  optimize={flowOptimize} srcRules={flowSrcRules} ocsfKeepRaw={flowOcsfKeepRaw} pp={flowPp} defaultPpName="" />
                <div className="fd-summary">
                  <div className="h">What will be built</div>
                  {flowSummary({ sourcetype: effectiveSourcetype, destFormats: state.destFormats, optimize: flowOptimize, ocsfKeepRaw: flowOcsfKeepRaw, pp: flowPp }).map((l, i) => <p key={i}>{l}</p>)}
                  {ppOutputsToBuild(state.destFormats, flowPp).length > 0 && (
                    <p>Post-processing packs: {ppOutputsToBuild(state.destFormats, flowPp).map(o => <code key={ppPackIdFor(flowPp.name, effectiveSourcetype, o)} style={{ marginRight: 6 }}>{ppPackIdFor(flowPp.name, effectiveSourcetype, o)}</code>)}</p>
                  )}
                </div>
              </div>
            )}
            <div className="exp-plan">
              <div className="exp-plan-row"><span className="exp-num">1</span><div><strong>Extraction</strong><span>Pull every field out of <code>_raw</code> for <code>{effectiveSourcetype}</code>. Scored on source-value coverage.</span></div></div>
              <div className="exp-plan-row"><span className="exp-num">2</span><div><strong>Mapping → {df.toUpperCase()}</strong><span>{isSchema ? `Map extracted fields to the ${df.toUpperCase()} schema. Scored on how many expected schema fields get populated.` : `“${df}” has no schema — events are serialized as-is. Mapping is N/A.`}</span></div></div>
              <div className="exp-plan-row"><span className="exp-num">3</span><div><strong>Output shaping</strong><span>Apply the destination’s required envelope and cleanup. No raw-field reduction rules are added.</span></div></div>
            </div>
            {isCimFormat(df) && packMode !== 'flow' && (
              <div className="exp-opts" style={{ marginTop: 8 }}>
                <div className="options-list">
                  <div className="option-row">
                    <label className="toggle-label">
                      <input type="checkbox"
                        checked={reductionToggles['cim_keep_unmapped'] ?? true}
                        onChange={e => setReductionToggles(prev => ({ ...prev, cim_keep_unmapped: e.target.checked }))} />
                      <span className="toggle-switch" />
                      <div className="option-info">
                        <strong>Keep unmapped source fields in _raw</strong>
                        <span>Preserve extracted fields that have no CIM mapping inside the rebuilt _raw JSON, so no source data is lost. Turn off for a strict CIM-only _raw.</span>
                      </div>
                    </label>
                  </div>
                  <div className="option-row">
                    <label className="toggle-label">
                      <input type="checkbox"
                        checked={reductionToggles['cim_flat'] ?? false}
                        onChange={e => setReductionToggles(prev => ({ ...prev, cim_flat: e.target.checked }))} />
                      <span className="toggle-switch" />
                      <div className="option-info">
                        <strong>Emit CIM fields as top-level (flat) fields</strong>
                        <span>Output the mapped CIM fields as indexed top-level fields instead of the default Splunk-HEC shape (metadata top-level, fields folded into _raw JSON). Use for destinations that index flat fields directly.</span>
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            )}
            <p className="step-desc" style={{ marginTop: 12 }}>Source: <code>{effectiveSourcetype}</code> · Destination: <code>{df}</code> · Group: <code>{selectedGroup || state.workerGroup}</code> · Pack: <code>{expPackIdFor(effectiveSourcetype, df)}</code></p>
            {expError && <div className="error-box"><span>{expError}</span></div>}
            {/* Existing-pack conflict is handled inline on the Pack Details
                screen (rename or continue-to-overwrite), so no dialog here. */}
            <StepNav>
              <button className="back" onClick={() => setStep('destination')}>Back</button>
              <button onClick={() => void startExperiment()}>Run staged build</button>
            </StepNav>
          </div>
        );
      }

      case 'experiment-running':
        if (packMode === 'flow') return <div className="step">{renderFlowBuildScreen()}</div>;
        return (
          <div className="step">
            <div className="demo-build-head"><span className="demo-build-spinner" /><h2 style={{ margin: 0 }}>Building &amp; scoring the pack…</h2></div>
            {(() => {
              const doneCount = expStages.filter(s => s.status === 'done' || s.status === 'skipped').length;
              const allDone = doneCount === expStages.length;
              return <GoatBar pct={allDone ? 100 : undefined} label={`Building & scoring — ${doneCount}/${expStages.length} stages`} />;
            })()}
            <div className="exp-stage-list">
              {expStages.map((s) => (
                <div key={s.stage} className={`exp-stage exp-${s.status}`}>
                  <span className="exp-stage-name">{s.stage}</span>
                  <span className="exp-stage-status">{s.status === 'done' ? (s.score === null ? 'N/A' : `${s.score}/100`) : s.status === 'running' ? 'Working…' : s.status === 'error' ? 'Failed' : s.status === 'skipped' ? 'N/A' : 'Queued'}</span>
                </div>
              ))}
            </div>
            <div className="deploy-log" ref={deployLogRef}>
              {expLog.map((line, i) => <div key={i} className="demo-log-line">{line}</div>)}
            </div>
            {expError && <div className="error-box" style={{ marginTop: 12 }}><span>{expError}</span><button onClick={() => setStep('experiment-setup')}>Back</button></div>}
          </div>
        );

      case 'experiment-done': {
        const df = state.destFormat === 'manual' ? (state.manualFormat || 'json') : state.destFormat;
        // Build the unified per-format report view model (build 687). The old
        // per-stage cards, the Event Journey MODAL buttons and the on-demand
        // schema ValidationPanel are all replaced by ONE inline <ScoringReport>
        // shown automatically here — no button click.
        const reportData: ReportFormatVM[] = expPerFormatStages.length > 1
          ? expPerFormatStages.map((pf) => {
              const ref = deployedPipelines.find(d => d.pipelineId === pf.pipelineId);
              const profileArgs = ref
                ? { workerGroup: ref.workerGroup, packId: ref.packId, pipelineId: ref.pipelineId, sampleName: ref.sampleName }
                : { workerGroup: selectedGroup || state.workerGroup, packId: expPackId, pipelineId: pf.pipelineId, sampleName: getSampleName(effectiveSourcetype) };
              return buildReportFormatVM(pf.stages, pf.format, pf.pipelineId, profileArgs);
            })
          : (() => {
              const ref = deployedPipelines.find(d => d.destFormat === df) || deployedPipelines[0];
              const pipelineId = ref?.pipelineId || `${expPackId}:${df}`;
              const profileArgs = ref
                ? { workerGroup: ref.workerGroup, packId: ref.packId, pipelineId: ref.pipelineId, sampleName: ref.sampleName }
                : undefined;
              return [buildReportFormatVM(expStages, df, pipelineId, profileArgs)];
            })();
        return (
          <div className="step">
            <h2>Pack Results</h2>
            <p className="step-desc">Each stage scored on its <strong>own job</strong>. No blended number — a weak stage can't hide behind a strong one. One tab per output format.</p>
            <ScoringReport data={reportData} packId={expPackId} workerGroup={selectedGroup || state.workerGroup} visualizerBaseUrl={criblInstanceBaseUrl()} />
            <BuildTracePanel traces={expBuildTraces} />
            <div className="build-trace-ai-row"><TraceAiPanel traces={expBuildTraces} /></div>
            <p className="step-desc" style={{ marginTop: 14 }}>Pack <code>{expPackId}</code> deployed on <code>{selectedGroup || state.workerGroup}</code>. {describeStoredGoldens(expBuildTraces)}</p>
            {/* Successful + scored post-process packs got their own tab in the
                ScoringReport above (see buildFlowPostProcessPacks). Only packs
                that errored, or deployed with no upstream sample to score
                against, stay in this plain list. */}
            {packMode === 'flow' && flowPpResults.some(r => r.error || !r.stages) && (
              <div className="fd-summary">
                <div className="h">Post-processing packs without a scoring tab</div>
                {flowPpResults.filter(r => r.error || !r.stages).map(r => (
                  <p key={r.packId}>
                    {r.error ? '✗' : '✓'} <strong>{r.label}</strong> — <code>{r.packId}</code>
                    {r.error ? <> · <span style={{ color: '#cf1322' }}>{r.error}</span></> : <> · {r.optimize ? 'optimized by category' : 'full copy'} · deployed but not scored (no upstream sample) · attach it as the post-processing pipeline on that destination</>}
                  </p>
                ))}
              </div>
            )}
            {expError && <div className="error-box"><span>{expError}</span></div>}
            <StepNav>
              <button onClick={resetAll}>Start Again</button>
            </StepNav>
          </div>
        );
      }
    }
  };

  // Build pack flow: one post-processing pack per output (OCSF → SIEM format),
  // lifted from handlePostProcessDeploy. Deferred deploy — the caller commits
  // once. Optimization runs only here, and only when the output says so.
  // Sample = what a post-processing pack actually receives: the main OCSF
  // pipeline's OUTPUT on the user's sample, exactly as emitted (the packs are
  // chained). Whether a `_raw` survives depends on the source's parser (Windows
  // XML consumes it; "Keep original _raw" puts it in `raw_data`), so never gate
  // on it (upstreamSampleEvents). Stored as structured events
  // (`structuredSample`). The curated OCSF set is only the fallback when that
  // preview returns nothing.
  async function upstreamOcsfOutputEvents(upstream: DeployedPipeline | undefined, log: (m: string) => void): Promise<Record<string, unknown>[]> {
    if (!upstream) return [];
    try {
      const out = await previewPipeline({
        workerGroup: upstream.workerGroup, packId: upstream.packId, pipelineId: upstream.pipelineId,
        sourcetype: upstream.sourcetype, destFormat: upstream.destFormat, sampleName: upstream.sampleName,
      });
      const events = upstreamSampleEvents(out);
      if (events.length) log(`[post-processing] sample = ${events.length} output event(s) of ${upstream.pipelineId}, exactly as that pipeline emits them.`);
      else log(`⚠ [post-processing] ${upstream.pipelineId} preview returned no events — falling back to the curated OCSF sample (not this pipeline's output).`);
      return events;
    } catch (e) {
      log(`⚠ [post-processing] could not preview ${upstream.pipelineId} (${e instanceof Error ? e.message : String(e)}) — falling back to the curated OCSF sample (no vendor _raw).`);
      return [];
    }
  }

  // Dot-path flatten of a structured event (the upstream OCSF event has no
  // raw text to show as "sample" — this is its display-only stand-in for the
  // extraction stage's `extractedFields`). Arrays are indexed; `null`/`''` are
  // dropped (the report already filters those out for the normal stages).
  function flattenOcsfForDisplay(ev: unknown, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    if (ev == null || typeof ev !== 'object') return out;
    for (const [k, v] of Object.entries(ev as Record<string, unknown>)) {
      if (k.startsWith('__') || k.startsWith('cribl_')) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v == null || v === '') continue;
      if (Array.isArray(v) || typeof v === 'object') Object.assign(out, flattenOcsfForDisplay(v, path));
      else out[path] = String(v);
    }
    return out;
  }

  // `over` lets the demo build the same packs for one of several sources: its
  // own sourcetype, pack IDs/names, and the OCSF events it already previewed.
  async function buildFlowPostProcessPacks(outs: ReturnType<typeof ppOutputsToBuild>, group: string, log: (m: string) => void, onItem?: (i: number, p: Partial<FlowLivePp>) => void, upstream?: DeployedPipeline, over?: {
    sourcetype: string; packIdFor: (o: FlowPpOutput) => string; displayNameFor: (o: FlowPpOutput) => string; upstreamEvents: Record<string, unknown>[];
  }) {
    const results: { label: string; packId: string; pipelineId: string; optimize: boolean; error?: string; destFormat?: string; stages?: ExpStageResult[] }[] = [];
    const sourceFormat = 'ocsf';
    const ppSourcetype = over?.sourcetype ?? effectiveSourcetype;
    const upstreamEvents = over ? over.upstreamEvents : await upstreamOcsfOutputEvents(upstream, log);
    const structuredSample = upstreamEvents.length > 0;
    const sampleEvents = structuredSample
      ? upstreamEvents.map(e => JSON.stringify(e)).join('\n')
      : postProcessSampleEvents(sourceFormat);
    for (const [i, o] of outs.entries()) {
      const eff = ppEffectiveFormat(o);
      const label = ppOutputLabel(o);
      const packId = over ? over.packIdFor(o) : ppPackIdFor(flowPp.name, ppSourcetype, o);
      log(`[post-processing ${i + 1}/${outs.length}] ${label} → pack ${packId} (${o.optimize ? 'optimize by category' : 'full copy'})`);
      onItem?.(i, { state: 'running' });
      try {
        const pair = getPostProcessPair(sourceFormat, o.fmt);
        if (!pair && !isNoPairPostProcessDestination(o.fmt)) throw new Error(`No transform available for ${sourceFormat} → ${o.fmt}`);
        const routeFilter = 'true';
        const ppState: WizardState = {
          ...state,
          packName: packId,
          displayName: over ? over.displayNameFor(o) : ppPackNameFor(flowPp.name, ppSourcetype, o),
          description: `Post-processing: OCSF → ${label}${o.optimize ? ' (optimized by category)' : ' (full copy)'}. Attach as a destination post-processing pack.`,
          destFormat: eff as DestFormat,
          routeFilter,
          sampleEvents,
        };
        // A raw output forwards the ORIGINAL event, which after the OCSF stage
        // exists only as `raw_data` ("Keep original _raw").
        if (structuredSample && isRawPassthroughDestination(eff) && !upstreamEvents.some(e => typeof e.raw_data === 'string' && e.raw_data)) {
          log(`⚠ ${label}: the OCSF output carries no raw_data ("Keep original _raw" is off) — this raw output will send the OCSF event as JSON in _raw (sourcetype ocsf), not the original event.`);
        }
        const fns = buildPostProcessFunctions(sourceFormat, eff, {
          optimize: o.optimize, sampleEvents: structuredSample ? upstreamEvents : null, sourceSourcetype: ppSourcetype,
        });
        const built = buildPack(ppState, sourceFormat, {}, false, null, null, fns);
        // buildPack kebab-cases packName; flow pack IDs are snake case (flowPackId).
        const pack = { ...built, packId, packageJson: { ...built.packageJson, name: packId }, readme: built.readme.split(`\`${built.packId}\``).join(`\`${packId}\``) };
        const referenceLookups = postProcessLookupsFor(sourceFormat, eff, { optimize: o.optimize })
          .map(l => ({ ...l, rows: Math.max(0, l.content.trim().split('\n').length - 1) }));
        const result = await deploy({
          mode: 'new',
          packId: pack.packId,
          pipelineId: pack.pipelineId,
          workerGroup: group,
          packageJson: pack.packageJson,
          routeYml: pack.routeYml,
          pipelineYml: pack.pipelineYml,
          pipelineConf: pack.pipelineConf,
          readme: pack.readme,
          sampleId: pack.sampleId,
          samplesYml: pack.samplesYml,
          sourcetype: sourceFormat,
          routeFilter,
          routeFinal: true,
          // The upstream events themselves, not buildPack's wrapped copy: wrapping
          // re-adds `_raw` (the JSON line) to every event that has none, which
          // hands the post pack a `_raw` the OCSF pipeline had deleted.
          sampleData: structuredSample ? upstreamEvents : pack.sampleData,
          structuredSample,
          sampleName: getSampleName(sourceFormat),
          createDatagen: false,
          referenceLookups,
          deferDeploy: true,
        }, log);
        log(`✓ Post-processing pack ${result.packId} — pipeline ${result.pipelineId} (${fns.length} functions).`);
        // Score this post-process pack like a mapping stage: how much of the
        // upstream OCSF event's fields carried into the destination schema,
        // typed correctly. `deferDeploy` above already wrote the pipeline
        // config, so previewPipeline works the same way upstreamOcsfOutputEvents
        // (above) already relies on for an un-committed pipeline.
        let stages: ExpStageResult[] | undefined;
        if (structuredSample) {
          try {
            const outEvents = upstreamSampleEvents(await previewPipeline({
              workerGroup: group, packId: result.packId, pipelineId: result.pipelineId,
              sourcetype: sourceFormat, destFormat: eff, sampleName: pack.sampleId,
            }));
            const extStage: ExpStageResult = {
              stage: 'extraction', status: 'done', score: 100, band: 'good', source: 'none', reasons: [],
              debug: { sampleRaw: JSON.stringify(upstreamEvents[0] ?? {}), extractedFields: flattenOcsfForDisplay(upstreamEvents[0]) },
            };
            const cefFamily = ['cef', 'arcsight'].includes(postProcessFamilyOf(eff));
            const r = !cefFamily && outEvents.length ? scoreSchemaMappingFromExtraction(eff, upstreamEvents, outEvents, ppSourcetype, sampleEvents) : null;
            const mapStage: ExpStageResult = {
              stage: 'mapping', status: 'done',
              score: r?.supported ? r.score : null, band: r?.supported ? r.band : 'na',
              source: 'golden', reasons: r?.lostValues?.length ? [`${r.lostValues.length} value(s) from the upstream OCSF event not carried into ${label}`] : [],
              debug: { outputEvent: outEvents[0], unmappedFields: r?.emptyFields },
            };
            stages = [extStage, mapStage];
          } catch (scoreErr) {
            log(`⚠ ${label}: could not score the post-processing output (${scoreErr instanceof Error ? scoreErr.message : 'preview failed'}) — pack still deployed.`);
          }
        }
        results.push({ label, packId: result.packId, pipelineId: result.pipelineId, optimize: o.optimize, destFormat: eff, stages });
        onItem?.(i, { state: 'done' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`✗ Post-processing ${label} failed: ${msg}`);
        results.push({ label, packId, pipelineId: '', optimize: o.optimize, error: msg });
        onItem?.(i, { state: 'error', error: msg });
      }
    }
    return results;
  }

  // Post-processing deploy (OCSF → CEF, …). Deterministic + curated: no AI parse,
  // no golden search, no quality/repair loop — the maps are fixed standards. Builds
  // one pipeline, bundles the editable class-dictionary lookup, and deploys a
  // self-contained pack (commit + deploy immediately; single pipeline, not deferred).
  async function handlePostProcessDeploy() {
    setError('');
    setStep('deploying');
    setDeployLog([]);
    const log = (msg: string) => setDeployLog((prev) => [...prev, msg]);
    try {
      const pair = getPostProcessPair(ppSourceFormat, ppDestFormat);
      // Raw-fidelity destinations (xsiam, crowdstrike_ngsiem) never have a pair
      // — there is no field mapping to define one for (plan Task 5). A missing
      // pair is only an error for every OTHER destination.
      if (!pair && !isNoPairPostProcessDestination(ppDestFormat)) {
        throw new Error(`No transform available for ${ppSourceFormat} → ${ppDestFormat}`);
      }
      // Concrete golden format: the chosen sub-schema (cim#authentication, asim#dns,
      // chronicle#endpoint, commonsecuritylog) else the family default.
      const schemaOpts = postProcessSchemaOptions(ppDestFormat);
      const ppEffectiveFormat = (ppSchema && schemaOpts.some(o => o.key === ppSchema)) ? ppSchema : ppDestFormat;
      const sourcetype = ppSourceFormat;                       // naming only (ocsf_to_cef, ocsf_sample.log)
      const routeFilter = state.routeFilter || 'true';         // post-processing usually sees every event
      const ppState: WizardState = {
        ...state,
        destFormat: ppEffectiveFormat as DestFormat,
        routeFilter,
        sampleEvents: state.sampleEvents.trim() || postProcessSampleEvents(ppSourceFormat),
      };
      const fns = buildPostProcessFunctions(ppSourceFormat, ppEffectiveFormat);
      const schemaLabel = schemaOpts.find(o => o.key === ppEffectiveFormat)?.label;
      const pairLabel = pair?.label ?? POSTPROCESS_DEST_FORMATS.find(f => f.value === ppDestFormat)?.label ?? ppDestFormat;
      log(`Mode: Post-processing pack — ${pairLabel}${schemaLabel ? ` (${schemaLabel})` : ''}`);
      log(`Built ${fns.length} deterministic pipeline functions (curated, no AI).`);
      const pack = buildPack(ppState, sourcetype, {}, false, null, null, fns);
      const referenceLookups = postProcessLookupsFor(ppSourceFormat, ppEffectiveFormat)
        .map(l => ({ ...l, rows: Math.max(0, l.content.trim().split('\n').length - 1) }));
      log(`Pack: ${pack.packId}`);
      log(`Worker group: ${state.workerGroup}`);
      log(`Route filter: ${routeFilter}`);
      if (referenceLookups.length > 0) {
        log(`Bundling editable class dictionary: ${referenceLookups.map(l => `${l.file} (${l.rows} rows)`).join(', ')}`);
      }
      log(`Deploying pipeline ${pack.pipelineId}...`);
      const result = await deploy({
        mode: 'new',
        packId: pack.packId,
        pipelineId: pack.pipelineId,
        workerGroup: state.workerGroup,
        packageJson: pack.packageJson,
        routeYml: pack.routeYml,
        pipelineYml: pack.pipelineYml,
        pipelineConf: pack.pipelineConf,
        readme: pack.readme,
        sampleId: pack.sampleId,
        samplesYml: pack.samplesYml,
        sourcetype,
        routeFilter,
        routeFinal: true,
        sampleData: pack.sampleData,
        sampleName: getSampleName(sourcetype),
        createDatagen: false,
        referenceLookups,
        deferDeploy: false,
      }, log);
      log(`✓ Deployed pack ${result.packId} — pipeline ${result.pipelineId} on ${state.workerGroup}.`);
      log(`Attach this pack as a post-processing pipeline on your ${ppDestFormat.toUpperCase()} destination.`);
      setDeployedPipelines([]);   // deterministic transform — no AI validation panel
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('pp-formats');
    }
  }

  async function handleDeploy() {
    setError('');
    setStep('deploying');
    const log = (msg: string) => setDeployLog((prev) => [...prev, msg]);
    const deployStartTime = Math.floor(Date.now() / 1000);  // pipeline build start

    try {
      const formats = state.destFormats;
      const firstFormat = formats[0];
      const firstState = { ...state, destFormat: firstFormat };
      // Parsed field contract for targeted remaps (AI parse output, else the
      // built-in parser's known fields) — keeps improve rounds grounded.
      const parsedFieldNamesForImprove = aiParseFns
        ? extractParsedFieldNames(aiParseFns)
        : getParserFieldNames(effectiveSourcetype);
      // Initial build is used only for the pre-deploy contract-findings preview
      // below; generateBestPack() rebuilds + quality-gates the deployed pack.
      let pack = buildPack(firstState, effectiveSourcetype, reductionToggles, allowCodeFunctions, aiMappings, aiParseFns?.functions || null);
      const effectivePackId = packMode === 'add-pipeline' ? selectedPackId : pack.packId;
      const effectiveWorkerGroup = packMode === 'add-pipeline' ? selectedGroup : state.workerGroup;

      log(`Mode: Add pipeline to existing pack`);
      log(`Pack: ${effectivePackId}`);
      log(`Formats: ${formats.length} (${formats.join(', ')})`);
      log(`Worker group: ${effectiveWorkerGroup}`);

      // --- Contract + extraction checks (static, pre-deploy preview) --------
      const previewFindings = pack.contractFindings || [];
      const previewErrors = getBlockingContractErrors(previewFindings);
      if (previewFindings.length > 0) {
        log(`Pre-deploy preview: ${previewErrors.length} blocking error(s), ${previewFindings.length - previewErrors.length} warning(s).`);
        for (const f of previewFindings.slice(0, 12)) {
          log(`   [${f.severity}] ${f.stage}: ${f.hint}`);
        }
      } else {
        log(`✓ Pre-deploy preview passed — all source keys extracted, every mapped field produced by the parse stage.`);
      }

      // --- Pre-deploy quality gate (shared core) ---
      // Same generateBestPack() the batch path uses — quality gate + repair loop
      // + auto-promote, all in one place so the two entry points can't drift.
      // The interactive preview already produced aiMappings; pass them as the
      // preset so we don't re-call aiMapping for the first attempt.
      const firstFmtLabel = DEST_OPTIONS.find(d => d.value === firstFormat)?.label || firstFormat;
      const firstGen = await generateBestPack({
        sourcetype: effectiveSourcetype,
        format: firstFormat,
        state: firstState,
        reductionToggles,
        allowCodeFunctions,
        aiParseFns,
        parsedFieldNames: parsedFieldNamesForImprove,
        presetMappings: aiMappings,
        log,
      });
      pack = firstGen.pack;
      log(`[${firstFmtLabel}] Deploying pipeline scored ${firstGen.score}/100`);

      if (logContractBlock(pack.contractFindings, log)) {
        setError('Deploy blocked: pre-deploy contract checks failed. Fix parser/extraction issues in the log, then retry.');
        setStep('review');
        return;
      }

      // The first pipeline's sample is the one uploaded to the pack; all
      // pipelines preview against it (samples are pack-scoped, shared parsing).
      // Named by sourcetype (destination-independent) so the pack holds ONE
      // shared sample — must match the name `buildSamplesYml` wrote into the pack.
      const sharedSampleName = getSampleName(effectiveSourcetype);
      const deployed: DeployedPipeline[] = [];

      // Self-heal the code-driven parsing lookup against THIS sample: any code
      // whose golden regex doesn't match the real events gets an AI-repaired
      // regex (and the fix is persisted back to the golden standard). This is
      // how lookup-coverage gaps get fixed at creation time, per sourcetype.
      let healedLookup: { file: string; content: string } | null = null;
      try {
        log(`Checking golden lookup coverage against your sample...`);
        const heal = await healLookup(effectiveSourcetype, state.sampleEvents);
        if (heal.repaired && heal.repaired.length > 0 && heal.file && heal.content) {
          healedLookup = { file: heal.file, content: heal.content };
          const added = heal.repaired.filter(r => r.added).map(r => r.code);
          const fixed = heal.repaired.filter(r => !r.added).map(r => r.code);
          const parts: string[] = [];
          if (added.length) parts.push(`added ${added.length} missing code(s) from ASA docs: ${added.join(', ')}`);
          if (fixed.length) parts.push(`repaired ${fixed.length} regex(es): ${fixed.join(', ')}`);
          log(`Self-healed lookup — ${parts.join('; ')}${heal.persisted ? ' (saved to golden standard)' : ''}`);
        } else {
          log(`Golden lookup coverage OK — no regex repairs needed.`);
        }
      } catch { /* healing is best-effort */ }

      // Fetch golden lookups for this sourcetype so the deploy path can bundle
      // them into the pack (works in BOTH iframe and standalone modes — the
      // browser can't read the filesystem, so we fetch the CSV content here).
      const referenceLookups = await fetchReferenceLookups(effectiveSourcetype);
      // Swap in the healed content for the parsing lookup we just repaired.
      if (healedLookup) {
        const idx = referenceLookups.findIndex(l => l.file === healedLookup!.file);
        if (idx >= 0) referenceLookups[idx] = { ...referenceLookups[idx], content: healedLookup.content };
      }
      if (referenceLookups.length > 0) {
        log(`Prepared ${referenceLookups.length} reference lookup(s) to bundle: ${referenceLookups.map(l => `${l.file} (${l.rows} rows)`).join(', ')}`);
      }

      // Push first pipeline (creates pack if mode='new') — deferred: no commit/deploy yet.
      // Preview/scoring works on the uncommitted working tree, so the quality loop
      // runs before any commit+deploy cycle. ONE commit+deploy at the very end.
      const isMulti = formats.length > 1;
      log(`[1/${formats.length}] Pushing pipeline: ${pack.pipelineId} (${firstFormat})...`);
      const result = await deploy({
        mode: packMode,
        packId: effectivePackId,
        pipelineId: pack.pipelineId,
        workerGroup: effectiveWorkerGroup,
        packageJson: pack.packageJson,
        routeYml: pack.routeYml,
        pipelineYml: pack.pipelineYml,
        pipelineConf: pack.pipelineConf,
        readme: pack.readme,
        sampleId: pack.sampleId,
        samplesYml: pack.samplesYml,
        sourcetype: effectiveSourcetype,
        routeFilter: state.routeFilter || `sourcetype=='${effectiveSourcetype}'`,
        routeFinal: !isMulti,
        sampleData: pack.sampleData,
        sampleName: sharedSampleName,
        createDatagen,
        referenceLookups,
        deferDeploy: true,
        breakerYml: pack.breakerYml,
      }, log);

      log(`Pipeline pushed: ${result.pipelineId}`);
      if (result.bundledLookups && result.bundledLookups.length > 0) {
        const total = result.bundledLookups.reduce((n, l) => n + l.rows, 0);
        log(`Bundled ${result.bundledLookups.length} reference lookup(s) into pack (${total} rows total): ${result.bundledLookups.map(l => l.file).join(', ')}`);
      }
      deployed.push({ pipelineId: pack.pipelineId, destFormat: firstFormat, sourcetype: effectiveSourcetype, packId: effectivePackId, workerGroup: effectiveWorkerGroup, sampleName: sharedSampleName });
      const goldenByPipeline: Record<string, boolean> = {
        [pack.pipelineId]: hasGoldenFormatPath(effectiveSourcetype, firstFormat, state.sampleEvents) && goldenPathMatchesSample(effectiveSourcetype, firstFormat, state.sampleEvents),
      };

      // Push additional pipelines (add-pipeline mode) — also deferred.
      for (let i = 1; i < formats.length; i++) {
        const fmt = formats[i];
        const isLast = i === formats.length - 1;
        const fmtState = { ...state, destFormat: fmt };
        const fmtGen = await generateBestPack({
          sourcetype: effectiveSourcetype,
          format: fmt,
          state: fmtState,
          reductionToggles,
          allowCodeFunctions,
          aiParseFns,
          parsedFieldNames: parsedFieldNamesForImprove,
          presetMappings: aiMappingsPerFormat[fmt] || null,
          log,
        });
        const fmtPack = fmtGen.pack;

        if (logContractBlock(fmtPack.contractFindings, log)) {
          setError(`Deploy blocked: contract checks failed for ${fmt} pipeline. Earlier pipeline(s) may already be deployed.`);
          setStep('review');
          return;
        }

        log(`[${i + 1}/${formats.length}] Pushing pipeline: ${fmtPack.pipelineId} (${fmt}) scored ${fmtGen.score}/100...`);
        const addResult = await deploy({
          mode: 'add-pipeline',
          packId: effectivePackId,
          pipelineId: fmtPack.pipelineId,
          workerGroup: effectiveWorkerGroup,
          packageJson: fmtPack.packageJson,
          routeYml: fmtPack.routeYml,
          pipelineYml: fmtPack.pipelineYml,
          pipelineConf: fmtPack.pipelineConf,
          sourcetype: effectiveSourcetype,
          routeFilter: state.routeFilter || `sourcetype=='${effectiveSourcetype}'`,
          routeFinal: isLast,
          deferDeploy: true,
          breakerYml: fmtPack.breakerYml,
        }, log);
        log(`Pipeline pushed: ${addResult.pipelineId}`);
        deployed.push({ pipelineId: fmtPack.pipelineId, destFormat: fmt, sourcetype: effectiveSourcetype, packId: effectivePackId, workerGroup: effectiveWorkerGroup, sampleName: sharedSampleName });
        goldenByPipeline[fmtPack.pipelineId] = hasGoldenFormatPath(effectiveSourcetype, fmt, state.sampleEvents) && goldenPathMatchesSample(effectiveSourcetype, fmt, state.sampleEvents);
      }

      log(`✓ ${formats.length} pipeline${formats.length > 1 ? 's' : ''} pushed. Scoring via preview…`);

      // Quality scoring runs on the uncommitted working tree (preview API reads
      // the PATCH'd conf without needing commit+deploy). Repairs also PATCH in
      // place. ONE commit+deploy happens after scoring is complete.
      for (const dp of deployed) {
        await runPostDeployQuality(dp, {
          golden: !!goldenByPipeline[dp.pipelineId],
          // Provenance for golden evidence: the deployed sample is this wizard's.
          sourceMode: state.sourceMode,
          startTime: deployStartTime,
          log,
          repairQuality,
          logScore: maybeLogScore,
          loadSettings: loadQualitySettings,
        });
      }

      // Single commit + deploy — makes all pipelines + repairs live in one cycle.
      log('Committing and deploying…');
      await commitDeploy(effectiveWorkerGroup, `Deploy ${deployed.length} pipeline(s) in pack ${effectivePackId}`);
      log(`✓ Committed and deployed to ${effectiveWorkerGroup}.`);

      setDeployedPipelines(deployed);
      setValidationReports({});
      setRepairSelection(new Set());
      setValidationError('');
      setStep('done');
      if (autoValidate && deployed.length > 0) {
        log('Auto-validating deployed pipelines...');
        await runValidation(deployed);
      }

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log(`ERROR: ${message}`);
      setError(message);
      setStep('review');
      void maybeLogScore({
        sourcetype: effectiveSourcetype,
        pack_id: packMode === 'add-pipeline' ? selectedPackId : toKebab(state.packName),
        pipeline_id: '',
        dest_format: state.destFormats[0] || '',
        // NULL: this build failed, it did not measure a pipeline at 0.
        score: null,
        sample_name: '',
        model_used: loadQualitySettings().normalModel,
        tokens_input: 0,
        tokens_output: 0,
        worker_group: packMode === 'add-pipeline' ? selectedGroup : state.workerGroup,
        is_golden_path: false,
        generation_mode: 'ai',
        findings_count: 0,
        status: 'error',
        deploy_message: message,
      });
    }
  }

  return (
    <div className="app pg-shell">
      <input type="file" ref={batchSampleInputRef} style={{ display: 'none' }} accept=".log,.txt,.json,.xml,.csv,.jsonl" onChange={handleBatchSampleUpload} />
      <aside className="pg-rail" aria-label="Modes and tools">
        <div className="pg-brand">
          <span className="pg-logo" aria-hidden="true" />
          <div><b>Pack Generator</b><small className="build-number">build {BUILD_NUMBER}</small></div>
        </div>
        <button type="button" className={`pg-nav${step === 'mode' && !toolPage ? ' on' : ''}`} onClick={goHome} disabled={railLocked}>
          <span className="ni" aria-hidden="true">⌂</span>Home
        </button>
        <div className="pg-rail-h">Modes</div>
        {MENU_MODES.map(m => (
          <button key={m.id} type="button" className={`pg-nav${!toolPage && step !== 'mode' && packMode === m.id ? ' on' : ''}`}
            title={railLocked ? 'Wait for the current build to finish' : m.title} disabled={railLocked} onClick={() => startMode(m.id)}>
            <span className="ni" aria-hidden="true">{m.icon}</span>{m.name}{m.badge && <span className="new">{m.badge}</span>}
          </button>
        ))}
        <div className="pg-spacer" />
        <div className="pg-rail-h">Tools</div>
            <div className="header-actions pg-tools">
              {/* Sample library — open in BOTH run modes since build 566: sanitising is
                  browser-only work. The staged-count badge is standalone's alone — in the
                  iframe there is no queue to count. */}
              <button className={`settings-btn${toolPage?.area === 'samples' ? ' on' : ''}`} onClick={() => openTool({ area: 'samples', tab: 'sanitize' })}
                title={getRunMode() !== 'standalone'
                  ? 'Samples — sanitize a sample and keep it as a validated one'
                  : sampleLibSummary
                    ? `Samples — ${sampleLibSummary.staged} staged for review, ${sampleLibSummary.library} committed`
                    + (sampleLibSummary.shadowed ? `, ${sampleLibSummary.shadowed} shadowed by a real vendor log` : '')
                    + (sampleLibSummary.probes ? `, ${sampleLibSummary.probes} test artifact(s) not counted` : '')
                    : 'Samples — could not read the staging queue'}>
                <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><path d="M4 2h3v16H4V2zm4.5 0h3v16h-3V2zM14 2.4l2.9 15.7-2.9.5L11.1 3 14 2.4z"/></svg><span className="rt-label">Samples</span>
                {getRunMode() === 'standalone' && sampleLibSummary && sampleLibSummary.staged > 0 && (
                  <span className="ai-status-dot dot-count">{sampleLibSummary.staged}</span>
                )}
              </button>
              {(() => {
                const health = settingsHealth(aiStatus, lakeExportActive, getRunMode());
                return (
                  <button className={`settings-btn${toolPage?.area === 'settings' ? ' on' : ''}`} onClick={() => openTool({ area: 'settings', tab: 'ai' })}
                    title={health === 'ok' ? 'Settings — all connected' : health === 'error' ? `Settings — ${aiStatus === 'error' ? 'AI disconnected' : 'score logging inactive'}` : 'Settings — checking…'}>
                    <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><path d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"/></svg><span className="rt-label">Settings</span>
                    <span className={`ai-status-dot ${health === 'ok' ? 'dot-ok' : health === 'error' ? 'dot-error' : 'dot-checking'}`}>
                      {health === 'ok' ? '✓' : health === 'error' ? '✗' : '•'}
                    </span>
                  </button>
                );
              })()}
              {/* The product documentation, one click from anywhere. Two documents: the
                  User guide (how to use the app) and the Technical reference (how results
                  are produced — also Settings → Quality → Reference). Each opens a tab. */}
              <button type="button" className="settings-btn rail-docs-btn" aria-expanded={docsOpen} aria-controls="rail-docs-menu"
                onClick={() => setDocsOpen(o => !o)}
                title="Documentation — the User guide and the Technical reference (open in a new tab)">
                <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><path d="M9 4.8C7.6 3.7 5.6 3.2 3 3.2c-.6 0-1 .4-1 1v10.4c0 .6.4 1 1 1 2.5 0 4.4.5 5.7 1.6.2.1.3.1.3-.1V5.2c0-.2 0-.3 0-.4zm2 0V17c0 .2.1.2.3.1 1.3-1.1 3.2-1.6 5.7-1.6.6 0 1-.4 1-1V4.2c0-.6-.4-1-1-1-2.6 0-4.6.5-6 1.6z"/></svg><span className="rt-label">Documentation</span>
                <span className="rail-docs-caret" aria-hidden="true">{docsOpen ? '▾' : '▸'}</span>
              </button>
              {docsOpen && (
                <div id="rail-docs-menu" className="rail-docs-menu">
                  <button type="button" className="settings-btn rail-doc-item" onClick={() => void openUserGuide()}
                    title="User guide — how to use each mode and tool, step by step (opens in a new tab)">
                    <span className="rail-doc-ic" aria-hidden="true">?</span><span className="rt-label">User guide</span>
                  </button>
                  <button type="button" className="settings-btn rail-doc-item" onClick={() => void openScoringDoc()}
                    title="Technical reference — onboarding, the golden → Search → AI sequence, every format and how scoring works (opens in a new tab)">
                    <span className="rail-doc-ic" aria-hidden="true">∑</span><span className="rt-label">Technical reference</span>
                  </button>
                </div>
              )}
            </div>
      </aside>
      <div className="pg-col">
      <header className="pg-topbar">
        <div className="pg-crumb">
          {toolPage
            ? <>{TOOL_AREAS[toolPage.area].title} · <b>{toolTabs(toolPage.area, getRunMode()).find(t => t.id === toolPage.tab)?.label}</b></>
            : step === 'mode' ? <b>Home</b> : <>{WIZARD_MODES.find(m => m.id === packMode)?.name}{currentStepLabel && <> · <b>{currentStepLabel}</b></>}</>}
        </div>
        {newBuild != null && (
          <div className="update-banner">
            <span>A new version (build {newBuild}) is available. Reload to update.</span>
            <button onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}
      </header>
      {!toolPage && step !== 'mode' && wizardStepList.length > 0 && (
        <nav className="pg-stepbar" aria-label="Steps">
          {wizardStepList.map(([id, label], i) => {
            const cur = wizardStepList.findIndex(w => w[0] === step);
            const state_ = i === cur ? ' on' : cur > i ? ' done' : '';
            const jump = canJumpToStep(wizardStepList, step, id);
            return [
              i > 0 && <span key={`sep-${id}`} className="pg-sep" aria-hidden="true" />,
              <button key={id} type="button" className={`pg-stp${state_}`} aria-current={i === cur ? 'step' : undefined}
                disabled={!jump && i !== cur} onClick={() => { if (jump) setStep(id as Step); }}>
                <span className="n">{cur > i ? '✓' : i + 1}</span>{label}
              </button>,
            ];
          })}
        </nav>
      )}
      {batchResumeCheckpoint && (
        <div className="ai-banner ai-banner-ok">
          <span>
            A batch run against <strong>{batchResumeCheckpoint.workerGroup}</strong> from{' '}
            {new Date(batchResumeCheckpoint.updatedAt).toLocaleString()} didn't finish (
            {(batchResumeCheckpoint.results as BatchResult[]).filter(r => r.status && r.status !== 'pending').length}
            /{(batchResumeCheckpoint.results as BatchResult[]).length} rows done). Resume where it left off, or discard it.
          </span>
          <button onClick={handleResumeBatch}>Resume</button>
          <button onClick={handleDiscardResume}>Discard</button>
        </div>
      )}
      {(batchBgCheckpoint || batchBgNotice || batchBgRead.status === 'unavailable'
        || batchBgRead.status === 'unreadable' || batchBgRead.runId)
        && step !== 'batch-bg-running' && (() => {
        // The same projection the progress screen renders, so the banner cannot
        // describe the run differently from the screen it links to: a parked,
        // failed or unreadable run announced as "still running" sends the
        // operator off to wait for work that stopped happening.
        const run = buildBackgroundRunView(batchBgCheckpoint, { read: batchBgRead });
        // Dismiss is offered HERE too, so the explanation for a cleanup that
        // failed has to be here too — otherwise the button reads as doing
        // nothing, with its reason on a screen the operator is not looking at.
        // A read that failed at mount is worth saying even with no manifest to
        // show: it is the difference between "no run" and "could not ask", and
        // only one of those makes it safe to start another.
        const trouble = batchBgNotice
          || (run.read.status === 'ok' || run.read.status === 'none' ? '' : run.read.message);
        // Only a TRANSIENT read is worth asking again — a corrupt document or a
        // refusal answers the same way every time, and a Retry there would be a
        // button whose whole job is to fail. That one has Dismiss instead.
        const retryable = run.read.status === 'unavailable';
        return (
          <div
            className={trouble ? 'ai-banner ai-banner-error' : run.active ? 'ai-banner ai-banner-ok' : 'ai-banner'}
            role={trouble ? 'alert' : undefined}
          >
            <span>
              {batchBgCheckpoint && <>
                Background batch against <strong>{run.workerGroup}</strong> — <strong>{run.statusLabel.toLowerCase()}</strong> (
                {run.counts.settled}/{run.counts.total} rows settled).{' '}
              </>}
              {trouble}
            </span>
            {/* Restores the mode as well as the step: after a reload this
                banner is how the operator gets back to a run the mount read
                found, and the screen is part of the background batch flow. */}
            {batchBgCheckpoint && (
              <button className="banner-primary" onClick={() => { setPackMode('batch'); setBatchBackground(true); setStep('batch-bg-running'); }}>
                {run.final ? 'View report' : 'View progress'}
              </button>
            )}
            {retryable && (
              <button className="banner-neutral" disabled={batchBgRetrying} onClick={() => void handleRetryBackgroundRead()}>
                {batchBgRetrying ? 'Checking…' : 'Retry'}
              </button>
            )}
            {run.dismissible && (
              <button className="banner-neutral" disabled={batchBgDismissing} onClick={() => void handleDismissBatchBackground()}>
                {batchBgDismissing ? 'Clearing…' : 'Dismiss'}
              </button>
            )}
          </div>
        );
      })()}
      {aiStatus === 'error' && (
        <div className="ai-banner ai-banner-error">
          <span>{getRunMode() === 'iframe'
            ? 'AI requires an API key — configure a provider (Anthropic, OpenAI, etc.) in Settings.'
            : `AI unavailable: ${aiStatusMsg}. Cribl AI (Aperture) requires Tailscale. For cloud environments, configure an Anthropic or OpenAI API key in Settings.`
          }</span>
          <button onClick={() => openToolLink('ai-banner')}>Settings</button>
          <button onClick={() => setAiStatus('checking')}>Dismiss</button>
        </div>
      )}
      {/* Hidden, not unmounted, under a tool page: a build keeps its screen state. */}
      <main style={toolPage ? { display: 'none' } : undefined}>{renderStep()}</main>
      {toolPage && <main className="tp-main">{renderToolPage()}</main>}
      {eventModal && (
        <div className="modal-backdrop" onClick={() => setEventModal(null)}>
          <div className="modal-panel event-modal-panel" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{eventModal.title}</h3>
              <button className="close-btn" onClick={() => setEventModal(null)}>×</button>
            </div>
            <div className="modal-body">
              <pre className="event-modal-pre">{eventModal.body}</pre>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => { void navigator.clipboard?.writeText(eventModal.body).catch(() => {}); }}>Copy</button>
              <button className="btn-primary" onClick={() => setEventModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {leaveAsk && (
        <div className="modal-backdrop" onClick={() => setLeaveAsk(null)}>
          <div className="modal-panel pg-leave-ask" role="alertdialog" aria-label="Leave this run?" onClick={e => e.stopPropagation()}>
            <div className="modal-header"><h3>Leave this run?</h3></div>
            <div className="modal-body"><p>Choices made so far are discarded.</p></div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setLeaveAsk(null)}>Stay</button>
              <button className="btn-primary" onClick={() => { const go = leaveAsk; setLeaveAsk(null); go(); }}>Leave</button>
            </div>
          </div>
        </div>
      )}
      {journeyModal && (
        <JourneyModal format={journeyModal.format} stages={journeyModal.stages} profileArgs={journeyModal.profileArgs} onClose={() => setJourneyModal(null)} />
      )}
      {/* Sanitise the loaded customer sample using the Sample Library's own flow. Opened
          from the Source Data step's banner; in apply mode it seeds from the loaded sample,
          opens straight on the review step, and on Apply hands the sanitised events back via
          onApplySanitised — it never shows the library save destinations. */}
      <SanitizeWizard
        open={sanitiseModalOpen}
        onClose={() => setSanitiseModalOpen(false)}
        runMode={getRunMode()}
        applyMode
        initialRaw={state.sampleEvents}
        initialSourcetype={effectiveSourcetype}
        onApply={onApplySanitised}
      />
      {/* Batch pre-flight sample picker: the same modal in pick mode. Sample
          first (library, saved, or own events sanitised), then the sourcetype
          it names — applyBatchPickedSample confirms that name for the row. */}
      <SanitizeWizard
        open={batchPickIndex != null}
        onClose={() => setBatchPickIndex(null)}
        runMode={getRunMode()}
        pickMode
        pickTitle={batchPickIndex == null ? '' : `Row ${batchPickIndex + 1} · ${batchRows[batchPickIndex]?.pack_name || ''}`}
        initialSourcetype={batchPickIndex == null ? '' : (preflightGate[batchPickIndex]?.draft || preflightGate[batchPickIndex]?.declared || '')}
        librarySample={() => batchPickIndex == null ? Promise.resolve(null) : loadBatchLibrarySample(batchPickIndex)}
        onPick={applyBatchPickedSample}
      />

      </div>
    </div>
  );
}

export default App;
