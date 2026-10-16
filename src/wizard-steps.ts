// The wizard's modes and step sequences, in one place: the left rail, the home
// cards and the step pills all read from here, so a mode's pills can never
// disagree with the screens it actually walks through. Pure data, no React.

export type WizardMode = 'add-pipeline' | 'batch' | 'demo' | 'experiment' | 'post-process' | 'flow';

export interface WizardModeInfo {
  id: WizardMode;
  icon: string;
  /** Short name for the left rail. */
  name: string;
  /** Full title on the home card. */
  title: string;
  desc: string;
  badge?: string;
  /** Kept working (startMode, resume, breadcrumbs) but not offered on the rail or home cards. */
  hidden?: boolean;
}

export const WIZARD_MODES: WizardModeInfo[] = [
  // Replaced on the menu by Build pack flow; the mode itself still works.
  { id: 'experiment', icon: '✦', name: 'Create new pack', title: 'Create new pack', hidden: true,
    desc: 'Build and check extraction, destination mapping, and output shaping. Extraction and mapping can reuse golden knowledge.' },
  { id: 'flow', icon: '⇶', name: 'Build pack flow', title: 'Build pack flow (including post-processing)',
    desc: 'Build a pack with a visual destination flow. Extraction and mapping can reuse golden knowledge. When OCSF is a destination, also builds the post-processing packs that reshape it for other SIEMs, in one run.' },
  { id: 'add-pipeline', icon: '＋', name: 'Modify existing pack', title: 'Modify existing pack',
    desc: 'Add a new pipeline or improve an existing pipeline in a pack already deployed in your environment.' },
  { id: 'batch', icon: '☰', name: 'Batch create', title: 'Batch create',
    desc: 'Upload a CSV/JSON file to create multiple packs and pipelines in one go — in this tab, or in the background (server-side, you can close the tab).' },
  { id: 'demo', icon: '◎', name: 'Demo environment', title: 'Create/Clean demo environment',
    desc: 'Stand up a ready customer demo (live datagen, packs per destination format, isolated routing) — or clean up an earlier demo.' },
  // Off the menu for now (Build pack flow builds post-processing packs); the mode still works.
  { id: 'post-process', icon: '⟲', name: 'Post-processing', title: 'Create a post-processing pipeline', hidden: true,
    desc: 'Transform data you already normalized (OCSF) into a SIEM standard format on the way out. Deploys a self-contained pack you attach as a destination post-processing pipeline.' },
];

/** The modes offered on the left rail and the home cards. */
export const MENU_MODES: WizardModeInfo[] = WIZARD_MODES.filter(m => !m.hidden);

export interface WizardStepContext {
  addImproveAction: 'add' | 'optimize' | null;
  optimizeSample: boolean;
  batchBackground: boolean;
  /** Demo: the clean-up path (scan → remove) instead of create. */
  demoCleanup: boolean;
}

/** [step id, pill label]. Step ids are App.tsx's `Step` values. */
export type WizardStep = readonly [string, string];

export function wizardSteps(mode: WizardMode, ctx: WizardStepContext): WizardStep[] {
  switch (mode) {
    case 'experiment':
      return [['select-group', 'Group'], ['name', 'Name'], ['source', 'Source'], ['destination', 'Destinations'],
        ['experiment-setup', 'Build plan'], ['experiment-running', 'Build'], ['experiment-done', 'Results']];
    case 'flow':
      // No Name step (the pack is named on the Flow screen) and no Review step
      // (the Build screen opens with a short summary).
      return [['select-group', 'Group'], ['source', 'Source'], ['destination', 'Flow'],
        ['experiment-running', 'Build'], ['experiment-done', 'Results']];
    case 'add-pipeline':
      if (ctx.addImproveAction === 'optimize') {
        return [['select-group', 'Group'], ['select-pack', 'Pack'], ['select-action', 'Action'], ['select-pipeline', 'Pipeline'],
          ['optimize-goals', 'Goals'], ...(ctx.optimizeSample ? [['optimize-sample', 'Sample'] as const] : []),
          ['optimize-running', 'Improve'], ['optimize-done', 'Done']];
      }
      return [['select-group', 'Group'], ['select-pack', 'Pack'], ['select-action', 'Action'], ['source', 'Source'],
        ['destination', 'Destination'], ['ai-analysis', 'AI analysis'], ['options', 'Options'], ['review', 'Review'],
        ['deploying', 'Deploy'], ['done', 'Done']];
    case 'batch':
      return ctx.batchBackground
        ? [['batch-upload', 'Upload'], ['batch-preflight', 'Pre-flight'], ['select-group', 'Group'], ['batch-bg-running', 'Background run']]
        : [['batch-upload', 'Upload'], ['batch-preflight', 'Pre-flight'], ['select-group', 'Group'], ['batch-running', 'Deploy'], ['batch-done', 'Done']];
    case 'demo':
      return ctx.demoCleanup
        ? [['demo-group', 'Group'], ['demo-sources', 'Sources'], ['demo-cleanup', 'Clean up'], ['demo-cleanup-done', 'Done']]
        : [['demo-group', 'Group'], ['demo-sources', 'Sources'], ['demo-destinations', 'Destinations'], ['demo-routing', 'Routing'],
          ['demo-deploying', 'Build'], ['demo-done', 'Live']];
    case 'post-process':
      return [['select-group', 'Group'], ['name', 'Name'], ['pp-formats', 'Formats'], ['deploying', 'Deploy'], ['done', 'Done']];
  }
}

/** Steps that do work (a build, deploy or scan in flight): no jumping away from them. */
const BUSY = new Set(['experiment-running', 'optimize-running', 'deploying', 'batch-running', 'batch-bg-running', 'demo-deploying']);

export function isBusyStep(step: string): boolean {
  return BUSY.has(step);
}

/**
 * A pill is clickable only to go BACK to an earlier form step, never forward
 * (the Next buttons own the checks), never into or out of a step doing work,
 * and never from a result screen (that run is over; start again from the rail).
 */
export function canJumpToStep(steps: WizardStep[], current: string, target: string): boolean {
  const ci = steps.findIndex(s => s[0] === current);
  const ti = steps.findIndex(s => s[0] === target);
  if (ci < 0 || ti < 0 || ti >= ci) return false;
  if (isBusyStep(current) || isBusyStep(target)) return false;
  if (steps.slice(ti, ci + 1).some(s => isBusyStep(s[0]))) return false;
  return true;
}
