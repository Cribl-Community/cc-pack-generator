import{dn as e,i as t,l as n,n as r,u as i}from"./sanitizer-core-D6Ixk8q3.js";import{mn as a,nn as o,pn as s,vn as c,yn as l}from"./ai-core-DAo_jnS1.js";import{f as u}from"./main-L25ncTmr.js";import d from"./golden-pipelines-DTPexGtI.js";import{t as f}from"./samples-pool-index-GxD56PE8.js";import{n as p,r as m,t as h}from"./doc-shell-CPA9elWS.js";function g(){let t=i.global||{},a=f.samples||[],o=d.pipelines||{},c=Object.keys(o).filter(e=>!e.startsWith(`_`)),p=0,m=0,h=0,g=new Set,_=new Set;for(let e of c){e.includes(`__extraction__`)?p++:e.includes(`__mapping__`)?m++:h++;let t=e.split(`::`);t[0]&&g.add(u(t[0])),t[1]&&!t[1].startsWith(`__`)&&_.add(t[1])}let v=e.parsers||{},y=Array.isArray(v)?v:Object.values(v),b=0,x=0,S=0;for(let e of y){let t=e&&e.dataFormat||``;t===`raw`?b++:t===`delimited`?x++:t===`kvp`&&S++}let C=l.formats||{},w=Object.keys(C),T=new Set,E=0,D=0;for(let e of w)T.add(e.split(`#`)[0]),e.startsWith(`asim#`)&&E++,e.startsWith(`ocsf#`)&&D++;return{goldenTotal:c.length,goldenFull:h,goldenExtraction:p,goldenMapping:m,goldenSourcetypes:g.size,goldenFormats:_.size,searchParsers:y.length,searchRaw:b,searchDelimited:x,searchKvp:S,formatSpecs:w.length,formatFamilies:T.size,asimSchemas:E,ocsfClasses:D,sourceSamples:Object.keys(s).length,vendorSamples:a.length,vendorVerified:a.filter(e=>e.confidence===`verified`).length,vendorAtFloor:a.filter(e=>(e.events||0)>=10).length,vendorMerged:a.filter(e=>(e.fixtures||1)>1).length,vendorEvents:a.reduce((e,t)=>e+(t.events||0),0),secretFields:(t.secretFields||[]).length,piiFields:(t.piiFields||[]).length,suspectFields:(t.suspectFields||[]).length,vocabularyFields:(t.neverReplaceFields||[]).length,secretRules:n(r.items||[]).rules.length,secretRulesTotal:(r.items||[]).length}}var _=g(),v=934,y=Object.keys(c.tables||{}).length,b=(()=>{let e=o.models||o;return Array.isArray(e)?e.length:Object.keys(e).length})(),x=Object.keys(a.sources||{}).length,S=((l.formats||{}).cef?.extension||[]).length,C=`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pack Generator — Technical reference</title>
<style>${h}</style></head><body>
<div class="page">
  <header>
    <div>
      <h1>Pack Generator — <span>Technical reference</span></h1>
      <div class="sub">How a source becomes a scored pipeline: recognition, samples, sanitising, the candidate sequence, mapping per format, and how every score is calculated.</div>
    </div>
    <div class="tools" id="tools">
      <button type="button" id="dl">⤓ Download</button>
      <button type="button" id="pr">🖨 Print / PDF</button>
    </div>
    <div class="badge">Technical</div>
  </header>
  <p class="xref">New to Pack Generator? The ${p(`guide`,`User guide`)} explains how to use each mode and tool, step by step. This document explains how the results are produced.</p>

  <div class="toc" id="contents">
    <b>Contents</b>
    <ol>
      <li><a href="#ch1">The three stages, and a source seen for the first time</a></li>
      <li><a href="#ch2">Sourcetype recognition</a></li>
      <li><a href="#ch3">Where the sample comes from</a></li>
      <li><a href="#ch4">Sanitising the sample</a></li>
      <li><a href="#ch5">The resolution sequence — golden → Search → schematizer → AI</a></li>
      <li><a href="#ch6">Extraction &amp; mapping, and every export format tile by tile</a>
        <ul class="fmts">
          <li><a href="#fmt-nextgen">CrowdStrike NG SIEM</a></li>
          <li><a href="#fmt-ocsf">OCSF 1.9</a></li>
          <li><a href="#fmt-cef">CEF</a></li>
          <li><a href="#fmt-sentinel">Sentinel</a></li>
          <li><a href="#fmt-cim">Splunk CIM</a></li>
          <li><a href="#fmt-ecs">Elastic ECS</a></li>
          <li><a href="#fmt-asim">ASIM</a></li>
          <li><a href="#fmt-chronicle">Chronicle UDM</a></li>
          <li><a href="#fmt-xsiam">Cortex XSIAM</a></li>
          <li><a href="#fmt-passthrough">Passthrough (raw copy)</a></li>
          <li><a href="#fmt-json">Clean JSON</a></li>
        </ul>
      </li>
      <li><a href="#ch7">How scoring works — value coverage, stage checks, caps &amp; the deployment score</a></li>
      <li><a href="#ch8">Knowledge-base stats</a></li>
    </ol>
    <p style="margin:8px 0 0;font-size:12px"><a href="#release-notes">Release notes</a> — what changed, by build.</p>
  </div>

  <!-- ============================ CHAPTER 1 ============================ -->
  <section class="chap" id="ch1">
    <div class="chap-h"><div class="chap-n">1</div><div class="chap-t">The three stages</div></div>
    <p>A pipeline is built in <b>three stages</b>. Each is scored on its own job, so a weak stage cannot hide behind a strong one.</p>
    <div class="stages">
      <div class="stage ex"><div class="sh">1 · Extraction</div><div class="sb"><b>Pull the values out of <code>_raw</code></b> into named fields (<code>src_ip</code>, <code>query_name</code>…) with a serde, a regex chain or a stock parser.</div></div>
      <div class="stage mp"><div class="sh">2 · Mapping</div><div class="sb"><b>Land those fields in the destination schema</b> (OCSF, CIM, ECS, ASIM, CEF, Sentinel, Chronicle…) and set <code>_time</code>, severity and class ids.</div></div>
      <div class="stage op"><div class="sh">3 · Output shaping</div><div class="sb"><b>Enforce the destination envelope.</b> Compact the payload and strip scratch (<code>__</code>) fields while protecting what mapping produced. No event suppression here.</div></div>
    </div>

    <h2><span class="d"></span>A source seen for the first time</h2>
    <p>When a sourcetype has no stored golden and no built-in parser, the app reads the <b>sample content</b> before it asks the AI, so the first pack is already right:</p>
    <ol class="steps">
      <li><b>Schema class from the sample, not the name.</b> The OCSF class, CIM data model or ASIM schema is inferred from what the sample contains (<code>effectiveDataClass</code> → <code>inferDataClass</code>). A correctly-labelled source is only overruled when the sample disagrees strongly: higher confidence and <b>two distinct signals</b> for the winning class. One incidental field (a <code>url</code> on a firewall line) cannot flip it.</li>
      <li><b>Extraction matched by shape.</b> Every Cribl <b>Search stock parser</b> is run against the sample (<code>matchDatatypeParserBySample</code>); the best match by content richness and match rate wins. A parser that only reads a generic syslog or RFC 5424 envelope does not count as a match. Where a parser reads its content in a second step (NSX firewall body, Infoblox CEF payload) the matcher follows the chain. A parser for a widely shared wrapper must also see the source's own token (the MSWinEventLog DHCP parser needs <code>DHCP</code>; Proofpoint TAP needs <code>tapmsg@21139</code>).</li>
      <li><b>Every event gets an extraction.</b> After the best candidate is chosen, each event is scored on its own. An event more than 30 points below the sample's median is <i>left behind</i>. Left-behind events are grouped by layout (two groups at most) and each group gets its own extraction — a JSON parse when they are JSON and the parser was not, otherwise an AI parse of only those events. It runs only where a field the parser fills on every handled event is empty, and is kept only if the sample score rises and no handled event loses more than 5 points. If nothing fills the gap, the extraction reasons say how many events were left behind and show one.</li>
      <li><b>A missing number stays missing.</b> Every mapping candidate, golden included, is guarded: an expression like <code>Number(src_port || 0)</code> is left out when none of the values it reads is present, instead of inventing a 0. OCSF enum ids (<code>severity_id</code>, <code>status_id</code>…) keep their 0, which OCSF defines as Unknown.</li>
      <li><b>AI only as the last resort.</b> If no golden, built-in parser or shape-matched stock parser fits, the model generates the stage. Its output is sanitised (single-expression evals, accessor-safe names) and scored like any other candidate.</li>
    </ol>
  </section>

  <!-- ============================ CHAPTER 2 ============================ -->
  <section class="chap" id="ch2">
    <div class="chap-h"><div class="chap-n">2</div><div class="chap-t">Sourcetype recognition</div></div>
    <p>Recognition answers <i>what is this source?</i> from its label (<code>XmlWinEventLog:Security</code>, <code>pan_traffic</code>, <code>web03_nginx</code>). It is kept separate from <i>do we have a golden for it?</i>: a recognised source without a golden still builds, via AI, on its own name. Only an <b>unresolved</b> label blocks a batch row.</p>

    <h2><span class="d"></span>Five statuses</h2>
    <table>
      <tr><th>Status</th><th>Meaning</th><th>Effect</th></tr>
      <tr><td><b>exact</b></td><td>A canonical name the app builds deterministically</td><td>Builds now</td></tr>
      <tr><td><b>alias</b></td><td>A known spelling of a canonical (<code>pan_traffic</code> → <code>palo_alto_traffic</code>)</td><td>Builds as the canonical</td></tr>
      <tr><td><b>catalogue_gap</b></td><td>Vendor/product identified (curated hint or AI confirmation), no golden</td><td>Builds via AI on its own name; never force-mapped</td></tr>
      <tr><td><b>needs_confirmation</b></td><td>A fuzzy near-match, likely a typo</td><td>Pre-filled and editable; does not block</td></tr>
      <tr><td><b>unresolved</b></td><td>No defensible candidate</td><td>The only status that blocks a build</td></tr>
    </table>

    <h2><span class="d"></span>The tier ladder (offline, cheapest first)</h2>
    <ol class="steps">
      <li><b>Namespace / host-prefix strip</b> — <code>ncsc:</code>, <code>custom::</code>, <code>web03_</code>, <code>vm2_</code> are not products.</li>
      <li><b>Exact / alias</b> — <code>SOURCETYPE_ALIASES</code> maps real-world spellings (FortiGate variants, every <code>XmlWinEventLog:*</code> channel, Zscaler NSS…) onto one canonical.</li>
      <li><b>Rotation / size-marker strip</b> — <code>messages-45</code>, <code>ssl_error_log-2</code>, <code>*-too_small</code> collapse to a known base.</li>
      <li><b>Format / transport suffix strip</b> — <code>f5_bigip_syslog</code> → <code>f5_bigip</code> (deterministic hits only).</li>
      <li><b>Squashed / CamelCase form</b> — <code>XmlWinEventLogMicrosoftWindowsSysmonOperational_CIM</code> resolves to <code>windows_sysmon</code>.</li>
      <li><b>Recognition hint</b> (<code>RECOGNITION_HINTS</code>) — curated vendor products without a golden, matched on normalised tokens; the most specific match wins. Gives <b>catalogue_gap</b>. A hint may match a glued prefix (<code>aemaccess</code>, <code>trellixTIE</code>); short prefixes such as <code>ora</code> also need a real log word after them (<code>oraaudit</code> ✓, <code>orange</code> ✗).</li>
      <li><b>Bounded fuzzy</b> — Levenshtein distance ≤ 2 against the catalog; medium confidence gives <b>needs_confirmation</b>.</li>
      <li><b>Unresolved</b> — blocks a batch row; the wizard asks for a real name.</li>
    </ol>
    <p><b>AI escalation (batch pre-flight).</b> A name still unresolved is sent once (deduplicated, cached) to the model, with no web access. It either maps the name to a supported one, marks it a real source without a golden (lifted to catalogue_gap), or leaves it unresolved. A recognised source's description, wire format and typical fields are reused to ground sample generation.</p>

    <h2><span class="d"></span>The interactive picker</h2>
    <p>Create Pack, Create Demo and Create Pipeline share one confirmation flow. On <b>Confirm</b> the local ladder runs first; exact, alias and high-confidence matches are accepted. Otherwise the catalog is searched (<code>searchSupportedSourcetypes</code>), ranked name-prefix › name-substring › description with golden (★) sources first, and merged with vendor product families (<code>PRODUCT_FAMILY_VARIANTS</code>: <code>sap</code> lists <code>sap_audit</code>★, <code>sap_syslog</code>, <code>sap_hana</code>…). Picking a listed option confirms it directly; edited free text is re-validated. Results appear only after a Confirm that did not resolve, never while typing.</p>
    <p>The confirmed vendor, product, log family and (for AI-validated sources) wire format and field list become a <b>grounding context</b> (<code>buildSampleGroundingContext</code>) for AI sample generation in both run modes. A real reference sample and the static format spec still take precedence.</p>

    <h2><span class="d"></span>Multi-format sources</h2>
    <p>Some sources ship in several wire formats: Zscaler NSS (key=value / JSON / CEF), Corelight/Zeek (JSON / TSV), FortiGate (key=value / CEF), Check Point (key=value / CEF / LEEF), Blue Coat ProxySG (W3C ELF / SQUID). A curated table (<code>getMultiFormatSpec</code>) flags them. Interactively, when there is no real reference sample, a <b>format picker</b> in the sample step locks the choice into the grounding. Batch and Demo cannot prompt, so they assume the most common format and flag the row. A real sample always wins and suppresses the picker.</p>

    <h2><span class="d"></span>Format first: a CEF sample names its own source</h2>
    <p>An uploaded sample's wire format is decided <b>before</b> its sourcetype. A sample is CEF when at least 60% of its lines carry a CEF header, at line start or after a syslog frame. The source is then read from the header's Device Vendor and Device Product. The vendor's own sourcetype is chosen only where its parser reads CEF at least as well as the generic one — <b>FortiGate</b> and <b>Check Point</b>; every other vendor builds as <code>cef</code>, with the vendor named in the reason. The same recogniser runs in the wizard, the AI detector and the Sample Sanitizer.</p>
  </section>

  <!-- ============================ CHAPTER 3 ============================ -->
  <section class="chap" id="ch3">
    <div class="chap-h"><div class="chap-n">3</div><div class="chap-t">Where the sample comes from</div></div>
    <p>Extraction is written against the sample, the schema class is inferred from it, and <b>every score is measured on it</b> (Chapter 7). The rule: <b>real logs first, synthetic last, and never a sample the source's own parser cannot read.</b></p>

    <h2><span class="d"></span>The tier ladder — first hit wins</h2>
    <table>
      <tr><th>#</th><th>Tier</th><th>What it is</th><th>Real?</th></tr>
      <tr><td>1</td><td><b>Your own sample</b></td><td>Events you pasted, uploaded, captured or picked from the worker group</td><td>✅ real</td></tr>
      <tr><td>2</td><td><b>Curated fallbacks</b></td><td>Hand-checked lines for the core deterministic sourcetypes</td><td>✅ real</td></tr>
      <tr><td>3</td><td><b>Reference logs</b></td><td>${_.sourceSamples} sourcetypes from the Splunk <code>security_content</code> corpus</td><td>✅ real</td></tr>
      <tr><td>4</td><td><b>Harvested vendor logs</b></td><td>${_.vendorSamples} sourcetypes from vendor pipeline test fixtures, via the shared samples pool (licence notices intact)</td><td>✅ real</td></tr>
      <tr><td>5</td><td><b>Verified AI samples</b></td><td>Generated samples that passed parser verification and were promoted</td><td>⚙ synthetic, checked</td></tr>
      <tr><td>6</td><td><b>Fresh AI generation</b></td><td>Generated now, grounded by the recognition metadata (Chapter 2)</td><td>⚙ synthetic</td></tr>
    </table>
    <ul>
      <li><b>Broken real entries are skipped.</b> A stored sample its own parser cannot read is skipped at resolution time, so the next tier is used instead of a sample that would extract nothing.</li>
      <li><b>Generated samples are checked line by line.</b> Empty events (<code>{}</code>) are dropped. A refusal line (<i>“Unable to generate authentic events…”</i>) fails the whole generated sample. A background run regenerates once; a second refusal stops the row and asks for a real sample.</li>
      <li><b>Verification.</b> A generated or harvested sample is replayed through the sourcetype's real parse functions: <b>pass</b>, <b>fail</b> (wrong format) or <b>unverified</b> (no parser exists — not a failure). A failure is fed into the retry prompt.</li>
    </ul>

    <h2><span class="d"></span>Every sample is labelled with its wire format</h2>
    <p>Choosing a sample is choosing a format, so every place a sample is offered shows its format, detected offline: JSON, XML, CEF, LEEF, key=value, CSV/TSV/PSV with the column count, syslog or free text, or <b>mixed</b>. The label reports structure, not transport (<code>JSON (syslog-framed)</code>, <code>PSV (6 cols, syslog-framed)</code>); Check Point's <code>time=…|hostname=…</code> reads as key=value. A column count is claimed only when at least 70% of lines split into the same number of fields. For a multi-format source the wizard adopts the loaded sample's variant, says which it recognised, and says so when the events match none or two of them.</p>

    <h2><span class="d"></span>Thin real samples are extended at the moment of use</h2>
    <p><b>${_.vendorSamples-_.vendorAtFloor} of ${_.vendorSamples}</b> harvested sources have fewer than 10 events. Stores keep only real lines; when a build needs more, the app tops the sample up towards 20 events:</p>
    <ol class="steps">
      <li>The real lines go into the prompt verbatim with their field names, envelope, column count and length. The model may only <b>vary values</b>.</li>
      <li>Rules are enforced in code: a generated line is dropped if it adds a field, changes the envelope or column count, uses vocabulary absent from the real free-text lines, duplicates a line, falls outside the real length band, or (when the parser reads every real line) cannot be parsed.</li>
      <li>At most two model calls; the retry gets the rejection reasons.</li>
      <li>Any failure falls back to the real sample with a note. Extensions are cached for the session only and never written to the stores.</li>
    </ol>

    <h2><span class="d"></span>Batch rows can bring their own sample</h2>
    <p>Each pre-flight row has a <b>Sample</b> column with <b>Choose sample</b>: the library sample, a saved sanitised sample, or your own events (upload, paste, capture), then sourcetype confirmation and sanitising. A chosen sample <b>is</b> the row's sample (tier 1, labelled <code>uploaded</code>); it is never replaced, extended or appended to. It applies to every row of the same pack and declared sourcetype, because a pack stores one <code>&lt;sourcetype&gt;_sample.log</code>; two rows of one pack and source with different samples are refused. Up to 100 events (64 KB) are kept; a quoted cell with a line break is refused. Rows without a chosen sample resolve through the tiers; samples that need generating or extending are created first, in the run's <b>Creating samples</b> stage. Every row needs a saved <b>Canonical</b> sourcetype before the run (suggestions: <b>From the sample</b>, <b>Close names</b>, <b>Has a golden</b>, <b>AI read the sample</b>).</p>
    <div class="note"><b>Require sanitised samples.</b> With this setting on, your own unsanitised events never reach an AI prompt: they are not extended, skip AI content classification, and the build uses only the golden, built-in parser and Search-datatype paths (the row's log says so). The same applies to a pasted or uploaded sample in the wizard. Sanitise first (Chapter 4) to use the AI steps.</div>
  </section>

  <!-- ============================ CHAPTER 4 ============================ -->
  <section class="chap" id="ch4">
    <div class="chap-h"><div class="chap-n">4</div><div class="chap-t">Sanitising the sample</div></div>
    <p>A real production log is customer data. The pipeline is written and scored against it, so it cannot simply be redacted: it must stay a working specimen while every identity in it is replaced. All of this happens <b>in the browser, with no network call</b>. The plan is computed as soon as a real sample lands, nothing is rewritten until <b>Apply</b> (with one level of undo), and neither the plan nor the original is persisted.</p>

    <h2><span class="d"></span>One gate to the prompt</h2>
    <p><code>aiSampleSnippet</code> is the only path from sample text to prompt text. It throws rather than returning an empty snippet. Vendor, reference and AI-generated samples are exempt by origin.</p>

    <h2><span class="d"></span>Advisory in the wizard, strict in the library</h2>
    <p>One compute (<code>runSanitisation</code>) replaces values, checks the wire format survived, re-parses before and after to prove identities changed, and re-verifies against the source parser. Each caller applies its own policy:</p>
    <ul>
      <li><b>Pack wizard — advisory.</b> A broken wire format refuses Apply: a JSON line that no longer parses or changed its field names, or a delimiter/whitespace boundary that moved. The banner says which of those happened, the entries causing it are marked red, and the banner clears as soon as they are unticked. A parser that reads the result slightly less cleanly only raises a warning.</li>
      <li><b>Sample library — strict.</b> <code>applyAndVerifySanitisation</code> rejects the save if nothing changed, the structure broke, identity coverage is unproven, or the parser regressed.</li>
    </ul>
    <p>Only a <b>regression</b> counts: the original parsed and the sanitised copy does not. Lines the source's own parser never read (scanner probes, TLS on the HTTP port) are not blamed on the sanitiser.</p>

    <h2><span class="d"></span>What it finds</h2>
    <table>
      <tr><th>Tier</th><th>Evidence</th><th>Reaches</th></tr>
      <tr><td><b>Parser fields</b></td><td>The format's parser names the field</td><td>Bare names no regex can find (an Apache <code>user</code>). ${t} field names carry an identity meaning.</td></tr>
      <tr><td><b>Patterns</b></td><td>The value's shape</td><td>IPv4/IPv6 (by class), email, MAC, <code>DOMAIN\\user</code>, FQDN</td></tr>
      <tr><td><b>Field names</b></td><td>The key in front of the value</td><td>${_.secretFields} credential and ${_.piiFields} personal/device field names. The name outranks the value's shape: <code>cardNumber</code> is settled on its name.</td></tr>
      <tr><td><b>Secret patterns</b></td><td>Public-source rules (gitleaks, Microsoft Presidio — MIT — and vendor token shapes)</td><td>${_.secretRules} of ${_.secretRulesTotal} bundled rules survive filtering (rules that would match every git SHA, or displace the IP/MAC/email rules, are removed). Always available, offline.</td></tr>
      <tr><td><b>Shape &amp; variance</b></td><td>A guess</td><td>Shown <b>unticked</b>.</td></tr>
    </table>

    <h2><span class="d"></span>Four properties of the replacement</h2>
    <ul>
      <li><b>Consistent</b> — one alias per distinct value, everywhere.</li>
      <li><b>Class-preserving</b> — private addresses stay private; public ones move to RFC 5737 documentation ranges.</li>
      <li><b>Shape-preserving</b> — label counts, <code>DOMAIN\\user</code>, delimiters, columns and JSON keys survive; a hex serial stays hex, ten digits stay ten digits.</li>
      <li><b>Collision-free</b> — no alias already appears in the sample.</li>
    </ul>
    <p><b>Credentials</b> lead the review list in their own colour and are scrambled character-for-character (length, delimiters and scheme survive). The warning says to treat the original as exposed and rotate it.</p>
    <p><b>Left alone by default:</b> ${_.vocabularyFields} product and device vocabulary fields (a phone model code is not a hostname); ${_.suspectFields} business-identifier fields (order, quote, invoice numbers — named in a warning with counts, your choice); structural placeholders (<code>NA</code>, <code>null</code>, <code>localhost</code>).</p>

    <h2><span class="d"></span>Review</h2>
    <p>Findings are grouped by kind and folded, with tick-all per group (5,000 events once produced 26,000 single-value rows). They are also <b>highlighted on the sample</b> in group colours; found-but-unticked values are outlined. Highlights come from the sanitiser itself, so they never promise cover that Apply will not deliver.</p>
    <p><b>Manual picks.</b> Highlight a value (the selection grows to whole tokens) or take the whole field (<code>quoteNumber=51015341</code> offers every value of <code>quoteNumber</code>, listed as <code>field:quoteNumber</code>). An explicit pick overrules the vocabulary and business-identifier defaults; values keep their shape and are minted fresh.</p>

    <h2><span class="d"></span>Getting events, and where the result is saved</h2>
    <p>Events arrive by <b>upload</b>, <b>paste</b>, an existing <b>worker-group sample</b>, or <b>live capture</b>. Only fetching touches Cribl. Capture lists only groups with a connected worker (from <code>/master/workers</code>) and runs as short windows (the App Platform fetch proxy abandons long requests), streaming into a live preview with a count and <b>Stop</b>; exact duplicates across windows are dropped.</p>
    <p>Save destinations (only the sanitised copy is written): <b>this generator's sample library</b> (App KV in Cribl; <code>config/sanitised-samples/</code> standalone), <b>upload to worker group</b> (<code>/m/*/system/samples</code>, reusable by both apps and by Stream itself), and — standalone only, with a configured repository — <b>publish to the shared sample pool</b>. Sanitised samples saved to the library are also listed in <b>Samples → Library</b>, labelled <b>Sanitised</b>. Inside Cribl, a sample that could only be saved in the browser gets a warning, not a success tick.</p>
    <p><b>Sample Sanitizer</b> is the same engine built as a separate App Platform app, from this repository. Its bundle excludes the AI client, goldens, sample corpus and schema code, and a build-time reachability check fails the build if an AI module becomes reachable — which is what backs its "AI-Free" badge.</p>
  </section>

  <!-- ============================ CHAPTER 5 ============================ -->
  <section class="chap" id="ch5">
    <div class="chap-h"><div class="chap-n">5</div><div class="chap-t">The resolution sequence</div></div>
    <p>Each stage tries several <b>candidates</b> and keeps the <b>highest-scoring</b> one; priority only breaks ties, so a higher-priority source can never lower quality. The winning source is shown on the stage card.</p>

    <h3>Extraction candidates</h3>
    <div class="flow">
      <div class="step"><div class="rank">1st</div><div class="nm">🏆 Golden</div><div class="ds">A verified stored pipeline, replayed when the sample's format matches.</div></div>
      <div class="arr">›</div>
      <div class="step"><div class="rank">2nd</div><div class="nm">🔍 Search datatype</div><div class="ds">A Cribl Search stock parser, matched by name or by sample shape.</div></div>
      <div class="arr">›</div>
      <div class="step"><div class="rank">3rd</div><div class="nm">⚙ Built-in / pack</div><div class="ds">A static parser emitting the canonical model, or one from an existing Cribl pack.</div></div>
      <div class="arr">›</div>
      <div class="step"><div class="rank">4th</div><div class="nm">🤖 AI</div><div class="ds">The configured model writes the parse stage.</div></div>
    </div>
    <ul>
      <li><b>Order flips by destination.</b> Extraction is scored name-agnostically, but the mapper reads canonical names. For a <b>mapped schema</b>, the canonical-emitting golden/built-in parsers go before the Search datatype; for <b>JSON / raw</b>, the Search datatype goes first because its native names are the desired output.</li>
      <li><b>Computed once per pack.</b> Extraction is resolved once per class (mapped-schema, raw/JSON) and reused by every pipeline of that class. A pack stores one sample per sourcetype. Passthrough skips extraction.</li>
    </ul>

    <h3>Mapping candidates</h3>
    <div class="flow">
      <div class="step"><div class="rank">1st</div><div class="nm">🏆 Golden</div><div class="ds">A stored mapping for this <code>sourcetype::format</code>.</div></div>
      <div class="arr">›</div>
      <div class="step"><div class="rank">2nd</div><div class="nm">🐐 Cribl schematizer</div><div class="ds">Cribl Copilot's agent, for OCSF, ECS and UDM.</div></div>
      <div class="arr">›</div>
      <div class="step"><div class="rank">3rd</div><div class="nm">🤖 AI (grounded)</div><div class="ds">Grounded on the target table / data-model columns and the real extracted field names.</div></div>
      <div class="arr">›</div>
      <div class="step"><div class="rank">4th</div><div class="nm">Static</div><div class="ds">Deterministic golden-format spec assembly as the floor.</div></div>
    </div>
    <p>The schematizer returns one parse+map+enrich pipeline with the exact versioned class (<code>ocsf@v1.8.0-network_activity-4001</code>); a high-scoring result is cached as golden so later builds skip the 1–2 minute call. Output shaping is fully deterministic and has no AI step.</p>

    <h3>Retries and health gates</h3>
    <ul>
      <li><b>Second-model retry.</b> An AI-generated stage below its golden threshold (Settings → Quality) gets one attempt with the second model from Settings → AI; the higher score wins.</li>
      <li><b>Empty extraction.</b> Zero named fields triggers an immediate fresh AI parse.</li>
      <li><b>Real field names to mapping.</b> AI mapping receives the field names extraction actually produced.</li>
      <li><b>Empty mapped values.</b> If more than 50% of output values are empty or null, mapping is retried against the real extracted fields.</li>
    </ul>

    <h3>Where the AI runs</h3>
    <p>Standalone, AI calls go through the app's backend with no per-call limit. <b>Inside Cribl they run in the browser</b> through the platform's fetch proxy, which <b>cancels any request not answered within 30 seconds</b>. Long work is therefore split: sample generation runs in small batches, a timed-out batch is retried smaller, and earlier results are kept.</p>
    <div class="note"><b>Reasoning models.</b> On Gemini 2.5+ and Claude extended-thinking models the token limit covers thinking and answer, so a model can spend it all and return nothing. The app sets a low thinking level and adds answer room; a <b>flash / fast</b> model is still the better choice for this structured work.</div>

    <h3>Improve an existing pipeline</h3>
    <p>Improve scores the deployed pipeline on its sample (the <i>before</i>), generates candidate rewrites, scores each the same way, and adopts a candidate that scores at least as well (ties are accepted, <code>&gt;=</code>); otherwise the original is kept. The <b>Improvement Complete</b> screen offers <b>Download report</b>, in the same report format as a build.</p>
    <p><b>Explicit OCSF class guidance</b> (<code>parseOcsfGuidance</code>). <b>Additional guidance</b> retargets the OCSF class when it contains <code>class_uid=N</code>, <code>class NNNN</code>, or a class caption in a targeting phrase (“map to Authorize Session”, “use the OCSF Authorize Session class”, “Authorize Session (3003)”); <code>activity_id=N</code> sets the activity. A caption mentioned in passing, or after “instead of / not / than / from / over”, is ignored. The prompt then carries a <code>TARGET CLASS</code> line instead of the inferred class. Acceptance (<code>guidedAcceptance</code>) changes only for the <b>mapping</b> stage and only when the deployed pipeline does not already emit that class: a candidate that emits the requested <code>class_uid</code> is kept unless it scores more than <code>GUIDED_CLASS_TOLERANCE</code> (5) points below the baseline. The verdict is shown on Improvement Complete and in the report, in the form “the NNNN mapping scored X vs Y for &lt;uid&gt; (&lt;caption&gt;)”; a candidate that did not emit the requested class is reported as such.</p>
    <p><b>Explicit class choice at build time</b> (<code>resolveOcsfClassChoice</code>). An OCSF class may be given as a golden key (<code>ocsf#authorize_session</code>), a class name, a caption or a <code>class_uid</code>. Any class in the vendored OCSF 1.9.0 schema is accepted; a class without a golden format gets a base-level spec generated from the schema (<code>synthesizeOcsfClassSpec</code>).</p>
  </section>

  <!-- ============================ CHAPTER 6 ============================ -->
  <section class="chap" id="ch6">
    <div class="chap-h"><div class="chap-n">6</div><div class="chap-t">Extraction &amp; mapping</div></div>

    <h2><span class="d"></span>The canonical field model</h2>
    <p>Extraction lands values under fixed, vendor-neutral names; mapping reads only those names. Any parser can feed any destination as long as it calls the address <code>src_ip</code>.</p>
    <table>
      <tr><th>Canonical field</th><th>Holds</th><th>Lands as (examples)</th></tr>
      <tr><td><code>src_ip</code> · <code>dest_ip</code></td><td>Addresses</td><td>OCSF <code>src_endpoint.ip</code>, CIM <code>src</code>, ECS <code>source.ip</code>, ASIM <code>SrcIpAddr</code></td></tr>
      <tr><td><code>src_port</code> · <code>dest_port</code></td><td>Ports</td><td>OCSF <code>*.port</code>, CEF <code>spt</code>/<code>dpt</code></td></tr>
      <tr><td><code>user</code> · <code>src_user</code></td><td>Principal</td><td>OCSF <code>actor.user.name</code>, ASIM <code>ActorUsername</code></td></tr>
      <tr><td><code>action</code> · <code>severity</code></td><td>Outcome, weight</td><td>OCSF <code>activity_id</code>/<code>severity_id</code>, ASIM <code>EventResult</code></td></tr>
      <tr><td><code>log_time</code></td><td>The event's own time</td><td>The only field every spec reads to set <code>_time</code></td></tr>
    </table>
    <p><b><code>log_time</code> is the one name for time.</b> A timestamp captured under another name is detected and aliased to <code>log_time</code>; otherwise every event would share the processing time.</p>

    <h2><span class="d"></span>Extraction techniques</h2>
    <div class="stages">
      <div class="stage ex"><div class="sh">serde — structured</div><div class="sb">kvp / json / csv / cef in one Cribl <code>serde</code> function.</div></div>
      <div class="stage mp"><div class="sh">regex_extract — text</div><div class="sb">Named capture groups for syslog and prose. Preferred over code functions.</div></div>
      <div class="stage op"><div class="sh">eval — normalise</div><div class="sb">Rename vendor fields to canonical names and build <code>log_time</code>.</div></div>
    </div>
    <ul>
      <li><b>One expression per <code>eval</code> field.</b> No <code>=&gt;</code>, <code>function</code>, <code>return</code>, <code>;</code> or <code>?.</code>; AI output that is not a safe single expression is dropped.</li>
      <li><b>Accessor-safe names.</b> kvp/csv serdes get <code>cleanFields:true</code> (SAP's <code>SY-MANDT</code> would otherwise break the accessor build), and references are realigned to the cleaned names.</li>
      <li><b>Values left in <code>_raw</code> don't count</b> towards extraction.</li>
      <li><b>Optional: drop null and blank fields.</b> With Settings → Quality → <b>Drop null and blank fields when parsing JSON</b> on (default off), new builds give each JSON Parser without a filter <code>fieldFilterExpr: value!=null &amp;&amp; value!==''</code>. <code>0</code> and <code>false</code> are kept; top-level fields only, nested objects are left as they are. Scores are unaffected, because null and blank values already count as unfilled.</li>
    </ul>

    <h2><span class="d"></span>Mapping by schema family</h2>
    <ul>
      <li><b>Flat (CIM, CommonSecurityLog, ASIM, CEF)</b> — evals copy canonical fields to schema names and set <code>_time</code>; CEF and CIM then serialise into <code>_raw</code>.</li>
      <li><b>Nested (OCSF, ECS, UDM)</b> — parent objects are created before dotted paths are assigned (a missing parent drops the branch); OCSF gets its enrichment literals.</li>
      <li><b>Grounded (Sentinel table, CIM data model)</b> — generated against the exact columns of the target you picked.</li>
    </ul>

    <h2><span class="d"></span>When a golden is refused</h2>
    <p>A golden is replayed only when the sample matches the format it expects (<code>goldenPathMatchesSample</code>). If the golden expects kvp, CEF or JSON but the sample fingerprints as unstructured, at least one of its critical keys must appear as a real pair (<code>key=</code> or <code>"key":</code>); otherwise the golden is refused and the source goes to AI. This stops, for example, a SAP-audit golden scoring ~0 on generic SSH lines.</p>

    <h2><span class="d"></span>Goldens are filed per wire format</h2>
    <ul>
      <li>The source's own format keeps the plain key (<code>fortinet_fortigate::cim</code>).</li>
      <li>Any other format gets a variant (<code>fortinet_fortigate@cef::cim</code>) and never replays the plain golden.</li>
      <li>A custom source is filed under its variant (<code>acme_app@json</code>) but still reuses an older plain golden unless that golden's sample was visibly CEF or JSON.</li>
      <li>A mixed or empty sample uses the plain key.</li>
      <li>The sourcetype part is the canonical name (<code>checkpoint_firewall_cef</code> → <code>checkpoint_firewall@cef</code>); parts stored under a typed name are still found as a fallback.</li>
      <li><b>A mapping golden needs a vendor sourcetype.</b> It is not stored or replayed under a format label (<code>json</code>, <code>csv</code>, <code>kvp</code>, <code>xml</code>, <code>text</code>, <code>syslog</code>, and the other column formats). A vendor key that arrived as JSON (<code>fortinet_fortigate@json</code>) is still a vendor key. CEF and LEEF stay allowed, because their headers are the source contract. Extraction goldens for a format label stay allowed — a JSON parser is reusable; a vendor's field mapping is not.</li>
    </ul>
    <p><b>Mapping sub-parts are keyed on the concrete schema</b> (<code>ocsf#network</code>, a CIM data model). A part stored under a bare family name is used only on proof: an OCSF part whose <code>class_uid</code> is the class this build wants. Bare CIM and ASIM parts record no data model, so they are never promoted.</p>

    <h2><span class="d"></span>Build pack flow and post-processing</h2>
    <ul>
      <li><b>The main pack is built like Create new pack</b>, with full-fidelity OCSF. When OCSF is a destination, <b>one post-processing pack per output format</b> is built in the same run (<code>&lt;name&gt;-&lt;format&gt;</code>). Each output is <b>Full copy</b> (mapping only, no optimisation lookups) or <b>Optimize by category</b> (adds the qualified OCSF optimisation rules). Post-processing packs are curated deterministic transforms and are not quality-scored.</li>
      <li>Each post-processing pack is sampled from the <b>main OCSF pipeline's own output</b>, every field kept; only if that preview is empty does it fall back to the curated OCSF sample (and the log says so).</li>
      <li><b>OCSF → any format.</b> OCSF's nested objects are aliased to canonical names once and handed to each destination's own <code>canonicalMap</code>. Every specific CIM data model, ASIM schema and Chronicle class is a target, as is Sentinel CommonSecurityLog. Attributes with a destination field land in it (75–99% of OCSF values in measurements); the rest goes to the leftover container (<code>AdditionalExtensions</code>, <code>AdditionalFields</code>, <code>additional_fields</code>, extra CIM keys) as flat dot paths. Chronicle has no leftover container.</li>
      <li><b>Raw outputs restore the original.</b> Splunk raw, Elastic integration, XSIAM and NG SIEM post outputs restore <code>raw_data</code> (from <b>Keep original <code>_raw</code></b>, on by default) into <code>_raw</code>; without it the OCSF event is serialised and the log warns.</li>
      <li><b>Splunk metadata contract.</b> Every Splunk output sets <code>host</code>, <code>source</code> and <code>sourcetype</code> (a restored Windows Security event gets <code>XmlWinEventLog</code> / <code>XmlWinEventLog:Security</code>; OCSF JSON gets <code>ocsf</code> / <code>ocsf:&lt;source&gt;</code>), and Splunk raw/JSON post outputs strip every other field.</li>
      <li><b>Source noise reduction.</b> A main-pack card other than OCSF, passthrough, XSIAM or JSON can be set to <b>Optimize</b> when noise rules exist for the source (per-sourcetype drops and the lookup-driven drops from the original Cribl packs). Rules from the same category are offered switched off, marked “same-category rule”. Rules run after mapping, before compaction; a rule whose fields are missing is reported as “won't fire”. They <b>do not change the score</b>: it is measured with every noise rule off, and the dropped-event count is reported separately.</li>
    </ul>

    <h2><span class="d"></span>The export formats — one sub-chapter per tile</h2>
    <p>What each <b>destination tile</b> produces. Three things apply to all of them: every selected tile becomes its own pipeline in the same pack, scored separately; Sentinel, Splunk CIM and ASIM open a sub-selector that resolves the tile to a concrete target before building; and the output shape (<code>nested</code>, <code>flat</code>, <code>raw</code>, <code>passthrough</code>) is the destination's hard contract.</p>
    <table>
      <tr><th>Tile</th><th>Output shape</th><th>Built by</th><th>Mapping stage scored?</th></tr>
      <tr><td><b>CrowdStrike NG SIEM</b></td><td>raw (the original <code>_raw</code>, alone)</td><td>Parser for drops and flags only; nothing mapped</td><td><b>No</b> — scored as raw fidelity instead</td></tr>
      <tr><td><b>OCSF 1.9</b></td><td>nested</td><td>Cribl schematizer → golden → AI</td><td>Yes</td></tr>
      <tr><td><b>CEF</b></td><td>raw (<code>_raw</code> string)</td><td>Golden spec → AI</td><td>Yes</td></tr>
      <tr><td><b>Microsoft Sentinel</b></td><td>flat (the table's columns)</td><td>Golden or AI grounded on the DCR</td><td>Yes — through the real column list</td></tr>
      <tr><td><b>Splunk CIM</b></td><td>raw + metadata (fields <i>inside</i> <code>_raw</code>)</td><td>Golden spec → AI grounded on the data model</td><td>Yes</td></tr>
      <tr><td><b>Elastic ECS</b></td><td>nested</td><td>Cribl schematizer → golden → AI</td><td>Yes</td></tr>
      <tr><td><b>Sentinel ASIM</b></td><td>flat</td><td>Golden spec (per ASIM schema) → AI</td><td>Yes</td></tr>
      <tr><td><b>Chronicle UDM</b></td><td>nested</td><td>Cribl schematizer → golden → AI</td><td>Yes</td></tr>
      <tr><td><b>Cortex XSIAM</b></td><td>passthrough</td><td>Deterministic tagging from the source catalog</td><td>Yes — as an all-or-nothing contract</td></tr>
      <tr><td><b>Passthrough (raw copy)</b></td><td>passthrough</td><td>None — events forwarded unchanged</td><td><b>No</b> — no transform, no schema</td></tr>
      <tr><td><b>Clean JSON</b></td><td>flat</td><td>Golden spec (rename only)</td><td><b>No</b> — no schema to map to</td></tr>
    </table>

    <h3 id="fmt-nextgen">CrowdStrike NG SIEM</h3>
    <p>The original event, byte for byte, for the NG SIEM connector's <b>vendor parser</b> (one connector and ingest token per parser). NG SIEM parses only the HEC <code>event</code> and bills the <b>whole payload</b>, so only <code>_raw</code> is sent; <code>_time</code> travels as the HEC <code>time</code>. The pipeline copies <code>_raw</code> aside, parses only so the source's drops and flags can read fields, then restores the untouched copy and removes every other field. It is <b>not</b> delegated to Cribl's schematizer, and no golden or AI mapping runs.</p>
    <p><b>Scored as raw fidelity:</b> the share of output events whose <code>_raw</code> is an unchanged sample line with no billable field beside it. <code>__</code> fields and platform-stamped <code>cribl_*</code> fields do not count. The Mapping card is N/A; the Optimization card carries this score, which is also the overall score.</p>

    <h3 id="fmt-ocsf">OCSF 1.9</h3>
    <p>A nested object tree plus the numeric identifiers that make an OCSF event valid. The build is first delegated to <b>Cribl Copilot's schematizer</b>; if its mapping scores below the threshold and a deterministic golden exists, the golden/AI path is used instead.</p>
    <ul>
      <li><b>Graded against the real schema</b> (vendored OCSF 1.9.0, every class): required attributes present, legal enum values, <code>type_uid</code> = <code>class_uid</code> × 100 + <code>activity_id</code>, and correct JSON types (a string <code>severity_id:"1"</code> costs at most a 10% haircut). Attributes outside the class are advisory only. The class is read from the <code>class_uid</code> the output actually carries; profile-gated attributes count only when the profile is used.</li>
      <li><b>Shape and carry, 50/50.</b> Of the values extraction delivered, one in a typed attribute of the class earns full credit, one only under <code>unmapped</code> a quarter, a lost one nothing. Every OCSF mapping ends with an output-shaping step (class attributes at top level, other vendor fields under <code>unmapped</code>, numeric attributes typed), and that shaped event is what is scored.</li>
      <li><b>The class comes from the data.</b> <code>network</code> → Network Activity (4001), <code>endpoint</code> → Process Activity (1007), <code>cloud_audit</code> → API Activity (6003), <code>authentication</code> → Authentication (3002), <code>privilege</code> → Authorize Session (3003), <code>dns</code> → DNS Activity (4003), <code>email</code> → Email Activity (4009). Mail gateways (Corelight/Zeek SMTP, Clearswift, Postfix, Symantec Email) are Email Activity; Cisco ISE and LDAP access logs are Authentication. The sample decides when present, else the sourcetype name.</li>
      <li><b><code>status</code> is the caption of <code>status_id</code></b>: 1 Success, 2 Failure, 99 Other, 0 Unknown. The vendor outcome sets <code>status_id</code> (Finished/Approved/Completed/Success/Allowed → 1; Denied/Rejected/Failed/Blocked → 2; anything else → 99) and the raw vendor word goes to <code>status_detail</code>. Grounding derives <code>status</code> from <code>status_id</code>, and a <code>status</code> that is not a caption is flagged as an advisory. Classes that redefine <code>status_id</code> (findings, remediation) are exempt.</li>
      <li><b>Keep original <code>_raw</code> does not split the stages.</b> The raw-copy eval (<code>pg_original_raw_copy = _raw</code>) that runs before the parser is counted as part of extraction, so a keep-raw pipeline scores its parser normally. <code>raw_data</code> is always a string: an object <code>_raw</code> is serialised with <code>JSON.stringify</code>.</li>
      <li><b>Windows picks the class per event</b> from the EventID: 4624/4625 Authentication (3002), 4672 Authorize Session (3003), 4720 Account Change (3001), 4728 Group Management (3006), 4688 Process Activity (1007), 5156 Network Activity (4001), 4104/4103 Script Activity (1009); unknown EventIDs become Base Event (0) with everything under <code>unmapped</code>.</li>
      <li><b><code>metadata.product</code> names your source</b> from the sourcetype's vendor entry (CEF from its own header), and <code>cloud.provider</code> follows it. Post-processing rules test <code>metadata.product.vendor_name</code>, so this matters.</li>
      <li><b>AWS VPC Flow Logs</b> are read in all five layouts (v2, v5, all-fields, Transit Gateway, v3 custom), with the CloudWatch <code>{"message":…}</code> envelope unwrapped; a <code>-</code> is left out, not 0.</li>
    </ul>
    <div class="note"><b>Added values are free.</b> <code>class_uid</code>, <code>category_uid</code>, <code>type_uid</code>, <code>severity_id</code> and <code>time</code> are excluded from the score's denominator. A multi-event-type source can score mid-range because OCSF has no field for some vendor values — that is real signal.</div>

    <h3 id="fmt-cef">CEF</h3>
    <p>One line: <code>CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|key=value…</code>. The golden spec builds the 7-part header and ~${S} extension keys from the canonical model and <b>replaces <code>_raw</code></b>. Keys are emitted only when their value exists; <code>cs1</code>… carry their <code>cs1Label</code>.</p>
    <p><b>Severity is translated:</b> the scales run in opposite directions (syslog 0 is most urgent, CEF 10 is), so syslog 0-1 → 10, 3 → 8, 5 → 4, 7 → 1, and the value defaults to 5 when the source has none.</p>
    <div class="note">The assembly is split across several evals of 6–8 fields, because Cribl fails on one very large template literal. There is no host word before <code>CEF:0</code>, and pipes and equals signs inside values stay escaped.</div>

    <h3 id="fmt-sentinel">Microsoft Sentinel</h3>
    <p>A family: the sub-selector offers <b>${y} native Sentinel tables</b>, pre-filtered from the sourcetype, and the table you pick is the build target. <code>CommonSecurityLog</code>, <code>SecurityEvent</code> and <code>Syslog</code> have hand-verified golden mappings; every other table is mapped by AI grounded on that table's DCR column list and Microsoft's own solution transforms where they exist.</p>
    <div class="note"><b>The exact opposite of CIM.</b> A DCR accepts <b>only</b> the table's own columns as top-level fields and silently discards the rest, so the pipeline ships the table's shape and nothing more (with an explicit exception that keeps <code>_time</code>). Each column is cast to its DCR type; an unparseable value becomes null, never 0. Vendor-native tables (<code>AWSVPCFlow</code>, <code>AWSCloudTrail</code>, <code>SecurityEvent</code>) expect the vendor's own values, so the original token kept as <code>vendor_action</code> / <code>vendor_severity</code> is preferred there; <code>ASim*</code>, <code>CommonSecurityLog</code> and <code>Syslog</code> keep the canonical value.</div>

    <h3 id="fmt-cim">Splunk CIM</h3>
    <p>The field names Splunk's data models search on. The sub-selector offers all <b>${b} CIM data models</b>, and the pick grounds the AI mapping on that model's fields. The golden spec maps the canonical fields to CIM names, then <b>serializes them into <code>_raw</code></b> as JSON and strips the top level back to Splunk metadata: <code>_raw</code>, <code>_time</code>, <code>index</code>, <code>source</code>, <code>sourcetype</code>, <code>host</code>. CIM's vocabulary is the canonical one (<code>allowed</code>/<code>blocked</code>), with the vendor's original word in <code>vendor_action</code> / <code>vendor_severity</code>.</p>

    <h3 id="fmt-ecs">Elastic ECS</h3>
    <p>A nested dot-notation tree for Elasticsearch and Elastic Security. Delegated first to Cribl's schematizer, with the golden spec and grounded AI behind it. <code>event.kind</code>, <code>event.category</code> (an array) and <code>ecs.version</code> are literals; <code>event.outcome</code> is derived from <code>action</code>. <code>@timestamp</code> is written by the Elasticsearch destination from <code>_time</code>. The source text is kept in <code>message</code>.</p>
    <p><b>Graded against Elastic's field list (ECS 9.5.0).</b> A mapping conflict (a string where ECS defines an object) is rejected by Elasticsearch: capped at <b>25</b>. A categorisation value outside the allowed set: capped at <b>55</b>. Malformed typed values (non-IP in an <code>ip</code> field, epoch seconds in a date): capped at the share that indexes. Anything Elasticsearch accepts (numeric strings, a single value for an array, unknown fields — with a suggested name) is advice only.</p>

    <h3 id="fmt-asim">Microsoft Sentinel ASIM</h3>
    <p>Microsoft's normalised, schema-versioned tables: flat columns plus <code>EventSchema</code>/<code>EventSchemaVersion</code>. ASIM is <b>${_.asimSchemas} different schemas</b> with a golden spec each: Authentication, DNS, Web Session, Network Session, Process, File, Registry, Audit, DHCP and User Management. The sub-selector defaults to <b>auto</b>, which resolves the schema from the source's data class (sniffed from the sample when there is one); an unclassifiable source falls to Network Session, ASIM's catch-all. ASIM keeps Microsoft's normalised vocabulary (<code>EventResult</code> = <code>Success</code>/<code>Failure</code>) and preserves <code>_raw</code>.</p>

    <h3 id="fmt-chronicle">Google Chronicle UDM</h3>
    <p>Chronicle's nested model with principal/target framing (<code>principal.ip</code>, <code>target.ip</code>, <code>network.sent_bytes</code>). Delegated to Cribl's schematizer (family <code>udm@</code>) with the golden spec behind it; <code>_raw</code> is dropped.</p>
    <div class="note"><b>Strict enums.</b> <code>metadata.event_type</code> must be a UDM EventType, <code>security_result.action</code> an array of <code>BLOCK</code>/<code>ALLOW</code>/<code>UNKNOWN_ACTION</code>, repeated fields are arrays, and <code>metadata.event_timestamp</code> is numeric <code>{seconds, nanos}</code>. SecOps silently drops an event without a valid type or timestamp and fails the whole batch (400) on an enum or type violation; Chapter 7 caps both.</div>

    <h3 id="fmt-xsiam">Cortex XSIAM</h3>
    <p>The destination that <b>deliberately does not normalise</b>: XSIAM's content packs parse the vendor format themselves, so <code>_raw</code> is preserved exactly and only routing metadata is added. A catalog of <b>${x} sources</b>, synchronised from Palo Alto's Demisto content, supplies the tagging pattern — <code>tag_only</code>, <code>tag_vendor_product</code>, <code>cef_extract</code> or <code>zscaler_wrap</code> — and sets <code>__sourceIdentifier</code> plus, where required, the exact <code>__vendor</code>/<code>__product</code> strings.</p>
    <div class="note"><b>An unknown source is marked, not faked.</b> Without a catalog match the pack is built with the generic collector UUID and a guessed vendor/product, recorded as a high-severity finding, and the score is <b>forced to zero</b>. Mapping is an <b>all-or-nothing</b> contract check (5 of 6 required tags is a failure), and Chapter 7's parse-conformance check asks whether XSIAM's own rule will read the line.</div>

    <h3 id="fmt-passthrough">Passthrough (raw copy)</h3>
    <p>Transforms <b>nothing</b>: every event is forwarded as received, <code>_raw</code> byte for byte, for a Lake or destination that wants a raw copy. The pipeline holds a single <code>comment</code> and no processing functions, and adds no routing tags.</p>
    <div class="note"><b>How it scores:</b> extraction, mapping and output shaping are all n/a, and the overall score is <b>N/A</b>, not a number. The build is logged with null scores and excluded from averages. No golden sub-part is stored.</div>

    <h3 id="fmt-json">Clean JSON</h3>
    <p>Flat JSON with normalised names for Cribl Lake, S3 or any JSON destination. The golden spec renames and types ~15 canonical fields (<code>src_ip</code>, <code>dest_port</code>, <code>action</code>, <code>bytes_in</code>…) and drops <code>_raw</code>. There is no schema, so the <b>mapping card</b> shows n/a, and the Search stock parser is tried first in extraction. A JSON-shaped pack aimed at Splunk tops out around 82 by design.</p>

    <div class="note" id="fmt-flow-only"><b>Destinations only the Build pack flow offers.</b> Its picker lists the Cribl Lake options first (OCSF 1.9, Passthrough, <b>Raw + extracted fields</b>), then the analytics tools alphabetically. <b>Raw + extracted fields</b> keeps <code>_raw</code> and ships every extracted field top-level beside it (one Parquet column per field in the Lake); it has no schema, so the <b>mapping card shows n/a</b> and it uses the raw/JSON extraction class. <b>Splunk raw</b> and <b>Elastic integration</b> build as Passthrough, <b>Splunk JSON</b> and <b>Elastic JSON</b> as Clean JSON, each in its own pipeline. <b>Elastic integration</b> sends <code>message</code> = the original line, <code>_dataId</code> = the source's canonical name (and <code>input.type: log</code> where the data stream needs it) for the Elastic <code>cribl</code> integration's reroute; sources only Elastic Agent can parse get no <code>_dataId</code> and the card recommends ECS. <b>Google SecOps raw (log type)</b> sends <code>_raw</code> unchanged with <code>__logType</code> from a committed table of Google's default parsers — no entry, no label — and recommends Chronicle UDM when Google's parser does not accept the sample's format. These raw cards score n/a.</div>

    <div class="note"><b>There is no "Custom / Other" destination.</b> A free-text schema could not be verified (no spec, no column list, no validator), so it was removed. Pick the closest real tile — Sentinel → CommonSecurityLog has a hand-verified golden — and adjust the deployed pipeline.</div>
  </section>

  <!-- ============================ CHAPTER 7 ============================ -->
  <section class="chap" id="ch7">
    <div class="chap-h"><div class="chap-n">7</div><div class="chap-t">How scoring works</div></div>
    <p>Every score answers one question: <b>of the information present in your sample, how much did the pipeline extract and deliver?</b> It is <b>source-relative</b>: a schema field your source never carries cannot lower it, so a sparse source captured completely scores 100. Scores are deterministic and computed from real preview output; the AI never sets a score.</p>
    <div class="formula">score = round( distinct sample values that reach the OUTPUT ÷ distinct meaningful sample values × 100 )</div>
    <ul>
      <li><b>Meaningful values only.</b> Structural tokens and English prose are filtered out of the denominator.</li>
      <li><b>A timestamp is one value</b>, never split on <code>:</code>. A Windows XML <code>&lt;Data Name='…'&gt;</code> name is a field name, not a value.</li>
      <li><b>Enrichment is free.</b> Values the pipeline adds (<code>_time</code>, protocol decode, OCSF ids) are output-only.</li>
      <li><b>A carried copy never counts.</b> <code>_raw</code> and OCSF <code>raw_data</code> are excluded from the output side.</li>
      <li><b>Covered elsewhere.</b> A value is only lost if it reaches <b>no</b> output event.</li>
    </ul>

    <h2><span class="d"></span>Score bands</h2>
    <div class="bands">
      <span class="band g">85–100 · Good</span>
      <span class="band w">60–84 · Needs review</span>
      <span class="band f">0–59 · Broken</span>
    </div>

    <h2><span class="d"></span>The stage checks</h2>
    <div class="stages">
      <div class="stage ex"><div class="sh">Extraction</div><div class="sb">Value coverage against the extracted fields only; values still in <code>_raw</code> do not count.</div></div>
      <div class="stage mp"><div class="sh">Mapping</div><div class="sb">Fit to the target schema. No schema (JSON, raw) → <b>N/A</b>.</div></div>
      <div class="stage op"><div class="sh">Output shaping</div><div class="sb">Did destination cleanup preserve the mapped fields? A deterministic regression check.</div></div>
    </div>
    <ul>
      <li><b>Extraction</b> — e.g. <code>42/55 meaningful source values were pulled out of _raw.</code></li>
      <li><b>Mapping, nested (OCSF)</b> — schema score (Chapter 6) blended with value carry; enrichment literals excluded.</li>
      <li><b>Mapping, flat (CIM, CommonSecurityLog, ASIM)</b> — of the schema fields your source can fill, how many were populated.</li>
      <li><b>Mapping, XSIAM</b> — one hard routing/payload contract; partial is 0.</li>
    </ul>

    <h2><span class="d"></span>The overall Pipeline Quality Check score</h2>
    <p>The overall score (and the logged <code>deployment_score</code>) is <b>end-to-end value coverage</b> of the whole pipeline on your sample. It can be lower than the stage scores when a value is lost <i>between</i> stages. Stage scores tell you which stage to fix; the overall score is the real quality of the result.</p>

    <h2><span class="d"></span>Caps — conformance can only lower a score</h2>
    <p>Value coverage says whether your data arrived, not whether the output has the shape the destination needs. These offline checks run after it and can only lower the score; a correctly shaped event scores exactly as before.</p>
    <table>
      <tr><th>Check</th><th>Cap</th></tr>
      <tr><td><b>OCSF completeness</b> — no <code>class_uid</code>, or no populated nested object (flat canonical names are not OCSF)</td><td>55</td></tr>
      <tr><td><b>OCSF class correctness</b> — the source's data class maps to one unambiguous class (network 4001, authentication 3002, privilege 3003, endpoint 1007, web proxy 4002, email 4009, DNS 4003, cloud audit 6003) and the output never carries it. <code>audit</code> and <code>generic</code> sources are exempt; a source emitting several classes passes if its primary class appears.</td><td>50</td></tr>
      <tr><td><b>CEF wire format</b> — malformed 7-part header, leading host word, unescaped pipes/equals</td><td>capped</td></tr>
      <tr><td><b>CIM &amp; ASIM types</b> — numeric or boolean fields emitted as strings</td><td>small haircut</td></tr>
      <tr><td><b>ECS schema</b> — see <a href="#fmt-ecs">Elastic ECS</a></td><td>25 / 55 / share that indexes</td></tr>
      <tr><td><b>Chronicle envelope</b> — a flat blob with dotted names instead of nested namespaces</td><td>capped</td></tr>
      <tr><td><b>SecOps UDM wire contract</b> — every event would be dropped / some dropped or a batch-400 violation</td><td>25 / 55</td></tr>
      <tr><td><b>XSIAM parse conformance</b> — the content-pack rule's raw-line gate fails, or a key the rule requires and your sample carried was lost</td><td>all events: deep (deeper for datasets that discard); some: the share XSIAM will parse</td></tr>
      <tr><td><b>JSON structural</b> — output must be non-empty structured JSON</td><td>capped</td></tr>
    </table>
    <ul>
      <li>Both OCSF gates are one audit (<code>ocsfStructuralAudit</code>) applied by the authoritative score <i>and</i> the staged Mapping card, so a wrong-class or flat candidate cannot win, be accepted from the schematizer, or be stored as golden. The card states the cap first (<i>OCSF capped at 50: this source is Network Activity (4001), the output emits class_uid 4009</i>). Score events record <code>ocsf_class_uid</code>, <code>ocsf_expected_class_uid</code>, <code>ocsf_schema_score</code> and <code>ocsf_cap</code>.</li>
      <li>The other caps run in one engine (<code>auditSchemaConformance</code>) on the authoritative score: repair, post-processing and <code>/pack-quality-check</code>. The staged builder's stage cards apply the CEF gate but not yet the CIM/ASIM, ECS, Chronicle and SecOps caps.</li>
      <li>XSIAM accepted-timestamp formats are reported, never capped; a clause that cannot be checked is reported, not counted.</li>
    </ul>

    <h2><span class="d"></span>Reliability rules</h2>
    <ul>
      <li><b>A zero has to be proven.</b> Under concurrent scoring the preview endpoint can return empty output for a working pipeline. When input exists but the preview yields nothing, it is re-run with backoff; only a persistently empty result is a real zero.</li>
      <li><b>Score logging reports whether it landed</b>; Settings shows a per-session logged / dropped tally with the reason.</li>
      <li><b>Batch traces.</b> Every batch row keeps its build trace (sample, candidates, stage scores and reasons, final functions) for <b>Trace</b> and <b>Analyze</b>; <b>Download results</b> exports one record per pipeline (CSV or JSON) with scores, sources, resolved destination, sample tier and format, and function counts. Rows with more than one Parser or <code>regex_extract</code> are flagged. Traces live in memory only, not in the resume checkpoint.</li>
    </ul>

    <h3>Quick reference</h3>
    <table>
      <tr><th>Number you see</th><th>What it measures</th><th>Formula</th></tr>
      <tr><td>Extraction (E)</td><td>Values pulled from <code>_raw</code> into named fields</td><td>covered ÷ meaningful sample values</td></tr>
      <tr><td>Mapping (M)</td><td>Fit to the destination schema (source-relative)</td><td>populated ÷ expected schema fields (OCSF: schema 50% + carry 50%)</td></tr>
      <tr><td>Output shaping</td><td>Destination cleanup preserved mapped fields</td><td>deterministic regression check</td></tr>
      <tr><td>Deployment score</td><td>End-to-end quality of the live pipeline</td><td>covered ÷ meaningful sample values (whole pipe), then caps</td></tr>
    </table>
  </section>

  <!-- ============================ CHAPTER 8 ============================ -->
  <section class="chap" id="ch8">
    <div class="chap-h"><div class="chap-n">8</div><div class="chap-t">Knowledge-base stats</div></div>
    <p>The deterministic knowledge the app ships with, read live from its bundled config. The more of it fits your source, the less the AI is needed.</p>

    <h3>Golden pipelines</h3>
    <div class="stat-grid">
      <div class="stat"><div class="n">${_.goldenTotal}</div><div class="l">Golden entries</div><div class="s">total stored</div></div>
      <div class="stat"><div class="n">${_.goldenSourcetypes}</div><div class="l">Sourcetypes</div><div class="s">distinct covered</div></div>
      <div class="stat"><div class="n">${_.goldenFormats}</div><div class="l">Dest formats</div><div class="s">with a golden</div></div>
      <div class="stat"><div class="n">${_.goldenFull}</div><div class="l">Full pipelines</div><div class="s">end-to-end</div></div>
    </div>
    <table>
      <tr><th>Granularity</th><th>Count</th><th>What it is</th></tr>
      <tr><td>Full <code>sourcetype::format</code></td><td>${_.goldenFull}</td><td>Complete verified pipeline</td></tr>
      <tr><td>Extraction sub-parts</td><td>${_.goldenExtraction}</td><td><code>::__extraction__</code> — reusable parse stage</td></tr>
      <tr><td>Mapping sub-parts</td><td>${_.goldenMapping}</td><td><code>::__mapping__</code> — reusable schema mapping</td></tr>
    </table>
    <p style="font-size:11.5px;color:var(--mut)">A wire-format variant (<code>fortinet_fortigate@cef</code>) counts under its source.</p>

    <h3>How a golden earns trust</h3>
    <p>A score is measured on <i>your</i> sample, so a 100 on two lines and a 100 on twenty are not the same claim. Every golden is therefore stored with its <b>evidence</b>: the score, the sample's shape, how many events and values it held, which store it came from, and how many of its lines an AI wrote. A golden with no evidence is not stored. Its standing is then <b>earned</b>, not set: <i>candidate</i> after one measurement, <i>corroborated</i> once it has passed on a second, different sample shape, <i>trusted</i> after three. Every time a build reuses a golden, the score it got is written back to that golden. A score under 80 on a real, non-thin sample <b>quarantines</b> it: it is kept with the reason, and never served again. Before a golden is shared, the app re-runs it offline on real samples it was not built on, but only samples it would actually be given, and only once that re-run reproduces the golden's own score. A golden built on a thin or AI-written sample can be used locally, but never outranks one measured on real data and never reaches the pool.</p>

    <h3>The shared golden pool</h3>
    <p>A pipeline that clears its threshold on real deployed output is stored locally and — if you opted in under <b>Settings → Goldens</b> — published to a public, goldens-only GitHub repository (<code>wvdlinde-cribl/cribl-pack-goldens</code>, branch <code>shared-goldens</code>). Only a <b>corroborated</b> golden with qualifying evidence scoring 80 or more is published. That bar is fixed in the app, not taken from your threshold setting. An existing shared golden is replaced only by one that outranks it. On startup the app reads the pool's manifest (one conditional request) and a <b>star badge</b> shows how many entries are new to you or outrank what you have; you choose what to import. A shared golden that carries no evidence is only imported where you have none. Reading is anonymous in both run modes. Publishing needs a write token held server-side, so it is standalone only; GitHub allows 5,000 requests/hour per user, bulk reads use GraphQL (about 7 requests for the pool), and a spent budget fails fast with the reset time. <b>Test GitHub access</b> shows what is left.</p>

    <h3>Cribl Search stock parsers</h3>
    <div class="stat-grid">
      <div class="stat"><div class="n">${_.searchParsers}</div><div class="l">Search parsers</div><div class="s">datatype library</div></div>
      <div class="stat"><div class="n">${_.searchRaw}</div><div class="l">raw / regex</div><div class="s">text log formats</div></div>
      <div class="stat"><div class="n">${_.searchDelimited}</div><div class="l">delimited</div><div class="s">CSV / TSV</div></div>
      <div class="stat"><div class="n">${_.searchKvp}</div><div class="l">key=value</div><div class="s">kvp formats</div></div>
    </div>
    <p style="font-size:11.5px;color:var(--mut)">Settings → Datatypes audits your Search group against this library and <b>Sync</b> imports the difference — to the parser file standalone, or stored with this app installation inside Cribl as a layer over the built-in library.</p>

    <h3>Real log samples (tiers 3–4, Chapter 3)</h3>
    <div class="stat-grid">
      <div class="stat"><div class="n">${_.sourceSamples+_.vendorSamples}</div><div class="l">Sources with a real log</div><div class="s">no AI needed to see the format</div></div>
      <div class="stat"><div class="n">${_.vendorEvents}</div><div class="l">Real event lines</div><div class="s">harvested vendor corpus</div></div>
      <div class="stat"><div class="n">${_.vendorAtFloor}</div><div class="l">Ready as-is</div><div class="s">&ge;10 events, no extension</div></div>
      <div class="stat"><div class="n">${_.vendorMerged}</div><div class="l">Multi-fixture</div><div class="s">several real shapes merged</div></div>
    </div>
    <p style="font-size:11.5px;color:var(--mut)">Harvested samples keep their upstream repository, commit and paths; ${_.vendorVerified} are parser-verified.</p>

    <h3>Destination format specs</h3>
    <div class="stat-grid">
      <div class="stat"><div class="n">${_.formatSpecs}</div><div class="l">Format specs</div><div class="s">golden-formats.json</div></div>
      <div class="stat"><div class="n">${_.formatFamilies}</div><div class="l">Families</div><div class="s">OCSF·CIM·ECS·ASIM·…</div></div>
      <div class="stat"><div class="n">${_.asimSchemas}</div><div class="l">ASIM schemas</div><div class="s">data-class variants</div></div>
      <div class="stat"><div class="n">${_.ocsfClasses}</div><div class="l">OCSF classes</div><div class="s">data-class variants</div></div>
    </div>
  </section>

  <!-- ============================ RELEASE NOTES ============================ -->
  <section class="chap" id="release-notes">
    <div class="chap-h"><div class="chap-t">Release notes</div></div>
    <p>Rule changes described above, newest first. A pack built before a change keeps its old behaviour until it is rebuilt.</p>
    <ul class="rn">
      <li>Mapping goldens are stored under the vendor sourcetype, not a format label. The two generic JSON mapping goldens were removed — build 907.</li>
      <li>Two documents: a User guide and this Technical reference; contents links scroll reliably in every browser — build 900.</li>
      <li>OCSF Authorize Session (3003) is a target class; Improve honours explicit class guidance (<code>class_uid=3003</code>); sanitised samples listed in Samples → Library; the wizard names the wire-format break that blocks Apply; keep-raw OCSF pipelines no longer score extraction 0; OCSF <code>status</code> is the caption of <code>status_id</code> — build 896–900.</li>
      <li>Pipeline Visualizer link explains the separate app before opening it (an app cannot read <code>/apps</code>, so it never checks) — build 902.</li>
      <li>Optional JSON null/blank field filter; optional JSON null/blank field filter; <b>Download report</b> on Improvement Complete — build 896.</li>
      <li>Every event gets an extraction: left-behind events get their own parse — build 891.</li>
      <li>A missing number stays missing: <code>|| 0</code> no longer invents ports, bytes or packets — build 889.</li>
      <li>AWS VPC Flow Logs read in all five record layouts, with OCSF cloud and network context — build 888.</li>
      <li>Mail, AAA and directory logs get Email Activity, DNS Activity and Authentication classes — build 887.</li>
      <li>Generated samples checked line by line; a refusal fails the sample — build 886.</li>
      <li>A timestamp counts as one value in coverage — build 885.</li>
      <li>OCSF post-processing puts source values in real destination fields — build 881.</li>
      <li>Documentation entry in the left rail — build 880.</li>
      <li>ECS graded against Elastic's own field list (ECS 9.5.0) — build 870.</li>
      <li>Sentinel SecurityEvent and Syslog goldens; year-less syslog timestamps get the current year — build 842.</li>
      <li>Google SecOps UDM wire-contract caps; SecOps raw (log type) card — build 841.</li>
      <li>Elastic integration card sets the <code>cribl</code> integration contract — build 840.</li>
      <li>Same-category noise rules; destination-aware AI advice — build 833.</li>
      <li>Raw post-processing outputs restore the original event; Splunk metadata contract — build 820.</li>
      <li>Build pack flow destinations: Raw + extracted fields, Splunk raw/JSON, Elastic integration/JSON — build 818.</li>
      <li>Goldens keyed on the canonical sourcetype; post-processing sampled from the main OCSF output — build 815.</li>
      <li>Both OCSF gates bound the staged Mapping score — build 789.</li>
      <li>Source noise reduction on non-OCSF Build pack flow cards — build 788.</li>
      <li>Batch build traces and results export; Full copy ships no lookup CSVs — build 787.</li>
      <li>Optimisation only in post-processing; <code>raw_data</code> excluded from coverage — build 786.</li>
      <li>XSIAM parse conformance — build 707.</li>
      <li>OCSF class-correctness gate; a zero preview must be proven — build 698.</li>
      <li>Custom / Other destination removed — build 687.</li>
      <li>Post-processing targets every CIM model, ASIM schema and Chronicle class — build 686.</li>
      <li>Format-conformance caps; OCSF → any format post-processing — build 684.</li>
      <li>OCSF attribute type check — build 683.</li>
    </ul>
  </section>

  <footer>Cribl Pack Generator${` · build ${v}`} · Technical reference. Mirrors the deterministic logic in the app; stats are computed live from the bundled config. <b>Download</b> saves this page as one self-contained HTML file. See also the ${p(`guide`,`User guide`)}.</footer>
</div>
<a class="totop" href="#contents">&uarr; Contents</a>
<div class="toast" id="toast" role="status"></div>
${m(`pack-generator-reference${`-build-${v}`}.html`)}
</body></html>`;export{C as SCORING_DOC_HTML};