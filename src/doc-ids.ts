// Ids shared by the opener (App.tsx) and the document shell (src/doc-shell.ts). Kept
// apart from doc-shell so the startup bundle does not carry the documents' stylesheet.

/** postMessage type the opener (App.tsx `openAppDoc`) listens for. */
export const DOC_OPEN_MESSAGE = 'pack-generator:open-doc';

export type AppDocId = 'guide' | 'technical';

/** File names of the generated copies in docs/ (and the cross-link hrefs). */
export const DOC_FILES: Record<AppDocId, string> = {
  guide: 'user-guide.html',
  technical: 'scoring-explained.html',
};
