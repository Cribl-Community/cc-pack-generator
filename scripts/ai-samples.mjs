import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_MODEL as MODEL_ID, invokeModel } from './cribl-auth.mjs';
import { withGeneratedSampleCache } from './generated-sample-cache.mjs';
import { writePendingDoc } from './ai-sample-library.mjs';
import { buildAiSampleDoc, buildSampleExtensionPrompt, renderVerificationFeedback, SAMPLE_EXTEND_MAX_TOKENS, sampleExtensionAsk, stripAiReasoning, verifyGeneratedSample } from '../src/sample-library.ts';

// Recorded in each staged sample's provenance so a bad batch can be traced to the
// build that produced it.
const BUILD_NUMBER = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).buildNumber;
  } catch {
    return undefined;
  }
})();

// Clean raw AI output into log-event lines. Models sometimes leak reasoning
// (<|start_of_thought|>…, <thinking>…), a prose preamble ("Here are 100…"),
// markdown fences, or numbered list prefixes. Strip all of that so only real
// event lines reach the sample file. Without this, the pack's parser sees prose
// and extracts nothing → every downstream mapping is empty.
export function cleanSampleText(text) {
  // Reasoning blocks, leftover markers and markdown fences: `stripAiReasoning`
  // (src/sample-library.ts) so the iframe client cleans identically (Hard Rule 18).
  const t = stripAiReasoning(text);

  // MULTI-LINE EVENT REASSEMBLY. The AI often pretty-prints structured events
  // across many lines (JSON objects, XML <Event>…</Event>). A naive split('\n')
  // shreds each event into per-line fragments ('{', '  "k": "v",' …), so the
  // pack's parser sees garbage and every mapping comes back empty (the batch
  // aws_cloudtrail bug: 20 records became 721 line-fragments → score 4). Detect
  // those envelopes and rebuild one event per line BEFORE the line filter.
  const trimmed = t.replace(/^\s+/, '');

  // (a) Concatenated / pretty-printed JSON objects → compact, one per line.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const objs = splitBalanced(t, '{', '}');
    const compact = objs.map(o => { try { return JSON.stringify(JSON.parse(o)); } catch { return null; } }).filter(Boolean);
    if (compact.length > 0) return compact;
  }
  // (b) XML events (Windows etc.) → one <Event>…</Event> (or <record>) per line.
  if (/^<\?xml|^<Event[\s>]|^<record[\s>]/i.test(trimmed)) {
    const xmlEvents = t.match(/<(Event|record)\b[\s\S]*?<\/\1>/gi);
    if (xmlEvents && xmlEvents.length > 0) return xmlEvents.map(e => e.replace(/\n\s*/g, ''));
  }

  const looksLikeEvent = (l) => {
    const s = l.trim();
    if (!s) return false;
    // Real events almost always contain one of these structural signals.
    if (/[=:]\s*\S/.test(s) && /("|=|\||,|\{)/.test(s)) return true; // kvp / json / csv / cef
    if (/^\d{4}-\d{2}-\d{2}|^\w{3}\s+\d+\s+\d/.test(s)) return true;  // leading timestamp
    if (/^[<{[]/.test(s)) return true;                                // json/xml/syslog-pri start
    if (/^\d+\.\d+\.\d+\.\d+/.test(s)) return true;                   // leading IP (vpc flow etc.)
    // Tab-separated values (Zeek/Bro conn.log, TSV exports): multiple TAB-split
    // columns is a strong structural signal even without =/:/quotes. Without
    // this, Zeek lines (leading fractional epoch + TABs) were dropped → 0 events.
    if (s.split('\t').length >= 3) return true;                       // TSV row
    // Leading epoch (10-digit, optional fractional) then whitespace-delimited
    // columns — Zeek conn.log starts `1300475167.096535<TAB>…`.
    if (/^\d{9,10}(?:\.\d+)?\s/.test(s) && /\s\S+\s\S+/.test(s)) return true;
    return false;
  };
  // Drop obvious prose / markers / numbered-list prefixes.
  return t.split('\n')
    .map(l => l.replace(/^\s*\d+[.)]\s+/, '').replace(/^[-*]\s+/, '')) // list prefixes
    .filter(l => l.trim().length > 0)
    .filter(l => !/^<\|?\/?(start_of_thought|end_of_thought|thinking|thought|think)\|?>?$/i.test(l.trim()))
    .filter(looksLikeEvent);
}

// Decide whether the cleaned events are a JSON-family sample. A JSON source
// emits objects/arrays; if the majority of lines start with `{`/`[` we treat the
// whole sample as JSON and hold every kept line to JSON.parse validity. (A single
// stray brace in an otherwise unstructured sample must NOT flip the whole sample
// to JSON mode — hence "majority", not "any".)
function looksLikeJsonSample(lines) {
  if (!lines || !lines.length) return false;
  const jsonish = lines.filter(l => /^\s*[{[]/.test(l)).length;
  return jsonish >= Math.ceil(lines.length / 2);
}

// Validate + repair a cleaned event list. Returns { events, ok, reason }.
//   - empty after cleaning        → ok:false (retry) — catches the sonnet-5 bare
//     `<think>` wrapper that produced ZERO real events (f5:bigip:syslog bug).
//   - JSON-family with bad JSON    → drop the unparseable lines; ok:false ONLY if
//     that leaves fewer than `minEvents` valid events (corelight_first_seen /
//     _known_domains emitted unclosed objects / unquoted IPs → invalid JSON).
// Non-JSON samples are passed through unchanged (text/kvp/CEF/XML validity is not
// something we can cheaply assert here — cleanSampleText's looksLikeEvent already
// gates those).
export function validateSampleEvents(lines, minEvents = 1) {
  const evts = Array.isArray(lines) ? lines : [];
  if (evts.length === 0) return { events: [], ok: false, reason: 'empty' };
  if (looksLikeJsonSample(evts)) {
    const valid = evts.filter(l => { try { JSON.parse(l); return true; } catch { return false; } });
    if (valid.length < Math.min(minEvents, evts.length)) {
      return { events: valid, ok: false, reason: `invalid-json (${valid.length}/${evts.length} parsed)` };
    }
    return { events: valid, ok: true, reason: valid.length < evts.length ? 'dropped-invalid-json' : 'ok' };
  }
  return { events: evts, ok: true, reason: 'ok' };
}

// Rank an attempt so the "best so far" fallback is chosen honestly: clearing the
// syntax gate beats not clearing it, passing verification beats failing it, and
// event count only breaks ties.
function attemptRank(v) {
  const verdict = v.verification?.verdict;
  return (v.ok ? 1e6 : 0) + (verdict === 'pass' ? 2e6 : verdict === 'unverified' ? 1e6 : 0) + v.events.length;
}

// Generate + clean + validate sample events, retrying on a failed gate. This is
// the ONE place both run-mode paths (handleAiSamples) and offline scripts should
// call so the non-empty + JSON-validity gates apply everywhere. On the final
// attempt we return the best cleaned result even if the gate still fails, so the
// caller gets whatever the model produced rather than nothing.
//
// `verify(events)` is an optional second gate — pass `verifyGeneratedSample` to
// hold the events to the sourcetype's real parser. When it fails, its reasons are
// appended to the prompt for the next attempt: the retry used to re-send the
// IDENTICAL prompt, so a model that got the wire format wrong got it wrong again
// three times. Only a `fail` verdict retries; `unverified` means nothing could be
// checked and is not held against the model.
// A generation attempt must be allowed to FAIL without taking the retries with it.
// `await invoke(...)` used to sit outside any try/catch, so `attempts: 3` covered a
// bad answer but not a timeout: the first `AbortSignal.timeout` threw straight past
// the loop. Combined with a 90s ceiling against a call measured at 45-87s
// uncontended, that is what left 39 of 73 batch rows with no sample at all.
//
// Cost is bounded by `budgetMs` (total, across attempts) rather than by attempts
// alone — three 240s attempts would be 12 minutes for one row. A per-attempt signal
// never exceeds what is left of the budget, and a timeout that leaves too little
// budget stops the loop with a truthful reason instead of a silent empty result.
const MIN_ATTEMPT_MS = 20000;

export async function generateValidatedSample({ invoke, systemPrompt, userPrompt, userPromptFor = null, maxTokens = 16000, minEvents = 1, attempts = 3, signalMs = 240000, budgetMs = null, verify = null, feedbackFor = null }) {
  const started = Date.now();
  const deadline = budgetMs ? started + budgetMs : null;
  let best = { events: [], ok: false, reason: 'no-attempt' };
  let feedback = '';
  let timedOut = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const left = deadline ? deadline - Date.now() : Infinity;
    if (left < MIN_ATTEMPT_MS) {
      if (attempt > 1) best.reason = `${best.reason} (no budget left for attempt ${attempt} of ${attempts})`;
      break;
    }
    const attemptMs = Math.min(signalMs, left === Infinity ? signalMs : left);
    const attemptStarted = Date.now();
    let text;
    try {
      // A retry after a TIMEOUT asks for less (`userPromptFor`) — the same
      // recovery `extendThinSample` relies on. Re-sending the identical wide ask
      // just times out again.
      const prompt = userPromptFor ? userPromptFor({ attempt, feedback, timedOut }) : userPrompt + feedback;
      text = await invoke(systemPrompt, prompt, maxTokens, { signal: AbortSignal.timeout(attemptMs) });
    } catch (err) {
      const msg = err?.message || String(err);
      const secs = Math.round((Date.now() - attemptStarted) / 1000);
      timedOut = /abort|timeout|timed out/i.test(msg);
      const failure = { events: [], ok: false, reason: `generation ${timedOut ? 'timed out' : 'failed'} after ${secs}s: ${msg}` };
      if (best.reason === 'no-attempt' || attemptRank(failure) > attemptRank(best)) best = failure;
      continue;
    }
    timedOut = false;
    const cleaned = cleanSampleText(text);
    const v = validateSampleEvents(cleaned, minEvents);
    if (v.ok && verify) {
      const verification = verify(v.events);
      v.verification = verification;
      if (verification.verdict !== 'fail') return v;
      feedback = feedbackFor ? feedbackFor(verification) : '';
      v.reason = `verification-failed: ${(verification.reasons || [])[0] || 'unknown'}`;
    } else if (v.ok) {
      return v;
    }
    if (attemptRank(v) > attemptRank(best)) best = v;
  }
  return best;
}

// Split a string into top-level balanced {…} (or […]) chunks, ignoring braces
// inside JSON string literals. Used to separate concatenated pretty-JSON events.
function splitBalanced(s, open, close) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) { if (depth === 0) start = i; depth++; }
    else if (ch === close) { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

// Render a SampleGrounding object (built client-side from sourcetype
// recognition, passed in the request body) into a prompt block. MIRROR of
// renderSampleGroundingPrompt in src/pack-builder.ts (Hard Rule 18) — keep the
// two in sync so both run modes ground identically.
export function renderGrounding(g) {
  if (!g || typeof g !== 'object') return '';
  const lines = [];
  const product = [g.vendor, g.product].filter(Boolean).join(' ');
  if (product) lines.push(`- Product: ${product}`);
  if (g.logFamily) lines.push(`- Log family: ${g.logFamily}`);
  if (g.formatHint) lines.push(`- REQUIRED wire format (the user confirmed this — emit ONLY this format): ${g.formatHint}`);
  else if (g.logFormat) lines.push(`- Typical wire format: ${g.logFormat}`);
  if (Array.isArray(g.typicalFields) && g.typicalFields.length) {
    lines.push(`- Fields this source commonly emits (use the REAL names): ${g.typicalFields.slice(0, 16).join(', ')}`);
  }
  if (!lines.length) return '';
  return `\nKNOWN FACTS ABOUT THIS SOURCE (from sourcetype recognition — match these exactly):\n${lines.join('\n')}\n`;
}

export async function handleAiSamples(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { sourcetype, count = 100, mode = 'balanced', grounding = null } = JSON.parse(body);

    // A user-confirmed wire format makes the generated events format-specific, so
    // it must be part of the cache key — otherwise a KV request would reuse a
    // previously-cached JSON sample for the same sourcetype.
    const cacheFmt = grounding && grounding.confirmedFormat ? grounding.confirmedFormat : '';
    const response = await withGeneratedSampleCache(
      { source: 'ai', sourcetype, count, mode, format: cacheFmt },
      async () => {

    const systemPrompt = `You are a log generator that produces realistic, diverse sample events. Return ONLY the raw events, one per line. No markdown, no numbering, no explanation.

Requirements for diversity:
- Vary timestamps across a 24-hour window (use recent dates)
- Use diverse IP addresses (mix of internal 10.x, 172.16.x, 192.168.x and external public ranges)
- Include different users/accounts/principals
- Mix different event types, severities, and outcomes (success AND failures)
- Include both routine operations and security-relevant events (suspicious activity, failed logins, policy violations)
- Vary hostnames, interfaces, zones, ports, protocols
- Include edge cases: very large payloads, unusual ports, empty fields, IPv6 addresses
- Make events realistic enough that a SOC analyst would find them plausible
- For structured formats (JSON, XML), maintain valid syntax per event
- CRITICAL: emit EXACTLY ONE EVENT PER LINE. For JSON, use COMPACT single-line JSON (no pretty-printing, no newlines inside an object). For XML, put the whole <Event>…</Event> on one line. A multi-line event breaks the sample.
- Each event should be unique — no two events should be identical patterns with only IPs changed`;

    const formatHints = getFormatHints(sourcetype);
    const groundingBlock = renderGrounding(grounding);

    const promptFor = (n) => `Generate exactly ${n} diverse ${sourcetype} log events.

${formatHints}${groundingBlock}

Return raw events only, one per line. No numbering, no code fences.`;

    // Budget, not a stopwatch. A plain 50-event ask measures 45-87s uncontended on
    // sonnet-5 (probed), so the old 90s per-attempt ceiling failed rows whose
    // generation was on its way — and because the abort threw past the retry loop,
    // `attempts: 3` bought nothing. Now: up to 240s per attempt (what
    // handleAiExtendSample has always allowed), 420s for the row as a whole, and a
    // retry after a timeout asks for HALF as many events so it fits.
    //
    // generateValidatedSample also applies the non-empty gate (bare `<think>`
    // wrapper → 0 events), the JSON-validity gate (unclosed objects / unquoted IPs)
    // and the parser verification, retrying with feedback on each.
    const validated = await generateValidatedSample({
      invoke: (sys, usr, tok, opts) => invokeModel(MODEL_ID, sys, usr, tok, opts),
      systemPrompt,
      userPrompt: promptFor(count),
      userPromptFor: ({ feedback, timedOut }) => promptFor(timedOut ? Math.max(8, Math.ceil(count / 2)) : count) + feedback,
      maxTokens: 16000, minEvents: 1, attempts: 3, signalMs: 240000, budgetMs: 420000,
      verify: events => verifyGeneratedSample(sourcetype, events, { synthetic: true }),
      feedbackFor: renderVerificationFeedback,
    });
    let lines = validated.events;

    // Cribl sample files are capped at 2 MB — trim events if needed
    const MAX_SAMPLE_BYTES = 2_097_152;
    let totalBytes = 0;
    for (let i = 0; i < lines.length; i++) {
      totalBytes += Buffer.byteLength(lines[i], 'utf8') + 1; // +1 for newline
      if (totalBytes > MAX_SAMPLE_BYTES) {
        lines = lines.slice(0, i);
        break;
      }
    }

    // Stage a sample the parser could actually read for review. NOT written into
    // config/ai-samples/ directly — promotion is a human step (`npm run
    // samples:review` / `samples:promote`), so generation never dirties the repo
    // and nothing synthetic reaches git without someone looking at it.
    const verification = validated.verification || null;
    if (verification && verification.verdict !== 'fail' && lines.length > 0) {
      try {
        writePendingDoc(buildAiSampleDoc({
          sourcetype, format: cacheFmt, events: lines, verification,
          provenance: {
            model: MODEL_ID,
            buildNumber: BUILD_NUMBER,
            generatedAt: new Date().toISOString(),
            grounding: groundingBlock ? groundingBlock.trim() : undefined,
          },
        }));
      } catch { /* staging is best-effort — a read-only .cache must not fail generation */ }
    }

        return { events: lines, count: lines.length, verification, reason: validated.reason };
      },
    );

    // A generation that produced ZERO events is a FAILURE, not an empty success.
    // Returning 200 with `{events: []}` made every batch row that hit it report
    // the generic "No sample available — upload a sample file" with no trace of
    // the real cause (39/73 rows in the build-446 batch). Answer 502 with the
    // gate's own reason ('empty' | 'invalid-json (n/m)' | 'verification-failed:
    // …' | 'no-attempt') so the caller can log WHY it has no sample.
    if (!Array.isArray(response?.events) || response.events.length === 0) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        error: `sample generation produced no events (${response?.reason || 'unknown'})`,
        reason: response?.reason || 'unknown',
        sourcetype,
      }));
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Sample generation failed' }));
  }
}

/**
 * Standalone counterpart of `aiExtendSampleEvents` (src/ai-client.ts): turn a
 * thin REAL sample into more events of the same shape.
 *
 * This handler deliberately does NOT decide what is usable — it returns raw
 * candidate lines and `src/api.ts` runs `guardExtendedEvents` on them, so both run
 * modes share ONE guard implementation (Hard Rule 18). Caching is the caller's job
 * too (api.ts keys the cache on the real lines' fingerprint).
 */
export async function handleAiExtendSample(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const { sourcetype, events = [], want = 20, ask: askIn, maxTokens: tokensIn, feedback = '' } = JSON.parse(body);
    const real = (Array.isArray(events) ? events : []).map(e => String(e || '').trim()).filter(Boolean);
    if (!sourcetype || real.length === 0) throw new Error('sourcetype and at least one real event are required');
    // The ask/budget plan comes from the caller (`sampleExtensionAttempts`) so both run
    // modes obey one policy; `want` is only a fallback for a caller that sends neither.
    const ask = Math.max(1, Math.min(40, Number(askIn) || sampleExtensionAsk(want, real)));
    const maxTokens = Math.min(SAMPLE_EXTEND_MAX_TOKENS, Number(tokensIn) || SAMPLE_EXTEND_MAX_TOKENS);

    const { systemPrompt, userPrompt } = buildSampleExtensionPrompt(sourcetype, real, ask, feedback);
    // Measured 54-180s+ for a 4-16 line ask on sonnet-5, with wide variance for the same
    // input (thycotic_ss: 90s once, over 180s the next time) — most of it thinking, not
    // text. 180s was clipping answers that were on their way, so allow 240s; a timeout
    // still degrades safely to the real sample in api.ts, and the caller retries once.
    const text = await invokeModel(MODEL_ID, systemPrompt, userPrompt, maxTokens, { signal: AbortSignal.timeout(240000) });
    const candidates = cleanSampleText(text).slice(0, ask);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ candidates, model: MODEL_ID }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Sample extension failed' }));
  }
}

export function getFormatHints(sourcetype) {
  const hints = {
    cisco_asa: `Format: Syslog with ASA message IDs. Example:
Jun 25 14:23:01 fw-01 %ASA-6-302013: Built inbound TCP connection 54321 for outside:203.0.113.50/443 (203.0.113.50/443) to inside:10.1.2.100/52341 (10.1.2.100/52341)
Include diverse message IDs: 302013/302014 (built/teardown), 106023 (deny), 106100 (access-list), 305011 (NAT), 710003 (denied), 113019 (session disconnect), 722022/722023 (VPN), 419001 (duplicate), 733100 (drop rate). Mix severities 1-7. Include both inbound/outbound, different interfaces (outside, inside, dmz, management). Vary connection types, durations, byte counts.`,

    cisco_firepower: `Format: Syslog with SFIMS prefix. Example:
Jun 25 10:15:33 fmc-01 SFIMS: Protocol: TCP, SrcIP: 198.51.100.22, DstIP: 10.0.1.50, SrcPort: 49152, DstPort: 443, Policy: IPS_Policy, AccessControlRuleName: Block_Malware, AccessControlRuleAction: Block
Include intrusion events, malware events, connection events, file events. Mix Allow/Block/Monitor/Trust. Vary impact flags, app protocols, URLs, user agents.`,

    palo_alto_traffic: `Format: Comma-separated PAN-OS traffic log with 60+ fields. Example:
1,2026/06/25 08:45:12,001234567890,TRAFFIC,end,2816,...
Include: start/end/drop/deny sessions. Vary zones (trust/untrust/dmz/guest), apps (web-browsing/ssl/dns/ms-office365/youtube), rules, NAT, threat categories. Mix session durations from milliseconds to hours.`,

    palo_alto_threat: `Format: PAN-OS threat log, comma-separated. Include: vulnerability, spyware, virus, wildfire-virus, url-filtering types. Mix severities critical/high/medium/low. Vary threat IDs, actions (alert/drop/reset-both/block-url). Include real-looking threat names.`,

    fortinet_fortigate: `Format: Key=value pairs. Example:
date=2026-06-25 time=14:23:01 devname="FGT-01" devid="FG100E0000000001" logid="0000000013" type="traffic" subtype="forward" level="notice" vd="root" srcip=10.1.2.50 srcport=49152 dstip=203.0.113.100 dstport=443 action="accept"
Include: traffic/utm/event log types. Mix subtypes (forward/local/multicast). Vary policies, users, services, interfaces (port1-port10, wan1/wan2). Include app control, IPS, web filter events.`,

    checkpoint_firewall: `Format: Syslog with key="value" pairs. Example:
Jun 25 09:12:45 gw-01 product="VPN-1 & FireWall-1" action="Accept" orig=gw-01 src=10.1.1.50 dst=203.0.113.22 proto="tcp" s_port="50123" service="443"
Include: Accept/Drop/Reject/Log. Mix SmartDefense/VPN/IPS/anti-malware products. Vary rules 1-50, include NAT translations (xlatesrc/xlatedst), VPN peers, user identities, blade names.`,

    windows_powershell: `Format: XML Event Log. Include EventIDs: 4103 (module logging), 4104 (script block), 4105/4106 (script start/stop), 600 (provider start), 800 (pipeline execution). Mix Level 3 (warning), 4 (info), 5 (verbose). Include diverse ScriptBlockText: benign admin scripts, suspicious patterns (Invoke-Mimikatz, DownloadString, EncodedCommand, bypass, -enc), module imports, profile loading, WMI queries, AD queries, file operations. Vary hosts, users, SIDs.`,

    windows_security: `Format: XML Event Log. Include diverse EventIDs: 4624/4625 (logon success/fail), 4634 (logoff), 4648 (explicit creds), 4672 (special privileges), 4688 (process creation), 4720/4726 (user create/delete), 4732 (group membership), 5156/5157 (WFP), 4768/4769 (Kerberos TGT/TGS). Vary LogonTypes: 2 (interactive), 3 (network), 7 (unlock), 10 (remote), 11 (cached). Include diverse IPs, workstations, failure codes (0xC000006D bad password, 0xC0000234 locked, 0xC000006A bad password).`,

    windows_sysmon: `Format: XML Event Log with Sysmon provider. Include EventIDs: 1 (process create), 3 (network), 5 (process term), 7 (image load), 8 (CreateRemoteThread), 10 (ProcessAccess), 11 (file create), 12/13 (registry), 22 (DNS). Include MITRE technique_id in RuleName (T1059, T1055, T1003, T1547, T1070). Mix suspicious and benign processes. Vary parents (explorer→cmd, winword→powershell, svchost→rundll32).`,

    f5_bigip: `Format: F5 BIG-IP LTM/TMM syslog (RFC3164 with an optional <priority>). Example:
<134>Jan 15 08:23:41 bigip-lb01 notice tmm1[12345]: 01260013:5: Pool /Common/web-pool-01 member /Common/10.20.30.15:443 monitor status down.
Emit diverse BIG-IP message IDs and modules: tmm (01260013 pool member status, 01260009 SSL, 011f0005 connection), mcpd (01070727 node/pool status, 01071681 pool member state), bigd (health monitor status), tmsh audit (014f0005 admin config change), APM/Access (01490500 session, 0149000e login), ASM/WAF (violation, blocked request), syslog-ng. Include severities notice/warning/err/info. Vary virtual servers (/Common/vs_*), pools, nodes, client/server IPs and ports, SSL handshake success/failure, LB decisions, config changes by admin users. One event per line.`,

    sap_audit: `Format: SAP Security Audit Log (SM20/SAL) as space-delimited KEY=value pairs with a quoted TEXT message. Example:
DATE=2026-06-25 TIME=14:23:01 MANDT=100 USER=JDOE TCODE=SU01 REPORT=SAPMSYST MSGID=AU2 MSGNO=1 CLASS=A TEXT="Logon failed (reason=1, type=A, method=A)" HOST=sapprd01 TERMINAL=10.20.30.15 SUNAME=JDOE CLIENT=100
Emit these exact UPPERCASE keys: DATE (YYYY-MM-DD), TIME (HH:MM:SS), MANDT/CLIENT (3-digit client e.g. 100/200), USER + SUNAME (same SAP user id, uppercase), TCODE (transaction e.g. SU01/SE38/PFCG/VA01/SM37, may be empty for RFC), REPORT (ABAP program e.g. SAPMSYST), MSGID (audit class AU1/AU2/AU3/AU5/AU6/AU9/AUK), MSGNO, CLASS (A=alert, E=error, W=warning, U=uncritical), TEXT (quoted human-readable message), HOST (SAP app server hostname), TERMINAL (client IP or workstation name). Include diverse events: logon success (AU1) and failure (AU2), transaction start (AU3), user lock/admin (AU6), authorization-check failure (AU9), RFC call (AUK), report/batch termination (AU5, CLASS=E). One event per line. Do NOT emit syslog or SSH lines.`,

    linux_syslog: `Format: RFC3164 syslog. Example:
Jun 25 14:23:01 web-01 sshd[12345]: Accepted publickey for admin from 198.51.100.50 port 52341 ssh2
Include diverse daemons: sshd, sudo, cron, systemd, kernel, NetworkManager, postfix, named, dockerd, nginx, httpd. Mix auth success/failure, session open/close, cron jobs, systemd unit changes, kernel panics, OOM kills, UFW blocks, disk errors, service restarts.`,

    linux_audit: `Format: type=TYPE msg=audit(timestamp:serial): key=value pairs. Include types: SYSCALL, EXECVE, CWD, PATH, USER_AUTH, USER_LOGIN, USER_CMD, AVC, NETFILTER_PKT, CRYPTO_KEY_USER, SERVICE_START. Mix success/failure. Vary syscalls, executables, audit keys (exec, priv, access, login, delete). Include SELinux AVC denials.`,

    crowdstrike_falcon: `Format: JSON. Include event_types: DetectionSummaryEvent, AuthActivityAuditEvent, UserActivityAuditEvent, IncidentSummaryEvent. Mix severities Critical/High/Medium/Low. Include diverse MITRE techniques, file hashes, process trees, network connections. Vary detection names realistically.`,

    aws_cloudtrail: `Format: JSON CloudTrail event. Include diverse eventNames: ConsoleLogin, AssumeRole, CreateUser, PutBucketPolicy, RunInstances, AuthorizeSecurityGroupIngress, CreateAccessKey, DeleteTrail, PutRolePolicy, ModifyDBInstance. Mix IAMUser/AssumedRole/AWSService types. Include errorCode/errorMessage for failures (AccessDenied, UnauthorizedAccess). Vary regions, user agents (console, cli, sdk).`,

    alibaba_action_trail: `Format: Alibaba Simple Log Service JSON envelope consumed by the Cortex XSIAM AlibabaActionTrail content pack. Every event MUST have this exact outer shape: {"__time__":"<epoch-seconds>","__topic__":"actiontrail_audit_event","event":{...}}. Put ActionTrail fields INSIDE event, never at the root. Required nested fields: event.eventType, event.eventId, event.eventName, event.eventTime, event.acsRegion, event.sourceIpAddress, and event.userIdentity. Include ApiCall, ConsoleOperation, AliyunServiceEvent, PasswordReset, ConsoleSignin, and ConsoleSignout. Keep each complete envelope as compact single-line JSON.`,

    aws_vpc_flow: `Format: Space-separated VPC flow log v2. Example:
2 123456789012 eni-abc12345 198.51.100.50 10.0.1.100 49152 443 6 25 15000 1719300000 1719300300 ACCEPT OK
Include ACCEPT and REJECT. Mix protocols: 6 (TCP), 17 (UDP), 1 (ICMP). Vary packet counts and byte sizes. Include common ports (22, 53, 80, 443, 3389, 8080) and unusual ones (4444, 6667, 9001). Mix ENI IDs.`,

    zeek_conn: `Format: Zeek (Bro) conn.log — TAB-separated values, ONE event per line, NO header lines. Column order:
ts	uid	id.orig_h	id.orig_p	id.resp_h	id.resp_p	proto	service	duration	orig_bytes	resp_bytes	conn_state	local_orig	local_resp	missed_bytes	history	orig_pkts	orig_ip_bytes	resp_pkts	resp_ip_bytes	tunnel_parents
Example (tabs between every field):
1300475167.096535	CHhAvVGS1DHFjwGM9	141.142.220.202	5353	224.0.0.251	5353	udp	dns	0.000000	0	0	S0	-	-	0	D	1	73	0	0	-
ts is a fractional epoch. Use a Zeek connection uid like CHhAvVGS1DHFjwGM9. Vary proto (tcp/udp/icmp), service (dns/http/ssl/ssh/-), conn_state (S0/SF/REJ/RSTO/S1/OTH), history flags (ShADadFf/D/Dd), byte/packet counts. Use '-' for empty fields. Separate EVERY field with a literal TAB character, not spaces.`,

    azure_signin: `Format: JSON Azure AD sign-in log. Include both success (errorCode 0) and failures (50126 InvalidPassword, 50076 MfaRequired, 53003 ConditionalAccess, 50053 AccountLocked, 50057 DisabledAccount). Mix apps (O365, Teams, Azure Portal, SharePoint, Power BI). Vary locations/countries, device types, client apps (Browser, Desktop, Mobile), risk levels. Include MFA challenge events.`,

    gcp_audit: `Format: JSON Cloud Audit Log. Include diverse methods: compute.instances.insert/delete, storage.buckets.create/delete, iam.serviceAccounts.create, bigquery.datasets.delete, cloudresourcemanager.projects.setIamPolicy. Mix severities INFO/WARNING/ERROR. Include status codes (0=OK, 3=INVALID_ARGUMENT, 7=PERMISSION_DENIED). Vary service accounts and user agents.`,

    okta_system: `Format: JSON Okta System Log. Include eventTypes: user.session.start, user.authentication.sso, user.mfa.factor.activate/deactivate, policy.evaluate_sign_on, user.account.lock/unlock, application.user_membership.add/remove, system.api_token.create, user.lifecycle.suspend. Mix outcomes SUCCESS/FAILURE/SKIPPED. Vary actors, clients (browser, API, mobile), geographies.`,

    zscaler_web: `Format: JSON. Include diverse actions: Allowed, Blocked, Cautioned, Isolated. Mix URL categories: Malware, Phishing, Adult, Gambling, Social Networking, Cloud Storage, Business. Vary departments, risk scores 0-100, request/response sizes, DLP rule triggers, threat names.`,

    apache_access: `Format: Combined Log Format. Example:
198.51.100.50 - admin [25/Jun/2026:14:23:01 +0000] "GET /api/v1/users HTTP/1.1" 200 4523 "https://app.example.com/" "Mozilla/5.0..."
Mix methods (GET/POST/PUT/DELETE/OPTIONS/HEAD), status codes (200/201/301/400/401/403/404/500/502/503), paths (APIs, static, health, admin), user agents (Chrome, Firefox, curl, bot, scanner). Include slowloris patterns, path traversal attempts, SQL injection in query strings.`,

    nginx_access: `Format: Extended Nginx log with upstream timing. Include response times from 0.001 to 30.000s. Mix HTTP/1.1 and HTTP/2.0. Include upstream response times, 502/503 errors with upstream timeouts, WebSocket upgrades, gRPC calls. Vary server blocks and upstreams.`,
  };

  return hints[sourcetype] || `Format: Generate realistic ${sourcetype} log events in their standard format. Mix different event types, severities, and outcomes. Include both normal operations and security-relevant events.`;
}
