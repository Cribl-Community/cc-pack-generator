/**
 * Pack-build wizard draft: survives refresh and accidental navigation for
 * Build pack flow, Modify existing pack, Create new pack, and Post-processing.
 * Batch and Demo use their own checkpoint models.
 */
import type { WizardState } from './types';
import type { FlowPpState } from './flow-builder';
import { getRunMode } from './run-mode';
import { safeGetItem, safeRemoveItem, safeSetItemDurable } from './safe-storage';
import { getApiBase } from './sample-io';
import { isBusyStep } from './wizard-steps';

export const WIZARD_DRAFT_VERSION = 1;
export const WIZARD_DRAFT_KV_KEY = 'wizard-draft/active';
export const WIZARD_DRAFT_LS_KEY = 'wizard-draft';

export type PackModeDraft = 'flow' | 'add-pipeline' | 'experiment' | 'post-process';

export interface WizardDraftDocument {
  version: typeof WIZARD_DRAFT_VERSION;
  updatedAt: number;
  packMode: PackModeDraft;
  step: string;
  /** Set when the user refreshed or closed the tab during a busy build/deploy step. */
  interruptedOnBusy?: boolean;
  state: WizardState;
  sourcetype: string;
  customSourcetype: string;
  isCustomSourcetype: boolean;
  customConfirmed: boolean;
  confirmedFormat: string;
  selectedGroup: string;
  selectedPackId: string;
  addImproveAction: 'add' | 'optimize' | null;
  optimizePipelineId: string;
  optimizeGoals: { sample: boolean; extraction: boolean; mapping: boolean; optimization: boolean };
  optimizeGuidance: string;
  flowOptimize: Record<string, boolean>;
  flowSrcRules: Record<string, boolean>;
  flowOcsfKeepRaw: boolean;
  flowOverwrite: boolean;
  flowPpOverwrite: boolean;
  flowNameEdited: boolean;
  flowPp: FlowPpState;
  allowCodeFunctions: boolean;
  createDatagen: boolean;
  autoValidate: boolean;
  reductionToggles: Record<string, boolean>;
  ppSourceFormat: string;
  ppDestFormat: string;
  ppSchema: string;
}

const PERSIST_MODES = new Set<PackModeDraft>(['flow', 'add-pipeline', 'experiment', 'post-process']);

export function isPackBuildDraftMode(packMode: string): packMode is PackModeDraft {
  return PERSIST_MODES.has(packMode as PackModeDraft);
}

/** Form steps worth saving; busy/result screens are not written as the live step. */
export function shouldPersistWizardDraft(step: string, packMode: string): boolean {
  if (step === 'mode' || !isPackBuildDraftMode(packMode)) return false;
  if (isBusyStep(step)) return false;
  const done = new Set(['experiment-done', 'done', 'optimize-done']);
  return !done.has(step);
}

/** Where to land after Resume when the draft was captured mid-build. */
export function wizardResumeStepAfterInterrupt(mode: PackModeDraft, interruptedStep: string): string {
  switch (interruptedStep) {
    case 'experiment-running':
      return mode === 'flow' ? 'destination' : 'experiment-setup';
    case 'deploying':
      return mode === 'post-process' ? 'pp-formats' : 'review';
    case 'optimize-running':
      return 'optimize-goals';
    default:
      return mode === 'flow' ? 'destination' : 'source';
  }
}

export function wizardDraftLabel(packMode: PackModeDraft): string {
  switch (packMode) {
    case 'flow': return 'Build pack flow';
    case 'add-pipeline': return 'Modify existing pack';
    case 'experiment': return 'Create new pack';
    case 'post-process': return 'Post-processing pack';
  }
}

export interface SerializeWizardDraftInput {
  packMode: PackModeDraft;
  step: string;
  state: WizardState;
  sourcetype: string;
  customSourcetype: string;
  isCustomSourcetype: boolean;
  customConfirmed: boolean;
  confirmedFormat: string;
  selectedGroup: string;
  selectedPackId: string;
  addImproveAction: 'add' | 'optimize' | null;
  optimizePipelineId: string;
  optimizeGoals: WizardDraftDocument['optimizeGoals'];
  optimizeGuidance: string;
  flowOptimize: Record<string, boolean>;
  flowSrcRules: Record<string, boolean>;
  flowOcsfKeepRaw: boolean;
  flowOverwrite: boolean;
  flowPpOverwrite: boolean;
  flowNameEdited: boolean;
  flowPp: FlowPpState;
  allowCodeFunctions: boolean;
  createDatagen: boolean;
  autoValidate: boolean;
  reductionToggles: Record<string, boolean>;
  ppSourceFormat: string;
  ppDestFormat: string;
  ppSchema: string;
}

export function serializeWizardDraft(input: SerializeWizardDraftInput): WizardDraftDocument {
  return {
    version: WIZARD_DRAFT_VERSION,
    updatedAt: Date.now(),
    packMode: input.packMode,
    step: input.step,
    state: { ...input.state },
    sourcetype: input.sourcetype,
    customSourcetype: input.customSourcetype,
    isCustomSourcetype: input.isCustomSourcetype,
    customConfirmed: input.customConfirmed,
    confirmedFormat: input.confirmedFormat,
    selectedGroup: input.selectedGroup,
    selectedPackId: input.selectedPackId,
    addImproveAction: input.addImproveAction,
    optimizePipelineId: input.optimizePipelineId,
    optimizeGoals: { ...input.optimizeGoals },
    optimizeGuidance: input.optimizeGuidance,
    flowOptimize: { ...input.flowOptimize },
    flowSrcRules: { ...input.flowSrcRules },
    flowOcsfKeepRaw: input.flowOcsfKeepRaw,
    flowOverwrite: input.flowOverwrite,
    flowPpOverwrite: input.flowPpOverwrite,
    flowNameEdited: input.flowNameEdited,
    flowPp: { ...input.flowPp, outputs: input.flowPp.outputs.map(o => ({ ...o })) },
    allowCodeFunctions: input.allowCodeFunctions,
    createDatagen: input.createDatagen,
    autoValidate: input.autoValidate,
    reductionToggles: { ...input.reductionToggles },
    ppSourceFormat: input.ppSourceFormat,
    ppDestFormat: input.ppDestFormat,
    ppSchema: input.ppSchema,
  };
}

function parseWizardDraft(raw: string | null): WizardDraftDocument | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WizardDraftDocument;
    if (!parsed || parsed.version !== WIZARD_DRAFT_VERSION) return null;
    if (!isPackBuildDraftMode(parsed.packMode)) return null;
    if (!parsed.state || typeof parsed.step !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** App KV limit is ~100 KiB; keep headroom for metadata. */
export const WIZARD_DRAFT_MAX_BYTES = 90_000;

export function fitWizardDraftSample(doc: WizardDraftDocument, maxBytes = WIZARD_DRAFT_MAX_BYTES): WizardDraftDocument {
  let body = JSON.stringify(doc);
  if (body.length <= maxBytes) return doc;
  const events = doc.state.sampleEvents || '';
  if (!events) return doc;
  const overhead = body.length - events.length;
  const budget = Math.max(0, maxBytes - overhead - 64);
  if (budget <= 0) {
    return { ...doc, state: { ...doc.state, sampleEvents: '' } };
  }
  const trimmed = events.length > budget ? events.slice(0, budget) : events;
  return { ...doc, state: { ...doc.state, sampleEvents: trimmed } };
}

export async function saveWizardDraft(doc: WizardDraftDocument): Promise<{ ok: boolean; trimmedSample: boolean }> {
  const fitted = fitWizardDraftSample(doc);
  const trimmedSample = fitted.state.sampleEvents !== doc.state.sampleEvents;
  const body = JSON.stringify(fitted);
  const durable = safeSetItemDurable(WIZARD_DRAFT_LS_KEY, body);
  if (getRunMode() === 'iframe') {
    try {
      await fetch(`${getApiBase()}/kvstore/${WIZARD_DRAFT_KV_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body,
      });
    } catch { /* browser copy above */ }
  }
  return { ok: durable || getRunMode() === 'iframe', trimmedSample };
}

export async function loadWizardDraft(): Promise<WizardDraftDocument | null> {
  if (getRunMode() === 'iframe') {
    try {
      const resp = await fetch(`${getApiBase()}/kvstore/${WIZARD_DRAFT_KV_KEY}`);
      if (resp.ok) {
        const parsed = parseWizardDraft(await resp.text());
        if (parsed) return parsed;
      }
    } catch { /* fall through */ }
  }
  return parseWizardDraft(safeGetItem(WIZARD_DRAFT_LS_KEY));
}

export async function clearWizardDraft(): Promise<void> {
  safeRemoveItem(WIZARD_DRAFT_LS_KEY);
  if (getRunMode() === 'iframe') {
    try {
      await fetch(`${getApiBase()}/kvstore/${WIZARD_DRAFT_KV_KEY}`, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
}

/** Snapshot immediately before refresh/close while a build is running. */
export function captureWizardDraftBeforeUnload(input: SerializeWizardDraftInput & { packMode: PackModeDraft }): void {
  if (!isPackBuildDraftMode(input.packMode)) return;
  if (!isBusyStep(input.step)) return;
  const doc: WizardDraftDocument = {
    ...serializeWizardDraft({ ...input, step: wizardResumeStepAfterInterrupt(input.packMode, input.step) }),
    interruptedOnBusy: true,
  };
  const body = JSON.stringify(fitWizardDraftSample(doc));
  safeSetItemDurable(WIZARD_DRAFT_LS_KEY, body);
}
