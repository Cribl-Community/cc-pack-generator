// The User guide: a self-contained HTML page that explains how to USE Pack Generator,
// for customers and SEs. Plain language, real UI labels, no build numbers or internal
// names — how the results are produced lives in the Technical reference
// (src/scoring-doc.ts). Both share src/doc-shell.ts and open in a new tab from the
// left rail (openAppDoc in App.tsx).
//
// tests/user-guide-doc-test.mjs checks that every contents link resolves, that every
// mode and tool label the UI exposes (read from src/wizard-steps.ts and
// src/tool-pages.ts) appears here, and that no build number leaks in. Rename a mode
// or tab and this page has to follow.

import { DOC_STYLE, docScript, docLink } from './doc-shell';

const tech = (text: string, hash = '') => docLink('technical', text, hash);

export const USER_GUIDE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pack Generator — User guide</title>
<style>${DOC_STYLE}</style></head><body>
<div class="page">
  <header>
    <div>
      <h1>Pack Generator — <span>User guide</span></h1>
      <div class="sub">How to build, improve and demo Cribl Stream packs with Pack Generator, step by step.</div>
    </div>
    <div class="tools" id="tools">
      <button type="button" id="dl">⤓ Download</button>
      <button type="button" id="pr">🖨 Print / PDF</button>
    </div>
    <div class="badge">Guide</div>
  </header>
  <p class="xref">Want to know how scores are calculated or how a format is mapped? See the ${tech('Technical reference')}.</p>

  <div class="toc" id="contents">
    <b>Contents</b>
    <ol>
      <li><a href="#what">What Pack Generator does</a></li>
      <li><a href="#before">Before you start</a></li>
      <li><a href="#quick">Quick start</a></li>
      <li><a href="#build">Building a pack</a></li>
      <li><a href="#samples">Samples</a></li>
      <li><a href="#scores">Understanding the scores</a></li>
      <li><a href="#improve">Improving an existing pipeline</a></li>
      <li><a href="#batch">Batch and background runs</a></li>
      <li><a href="#demo">Demo environment</a></li>
      <li><a href="#whiteboards">Whiteboards &amp; demos</a></li>
      <li><a href="#visualizer">Pipeline Visualizer</a></li>
      <li><a href="#settings">Settings reference</a></li>
      <li><a href="#faq">Troubleshooting &amp; FAQ</a></li>
      <li><a href="#glossary">Glossary</a></li>
    </ol>
  </div>

  <section class="chap" id="what">
    <div class="chap-h"><div class="chap-n">1</div><div class="chap-t">What Pack Generator does</div></div>
    <p>Pack Generator turns a sample of your log events into a working Cribl Stream pack. You give it events, it works out what the source is, and it builds a pipeline that parses the events and reshapes them for the destination you choose — OCSF, Splunk CIM, Elastic ECS, Microsoft Sentinel and more. It then tests the pipeline on your sample and gives it a score, so you can see how much of your data arrives.</p>
    <p>It uses proven, stored pipelines (<i>goldens</i>) and Cribl's own parsers first. AI is only used where nothing proven fits. AI drafts, you decide: inspect the pipeline steps, check the field mappings and test with real data before you use a pack in production.</p>
    <h2><span class="d"></span>The three modes</h2>
    <p>Pick a mode on <span class="ui">⌂ Home</span> or under <b>Modes</b> in the left rail.</p>
    <table>
      <tr><th>Mode</th><th>Use it to</th></tr>
      <tr><td><b>Build pack flow</b></td><td>Build a new pack for one source and one or more destinations. When OCSF is a destination it can also build post-processing packs for other SIEMs in the same run.</td></tr>
      <tr><td><b>Modify existing pack</b></td><td>Add a pipeline to a pack you already deployed, or improve one of its pipelines.</td></tr>
      <tr><td><b>Batch create</b></td><td>Build many packs and pipelines from one CSV or JSON file, up to 200 pipelines.</td></tr>
    </table>
    <p>Under <b>Tools</b> in the rail you find <b>Samples</b>, <b>Settings</b> and <b>Documentation</b> (this guide and the technical reference). Cribl and partner teams also get <b>Whiteboards &amp; demos</b> there, for discovery boards and the <b>Demo environment</b> built from them (see <a href="#whiteboards">Whiteboards &amp; demos</a>). The chevron next to the logo folds the rail to icons and back; on a narrow window the rail shows icons only.</p>
  </section>

  <section class="chap" id="before">
    <div class="chap-h"><div class="chap-n">2</div><div class="chap-t">Before you start</div></div>
    <ol class="steps">
      <li><b>Set up an AI provider.</b> Open <span class="ui">Settings → AI</span>, choose a <b>Provider</b> and enter its key, then click <span class="ui">Test Connection</span>. Inside Cribl, <b>Cribl AI Settings (this org)</b> uses your organization's own AI configuration and needs no key. You can still build without AI — proven pipelines and Cribl parsers work without it — but sources nobody has seen before need it.</li>
      <li><b>Have a worker group ready.</b> Every mode starts by picking a Stream worker group (or Edge fleet). Demos, background batches and Cribl AI need a group with at least one connected worker.</li>
      <li><b>Check your permissions.</b> Pack Generator creates packs, pipelines, routes and samples in the group, and commits and deploys. You need a Cribl role that allows that in the group you pick.</li>
    </ol>
    <div class="tip"><b>Settings are shared.</b> Settings are stored in the app inside your Cribl organization, so everyone who opens Pack Generator sees the same provider, thresholds and options. API keys are stored encrypted, are never shown again after you save them, and are added to AI requests by Cribl. Enter a key once and it works for everyone.</div>
  </section>

  <section class="chap" id="quick">
    <div class="chap-h"><div class="chap-n">3</div><div class="chap-t">Quick start</div></div>
    <ol class="steps">
      <li>Click <b>Build pack flow</b> and pick your worker group.</li>
      <li>On <b>Source Data</b>, give your own events if you can: paste them into the box (or drop a file on it), or use <span class="ui">Pick a sample in</span> your worker group, <span class="ui">Capture live traffic</span> or <span class="ui">Upload a file</span>, then check the <b>Detected sourcetype</b>. No events at hand? Under <b>Start from a catalog sample</b>, type your source (for example <i>darktrace</i>), click it in the list, then <span class="ui">Load sample and continue</span>: its sample loads and Flow opens. A name the catalog does not know gets a <span class="ui">Generate an AI sample</span> row.</li>
      <li>On <b>Flow</b>, enter a <b>Pack name</b> and click <span class="ui">＋ Add a destination</span> for each place the data goes.</li>
      <li>Click <span class="ui">Build pack</span>. Each stage card fills in with a score as it builds. Then commit and deploy.</li>
      <li>Read the result on <b>Results</b>: it opens with whether the pack is live, <span class="ui">Open pack in Stream</span> and one row per destination with its score and <span class="ui">Open pipeline</span>. The <b>Extraction inspector</b> below shows what was extracted and mapped. Click <span class="ui">⬇ Download report</span> to keep it.</li>
    </ol>
    <p>If you refresh or close the tab before the build finishes, Pack Generator saves your choices. On <b>Home</b>, use <span class="ui">Resume</span> on the draft banner to continue, or <span class="ui">Discard</span> to clear it. A build that was running when you left is not restarted automatically — review and click <span class="ui">Build pack</span> again. The browser <b>Back</b> button from the wizard returns to Home inside the app.</p>
  </section>

  <section class="chap" id="build">
    <div class="chap-h"><div class="chap-n">4</div><div class="chap-t">Building a pack</div></div>
    <h2><span class="d"></span>Source and sourcetype</h2>
    <p>The page opens on <b>Use events from your feed</b>, because the pack is built and scored on the sample: your own events give the most accurate pack. Paste 20 to 200 lines into the box or drop a file on it; the buttons under it pick a sample saved in your worker group, capture live traffic or upload a file. The panel beside the box, <b>How close is the sample to your feed?</b>, and the meter in the bottom bar show what you are building on: your own events, a real vendor sample, or an AI-written one.</p>
    <p>Below it, <b>Start from a catalog sample</b> has a search box over every source Pack Generator knows: a few popular ones shown before you type, the supported catalog and every source with real sample events. Each row says what you get: <b>real sample</b> (real vendor events), <b>golden parser</b> (a proven pipeline, no AI) or <b>AI sample</b>. When nothing matches, the <span class="ui">Generate an AI sample</span> row builds for the name you typed. The button at the bottom always says what it will do next: <span class="ui">Load sample and continue</span>, <span class="ui">Generate sample</span> or <span class="ui">Next: Flow</span>. Generated events are never moved past without you: review them, then click <span class="ui">Next: Flow</span>. <span class="ui">Restart</span> is in the top bar. A catalog sample shows a warning that it is not your feed: fields only your feed sends will not be parsed, and the score measures that sample. <span class="ui">Paste my own events instead</span> (or <span class="ui">Use my own events</span> in the bottom bar) takes you back to the paste box.</p>
    <p>With your own events, give the events first; the sourcetype is detected from them. If the detection is wrong, type the correct name under <b>Not right? Enter the correct sourcetype</b> and click <span class="ui">Use this</span>. If nothing is detected, enter it under <b>Enter the sourcetype manually</b> and click <span class="ui">Confirm</span>. Close matches are suggested as you confirm; a ★ means a proven pipeline exists for it.</p>
    <p>Some sources ship in several formats (for example key=value, JSON or CEF). When you generate events instead of loading real ones, you are asked <b>Which format does your data use?</b> — pick the one your feed really emits.</p>
    <p><b>Allow Code functions</b> (under <b>Build options</b>) is off by default. Leave it off unless you are happy to deploy Code functions.</p>
    <h2><span class="d"></span>Samples matter most</h2>
    <p>The pipeline is written and scored against your sample, so a real sample from your own feed gives the best pack. A <b>Reference sample (recommended)</b> — real events from an official Cribl pack — is the next best. AI-generated events are a last resort. See <a href="#samples">Samples</a>.</p>
    <h2><span class="d"></span>Destinations</h2>
    <p>On the flow step, click <span class="ui">＋ Add a destination</span>. The picker lists the Cribl Lake options first (OCSF 1.9, Passthrough (raw copy), Raw + extracted fields), then the analytics tools: Splunk (CIM, JSON, Raw), Elastic (ECS, JSON, Raw), Microsoft Sentinel (native table or ASIM), Google Chronicle UDM, Google SecOps raw (log type), CEF format, CrowdStrike NG SIEM (vendor parser), PaloAlto Cortex XSIAM and Clean JSON. Each destination becomes its own pipeline in the pack, scored on its own.</p>
    <ul>
      <li><b>How should we send it?</b> <span class="ui">Full fidelity</span> sends every event. <span class="ui">Optimize</span> drops known-noise events with rules from Cribl's packs; you can untick rules (they still ship, switched off).</li>
      <li><b>Keep original _raw</b> (OCSF, on by default) keeps the untouched event in the OCSF <code>raw_data</code> field. Raw outputs built from OCSF use it to send the original event.</li>
      <li>Sentinel, Splunk CIM and ASIM ask which table, data model or schema you want. Pick the one your analysts use.</li>
    </ul>
    <h2><span class="d"></span>Post-processing packs</h2>
    <p>With OCSF as a destination, click <span class="ui">＋ Add an output format</span> to also build packs that reshape the OCSF output for another SIEM (Splunk, Elastic, Sentinel, CEF). Choose <span class="ui">Full copy</span> to keep everything, or <span class="ui">Optimize by category</span> to add the OCSF noise-reduction rules. Each output is its own pack.</p>
    <h2><span class="d"></span>Reading the result</h2>
    <p>During the build, the <b>Main pack</b> cards show the stages <b>Extract</b>, <b>Map</b> and <b>Shape</b>, followed by the post-processing packs, <b>Commit &amp; deploy</b> and the <b>Build log</b>. The finished <b>Results</b> page first says whether the pack is live: built, committed and deployed (or why the deploy failed), and scored. <span class="ui">Open pack in Stream</span> opens it in Cribl, and each destination row has <span class="ui">Open pipeline</span>. Below, the <b>Extraction inspector</b> has a tab per pipeline with:</p>
    <ul>
      <li>the <b>Average score</b> and a card for each stage, with where it came from (🏆 golden, 🔍 Search datatype, 🐐 Copilot schema, 🤖 AI-generated, ⚙ built-in);</li>
      <li><b>Raw in</b>, <b>Extraction</b> (the fields pulled out), <b>Mapping</b> (input fields side by side with the output, including what was dropped or added) and <b>Output event</b>;</li>
      <li><b>Pipeline statistics</b> from Cribl: processing time, throughput, events in and out.</li>
    </ul>
    <p>To add a pipeline to a pack later, use <b>Modify existing pack</b> → <span class="ui">Add a new pipeline</span>.</p>
  </section>

  <section class="chap" id="samples">
    <div class="chap-h"><div class="chap-n">5</div><div class="chap-t">Samples</div></div>
    <h2><span class="d"></span>Where samples come from</h2>
    <p>Pack Generator always prefers real logs: your own events first, then real reference logs and vendor test data, and AI-generated events only when nothing real exists. A short real sample is topped up with generated events that copy its exact shape; the extra events are only used for that build.</p>
    <h2><span class="d"></span>Adding your own</h2>
    <ul>
      <li><span class="ui">Upload file</span> — a .log, .txt, .json, .ndjson, .csv or .xml file, one event per line. It stays in your browser.</li>
      <li><span class="ui">Group sample</span> — a sample already in the worker group, including samples inside installed packs. Each shows its wire format; pick one that matches your real feed.</li>
      <li><span class="ui">Paste events</span> — one event per line, or a JSON array.</li>
      <li><span class="ui">Live capture</span> — capture events flowing through the group: set a filter (<code>true</code> for everything), the maximum number of events (up to 500) and the duration (up to 30 seconds).</li>
    </ul>
    <h2><span class="d"></span>The Sanitizer, step by step</h2>
    <p>Your own events are real data. The Sanitizer replaces hostnames, user names, IP addresses, credentials and other identities with consistent stand-ins, while keeping the events parseable. Everything happens in your browser: no upload and no AI call. Open it from <span class="ui">Samples → Sanitize</span> (<span class="ui">Sanitize a sample</span>) or with <span class="ui">Sanitize sample</span> on the source step.</p>
    <ol class="steps">
      <li><b>Events</b> — choose <span class="ui">Upload file</span>, <span class="ui">Group sample</span>, <span class="ui">Paste events</span> or <span class="ui">Live capture</span>. Live capture shows events as they arrive; click <span class="ui">Stop</span> when you have enough. Click <span class="ui">Identify source</span>.</li>
      <li><b>Source</b> — confirm the sourcetype. The detected sourcetype is shown as in the Pack Generator: the name, its confidence and why it was chosen; type another name under <i>Not right?</i> to override it. The page says how many lines the source's parser reads. If no parser recognises it, values are only found by their shape and the save may be blocked.</li>
      <li><b>Sanitize</b> — review the replacements (see below), then click <span class="ui">Apply and verify</span>.</li>
      <li><b>Save</b> — choose where the sanitised copy goes: <span class="ui">Add to library</span> (reusable by Pack Generator), <span class="ui">Upload to worker group</span> (also usable by Stream itself), <span class="ui">⤓ Download .log</span>, or the shared pool where that is set up. You can also download a report and an evidence file. Inside Cribl, if the sample could only be saved in this browser, you see a warning instead of a tick — download it so it is not lost.</li>
    </ol>
    <h3>Reviewing replacements</h3>
    <ul>
      <li>Findings are grouped — <b>probable credentials</b>, <b>personal and device identifiers</b>, <b>addresses</b>, <b>machine names</b>, <b>accounts</b>, <b>other values</b> — and folded. Open a group to see each original value and its replacement; you can edit a replacement or untick a value.</li>
      <li><b>Suggestions</b> are matched on shape alone, so they start unticked. Tick only the ones that are real.</li>
      <li>The <b>before</b> pane highlights what will change. To add something it missed, drag over it (double-click picks a word). Choose whether to mask the whole value or a piece, and whether to match this exact text or any value like it, then click <span class="ui">Mask it</span>. Landing inside a <code>field=value</code> pair offers every value of that field. You can also <span class="ui">Write your own regex</span> or type picks under <b>Or type them</b>.</li>
      <li>Business identifiers such as order or invoice numbers, and product names, are left alone unless you pick them.</li>
    </ul>
    <h3>What the warnings mean</h3>
    <dl>
      <dt>Probable credentials</dt><dd>A password, key or token was found. It is scrambled so the sample still parses, but that does not revoke anything — rotate the original.</dd>
      <dt>Red highlights</dt><dd>A mask would break the format. Narrow the pick, mask the value only, or untick it.</dd>
      <dt>"… still shows through unchanged"</dt><dd>A parsed identity was not covered. The lines are listed; mask them and apply again.</dd>
      <dt>Apply is refused because the wire format broke</dt><dd>A replacement made a JSON line stop parsing, changed its field names, or moved a delimiter or whitespace boundary. The banner says which, the entries causing it are marked red, and the banner clears as soon as you untick them.</dd>
      <dt>"The parser could not prove that identifying field values changed"</dt><dd>No parser reads this source, so the library cannot confirm it is safe to store. Check the sourcetype.</dd>
      <dt>"… the parser no longer reads them"</dt><dd>Sanitising changed the events enough that the source's parser fails. In the pack wizard this is only a warning; you can build anyway or <span class="ui">Undo sanitise</span>.</dd>
    </dl>
    <h2><span class="d"></span>The Samples pages</h2>
    <ul>
      <li><b>Sanitize</b> — start the Sanitizer and see the samples you sanitised, with <span class="ui">.log</span>, <span class="ui">Evidence JSON</span> and <span class="ui">Remove</span>.</li>
      <li><b>Review queue</b> — promote or reject generated samples (when running on your own machine).</li>
      <li><b>Library</b> — committed and sanitised samples. Sanitised ones carry a green <b>Sanitised</b> label and a <span class="ui">.log</span> download; remove them on the Sanitize tab.</li>
      <li><b>Sharing</b> — <b>Require sanitised samples before any AI call</b>. With this on, your own events are never sent to the AI provider until you sanitise them; reference and generated samples are not affected.</li>
    </ul>
  </section>

  <section class="chap" id="scores">
    <div class="chap-h"><div class="chap-n">6</div><div class="chap-t">Understanding the scores</div></div>
    <p>A score answers one question: <b>of the information in your sample, how much reached the destination?</b> Fields your source never has cannot lower it, so a simple source captured completely scores 100. Scores are calculated from real Cribl preview output, never by the AI.</p>
    <div class="bands">
      <span class="band g">85–100 · Good</span>
      <span class="band w">60–84 · Needs review</span>
      <span class="band f">0–59 · Broken</span>
    </div>
    <ul>
      <li><b>Extraction</b> — how many values were pulled out of the raw event into fields.</li>
      <li><b>Mapping</b> — how well those fields landed in the destination schema. <b>N/A</b> when there is no schema (JSON, raw copies).</li>
      <li><b>Output shaping</b> (shown as Optimization in reports) — whether the final cleanup kept what mapping produced.</li>
    </ul>
    <p>A score can be capped when the output does not have the shape the destination needs — for example an OCSF event in the wrong class, or an XSIAM source that is not recognised. The reason is shown on the card. The ${tech('Technical reference, chapter 7', 'ch7')} explains every rule.</p>
  </section>

  <section class="chap" id="improve">
    <div class="chap-h"><div class="chap-n">7</div><div class="chap-t">Improving an existing pipeline</div></div>
    <ol class="steps">
      <li>Choose <b>Modify existing pack</b>, the group and the pack, then <span class="ui">Improve an existing pipeline</span> and the pipeline.</li>
      <li>On <b>Improvement Goals</b>, check the sourcetype and destination format. Choose your goals: <b>New or updated sample</b>, <b>Improve extraction</b>, <b>Improve mapping</b>. A higher goal includes the ones below it.</li>
      <li>Optionally add <b>Additional guidance</b> (see tips below).</li>
      <li>Click <span class="ui">Score &amp; Improve</span>. The current pipeline is scored first, then better candidates are tried.</li>
    </ol>
    <p>A candidate replaces your pipeline only if it scores at least as well. If nothing does, you see “No candidate beat the deployed baseline” and nothing is changed. The <b>Improvement Complete</b> screen compares <b>Current</b> and <b>After improvements</b>, lists what was tried, and shows values that were extracted but not kept, or never extracted. Click <span class="ui">⬇ Download report</span> to save the before/after result as an HTML page.</p>
    <div class="tip"><b>Guidance tips.</b> Keep it short and specific: “keep vendor_action”, “fix _time”, “do not drop ACL names”.<br><b>Moving an OCSF pipeline to another class.</b> Name the class in one of these ways: <code>class_uid=3003</code>, <code>class 3003</code>, “map to Authorize Session”, “use the OCSF Authorize Session class” or “Authorize Session (3003)”. Add <code>activity_id=1</code> to set the activity as well. Just mentioning a class in passing (“keep the authentication fields”) does not change the target.<br>A new mapping in the class you asked for is kept unless it scores more than 5 points below your current one, because a stricter class can cost a few points at first. This applies to the mapping step only, and only when your pipeline does not already use that class. Either way, <b>Improvement Complete</b> says what happened, for example “Accepted per your guidance: the 3003 mapping scored 74 vs 77 for 0 (Base Event)”, or why the current mapping was kept.</div>
  </section>

  <section class="chap" id="batch">
    <div class="chap-h"><div class="chap-n">8</div><div class="chap-t">Batch and background runs</div></div>
    <ol class="steps">
      <li><b>Upload</b> a CSV or JSON file with one row per pipeline. Required columns: <code>sourcetype</code>, <code>pack_name</code>, <code>pipeline_name</code>, <code>dest_format</code>; optional: <code>route_name</code>, <code>filter</code>. Rows with the same pack name become one pack. A file with more than 200 pipelines keeps the first 200 and ignores the rest. Fix or remove invalid rows, then <span class="ui">Continue to check</span>.</li>
      <li><b>Check sourcetypes and samples.</b> Confirm each row's sourcetype (suggestions come from the sample, the AI, proven pipelines and close names). Use <span class="ui">⇪ Add sample</span> to give a row its own events, a library sample or a saved sanitised sample. Rows without a sample get one at build time. <span class="ui">Download corrected CSV</span> saves your fixes.</li>
      <li><b>Where it runs.</b> Inside Cribl there is one way to run: on the worker group, one pack at a time. You can close the tab. The app does not ask for an AI provider or how many pipelines to build at once. Outside Cribl, you choose the AI provider and how many pipelines to build at once, and the build stays in this browser. A batch that is still open has to be dismissed before another starts; that message appears as soon as you choose <span class="ui">Batch create</span>.</li>
      <li><b>Ready to start.</b> Check the summary and the estimate. For packs that already exist, choose <b>Overwrite</b>, <b>Skip</b>, <b>Repair</b> (improve the weak parts) or <b>Scorecard</b> (only score it). Then start.</li>
    </ol>
    <p>While it runs, <span class="ui">■ Stop</span> lets rows in progress finish; <span class="ui">✖ Kill</span> abandons them and commits nothing. When it is done, open <span class="ui">View scoring report</span>, filter rows <b>Below 85</b>, use <span class="ui">✦ Improve all N below 85</span>, or <b>Export</b> the results as CSV or JSON, the log or all build traces. To get back to a background run, use <span class="ui">View progress</span> on the banner.</p>
    <p>For a source the vendor field library knows, batch drops <code>||</code> fallbacks that name fields that source does not carry. The field lists are generated from each source's parser and bundled sample. The score is of the generated pipeline. The shorter one ships when the sample comes out the same; otherwise the generated pipeline ships and the log says why.</p>
  </section>

  <section class="chap" id="demo">
    <div class="chap-h"><div class="chap-n">9</div><div class="chap-t">Demo environment</div></div>
    <p>Demo environment is for Cribl and partner teams. Start it from <span class="ui">Whiteboards &amp; demos</span>: <span class="ui">Deploy demo</span> on a board, or <span class="ui">New demo by hand</span> in the <b>Demos not made from a whiteboard</b> section, under the boards, for one without a board.</p>
    <p><b>Create:</b> pick a group with a connected worker, add the demo sources, choose destinations (one pack per format) and the routing destination (<code>devnull</code> by default). Click <span class="ui">Create Demo Environment</span>. Live generated data starts flowing on isolated routes, ending in a route that drops the demo data.</p>
    <p><b>Stop, start or destroy one demo:</b> see <a href="#several-demos">Running several demos</a>. <b>Clean up</b> by hand: on the sources step, click <span class="ui">Clean up demo environment</span>, tick what to remove (routing, datagen sources, packs, Lake outputs) and click <span class="ui">Remove N selected</span>. Items are removed in a safe order.</p>
  </section>

  <section class="chap" id="whiteboards">
    <div class="chap-h"><div class="chap-n">10</div><div class="chap-t">Whiteboards &amp; demos</div></div>
    <p>A whiteboard is the discovery board you draw with a prospect: what hurts today and what it becomes with Cribl, their goals, the sources they collect and the tools they send data to, on the Cribl platform picture. Open <span class="ui">Whiteboards &amp; demos</span> under <b>Tools</b> in the rail. One row per prospect, read across: who it is, the board (a small picture of it, then Open), the architecture (how many parts are on it, then Open or Draw it), and the demo. The bin on a row deletes that board; <span class="ui">Undo</span> in the message brings it back for a few seconds.</p>
    <p>It is for Cribl and partner teams, so it stays hidden until you turn it on: the <b>Whiteboards &amp; demos</b> switch in <span class="ui">Settings → Menu</span>. The switch applies at once.</p>
    <h2><span class="d"></span>Drawing and saving</h2>
    <ul>
      <li><span class="ui">New whiteboard</span> asks how the board starts: <span class="ui">Start empty</span> (no sources and no destinations; each empty row shows <span class="ui">+ Add to …</span>) or <span class="ui">Start with the usual estate</span> (the common sources and destinations already drawn, to remove what the prospect doesn't run). An empty board has none of Cribl's own stores either (Cribl Lake, the Lakehouse Engine, Cribl Detect): add the ones the prospect needs with <span class="ui">+</span>. The usual estate starts with them. The <b>People</b> row (who uses the data: SOC analysts, threat hunters, SREs, developers) is hidden on a new board: <span class="ui">+ People</span> on the right of the board shows it, <span class="ui">− People</span> hides it again, and the board keeps your choice. Then type the prospect's name at the top and click <span class="ui">Logo</span> next to it: the app looks the company up by that name on Wikidata and shows its official logos, each with what Wikidata says the company is (so you pick the telecom Orange, not the town). Click one and it is on the board. Nothing is sent until you open that dialog. If the company is not there, type their website for its icon, or <span class="ui">Upload an image</span>.</li>
      <li>To add something, press <span class="ui">+</span> on its row, pick a suggestion or type a new name, and press the <span class="ui">Add “…”</span> button under the fields (or Enter).</li>
      <li>Discovery happens on the board, while you draw. When the prospect says what hurts, press <span class="ui">Pain</span> (the search button) in the toolbox, or <span class="ui">/</span> on the board, and type their words: “our SIEM licence is too expensive” finds <b>Costly SIEM ingestion</b>. Each result shows what it becomes with Cribl, its positive business outcomes (each one <b>Operational</b>, <b>Financial</b> or <b>Strategic</b>). Enter or a click puts it on the board; on one that is already there it takes it off. Words that match nothing become your own situation, the way a new source is added from <span class="ui">+</span>: a form opens under the list for its positive business outcomes (<span class="ui">+ Outcome</span> adds another, each <b>Operational</b>, <b>Financial</b> or <b>Strategic</b>), the layer that solves it, where it lands and its kind. Press <span class="ui">Add “…”</span> (or Enter in any field); it goes on the board and stays in your library for every board.</li>
      <li>A picked situation is a red <b>pain</b> in the left lane, beside the part of the estate it hurts, with a red sticker there. When you show the Cribl layer that solves it (most often the pipeline; long investigations and short retention are solved by Search, AI agents stuck in silos by AI), the card turns green: its outcomes in bold and the pain struck through above them, so the prospect sees what was fixed. The × on a card takes it off the board. <span class="ui">$</span> in the toolbox hides the whole lane for a clearer drawing.</li>
      <li><span class="ui">+ Security goals</span> and <span class="ui">+ Observability goals</span> under the board open two sections for what the prospect wants to achieve, in their own words. Security has four pillars side by side: <b>Compliance</b>, <b>Detection</b>, <b>Investigation</b> and <b>Response</b>; observability has <b>Availability &amp; SLOs</b>, <b>Troubleshooting</b>, <b>Performance</b> and <b>Cost control</b>. <span class="ui">+ Initiative</span> adds an initiative, such as “SIEM migration” (Enter starts the next one, Shift+Enter is a new line); click a pillar's name to rename it, × removes it, <span class="ui">+</span> in the section's header adds one, and the columns share the width. <span class="ui">−</span> hides a section and keeps its initiatives. Exports show the initiatives, without empty sections or buttons.</li>
      <li>In <span class="ui">Configure and style</span>, each situation has its badge, icon, where it lands, the layer that solves it, its tooltip, its outcomes (<span class="ui">+ Outcome</span> adds one, each with its family) and the words prospects use for it, which the search reads. A new situation at the bottom takes the same, with as many outcomes as you need. Changes are yours and apply to every board.</li>
      <li><span class="ui">Whiteboard</span> and <span class="ui">Architecture</span> in the board header switch what the editor shows. While a board is open the app's left menu folds to icons, and it comes back when you return to the list. <span class="ui">EN</span> in the board header is the board's language: hover it to pick French, German or Spanish (or press L on the board). The board starts in English and keeps your choice for every board.</li>
      <li>On the drawing, <span class="ui">+</span> and <span class="ui">−</span> on the right show or hide Pipeline, Search and AI (keys 1, 2, 3; ← → walk the four steps). The toolbox stays in the bottom-right corner of the screen, wherever you scroll. It starts with the arrows: <span class="ui">Clean</span>, <span class="ui">Auto</span> or <span class="ui">Manual</span>. Then <span class="ui">Pain</span> opens the search for what hurts, and <span class="ui">$</span> hides or shows the situations and their outcomes, for a clearer view; then <span class="ui">Configure and style</span> (the gear), <span class="ui">Back to step 1</span> (or 0), <span class="ui">Cribl product names</span> on or off (or C), and <span class="ui">Fit to screen</span> (or Z). Point at a button to see what it does.</li>
      <li>Arrows join one item to another: a source, a destination, a person, an agent. They always leave from the top or the bottom of an item, never its side. Drag from one item to another to draw one, at any time. Click an arrow to label it, colour it, bend it left or right by its middle handle, or delete it. Drag a box on an empty part of the board to select every arrow it touches, then press Delete (or <span class="ui">×</span>) to remove them all; <span class="ui">Undo</span> brings them back.</li>
      <li><span class="ui">Clean</span>, the default on a new board, draws one wide arrow from layer to layer: from the data sources to the data stores, or, with the pipeline shown, into the pipeline and out again with one arrow into each store family: point tools, Cribl and platforms. The flow reads at first glance; switch to <span class="ui">Auto</span> when you want it item by item.</li>
      <li>With <span class="ui">Auto</span>, the board draws the arrows of each story step for you. Before the pipeline, each source curves to its tools. Show the pipeline and the lines end in Stream and start again from Stream to every destination. Unified search and Unified AI do the same through Search and MCP. Hide the pipeline and the lines curve again. These arrows are like the ones you draw: delete the ones that don't fit, edit them, or draw more. A deleted one stays deleted on that board; draw it again to bring it back. <span class="ui">Manual</span> shows only the arrows you drew.</li>
      <li>P on the board fills the screen with it, without its editing controls, fitted under the prospect's name. <span class="ui">Exit presentation</span> or Esc brings you back; the board's own Fit setting is left as it was.</li>
      <li>The board is the same whiteboard SEs use on calls: its themes and keyboard shortcuts work while you are on the board.</li>
      <li>Every change is saved automatically. The header says <b>Saved</b>; if a save fails it says <b>Not saved</b> with the reason and a <span class="ui">Retry</span>, and the board keeps your changes while it tries again.</li>
      <li>Your own entries and your Configure choices are shared by all your boards. Each board keeps its own prospect, logo, items, selections and arrows.</li>
      <li>On the list, prospect names start hidden behind their first two letters (and logos are not shown), so a shared screen on a call shows no customers. <span class="ui">Show names</span> reveals them until you leave the list. <span class="ui">Sort by</span> orders the boards by last edited, date created or name.</li>
    </ul>
    <h2><span class="d"></span>Architecture</h2>
    <p><span class="ui">Architecture</span>, the second tab in the board header (next to <span class="ui">Whiteboard</span>) (or <span class="ui">Draw it</span> on the board's row), is where you draw the Cribl deployment you propose: the leader, worker groups, Edge fleets, Lake, Search and Detect, the prospect's sources and destinations, and the lines between them, in the style of the reference architectures on docs.cribl.io.</p>
    <ul>
      <li><span class="ui">Draw it from the whiteboard</span> (on an empty drawing, or under <span class="ui">Start from</span>) starts from what is on the prospect's board: its sources feed a worker group, its tools and data platforms are the destinations, an Edge agent becomes an Edge fleet, and Cribl Lake, the Lakehouse Engine and Cribl Detect bring their Cribl parts when you put them on that board (a new board shows Lake and the Lakehouse Engine by default; those alone don't count), as does the Search layer. Then change it as you need; the whiteboard itself is not changed. Anything with no part on the architecture is named in the message.</li>
      <li>An empty drawing also offers five starting points: <span class="ui">Distributed agents</span>, <span class="ui">Hybrid cloud</span>, <span class="ui">Edge to Stream</span>, <span class="ui">Full suite</span> and <span class="ui">Empty canvas</span>. <span class="ui">Draw this Cribl org as it runs now</span> reads this org's worker groups, Edge fleets and connected workers and draws them, Cribl-managed groups in Cribl Cloud and customer-managed ones on-prem. At most five nodes are drawn per group; the name says how many there are. <span class="ui">Start from</span> in the toolbar offers the same later; it replaces the drawing, and Undo brings it back.</li>
      <li>Drag a part from the left onto the canvas, or click it to add it in the middle. Worker nodes go in a worker group, Edge nodes in a fleet and engines in Cribl Search: drop one on empty canvas and the right container is made for it. Drag a worker or Edge node onto another group to move it.</li>
      <li>Parts bring what they need, and a message says what was added: a leader comes with the user and, in Cribl Cloud, the external git repo; a customer-managed leader with high availability adds the load balancers, and the groups connect through the network load balancer. A worker group without a leader brings one; Cribl Detect brings Cribl Search with a lakehouse engine for security data. Parts you placed yourself are never removed.</li>
      <li>Sources sit in their panel: <span class="ui">+ Add a source</span> opens a list you can search. Each destination is its own teal oval, with the name under it, not grouped in a box. An analytic tool is the gray card with the magnifier; a data lake is a teal oval with the stack of disks. Drop <span class="ui">Destination</span> from the palette and pick a name, or type one that isn't in the list.</li>
      <li>Lines: teal is control (port 4200), black dotted is data, grey dotted is optional. When Cribl has a default port for that traffic, the line shows it — <code>TCP/4200</code> from the leader to a worker group or Edge fleet, <code>TCP/9997</code> for a Splunk UF, <code>TCP/9514</code> for syslog, <code>TCP/9100</code> for Prometheus or node exporter. A line with several known ports lists them. Type a second line to replace the port. Every line is straight or has right-angled corners, and goes around the other parts. To connect two parts, hover one: a dot shows on each side. Press the dot of the side the line should leave by, then release on the other part (or click it): the line enters by the side nearest where you let go, or by the dot you release on. For a line of your own, press <span class="ui">Line</span> (L): click to start, click to add a corner, click a part or double-click to finish, Esc to cancel. Click a line to set its type, label and second line; drag the square on it to move its corner.</li>
      <li>Scroll or swipe moves the canvas; Ctrl or ⌘ with scroll, or a pinch, zooms. <span class="ui">Fit</span> (Z) shows everything, <span class="ui">Tidy</span> lines parts up on a grid, Delete removes what is selected, and ⌘Z / Ctrl+Z undoes (⇧⌘Z or Ctrl+Y redoes). <span class="ui">Present</span> shows the drawing alone; Esc comes back.</li>
      <li>The customer's logo from the whiteboard sits at the top of the drawing when the whiteboard has one. <span class="ui">Export</span> downloads that drawing, logo included, as PNG, PDF or SVG. The board's JSON file includes the drawing, so it moves to another org with the board; duplicating a board copies it too. It is saved automatically with the board, like everything else.</li>
    </ul>
    <h2><span class="d"></span>Sharing with the prospect</h2>
    <p><span class="ui">Export</span> → <span class="ui">PNG image</span> or <span class="ui">PDF document</span> downloads the board as the prospect sees it, without the editing controls. It is in the board header; <span class="ui">Export PNG</span> and <span class="ui">Export PDF</span> are also under <span class="ui">More</span> on each row of the list, so you can export a board without opening it.</p>
    <h2><span class="d"></span>Deploying the demo</h2>
    <p>When you know what to show, press <span class="ui">Deploy demo</span> on the board or on its row. Nothing is written to Cribl until the last step, <span class="ui">Deploy</span>. The check screen, <b>what we can demo</b>, puts each source and destination drawn on the board beside what Pack Generator will build:</p>
    <ul>
      <li>Sources become sourcetypes, with <b>Sample ready</b> or <b>AI-generated at deploy</b> next to each. "Microsoft" or "Okta" offer the matching sources; <i>Syslog</i>, <i>Kafka</i> and other transports ask for the source behind them.</li>
      <li>Destinations become formats. Elastic becomes Elastic raw (the events as sent, for the Elastic integration to parse); ECS is one click away. A tool with no format of its own gets a suggestion you accept: Sekoia → Elastic ECS (Elasticsearch-compatible API), OpenSearch → Elastic JSON, QRadar → CEF. <span class="ui">Change format…</span> offers only that destination’s formats, as the pack flow does: Splunk shows CIM, JSON, Raw and CSV; Sentinel its native table or ASIM. A line nothing matched lists every format, by destination.</li>
      <li><b>Cribl Lake</b> creates a Lake dataset (default <code>demo_&lt;prospect&gt;</code>, kept 30 days) and a Cribl Lake destination; the OCSF copy of each source goes there. Its <span class="ui">Format</span> picker switches that to Passthrough (raw copy) or Raw + extracted fields. An existing dataset with that id is reused, never changed. Tick <span class="ui">Also build a Cribl Search dashboard on this dataset</span> and the raw events with their extracted fields go there instead (unless you picked a format), and the demo ends with a Cribl Search dashboard over that dataset.</li>
      <li>Change any line, add a second source to it, or <span class="ui">Leave out of the demo</span>. <span class="ui">Remember for next time</span> keeps what you changed for the same words on your other boards.</li>
      <li>A line nothing matched offers <span class="ui">Ask AI for a match</span> (sources) or <span class="ui">Ask AI which format</span> (destinations). The AI only suggests names the app supports; click a suggestion to use it. Only the words on that line are sent.</li>
      <li>The demo takes 5 sources and 3 formats; the bar at the bottom says what is left to settle.</li>
    </ul>
    <p><span class="ui">Continue to worker group</span> opens <b>Demo environment</b> with everything filled in. Nothing is written to Cribl until you press <span class="ui">Create Demo Environment</span>. Each whiteboard's demo has its own names, so several prospects' demos run on one worker group side by side; a group's tile lists the ones already there. A demo made by hand in <b>Demo environment</b> keeps the classic names and never touches a whiteboard's. The whiteboard list then shows where each board's demo runs, and <b>Demo out of date</b> once the board changed after it. In demo cleanup, <span class="ui">Select one demo</span> ticks everything that belongs to one whiteboard (or to the demo made by hand); it also offers to delete that board's Lake dataset (off by default).</p>
    <h2 id="several-demos"><span class="d"></span>Running several demos</h2>
    <p>The page checks every Stream worker group for demos when it opens; <span class="ui">Check again</span> reads them again. Each demo shows its worker group, what it shows (sources → formats), its events a second, and whether it is <b>Running</b>, <b>Stopped</b> or <b>Partly running</b>. A prospect with demos on two groups has two lines, each with its own buttons:</p>
    <ul>
      <li><span class="ui">Stop</span> turns that demo's data generators off and deploys the group. Its packs and routes stay, so <span class="ui">Start</span> brings it back in seconds.</li>
      <li><span class="ui">Destroy</span> removes that demo's routes, data generators and packs from its group, after a confirmation that lists them. The other demos on the group keep running and customer routes are not touched. When it was the last demo on the group, the shared route that drops demo data goes too. A demo with a Lake dataset offers to delete it as well (off by default).</li>
      <li>A demo a board remembers but that is no longer on its group (removed outside the app) says <b>Not found</b>; <span class="ui">Mark as removed</span> updates the board.</li>
    </ul>
    <p><b>Demos not made from a whiteboard</b>, under the list, are the ones made by hand in Demo environment, or whose whiteboard is not in this app (deleted, or kept in another browser — outside Cribl, boards are kept per browser). They stop, start and go the same way.</p>
    <h2><span class="d"></span>Moving a board to another Cribl org</h2>
    <p><span class="ui">Export</span> → <span class="ui">JSON file</span> in the board header (or <span class="ui">Export JSON</span> under <span class="ui">More</span> on its row) downloads the board. On the other org, open Whiteboards &amp; demos and use <span class="ui">Import saved whiteboard</span>. The board opens as it looked: the same sources, destinations, selections, arrows and logo, and your own entries on it are added to the library there. Its check against the app comes with it. Its demos do not, because they belong to this org's worker groups: generate the demo again there.</p>
    <h2><span class="d"></span>Boards you saved before</h2>
    <p><span class="ui">Import saved whiteboard</span> takes a <code>.html</code> file saved by the standalone whiteboard and makes it a board here. Your own entries from that file are added to your library; nothing you already have is changed. A library copied from <span class="ui">Configure</span> as JSON can be imported the same way.</p>
    <p>Inside Cribl, boards are kept in the app's own storage on your Cribl organization. When you run Pack Generator locally, they are kept in your browser.</p>
  </section>

  <section class="chap" id="visualizer">
    <div class="chap-h"><div class="chap-n">11</div><div class="chap-t">Pipeline Visualizer</div></div>
    <p><span class="ui">🔗 Open in Pipeline Visualizer</span> on a report draws the pipeline as a diagram. Pipeline Visualizer is a <b>separate Cribl app</b>, and Cribl does not let Pack Generator check whether it is installed. So clicking the link first shows a short note; click <span class="ui">Open Pipeline Visualizer</span> in it to go there. If the app is not installed, Cribl shows a “sufficient permissions” page — that means the app is missing, not that you lack rights. Ask your Cribl Solutions Engineer for the app, then install it under <b>App Platform → Add App</b>. The link only appears when Pack Generator runs inside Cribl.</p>
  </section>

  <section class="chap" id="settings">
    <div class="chap-h"><div class="chap-n">12</div><div class="chap-t">Settings reference</div></div>
    <table>
      <tr><th>Tab</th><th>What you set there</th></tr>
      <tr><td><b>AI</b></td><td><b>Provider</b> and its key, the <b>Default model</b>, <b>Normal-flow model</b> (builds) and <b>Repair-flow model</b> (second opinion when a stage scores low). <span class="ui">Test Connection</span> saves and tests.</td></tr>
      <tr><td><b>Connection</b></td><td>Only when running outside Cribl: the Cribl Cloud login and score logging.</td></tr>
      <tr><td><b>Quality</b></td><td><b>Golden thresholds</b> for Extraction, Mapping and Output shaping (default 80): a stage that scores at least this is stored as a proven pipeline. <b>Drop null and blank fields when parsing JSON</b> (off by default): new builds leave out top-level JSON fields that are null or empty (0 and false are kept). The <b>Reference</b> button opens the technical reference.</td></tr>
      <tr><td><b>Goldens</b></td><td>The shared pool of proven pipelines: <span class="ui">Import all</span> new or better ones, and publishing (outside Cribl only). <span class="ui">Test GitHub access</span> checks the connection. Under <b>Vendor field lists</b>, the same pool offers field lists per source type that someone checked against the vendor documentation; <span class="ui">Import all</span> keeps them on this install and performance mode uses them from the next build. Field names your own builds see are never shared.</td></tr>
      <tr><td><b>Datatypes</b></td><td>Compares the Cribl Search datatypes in your group with the parsers the app knows; <span class="ui">Sync</span> imports the difference.</td></tr>
      <tr><td><b>Menu</b></td><td>The <b>Whiteboards &amp; demos</b> switch: shows it under Tools in the rail, for Cribl and partner teams. Hidden until you turn it on; it applies at once, without Save.</td></tr>
    </table>
    <p>The sample privacy rule is under <span class="ui">Samples → Sharing</span>. A red dot on <b>Settings</b> in the rail means the AI connection needs attention.</p>
  </section>

  <section class="chap" id="faq">
    <div class="chap-h"><div class="chap-n">13</div><div class="chap-t">Troubleshooting &amp; FAQ</div></div>
    <dl>
      <dt>My settings disappear in Safari, Brave or a private window.</dt>
      <dd>Fixed: settings are now stored in the app inside Cribl, not only in the browser, so privacy settings no longer wipe them. If a colleague changed a setting and you still see the old value, open Settings and save again.</dd>
      <dt>I don't see my samples.</dt>
      <dd>On <span class="ui">Group sample</span>, check you picked the right worker group and click <span class="ui">Load samples</span>. Samples you sanitised appear under <span class="ui">Samples → Sanitize</span> and <span class="ui">Samples → Library</span>; in a batch, under <b>Saved sample</b>. Samples you uploaded to a group appear under <span class="ui">Group sample</span>.</dd>
      <dt>I get a permission or "not found" error when deploying.</dt>
      <dd>Your Cribl role must allow creating packs, routes and samples, and committing and deploying in that group. Ask your Cribl admin. If pipelines were created but the deploy failed, they are not live yet; fix the cause and deploy again.</dd>
      <dt>The AI provider returns an error.</dt>
      <dd>Open <span class="ui">Settings → AI</span> and click <span class="ui">Test Connection</span>. A 401 means the key is wrong; 429 means you hit the provider's rate limit — wait and retry. Inside Cribl, requests that take longer than 30 seconds are cancelled; large jobs are split and retried automatically, and a fast model helps. You can always <span class="ui">Skip &amp; continue</span> without AI.</dd>
      <dt>Cribl AI Settings gives an error.</dt>
      <dd>Check that AI is enabled for your organization under Cribl Settings → AI Settings. Cribl AI handles one request at a time, so batches run one row at a time.</dd>
      <dt>My score is lower than expected.</dt>
      <dd>Look at the Mapping section of the report for dropped values, and the card for a cap reason. A sample from your real feed usually scores higher than a generated one. Some sources have values the destination schema has no field for — that is a real limit, not a bug. Try <a href="#improve">Improve</a> with guidance.</dd>
      <dt>Pipeline Visualizer says I do not have sufficient permissions.</dt>
      <dd>The Pipeline Visualizer app is not installed in your organization. See <a href="#visualizer">Pipeline Visualizer</a>.</dd>
    </dl>
  </section>

  <section class="chap" id="glossary">
    <div class="chap-h"><div class="chap-n">14</div><div class="chap-t">Glossary</div></div>
    <dl>
      <dt>Pack</dt><dd>A bundle of Cribl Stream pipelines, routes and samples that you deploy to a worker group.</dd>
      <dt>Sourcetype</dt><dd>The name of the kind of log, such as <code>cisco_asa</code> or <code>pan_traffic</code>.</dd>
      <dt>Golden</dt><dd>A proven pipeline that scored above the threshold on real output; reused before AI.</dd>
      <dt>Extraction, Mapping, Output shaping</dt><dd>The three pipeline stages: pull values out of the event, put them in the destination schema, and clean up for the destination.</dd>
      <dt>OCSF, CIM, ECS, ASIM, UDM</dt><dd>Destination schemas: Open Cybersecurity Schema Framework, Splunk Common Information Model, Elastic Common Schema, Microsoft Sentinel ASIM, Google Chronicle UDM.</dd>
      <dt>Post-processing pack</dt><dd>A pack that reshapes OCSF output for another destination.</dd>
      <dt>Sanitising</dt><dd>Replacing identities in a sample with consistent stand-ins, locally in your browser.</dd>
      <dt>Worker group</dt><dd>The set of Cribl workers where the pack runs.</dd>
    </dl>
  </section>

  <footer>Cribl Pack Generator · User guide. <b>Download</b> saves this page as one self-contained HTML file. For how results are produced, see the ${tech('Technical reference')}.</footer>
</div>
<a class="totop" href="#contents">&uarr; Contents</a>
<div class="toast" id="toast" role="status"></div>
${docScript('pack-generator-user-guide.html')}
</body></html>`;
