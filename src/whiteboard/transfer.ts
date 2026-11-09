/**
 * One board as a JSON file, to open it in Pack Generator on another Cribl org.
 *
 * What is on a board depends on the SE's library as well as the meeting: an item the
 * meeting says nothing about shows when its library entry is on. Another org has
 * another library, so the file pins every item's visibility into the meeting and
 * carries the SE's own items the board shows — the board opens there exactly as it
 * looks here. The check (`validation`) travels with it; what was deployed does not
 * (worker groups and demo names belong to this org). Pure: no storage, no DOM.
 */
import { BOARD_DEFAULTS } from './catalog.generated';
import { groupItems, isShown } from './board-model';
import type { DiscoveryValidation, WhiteboardDoc, WhiteboardLibItem, WhiteboardLibV5, WhiteboardMeetV5 } from './types';
import type { ArchDoc } from '../architecture/model';

export const BOARD_FILE_FORMAT = 'cribl-pack-generator-whiteboard';
export const BOARD_FILE_VERSION = 1;

export interface BoardFile {
  format: typeof BOARD_FILE_FORMAT;
  v: typeof BOARD_FILE_VERSION;
  exportedAt: string;
  board: { createdAt: string; updatedAt: string; meet: WhiteboardMeetV5; validation?: DiscoveryValidation };
  /** The SE's own items this board shows, by group. */
  items: Record<string, WhiteboardLibItem[]>;
  /** The board's Architecture drawing, when one is drawn. */
  architecture?: ArchDoc;
}

export function boardFile(doc: WhiteboardDoc, lib: WhiteboardLibV5 | null, now = new Date(), arch?: ArchDoc | null): BoardFile {
  const meet: WhiteboardMeetV5 = JSON.parse(JSON.stringify(doc.meet));
  const shown: Record<string, boolean> = { ...meet.shown };
  const items: Record<string, WhiteboardLibItem[]> = {};
  const groups = new Set([...Object.keys(BOARD_DEFAULTS), ...Object.keys(lib?.groups || {})]);
  for (const g of groups) {
    for (const it of groupItems(lib, g)) {
      const on = isShown(doc.meet, g, it);
      shown[`${g}:${it.id}`] = on;
      if (on && !it.builtin) {
        const { builtin: _b, ...entry } = it;
        (items[g] ||= []).push({ ...entry, custom: true });
      }
    }
    // A built-in this SE deleted from their library is not on the board; another library still has it.
    for (const d of BOARD_DEFAULTS[g] || []) if (!(`${g}:${d.id}` in shown)) shown[`${g}:${d.id}`] = false;
  }
  meet.shown = shown;
  return {
    format: BOARD_FILE_FORMAT,
    v: BOARD_FILE_VERSION,
    exportedAt: now.toISOString(),
    board: { createdAt: doc.createdAt, updatedAt: doc.updatedAt, meet, ...(doc.validation ? { validation: doc.validation } : {}) },
    items,
    ...(arch && Array.isArray(arch.nodes) && arch.nodes.length ? { architecture: arch } : {}),
  };
}

/**
 * The imported meeting against the library it lands in: the file pinned every item it
 * knew, so an item still unpinned is the other org's own (or a built-in newer than the
 * file) — not on this board. Hidden for this meeting only; the library is untouched.
 */
export function hideItemsNotOnFile(meet: WhiteboardMeetV5, lib: WhiteboardLibV5 | null): WhiteboardMeetV5 {
  const shown = { ...meet.shown };
  const groups = new Set([...Object.keys(BOARD_DEFAULTS), ...Object.keys(lib?.groups || {})]);
  for (const g of groups) for (const it of groupItems(lib, g)) if (!(`${g}:${it.id}` in shown)) shown[`${g}:${it.id}`] = false;
  return { ...meet, shown };
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function isBoardFile(v: unknown): v is { format: string } {
  return isObj(v) && v.format === BOARD_FILE_FORMAT;
}

/** A parsed board file → the board's parts, and its items as a library to merge add-only. */
export function readBoardFile(name: string, data: Record<string, any>):
  | { ok: true; meet: WhiteboardMeetV5; lib: WhiteboardLibV5; validation?: DiscoveryValidation; createdAt?: string; architecture?: ArchDoc }
  | { ok: false; message: string } {
  if (data.v !== BOARD_FILE_VERSION) {
    return { ok: false, message: `${name} was exported by a newer Pack Generator (file version ${data.v}). Update this app, then import it again.` };
  }
  const board = data.board;
  if (!isObj(board) || !isObj(board.meet) || typeof board.meet.prospect !== 'string') {
    return { ok: false, message: `${name} has no board in it.` };
  }
  const groups: WhiteboardLibV5['groups'] = {};
  for (const [g, list] of Object.entries(isObj(data.items) ? data.items : {})) {
    if (!Array.isArray(list)) continue;
    const own = list.filter((i: any) => isObj(i) && typeof i.id === 'string' && i.id).map((i: any) => ({ ...i, custom: true }));
    if (own.length) groups[g] = { items: own };
  }
  return {
    ok: true,
    meet: board.meet as WhiteboardMeetV5,
    lib: { v: 5, groups, removed: [] },
    ...(isObj(board.validation) ? { validation: board.validation as DiscoveryValidation } : {}),
    ...(typeof board.createdAt === 'string' ? { createdAt: board.createdAt } : {}),
    ...(isObj(data.architecture) && data.architecture.v === 1 && Array.isArray(data.architecture.nodes) ? { architecture: data.architecture as ArchDoc } : {}),
  };
}
