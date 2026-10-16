// The two tool areas in the left rail — Settings and Samples — and their tabs, in
// one place: the rail, the page tab lists and every "open settings" link elsewhere
// in the app resolve through here, so a link can never land on a tab this run mode
// does not have. Pure data, no React.

export type SettingsTab = 'ai' | 'connection' | 'quality' | 'goldens' | 'datatypes';
export type SamplesTab = 'sanitize' | 'review' | 'library' | 'sharing';
export type ToolPage =
  | { area: 'settings'; tab: SettingsTab }
  | { area: 'samples'; tab: SamplesTab };
export type ToolArea = ToolPage['area'];
export type ToolRunMode = 'iframe' | 'standalone' | 'backend';

export interface ToolTab<T extends string = string> {
  id: T;
  icon: string;
  label: string;
  desc: string;
  /** Only exists with the local dev server behind it (disk, .env, scoring source). */
  standaloneOnly?: boolean;
}

export const TOOL_AREAS: Record<ToolArea, { title: string; desc: string }> = {
  settings: { title: 'Settings', desc: 'AI provider, connections, quality thresholds, shared goldens and Search datatypes.' },
  samples: { title: 'Samples', desc: 'Sanitize real events, review generated samples, and choose how sanitised samples are shared.' },
};

export const SETTINGS_TABS: ToolTab<SettingsTab>[] = [
  { id: 'ai', icon: '✦', label: 'AI', desc: 'Provider, key and models' },
  { id: 'connection', icon: '⇄', label: 'Connection', desc: 'Cribl Cloud login and score logging', standaloneOnly: true },
  { id: 'quality', icon: '◎', label: 'Quality', desc: 'Golden thresholds per stage' },
  { id: 'goldens', icon: '★', label: 'Goldens', desc: 'Shared repo, import and publish' },
  { id: 'datatypes', icon: '▦', label: 'Datatypes', desc: 'Cribl Search coverage check' },
];

export const SAMPLES_TABS: ToolTab<SamplesTab>[] = [
  { id: 'sanitize', icon: '🧼', label: 'Sanitize', desc: 'Replace identities, keep a validated sample' },
  { id: 'review', icon: '☑', label: 'Review queue', desc: 'Promote or reject staged samples' },
  { id: 'library', icon: '▤', label: 'Library', desc: 'Committed and sanitised samples' },
  { id: 'sharing', icon: '⇪', label: 'Sharing', desc: 'Privacy rule and the shared sample pool' },
];

export function toolTabs(area: 'settings', runMode: ToolRunMode): ToolTab<SettingsTab>[];
export function toolTabs(area: 'samples', runMode: ToolRunMode): ToolTab<SamplesTab>[];
export function toolTabs(area: ToolArea, runMode: ToolRunMode): ToolTab[];
export function toolTabs(area: ToolArea, runMode: ToolRunMode): ToolTab[] {
  const all: ToolTab[] = area === 'settings' ? SETTINGS_TABS : SAMPLES_TABS;
  return all.filter(t => !t.standaloneOnly || runMode === 'standalone');
}

/** A page this run mode can show: an unavailable tab falls back to the area's first tab. */
export function resolveToolPage(page: ToolPage, runMode: ToolRunMode): ToolPage {
  const tabs = toolTabs(page.area, runMode);
  if (tabs.some(t => t.id === page.tab)) return page;
  return { area: page.area, tab: tabs[0].id } as ToolPage;
}

/** Every place outside the rail that sends the user to a setting. */
export type ToolLink =
  | 'configure-ai'      // Source step: AI not configured
  | 'ai-banner'         // top banner: AI unavailable
  | 'sample-sharing'    // Sample library / sanitize wizard: shared-pool repo and token
  | 'goldens';

export function toolLink(link: ToolLink, runMode: ToolRunMode): ToolPage {
  const page: ToolPage =
    link === 'configure-ai' || link === 'ai-banner' ? { area: 'settings', tab: 'ai' }
    : link === 'sample-sharing' ? { area: 'samples', tab: 'sharing' }
    : { area: 'settings', tab: 'goldens' };
  return resolveToolPage(page, runMode);
}

/** The Sample Library's own view for a Samples tab; null for tabs it does not render. */
export function sampleLibraryView(tab: SamplesTab): 'sanitised' | 'staged' | 'library' | null {
  return tab === 'sanitize' ? 'sanitised' : tab === 'review' ? 'staged' : tab === 'library' ? 'library' : null;
}

export type ToolHealth = 'ok' | 'error' | 'checking';

/**
 * The rail Settings dot: red when anything it owns is broken. Score logging only
 * counts in standalone — inside Cribl there is no scoring source to be down.
 */
export function settingsHealth(ai: ToolHealth, scoring: boolean | null, runMode: ToolRunMode): ToolHealth {
  if (ai === 'error' || (runMode === 'standalone' && scoring === false)) return 'error';
  if (ai === 'checking' || (runMode === 'standalone' && scoring == null)) return 'checking';
  return 'ok';
}
