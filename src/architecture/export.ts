/**
 * The Architecture board as PNG, PDF or SVG, named like the whiteboard's exports.
 * PNG draws the export SVG on a canvas at 2×; PDF puts that drawing on one page sized to it,
 * as JPEG like the whiteboard's own PDF (a PNG is stored uncompressed: megabytes).
 */
import { downloadBlob, exportFileBase } from '../whiteboard/export';
import type { Arch } from './model';
import { exportSvgDoc, type ArchHeading } from './render';
import { jpegPdf } from './pdf';

export type ArchExportKind = 'png' | 'pdf' | 'svg';

const SCALE = 2;

async function drawCanvas(svg: string, w: number, h: number): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.decoding = 'async';
  // a data: URL, not blob: — the app frame's sandbox may refuse blob images on a canvas
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w * SCALE;
  canvas.height = h * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the image.');
  ctx.scale(SCALE, SCALE);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

/** Download the drawing; returns the file name. */
export async function exportArchitecture(a: Arch, kind: ArchExportKind, prospect: string, logo = ''): Promise<string> {
  const heading: ArchHeading = { logo };
  const doc = exportSvgDoc(a, heading);
  if (!doc) throw new Error('Draw something first.');
  const name = `${exportFileBase(prospect).replace(/_Cribl-platform$/, '_Cribl-architecture')}.${kind}`;
  if (kind === 'svg') {
    downloadBlob(name, new Blob([doc.svg], { type: 'image/svg+xml' }));
    return name;
  }
  const canvas = await drawCanvas(doc.svg, doc.w, doc.h);
  if (kind === 'png') {
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The image could not be made.'))), 'image/png'));
    downloadBlob(name, png);
    return name;
  }
  const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The image could not be made.'))), 'image/jpeg', 0.92));
  const bytes = jpegPdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height, doc.w, doc.h);
  downloadBlob(name, new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  return name;
}
