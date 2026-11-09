/**
 * Whiteboards list — the pure parts of the rows (plan Task 3). No React, no storage.
 */
import type { BoardSketch, WhiteboardIndexEntry } from './types';

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

/** A stable colour per prospect for the initials tile (the board's own palette). */
export const TILE_COLOURS = ['#0B6CD9', '#05A758', '#FF8B00', '#5955FF', '#008080', '#2D389A'];
export function tileColour(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TILE_COLOURS[h % TILE_COLOURS.length];
}

function dayLabel(verb: string, iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `${verb} today, ${time}`;
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return `${verb} ${d.toLocaleDateString('en-GB', opts)}`;
}

export const editedLabel = (iso: string, now = new Date()): string => dayLabel('Edited', iso, now);
export const createdLabel = (iso: string, now = new Date()): string => dayLabel('Created', iso, now);

export function summaryLabel(s: WhiteboardIndexEntry['summary']): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${plural(s.sources, 'source', 'sources')} to ${plural(s.destinations, 'tool', 'tools')}`;
}

/** The second line of a ledger row: what Discover put on the board. */
export function discoveryLabel(s: WhiteboardIndexEntry['summary']): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (!s.pains && !s.useCases) return 'Nothing discovered';
  return [s.pains ? plural(s.pains, 'situation', 'situations') : '', s.useCases ? plural(s.useCases, 'use case', 'use cases') : '']
    .filter(Boolean).join(' · ');
}

/**
 * How the thumbnail splits the store row. A hidden Cribl column (the pipeline is not on)
 * is not a track. An empty column keeps a small share so the crowded one can use the width.
 */
export function thumbColumns(sk: Pick<BoardSketch, 'point' | 'cribl' | 'platform' | 'pipe'>): { key: string; share: number }[] {
  const parts = [{ key: 'point', n: sk.point }];
  if (sk.pipe === 'after') parts.push({ key: 'cribl', n: Math.max(sk.cribl, 1) });
  parts.push({ key: 'platform', n: sk.platform });
  const fr = parts.map(p => Math.max(0.62, p.n));
  const sum = fr.reduce((a, b) => a + b, 0);
  return parts.map((p, i) => ({ key: p.key, share: fr[i] / sum }));
}

/** A sketch for a row saved before the list stored one: the counts, drawn as the opening picture. */
export function sketchOf(row: WhiteboardIndexEntry): BoardSketch {
  return row.sketch ?? {
    sources: row.summary.sources, point: row.summary.destinations, cribl: 0, platform: 0,
    pipe: 'before', search: false, ai: false, pains: row.summary.pains, useCases: row.summary.useCases,
  };
}

/**
 * When the board was created. Rows written before build 949 have no `createdAt`; their id
 * still carries it (`newBoardId`: `wb_` + creation ms in base 36 + 4 random characters).
 */
export function createdAtOf(row: Pick<WhiteboardIndexEntry, 'id' | 'createdAt' | 'updatedAt'>): string {
  if (row.createdAt) return row.createdAt;
  const m = /^wb_([0-9a-z]+)[0-9a-z]{4}$/.exec(row.id);
  const ms = m ? parseInt(m[1], 36) : NaN;
  // Only a plausible timestamp (2020 … the board's last edit) — anything else is not an id we made.
  return Number.isFinite(ms) && ms > Date.UTC(2020, 0, 1) && ms <= Date.parse(row.updatedAt) + 1000 ? new Date(ms).toISOString() : row.updatedAt;
}

export type BoardSort = 'updated' | 'created' | 'name';
export const BOARD_SORTS: { id: BoardSort; label: string }[] = [
  { id: 'updated', label: 'Last edited' },
  { id: 'created', label: 'Date created' },
  { id: 'name', label: 'Name (A–Z)' },
];

const nameKey = (r: WhiteboardIndexEntry) => (r.prospect || '').trim();

/** Rows matching the filter text (prospect name), in the chosen order (default: most recently edited first). */
export function filterBoards(rows: WhiteboardIndexEntry[], query: string, sort: BoardSort = 'updated'): WhiteboardIndexEntry[] {
  const q = query.trim().toLowerCase();
  const byName = (a: WhiteboardIndexEntry, b: WhiteboardIndexEntry) => {
    // Untitled boards go last; names compare as people read them (accents, case, numbers).
    const an = nameKey(a), bn = nameKey(b);
    if (!an !== !bn) return an ? -1 : 1;
    return an.localeCompare(bn, undefined, { sensitivity: 'base', numeric: true }) || b.updatedAt.localeCompare(a.updatedAt);
  };
  const cmp = sort === 'name' ? byName
    : sort === 'created' ? (a: WhiteboardIndexEntry, b: WhiteboardIndexEntry) => createdAtOf(b).localeCompare(createdAtOf(a))
    : (a: WhiteboardIndexEntry, b: WhiteboardIndexEntry) => b.updatedAt.localeCompare(a.updatedAt);
  return rows
    .filter(r => !q || (r.prospect || 'untitled').toLowerCase().includes(q))
    .sort(cmp);
}

/**
 * A prospect name safe to show on a shared screen: its first two letters, then a fixed
 * run of dots, so neither the rest nor the length of the name shows. The SE recognises
 * the board; a call watching the screen learns nothing it can search for.
 */
export function maskedName(name: string): string {
  const n = name.trim();
  if (!n) return 'Untitled prospect';
  return `${[...n].slice(0, 2).join('')}\u2022\u2022\u2022\u2022\u2022`;
}

/** The name as the list shows it: the real one when revealed, else masked. */
export const displayName = (name: string, reveal: boolean): string =>
  reveal ? (name.trim() || 'Untitled prospect') : maskedName(name);
