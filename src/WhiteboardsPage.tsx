/**
 * Whiteboards & demos — one row per prospect: the discovery board (spec R1–R6) and every
 * demo built from it, each with its own Stop / Start / Destroy (src/WhiteboardsDemos.tsx).
 *
 * The list is the app's; the board is the vendored whiteboard in an <iframe srcdoc>
 * (src/whiteboard/), talking to the app only through src/whiteboard/host.ts. Saving is
 * automatic and a save that did not land says so; export is PNG / PDF for the prospect.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createAutosaver, deleteBoard, duplicateBoard, listBoards, loadArchitecture, loadBoard, loadLibrary, newBoardDoc,
  renameBoard, saveArchitecture, saveBoard, saveLibrary, type SaveResult, type SaveStatus,
} from './whiteboard-store';
import { connectWhiteboardFrame, type ExportKind, type WhiteboardConnection } from './whiteboard/host';
import { downloadBlob, exportBoard, exportBoardHeadless, exportFileBase, loadBoardHtml } from './whiteboard/export';
import { boardFile, hideItemsNotOnFile } from './whiteboard/transfer';
import { mergeLibraries, parseWhiteboardFile } from './whiteboard/import';
import type { BoardSketch, WhiteboardDoc, WhiteboardIndexEntry, WhiteboardLibV5, WhiteboardMeetV5 } from './whiteboard/types';
import {
  BOARD_SORTS, createdAtOf, createdLabel, discoveryLabel, displayName, editedLabel, filterBoards, initials, sketchOf, summaryLabel, thumbColumns, tileColour, type BoardSort,
} from './whiteboard/list-view';
import { blankMeet, emptyMeet, liveItems, DESTINATION_GROUPS } from './whiteboard/board-model';
import { BOARD_LANGUAGES } from './whiteboard/catalog.generated';
import DiscoveryValidate from './DiscoveryValidate';
import type { DemoSeed } from './discovery-demo-seed';
import { DemoStrip, DestroyDemoDialog, useLiveDemos } from './WhiteboardsDemos';
import { DEMO_STATE_LABEL, demoFlowLabel, type LiveDemo } from './demo-control';
import ArchitectureBoard, { type ArchBoardHandle } from './architecture/ArchitectureBoard';
import type { ArchExportKind } from './architecture/export';
import type { ArchDoc } from './architecture/model';
import { boardIntake } from './architecture/from-board';
import { fetchImageDataUrl, scaleLogo, searchLogos, siteIconCandidate, type LogoCandidate } from './whiteboard/logo-search';
import './WhiteboardsPage.css';

const UNDO_MS = 8000;

/** Download one board as JSON, to import it in Pack Generator on another Cribl org. Returns the file name. */
function downloadBoardJson(doc: WhiteboardDoc, lib: WhiteboardLibV5 | null, arch: ArchDoc | null): string {
  const name = `${exportFileBase(doc.meet.prospect || '')}.json`;
  downloadBlob(name, new Blob([JSON.stringify(boardFile(doc, lib, new Date(), arch), null, 2)], { type: 'application/json' }));
  return name;
}

// Remembered while the app is open (never stored): the list order and how the last board started.
// Revealed names are deliberately NOT remembered — the list opens with names hidden every time.
let rememberedSort: BoardSort = 'updated';
let rememberedStart: BoardStart = 'empty';
// Whiteboard (the drawing, discovery included) or Architecture: boards open on the last one used.
type EditorView = 'board' | 'arch';
let rememberedMode: EditorView = 'board';
type BoardStart = 'empty' | 'usual';

function SaveIndicator({ status, onRetry }: { status: SaveStatus | null; onRetry: () => void }) {
  if (!status) return null;
  if (status.state === 'saving') return <span className="wb-save" role="status">Saving…</span>;
  if (status.state === 'saved') return <span className="wb-save ok" role="status">Saved</span>;
  return (
    <span className="wb-save bad" role="alert">
      Not saved: {status.message}. <button type="button" className="wb-link" onClick={onRetry}>Retry</button>
    </span>
  );
}

// --- the board ----------------------------------------------------------------

function BoardEditor({ id, onBack, onToast, onGenerate, startIn }: { id: string; onBack: () => void; onToast: (msg: string) => void; onGenerate?: () => void; startIn?: EditorView }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const docRef = useRef<WhiteboardDoc | null>(null);
  const libRef = useRef<WhiteboardLibV5 | null>(null);
  const savedMeetJson = useRef('');
  const connRef = useRef<WhiteboardConnection | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [prospect, setProspect] = useState('');
  const [logo, setLogo] = useState('');
  const [ready, setReady] = useState(false);
  const [exporting, setExporting] = useState<ExportKind | ArchExportKind | null>(null);
  const [boardStatus, setBoardStatus] = useState<SaveStatus | null>(null);
  const [libStatus, setLibStatus] = useState<SaveStatus | null>(null);
  const [full, setFull] = useState(false);
  const [mode, setMode] = useState<EditorView>(startIn ?? rememberedMode);
  // The Architecture drawing: loaded with the board, saved on its own key.
  const archRef = useRef<ArchBoardHandle>(null);
  const archDocRef = useRef<ArchDoc | null>(null);
  const [archLoaded, setArchLoaded] = useState(false);
  const [archStatus, setArchStatus] = useState<SaveStatus | null>(null);
  // The board's language is the SE's library's (lib.lang); the header picks it, the board's L key too.
  const [lang, setLang] = useState('en');
  const modeRef = useRef(mode);
  // Set each render below, once enterFull/leaveFull exist: the board's P / Esc / Present ask through it.
  const presentRequestRef = useRef<(on: boolean) => void>(() => {});
  // A click on the board's logo slot: the app finds the logo by the prospect's name.
  const [logoAsk, setLogoAsk] = useState<{ prospect: string; has: boolean } | null>(null);

  const boardSaver = useMemo(() => createAutosaver<WhiteboardDoc>((d) => saveBoard(d, libRef.current), { onStatus: setBoardStatus }), []);
  const libSaver = useMemo(() => createAutosaver<WhiteboardLibV5>((l) => saveLibrary(l), { onStatus: setLibStatus }), []);
  const archSaver = useMemo(() => createAutosaver<ArchDoc>((d) => saveArchitecture(id, d), { onStatus: setArchStatus }), [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [doc, lib, page, arch] = await Promise.all([loadBoard(id), loadLibrary(), loadBoardHtml(), loadArchitecture(id)]);
        if (cancelled) return;
        if (!doc) { setLoadError('This whiteboard could not be found. It may have been deleted in another tab.'); return; }
        archDocRef.current = arch;
        setArchLoaded(true);
        docRef.current = doc;
        libRef.current = lib;
        if (typeof lib?.lang === 'string') setLang(lib.lang);
        savedMeetJson.current = JSON.stringify(doc.meet);
        setProspect(doc.meet.prospect || '');
        setLogo(doc.meet.logo || '');
        setHtml(page);
      } catch (err) {
        if (!cancelled) setLoadError(`The whiteboard could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Connect before the frame's first wb:ready can arrive (srcdoc is set by React after this runs).
  useEffect(() => {
    const frame = frameRef.current;
    if (!html || !frame) return;
    const conn = connectWhiteboardFrame(frame, {
      getLib: () => libRef.current,
      getMeet: () => docRef.current!.meet,
      onMeet: (meet: WhiteboardMeetV5) => {
        const json = JSON.stringify(meet);
        // The board re-writes its meeting on load; only a real change is an edit.
        if (json === savedMeetJson.current || !docRef.current) return;
        savedMeetJson.current = json;
        docRef.current = { ...docRef.current, meet, updatedAt: new Date().toISOString() };
        setProspect(meet.prospect || '');
        setLogo(meet.logo || '');
        boardSaver.push(docRef.current);
      },
      onLib: (lib: WhiteboardLibV5) => {
        if (JSON.stringify(lib) === JSON.stringify(libRef.current)) return;
        libRef.current = { ...lib, ...(libRef.current?.discoveryAliases ? { discoveryAliases: libRef.current.discoveryAliases } : {}) };
        if (typeof lib.lang === 'string') setLang(lib.lang);
        libSaver.push(libRef.current);
      },
      onDownload: (name, blob) => downloadBlob(name, blob),
      onPresentRequest: (on) => presentRequestRef.current(on),
      onLogoRequest: (p) => setLogoAsk({ prospect: p, has: !!docRef.current?.meet.logo }),
      onReady: () => setReady(true),
    });
    connRef.current = conn;
    return () => { conn.disconnect(); connRef.current = null; };
  }, [html, boardSaver, libSaver]);

  // Leaving the board writes what is pending; leaving the page while unsaved asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (boardSaver.dirty() || libSaver.dirty() || archSaver.dirty()) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      void boardSaver.flush().then(() => boardSaver.dispose());
      void libSaver.flush().then(() => libSaver.dispose());
      void archSaver.flush().then(() => archSaver.dispose());
    };
  }, [boardSaver, libSaver, archSaver]);

  const leaveTo = useCallback(async (next: () => void) => {
    await Promise.all([boardSaver.flush(), libSaver.flush(), archSaver.flush()]);
    const unsaved = [boardSaver.status(), libSaver.status(), archSaver.status()].find(s => s?.state === 'unsaved');
    if (unsaved && !window.confirm('This whiteboard has changes that are not saved. Leave anyway?')) return;
    next();
  }, [boardSaver, libSaver, archSaver]);
  const leave = useCallback(() => leaveTo(onBack), [leaveTo, onBack]);

  const changeMode = useCallback((m: EditorView) => {
    const fromArch = modeRef.current === 'arch';
    modeRef.current = m;
    rememberedMode = m;
    setMode(m);
    // the frame was hidden: let the board measure its space again
    if (m === 'board' && fromArch) requestAnimationFrame(() => { try { frameRef.current?.contentWindow?.dispatchEvent(new Event('resize')); } catch { /* not reachable */ } });
  }, []);

  // Present: the browser's full screen when the frame allows it, else the editor covers the app's
  // pane. Either way the board hides its edit controls and fits under its title (wb:present), and
  // nothing of that is saved as the SE's view.
  const fullRef = useRef(false);
  const leaveFull = useCallback(() => {
    if (!fullRef.current) return;
    fullRef.current = false;
    setFull(false);
    connRef.current?.setPresent(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);
  const enterFull = async () => {
    if (fullRef.current) return;
    fullRef.current = true;
    setFull(true);
    if (modeRef.current !== 'board') changeMode('board');
    const el = editorRef.current;
    if (el?.requestFullscreen && !document.fullscreenElement) {
      try { await el.requestFullscreen(); } catch { /* refused by the sandbox: the pane-filling layout stands */ }
    }
    // Fit once the new size has landed, so the board measures the space it really has.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (fullRef.current) connRef.current?.setPresent(true); }));
  };
  presentRequestRef.current = (on) => { if (on) void enterFull(); else leaveFull(); };
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) leaveFull(); };
    // Esc reaches this document only when the browser is not full screen (it handles Esc itself then).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && fullRef.current && !document.fullscreenElement) leaveFull(); };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [leaveFull]);

  const doArchExport = async (kind: ArchExportKind) => {
    if (!archRef.current) return;
    setExporting(kind);
    try {
      onToast(`Downloaded ${await archRef.current.exportAs(kind)}`);
    } catch (err) {
      onToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(null);
    }
  };
  const doExport = async (kind: ExportKind) => {
    if (!connRef.current) return;
    setExporting(kind);
    try {
      const name = await exportBoard(connRef.current, kind, docRef.current?.meet.prospect || '');
      onToast(`Downloaded ${name}`);
    } catch (err) {
      onToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(null);
    }
  };

  const statuses = [boardStatus, libStatus, archStatus];
  const status: SaveStatus | null = statuses.find(s => s?.state === 'unsaved')
    ?? statuses.find(s => s?.state === 'saving') ?? boardStatus ?? libStatus ?? archStatus;
  const retry = () => { void boardSaver.flush(); void libSaver.flush(); void archSaver.flush(); };
  const isArch = mode === 'arch';
  const jsonItem = { label: 'JSON file', hint: 'To open the board on another Cribl org', separator: true,
    onPick: () => { if (docRef.current) onToast(`Downloaded ${downloadBoardJson(docRef.current, libRef.current, archDocRef.current)}`); } };

  return (
    <div className={`wb-editor${full ? ' is-full' : ''}`} ref={editorRef}>
      <div className="wb-edhead">
        {!full && <button type="button" className="wb-back" onClick={() => void leave()}>← Whiteboards &amp; demos</button>}
        <span className="wb-crumb">{!full && '/ '}<b>{prospect || 'Untitled prospect'}</b></span>
        <SaveIndicator status={status} onRetry={retry} />
        <span className="wb-grow" />
        {full ? (
          <button type="button" className="btn-secondary wb-fs" onClick={leaveFull}>
            <FullScreenIcon exit /> Exit presentation <kbd>Esc</kbd>
          </button>
        ) : (
          <>
            <span className="wb-modes" role="group" aria-label="What the board shows">
              {([['board', 'Whiteboard', 'The drawing, with what hurts and the goals: the search button in its toolbox (or /) adds a situation'], ['arch', 'Architecture', 'The Cribl deployment: leader, worker groups, Edge, Lake and Search']] as const).map(([m, label, hint]) => (
                <button key={m} type="button" aria-pressed={mode === m} disabled={m === 'arch' ? !archLoaded : !ready} title={hint} onClick={() => changeMode(m)}>{label}</button>
              ))}
            </span>
            <span className="wb-grow" />
            {!isArch && <LanguagePicker lang={lang} disabled={!ready} onPick={(l) => { setLang(l); connRef.current?.setLang(l); }} />}
            {isArch
              ? <PopMenu label={exporting ? `Exporting ${exporting.toUpperCase()}…` : 'Export'} disabled={!!exporting} buttonClass="btn-secondary"
                items={[
                  { label: 'PNG image', hint: 'The architecture, for the follow-up email', onPick: () => void doArchExport('png') },
                  { label: 'PDF document', hint: 'One page, ready to share', onPick: () => void doArchExport('pdf') },
                  { label: 'SVG image', hint: 'To edit in a drawing tool', onPick: () => void doArchExport('svg') },
                  jsonItem,
                ]} />
              : <PopMenu label={exporting ? `Exporting ${exporting.toUpperCase()}…` : 'Export'} disabled={!ready || !!exporting} buttonClass="btn-secondary"
                items={[
                  { label: 'PNG image', hint: 'For the follow-up email', onPick: () => void doExport('png') },
                  { label: 'PDF document', hint: 'One page, ready to share', onPick: () => void doExport('pdf') },
                  jsonItem,
                ]} />}
            {onGenerate && <button type="button" className="btn-primary" disabled={!ready} onClick={() => void leaveTo(onGenerate)}>Deploy demo</button>}
          </>
        )}
      </div>
      {loadError
        ? <p className="wb-error" role="alert">{loadError}</p>
        : html
          ? <>
            <iframe ref={frameRef} className="wb-frame" hidden={isArch} title={`Whiteboard: ${prospect || 'untitled prospect'}`} srcDoc={html} allow="fullscreen; clipboard-write" />
            {isArch && archLoaded && (
              <ArchitectureBoard ref={archRef} initial={archDocRef.current} prospect={prospect} logo={logo} onToast={onToast}
                fromBoard={() => (docRef.current ? boardIntake(libRef.current, docRef.current.meet) : null)}
                onChange={(d) => { archDocRef.current = d; archSaver.push(d); }} />
            )}
          </>
          : <p className="wb-loading">Opening the whiteboard…</p>}
      {logoAsk && (
        <LogoDialog prospect={logoAsk.prospect} hasLogo={logoAsk.has} lang={lang} onClose={() => setLogoAsk(null)}
          onPick={(logo) => { connRef.current?.setLogo(logo); setLogoAsk(null); }} />
      )}
    </div>
  );
}

// --- the list -----------------------------------------------------------------

function FullScreenIcon({ exit }: { exit?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {exit
        ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
        : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5" />
    </svg>
  );
}

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

/** The board's language: its short code in the header; hovering it (or a click) lists the others. */
function LanguagePicker({ lang, disabled, onPick }: { lang: string; disabled?: boolean; onPick: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cur = BOARD_LANGUAGES.find(l => l.code === lang) ?? BOARD_LANGUAGES[0];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const show = () => { clearTimeout(closeTimer.current); if (!disabled) setOpen(true); };
  // A short grace, so the pointer can cross the gap between the code and its list.
  const hide = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 200); };
  return (
    <div className="wb-menu wb-lang" ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      <button type="button" className="wb-langbtn" aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        aria-label={`Language: ${cur.name}`} title={cur.name} onClick={() => setOpen(o => !o)}>
        {cur.short}<span className="wb-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="wb-pop wb-langpop" role="menu" aria-label="Language">
          {BOARD_LANGUAGES.filter(l => l.code !== cur.code).map(l => (
            <button key={l.code} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(l.code); }}>
              <b>{l.short}</b>{l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type MenuItem = { label: string; hint?: string; danger?: boolean; separator?: boolean; onPick: () => void };

/** A button that opens a small menu; closes on pick, outside click or Escape. */
function PopMenu({ label, ariaLabel, items, disabled, buttonClass = 'wb-link' }: {
  label: string; ariaLabel?: string; items: MenuItem[]; disabled?: boolean; buttonClass?: string;
}) {
  const [open, setOpen] = useState(false);
  // Opens upward when the space under the button is too short for it (the last rows of a list).
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!open && r) setUp(window.innerHeight - r.bottom < 60 + items.length * 36 && r.top > window.innerHeight - r.bottom);
    setOpen(o => !o);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div className="wb-menu" ref={ref}>
      <button type="button" className={`${buttonClass} wb-menubtn`} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        aria-label={ariaLabel} onClick={toggle}>{label}<span className="wb-caret" aria-hidden="true" /></button>
      {open && (
        <div className={`wb-pop${up ? ' up' : ''}`} role="menu">
          {items.map(it => (
            <div key={it.label}>
              {it.separator && <hr />}
              <button type="button" role="menuitem" className={it.danger ? 'danger' : undefined} onClick={pick(it.onPick)}>
                {it.label}{it.hint && <small>{it.hint}</small>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RowMenu({ name, onExport, onExportJson, onDuplicate, onDelete }: {
  name: string; onExport: (k: ExportKind) => void; onExportJson: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  return <PopMenu label="More" ariaLabel={`More actions for ${name}`} items={[
    { label: 'Export PNG', onPick: () => onExport('png') },
    { label: 'Export PDF', onPick: () => onExport('pdf') },
    { label: 'Export JSON', hint: 'To open on another Cribl org', onPick: onExportJson },
    { label: 'Duplicate', separator: true, onPick: onDuplicate },
    { label: 'Delete', danger: true, onPick: onDelete },
  ]} />;
}

/** Labels of what a board would start with, from the SE's own library (the board's defaults merged in). */
function usualEstate(lib: WhiteboardLibV5 | null) {
  const meet = emptyMeet();
  const sources = liveItems(lib, meet, 'sources').map(i => i.label || '').filter(Boolean);
  const stores = DESTINATION_GROUPS.flatMap(g => liveItems(lib, meet, g)).filter(i => !i.isCribl).map(i => i.label || '').filter(Boolean);
  return { sources, stores };
}

/**
 * The prospect's logo, found by name (Wikidata's official logo, else the website's icon), picked in
 * one click. The search runs when the dialog opens with a name and on Search; nothing else is sent.
 * Uploading a file stays possible, and dropping one on the board's logo slot too.
 */
function LogoDialog({ prospect, hasLogo, lang, onPick, onClose }: {
  prospect: string; hasLogo: boolean; lang: string; onPick: (logo: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(prospect.trim());
  const [site, setSite] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'searching' | 'done' | 'error'; message?: string }>({ kind: 'idle' });
  const [found, setFound] = useState<(LogoCandidate & { preview?: string; failed?: boolean })[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = useRef(0);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  // Each image is read as a data URL (through the proxy in the iframe), then shown.
  const show = (list: LogoCandidate[], id: number) => {
    setFound(list);
    list.forEach(c => {
      void fetchImageDataUrl(c.imageUrl)
        .then(preview => { if (run.current === id) setFound(fs => fs.map(f => (f.imageUrl === c.imageUrl ? { ...f, preview } : f))); })
        .catch(() => { if (run.current === id) setFound(fs => fs.map(f => (f.imageUrl === c.imageUrl ? { ...f, failed: true } : f))); });
    });
  };
  const search = useCallback(async (q: string) => {
    const id = ++run.current;
    if (!q.trim()) { setFound([]); setState({ kind: 'idle' }); return; }
    setState({ kind: 'searching' });
    try {
      const list = await searchLogos(q, { lang });
      if (run.current !== id) return;
      show(list, id);
      setState({ kind: 'done' });
    } catch (err) {
      if (run.current !== id) return;
      setFound([]);
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [lang]);
  useEffect(() => { if (prospect.trim()) void search(prospect.trim()); }, [prospect, search]);
  const fromSite = () => {
    const c = siteIconCandidate(site);
    if (!c) { setState({ kind: 'error', message: 'That is not a website address (for example acme.com)' }); return; }
    const id = ++run.current;
    show([c, ...found.filter(f => f.imageUrl !== c.imageUrl)], id);
    setState({ kind: 'done' });
  };
  const pick = async (key: string, read: () => Promise<string>) => {
    setBusy(key);
    try { onPick(await scaleLogo(await read())); }
    catch (err) { setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(null); }
  };
  const readFile = (file: File) => new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('The file could not be read'));
    fr.readAsDataURL(file);
  });
  const shown = found.filter(f => !f.failed);
  return (
    <div className="wb-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wb-modal wb-logodlg" role="dialog" aria-modal="true" aria-labelledby="wb-logo-title">
        <div className="wb-modal-head">
          <h3 id="wb-logo-title">Prospect logo</h3>
          <button type="button" className="wb-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="wb-modal-sub">Found by the company's name on Wikidata. Pick the right one: nothing to download.</p>
        <form className="wb-logoq" onSubmit={(e) => { e.preventDefault(); void search(query); }}>
          <input type="search" value={query} placeholder="Company name" aria-label="Company name" autoFocus onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className="btn-primary" disabled={!query.trim() || state.kind === 'searching'}>Search</button>
        </form>
        <div className="wb-logogrid" aria-live="polite">
          {state.kind === 'searching' && <p className="wb-loading">Searching…</p>}
          {state.kind === 'error' && <p className="wb-error" role="alert">{state.message}</p>}
          {state.kind === 'done' && shown.length === 0 && (
            <p className="wb-loading">No logo found for “{query.trim()}”. Try the full company name, their website, or upload the image.</p>
          )}
          {shown.map(c => (
            <button key={c.imageUrl} type="button" className="wb-logotile" disabled={!c.preview || !!busy}
              title={c.description || c.name} onClick={() => void pick(c.imageUrl, async () => c.preview!)}>
              <span className="wb-logoimg">{c.preview ? <img src={c.preview} alt="" /> : <i aria-hidden="true" />}</span>
              <b>{c.name}</b>
              <small>{busy === c.imageUrl ? 'Adding…' : c.description || (c.source === 'site' ? 'Website icon' : '')}</small>
            </button>
          ))}
        </div>
        <div className="wb-logomore">
          <form className="wb-logoq" onSubmit={(e) => { e.preventDefault(); fromSite(); }}>
            <input value={site} placeholder="Or their website, e.g. acme.com" aria-label="Website" onChange={(e) => setSite(e.target.value)} />
            <button type="submit" className="btn-secondary" disabled={!site.trim()}>Use its icon</button>
          </form>
          <span className="wb-grow" />
          <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>Upload an image</button>
          {hasLogo && <button type="button" className="wb-link wb-link-danger" onClick={() => onPick('')}>Remove the logo</button>}
          <input ref={fileRef} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick('file', () => readFile(f)); }} />
        </div>
      </div>
    </div>
  );
}

/** How a new board starts: with nothing of the prospect's estate, or with the usual one. */
function NewBoardDialog({ lib, onPick, onClose }: { lib: WhiteboardLibV5 | null | undefined; onPick: (start: BoardStart) => void; onClose: () => void }) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const lastRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (rememberedStart === 'usual' ? lastRef : firstRef).current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const estate = lib === undefined ? null : usualEstate(lib);
  const sample = (xs: string[]) => xs.length > 4 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : xs.join(', ');
  return (
    <div className="wb-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wb-modal" role="dialog" aria-modal="true" aria-labelledby="wb-new-title">
        <div className="wb-modal-head">
          <h3 id="wb-new-title">New whiteboard</h3>
          <button type="button" className="wb-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="wb-modal-sub">How should the board start? You can add and remove anything on it later.</p>
        <div className="wb-starts">
          <button type="button" ref={firstRef} className="wb-start" onClick={() => onPick('empty')}>
            <span className="wb-start-art empty" aria-hidden="true"><i /><i /><i /></span>
            <b>Start empty</b>
            <span>No sources and no destinations. Draw only what the prospect tells you, with the + on each row.</span>
            <small>Best for a first discovery call</small>
          </button>
          <button type="button" ref={lastRef} className="wb-start" onClick={() => onPick('usual')}>
            <span className="wb-start-art usual" aria-hidden="true"><i /><i /><i /></span>
            <b>Start with the usual estate</b>
            <span>
              {estate
                ? <>{estate.sources.length} sources and {estate.stores.length} destinations already on the board{estate.sources.length ? <> ({sample(estate.sources)})</> : null}. Remove what they don't run.</>
                : <>Common sources and destinations already on the board. Remove what they don't run.</>}
            </span>
            <small>Best when you already know the estate</small>
          </button>
        </div>
      </div>
    </div>
  );
}


/** Loads a board and the library for the validation screen. */
function ValidateLoader({ id, onBack, onContinue, onToast }: { id: string; onBack: () => void; onContinue: (seed: DemoSeed) => void; onToast: (msg: string) => void }) {
  const [data, setData] = useState<{ doc: WhiteboardDoc; lib: WhiteboardLibV5 | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadBoard(id), loadLibrary()]).then(([doc, lib]) => {
      if (cancelled) return;
      if (!doc) setError('This whiteboard could not be found. It may have been deleted in another tab.');
      else setData({ doc, lib });
    }).catch(err => { if (!cancelled) setError(`The whiteboard could not be loaded: ${err instanceof Error ? err.message : String(err)}`); });
    return () => { cancelled = true; };
  }, [id]);
  if (error) return <p className="wb-error" role="alert">{error}</p>;
  if (!data) return <p className="wb-loading">Opening the whiteboard…</p>;
  return <DiscoveryValidate board={data.doc} lib={data.lib} onBack={onBack} onContinue={onContinue} onToast={onToast} />;
}

export default function WhiteboardsPage({ onGenerateDemo, onNewDemo, initialBoardId, onInitialBoardOpened, onBoardOpen }: {
  /** Fill Demo mode from a validated board (App.startDemoFromSeed). Absent = no Generate. */
  onGenerateDemo?: (seed: DemoSeed) => void;
  /** Open Demo environment empty: a demo made by hand, not from a board. */
  onNewDemo?: () => void;
  /** Open this board straight away (the demo banner's "Back to the whiteboard"). */
  initialBoardId?: string | null;
  onInitialBoardOpened?: () => void;
  /** A board opened (true) or closed (false): the app folds its rail while one is open. */
  onBoardOpen?: (open: boolean) => void;
}) {
  const [rows, setRows] = useState<WhiteboardIndexEntry[] | null>(null);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<BoardSort>(rememberedSort);
  const setSort = (s: BoardSort) => { rememberedSort = s; setSortState(s); };
  // Prospect names start hidden every time the list opens: a screen shared on a call shows no customers.
  const [reveal, setReveal] = useState(false);
  const shownName = (name: string) => displayName(name, reveal);
  // null = closed; lib undefined = still loading, null = the SE has no library yet (board defaults)
  const [newDialog, setNewDialog] = useState<{ lib: WhiteboardLibV5 | null | undefined } | null>(null);
  const [view, setView] = useState<{ id: string; mode: 'board' | 'validate'; startIn?: EditorView } | null>(initialBoardId ? { id: initialBoardId, mode: 'board' } : null);
  const openId = view?.id ?? null;
  const setOpenId = (id: string | null, startIn?: EditorView) => setView(id ? { id, mode: 'board', ...(startIn ? { startIn } : {}) } : null);
  useEffect(() => { if (initialBoardId) onInitialBoardOpened?.(); }, [initialBoardId, onInitialBoardOpened]);
  // Its check screen counts as the board: the rail stays folded until the list is back (or the page closes).
  useEffect(() => {
    if (!openId) return;
    onBoardOpen?.(true);
    return () => onBoardOpen?.(false);
  }, [openId, onBoardOpen]);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pendingDelete = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string, undo?: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, undo });
    toastTimer.current = setTimeout(() => setToast(null), undo ? UNDO_MS : 4000);
  }, []);

  const refresh = useCallback(async () => {
    try { setRows(await listBoards()); setListError(''); }
    catch (err) { setListError(`The list of whiteboards could not be read: ${err instanceof Error ? err.message : String(err)}`); setRows([]); }
  }, []);

  useEffect(() => { if (!openId) void refresh(); }, [openId, refresh]);
  const [destroying, setDestroying] = useState<{ demo: LiveDemo; label: string } | null>(null);

  // A delete still waiting for its undo window is carried out when the page closes.
  useEffect(() => () => {
    const p = pendingDelete.current;
    if (p) { clearTimeout(p.timer); void deleteBoard(p.id); }
  }, []);

  const report = (r: SaveResult, okMsg?: string) => { if (!r.ok) showToast(`Not saved: ${r.message}`); else if (okMsg) showToast(okMsg); return r.ok; };

  const openNewDialog = () => {
    setNewDialog({ lib: undefined });
    void loadLibrary().then(lib => setNewDialog(d => (d ? { lib } : d))).catch(() => setNewDialog(d => (d ? { lib: null } : d)));
  };

  const create = async (start: BoardStart) => {
    rememberedStart = start;
    setNewDialog(null);
    const lib = await loadLibrary();
    const doc = newBoardDoc(new Date(), start === 'empty' ? blankMeet(lib) : undefined);
    if (report(await saveBoard(doc, lib))) setOpenId(doc.id);
  };

  const duplicate = async (row: WhiteboardIndexEntry) => {
    const doc = await loadBoard(row.id);
    if (!doc) { showToast('That whiteboard could not be found.'); return; }
    const copy = duplicateBoard(doc);
    if (!report(await saveBoard(copy, await loadLibrary()))) return;
    // the drawing comes along with the board
    const arch = await loadArchitecture(row.id);
    if (arch && !report(await saveArchitecture(copy.id, arch))) { void refresh(); return; }
    showToast(copy.meet.prospect ? `Duplicated as ${shownName(copy.meet.prospect)}` : 'Duplicated as an untitled board');
    void refresh();
  };

  const rename = async (row: WhiteboardIndexEntry, name: string): Promise<boolean> => {
    if (!report(await renameBoard(row.id, name))) return false;
    showToast(`Renamed to ${shownName(name)}`);
    void refresh();
    return true;
  };

  const remove = (row: WhiteboardIndexEntry) => {
    const prev = pendingDelete.current;
    if (prev) { clearTimeout(prev.timer); void deleteBoard(prev.id); }
    const timer = setTimeout(() => {
      pendingDelete.current = null;
      void deleteBoard(row.id).then(r => { if (!r.ok) { showToast(`Not deleted: ${r.message}`); void refresh(); } });
    }, UNDO_MS);
    pendingDelete.current = { id: row.id, timer };
    setRows(rs => (rs || []).filter(r => r.id !== row.id));
    showToast(`Deleted ${row.prospect ? shownName(row.prospect) : 'untitled board'}`, () => {
      clearTimeout(timer);
      pendingDelete.current = null;
      void refresh();
    });
  };

  const exportRow = async (row: WhiteboardIndexEntry, kind: ExportKind) => {
    setBusy(`${row.id}:${kind}`);
    try {
      const [doc, lib] = await Promise.all([loadBoard(row.id), loadLibrary()]);
      if (!doc) { showToast('That whiteboard could not be found.'); return; }
      showToast(`Downloaded ${await exportBoardHeadless(doc.meet, lib, kind)}`);
    } catch (err) {
      showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const exportRowJson = async (row: WhiteboardIndexEntry) => {
    try {
      const [doc, lib, arch] = await Promise.all([loadBoard(row.id), loadLibrary(), loadArchitecture(row.id)]);
      if (!doc) { showToast('That whiteboard could not be found.'); return; }
      showToast(`Downloaded ${downloadBoardJson(doc, lib, arch)}`);
    } catch (err) {
      showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const importFile = async (file: File) => {
    const parsed = parseWhiteboardFile(file.name, await file.text());
    if (parsed.kind === 'error') { showToast(parsed.message); return; }
    const mine = await loadLibrary();
    let lib = mine;
    let added = 0;
    if (parsed.lib) {
      const merged = mergeLibraries(mine, parsed.lib);
      added = merged.added;
      if (added > 0 || !mine) {
        if (!report(await saveLibrary(merged.lib))) return;
        lib = merged.lib;
      }
    }
    if (parsed.kind === 'library') { showToast(added ? `Added ${added} of your entries to your whiteboard library` : 'Your library already has everything in that file'); return; }
    const doc = newBoardDoc();
    doc.meet = parsed.pinned ? hideItemsNotOnFile(parsed.meet, lib) : parsed.meet;
    if (parsed.savedAt) doc.createdAt = parsed.savedAt;
    // The check travels with a board exported from another org; what was deployed there does not.
    if (parsed.validation) doc.validation = parsed.validation;
    if (!report(await saveBoard(doc, lib))) return;
    if (parsed.architecture && !report(await saveArchitecture(doc.id, parsed.architecture))) { void refresh(); return; }
    showToast(`Imported ${parsed.meet.prospect ? shownName(parsed.meet.prospect) : 'the whiteboard'}${added ? `, and ${added} of its library entries` : ''}`);
    void refresh();
  };

  const toastEl = toast && (
    <div className="wb-toast" role="status" aria-live="polite">
      <span>{toast.msg}</span>
      {toast.undo && <button type="button" onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}
    </div>
  );

  if (view?.mode === 'validate' && onGenerateDemo) {
    return <>{<ValidateLoader id={view.id} onBack={() => setView({ id: view.id, mode: 'board' })} onContinue={onGenerateDemo} onToast={showToast} />}{toastEl}</>;
  }
  if (view) {
    return <>{<BoardEditor id={view.id} startIn={view.startIn} onBack={() => setView(null)} onToast={showToast}
      onGenerate={onGenerateDemo ? () => setView({ id: view.id, mode: 'validate' }) : undefined} />}{toastEl}</>;
  }

  return (
    <BoardList rows={rows} listError={listError} query={query} setQuery={setQuery} sort={sort} setSort={setSort}
      reveal={reveal} setReveal={setReveal} shownName={shownName} busy={busy}
      onGenerateDemo={onGenerateDemo} onNewDemo={onNewDemo} destroying={destroying} setDestroying={setDestroying}
      showToast={showToast} refresh={refresh} openNewDialog={openNewDialog}
      openBoard={(id, startIn) => setOpenId(id, startIn)} validate={(id) => setView({ id, mode: 'validate' })} pickFile={() => fileRef.current?.click()}
      onDuplicate={(row) => void duplicate(row)} onDelete={remove} onRename={rename} onExport={(row, k) => void exportRow(row, k)}
      onExportJson={(row) => void exportRowJson(row)}>
      <input ref={fileRef} type="file" accept=".html,.htm,.json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
      {newDialog && <NewBoardDialog lib={newDialog.lib} onPick={(s) => void create(s)} onClose={() => setNewDialog(null)} />}
      {toastEl}
    </BoardList>
  );
}

/** The list's picture of a drawn architecture: a leader over worker groups. */
function ArchThumb() {
  return (
    <svg className="wb-thumb" viewBox="0 0 106 54" aria-hidden="true">
      <rect x="45" y="2" width="16" height="12" rx="2" fill="#1ccbc8" />
      {[6, 40, 74].map(x => (
        <g key={x}>
          <path d={`M53 14V22H${x + 13}V30`} stroke="#1ccbc8" fill="none" />
          <rect x={x} y="30" width="26" height="18" rx="2" fill="#d6e6f0" />
          <rect x={x + 4} y="38" width="6" height="6" fill="#2f8fc6" /><rect x={x + 16} y="38" width="6" height="6" fill="#2f8fc6" />
        </g>
      ))}
    </svg>
  );
}

const THUMB_FILL: Record<string, string> = { point: '#FF8B00', cribl: '#00CCCC', platform: '#FF8B00' };

/** The row's picture of the board: layers that are on, store columns by how full they are, curves before the pipeline. */
function BoardThumb({ sketch }: { sketch: BoardSketch }) {
  const cols = thumbColumns(sketch);
  const top = sketch.search || sketch.ai;
  const storeY = top ? 24 : 14;
  let x = 0;
  const tracks = cols.map(c => {
    const w = Math.max(c.share * 106 - 3, 8);
    const at = x;
    x += c.share * 106;
    const empty = c.key === 'platform' && sketch.platform === 0;
    return { ...c, at, w, empty };
  });
  const srcN = Math.min(sketch.sources, 8);
  return (
    <svg className="wb-thumb" viewBox="0 0 106 54" aria-hidden="true">
      {sketch.search && <rect x="0" y="0" width="32" height="8" rx="2.5" fill="#2D389A" opacity="0.85" />}
      {sketch.ai && <rect x="37" y="0" width="32" height="8" rx="2.5" fill="#05A758" opacity="0.85" />}
      {sketch.ai && <rect x="74" y="0" width="32" height="8" rx="2.5" fill="#5955FF" opacity="0.85" />}
      {top && <rect x="0" y="12" width="106" height="8" rx="2.5" fill="#0B6CD9" opacity="0.85" />}
      {tracks.map(c => c.empty
        ? <rect key={c.key} x={c.at} y={storeY} width={c.w} height="10" rx="2.5" fill="none" stroke="#D6DADE" strokeDasharray="2 2" />
        : <rect key={c.key} x={c.at} y={storeY} width={c.w} height="10" rx="2.5" fill={THUMB_FILL[c.key]} opacity={c.key === 'cribl' ? 1 : 0.9} />)}
      {sketch.pipe === 'after' && <rect x="0" y={storeY + 14} width="106" height="6" rx="2" fill="#008080" />}
      {sketch.pipe !== 'after' && (
        <g stroke="#FF3342" strokeWidth="1.1" fill="none" opacity="0.85">
          <path d={`M10 48 Q 24 ${storeY + 16} 18 ${storeY + 10}`} />
          <path d={`M36 48 Q 42 ${storeY + 16} 40 ${storeY + 10}`} />
          <path d={`M62 48 Q 58 ${storeY + 16} 64 ${storeY + 10}`} />
          <path d={`M88 48 Q 78 ${storeY + 16} 84 ${storeY + 10}`} />
        </g>
      )}
      {Array.from({ length: srcN }, (_, i) => <rect key={i} x={i * 13} y="48" width="11" height="6" rx="2" fill="#73808F" />)}
      {sketch.pains > 0 && <circle cx="100" cy={storeY + 5} r="3.5" fill="#FF3342" />}
    </svg>
  );
}

/**
 * The row's prospect name, renamed in place: a click opens a field with a small Save beside it
 * (Enter saves, Escape cancels). While names are hidden the field starts empty, so renaming
 * on a shared screen never shows the old name.
 */
function BoardName({ prospect, shown, reveal, onRename }: {
  prospect: string; shown: string; reveal: boolean; onRename: (name: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const next = (draft ?? '').trim();
  const canSave = !saving && !!next && next !== prospect.trim();
  const save = async () => {
    if (!canSave) { if (!next || next === prospect.trim()) setDraft(null); return; }
    setSaving(true);
    const ok = await onRename(next);
    setSaving(false);
    if (ok) setDraft(null);
  };
  if (draft === null) {
    return (
      <button type="button" className={`wb-name${reveal ? '' : ' wb-masked'}`} onClick={() => setDraft(reveal ? prospect : '')}
        title="Rename this whiteboard">{shown}</button>
    );
  }
  return (
    <form className="wb-rename" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input value={draft} maxLength={120} disabled={saving} aria-label="Prospect name"
        placeholder={reveal ? 'Prospect name' : 'New name'} autoFocus onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setDraft(null); } }}
        onBlur={(e) => { if (!e.currentTarget.form?.contains(e.relatedTarget as Node | null) && (!next || next === prospect.trim())) setDraft(null); }} />
      <button type="submit" className="wb-rename-save" disabled={!canSave} title="Save the new name">{saving ? '…' : 'Save'}</button>
    </form>
  );
}

/** The prospect list: one ledger row per board; then the demos no board owns. */
function BoardList({ rows, listError, query, setQuery, sort, setSort, reveal, setReveal, shownName, busy,
  onGenerateDemo, onNewDemo, destroying, setDestroying, showToast, refresh, openNewDialog, openBoard, validate, pickFile,
  onDuplicate, onDelete, onRename, onExport, onExportJson, children }: {
  rows: WhiteboardIndexEntry[] | null; listError: string;
  query: string; setQuery: (q: string) => void; sort: BoardSort; setSort: (s: BoardSort) => void;
  reveal: boolean; setReveal: (f: (r: boolean) => boolean) => void; shownName: (n: string) => string;
  busy: string | null;
  onGenerateDemo?: (seed: DemoSeed) => void; onNewDemo?: () => void;
  destroying: { demo: LiveDemo; label: string } | null; setDestroying: (d: { demo: LiveDemo; label: string } | null) => void;
  showToast: (msg: string) => void; refresh: () => Promise<void>;
  openNewDialog: () => void; openBoard: (id: string, startIn?: EditorView) => void; validate: (id: string) => void; pickFile: () => void;
  onDuplicate: (row: WhiteboardIndexEntry) => void; onDelete: (row: WhiteboardIndexEntry) => void;
  onRename: (row: WhiteboardIndexEntry, name: string) => Promise<boolean>;
  onExport: (row: WhiteboardIndexEntry, k: ExportKind) => void;
  onExportJson: (row: WhiteboardIndexEntry) => void;
  children: ReactNode;
}) {
  const demosOn = !!onGenerateDemo;
  const live = useLiveDemos(rows, { enabled: demosOn, onToast: showToast, onBoardsChanged: () => void refresh() });
  const shown = rows ? filterBoards(rows, query, sort) : [];
  const demoName = (row: WhiteboardIndexEntry) => (row.prospect ? shownName(row.prospect) : 'untitled board');
  const strip = (d: LiveDemo, label: string, title?: string) => (
    <DemoStrip key={d.key} demo={d} busy={live.busy[d.key]} title={title}
      onStop={() => live.stop(d, label)} onStart={() => live.start(d, label)}
      onDestroy={() => setDestroying({ demo: d, label })} />
  );
  const checking = live.loading
    ? 'Checking worker groups…'
    : live.checkedGroups === null ? '' : `Checked ${live.checkedGroups} worker group${live.checkedGroups === 1 ? '' : 's'}`;
  const scanStatus = demosOn && <>
    <span className="wb-count" role="status">{checking}</span>
    <button type="button" className="wb-link" disabled={live.loading} onClick={() => void live.refresh()}>Check again</button>
  </>;

  return (
    <div className="wb-page">
      <div className="wb-head">
        <div>
          <h2>Whiteboards &amp; demos</h2>
          <p>Each prospect's discovery board, the architecture you drew after the call, and the demo built from them.</p>
        </div>
        <div className="wb-actions">
          <button type="button" className="btn-secondary" onClick={pickFile}
            title="A board exported as JSON from Pack Generator on another Cribl org, a board saved as .html by the standalone whiteboard, or a library .json">Import saved whiteboard</button>
          <button type="button" className="btn-primary" onClick={openNewDialog}>New whiteboard</button>
        </div>
      </div>

      {listError && <p className="wb-error" role="alert">{listError}</p>}
      {live.failed.map(f => (
        <p key={f.group || 'groups'} className="wb-error" role="alert">
          {f.group ? <>Could not check <b>{f.group}</b>: {f.message}. Its demos are not shown.</> : f.message}
        </p>
      ))}
      {rows === null ? <p className="wb-loading">Loading whiteboards…</p>
        : rows.length === 0 ? (<>
          {demosOn && <div className="wb-toolbar"><span className="wb-grow" />{scanStatus}</div>}
          <div className="wb-empty">
            <p>No whiteboards yet. Start one before your next discovery call.</p>
            <button type="button" className="btn-primary" onClick={openNewDialog}>New whiteboard</button>
          </div>
        </>) : (
          <>
            <div className="wb-toolbar">
              <input className="wb-search" type="search" placeholder="Filter by prospect" aria-label="Filter by prospect"
                value={query} onChange={(e) => setQuery(e.target.value)} />
              <label className="wb-sort">
                <span className="wb-sr">Sort by</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as BoardSort)} aria-label="Sort by">
                  {BOARD_SORTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>
              <span className="wb-count">{shown.length === rows.length ? `${rows.length} prospect${rows.length === 1 ? '' : 's'}` : `${shown.length} of ${rows.length}`}</span>
              <span className="wb-grow" />
              {scanStatus}
              <button type="button" className={`wb-reveal${reveal ? ' on' : ''}`} aria-pressed={reveal} onClick={() => setReveal(r => !r)}
                title={reveal ? 'Hide prospect names and logos, before you share your screen' : 'Prospect names are hidden so a shared screen shows no customers'}>
                <EyeIcon off={!reveal} /> {reveal ? 'Hide names' : 'Show names'}
              </button>
            </div>
            <div className="wb-ledger">
              <div className="wb-lrow head"><span>Prospect</span><span>Whiteboard</span><span>Architecture</span><span>Demo</span><span></span></div>
              {shown.map(row => {
                const name = shownName(row.prospect);
                const tileText = reveal ? initials(row.prospect || 'Untitled') : [...(row.prospect.trim() || 'Untitled')].slice(0, 2).join('').toUpperCase();
                const demos = live.byBoard.get(row.id) || [];
                const missing = live.missingByBoard.get(row.id) || [];
                const tone: Record<LiveDemo['state'], string> = { running: 'ok', stopped: 'none', partial: 'warn' };
                return (
                  <div key={row.id} className="wb-lrow">
                    <div className="wb-who">
                      {reveal && row.logoThumb
                        ? <img className="wb-logo" src={row.logoThumb} alt="" />
                        : <span className="wb-logo" style={{ background: tileColour(row.id) }} aria-hidden="true">{tileText}</span>}
                      <div>
                        <BoardName prospect={row.prospect} shown={name} reveal={reveal} onRename={(n) => onRename(row, n)} />
                        <small>{sort === 'created' ? createdLabel(createdAtOf(row)) : editedLabel(row.updatedAt)}</small>
                      </div>
                    </div>
                    <div className="wb-part">
                      <BoardThumb sketch={sketchOf(row)} />
                      <div className="wb-parttxt">
                        <b>{summaryLabel(row.summary)}</b>
                        <small>{discoveryLabel(row.summary)}{row.validation === 'stale' ? ' · Board changed since the check' : ''}</small>
                        <button type="button" className="wb-link" onClick={() => openBoard(row.id)}>Open</button>
                      </div>
                    </div>
                    <div className="wb-part">
                      {row.arch ? <ArchThumb /> : <span className="wb-slot" aria-hidden="true">+</span>}
                      <div className="wb-parttxt">
                        <b>{row.arch ? `${row.arch.parts} part${row.arch.parts === 1 ? '' : 's'}` : 'Not drawn yet'}</b>
                        {row.arch && <small>{row.arch.groups ? `${row.arch.groups} worker group${row.arch.groups === 1 ? '' : 's'} and fleet${row.arch.groups === 1 ? '' : 's'}` : 'No worker groups yet'}</small>}
                        <button type="button" className="wb-link" onClick={() => openBoard(row.id, 'arch')}>{row.arch ? 'Open' : 'Draw it'}</button>
                      </div>
                    </div>
                    <div className="wb-democell">
                      {demosOn && demos.map(d => (
                        <div key={d.key} className="wb-demoline">
                          <span className={`wb-chip ${live.busy[d.key] ? 'none wb-chip-busy' : tone[d.state]}`}>
                            {live.busy[d.key] ? 'Working' : `${DEMO_STATE_LABEL[d.state]} on ${d.group}`}
                          </span>
                          <small>{demoFlowLabel(d)}{d.eventsPerSec && d.state !== 'stopped' ? `, ${d.eventsPerSec} events/s` : ''}</small>
                          <span className="wb-demolinks">
                            {d.state === 'stopped'
                              ? <button type="button" className="wb-link" disabled={!!live.busy[d.key] || d.datagens.length === 0} onClick={() => live.start(d, demoName(row))}>Start</button>
                              : <button type="button" className="wb-link" disabled={!!live.busy[d.key]} onClick={() => live.stop(d, demoName(row))}>Stop</button>}
                            <button type="button" className="wb-link wb-link-danger" disabled={!!live.busy[d.key]} onClick={() => setDestroying({ demo: d, label: demoName(row) })}>Destroy</button>
                          </span>
                        </div>
                      ))}
                      {demosOn && missing.map(rec => (
                        <div key={`${rec.group}:${rec.deployedAt}`} className="wb-demoline">
                          <span className="wb-chip none">Not found on {rec.group}</span>
                          <button type="button" className="wb-link" disabled={!!live.busy[`${row.id}::${rec.group}`]} onClick={() => live.forget(row.id, rec)}>Mark as removed</button>
                        </div>
                      ))}
                      {(!demosOn || (!demos.length && !missing.length)) && (
                        <div className="wb-demoline">
                          <span className="wb-chip none">{live.loading && row.demo ? 'Checking…' : 'No demo'}</span>
                          {demosOn && !(live.loading && row.demo) && (
                            <button type="button" className="wb-link" onClick={() => validate(row.id)}>Deploy a demo</button>
                          )}
                        </div>
                      )}
                      {demosOn && demos.length > 0 && (
                        <button type="button" className="wb-link" onClick={() => validate(row.id)}>Demo on another group</button>
                      )}
                    </div>
                    <div className="wb-acts">
                      {busy?.startsWith(`${row.id}:`) && <span className="wb-busy">Exporting…</span>}
                      <button type="button" className="wb-del" aria-label={`Delete ${row.prospect ? name : 'untitled board'}`}
                        title="Delete this whiteboard (you can undo it for a few seconds)" onClick={() => onDelete(row)}><TrashIcon /></button>
                      <RowMenu name={row.prospect || 'untitled prospect'} onExport={(k) => onExport(row, k)} onExportJson={() => onExportJson(row)} onDuplicate={() => onDuplicate(row)} onDelete={() => onDelete(row)} />
                    </div>
                  </div>
                );
              })}
            </div>
            {shown.length === 0 && <p className="wb-loading">No whiteboard matches “{query}”.</p>}
          </>
        )}
      {/* The demos section: a demo made by hand starts here, next to the ones already made that way */}
      {((demosOn && live.unlinked.length > 0) || onNewDemo) && (
        <section className="wb-unlinked" aria-labelledby="wb-unlinked-h">
          <div className="wb-unlinked-head">
            <div>
              <h3 id="wb-unlinked-h">Demos not made from a whiteboard</h3>
              <p>{demosOn && live.unlinked.length > 0
                ? 'Built by hand in Demo environment, or their whiteboard is not in this app (deleted, or kept in another browser). They stop and go the same way.'
                : 'A demo you pick the sources and formats for yourself, without a whiteboard.'}</p>
            </div>
            {onNewDemo && <button type="button" className="btn-secondary" onClick={onNewDemo} title="A demo you pick the sources and formats for, without a whiteboard">New demo by hand</button>}
          </div>
          {demosOn && live.unlinked.length > 0 && (
            <div className="wb-pdemos">
              {live.unlinked.map(d => strip(d, d.ns === '' ? 'hand-made' : d.ns, d.ns === '' ? 'Made by hand' : `Whiteboard not found (${d.ns})`))}
            </div>
          )}
        </section>
      )}
      {destroying && (
        <DestroyDemoDialog demo={destroying.demo} label={destroying.label} others={live.otherDemosOn(destroying.demo)}
          onCancel={() => setDestroying(null)}
          onConfirm={(lake) => { const d = destroying; setDestroying(null); live.destroy(d.demo, d.label, lake); }} />
      )}
      {children}
    </div>
  );
}
