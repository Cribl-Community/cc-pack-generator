import{n as e,r as t,t as n}from"./doc-shell-BRvycMzJ.js";var r=(t,n=``)=>e(`technical`,t,n),i=`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pack Generator — User guide</title>
<style>${n}</style></head><body>
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
  <p class="xref">Want to know how scores are calculated or how a format is mapped? See the ${r(`Technical reference`)}.</p>

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
    <h2><span class="d"></span>The four modes</h2>
    <p>Pick a mode on <span class="ui">⌂ Home</span> or under <b>Modes</b> in the left rail.</p>
    <table>
      <tr><th>Mode</th><th>Use it to</th></tr>
      <tr><td><b>Build pack flow</b></td><td>Build a new pack for one source and one or more destinations. When OCSF is a destination it can also build post-processing packs for other SIEMs in the same run.</td></tr>
      <tr><td><b>Modify existing pack</b></td><td>Add a pipeline to a pack you already deployed, or improve one of its pipelines.</td></tr>
      <tr><td><b>Batch create</b></td><td>Build many packs and pipelines from one CSV or JSON file, in this tab or in the background.</td></tr>
      <tr><td><b>Demo environment</b></td><td>Stand up a ready customer demo with live generated data — or clean up an earlier one.</td></tr>
    </table>
    <p>Under <b>Tools</b> in the rail you find <b>Samples</b>, <b>Settings</b> and <b>Documentation</b> (this guide and the technical reference). On a narrow window the rail shows icons only.</p>
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
      <li>On <b>Source Data</b>, give it events: <span class="ui">Upload file</span>, <span class="ui">Group sample</span>, <span class="ui">Paste events</span>, <span class="ui">Live capture</span> or <span class="ui">AI-generate</span>. Check the <b>Detected sourcetype</b> and correct it if needed.</li>
      <li>Click <span class="ui">Next: Flow</span>, enter a <b>Pack name</b> and click <span class="ui">＋ Add a destination</span> for each place the data goes.</li>
      <li>Click <span class="ui">Build pack</span>. Each stage card fills in with a score as it builds. Then commit and deploy.</li>
      <li>Read the result on <b>Pack Results</b>: one tab per pipeline, the score, and what was extracted and mapped. Click <span class="ui">⬇ Download report</span> to keep it.</li>
    </ol>
  </section>

  <section class="chap" id="build">
    <div class="chap-h"><div class="chap-n">4</div><div class="chap-t">Building a pack</div></div>
    <h2><span class="d"></span>Source and sourcetype</h2>
    <p>Give the events first; the sourcetype is detected from them. If the detection is wrong, type the correct name under <b>Not right? Enter the correct sourcetype</b> and click <span class="ui">Use this</span>. If nothing is detected, enter it under <b>Enter the sourcetype manually</b> and click <span class="ui">Confirm</span>. Close matches are suggested as you confirm; a ★ means a proven pipeline exists for it.</p>
    <p>Some sources ship in several formats (for example key=value, JSON or CEF). When you generate events instead of loading real ones, you are asked <b>Which format does your data use?</b> — pick the one your feed really emits.</p>
    <p><b>Allow Code functions</b> is off by default. Leave it off unless you are happy to deploy Code functions.</p>
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
    <p>During the build, the <b>Main pack</b> cards show the stages <b>Extract</b>, <b>Map</b> and <b>Shape</b>, followed by the post-processing packs, <b>Commit &amp; deploy</b> and the <b>Build log</b>. The finished <b>Pack Results</b> page has a tab per pipeline with:</p>
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
      <li><b>Source</b> — confirm the sourcetype. The page says how many lines the source's parser reads. If no parser recognises it, values are only found by their shape and the save may be blocked.</li>
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
    <p>A score can be capped when the output does not have the shape the destination needs — for example an OCSF event in the wrong class, or an XSIAM source that is not recognised. The reason is shown on the card. The ${r(`Technical reference, chapter 7`,`ch7`)} explains every rule.</p>
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
      <li><b>Upload</b> a CSV or JSON file with one row per pipeline. Required columns: <code>sourcetype</code>, <code>pack_name</code>, <code>pipeline_name</code>, <code>dest_format</code>; optional: <code>route_name</code>, <code>filter</code>. Rows with the same pack name become one pack. Fix or remove invalid rows, then <span class="ui">Continue to check</span>.</li>
      <li><b>Check sourcetypes and samples.</b> Confirm each row's sourcetype (suggestions come from the sample, the AI, proven pipelines and close names). Use <span class="ui">⇪ Add sample</span> to give a row its own events, a library sample or a saved sanitised sample. Rows without a sample get one at build time. <span class="ui">Download corrected CSV</span> saves your fixes.</li>
      <li><b>Where it runs.</b> <span class="ui">⚡ In this tab</span> is fastest; keep the tab open, and an interrupted run can be resumed. <span class="ui">☾ In the background</span> runs on Cribl's side, one row per minute, up to 200 pipelines; you can close the tab. Rows without a ready sample are skipped.</li>
      <li><b>Ready to start.</b> Check the summary and the estimate. For packs that already exist, choose <b>Overwrite</b>, <b>Skip</b>, <b>Repair</b> (improve the weak parts) or <b>Scorecard</b> (only score it). Then start.</li>
    </ol>
    <p>While it runs, <span class="ui">■ Stop</span> lets rows in progress finish; <span class="ui">✖ Kill</span> abandons them and commits nothing. When it is done, open <span class="ui">View scoring report</span>, filter rows <b>Below 85</b>, use <span class="ui">✦ Improve all N below 85</span>, or <b>Export</b> the results as CSV or JSON, the log or all build traces. To get back to a background run, use <span class="ui">View progress</span> on the banner.</p>
  </section>

  <section class="chap" id="demo">
    <div class="chap-h"><div class="chap-n">9</div><div class="chap-t">Demo environment</div></div>
    <p><b>Create:</b> pick a group with a connected worker, add the demo sources, choose destinations (one pack per format) and the routing destination (<code>devnull</code> by default). Click <span class="ui">Create Demo Environment</span>. Live generated data starts flowing on isolated routes, ending in a route that drops the demo data.</p>
    <p><b>Clean up:</b> on the sources step, click <span class="ui">Clean up demo environment</span>, tick what to remove (routing, datagen sources, packs, Lake outputs) and click <span class="ui">Remove N selected</span>. Items are removed in a safe order.</p>
  </section>

  <section class="chap" id="visualizer">
    <div class="chap-h"><div class="chap-n">10</div><div class="chap-t">Pipeline Visualizer</div></div>
    <p><span class="ui">🔗 Open in Pipeline Visualizer</span> on a report draws the pipeline as a diagram. Pipeline Visualizer is a <b>separate Cribl app</b>, and Cribl does not let Pack Generator check whether it is installed. So clicking the link first shows a short note; click <span class="ui">Open Pipeline Visualizer</span> in it to go there. If the app is not installed, Cribl shows a “sufficient permissions” page — that means the app is missing, not that you lack rights. Ask your Cribl Solutions Engineer for the app, then install it under <b>App Platform → Add App</b>. The link only appears when Pack Generator runs inside Cribl.</p>
  </section>

  <section class="chap" id="settings">
    <div class="chap-h"><div class="chap-n">11</div><div class="chap-t">Settings reference</div></div>
    <table>
      <tr><th>Tab</th><th>What you set there</th></tr>
      <tr><td><b>AI</b></td><td><b>Provider</b> and its key, the <b>Default model</b>, <b>Normal-flow model</b> (builds) and <b>Repair-flow model</b> (second opinion when a stage scores low). <span class="ui">Test Connection</span> saves and tests.</td></tr>
      <tr><td><b>Connection</b></td><td>Only when running outside Cribl: the Cribl Cloud login and score logging.</td></tr>
      <tr><td><b>Quality</b></td><td><b>Golden thresholds</b> for Extraction, Mapping and Output shaping (default 80): a stage that scores at least this is stored as a proven pipeline. <b>Drop null and blank fields when parsing JSON</b> (off by default): new builds leave out top-level JSON fields that are null or empty (0 and false are kept). The <b>Reference</b> button opens the technical reference.</td></tr>
      <tr><td><b>Goldens</b></td><td>The shared pool of proven pipelines: <span class="ui">Import all</span> new or better ones, and publishing (outside Cribl only). <span class="ui">Test GitHub access</span> checks the connection.</td></tr>
      <tr><td><b>Datatypes</b></td><td>Compares the Cribl Search datatypes in your group with the parsers the app knows; <span class="ui">Sync</span> imports the difference.</td></tr>
    </table>
    <p>The sample privacy rule is under <span class="ui">Samples → Sharing</span>. A red dot on <b>Settings</b> in the rail means the AI connection needs attention.</p>
  </section>

  <section class="chap" id="faq">
    <div class="chap-h"><div class="chap-n">12</div><div class="chap-t">Troubleshooting &amp; FAQ</div></div>
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
    <div class="chap-h"><div class="chap-n">13</div><div class="chap-t">Glossary</div></div>
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

  <footer>Cribl Pack Generator · User guide. <b>Download</b> saves this page as one self-contained HTML file. For how results are produced, see the ${r(`Technical reference`)}.</footer>
</div>
<a class="totop" href="#contents">&uarr; Contents</a>
<div class="toast" id="toast" role="status"></div>
${t(`pack-generator-user-guide.html`)}
</body></html>`;export{i as USER_GUIDE_HTML};