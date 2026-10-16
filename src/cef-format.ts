// CEF wire-format checker — the syntactic analogue of src/ocsf-schema.ts.
//
// Unlike OCSF (a published JSON *schema* we grade semantic conformance against),
// CEF is a *wire format*: `CEF:Version|Vendor|Product|Version|SignatureID|Name|
// Severity|key=value key=value …`. So this checker validates SYNTAX — the header
// structure, the severity range, extension well-formedness and escaping — plus a
// static CEF key DICTIONARY (the ArcSight standard extension keys), which is the
// direct analogue of OCSF's enum/type check.
//
// Design (see scoreAuthoritative in pack-builder.ts): a CEF checker must NOT
// replace the value-coverage score the way the OCSF oracle does. CEF validity is
// ORTHOGONAL to coverage — a perfectly-formed CEF can carry no source values, and
// coverage is what measures "did the source's values reach the extension". So this
// audit is a CORRECTNESS CAP + findings (like ocsfEnvelopeAudit): a malformed CEF
// caps the score into a lower band; a well-formed CEF never inflates it.
//
// AI-free and dependency-free by construction (string parsing + a static
// dictionary only), so importing it into pack-builder drags nothing in.

// The ArcSight CEF Implementation Standard's predefined extension keys (the short
// "key" forms that appear in `_raw`, not the full names). Custom keys (cs1,
// cs1Label, cn1, flexString1, deviceCustom*) are ALLOWED by the spec and handled
// by pattern below — they are not listed here. Non-standard, non-custom keys are
// reported as advisory (a SIEM keeps them, but they are not dictionary members).
const CEF_STANDARD_KEYS = new Set<string>([
  // Network / transport
  'src', 'dst', 'spt', 'dpt', 'proto', 'app', 'in', 'out', 'smac', 'dmac',
  'sourceTranslatedAddress', 'destinationTranslatedAddress',
  'sourceTranslatedPort', 'destinationTranslatedPort',
  'sourceMacAddress', 'destinationMacAddress', 'transportProtocol',
  'applicationProtocol', 'bytesIn', 'bytesOut',
  // Hosts / zones
  'shost', 'dhost', 'dvc', 'dvchost', 'deviceInboundInterface', 'deviceOutboundInterface',
  'sourceHostName', 'destinationHostName', 'deviceAddress', 'deviceHostName',
  'sntdom', 'dntdom', 'sourceNtDomain', 'destinationNtDomain', 'dvcpid',
  'sourceZoneURI', 'destinationZoneURI', 'deviceZoneURI',
  // Identity / user
  'suser', 'duser', 'suid', 'duid', 'sourceUserName', 'destinationUserName',
  'sourceUserId', 'destinationUserId', 'sourceUserPrivileges', 'destinationUserPrivileges',
  // Event / action
  'act', 'msg', 'reason', 'outcome', 'cat', 'request', 'requestMethod',
  'requestClientApplication', 'requestContext', 'requestCookies',
  'deviceAction', 'message', 'deviceEventCategory', 'deviceEventClassId',
  'externalId', 'cnt', 'dpriv',
  // File
  'fname', 'fsize', 'filePath', 'fileType', 'fileId', 'fileHash',
  'fileCreateTime', 'fileModificationTime', 'oldFileName', 'oldFilePath',
  'oldFileSize', 'oldFileHash', 'fileName',
  // Time
  'rt', 'start', 'end', 'art', 'deviceReceiptTime', 'startTime', 'endTime',
  'agentReceiptTime', 'deviceCustomDate1', 'deviceCustomDate2',
  // Device / agent
  'dvcpid', 'deviceProcessName', 'sproc', 'dproc', 'sourceProcessName',
  'destinationProcessName', 'spid', 'dpid', 'sourceProcessId', 'destinationProcessId',
  'ahost', 'aid', 'agt', 'av', 'at', 'atz', 'agentHostName', 'agentAddress',
  'agentVersion', 'agentType', 'agentZoneURI', 'agentTimeZone',
  'deviceVersion', 'deviceProduct', 'deviceVendor', 'deviceFacility',
  'deviceDnsDomain', 'deviceExternalId', 'devicePayloadId', 'deviceTimeZone',
  'dtz', 'customerURI', 'customerExternalID',
  'dvcmac', 'smac', 'dmac', 'c6a1', 'c6a2', 'c6a3', 'c6a4',
]);

// Valid string severities (case-insensitive) alongside the numeric 0–10 scale.
const CEF_SEVERITY_WORDS = new Set(['unknown', 'low', 'medium', 'high', 'very-high']);

// Custom-extension key patterns the spec explicitly reserves (any suffix index):
//   csN / csNLabel (string), cnN / cnNLabel (number), cfpN (float), cN (deprecated),
//   flexStringN / flexNumberN / flexDateN (+ Label), deviceCustom* (long forms),
//   c6aN (IPv6). These are legal, not dictionary members.
const CEF_CUSTOM_KEY = /^(?:cs\d+(?:Label)?|cn\d+(?:Label)?|cfp\d+(?:Label)?|c\d+(?:Label)?|flexString\d+(?:Label)?|flexNumber\d+(?:Label)?|flexDate\d+(?:Label)?|deviceCustom\w+|c6a\d+(?:Label)?)$/;

export interface CefEventCheck {
  ok: boolean;
  reasons: string[];        // why this event is not valid CEF (empty when ok)
  extKeys: string[];        // extension keys parsed from this event
}

export interface CefFormatAudit {
  applicable: boolean;      // there were events to grade (caller only audits CEF dests)
  totalEvents: number;
  validEvents: number;      // structurally valid CEF events
  score: number;            // round(100 * validEvents/total) — dictionary does NOT affect this
  band: 'good' | 'warn' | 'fail';
  malformed: string[];      // distinct structural problems across events (for findings)
  unknownKeys: string[];    // extension keys not in the dictionary and not custom (advisory)
  reasons: string[];        // human-readable summary lines
  checks: {
    headerValid: number; severityValid: number; extensionValid: number;
    escapingValid: number; checked: number;
  };
}

function bandFor(score: number): 'good' | 'warn' | 'fail' {
  return score >= 85 ? 'good' : score >= 60 ? 'warn' : 'fail';
}

// Split a CEF line into its (≤7) header pipes + extension, honouring `\|` escapes.
// Returns { header: string[7 fields incl. `CEF:v`], extension: string } or null if
// the `CEF:` prefix is absent. header may have <8 entries when the line is broken.
function splitCef(raw: string): { header: string[]; extension: string } | null {
  if (!raw.startsWith('CEF:')) return null;
  const header: string[] = [];
  let field = '';
  let i = 0;
  const n = raw.length;
  // Collect exactly 7 pipe-delimited fields (CEF:v | vendor | product | version |
  // sigid | name | severity), then the remainder is the extension verbatim.
  while (i < n) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < n) { field += ch + raw[i + 1]; i += 2; continue; }
    if (ch === '|') {
      header.push(field);
      field = '';
      i++;
      if (header.length === 7) return { header, extension: raw.slice(i) };
      continue;
    }
    field += ch;
    i++;
  }
  header.push(field);            // no extension pipe seen — whole line was header
  return { header, extension: '' };
}

// Parse a CEF extension string into key=value pairs, honouring `\=` / `\\` escapes.
// CEF keys are alphanumeric tokens; a new pair starts at ` key=`. Returns the keys
// found and whether the extension was well-formed (no stray tokens, no empty keys).
function parseExtension(ext: string): { keys: string[]; wellFormed: boolean; escapingOk: boolean } {
  const trimmed = ext.trim();
  if (!trimmed) return { keys: [], wellFormed: true, escapingOk: true };
  const keys: string[] = [];
  let wellFormed = true;
  let escapingOk = true;
  // Find each `<key>=` boundary. A key is [A-Za-z][A-Za-z0-9]* immediately before
  // an unescaped `=`, preceded by start-of-string or whitespace.
  const keyRe = /(^|\s)([A-Za-z][A-Za-z0-9]*)=/g;
  const boundaries: { key: string; valueStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(trimmed)) !== null) {
    boundaries.push({ key: m[2], valueStart: m.index + m[0].length });
  }
  if (!boundaries.length) return { keys: [], wellFormed: false, escapingOk: true };
  // Anything before the first key= that is non-whitespace is a stray/malformed lead.
  if (trimmed.slice(0, boundaries[0].valueStart - boundaries[0].key.length - 1).trim() !== '') wellFormed = false;
  for (let b = 0; b < boundaries.length; b++) {
    keys.push(boundaries[b].key);
    const valEnd = b + 1 < boundaries.length
      ? boundaries[b + 1].valueStart - boundaries[b + 1].key.length - 1
      : trimmed.length;
    const value = trimmed.slice(boundaries[b].valueStart, valEnd);
    // A bare unescaped `=` inside a value is legal in practice but a lone `\`
    // not followed by an escapable char signals broken escaping.
    if (/\\(?![\\=|n r])/.test(value)) escapingOk = false;
  }
  return { keys, wellFormed, escapingOk };
}

/** Validate ONE event's `_raw` as a CEF line. */
export function checkCefEvent(event: any): CefEventCheck {
  const reasons: string[] = [];
  const raw = event && typeof event._raw === 'string' ? event._raw : '';
  if (!raw) return { ok: false, reasons: ['event has no _raw string'], extKeys: [] };

  const split = splitCef(raw);
  if (!split) return { ok: false, reasons: ['missing the CEF: prefix'], extKeys: [] };
  const { header, extension } = split;

  // Prefix + integer version.
  const pfx = /^CEF:(\d+)$/.exec(header[0] || '');
  if (!pfx) reasons.push('CEF: prefix has no integer version');

  // Exactly 7 header fields (so 8 segments incl. the version segment).
  if (header.length < 7) reasons.push(`header has ${header.length} field(s), CEF requires 7 before the extension`);

  // Mandatory non-empty headers: vendor(1) product(2) version(3) sigid(4) name(5) severity(6).
  const HEAD_NAMES = ['version', 'DeviceVendor', 'DeviceProduct', 'DeviceVersion', 'SignatureID', 'Name', 'Severity'];
  for (let h = 1; h <= 6 && h < header.length; h++) {
    if (!header[h] || header[h].trim() === '') reasons.push(`mandatory header ${HEAD_NAMES[h]} is empty`);
  }

  // Severity: integer 0–10, or a valid severity word.
  const sev = (header[6] ?? '').trim();
  if (sev !== '') {
    const asNum = Number(sev);
    const numOk = Number.isInteger(asNum) && asNum >= 0 && asNum <= 10;
    const wordOk = CEF_SEVERITY_WORDS.has(sev.toLowerCase());
    if (!numOk && !wordOk) reasons.push(`severity "${sev}" is not 0–10 or Low/Medium/High/Very-High/Unknown`);
  }

  // Extension well-formedness + escaping.
  const ext = parseExtension(extension);
  if (!ext.wellFormed) reasons.push('extension is not well-formed key=value');
  if (!ext.escapingOk) reasons.push('extension has broken backslash escaping');

  return { ok: reasons.length === 0, reasons, extKeys: ext.keys };
}

/**
 * Audit a batch of CEF output events. Score = fraction of structurally valid CEF
 * events × 100 (dictionary membership is advisory and does NOT change the score).
 * The caller (scoreAuthoritative) only invokes this for a CEF destination, so
 * `applicable` is simply "there were events".
 */
export function auditCefFormat(outputEvents: any[]): CefFormatAudit {
  const events = (outputEvents || []).filter(e => e && typeof e === 'object' && !Array.isArray(e));
  const na: CefFormatAudit = {
    applicable: false, totalEvents: 0, validEvents: 0, score: 0, band: 'fail',
    malformed: [], unknownKeys: [], reasons: [],
    checks: { headerValid: 0, severityValid: 0, extensionValid: 0, escapingValid: 0, checked: 0 },
  };
  if (!events.length) return na;

  let valid = 0;
  const malformed = new Set<string>();
  const unknown = new Set<string>();
  const checks = { headerValid: 0, severityValid: 0, extensionValid: 0, escapingValid: 0, checked: 0 };

  for (const ev of events) {
    checks.checked++;
    const r = checkCefEvent(ev);
    if (r.ok) valid++;
    for (const reason of r.reasons) malformed.add(reason);
    // Sub-check tallies (for the summary line).
    if (!r.reasons.some(x => /header|prefix/.test(x))) checks.headerValid++;
    if (!r.reasons.some(x => /severity/.test(x))) checks.severityValid++;
    if (!r.reasons.some(x => /well-formed/.test(x))) checks.extensionValid++;
    if (!r.reasons.some(x => /escaping/.test(x))) checks.escapingValid++;
    // Dictionary: keys neither standard nor a legal custom form → advisory.
    for (const k of r.extKeys) {
      if (!CEF_STANDARD_KEYS.has(k) && !CEF_CUSTOM_KEY.test(k)) unknown.add(k);
    }
  }

  const score = Math.round(100 * valid / events.length);
  const unknownKeys = [...unknown];
  const reasons: string[] = [];
  if (valid < events.length) {
    const eg = [...malformed].slice(0, 4).join('; ');
    reasons.push(`${events.length - valid}/${events.length} events are not valid CEF${eg ? ` (${eg})` : ''} — a SIEM/ArcSight collector rejects malformed CEF.`);
  }
  if (unknownKeys.length) {
    reasons.push(`${unknownKeys.length} extension key(s) are not CEF-standard or custom (csN/cnN/…): ${unknownKeys.slice(0, 8).join(', ')}${unknownKeys.length > 8 ? '…' : ''} — map to a dictionary key or a labelled custom field.`);
  }
  if (!reasons.length) {
    reasons.push(`Valid CEF: ${valid}/${events.length} events have a well-formed CEF:0|…| header, in-range severity and well-formed extension.`);
  }

  return {
    applicable: true,
    totalEvents: events.length,
    validEvents: valid,
    score,
    band: bandFor(score),
    malformed: [...malformed],
    unknownKeys,
    reasons,
    checks,
  };
}
