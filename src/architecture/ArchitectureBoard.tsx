/**
 * The Architecture tab of a prospect's board: drag Cribl parts onto an empty canvas and get
 * a diagram in the style of the reference architectures on docs.cribl.io. The behaviour is
 * the agreed mockup's (~/Downloads/architecture-mockup, ARCHITECTURE-TODO.md).
 *
 * The drawing lives in an `Arch` (./model.ts) and is drawn as SVG markup (./render.ts);
 * this component owns the canvas (pan, zoom, drag, the line tool), the palette, the
 * inspector and the panel picker, and hands every change to `onChange` for saving.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type Ref } from 'react';
import { Arch, KIND, PARTS, snap10, type ArchDoc, type ArchEdge, type ArchNode, type PartType, type Pt, type Side } from './model';
import { contentFrame, DEFS, FONT, paletteIcon, safeLogo, worldSvg, type Selection } from './render';
import { applyTemplate, drawOrg, TEMPLATE_LIST, type TemplateKey } from './templates';
import { exportArchitecture, type ArchExportKind } from './export';
import { readOrg } from './org-read';
import { drawFromBoard, type BoardIntake } from './from-board';
import './architecture.css';

export interface ArchBoardHandle {
  exportAs(kind: ArchExportKind): Promise<string>;
  isEmpty(): boolean;
}

const HISTORY = 100;
const ZOOM_MIN = 0.3, ZOOM_MAX = 2;

type Drag =
  | { mode: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { mode: 'move'; n: ArchNode; sx: number; sy: number; ox: number; oy: number; snap: string; moved: boolean }
  | { mode: 'child'; n: ArchNode; snap: string; moved: boolean }
  | { mode: 'resize'; n: ArchNode; sx: number; sy: number; w: number; h: number; snap: string }
  | { mode: 'mid'; e: ArchEdge; axis: 'x' | 'y'; snap: string }
  | { mode: 'link'; n: ArchNode; side: Side; sx: number; sy: number };

interface Picker { panelId: string; left: number; top: number; q: string }

export default function ArchitectureBoard({ initial, prospect, logo = '', onChange, onToast, fromBoard, ref }: {
  initial: ArchDoc | null;
  /** What the prospect's whiteboard says, for "Draw it from the whiteboard". */
  fromBoard?: () => BoardIntake | null;
  prospect: string;
  /** The prospect's logo, a data URL from the whiteboard. */
  logo?: string;
  onChange: (doc: ArchDoc) => void;
  onToast: (msg: string) => void;
  ref?: Ref<ArchBoardHandle>;
}) {
  // read once: the board re-mounts this with the latest drawing each time the tab opens
  const [arch] = useState(() => Arch.fromDoc(initial));
  const [tick, setTick] = useState(0);
  const redraw = useCallback(() => setTick(t => t + 1), []);
  const [sel, setSelState] = useState<Selection>(null);
  const selRef = useRef<Selection>(null);
  const setSel = (s: Selection) => { selRef.current = s; setSelState(s); };
  const [view, setViewState] = useState({ x: 0, y: 0, z: 1 });
  const viewRef = useRef(view);
  const setView = (v: { x: number; y: number; z: number }) => { viewRef.current = v; setViewState(v); };
  const [tool, setToolState] = useState<'select' | 'line'>('select');
  const toolRef = useRef(tool);
  const [hint, setHint] = useState('');
  const [preview, setPreview] = useState('');
  const [picker, setPicker] = useState<Picker | null>(null);
  const [filter, setFilter] = useState('');
  const [present, setPresent] = useState(false);
  const presentRef = useRef(false);
  presentRef.current = present;
  const [menu, setMenu] = useState(false);
  const [readingOrg, setReadingOrg] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drawing = useRef<{ from: string | null; pts: Pt[] } | null>(null);
  const drag = useRef<Drag | null>(null);
  const dragPart = useRef<string | null>(null);
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const fieldSnap = useRef<string | null>(null);
  // the line tool's last two clicks, on screen: a double-click is two clicks on one spot
  const clicks = useRef<Pt[]>([]);
  // a side's dot was clicked (not dragged): the next click on a part connects to it
  const linking = useRef<{ n: ArchNode; side: Side } | null>(null);

  // --- history and saving -----------------------------------------------------

  const snapshot = () => JSON.stringify(arch.toDoc());
  const remember = (snap = snapshot()) => {
    undo.current.push(snap);
    if (undo.current.length > HISTORY) undo.current.shift();
    redo.current = [];
  };
  /** After every change: say what the rules did, draw, save. */
  const changed = () => {
    const notes = arch.takeNotes();
    if (notes.length) onToast(notes[notes.length - 1]);
    redraw();
    onChange(arch.toDoc());
  };
  /** A change from one action: remembered for undo, then `changed`. */
  const act = (fn: () => void) => { remember(); fn(); changed(); };
  const restore = (json: string) => {
    const next = Arch.fromDoc(JSON.parse(json));
    arch.nodes = next.nodes; arch.edges = next.edges; arch.uid = next.uid;
    setSel(null);
    closePicker();
    redraw();
    onChange(arch.toDoc());
  };
  const doUndo = () => { const s = undo.current.pop(); if (!s) return; redo.current.push(snapshot()); restore(s); };
  const doRedo = () => { const s = redo.current.pop(); if (!s) return; undo.current.push(snapshot()); restore(s); };

  // --- coordinates and view ---------------------------------------------------

  const toWorld = (cx: number, cy: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect(), v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  };
  const zoomAt = (cx: number, cy: number, f: number) => {
    const r = svgRef.current!.getBoundingClientRect(), v = viewRef.current;
    const wx = (cx - r.left - v.x) / v.z, wy = (cy - r.top - v.y) / v.z;
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z * f));
    setView({ z, x: cx - r.left - wx * z, y: cy - r.top - wy * z });
  };
  const fit = useCallback(() => {
    const svg = svgRef.current, b = contentFrame(arch);
    if (!svg) return;
    if (!b) { setView({ x: 0, y: 0, z: 1 }); return; }
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // leave the toolbar's band at the top and the legend's at the bottom free (none while presenting)
    const top = presentRef.current ? 20 : 70, bottom = presentRef.current ? 20 : 60;
    const z = Math.min(1.2, Math.min((r.width - 80) / (b.x1 - b.x0), (r.height - top - bottom) / (b.y1 - b.y0)));
    setView({ z, x: (r.width - (b.x1 - b.x0) * z) / 2 - b.x0 * z, y: top + (r.height - top - bottom - (b.y1 - b.y0) * z) / 2 - b.y0 * z });
  }, [arch]);
  useEffect(() => { requestAnimationFrame(fit); }, [fit]);
  useEffect(() => { requestAnimationFrame(() => requestAnimationFrame(fit)); }, [present, fit]);

  // Scroll and two-finger swipe move the canvas. Zoom only with Ctrl/⌘ + scroll or a trackpad
  // pinch (which the browser reports as Ctrl + wheel), at most 8% per event.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, 1 + Math.max(-0.08, Math.min(0.08, -e.deltaY * 0.004)));
      else { const v = viewRef.current; setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }); }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  // --- tools ------------------------------------------------------------------

  const setTool = (t: 'select' | 'line') => {
    toolRef.current = t;
    setToolState(t);
    drawing.current = null;
    setPreview('');
    setHint(t === 'line' ? 'Click a part or the canvas to start the line. Each click adds a corner.' : '');
  };
  const orth = (last: Pt, pt: Pt): Pt => (Math.abs(pt.x - last.x) >= Math.abs(pt.y - last.y) ? { x: snap10(pt.x), y: last.y } : { x: last.x, y: snap10(pt.y) });
  const drawPreview = (pt: Pt) => {
    const d = drawing.current;
    if (!d) return;
    const pts = [...d.pts, orth(d.pts[d.pts.length - 1], pt)];
    setPreview(`M${pts.map(p => `${p.x} ${p.y}`).join(' L')}`);
  };
  const finishDrawing = (end: ArchNode | undefined) => {
    const d = drawing.current;
    drawing.current = null;
    setPreview('');
    if (!d) return;
    remember();
    const e = arch.finishLine(d.from, d.pts, end);
    if (!e) { undo.current.pop(); return; }
    setSel({ kind: 'edge', id: e.id });
    onToast(e.free ? 'Line drawn. Set its type and label on the right.' : 'Connected. It follows the parts when you move them.');
    changed();
  };
  /** The part under a screen point (a worker or Edge node stands for its group); zones don't count. */
  const partAt = (cx: number, cy: number, not?: string): ArchNode | undefined => {
    const g = document.elementsFromPoint(cx, cy).map(el => el.closest?.('.arch-world .node') as SVGGElement | null).find(x => x && x.dataset.id !== not);
    return arch.lineEnd(arch.byId(g?.dataset.id));
  };
  const highlight = (id?: string) => {
    svgRef.current?.querySelectorAll('.drop-ok').forEach(g => g.classList.remove('drop-ok'));
    if (id) svgRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('drop-ok');
  };

  // --- the panel picker -------------------------------------------------------

  const closePicker = () => setPicker(null);
  const openPicker = (p: ArchNode, at?: { x: number; y: number }) => {
    const stage = stageRef.current!.getBoundingClientRect(), v = viewRef.current, b = arch.box(p), svg = svgRef.current!.getBoundingClientRect();
    const pt = at || { x: svg.left + v.x + (b.x + 30) * v.z, y: svg.top + v.y + (b.y + b.h - 26) * v.z };
    setPicker({ panelId: p.id, q: '', left: Math.min(stage.width - 270, Math.max(8, pt.x - stage.left - 20)), top: Math.min(stage.height - 330, Math.max(8, pt.y - stage.top + 14)) });
  };
  const pickerPanel = picker ? arch.byId(picker.panelId) : undefined;
  const pick = (label: string) => {
    if (!pickerPanel) return;
    if (pickerPanel.type === 'dst') {
      act(() => { arch.nameDestination(pickerPanel, label); });
      closePicker();
      return;
    }
    act(() => { arch.addToPanel(pickerPanel, label); });
    // the list stays open, under the panel's new last row, to add several in a row
    requestAnimationFrame(() => openPicker(pickerPanel));
  };

  // --- dropping from the palette ----------------------------------------------

  const dropPart = (part: string, pt: Pt) => {
    remember();
    const r = arch.drop(part, pt);
    setSel({ kind: 'node', id: r.select.id });
    changed();
    if (r.pick) requestAnimationFrame(() => openPicker(r.select));
    if (r.name) {
      onToast('Type what the prospect calls it');
      requestAnimationFrame(() => { const f = rootRef.current?.querySelector<HTMLInputElement>('.arch-insp [data-k="label"]'); f?.focus(); f?.select(); });
    }
  };
  const addAtCentre = (part: string) => {
    const r = svgRef.current!.getBoundingClientRect();
    dropPart(part, toWorld(r.left + r.width / 2, r.top + r.height / 2));
  };

  // --- connecting by the dots on a part's sides ---------------------------------

  /** Out of the side for a moment, then straight across and up or down to the pointer. */
  const linkPreview = (n: ArchNode, side: Side, pt: Pt) => {
    const p = arch.port(arch.ebox(n), side);
    const out = 20, v = side === 'top' || side === 'bottom';
    const p1 = { x: p.x + (side === 'right' ? out : side === 'left' ? -out : 0), y: p.y + (side === 'bottom' ? out : side === 'top' ? -out : 0) };
    setPreview(`M${p.x} ${p.y} L${p1.x} ${p1.y} ${v ? `H${pt.x} V${pt.y}` : `V${pt.y} H${pt.x}`}`);
  };
  const cancelLink = () => { linking.current = null; setPreview(''); setHint(''); };
  /** Connect two parts by the sides chosen: the dot pressed, and the dot (or the side nearest) where it ended. */
  const connectBySides = (n: ArchNode, side: Side, cx: number, cy: number) => {
    setPreview('');
    const from = arch.lineEnd(n), to = partAt(cx, cy, n.id);
    if (!from || !to || from.id === to.id) { onToast('Release or click on another part to connect it.'); return; }
    const dot = document.elementsFromPoint(cx, cy).map(el => el.closest?.('[data-port]') as SVGElement | null).find(x => x && x.dataset.port === to.id);
    const toSide = (dot?.dataset.side as Side | undefined) || arch.nearestSide(to, toWorld(cx, cy));
    let made: ArchEdge | undefined;
    act(() => {
      made = arch.connect(from, to, arch.inferKind(from, to));
      if (made) { made.fromSide = from === n ? side : undefined; made.toSide = toSide; delete made.mid; }
    });
    if (made) setSel({ kind: 'edge', id: made.id });
    onToast('Connected, around the other parts. Change the line type on the right.');
  };

  // --- pointer ----------------------------------------------------------------

  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    const target = e.target as Element;
    const pt = toWorld(e.clientX, e.clientY);
    if (toolRef.current === 'line') {
      clicks.current = [...clicks.current.slice(-1), { x: e.clientX, y: e.clientY }];
      const part = partAt(e.clientX, e.clientY);
      const d = drawing.current;
      if (!d) {
        const B = part && arch.ebox(part);
        drawing.current = { from: part?.id || null, pts: [B ? { x: B.cx, y: B.cy } : { x: snap10(pt.x), y: snap10(pt.y) }] };
        setHint('Click to add a corner. Click a part, or double-click, to finish. Esc cancels.');
        drawPreview(pt);
        return;
      }
      if (part && part.id !== d.from) {
        if (d.pts.length > 1) d.pts.push(orth(d.pts[d.pts.length - 1], pt));
        finishDrawing(part);
        setTool('select');
        return;
      }
      d.pts.push(orth(d.pts[d.pts.length - 1], pt));
      drawPreview(pt);
      return;
    }
    if (linking.current) {
      const { n, side } = linking.current;
      cancelLink();
      if (partAt(e.clientX, e.clientY, n.id)) { connectBySides(n, side, e.clientX, e.clientY); return; }
    }
    const grip = target.closest<SVGElement>('[data-mid]');
    if (grip) {
      const ed = arch.edges.find(x => x.id === grip.dataset.mid);
      if (ed) drag.current = { mode: 'mid', e: ed, axis: grip.dataset.axis === 'x' ? 'x' : 'y', snap: snapshot() };
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    const addeng = target.closest<SVGElement>('[data-addeng]');
    if (addeng) {
      const se = arch.byId(addeng.dataset.addeng);
      if (!se) return;
      let le: ArchNode | undefined;
      act(() => { le = arch.addLakehouse(se); });
      if (le) setSel({ kind: 'node', id: le.id });
      onToast('Added a lakehouse engine. Name it after the data it holds.');
      return;
    }
    const addto = target.closest<SVGElement>('[data-addto]');
    if (addto) {
      const p = arch.byId(addto.dataset.addto);
      if (p) { setSel({ kind: 'node', id: p.id }); openPicker(p, { x: e.clientX, y: e.clientY }); }
      return;
    }
    closePicker();
    setMenu(false);
    const handle = target.closest<SVGElement>('[data-port]'), rs = target.closest<SVGElement>('[data-resize]');
    const g = target.closest<SVGGElement>('.node'), ed = target.closest<SVGGElement>('.edge');
    if (rs) {
      const n = arch.byId(rs.dataset.resize);
      if (n) drag.current = { mode: 'resize', n, sx: pt.x, sy: pt.y, w: n.w || 520, h: n.h || 300, snap: snapshot() };
    } else if (handle) {
      const n = arch.byId(handle.dataset.port);
      if (n) { drag.current = { mode: 'link', n, side: (handle.dataset.side as Side) || 'right', sx: e.clientX, sy: e.clientY }; setHint('Release on another part, or on one of its dots, to connect it'); }
    } else if (g) {
      const n = arch.byId(g.dataset.id);
      if (!n) return;
      setSel({ kind: 'node', id: n.id });
      drag.current = n.parent
        ? { mode: 'child', n, snap: snapshot(), moved: false }
        : { mode: 'move', n, sx: pt.x, sy: pt.y, ox: n.x, oy: n.y, snap: snapshot(), moved: false };
    } else if (ed) {
      setSel({ kind: 'edge', id: ed.dataset.edge! });
      return;
    } else {
      setSel(null);
      const v = viewRef.current;
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y };
      stageRef.current?.classList.add('panning');
    }
    svgRef.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (toolRef.current === 'line') { drawPreview(toWorld(e.clientX, e.clientY)); return; }
    if (linking.current) { linkPreview(linking.current.n, linking.current.side, toWorld(e.clientX, e.clientY)); return; }
    const d = drag.current;
    if (!d) return;
    const pt = toWorld(e.clientX, e.clientY);
    switch (d.mode) {
      case 'mid': d.e.mid = snap10(d.axis === 'y' ? pt.y : pt.x); redraw(); return;
      case 'pan': setView({ ...viewRef.current, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }); return;
      case 'move': arch.moveTo(d.n, d.ox + pt.x - d.sx, d.oy + pt.y - d.sy); d.moved = true; redraw(); return;
      case 'resize': d.n.w = Math.max(200, snap10(d.w + pt.x - d.sx)); d.n.h = Math.max(120, snap10(d.h + pt.y - d.sy)); redraw(); return;
      case 'child': {
        d.moved = true;
        const c = arch.containerAt(pt, d.n.type);
        highlight(c && c.id !== d.n.parent ? c.id : undefined);
        return;
      }
      case 'link': linkPreview(d.n, d.side, pt);
    }
  };

  const onPointerUp = (e: RPointerEvent<SVGSVGElement>) => {
    stageRef.current?.classList.remove('panning');
    if (toolRef.current !== 'line') setHint('');
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const pt = toWorld(e.clientX, e.clientY);
    if (d.mode === 'link') {
      // a click on the dot, not a drag: the next click on a part finishes it
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) {
        linking.current = { n: d.n, side: d.side };
        setHint('Now click the part to connect to: the line goes to the side nearest your click. Esc cancels.');
        return;
      }
      connectBySides(d.n, d.side, e.clientX, e.clientY);
      return;
    }
    if (d.mode === 'child') {
      highlight();
      const c = d.moved ? arch.containerAt(pt, d.n.type) : undefined;
      if (c && c.id !== d.n.parent) { remember(d.snap); arch.moveChild(d.n, c); changed(); }
      return;
    }
    if (d.mode === 'pan') return;
    if (d.mode === 'move' && !d.moved) return;
    if (d.snap !== snapshot()) { remember(d.snap); changed(); }
  };

  const onDoubleClick = () => {
    // Two quick clicks far apart are two corners, not a double-click.
    const [c1, c2] = clicks.current;
    if (!c1 || !c2 || Math.hypot(c1.x - c2.x, c1.y - c2.y) > 8) return;
    if (toolRef.current === 'line' && drawing.current) {
      // the double-click's second click added a corner on the same spot: drop it
      drawing.current.pts.pop();
      finishDrawing(undefined);
      setTool('select');
    }
  };

  // --- keyboard ---------------------------------------------------------------

  const removeSel = () => {
    const s = selRef.current;
    if (!s) return;
    act(() => { if (s.kind === 'edge') arch.removeEdge(s.id); else arch.removeNode(s.id); });
    setSel(null);
  };
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const mod = e.metaKey || e.ctrlKey;
    // text fields keep their own keys; a checkbox or a list still lets ⌘Z and Esc through
    if (t?.closest?.('textarea,[contenteditable="true"]')) return;
    if (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'radio') return;
    if (t instanceof HTMLSelectElement && !mod && e.key !== 'Escape') return;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
    if (mod || e.altKey) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current && !present) { e.preventDefault(); removeSel(); return; }
    if (e.key === 'Escape') {
      if (linking.current) { cancelLink(); return; }
      if (picker) { closePicker(); return; }
      if (toolRef.current === 'line') { setTool('select'); return; }
      if (present) { leavePresent(); return; }
      setSel(null);
      return;
    }
    if (e.key === 'Enter' && drawing.current) { finishDrawing(undefined); setTool('select'); return; }
    if (present) return;
    if (e.key === 'l' || e.key === 'L') setTool(toolRef.current === 'line' ? 'select' : 'line');
    else if (e.key === 'v' || e.key === 'V') setTool('select');
    else if (e.key === 'z' || e.key === 'Z') fit();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // --- present ----------------------------------------------------------------

  const enterPresent = async () => {
    setSel(null);
    closePicker();
    setTool('select');
    setPresent(true);
    const el = rootRef.current;
    if (el?.requestFullscreen && !document.fullscreenElement) {
      try { await el.requestFullscreen(); } catch { /* refused by the sandbox: the pane-filling layout stands */ }
    }
  };
  const leavePresent = useCallback(() => {
    setPresent(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setPresent(false); };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // --- templates and the org ----------------------------------------------------

  const startFrom = (key: TemplateKey) => {
    setMenu(false);
    const had = arch.nodes.length > 0;
    act(() => applyTemplate(arch, key));
    setSel(null);
    closePicker();
    if (had) onToast('Replaced the drawing. Undo (⌘Z / Ctrl+Z) brings it back.');
    requestAnimationFrame(fit);
  };
  const drawWhiteboard = () => {
    setMenu(false);
    const intake = fromBoard?.();
    if (!intake) return;
    const had = arch.nodes.length > 0;
    remember();
    const msg = drawFromBoard(arch, intake);
    setSel(null);
    closePicker();
    changed();
    onToast(had ? `${msg} Undo (⌘Z / Ctrl+Z) brings the previous drawing back.` : msg);
    requestAnimationFrame(fit);
  };
  const drawThisOrg = async () => {
    setMenu(false);
    setReadingOrg(true);
    try {
      const { groups, workers } = await readOrg();
      remember();
      const msg = drawOrg(arch, groups, workers);
      setSel(null);
      changed();
      onToast(msg);
      requestAnimationFrame(fit);
    } catch (err) {
      onToast(`Could not read this org: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReadingOrg(false);
    }
  };

  useImperativeHandle(ref, () => ({
    exportAs: (kind) => exportArchitecture(arch, kind, prospect, logo),
    isEmpty: () => arch.nodes.length === 0,
  }), [arch, prospect, logo]);

  // --- inspector edits ------------------------------------------------------------

  /** Typing in a field is one undo step per visit to the field. */
  const editField = (fn: () => void) => {
    if (fieldSnap.current) { remember(fieldSnap.current); fieldSnap.current = null; }
    fn();
    changed();
  };
  const fieldProps = { onFocus: () => { fieldSnap.current = snapshot(); }, onBlur: () => { fieldSnap.current = null; } };

  // --- draw ---------------------------------------------------------------------

  // `arch` is changed in place; `tick` is what says it changed
  const markup = useMemo(() => { void tick; return worldSvg(arch, sel, true); }, [arch, sel, tick]);
  const empty = arch.nodes.length === 0;
  const transform = `translate(${view.x} ${view.y}) scale(${view.z})`;
  const q = filter.trim().toLowerCase();
  const pickerOpts = pickerPanel && picker ? arch.pickerOptions(pickerPanel, picker.q) : null;

  return (
    <div ref={rootRef} className={`arch-board${present ? ' is-present' : ''}${sel && !present ? ' has-sel' : ''}`}>
      <aside className="arch-palette" aria-label="Architecture parts">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Find a part" aria-label="Find a part" />
        {PARTS.map(([group, items]) => {
          const shown = items.filter(([, l]) => l.toLowerCase().includes(q));
          if (!shown.length) return null;
          return (
            <div key={group} className="arch-pgroup">
              <h3>{group}</h3>
              <div className="arch-pitems">
                {shown.map(([part, label]) => (
                  <button key={part} type="button" className="arch-pitem" draggable title="Drag onto the canvas, or click to add it in the middle"
                    onDragStart={e => { dragPart.current = part; e.dataTransfer.setData('text/plain', `arch:${part}`); e.dataTransfer.effectAllowed = 'copy'; }}
                    onDragEnd={() => { dragPart.current = null; highlight(); }}
                    onClick={() => addAtCentre(part)}>
                    <span dangerouslySetInnerHTML={{ __html: paletteIcon(part) }} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <p className="arch-tip">Scroll to move around; Ctrl or ⌘ + scroll, or pinch, to zoom. Drag a part onto the canvas, or click it. Drop worker nodes on a worker group and Edge nodes on a fleet. To connect two parts, press a dot on one side of a part, then release or click on the other part: the line takes the side nearest you and goes around everything in between. Add sources and destinations with the + in their panel.</p>
      </aside>

      <div ref={stageRef} className={`arch-stage${tool === 'line' ? ' drawing' : ''}`}>
        {safeLogo(logo) && (
          <div className="arch-customer">
            <img src={safeLogo(logo)} alt="" />
          </div>
        )}
        <svg ref={svgRef} className="arch-world" aria-label="Architecture canvas" style={{ fontFamily: FONT }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={onDoubleClick}
          onDragOver={e => {
            e.preventDefault();
            const part = dragPart.current;
            if (!part) return;
            const kind = part.split(':')[0] as PartType;
            highlight(arch.containerAt(toWorld(e.clientX, e.clientY), kind)?.id);
          }}
          onDrop={e => {
            e.preventDefault();
            highlight();
            const raw = e.dataTransfer.getData('text/plain');
            const part = raw.startsWith('arch:') ? raw.slice(5) : dragPart.current;
            dragPart.current = null;
            if (part) dropPart(part, toWorld(e.clientX, e.clientY));
          }}>
          <g dangerouslySetInnerHTML={{ __html: DEFS }} />
          <g transform={transform} dangerouslySetInnerHTML={{ __html: markup }} />
          {preview && <g transform={transform}><path d={preview} fill="none" stroke="#00b3b3" strokeWidth={2} strokeDasharray="5 4" /></g>}
        </svg>

        {empty && (
          <div className="arch-empty">
            <div className="arch-empty-box">
              <h2>Draw the architecture</h2>
              <p>Drag parts from the left onto the canvas, or start from the whiteboard or a reference architecture and change it.</p>
              {fromBoard && (
                <button type="button" className="btn-primary arch-fromboard" onClick={drawWhiteboard}>
                  Draw it from the whiteboard
                  <small>The prospect's sources and destinations, with the Cribl products on their board</small>
                </button>
              )}
              <div className="arch-tpls">
                {TEMPLATE_LIST.map(t => (
                  <button key={t.key} type="button" className="arch-tpl" onClick={() => startFrom(t.key)}>
                    <TemplateThumb k={t.key} />
                    <b>{t.title}</b><span>{t.hint}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="btn-secondary arch-org" disabled={readingOrg} onClick={() => void drawThisOrg()}>
                {readingOrg ? 'Reading this org…' : 'Draw this Cribl org as it runs now'}
              </button>
            </div>
          </div>
        )}

        {hint && <div className="arch-hint" role="status">{hint}</div>}

        {!present && (
          <div className="arch-tools" role="toolbar" aria-label="Canvas tools">
            <button type="button" aria-pressed={tool === 'select'} title="Select and move (V)" onClick={() => setTool('select')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 3l14 7-6 2-2 6z" /></svg>Select
            </button>
            <button type="button" aria-pressed={tool === 'line'} title="Draw a line (L)" onClick={() => setTool(tool === 'line' ? 'select' : 'line')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 18H12V6H20" /></svg>Line
            </button>
            <span className="arch-sep" />
            <button type="button" title="Undo (⌘Z / Ctrl+Z)" aria-label="Undo" disabled={!undo.current.length} onClick={doUndo}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
            </button>
            <button type="button" title="Redo (⇧⌘Z / Ctrl+Y)" aria-label="Redo" disabled={!redo.current.length} onClick={doRedo}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
            </button>
            <span className="arch-sep" />
            <span className="arch-menu-wrap">
              <button type="button" aria-expanded={menu} onClick={() => setMenu(m => !m)}>Start from ▾</button>
              {menu && (
                <div className="arch-menu" role="menu">
                  {fromBoard && (
                    <button type="button" role="menuitem" onClick={drawWhiteboard}>
                      From the whiteboard<small>The prospect's sources, destinations and Cribl products</small>
                    </button>
                  )}
                  {TEMPLATE_LIST.map(t => (
                    <button key={t.key} type="button" role="menuitem" onClick={() => startFrom(t.key)}>
                      {t.title}{t.menu && <small>{t.menu}</small>}
                    </button>
                  ))}
                  <button type="button" role="menuitem" disabled={readingOrg} onClick={() => void drawThisOrg()}>
                    This Cribl org<small>Leader, worker groups and fleets as they run now</small>
                  </button>
                </div>
              )}
            </span>
            <button type="button" className="arch-present-btn" disabled={empty} onClick={() => void enterPresent()}>Present</button>
          </div>
        )}

        {present && <button type="button" className="btn-secondary arch-exit" onClick={leavePresent}>Stop presenting <kbd>Esc</kbd></button>}

        {picker && pickerPanel && pickerOpts && (
          <div className="arch-picker" role="dialog" aria-label={pickerPanel.type === 'dst' ? 'Name this destination' : 'Add to the panel'} style={{ left: picker.left, top: picker.top }}>
            <input autoFocus autoComplete="off" value={picker.q} placeholder={pickerPanel.type === 'srcpanel' ? 'Find or type a source' : 'Find or type a destination'}
              onChange={e => setPicker({ ...picker, q: e.target.value })}
              onKeyDown={e => {
                if (e.key === 'Enter') { const first = pickerOpts.typed ? picker.q.trim() : pickerOpts.opts[0]; if (first) pick(first); }
                if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
              }} />
            <div className="arch-picker-opts">
              {pickerOpts.typed && <button type="button" onClick={() => pick(picker.q.trim())}><b>Add "{picker.q.trim()}"</b><small>your own</small></button>}
              {pickerOpts.opts.map(o => <button key={o} type="button" onClick={() => pick(o)}>{o}</button>)}
              {!pickerOpts.typed && !pickerOpts.opts.length && <p>{pickerPanel.type === 'dst' ? 'No matches.' : 'Everything is on the panel.'}</p>}
            </div>
          </div>
        )}

        <div className="arch-legend" aria-label="Line types">
          <span><svg width="28" height="6" aria-hidden="true"><path d="M0 3H28" stroke="#1ccbc8" strokeWidth="2" /></svg>Control · tcp4200</span>
          <span><svg width="28" height="6" aria-hidden="true"><path d="M0 3H28" stroke="#222" strokeWidth="1.6" strokeDasharray="2 3" /></svg>Data</span>
          <span><svg width="28" height="6" aria-hidden="true"><path d="M0 3H28" stroke="#9a9a9a" strokeWidth="1.6" strokeDasharray="2 3" /></svg>Optional</span>
        </div>

        {!present && (
          <div className="arch-zoom">
            <button type="button" aria-label="Zoom out" onClick={() => { const r = svgRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.15); }}>−</button>
            <span>{Math.round(view.z * 100)}%</span>
            <button type="button" aria-label="Zoom in" onClick={() => { const r = svgRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.15); }}>+</button>
            <button type="button" title="Fit the drawing (Z)" onClick={fit}>Fit</button>
            <button type="button" title="Line up parts on a grid" disabled={empty} onClick={() => { act(() => arch.tidy()); onToast('Lined up on the grid'); }}>Tidy</button>
          </div>
        )}
      </div>

      {sel && !present && (
        <aside className="arch-insp" aria-label={sel.kind === 'edge' ? 'Selected line' : 'Selected part'}>
          {sel.kind === 'edge'
            ? <EdgeInspector arch={arch} id={sel.id} edit={editField} fieldProps={fieldProps} act={act} onRemove={removeSel} />
            : <NodeInspector arch={arch} id={sel.id} edit={editField} fieldProps={fieldProps} act={act} onRemove={removeSel} />}
        </aside>
      )}
    </div>
  );
}

// --- inspector ------------------------------------------------------------------

type FieldProps = { onFocus: () => void; onBlur: () => void };
type InspProps = { arch: Arch; id: string; edit: (fn: () => void) => void; fieldProps: FieldProps; act: (fn: () => void) => void; onRemove: () => void };

function EdgeInspector({ arch, id, edit, fieldProps, act, onRemove }: InspProps) {
  const e = arch.edges.find(x => x.id === id);
  if (!e) return null;
  const end = (i: string | null) => (i ? arch.byId(i)?.label || KIND[arch.byId(i)?.type || 'zone'] : 'the canvas');
  return (
    <>
      <h2>Line</h2>
      <div className="arch-kind">{end(e.from)} to {end(e.to)}</div>
      <label className="arch-field">Type
        <select value={e.kind} onChange={ev => act(() => { e.kind = ev.target.value as ArchEdge['kind']; })}>
          <option value="control">Control: leader to workers and Edge (tcp4200)</option>
          <option value="data">Data</option>
          <option value="optional">Optional data</option>
        </select>
      </label>
      <label className="arch-field">Label
        <input type="text" {...fieldProps} value={e.label || ''} placeholder={e.kind === 'optional' ? 'Optional' : 'For example UI/API'} onChange={ev => edit(() => { e.label = ev.target.value; })} />
      </label>
      <label className="arch-field">Second line
        <input type="text" {...fieldProps} value={e.sub || ''} placeholder={arch.trafficPort(e) || 'For example TCP/9100'} onChange={ev => edit(() => { e.sub = ev.target.value; })} />
      </label>
      {e.free
        ? <div className="arch-note">Drawn by hand. It stays where you drew it when parts move.</div>
        : <>
          <div className="arch-note">{e.fromSide || e.toSide
            ? `Leaves by the ${e.fromSide || 'nearest'} side and enters by the ${e.toSide || 'nearest'} side, around the other parts.`
            : 'Runs between the facing sides, around the other parts.'} Drag the square on it to move its corner.</div>
          {e.mid != null && <button type="button" className="btn-secondary" onClick={() => act(() => { delete e.mid; })}>Reset the corner</button>}
          {(e.fromSide || e.toSide) && <button type="button" className="btn-secondary" onClick={() => act(() => { delete e.fromSide; delete e.toSide; delete e.mid; })}>Facing sides</button>}
        </>}
      <button type="button" className="btn-secondary arch-danger" onClick={onRemove}>Remove line</button>
    </>
  );
}

function NodeInspector({ arch, id, edit, fieldProps, act, onRemove }: InspProps) {
  const n = arch.byId(id);
  if (!n) return null;
  const kids = arch.kidsOf(n.id).length;
  const kind = KIND[n.type];
  const note = (text: string) => <div className="arch-note">{text}</div>;
  return (
    <>
      <h2>{n.label || kind}</h2>
      <div className="arch-kind">{kind}</div>
      {'label' in n && (
        <label className="arch-field">Name
          <input type="text" data-k="label" {...fieldProps} value={n.label || ''} onChange={ev => edit(() => { n.label = ev.target.value; })} />
        </label>
      )}
      {'sub' in n && n.type !== 'leader' && (
        <label className="arch-field">Second line
          <input type="text" {...fieldProps} value={n.sub || ''} onChange={ev => edit(() => { n.sub = ev.target.value; })} />
        </label>
      )}
      {n.type === 'leader' && (
        <>
          <label className="arch-field">Second line
            <input type="text" {...fieldProps} value={n.sub || ''} onChange={ev => edit(() => { n.sub = ev.target.value; })} />
          </label>
          <label className="arch-field">Runs in
            <select value={n.where || 'cloud'} onChange={ev => act(() => arch.setLeader(n, { where: ev.target.value as 'cloud' | 'self' }))}>
              <option value="cloud">Cribl Cloud</option>
              <option value="self">Customer-managed (on-prem or own cloud)</option>
            </select>
          </label>
          {n.where === 'self' && (
            <label className="arch-check"><input type="checkbox" checked={!!n.ha} onChange={ev => act(() => arch.setLeader(n, { ha: ev.target.checked }))} /> High availability (active and standby)</label>
          )}
          {note(n.where !== 'self' ? 'Cribl runs the leader. The board adds the user and the external git repo.'
            : n.ha ? 'The board adds the load balancer for the UI, the user and the network load balancer the workers connect through.'
              : 'The board adds the user. Tick high availability to add the load balancers.')}
        </>
      )}
      {(n.type === 'wg' || n.type === 'fleet') && (
        <>
          <div className="arch-field">{n.type === 'wg' ? 'Worker nodes' : 'Edge nodes'}
            <div className="arch-stepper">
              <button type="button" aria-label="One fewer" disabled={!kids} onClick={() => act(() => arch.setCount(n, -1))}>−</button>
              <b>{kids}</b>
              <button type="button" aria-label="One more" onClick={() => act(() => arch.setCount(n, 1))}>+</button>
            </div>
          </div>
          <label className="arch-check"><input type="checkbox" checked={!!n.ghost} onChange={ev => act(() => { n.ghost = ev.target.checked; })} /> Show that it scales out</label>
        </>
      )}
      {(n.type === 'srcpanel' || n.type === 'dstpanel') && note(`${kids} ${n.type === 'srcpanel' ? 'source' : 'destination'}${kids === 1 ? '' : 's'}. Add more with the + on the panel, from the list or by typing a name.`)}
      {n.type === 'cribllake' && note('Cribl-managed. Worker groups write to it and can replay from it; the federated engine in Cribl Search reads it in place.')}
      {n.type === 'criblsearch' && note("Cribl-managed. Holds the workspace's federated engine and its lakehouse engines; results can go back to a worker group.")}
      {n.type === 'engine' && note(n.eng === 'federated'
        ? 'One per workspace. Queries Cribl Lake, S3 and Blob where the data is, without ingesting it.'
        : 'Storage and compute for data sent into Cribl Search. Cribl Detect needs one dedicated to security data.')}
      {n.type === 'cribldetect' && note('Cribl-managed. Runs detections on a lakehouse engine for security data and sends alerts to the SOC tools.')}
      {(n.type === 'worker' || n.type === 'edgenode') && note(`Part of ${arch.byId(n.parent)?.label || 'its group'}. Drag it onto another group to move it.`)}
      {n.autoFor && note('Added for the leader: it moves with the leader and goes when the leader goes.')}
      <button type="button" className="btn-secondary arch-danger" onClick={onRemove}>Remove {kind.toLowerCase()}</button>
    </>
  );
}

function TemplateThumb({ k }: { k: TemplateKey }) {
  if (k === 'empty') return <svg viewBox="0 0 120 56" aria-hidden="true"><rect x="20" y="10" width="80" height="36" rx="4" fill="none" stroke="#c4cdd5" strokeDasharray="3 3" /></svg>;
  const xs = [14, 48, 82].slice(0, k === 'edge' ? 2 : 3);
  return (
    <svg viewBox="0 0 120 56" aria-hidden="true">
      <rect x="52" y="4" width="16" height="12" rx="2" fill="#1ccbc8" />
      {xs.map(x => {
        const fleet = k === 'edge' && x === 14;
        return (
          <g key={x}>
            <rect x={x} y="28" width="26" height="16" rx="2" fill={fleet ? '#fff' : '#d6e6f0'} stroke={fleet ? '#1ccbc8' : 'none'} />
            <path d={`M60 16V22H${x + 13}V28`} stroke="#1ccbc8" fill="none" />
          </g>
        );
      })}
    </svg>
  );
}
