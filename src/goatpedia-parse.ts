/** Log-sample parser, ported from the Goatpedia site's parse.js. */

export interface ParsedField {
  i: number;
  name: string;
  value: string;
  text: string;
}

export interface ParseInput {
  format: string;
  sample: string;
  fields?: string[];
  pattern?: string;
}

export const SEP: Record<string, string> = {
  csv: ',', tsv: '⇥', kv: ' ', json: '  ', cef: ' ', leef: ' ', xml: '  ', text: ' ',
};

interface Pair { name: string; value: string }

function split(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const c of line) {
    if (c === '"') { q = !q; cur += c; }
    else if (c === sep && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function kv(s: string, delim?: string): Pair[] {
  const out: Pair[] = [];
  if (delim) {
    for (const part of s.split(delim)) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq < 1) { out.push({ name: 'header', value: part }); continue; }
      out.push({ name: part.slice(0, eq), value: part.slice(eq + 1) });
    }
    return out;
  }
  const re = /(?:^|\s|>)([\w.:\-[\]]+)=("(?:[^"\\]|\\.)*"\]?|.*?)(?=\s+[\w.:\-[\]]+=|\s*$)/g;
  let m: RegExpExecArray | null;
  let first = true;
  let last = 0;
  while ((m = re.exec(s))) {
    const keyAt = m.index + m[0].indexOf(m[1] + '=');
    if (first && keyAt > 0 && s.slice(0, keyAt).trim()) out.push({ name: 'header', value: s.slice(0, keyAt).trim() });
    first = false;
    let v = m[2];
    if (v.length > 1 && v[0] === '"' && v.endsWith('"]')) v = v.slice(1, -2);
    else if (v.length > 1 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    out.push({ name: m[1], value: v });
    last = re.lastIndex;
  }
  if (first && s.trim()) out.push({ name: 'header', value: s.trim() });
  else if (s.slice(last).trim()) out.push({ name: 'trailer', value: s.slice(last).trim() });
  return out;
}

function flat(o: unknown, p: string, out: Pair[]): Pair[] {
  if (o !== null && typeof o === 'object') {
    const arr = Array.isArray(o);
    const ks = arr ? o.map((_, i) => i) : Object.keys(o as Record<string, unknown>);
    if (!ks.length) out.push({ name: p, value: arr ? '[]' : '{}' });
    for (const k of ks) {
      const child = arr ? (o as unknown[])[k as number] : (o as Record<string, unknown>)[k as string];
      flat(child, arr ? `${p}[${k}]` : p ? `${p}.${k}` : String(k), out);
    }
  } else out.push({ name: p, value: o === null ? 'null' : String(o) });
  return out;
}

function cef(s: string): Pair[] {
  const at = s.indexOf('CEF:');
  if (at < 0) throw new Error('no "CEF:" header');
  const out: Pair[] = at > 0 ? [{ name: 'syslog_header', value: s.slice(0, at).trim() }] : [];
  const parts: string[] = [];
  let cur = '';
  let rest = '';
  const body = s.slice(at);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) { cur += c + body[++i]; continue; }
    if (c === '|' && parts.length < 7) {
      parts.push(cur);
      cur = '';
      if (parts.length === 7) { rest = body.slice(i + 1); break; }
      continue;
    }
    cur += c;
  }
  if (parts.length < 7) throw new Error('CEF header needs 7 pipe-separated fields');
  const H = ['cef_version', 'device_vendor', 'device_product', 'device_version', 'signature_id', 'name', 'severity'];
  parts.forEach((v, i) => out.push({ name: H[i], value: i === 0 ? v.replace(/^CEF:/, '') : v }));
  return out.concat(kv(rest));
}

function leef(s: string): Pair[] {
  const at = s.indexOf('LEEF:');
  if (at < 0) throw new Error('no "LEEF:" header');
  const out: Pair[] = at > 0 ? [{ name: 'syslog_header', value: s.slice(0, at).trim() }] : [];
  const body = s.slice(at);
  const ver = body.slice(5, body.indexOf('|'));
  const n = ver.startsWith('2') ? 6 : 5;
  let parts = body.split('|');
  if (n === 5 && parts.length === 5 && parts[4].includes('\t')) {
    const t = parts[4].indexOf('\t');
    parts = [...parts.slice(0, 4), parts[4].slice(0, t), parts[4].slice(t + 1)];
  }
  if (parts.length <= n) throw new Error('LEEF header too short');
  const H = ['leef_version', 'vendor', 'product', 'version', 'event_id', 'delimiter'];
  parts.slice(0, n).forEach((v, i) => out.push({ name: H[i], value: i === 0 ? v.replace(/^LEEF:/, '') : v }));
  let delim = '\t';
  if (n === 6 && parts[5]) {
    delim = parts[5].startsWith('x') || parts[5].startsWith('0x')
      ? String.fromCharCode(parseInt(parts[5].replace(/^0?x/, ''), 16))
      : parts[5];
  }
  return out.concat(kv(parts.slice(n).join('|'), delim));
}

function xml(s: string): Pair[] {
  const out: Pair[] = [];
  const re = /<Data Name=['"]([^'"]+)['"]\s*>([^<]*)<\/Data>|<Data Name=['"]([^'"]+)['"]\s*\/>|<(\w+)((?:\s+[\w:]+=['"][^'"]*['"])*)\s*(\/?)>([^<]*)(?=<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) { out.push({ name: m[1], value: m[2] }); continue; }
    if (m[3]) { out.push({ name: m[3], value: '' }); continue; }
    const tag = m[4];
    if (tag === 'Data' || tag === 'Event' || tag === 'System' || tag === 'EventData') continue;
    for (const a of (m[5] || '').matchAll(/([\w:]+)=['"]([^'"]*)['"]/g)) {
      if (!a[1].startsWith('xmlns')) out.push({ name: `${tag}.${a[1]}`, value: a[2] });
    }
    if (!m[6] && m[7].trim()) out.push({ name: tag, value: m[7] });
  }
  if (!out.length) throw new Error('no XML elements found');
  return out;
}

function text(s: string, pattern?: string): Pair[] {
  if (!pattern) throw new Error('format "text" needs a `pattern` (regex with named groups)');
  const m = new RegExp(pattern).exec(s);
  if (!m?.groups) throw new Error('pattern does not match the sample');
  return Object.entries(m.groups).map(([name, value]) => ({ name, value: value ?? '' }));
}

export function parseLog(l: ParseInput): ParsedField[] {
  const f = l.format;
  let rows: Pair[];
  if (f === 'csv' || f === 'tsv') rows = split(l.sample, f === 'csv' ? ',' : '\t').map((value, i) => ({ name: (l.fields || [])[i] ?? '', value }));
  else if (f === 'kv') rows = kv(l.sample);
  else if (f === 'json') rows = flat(JSON.parse(l.sample), '', []);
  else if (f === 'cef') rows = cef(l.sample);
  else if (f === 'leef') rows = leef(l.sample);
  else if (f === 'xml') rows = xml(l.sample);
  else if (f === 'text') rows = text(l.sample, l.pattern);
  else throw new Error(`unknown format "${f}"`);
  return rows.map((r, i) => ({
    i, name: r.name, value: r.value,
    text: f === 'csv' || f === 'tsv' || f === 'text' ? r.value : `${r.name}=${r.value}`,
  }));
}
