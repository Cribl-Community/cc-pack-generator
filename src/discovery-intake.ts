/**
 * From a discovery whiteboard to its intake (spec R7, plan Task 7): what is ON the
 * board, as the SE drew it — not what is in their library.
 *
 *   sources       the shown items of group `sources`
 *   destinations  the shown items of the three store columns (point solution, Cribl, data platform)
 *   context       prospect, selected pains and use cases — carried for the record only
 *
 * The story step is presentation, not content: a Cribl column hidden in the "before"
 * step is still read. Pure: no storage, no network, no DOM.
 */
import { BOARD_FR_ITEMS, BOARD_ITEM_I18N, BOARD_LANGUAGES } from './whiteboard/catalog.generated';
import { DESTINATION_GROUPS, intakeFingerprint, intakeItemKey, liveItems, type BoardItem } from './whiteboard/board-model';
import type { WhiteboardLibV5, WhiteboardMeetV5 } from './whiteboard/types';

export interface IntakeItem {
  /** Stable across languages for built-ins (`sources:src-win`), by text for the SE's own items. */
  itemKey: string;
  id: string;
  builtin: boolean;
  /** As drawn on the board, in the board's language. */
  label: string;
  desc?: string;
}

export type DestinationColumn = typeof DESTINATION_GROUPS[number];

export interface DiscoveryIntake {
  prospect: string;
  sources: IntakeItem[];
  destinations: Array<IntakeItem & { column: DestinationColumn }>;
  pains: string[];
  useCases: string[];
  fingerprint: string;
}

/** The board's own text rule: built-in text follows the language; anything the SE typed stays as typed. */
function boardText(it: BoardItem, field: 'label' | 'desc', lang: string): string {
  const v = String((it as unknown as Record<string, unknown>)[field] ?? '');
  if (lang !== 'en' && it.builtin) {
    const fr = (lang === 'fr' ? BOARD_FR_ITEMS : BOARD_ITEM_I18N[lang] || {})[it.id];
    const k = field === 'label' ? 'l' : 'd';
    if (fr && fr[k] != null) return fr[k]!;
  }
  return v;
}

function toIntake(group: string, it: BoardItem, lang: string): IntakeItem {
  const desc = boardText(it, 'desc', lang);
  return { itemKey: intakeItemKey(group, it), id: it.id, builtin: it.builtin, label: boardText(it, 'label', lang), ...(desc ? { desc } : {}) };
}

export function extractIntake(meet: WhiteboardMeetV5, lib: WhiteboardLibV5 | null, lang: string = BOARD_LANGUAGES.some(l => l.code === lib?.lang) ? lib!.lang! : 'en'): DiscoveryIntake {
  // A pick is on the board (Discover has no Show / Hide since build 961).
  const sel = (group: 'pains' | 'usecases', picked: Record<string, boolean> | undefined) =>
    liveItems(lib, meet, group).filter(it => picked?.[it.id] === true).map(it => boardText(it, 'label', lang));
  return {
    prospect: String(meet.prospect || '').trim(),
    sources: liveItems(lib, meet, 'sources').map(it => toIntake('sources', it, lang)),
    destinations: DESTINATION_GROUPS.flatMap(column => liveItems(lib, meet, column).map(it => ({ ...toIntake(column, it, lang), column }))),
    pains: sel('pains', meet.paSel),
    useCases: sel('usecases', meet.ucSel),
    fingerprint: intakeFingerprint(lib, meet),
  };
}
