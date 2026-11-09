/**
 * Bring boards saved before the app had them (spec R6, plan Task 5).
 *
 * The standalone whiteboard saves a meeting as a self-contained .html with its data in
 * `<script id="snapshot" type="application/json">{"lib":…,"meet":…,"savedAt":…}</script>`,
 * and its Configure page copies the library as JSON. Both are accepted here, and so is a
 * board exported as JSON from Pack Generator on another Cribl org (./transfer.ts). Pure:
 * no storage, no DOM.
 */
import type { ArchDoc } from '../architecture/model';
import type { DiscoveryValidation, WhiteboardLibItem, WhiteboardLibV5, WhiteboardMeetV5 } from './types';
import { isBoardFile, readBoardFile } from './transfer';

export type ImportResult =
  | { kind: 'board'; meet: WhiteboardMeetV5; lib?: WhiteboardLibV5; savedAt?: string; validation?: DiscoveryValidation;
      /** A Pack Generator board file: every item's visibility is pinned (see transfer.ts hideItemsNotOnFile). */
      pinned?: true;
      /** The board's Architecture drawing, from a Pack Generator board file. */
      architecture?: ArchDoc }
  | { kind: 'library'; lib: WhiteboardLibV5 }
  | { kind: 'error'; message: string };

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isLib = (v: unknown): v is WhiteboardLibV5 => isObj(v) && v.v === 5 && isObj(v.groups);
const isMeet = (v: unknown): v is WhiteboardMeetV5 => isObj(v) && typeof v.prospect === 'string' && isObj(v.shown ?? {});

/** The snapshot element sits in <head> (the file writes it just before `</head>`). Its
 *  own code also contains that tag as a string, further down in <body> — so only the
 *  head is searched, or every unsaved copy of the file would look like a broken save. */
function snapshotJson(html: string): string | null {
  const headEnd = html.indexOf('</head>');
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const m = head.match(/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

export function parseWhiteboardFile(name: string, text: string): ImportResult {
  const trimmed = text.trimStart();
  if (/\.html?$/i.test(name) || trimmed.startsWith('<')) {
    const json = snapshotJson(text);
    if (!json) {
      return { kind: 'error', message: `${name} is not a saved whiteboard: it has no <script id="snapshot"> with the board's data. Save the board from the whiteboard file (Save → HTML) and import that.` };
    }
    let data: any;
    try { data = JSON.parse(json); } catch { return { kind: 'error', message: `${name}: the saved board's data is not valid JSON.` }; }
    if (!isObj(data) || !isMeet(data.meet)) return { kind: 'error', message: `${name}: the saved board has no meeting in it.` };
    return {
      kind: 'board',
      meet: data.meet,
      ...(isLib(data.lib) ? { lib: data.lib } : {}),
      ...(typeof data.savedAt === 'string' ? { savedAt: data.savedAt } : {}),
    };
  }
  let data: any;
  try { data = JSON.parse(text); } catch { return { kind: 'error', message: `${name} is neither a saved whiteboard (.html) nor a whiteboard or library (.json).` }; }
  if (isBoardFile(data)) {
    const r = readBoardFile(name, data);
    if (!r.ok) return { kind: 'error', message: r.message };
    return { kind: 'board', meet: r.meet, lib: r.lib, pinned: true, ...(r.createdAt ? { savedAt: r.createdAt } : {}), ...(r.validation ? { validation: r.validation } : {}), ...(r.architecture ? { architecture: r.architecture } : {}) };
  }
  if (isLib(data)) return { kind: 'library', lib: data };
  if (isObj(data) && isObj(data.sources) && Array.isArray(data.sources.items)) {
    return { kind: 'error', message: `${name} is a v4.3 configuration. Open any whiteboard, go to Configure and paste it into "Apply pasted JSON" — the board converts it.` };
  }
  return { kind: 'error', message: `${name} is JSON but neither a whiteboard exported from Pack Generator nor a whiteboard library (expected "v": 5 and "groups").` };
}

/**
 * Add what `theirs` has that `mine` does not: the SE's own items (by id), and learned
 * aliases (by words). Never changes or removes anything already in `mine`.
 */
export function mergeLibraries(mine: WhiteboardLibV5 | null, theirs: WhiteboardLibV5): { lib: WhiteboardLibV5; added: number } {
  if (!mine) return { lib: theirs, added: Object.values(theirs.groups).reduce((n, g) => n + (g.items || []).filter(i => i.custom).length, 0) };
  const out: WhiteboardLibV5 = JSON.parse(JSON.stringify(mine));
  let added = 0;
  for (const [g, grp] of Object.entries(theirs.groups)) {
    const target = (out.groups[g] ||= { items: [] });
    const have = new Set(target.items.map(i => i.id));
    for (const item of (grp.items || []) as WhiteboardLibItem[]) {
      if (!item?.custom || !item.id || have.has(item.id)) continue;
      target.items.push({ ...item });
      have.add(item.id);
      added++;
    }
  }
  if (theirs.discoveryAliases) {
    const a = (out.discoveryAliases ||= { sources: {}, dests: {} });
    for (const [k, v] of Object.entries(theirs.discoveryAliases.sources || {})) if (!(k in a.sources)) { a.sources[k] = v; added++; }
    for (const [k, v] of Object.entries(theirs.discoveryAliases.dests || {})) if (!(k in a.dests)) { a.dests[k] = v; added++; }
  }
  return { lib: out, added };
}
