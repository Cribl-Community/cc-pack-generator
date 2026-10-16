import {
  selectReferenceLookups,
  type ReferenceLookupIndex,
  type SelectedReferenceLookup,
} from './reference-lookup-select';

/**
 * The golden lookup corpus, as a Backend Function sees it (build 753).
 *
 * A background-built pack needs the same `data/lookups/` a wizard-built one
 * gets — without `cisco_asa_parsing.csv` the ASA/FTD pipeline's lookup function
 * resolves nothing and every code-specific field is simply absent. But the
 * module that holds the corpus in the browser (`bundled-data.ts`) also drags in
 * the 11 MB golden-pipelines corpus, which is precisely what must never reach a
 * Backend Function's 5 MB bundle (Hard Rule 34), and there is no Vite handler to
 * ask either (Hard Rule 17).
 *
 * So the corpus — ~160 KB, the whole of `config/golden-lookups/` — is injected
 * by the PACKAGER as an esbuild define, and read here. `scripts/pkgutil.mjs`
 * (`backendReferenceLookupPayload`) is the only writer.
 */
export interface BackendReferenceLookupPayload {
  index: ReferenceLookupIndex;
  /** filename → verbatim CSV text, for every file the index names. */
  files: Record<string, string>;
}

declare const BACKEND_REFERENCE_LOOKUPS: string;

/**
 * The injected payload as raw JSON text, or '' when nothing injected it.
 *
 * `try`/`catch` rather than `typeof BACKEND_REFERENCE_LOOKUPS === 'undefined'`
 * for one measurable reason: esbuild's `define` is a TEXTUAL substitution at
 * every occurrence, and the `typeof` form has two — which would inline the
 * whole ~123 KB string literal twice. This has exactly one. In the browser
 * builds nothing defines the identifier, so the bare read throws ReferenceError
 * and we degrade to no corpus.
 */
function embeddedPayloadText(): string {
  try {
    return BACKEND_REFERENCE_LOOKUPS;
  } catch {
    return '';
  }
}

let parsed: BackendReferenceLookupPayload | null | undefined;

/** The embedded corpus, parsed once, or null when the build did not inject one. */
export function embeddedReferenceLookups(): BackendReferenceLookupPayload | null {
  if (parsed !== undefined) return parsed;
  const text = embeddedPayloadText();
  if (typeof text !== 'string' || text.length === 0) {
    parsed = null;
    return parsed;
  }
  try {
    const payload = JSON.parse(text) as BackendReferenceLookupPayload;
    parsed = payload && typeof payload === 'object' && payload.files ? payload : null;
  } catch {
    parsed = null;
  }
  return parsed;
}

/** Drop the memoized parse. Tests install a payload and re-read; nothing else. */
export function resetEmbeddedReferenceLookups(): void {
  parsed = undefined;
}

/**
 * The lookups a sourcetype needs, from the embedded corpus. Empty when no
 * corpus was injected — the honest answer for a build that did not ship one,
 * and never a request to a Vite route that cannot exist here.
 */
export function backendReferenceLookups(sourcetype: string): SelectedReferenceLookup[] {
  const payload = embeddedReferenceLookups();
  if (!payload) return [];
  return selectReferenceLookups(sourcetype, payload.index, file => payload.files[file]);
}
