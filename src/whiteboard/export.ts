/**
 * Export a whiteboard as PNG or PDF — what the SE sends the prospect (spec R5, plan Task 4).
 *
 * The board renders itself (its own capturePng / pngToPdf, the same code as the
 * standalone file); the app asks over the frame protocol and downloads the result from
 * its own frame. A board that is not open is mounted off-screen for the export.
 */
import { connectWhiteboardFrame, type ExportKind, type WhiteboardConnection } from './host';
import type { WhiteboardLibV5, WhiteboardMeetV5 } from './types';

/** The vendored board as one HTML string, loaded only when a board is shown or exported. */
export async function loadBoardHtml(): Promise<string> {
  return (await import('./board.generated.html?raw')).default;
}

/** The board's own file-name rule (v5 `slug` + `baseName`): `2026-10-31_Acme-Bank_Cribl-platform`. */
export function exportFileBase(prospect: string, date = new Date()): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const slug = String(prospect || '').trim().replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, '').replace(/\s+/g, '-').slice(0, 60);
  return `${d}_${slug || 'Prospect'}_Cribl-platform`;
}

export function downloadBlob(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Export through an open board's connection and download the file. */
export async function exportBoard(conn: WhiteboardConnection, kind: ExportKind, prospect: string): Promise<string> {
  const blob = await conn.requestExport(kind);
  const name = `${exportFileBase(prospect)}.${kind}`;
  downloadBlob(name, blob);
  return name;
}

const READY_TIMEOUT_MS = 20_000;
/** The board lays out on font load and builds its flows on the next frames; give it that before capturing. */
const SETTLE_MS = 1200;

/** Export a board that is not on screen: mount it off-screen, export, remove it. */
export async function exportBoardHeadless(meet: WhiteboardMeetV5, lib: WhiteboardLibV5 | null, kind: ExportKind): Promise<string> {
  const html = await loadBoardHtml();
  const frame = document.createElement('iframe');
  frame.title = 'Whiteboard export';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1500px;height:1000px;border:0;visibility:hidden';
  let conn: WhiteboardConnection | null = null;
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The whiteboard did not load for the export.')), READY_TIMEOUT_MS);
      conn = connectWhiteboardFrame(frame, {
        getLib: () => lib, getMeet: () => meet,
        // An export must not change the stored board: its writes are dropped.
        onLib() {}, onMeet() {},
        onReady: () => { clearTimeout(timer); resolve(); },
      });
    });
    frame.srcdoc = html;
    document.body.appendChild(frame);
    await ready;
    await new Promise(r => setTimeout(r, SETTLE_MS));
    return await exportBoard(conn!, kind, meet.prospect);
  } finally {
    (conn as WhiteboardConnection | null)?.disconnect();
    frame.remove();
  }
}
