/**
 * A one-page PDF holding one JPEG: all the Architecture export needs.
 *
 * jsPDF did this before, and with its optional html2canvas, DOMPurify and canvg it was about
 * 200 KB of the app's gzipped bundle, enough to push the community package over the Marketplace's
 * 5 MB upload limit (build 1016). A JPEG goes into a PDF as-is (DCTDecode), so the file is the
 * image plus five small objects and a cross-reference table.
 */

/** `widthPx` × `heightPx` is the drawing's size in CSS pixels; the page is that size at 96 dpi. */
export function jpegPdf(jpeg: Uint8Array, imageW: number, imageH: number, widthPx: number, heightPx: number): Uint8Array {
  const pt = (px: number) => Math.round(px * 0.75 * 100) / 100; // 96 dpi → 72 pt per inch
  const w = pt(widthPx), h = pt(heightPx);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: string) => { offsets[n] = length; push(`${n} 0 obj\n${body}\nendobj\n`); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = length;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageW} /Height ${imageH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);

  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1, 6).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
