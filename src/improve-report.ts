// Standalone HTML report for the Improve Pipeline "Improvement Complete" screen.
//
// The Improve flow scores a DEPLOYED pipeline before and after its improvement
// attempts. Its stage data (extraction + mapping per side, one shared sample)
// does not carry what ScoringReport's per-format view model needs (extracted
// field chips, the mapping diff, the optimization score), so instead of faking
// that model this serialises the screen's own panels — Current, After
// improvements, What was tried, coverage gaps — inside the SAME report shell and
// stylesheet as the build report (ScoringReport.reportShell), so both downloads
// read as one family. Pure: the caller passes display-ready strings, so this
// file needs no pack-builder imports and is unit-testable.
import { bandOfScore, esc, reportScoreColor, reportShell } from './ScoringReport';

export interface ImproveReportStage {
  score: number | null;
  reason?: string;
  /** The stage's output event, already formatted for display (null = not available). */
  body: string | null;
}

export interface ImproveReportRow {
  label: string;                 // 'Current' | 'After improvements'
  overall: number | null;
  extraction: ImproveReportStage;
  mapping: ImproveReportStage;
  coverage?: { coveredValues: number; totalValues: number };
}

export interface ImproveReportInput {
  packId?: string;
  pipelineId?: string;
  workerGroup?: string;
  destFormat?: string;
  sourcetype?: string;
  /** True when an improvement was committed and deployed. */
  changed: boolean;
  /** The sample event both sides were scored on, formatted for display. */
  sample: string | null;
  rows: ImproveReportRow[];
  tried: { stage: string; kept: 'new' | 'baseline'; score: number | null; summary?: string }[];
  gaps?: { notMapped: { field: string; value: string }[]; notExtracted: { value: string }[]; droppedFieldCount?: number };
  generatedAt?: Date;
}

const IMPROVE_STYLE = `
  .improve-outcome{font-size:12px;margin:0 0 10px;padding:8px 12px;border-radius:8px;border:1px solid #e6e8ee;background:#f7f9fc;}
  .improve-outcome.changed{border-color:#b7eb8f;background:#f6ffed;}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;align-items:start;}
  .grid3 > *{min-width:0;overflow-wrap:anywhere;}
  table.tried td.kept-new{color:#389e0d;font-weight:600;} table.tried td.kept-baseline{color:#8c8c8c;}
  ul.gaps{margin:3px 0 0;padding-left:16px;font-family:monospace;font-size:11px;} ul.gaps li{margin:1px 0;}
  @media print{ .grid3{gap:8px;} }
`;

const scoreSpan = (n: number | null) =>
  `<span class="sc" style="color:${reportScoreColor(bandOfScore(n))}">${n == null ? 'N/A' : n}</span>`;

const pre = (body: string | null, empty: string) =>
  body != null && body !== '' ? `<pre class="json">${esc(body)}</pre>` : `<p class="dim">${esc(empty)}</p>`;

function renderRow(row: ImproveReportRow, sample: string | null): string {
  const b = bandOfScore(row.overall);
  const cov = row.coverage
    ? `<p class="note">Diagnostic only — sample→final coverage: ${row.coverage.coveredValues}/${row.coverage.totalValues} (not the total above).</p>`
    : '';
  return `<section class="page">
      <h2>${esc(row.label)}</h2>
      <div class="scorehead">
        <div class="overall"><div class="big" style="color:${reportScoreColor(b)}">${row.overall ?? '—'}</div><div class="lbl">Total · value coverage</div></div>
        <div class="stagescores">
          <div class="ss"><div class="ss-n">Extraction</div><div class="ss-v" style="color:${reportScoreColor(bandOfScore(row.extraction.score))}">${row.extraction.score ?? 'N/A'}</div></div>
          <div class="ss"><div class="ss-n">Mapping</div><div class="ss-v" style="color:${reportScoreColor(bandOfScore(row.mapping.score))}">${row.mapping.score ?? 'N/A'}</div></div>
        </div>
      </div>
      <p class="note">Total = average of extraction (${row.extraction.score ?? 'n/a'}) and mapping (${row.mapping.score ?? 'n/a'}).</p>
      ${cov}
      <div class="grid3">
        <div><h3>1 · Sample (original)</h3>${pre(sample, 'No sample loaded.')}</div>
        <div><h3>2 · After extraction ${scoreSpan(row.extraction.score)}</h3>${row.extraction.reason ? `<p class="reason">${esc(row.extraction.reason)}</p>` : ''}${pre(row.extraction.body, 'Extraction output not available.')}</div>
        <div><h3>3 · After mapping ${scoreSpan(row.mapping.score)}</h3>${row.mapping.reason ? `<p class="reason">${esc(row.mapping.reason)}</p>` : ''}${pre(row.mapping.body, 'Mapping output not available.')}</div>
      </div>
    </section>`;
}

/** The whole Improve result as one standalone HTML page. */
export function buildImproveReportHtml(input: ImproveReportInput): string {
  const title = `Improve pipeline report${input.pipelineId ? ' — ' + input.pipelineId : ''}`;
  const meta = [
    input.packId ? `pack <code>${esc(input.packId)}</code>` : '',
    input.workerGroup ? `on <code>${esc(input.workerGroup)}</code>` : '',
    input.sourcetype ? `sourcetype <code>${esc(input.sourcetype)}</code>` : '',
    input.destFormat ? `destination <code>${esc(input.destFormat)}</code>` : '',
    `generated ${(input.generatedAt ?? new Date()).toLocaleString()}`,
  ].filter(Boolean).join(' · ');
  const outcome = input.changed
    ? '<p class="improve-outcome changed">An improvement was committed and deployed.</p>'
    : '<p class="improve-outcome">No pipeline change was committed; the live pipeline stays as it was.</p>';
  const rows = input.rows.map(r => renderRow(r, input.sample)).join('\n');
  const tried = input.tried.length
    ? `<section class="page"><h2>What was tried</h2><table class="summary tried"><thead><tr><th>Stage</th><th>Result</th><th class="n">Score</th><th>Notes</th></tr></thead><tbody>${input.tried.map(t =>
      `<tr><td>${esc(t.stage)}</td><td class="kept-${t.kept}">${t.kept === 'new' ? 'Improved' : 'Baseline kept'}</td><td class="n" style="color:${reportScoreColor(bandOfScore(t.score))}">${t.score ?? '—'}</td><td>${esc(t.summary || '')}</td></tr>`).join('')}</tbody></table></section>`
    : '';
  const g = input.gaps;
  const gaps = g && (g.notMapped.length || g.notExtracted.length)
    ? `<section class="page"><h2>Coverage gaps (current pipeline)</h2>
      ${g.notMapped.length ? `<h3>Extracted but not kept in the destination (${g.droppedFieldCount || g.notMapped.length} fields)</h3><ul class="gaps">${g.notMapped.slice(0, 25).map(x => `<li>${esc(x.field)} = ${esc(x.value)}</li>`).join('')}</ul>` : ''}
      ${g.notExtracted.length ? `<h3>Never extracted from the sample (${g.notExtracted.length} values)</h3><ul class="gaps">${g.notExtracted.slice(0, 15).map(x => `<li>${esc(x.value)}</li>`).join('')}</ul>` : ''}
    </section>`
    : '';
  return reportShell(title, meta, outcome + rows + tried + gaps, IMPROVE_STYLE);
}

/** File name for the download: the pipeline id, made filename-safe. */
export function improveReportFilename(pipelineId?: string): string {
  const safe = (pipelineId || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `improve-pipeline-report${safe ? '-' + safe : ''}.html`;
}
