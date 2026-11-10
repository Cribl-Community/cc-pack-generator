/**
 * Where a dropdown fits: below its anchor, or above it, and how tall it may be, so that ALL of it is
 * on screen, including its last row (the source picker's Done). A fixed max-height was not enough:
 * near the bottom of a short page the picker ran past the sticky bar and was cut off by the scroll
 * area, so Done was out of reach however its inside was laid out.
 */

export interface PlacementInput {
  /** Viewport y of the anchor's top and bottom (the row the picker hangs from). */
  anchorTop: number;
  anchorBottom: number;
  /** The visible band: the clipping scroll area / viewport, minus anything sticky that covers it. */
  visibleTop: number;
  visibleBottom: number;
  /** How far the picker overlaps the anchor edge it hangs from (its CSS `calc(100% - 6px)`). */
  overlap?: number;
  /** Tallest the picker ever gets, and the least that is still usable when opening downward. */
  maxHeight?: number;
  minUseful?: number;
  gap?: number;
}

export interface Placement { direction: 'down' | 'up'; maxHeight: number }

/** Pure: open downward when the room below is usable (or at least as large as above), else upward. */
export function pickerPlacement(p: PlacementInput): Placement {
  const overlap = p.overlap ?? 6, cap = p.maxHeight ?? 420, minUseful = p.minUseful ?? 240, gap = p.gap ?? 8;
  const below = Math.floor(p.visibleBottom - gap - (p.anchorBottom - overlap));
  const above = Math.floor((p.anchorTop + overlap) - gap - p.visibleTop);
  const direction = below >= Math.min(minUseful, cap) || below >= above ? 'down' : 'up';
  const room = direction === 'down' ? below : above;
  return { direction, maxHeight: Math.max(120, Math.min(cap, room)) };
}

/** The visible band for `el`: every clipping ancestor and the viewport, minus a sticky bar below it. */
export function visibleBand(el: Element, stickyBelow?: Element | null): { top: number; bottom: number } {
  let top = 0, bottom = window.innerHeight;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const o = getComputedStyle(a).overflowY;
    if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') {
      const r = a.getBoundingClientRect();
      top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom);
    }
  }
  if (stickyBelow) {
    const r = stickyBelow.getBoundingClientRect();
    if (r.height && r.top < bottom) bottom = Math.max(top, r.top);
  }
  return { top, bottom };
}

/** Measure and apply: sets `data-dir` (down | up) and a max-height in px on the picker. */
export function placePicker(picker: HTMLElement, anchor: Element, stickyBelow?: Element | null): Placement {
  const a = anchor.getBoundingClientRect(), band = visibleBand(picker, stickyBelow);
  const placement = pickerPlacement({ anchorTop: a.top, anchorBottom: a.bottom, visibleTop: band.top, visibleBottom: band.bottom });
  picker.dataset.dir = placement.direction;
  picker.style.maxHeight = `${placement.maxHeight}px`;
  return placement;
}
