/**
 * What is ON a whiteboard, computed the way the vendored board computes it.
 *
 * The board resolves each group's items from the SE's library (`LIB.groups[g].items`,
 * built-ins merged in by id from its DEFAULTS, plus built-ins shipped after the library
 * was saved unless the SE deleted them) and shows an item when the meeting says so
 * (`MEET.shown["g:id"]`), else when its library entry is on. These helpers mirror
 * `mergeLib`, `items` and `isShown` of the vendored file against its generated
 * catalogue, so the app can summarise a board and read its intake without the frame.
 */
import { BOARD_DEFAULTS, type BoardCatalogItem } from './catalog.generated';
import type { WhiteboardLibV5, WhiteboardMeetV5, WhiteboardLibItem } from './types';

export type BoardItem = BoardCatalogItem & WhiteboardLibItem & { builtin: boolean };

/** Groups whose items are destinations, as the board's three store columns. */
export const DESTINATION_GROUPS = ['point', 'cribl', 'platform'] as const;

const baseOn = (d: BoardCatalogItem): boolean => !d.sg && d.on !== false;

/** The library entries of one group, as the board's `mergeLib` would leave them. */
function libEntries(lib: WhiteboardLibV5 | null | undefined, group: string): WhiteboardLibItem[] {
  const defaults = BOARD_DEFAULTS[group] || [];
  const stored = lib?.groups?.[group]?.items;
  if (!Array.isArray(stored)) return defaults.map(d => ({ id: d.id, on: baseOn(d) }));
  const builtinIds = new Set(defaults.map(d => d.id));
  const removed = new Set(Array.isArray(lib?.removed) ? lib!.removed : []);
  let kept = stored.filter(li => li && li.id && (li.custom || builtinIds.has(li.id)));
  // The people start empty (P13): a library saved before has its built-in profiles turned off, once; the SE's own stay.
  if (group === 'humans' && !lib?.peopleEmpty) kept = kept.map(li => (li.custom ? li : { ...li, on: false }));
  const have = new Set(kept.map(li => li.id));
  for (const d of defaults) if (!have.has(d.id) && !removed.has(d.id)) kept.push({ id: d.id, on: baseOn(d) });
  return kept;
}

/** Every item of a group: built-in text plus whatever the library changed. */
export function groupItems(lib: WhiteboardLibV5 | null | undefined, group: string): BoardItem[] {
  const byId = new Map((BOARD_DEFAULTS[group] || []).map(d => [d.id, d]));
  return libEntries(lib, group).map(li => {
    const d = byId.get(li.id);
    return d ? { ...d, ...li, builtin: true } : { ...(li as BoardCatalogItem), ...li, label: li.label || '', builtin: false };
  });
}

/** Cribl Detect on an empty board waits for the pipeline. A × after that keeps it off (`shown` false). */
function detectWaits(meet: WhiteboardMeetV5 | null | undefined, group: string, item: { id: string }): boolean {
  return !!meet?.detectWithPipe && group === 'point' && item.id === 'pt-detect' && (meet.view?.pipe ?? 'before') !== 'after';
}

export function isShown(meet: WhiteboardMeetV5 | null | undefined, group: string, item: { id: string; on?: boolean }): boolean {
  if (detectWaits(meet, group, item)) return false;
  const key = `${group}:${item.id}`;
  const shown = meet?.shown || {};
  return key in shown ? shown[key] === true : item.on !== false;
}

/** The items on the board for one group. */
export function liveItems(lib: WhiteboardLibV5 | null | undefined, meet: WhiteboardMeetV5 | null | undefined, group: string): BoardItem[] {
  return groupItems(lib, group).filter(it => isShown(meet, group, it));
}

const norm = (s: string): string => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

/** Built-ins are identified by id (language-independent), the SE's own items by their text. */
export const intakeItemKey = (group: string, it: BoardItem): string =>
  it.builtin ? `${group}:${it.id}` : `${group}:custom:${norm(it.label || '')}`;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Changes when a source or destination is added, removed or (for the SE's own
 * items) renamed — and not when the story step, theme, arrows or selections change.
 * A validation or a deploy recorded against another fingerprint is stale.
 */
export function intakeFingerprint(lib: WhiteboardLibV5 | null | undefined, meet: WhiteboardMeetV5 | null | undefined): string {
  const keys: string[] = [];
  for (const g of ['sources', ...DESTINATION_GROUPS]) for (const it of liveItems(lib, meet, g)) keys.push(intakeItemKey(g, it));
  return fnv1a(keys.sort().join('\n'));
}

/** The list thumbnail: which layers are on, and how full each store column is. */
export function boardSketch(lib: WhiteboardLibV5 | null | undefined, meet: WhiteboardMeetV5 | null | undefined) {
  const view = meet?.view || {};
  const pipe: 'before' | 'after' | 'off' = view.pipe === 'after' ? 'after' : view.pipe === 'off' ? 'off' : 'before';
  const summary = boardSummary(lib, meet);
  return {
    sources: summary.sources,
    point: liveItems(lib, meet, 'point').length,
    cribl: liveItems(lib, meet, 'cribl').length,
    platform: liveItems(lib, meet, 'platform').length,
    pipe,
    search: view.search === 'after',
    ai: view.ai === 'after',
    pains: summary.pains,
    useCases: summary.useCases,
  };
}

export function boardSummary(lib: WhiteboardLibV5 | null | undefined, meet: WhiteboardMeetV5 | null | undefined) {
  const selected = (group: 'pains' | 'usecases', sel: Record<string, boolean> | undefined) =>
    liveItems(lib, meet, group).filter(it => sel?.[it.id] === true).length;
  // Discover has no Show / Hide any more (build 961): a pick is on the board, whatever an older view says.
  return {
    sources: liveItems(lib, meet, 'sources').length,
    destinations: DESTINATION_GROUPS.reduce((n, g) => n + liveItems(lib, meet, g).length, 0),
    pains: selected('pains', meet?.paSel),
    useCases: selected('usecases', meet?.ucSel),
  };
}

/** Groups an empty board starts without: the prospect's sources and their two store columns.
 *  Cribl Detect is a Cribl item in the point column; `detectWithPipe` holds it until the pipeline. */
export const ESTATE_GROUPS = ['sources', 'point', 'platform'] as const;

/**
 * A new meeting with nothing on its stores: every source and store the library would show
 * is hidden for this meeting only (`shown[g:id] = false`, exactly what the board's × writes),
 * so the SE adds what the prospect names with + and the library itself is untouched. Cribl's
 * own stores (Cribl Lake, the Lakehouse Engine, Cribl Detect) start hidden too: the SE adds
 * the ones the prospect needs, and only those reach the Architecture tab (user, 2026-11-04).
 * The pipeline, the layers and Discover are untouched.
 */
export function blankMeet(lib: WhiteboardLibV5 | null | undefined, today = new Date()): WhiteboardMeetV5 {
  const meet = emptyMeet(today);
  for (const g of [...ESTATE_GROUPS, 'cribl']) {
    for (const it of groupItems(lib, g)) if (isShown(meet, g, it)) meet.shown[`${g}:${it.id}`] = false;
  }
  // after the loop: with the hold set first, Detect would look hidden and keep no × of its own
  meet.detectWithPipe = true;
  return meet;
}

/** A meeting the board accepts as new: the shape of its own `freshMeet()`. */
export function emptyMeet(today = new Date()): WhiteboardMeetV5 {
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return { v: 5, prospect: '', logo: '', view: {}, shown: {}, ucSel: {}, paSel: {}, arrows: [], auto: 'clean', started: d };
}
