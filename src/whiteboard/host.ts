/**
 * The app side of the whiteboard frame protocol (spec ADR-1, plan Task 2).
 *
 * The board runs in an <iframe srcdoc> inside the app's own sandboxed frame. Both have
 * opaque origins, so neither can touch the other's globals: everything goes through
 * postMessage, and a message counts only when its source is this board's window.
 *
 *   board → app  wb:ready                      send it the board's data
 *                wb:write {key, value}         the board saved its library or meeting
 *                wb:download {name, blob}      the board made a file; the app downloads it
 *                wb:exported {id, kind, blob}  answer to wb:export
 *                wb:export-failed {id, message}
 *                wb:present {on}               P, Esc or the board's button asks the app to present
 *                wb:logo {prospect}            a click on the logo slot: the app finds the logo by name
 *   app → board  wb:init {lib, meet, mode}     sent on every wb:ready (a reloaded frame re-asks); mode is 'board'
 *                wb:export {id, kind}          png | pdf, rendered by the board itself
 *                wb:fit {on}                   fit the board to its frame, not saved
 *                wb:present {on}               the app is presenting: the board hides its edit controls
 *                wb:lang {lang}                the header's language picker (the board keeps it in the SE's library)
 *                wb:set-logo {logo}            the logo the SE picked, as an image data URL ('' removes it)
 *
 * The keys are the vendored board's own localStorage keys (scripts/whiteboard-vendor.mjs).
 */
import type { WhiteboardLibV5, WhiteboardMeetV5 } from './types';

export const WB_LIB_KEY = 'cribl-canvas:lib:v5';
export const WB_MEET_KEY = 'cribl-canvas:meet:v5';
export const EXPORT_TIMEOUT_MS = 60_000;

export type ExportKind = 'png' | 'pdf';
/** What the board shows. Discovery is on the board itself now (each box's + Challenge), so there is one mode. */
export type BoardMode = 'board';

export type FrameToHost =
  | { type: 'wb:ready' }
  | { type: 'wb:write'; key: string; value: unknown }
  | { type: 'wb:download'; name: string; blob: Blob }
  | { type: 'wb:exported'; id: string; kind: ExportKind; blob: Blob }
  | { type: 'wb:export-failed'; id: string; message: string }
  | { type: 'wb:present'; on: boolean }
  | { type: 'wb:logo'; prospect?: string };

export type HostToFrame =
  | { type: 'wb:init'; lib: WhiteboardLibV5 | null; meet: WhiteboardMeetV5; mode: BoardMode }
  | { type: 'wb:export'; id: string; kind: ExportKind }
  | { type: 'wb:fit'; on: boolean }
  | { type: 'wb:present'; on: boolean }
  | { type: 'wb:lang'; lang: string }
  | { type: 'wb:set-logo'; logo: string };

/** The slice of a window the host needs — a real `window`, or a fake in tests. */
export interface MessageTarget {
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
}

export interface WhiteboardConnection {
  /** Ask the board to render itself; resolves with the file, rejects with the board's reason. */
  requestExport(kind: ExportKind): Promise<Blob>;
  /** Fit the board to its frame (on), or give it back the SE's own Fit choice (off). */
  setFit(on: boolean): void;
  /** The app is presenting (on) or not: the board hides its edit controls and fits under its title. */
  setPresent(on: boolean): void;
  /** Show the board in another language (a code of BOARD_LANGUAGES). */
  setLang(lang: string): void;
  /** Put this logo (an image data URL) on the board. */
  setLogo(logo: string): void;
  /** True once the board has sent wb:ready at least once. */
  isReady(): boolean;
  disconnect(): void;
}

export interface ConnectOptions {
  /** The latest library and meeting — read on every wb:ready, so a reloaded frame gets the current state. */
  getLib(): WhiteboardLibV5 | null;
  getMeet(): WhiteboardMeetV5;
  onLib(lib: WhiteboardLibV5): void;
  onMeet(meet: WhiteboardMeetV5): void;
  onDownload?(name: string, blob: Blob): void;
  /** The board asked to start (true) or stop (false) presenting. */
  onPresentRequest?(on: boolean): void;
  /** The SE clicked the board's logo slot. */
  onLogoRequest?(prospect: string): void;
  onReady?(): void;
  /** Where messages arrive (default: window) — injectable for tests. */
  target?: MessageTarget;
  exportTimeoutMs?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function connectWhiteboardFrame(frame: { contentWindow: Window | null }, opts: ConnectOptions): WhiteboardConnection {
  const target: MessageTarget = opts.target ?? window;
  const timeoutMs = opts.exportTimeoutMs ?? EXPORT_TIMEOUT_MS;
  const pending = new Map<string, { resolve: (b: Blob) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let ready = false;
  let seq = 0;

  const post = (msg: HostToFrame) => frame.contentWindow?.postMessage(msg, '*');

  const onMessage = (ev: MessageEvent) => {
    if (!frame.contentWindow || ev.source !== frame.contentWindow) return;
    const d = ev.data as FrameToHost;
    if (!isObject(d) || typeof d.type !== 'string') return;
    switch (d.type) {
      case 'wb:ready':
        ready = true;
        post({ type: 'wb:init', lib: opts.getLib(), meet: opts.getMeet(), mode: 'board' });
        opts.onReady?.();
        break;
      case 'wb:write':
        if (d.key === WB_LIB_KEY && isObject(d.value)) opts.onLib(d.value as unknown as WhiteboardLibV5);
        else if (d.key === WB_MEET_KEY && isObject(d.value)) opts.onMeet(d.value as unknown as WhiteboardMeetV5);
        break;
      case 'wb:present':
        opts.onPresentRequest?.(d.on === true);
        break;
      case 'wb:logo':
        opts.onLogoRequest?.(typeof d.prospect === 'string' ? d.prospect : '');
        break;
      case 'wb:download':
        if (d.blob instanceof Blob && typeof d.name === 'string') opts.onDownload?.(d.name, d.blob);
        break;
      case 'wb:exported':
      case 'wb:export-failed': {
        const p = pending.get(String(d.id));
        if (!p) break;
        pending.delete(String(d.id));
        clearTimeout(p.timer);
        if (d.type === 'wb:exported' && d.blob instanceof Blob) p.resolve(d.blob);
        else p.reject(new Error(d.type === 'wb:export-failed' && d.message ? d.message : 'The whiteboard returned no file.'));
        break;
      }
    }
  };
  target.addEventListener('message', onMessage);

  return {
    isReady: () => ready,
    setFit(on) { if (ready) post({ type: 'wb:fit', on }); },
    setPresent(on) { if (ready) post({ type: 'wb:present', on }); },
    setLang(lang) { if (ready) post({ type: 'wb:lang', lang }); },
    setLogo(logo) { if (ready) post({ type: 'wb:set-logo', logo }); },
    requestExport(kind) {
      if (!ready) return Promise.reject(new Error('The whiteboard has not finished loading.'));
      const id = `x${++seq}`;
      return new Promise<Blob>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The whiteboard did not finish the ${kind.toUpperCase()} within ${Math.ceil(timeoutMs / 1000)} s.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        post({ type: 'wb:export', id, kind });
      });
    },
    disconnect() {
      target.removeEventListener('message', onMessage);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('The whiteboard was closed.')); }
      pending.clear();
    },
  };
}
