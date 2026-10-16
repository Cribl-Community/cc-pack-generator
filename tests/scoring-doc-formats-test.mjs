// The Settings reference doc must document EVERY export-format tile the wizard
// offers, and must describe each one truthfully (build 458).
//
// The failure this guards against is drift, not absence: someone adds a
// destination tile (or changes what a spec emits) and the documentation keeps
// confidently describing the previous world. A doc that is 90% right is worse
// than a missing one, because a reader has no way to tell which 10% lied.
//
// So the assertions are pinned to the SAME config the app builds from — the
// tiles come out of DEST_OPTIONS, the output shapes out of golden-formats.json,
// the schematizer set out of App.tsx, the sub-selector counts out of their real
// catalogs. Editing the doc alone cannot make this pass.
//
// It also checks the page WORKS as a page: every contents link resolves to an id
// that exists, every chapter and tile is reachable, the download really serializes
// the whole document, and navigation stays script-free (a Blob-URL page inherits
// the opener's CSP, so an inline script can legitimately be blocked).

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { SCORING_DOC_HTML } from '../src/scoring-doc.ts';
import goldenFormats from '../config/golden-formats.json' with { type: 'json' };
import sentinelDests from '../config/sentinel-destinations.json' with { type: 'json' };
import cimModels from '../config/cim-data-models.json' with { type: 'json' };
import xsiamSources from '../config/xsiam-sources.json' with { type: 'json' };

const read = p => readFileSync(new URL(p, new URL('../', import.meta.url)), 'utf8');
// SCHEMATIZER_DESTS and scoreStage's per-format logic moved to staged-build.ts
// (build 712) so the 3-stage builder can run outside the browser.
const app = read('src/App.tsx');
// The 3-stage builder (SCHEMATIZER_DESTS, scoreStage and its per-format logic)
// moved to staged-build.ts in build 712 so it can run outside the browser.
// Kept as its OWN constant rather than concatenated onto `app`: each assertion
// below then states which file it is really pinning, and a guard cannot be
// satisfied by a second copy of the builder living back in App.tsx.
const staged = read('src/staged-build.ts');
const formats = goldenFormats.formats || goldenFormats;

// The tiles, straight out of the array the wizard renders.
const destOptionsBlock = app.match(/const DEST_OPTIONS[^=]*=\s*\[([\s\S]*?)\n\];/)?.[1];
assert.ok(destOptionsBlock, 'could not locate DEST_OPTIONS in src/App.tsx');
const TILES = [...destOptionsBlock.matchAll(/\{\s*value:\s*'([^']+)',\s*label:\s*'([^']+)'/g)]
  .map(m => ({ value: m[1], label: m[2] }));

// Chapter 6's per-format sub-chapters. Scoped to the format section, so chapter
// 6's other <h3> ("Golden mapping vs AI mapping") isn't mistaken for a tile.
const chapter6 = SCORING_DOC_HTML.split('CHAPTER 6')[1]?.split('CHAPTER 7')[0] || '';
const fmtSectionStart = chapter6.search(/<h2>[^<]*<span class="d"><\/span>The export formats/);
assert.notEqual(fmtSectionStart, -1, 'chapter 6 has no "The export formats" section');
const formatSection = chapter6.slice(fmtSectionStart);
// Each heading carries its own anchor id (`<h3 id="fmt-cef">`), so match on the
// open tag rather than on `<h3>` exactly.
const H3 = /<h3(?:\s[^>]*)?>([^<]+)<\/h3>/g;
const h3s = [...formatSection.matchAll(H3)].map(m => ({ text: m[1].trim(), at: m.index, end: m.index + m[0].length }));
const subChapters = h3s.map(h => h.text);
// The tile-summary table is the one INSIDE the format section.
const fmtTable = formatSection.slice(formatSection.indexOf('<table>'), formatSection.indexOf('</table>') + 8);
// The prose for one sub-chapter: from its <h3> to the next <h3> or the section
// end. `key` may be a distinctive fragment ('Sentinel', 'ASIM') — the SHORTEST
// matching heading wins, so 'Sentinel' resolves to "Microsoft Sentinel" and not
// to "Microsoft Sentinel ASIM".
const sectionFor = (key) => {
  const hit = h3s.find(h => h.text === key)
    || h3s.filter(h => h.text.includes(key)).sort((a, b) => a.text.length - b.text.length)[0];
  assert.ok(hit, `no sub-chapter for "${key}" — headings: ${subChapters.join(' | ')}`);
  const next = h3s.find(h => h.at > hit.at);
  return formatSection.slice(hit.end, next ? next.at : undefined);
};

test('the Settings button can actually open the document', () => {
  /*
   * It could not, and the reason is a trap worth pinning: `window.open` returns null
   * whenever `noopener` is set. The pre-await open exists solely to capture a handle while
   * the click still authorises a popup, and asking for `noopener` guaranteed it captured
   * nothing — so the real open always happened after the dynamic import, by which point the
   * gesture had expired and the browser silently blocked it. It survived for as long as the
   * import fitted inside the browser's grace period, and died as this document grew to
   * import the golden pipelines, the parser catalogue and the sample corpus.
   *
   * Nothing about that failure is visible in a diff or a type: the code reads as if it
   * handles the popup case, and does the opposite.
   */
  // Build 900: one opener serves both documents. openScoringDoc delegates to
  // openAppDoc('technical'); the chunk import lives in loadAppDocHtml.
  assert.match(app, /const openScoringDoc = \(\) => openAppDoc\('technical'\);/, 'the Reference button still opens the technical reference');
  const loader = app.slice(app.indexOf('async function loadAppDocHtml('));
  assert.ok(loader.slice(0, loader.indexOf('\n}\n')).includes('await import(\'./scoring-doc\')'), 'located the loader');
  const fn = app.slice(app.indexOf('async function openAppDoc('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(body.includes('await loadAppDocHtml(doc)'), 'located the opener');

  const open = body.slice(0, body.indexOf('await loadAppDocHtml'));
  assert.match(open, /const tab = window\.open\('', '_blank'\);/,
    'the tab must be opened before the await, and WITHOUT noopener, or the handle is null');
  assert.ok(!/window\.open\([^)]*noopener/.test(body),
    'noopener makes window.open return null, which is the bug this replaced');

  /* A second window.open after the await would be blocked in exactly the same way — which
     is how this failed silently rather than visibly. A download is not popup-blocked. */
  assert.equal((body.match(/window\.open\(/g) || []).length, 1, 'only one window.open, before the await');
  assert.ok(body.includes('a.download ='), 'and a fallback that survives a blocked popup');
});

test('every destination tile has its own sub-chapter', () => {
  assert.ok(TILES.length >= 11, `expected the full tile set, parsed ${TILES.length}`);
  for (const tile of TILES) {
    // Match on the tile's own label so a renamed tile is caught too. The doc may
    // shorten a long label (the Sentinel/ASIM tiles), so accept a heading that
    // carries the label's distinctive words.
    const key = tile.label.replace(/^Microsoft Sentinel /, '').replace(/^Google /, '');
    const hit = subChapters.find(h => h === tile.label || h.includes(key) || key.includes(h));
    assert.ok(hit, `tile "${tile.label}" (${tile.value}) has no sub-chapter — headings: ${subChapters.join(' | ')}`);
  }
});

test('no sub-chapter documents a tile that does not exist', () => {
  // The reverse drift: a destination is removed and its documentation lingers.
  for (const h of subChapters) {
    const hit = TILES.find(t => t.label === h || t.label.includes(h) || h.includes(t.label.replace(/^Microsoft Sentinel /, '')));
    assert.ok(hit, `sub-chapter "${h}" documents no DEST_OPTIONS tile`);
  }
});

test('each format is described with its REAL output shape', () => {
  // outputShape is the destination's hard contract — a doc that gets this wrong
  // sends a reader to build the one thing the destination will reject.
  const claims = [
    ['OCSF 1.9', 'ocsf', 'nested'],
    ['CEF', 'cef', 'raw'],
    ['Splunk CIM', 'cim', 'flat'],
    ['Elastic ECS', 'ecs', 'nested'],
    ['Chronicle UDM', 'chronicle', 'nested'],
    ['Cortex XSIAM', 'xsiam', 'passthrough'],
    ['Clean JSON', 'json', 'flat'],
  ];
  for (const [heading, fmt, shape] of claims) {
    assert.equal(formats[fmt].outputShape, shape,
      `golden-formats.json says ${fmt} is "${formats[fmt].outputShape}", the doc's table says "${shape}"`);
    assert.ok(sectionFor(heading).length > 200, `${heading} sub-chapter is too thin to be useful`);
  }
  // The table row must state the shape the spec actually declares.
  assert.match(fmtTable, /Cortex XSIAM<\/b><\/td><td>passthrough/);
  assert.match(fmtTable, /CEF<\/b><\/td><td>raw/);
});

test('NG SIEM is documented as raw fidelity — the OCSF alias only keeps a format path', () => {
  // aliasOf stays so the build has a golden-format path (dropping it sends the
  // orchestrator into AI mapping), but the output is the original _raw, scored as
  // raw fidelity — the doc must say that, not "OCSF alias".
  assert.equal(formats.nextgen.aliasOf, 'ocsf');
  assert.equal(formats.nextgen.label, 'CrowdStrike NG SIEM');
  const sec = sectionFor('CrowdStrike NG SIEM');
  assert.ok(sec.length > 200, 'NG SIEM sub-chapter is too thin to be useful');
  assert.match(sec, /raw fidelity/i);
  assert.match(sec, /vendor parser/i);
  assert.match(sec, /whole payload/i);
  assert.match(fmtTable, /CrowdStrike NG SIEM<\/b><\/td><td>raw/);
});

test('only the real schematizer destinations are described as delegated', () => {
  const listed = staged.match(/const SCHEMATIZER_DESTS = \[([^\]]+)\]/)?.[1] || '';
  const dests = [...listed.matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(dests.sort(), ['chronicle', 'ecs', 'ocsf'], 'SCHEMATIZER_DESTS changed — Chapter 6 must follow');
  for (const heading of ['OCSF 1.9', 'Elastic ECS', 'Chronicle UDM']) {
    assert.match(sectionFor(heading), /schematizer/i, `${heading} is delegated but the doc does not say so`);
  }
  // NG SIEM and Sentinel are NOT delegated — claiming they were would be the
  // easy mistake, since NG SIEM used to be OCSF and Sentinel is a schema destination.
  assert.match(sectionFor('CrowdStrike NG SIEM'), /<b>not<\/b> delegated to Cribl's schematizer/,
    'NG SIEM is NOT a schematizer destination — the doc must say so explicitly');
  assert.ok(!/schematizer/i.test(sectionFor('Sentinel')), 'Sentinel is not delegated to the schematizer');
});

test('the unscored-mapping destinations are the ones the code exempts', () => {
  // scoreStage: `isSchema = !['json','manual','raw','passthrough',''].includes(destFormat)`,
  // and a non-schema destination reports mapping as n/a rather than a number.
  const isSchema = staged.match(/const isSchema = !\[([^\]]+)\]/)?.[1] || '';
  const exempt = [...isSchema.matchAll(/'([^']*)'/g)].map(m => m[1]).filter(Boolean);
  // 'manual' stays in the exclusion list even though build 687 retired the tile:
  // Rule 27 requires extractionClassOf to mirror this list EXACTLY, and a pack built
  // before the removal can still carry the value. It must not be documented, though —
  // see the retired-tile assertion below.
  // 'raw_fields' is the Build pack flow's "Raw + extracted fields" Lake card (build
  // 818) — not a DEST_OPTIONS tile, so it is documented in the flow-only note.
  assert.deepEqual(exempt.sort(), ['json', 'manual', 'passthrough', 'raw', 'raw_fields']);
  assert.match(formatSection, /id="fmt-flow-only"[\s\S]*?Raw \+ extracted fields[\s\S]*?mapping card shows n\/a/);
  // The user-facing ones must say the mapping card shows no score.
  assert.match(sectionFor('Clean JSON'), /mapping card<\/b> shows n\/a|no schema/i);
  // Passthrough scores NOTHING — extraction, mapping and output shaping are ALL
  // n/a and the overall is N/A. The doc must NOT still claim "extraction 100"
  // (that was the fake perfect score this behaviour was fixed to remove).
  assert.match(sectionFor('Passthrough'), /extraction, mapping and output shaping are all n\/a/i);
  assert.doesNotMatch(sectionFor('Passthrough'), /extraction is scored 100/i);
  assert.match(fmtTable, /Clean JSON<\/b><\/td>[\s\S]{0,160}<b>No<\/b>/);
});

test('the retired Custom / Other destination is documented as retired, not as a tile', () => {
  // Build 687 removed the free-text destination from DEST_OPTIONS; the doc kept a full
  // sub-chapter, a TOC chip and a summary row for it for six builds. A reader following
  // that text would look for a tile that is not there — which is the exact drift this
  // suite exists to catch, so the removal is asserted rather than merely done.
  assert.ok(!TILES.some(t => t.value === 'manual'), 'DEST_OPTIONS must not offer a free-text destination');
  assert.ok(!/id="fmt-manual"|href="#fmt-manual"/.test(SCORING_DOC_HTML),
    'no anchor or TOC chip may survive the removed tile');
  assert.ok(!/<td><b>Custom \/ Other<\/b><\/td>/.test(fmtTable),
    'the tile-summary table must not list a destination the wizard cannot offer');
  // Removed, but not silently: a reader who knows the old escape hatch must find out
  // where it went and what to do instead.
  assert.match(formatSection, /no "Custom \/ Other" destination/i, 'the doc must say the tile is gone');
  // Build 900 moved build-numbered history out of the chapters into Release notes;
  // the date of the removal lives there now.
  const notes = SCORING_DOC_HTML.slice(SCORING_DOC_HTML.indexOf('id="release-notes"'));
  assert.match(notes, /Custom \/ Other destination removed — build 687/, 'and when, so the note can be dated against the app');
});

test('passthrough is scored as N/A everywhere — no fake 100, no fake 0', () => {
  // A passthrough transforms nothing, so extraction and mapping have nothing to
  // measure. The extraction stage must return n/a (null), NOT a hardcoded 100 —
  // that fake perfect score inflated the deployment_score average and read as
  // validated work. Mapping already returns n/a (passthrough is not a schema).
  const ext = staged.slice(staged.indexOf("if (stage === 'extraction')"), staged.indexOf("if (isXsiam) return scoreXsiamPayloadStage"));
  assert.match(ext, /if \(isPassthrough\) return \{ score: null, band: 'na'/,
    'passthrough extraction must return n/a, not a number');
  assert.doesNotMatch(ext, /if \(isPassthrough\) return \{ score: 100/,
    'the hardcoded extraction 100 for passthrough must be gone');

  // And the overall must NOT coerce a null (n/a) average to 0 — a 0 is a fake
  // FAILURE, the mirror of the fake 100. Every site that averages the two stages
  // for a row/log score must carry null through, so N/A stays N/A.
  const overallSites = (app + staged).match(/averageStageScores\([^)]*\)\s*\?\?\s*0/g) || [];
  assert.equal(overallSites.length, 0,
    `no overall-score site may coerce a null average to 0 (found ${overallSites.length})`);
});

test('the sub-selector counts match the real catalogs', () => {
  const sentinelTables = Object.keys(sentinelDests.tables).length;
  const models = cimModels.models || cimModels;
  const modelCount = Array.isArray(models) ? models.length : Object.keys(models).length;
  const asimSchemas = Object.keys(formats).filter(k => k.startsWith('asim#')).length;
  const xsiam = Object.keys(xsiamSources.sources).length;

  assert.match(sectionFor('Sentinel'), new RegExp(`<b>${sentinelTables} native Sentinel tables</b>`),
    `Sentinel catalog holds ${sentinelTables} tables`);
  assert.match(sectionFor('Splunk CIM'), new RegExp(`<b>${modelCount} CIM data models</b>`),
    `CIM catalog holds ${modelCount} data models`);
  assert.match(sectionFor('ASIM'), new RegExp(`<b>${asimSchemas} different schemas</b>`),
    `golden-formats.json holds ${asimSchemas} asim# schemas`);
  assert.match(sectionFor('Cortex XSIAM'), new RegExp(`<b>${xsiam} sources</b>`),
    `xsiam-sources.json holds ${xsiam} sources`);
});

test('the ASIM sub-chapter names schemas that actually exist', () => {
  // Auto-selection is data-class driven, so the doc lists the schemas by concern.
  // Anything it names must be a real key, or a reader picks a schema we can't build.
  const asimKeys = Object.keys(formats).filter(k => k.startsWith('asim#')).map(k => k.split('#')[1]);
  for (const concern of ['authentication', 'dns', 'endpoint', 'file', 'registry', 'audit', 'dhcp', 'usermgmt', 'network', 'web_proxy']) {
    assert.ok(asimKeys.includes(concern), `doc names an ASim ${concern} schema that golden-formats.json lacks`);
  }
  // `auto` is the DEFAULT (App.tsx sets asimSchema:'auto' when the tile is
  // selected) and it resolves from the data class — a doc that made the pick look
  // mandatory would send every reader to choose a schema by hand.
  assert.match(app, /asimSelected && !state\.asimSchema\) setTimeout\(\(\) => update\(\{ asimSchema: 'auto' \}\)/);
  assert.match(sectionFor('ASIM'), /defaults to <b>auto<\/b>/, 'auto must be documented as the DEFAULT');
  assert.match(sectionFor('ASIM'), /resolves the schema from the source's data class/);
  // And auto's fallback must be named, since it is the one non-obvious case.
  const fallback = read('src/pack-builder.ts').match(/named === 'generic' \? '(\w+)'/)?.[1];
  assert.equal(fallback, 'network', 'ASIM auto fallback changed');
  assert.match(sectionFor('ASIM'), /falls to Network Session/);
});

test('Sentinel and CIM are documented as OPPOSITE shape contracts', () => {
  // This is the single most expensive thing to get backwards: CIM wants the
  // fields inside _raw with a metadata-only top level, a Sentinel DCR wants the
  // table's columns at the top level and drops everything else. Both claims are
  // checked against the code that enforces them.
  const pb = read('src/pack-builder.ts');
  assert.match(pb, /const CIM_METADATA_KEEP = \[([^\]]+)\]/);
  const keep = pb.match(/const CIM_METADATA_KEEP = \[([^\]]+)\]/)[1];
  for (const f of ['_raw', '_time', 'index', 'source', 'sourcetype', 'host']) {
    assert.ok(keep.includes(`'${f}'`), `CIM keep list lost ${f}`);
    assert.ok(sectionFor('Splunk CIM').includes(`<code>${f}</code>`), `CIM sub-chapter should list ${f} as kept metadata`);
  }
  assert.match(sectionFor('Splunk CIM'), /serializes them into <code>_raw<\/code>/);
  assert.match(sectionFor('Sentinel'), /only<\/b> the table's own columns|exact opposite/i);
  // And the vendor-native value rule (build 457) belongs on the Sentinel page.
  assert.match(sectionFor('Sentinel'), /vendor_action/);
  assert.ok(!/vendor's own value/i.test(sectionFor('ASIM')), 'ASIM keeps the normalized vocabulary');
});

test('XSIAM is documented as passthrough, with the guessed-source zero', () => {
  const s = sectionFor('Cortex XSIAM');
  assert.match(s, /__sourceIdentifier/);
  assert.match(s, /forced<\/b> to zero|forced to zero/i);
  assert.match(s, /all-or-nothing/i);
  // The four real tagging patterns, no invented fifth.
  const patterns = [...new Set(Object.values(xsiamSources.sources).map(v => v.pattern))];
  for (const p of patterns) assert.ok(s.includes(`<code>${p}</code>`), `XSIAM pattern ${p} is not documented`);
  for (const m of s.matchAll(/<code>(tag_\w+|cef_\w+|zscaler_\w+)<\/code>/g)) {
    assert.ok(patterns.includes(m[1]), `doc names a pattern "${m[1]}" that no source uses`);
  }
});

test('CEF severity inversion is documented in the direction the rule runs', () => {
  // The scales are inverted; copying instead of translating is the classic bug,
  // and documenting it backwards would teach exactly that bug.
  const rule = formats.cef.valueRules.cefSeverityFromLevel;
  assert.match(rule, /Number\(severity\) <= 1 \? 10/, 'CEF severity rule changed');
  assert.match(rule, /=== ''\s*\? 5/, 'CEF severity default changed');
  const s = sectionFor('CEF');
  assert.match(s, /0 is most urgent|opposite directions/i);
  assert.match(s, /defaults to 5/);
  assert.match(s, new RegExp(`${formats.cef.extension.length} extension keys|~${formats.cef.extension.length} extension`));
});

test('every in-page link resolves to an id that exists', () => {
  // A contents list that scrolls nowhere is the failure mode of hand-written
  // anchors: the link and the target drift apart and nothing complains.
  const ids = new Set([...SCORING_DOC_HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const targets = [...SCORING_DOC_HTML.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
  assert.ok(targets.length >= 19, `expected the full contents list to be linked, found ${targets.length}`);
  for (const t of targets) assert.ok(ids.has(t), `href="#${t}" points at an id that does not exist`);
});

test('the contents list reaches every chapter and every format tile', () => {
  const toc = SCORING_DOC_HTML.slice(SCORING_DOC_HTML.indexOf('class="toc"'), SCORING_DOC_HTML.indexOf('CHAPTER 1'));
  // One link per chapter, in order, each landing on that chapter's own section.
  for (let n = 1; n <= 8; n++) {
    assert.ok(toc.includes(`href="#ch${n}"`), `chapter ${n} is not linked from the contents`);
    assert.match(SCORING_DOC_HTML, new RegExp(`<section class="chap" id="ch${n}">`), `chapter ${n} has no anchor`);
  }
  // And one chip per destination tile, keyed on the tile's own DEST_OPTIONS value,
  // so a new tile cannot be documented yet left unreachable.
  for (const tile of TILES) {
    assert.ok(toc.includes(`href="#fmt-${tile.value}"`), `tile ${tile.value} is missing from the format jump list`);
    assert.match(formatSection, new RegExp(`<h3 id="fmt-${tile.value}">`), `tile ${tile.value} has no sub-chapter anchor`);
  }
  const chips = [...toc.matchAll(/href="#fmt-([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(chips.sort(), TILES.map(t => t.value).sort(), 'the jump list and DEST_OPTIONS disagree');
});

test('the whole document can be downloaded, and the buttons are script-gated', () => {
  // The page is served from a Blob URL, which inherits the opener's CSP — an inline
  // script CAN be blocked in the iframe. So navigation must not depend on script,
  // and the buttons must not be visible when script did not run.
  assert.match(SCORING_DOC_HTML, /<div class="tools" id="tools">/);
  assert.match(SCORING_DOC_HTML, /\.tools\{display:none/, 'the buttons must start hidden');
  assert.match(SCORING_DOC_HTML, /tools\.style\.display = 'flex'/, 'script must reveal them');
  // The download is a self-serialization: whatever is on screen is what is saved.
  assert.match(SCORING_DOC_HTML, /document\.documentElement\.outerHTML/);
  assert.match(SCORING_DOC_HTML, /a\.download = "pack-generator-reference[^"]*\.html"/);
  assert.match(SCORING_DOC_HTML, /window\.print\(\)/);
  // No external asset, or a downloaded copy would render broken offline.
  assert.ok(!/<link\s|<img\s|src="http/.test(SCORING_DOC_HTML), 'the page must stay self-contained');
  // Navigation is plain anchors (the no-script fallback). Build 900: when script runs it
  // takes over in-page links and scrolls, because a hash click on a blob: page can be
  // treated as a navigation and then the contents do nothing (customer report).
  assert.match(SCORING_DOC_HTML, /<a href="#ch1">/);
  assert.match(SCORING_DOC_HTML, /href\.charAt\(0\) !== '#'[\s\S]{0,300}e\.preventDefault\(\);\s*el\.scrollIntoView\(/);
});

test('the doc still renders as one self-contained page', () => {
  assert.ok(SCORING_DOC_HTML.startsWith('<!DOCTYPE html>'));
  assert.ok(!/<\/p><\/div>/.test(SCORING_DOC_HTML), 'stray </p> inside a note div');
  // Eight chapters since build 624 — sanitising was promoted from a section of
  // chapter 3 to its own chapter 4; the export formats still live INSIDE chapter 6,
  // they are not a chapter of their own.
  assert.equal((SCORING_DOC_HTML.match(/class="chap-n">\d</g) || []).length, 8);
  const toc = SCORING_DOC_HTML.slice(SCORING_DOC_HTML.indexOf('class="toc"'), SCORING_DOC_HTML.indexOf('</ol>'));
  assert.equal((toc.match(/href="#ch\d"/g) || []).length, 8, 'TOC must list every chapter, and only those');
  assert.match(toc, /export format/i, 'the TOC must advertise the format sub-chapters');
  // No unbalanced h3/section markup that would swallow later chapters.
  assert.equal((chapter6.match(/<h3[\s>]/g) || []).length, (chapter6.match(/<\/h3>/g) || []).length);
  assert.equal(subChapters.length, TILES.length, 'one sub-chapter per tile, no more');
});
