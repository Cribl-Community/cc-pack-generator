// Deep links into the separate "Cribl Pipeline Visualizer" app, mounted on the
// same Cribl instance this tool manages. Kept as its own tiny module (not
// pack-builder.ts) so ScoringReport.tsx — which deliberately imports no
// pack-builder code (see its header comment) — can use it without pulling in
// the generator's dependency graph.
//
// Link shapes (Pipeline Visualizer 1.4.0):
//   /apps/a/cribl-pipeline-visualizer/groups/<group>/packs/<pack>
//   /apps/a/cribl-pipeline-visualizer/groups/<group>/packs/<pack>/pipelines/<pipeline>
import { getApiBase } from './sample-io';
import { getRunMode } from './run-mode';

/**
 * The Cribl instance's own origin (protocol+host[+base path]), with no
 * trailing `/api/v1`. Only resolvable in 'iframe' mode — this app is itself a
 * Cribl App Platform add-on, so `CRIBL_API_URL` IS the host it's running
 * inside. In 'standalone' (local `npm run dev`) or 'backend' (a Backend
 * Function has no browser to open a tab from) there is no reliable base URL
 * to build a navigable link from — callers should hide the button rather
 * than guess.
 */
export function criblInstanceBaseUrl(): string | null {
  if (getRunMode() !== 'iframe') return null;
  return getApiBase().replace(/\/api\/v1\/?$/, '');
}

/**
 * Build a Pipeline Visualizer URL for a pack (and, when known, one specific
 * pipeline inside it). `group`/`packId`/`pipelineId` are used verbatim as URL
 * path segments — Cribl's own API already treats them as literal path
 * segments (`/m/<group>/p/<packId>/pipelines/<pipelineId>`), so no further
 * transformation is needed here, only percent-encoding.
 */
export function pipelineVisualizerUrl(baseUrl: string, group: string, packId: string, pipelineId?: string): string {
  const seg = (s: string) => encodeURIComponent(s);
  const path = pipelineId
    ? `/apps/a/cribl-pipeline-visualizer/groups/${seg(group)}/packs/${seg(packId)}/pipelines/${seg(pipelineId)}`
    : `/apps/a/cribl-pipeline-visualizer/groups/${seg(group)}/packs/${seg(packId)}`;
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

// --- Is the Visualizer installed? ---------------------------------------------
//
// The Visualizer is a SEPARATE app, shared privately — most customer orgs do not
// have it. Cribl answers `/apps/a/<unknown id>` with its generic "You do not
// have sufficient permissions" page, so a link to a missing app reads as an
// access problem rather than "not installed". Every call site therefore shows a
// plain notice first instead of the broken page.
//
// An app cannot find out: Cribl's preinstall check rejects any `/apps` path in
// policies.yml ("Apps management paths are not allowed"), so there is no app
// list to read. The probe answers 'unknown' without a request; 'installed' and
// 'missing' stay in the type for the day Cribl exposes the answer.

export const PIPELINE_VISUALIZER_APP_ID = 'cribl-pipeline-visualizer';

export type VisualizerAvailability = 'installed' | 'missing' | 'unknown';

export const VISUALIZER_MISSING_NOTICE =
  "Pipeline Visualizer isn't installed in this Cribl organization. It's a separate Cribl app that draws this pipeline as a diagram. Ask your Cribl Solutions Engineer for the app, then install it under App Platform → Add App.";
export const VISUALIZER_UNKNOWN_NOTICE =
  "Pipeline Visualizer is a separate Cribl app that draws this pipeline as a diagram. If it isn't installed in this Cribl organization, Cribl shows a \"sufficient permissions\" page instead: ask your Cribl Solutions Engineer for the app, then install it under App Platform → Add App.";
/** One line for the static HTML reports, which cannot show a notice. */
export const VISUALIZER_REPORT_NOTE =
  'The 🔗 links open the separate Pipeline Visualizer app. If it is not installed in this Cribl organization, Cribl shows a permissions page: ask your Cribl Solutions Engineer for the app.';

let settled: VisualizerAvailability | null = null;

export function probePipelineVisualizer(): Promise<VisualizerAvailability> {
  settled = 'unknown';
  return Promise.resolve(settled);
}

/** The probe's answer if it has finished, else null (still checking / not started). */
export function cachedVisualizerAvailability(): VisualizerAvailability | null {
  return settled;
}

/** Test hook: forget the cached probe. */
export function resetVisualizerProbeForTests(): void {
  settled = null;
}

/**
 * What a Visualizer control renders for a probe state — the ONE decision every
 * call site shares. `null` (probe not finished) is treated as 'unknown': the
 * user still gets the notice plus the link, never the broken page.
 */
export type VisualizerControl =
  | { kind: 'link' }
  | { kind: 'notice'; text: string; openAnyway: boolean };

export function visualizerControl(availability: VisualizerAvailability | null): VisualizerControl {
  if (availability === 'installed') return { kind: 'link' };
  if (availability === 'missing') return { kind: 'notice', text: VISUALIZER_MISSING_NOTICE, openAnyway: false };
  return { kind: 'notice', text: VISUALIZER_UNKNOWN_NOTICE, openAnyway: true };
}
