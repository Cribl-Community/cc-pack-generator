import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupCategoryFor } from './lookup-bundler.mjs';
import { AI_MODEL as MODEL_ID, invokeModel } from './cribl-auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_LOOKUPS_PATH = join(__dirname, '..', 'config', 'golden-lookups');

// Which parsing lookup + key column applies to a sourcetype's code-driven parse.
function parsingLookupFor(sourcetype) {
  const cat = lookupCategoryFor(sourcetype);
  if (cat === 'cisco_asa') return { file: 'cisco_asa_parsing.csv', codeField: 'asa_code', codeRegex: /%(?:ASA|FTD)-\d-(\d+):/ };
  if (cat === 'cisco_ftd') return { file: 'cisco_ftd_parsing.csv', codeField: 'ftd_code', codeRegex: /%(?:FTD|ASA)-\d-(\d+):/ };
  return null;
}

// Minimal CSV parse/serialize preserving the asa_code,regex shape.
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && (r.length > 1 || r[0] !== ''));
}

function serializeCsv(rows) {
  return rows.map(r => r.map(cell => {
    const s = String(cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

// Convert a JS-style named-group regex (?<name>) — test with the JS engine the
// way Cribl's _raw.match() will at runtime.
function jsTest(regexStr, line) {
  try {
    const re = new RegExp(regexStr);
    const m = line.match(re);
    if (!m) return { matched: false, count: 0 };
    const groups = m.groups || {};
    const count = Object.values(groups).filter(v => v != null && v !== '').length;
    return { matched: true, count };
  } catch {
    return { matched: false, count: 0, error: true };
  }
}

async function invokeAi(system, user, maxTokens = 1024) {
  return invokeModel(MODEL_ID, system, user, maxTokens);
}

// Ask the AI to produce a corrected extraction regex for one code. For codes
// already in the lookup we repair from the REAL sample lines; for codes MISSING
// from the lookup we lean on the AI's knowledge of the official Cisco ASA/FTD
// syslog message-ID documentation to derive the canonical format (then still
// verify against any sample lines we have). Returns a regex string using
// (?<name>) named groups, or null.
async function repairRegex(code, sampleLines, oldRegex, isNew = false) {
  const canonicalFields = `action, transport, protocol, src_ip, src_port, dest_ip, dest_port, src_interface, dest_interface, src_user, dest_user, icmp_type, icmp_code, icmp_id, access_group, rule_id, bytes, duration, session_id, direction, reason, user`;

  const system = isNew
    ? `You are a Cisco ASA/FTD syslog expert. A per-message-code extraction regex is MISSING from our lookup for message ID ${code}. Use your knowledge of the OFFICIAL Cisco ASA/FTD System Log Messages documentation for message ID ${code} to write a regex that captures its documented fields with named groups.

Rules:
- Return ONLY the regex body (no delimiters, no quotes, no explanation).
- Use JavaScript named capture groups: (?<name>...). It will be applied via _raw.match(regex) in Cribl.
- Base the pattern on the DOCUMENTED message format for %ASA-<sev>-${code}, but make it robust to real-world spacing/variants.
- The regex must match the message BODY as it appears in _raw AFTER the code (start the pattern with the code number, e.g. "${code}:").
- Prefer canonical field names: ${canonicalFields}.
- Make optional/variant parts optional with (?:...)? so the ONE regex matches all documented variants (and any sample lines shown).
- IP groups must allow IPv4 and IPv6: [0-9A-Fa-f.:]+
- If sample lines are provided, the regex MUST also match every one of them.`
    : `You fix a single Cisco ASA/FTD per-message-code extraction regex so it matches REAL sample lines and captures useful fields with named groups.

Rules:
- Return ONLY the regex body (no delimiters, no quotes, no explanation).
- Use JavaScript named capture groups: (?<name>...). It will be applied via _raw.match(regex) in Cribl.
- The regex must match the message BODY as it appears in _raw AFTER the code (start the pattern with the code number, e.g. "${code}:").
- Prefer canonical field names: ${canonicalFields}.
- Make optional trailing/variant parts optional with (?:...)? so the ONE regex matches ALL provided sample lines.
- IP groups must allow IPv4 and IPv6: [0-9A-Fa-f.:]+`;

  const sampleBlock = sampleLines.length
    ? `Real sample lines (full _raw) that must all match and extract fields:\n${sampleLines.slice(0, 8).join('\n')}`
    : `(no sample lines available — derive purely from the documented format for message ID ${code})`;

  const user = `ASA/FTD code: ${code}
Current regex (${isNew ? 'not in lookup' : 'fails or under-matches'}): ${oldRegex || '(none)'}

${sampleBlock}

Return the corrected regex body only.`;

  const text = (await invokeAi(system, user)).trim();
  // Strip accidental code fences / delimiters / quotes.
  let rx = text.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
  rx = rx.replace(/^\/|\/[a-z]*$/g, '').trim();
  if ((rx.startsWith('"') && rx.endsWith('"')) || (rx.startsWith("'") && rx.endsWith("'"))) rx = rx.slice(1, -1);
  if (!rx || rx.length < 5) return null;
  // Sanity: must be a valid JS regex and match at least one sample line.
  try { new RegExp(rx); } catch { return null; }
  return rx;
}

// Core: given a sourcetype and the real sample text, find codes whose lookup
// regex doesn't match (or extracts nothing) and repair them from the samples.
// Returns { file, codeField, content, repaired: [{code, before, after, ...}], persisted }.
// If persist=true, writes the improved rows back to the golden CSV (grows the
// golden standard over time).
export async function healParsingLookup(sourcetype, sampleText, { persist = true } = {}) {
  const spec = parsingLookupFor(sourcetype);
  if (!spec) return null;
  const path = join(GOLDEN_LOOKUPS_PATH, spec.file);
  if (!existsSync(path)) return null;

  const rows = parseCsv(readFileSync(path, 'utf-8'));
  const header = rows[0];
  const dataRows = rows.slice(1);
  const regexByCode = new Map(dataRows.map(r => [r[0], r[1]]));

  // Group sample lines by code.
  const lines = (sampleText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const linesByCode = new Map();
  for (const line of lines) {
    const m = line.match(spec.codeRegex);
    if (!m) continue;
    const code = m[1];
    if (!linesByCode.has(code)) linesByCode.set(code, []);
    linesByCode.get(code).push(line);
  }

  const repaired = [];
  for (const [code, codeLines] of linesByCode) {
    const oldRegex = regexByCode.get(code);
    // Evaluate current coverage: does the existing regex match every sample line
    // for this code and extract >0 fields? Test against _raw (full line).
    let needsFix = false;
    if (!oldRegex) needsFix = true;
    else {
      for (const line of codeLines) {
        const res = jsTest(oldRegex, line);
        if (!res.matched || res.count === 0) { needsFix = true; break; }
      }
    }
    if (!needsFix) continue;

    const isNew = !oldRegex;  // code present in the sample but ABSENT from the lookup
    try {
      const fixed = await repairRegex(code, codeLines, oldRegex, isNew);
      if (!fixed) continue;
      // Verify the fix matches ALL sample lines for this code and beats the old.
      const allMatch = codeLines.every(l => { const r = jsTest(fixed, l); return r.matched && r.count > 0; });
      if (!allMatch) continue;
      regexByCode.set(code, fixed);
      repaired.push({ code, before: oldRegex || null, after: fixed, sampleCount: codeLines.length, added: isNew });
    } catch { /* skip this code */ }
  }

  if (repaired.length === 0) {
    return { file: spec.file, codeField: spec.codeField, content: readFileSync(path, 'utf-8'), repaired: [], persisted: false };
  }

  // Rebuild rows (preserve order, update repaired codes; append new codes).
  const seen = new Set();
  const outRows = [header];
  for (const r of dataRows) {
    outRows.push([r[0], regexByCode.get(r[0]) ?? r[1]]);
    seen.add(r[0]);
  }
  for (const { code } of repaired) {
    if (!seen.has(code)) { outRows.push([code, regexByCode.get(code)]); seen.add(code); }
  }
  const content = serializeCsv(outRows);

  let persisted = false;
  if (persist) {
    try { writeFileSync(path, content); persisted = true; } catch { /* best effort */ }
  }

  return { file: spec.file, codeField: spec.codeField, content, repaired, persisted };
}

// HTTP handler: POST { sourcetype, sampleEvents } → heal + return repaired lookup.
export async function handleHealLookup(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { sourcetype, sampleEvents } = body ? JSON.parse(body) : {};
    if (!sourcetype || !sampleEvents) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Missing sourcetype or sampleEvents' }));
    }
    const result = await healParsingLookup(sourcetype, sampleEvents, { persist: true });
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result || { repaired: [] }));
  } catch (e) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e.message }));
  }
}
