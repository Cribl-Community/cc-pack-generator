// Unified per-format scoring report (build 687). Replaces the old experiment-done
// stage cards + the Event Journey MODAL + the on-demand schema ValidationPanel with
// ONE inline report shown automatically after a pack finishes:
//   score header (Extraction / Mapping / Optimization + average, each with its
//   source badge) → Raw in → Extraction → Mapping (raw→output diff) → Output event
//   (with a format-conformance ✓/⚠ badge) → live Pipeline statistics.
// One tab per output format. A Download button emits a standalone HTML report with
// one page per format (page-break-before per format for print).
//
// This component is PURE PRESENTATION over a prepared view model (ReportFormatVM) —
// all shaping (event display, dropped/added-field diff, format validation) is done
// by the caller in App.tsx (buildReportFormatVM) so this file needs no pack-builder
// imports. The only side effect is the lazy live Cribl pipeline-profile fetch.
import { useEffect, useMemo, useRef, useState } from 'react';
import { previewPipelineProfile, type CriblPipelineProfile } from './api';
import { pipelineVisualizerUrl, VISUALIZER_REPORT_NOTE, type VisualizerAvailability } from './pipeline-visualizer-link';
import { PipelineVisualizerLink } from './PipelineVisualizerLink';

export interface ReportProfileArgs { workerGroup: string; packId: string; pipelineId: string; sampleName: string; }
export type ReportStageSource = 'search' | 'golden' | 'copilot' | 'ai' | 'static' | 'none';
export interface ReportStageScore { v: number | null; src: ReportStageSource; }
export interface ReportField { name: string; value: string; }
export interface ReportMapping { from: string; to: string; expr: string }
export interface ReportSampleStats {
  bytesIn?: number; bytesOut?: number; rawIn?: number; rawOut?: number; measured?: number;
}
// Per-stage measurements captured at build time (mapping / optimization each
// carry these in the persisted artifact). Used to render a statistics table
// when no live pipeline profile is available — e.g. every batch-run page.
export interface ReportStageStat {
  label: string;              // 'Mapping', 'Optimization', …
  durationMs?: number;
  events?: number;
  bytesIn?: number;
  bytesOut?: number;
}
export interface ReportFormatVM {
  format: string;             // destination format (may carry a #sub-schema)
  formatLabel: string;        // human label for the tab
  pipelineId: string;
  band: 'good' | 'warn' | 'fail' | 'na';
  average: number | null;
  scores: { extraction: ReportStageScore; mapping: ReportStageScore; optimization: ReportStageScore };
  extractionReason?: string;
  mappingReason?: string;
  rawLine: string;
  extractedFields: ReportField[];
  mappings: ReportMapping[];
  droppedFields: string[];    // extracted but not mapped to a destination field
  addedFields: string[];      // enrichment fields present in the output, not from the source
  unmappedRideAlong: string[];// kept inside _raw (not dropped)
  outputEvent: string;        // pre-serialized final output event
  formatValid: boolean | null;// null = no conformance check applies to this format
  formatNote: string;
  appliedOptimizations: { label: string; description: string; reduction?: number }[];
  sampleStats?: ReportSampleStats;
  stageStats?: ReportStageStat[];
  profileArgs?: ReportProfileArgs;
}

const COLORS = ['#0958d9', '#722ed1', '#d46b08', '#389e0d', '#c41d7f', '#1d39c4', '#d48806', '#08979c', '#7cb305', '#597ef7', '#eb2f96', '#0891b2'];

const SRC_LABEL: Record<ReportStageSource, string> = {
  search: '🔍 Search datatype', golden: '🏆 golden', copilot: '🐐 Copilot schema',
  ai: '🤖 AI-generated', static: '⚙ built-in', none: '—',
};

export function bandOfScore(n: number | null): 'good' | 'warn' | 'fail' | 'na' {
  if (n == null) return 'na';
  return n >= 85 ? 'good' : n >= 60 ? 'warn' : 'fail';
}
function fmtBytes(n?: number) { return n == null ? '—' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`; }
function fmtMs(n?: number) { return n == null ? '—' : n < 1 ? `${n.toFixed(3)} ms` : `${n.toFixed(2)} ms`; }
export function esc(s: any) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Locate each extracted value inside the raw line so verbatim tokens light up.
function rawSegments(raw: string, fields: { name: string; value: string; color: string }[]) {
  const matches: { start: number; end: number; color: string; name: string }[] = [];
  for (const f of [...fields].sort((a, b) => b.value.length - a.value.length)) {
    if (!f.value || f.value.length < 2) continue;
    const idx = raw.indexOf(f.value);
    if (idx >= 0) matches.push({ start: idx, end: idx + f.value.length, color: f.color, name: f.name });
  }
  matches.sort((a, b) => a.start - b.start);
  const segs: { text: string; color?: string; name?: string }[] = [];
  let pos = 0;
  for (const m of matches) {
    if (m.start < pos) continue;
    if (m.start > pos) segs.push({ text: raw.slice(pos, m.start) });
    segs.push({ text: raw.slice(m.start, m.end), color: m.color, name: m.name });
    pos = m.end;
  }
  if (pos < raw.length) segs.push({ text: raw.slice(pos) });
  return segs;
}

// ---- live pipeline-profile derived numbers ----------------------------------
function profileNumbers(p: CriblPipelineProfile | null) {
  const fns = p?.functions || [];
  return {
    fns,
    total: p?.duration,
    bytesIn: fns[0]?.bytesIn,
    bytesOut: fns.length ? fns[fns.length - 1].bytesOut : undefined,
    eventsIn: fns[0]?.eventsIn,
    eventsOut: fns.length ? fns[fns.length - 1].eventsOut : undefined,
    cpu: p?.cpu,
  };
}

export function ScoringReport({ data, packId, workerGroup, visualizerBaseUrl }: { data: ReportFormatVM[]; packId?: string; workerGroup?: string; visualizerBaseUrl?: string | null }) {
  const [active, setActive] = useState(0);
  // Live Cribl pipeline profiles keyed by pipelineId, fetched once per format.
  const [profiles, setProfiles] = useState<Record<string, CriblPipelineProfile | null>>({});
  const [profileState, setProfileState] = useState<Record<string, 'loading' | 'done' | 'error'>>({});
  const fetched = useRef<Set<string>>(new Set());

  // Fetch every format's profile up-front (usually 1–4) so tab switches are
  // instant and the downloaded report carries stats for all pages.
  // NOTE: the `fetched` ref (not a per-effect `live` flag) is the dedupe — refs
  // survive StrictMode's double-mount, so guarding the result on a `live` that
  // the first cleanup flips to false would strand the profile on "loading"
  // forever (the re-run skips the already-fetched id). setState after unmount is
  // a harmless no-op in React 18+, so no `live` guard is needed here.
  useEffect(() => {
    for (const vm of data) {
      if (!vm.profileArgs?.pipelineId || fetched.current.has(vm.pipelineId)) continue;
      const id = vm.pipelineId;
      fetched.current.add(id);
      setProfileState(s => ({ ...s, [id]: 'loading' }));
      previewPipelineProfile(vm.profileArgs)
        .then(p => { setProfiles(m => ({ ...m, [id]: p })); setProfileState(s => ({ ...s, [id]: p ? 'done' : 'error' })); })
        .catch(() => { setProfileState(s => ({ ...s, [id]: 'error' })); });
    }
  }, [data]);

  const vm = data[active] || data[0];
  const download = () => downloadReport(data, profiles, packId, workerGroup);

  if (!vm) return null;

  return (
    <div className="sr-report">
      <div className="sr-tabbar">
        <div className="sr-tabs">
          {data.map((f, i) => (
            <button key={f.pipelineId} className={`sr-tab${i === active ? ' active' : ''}`} onClick={() => setActive(i)}>
              <span className={`sr-dot band-${f.band}`} />{f.formatLabel}
              {f.average != null && <span className="sr-tabscore">{f.average}</span>}
            </button>
          ))}
        </div>
        {(() => {
          const pa = vm.profileArgs;
          const group = pa?.workerGroup || workerGroup;
          const pack = pa?.packId || packId;
          if (!visualizerBaseUrl || !group || !pack) return null;
          const href = pipelineVisualizerUrl(visualizerBaseUrl, group, pack, vm.pipelineId);
          return (
            <PipelineVisualizerLink className="sr-visualizer" href={href} title={`Open ${pack} in the Pipeline Visualizer`}>
              🔗 Open in Pipeline Visualizer
            </PipelineVisualizerLink>
          );
        })()}
        <button className="sr-download" onClick={download} title="Download the full report (one page per format)">⬇ Download report</button>
      </div>
      <div className="sr-panel">
        <FormatView vm={vm} profile={profiles[vm.pipelineId] ?? null} profileState={profileState[vm.pipelineId]} />
      </div>
    </div>
  );
}

function StageScore({ name, s }: { name: string; s: ReportStageScore }) {
  const band = bandOfScore(s.v);
  return (
    <div className="sr-ss">
      <div className="sr-ss-name">{name}</div>
      <div className={`sr-ss-val score-${band}`}>{s.v == null ? 'N/A' : s.v}</div>
      <div className="sr-ss-bar"><div className={`fill band-${band}`} style={{ width: `${s.v ?? 0}%` }} /></div>
      <div className={`sr-badge src-${s.src}`}>{SRC_LABEL[s.src]}</div>
    </div>
  );
}

function FormatView({ vm, profile, profileState }: { vm: ReportFormatVM; profile: CriblPipelineProfile | null; profileState?: 'loading' | 'done' | 'error' }) {
  const fields = useMemo(() => vm.extractedFields.map((f, i) => ({ ...f, color: COLORS[i % COLORS.length] })), [vm]);
  const colorOf = (name: string) => fields.find(f => f.name === name)?.color || '#98a2b3';
  const segs = useMemo(() => vm.rawLine ? rawSegments(vm.rawLine, fields) : [], [vm.rawLine, fields]);
  const P = profileNumbers(profile);
  const dropDelta = (P.eventsIn != null && P.eventsOut != null) ? P.eventsIn - P.eventsOut : null;
  const st = vm.sampleStats;

  return (
    <>
      {/* ---- score header ---- */}
      <div className="sr-scorehead">
        <div className="sr-overall">
          <div className={`sr-overall-n score-${vm.band}`}>{vm.average ?? '—'}</div>
          <div className="sr-overall-l">Average score</div>
          <div className={`sr-overall-band score-${vm.band}`}>{vm.band === 'na' ? '' : vm.band.toUpperCase()} · value coverage</div>
        </div>
        <div className="sr-stagescores">
          <StageScore name="Extraction" s={vm.scores.extraction} />
          <StageScore name="Mapping" s={vm.scores.mapping} />
          <StageScore name="Optimization" s={vm.scores.optimization} />
        </div>
      </div>

      {/* ---- 1. Raw in ---- */}
      <section className="sr-stage">
        <div className="sr-shead"><span className="sr-num">1</span><strong>Raw in</strong><span className="sr-sub">one sample line, as ingested</span></div>
        <div className="sr-sbody">
          <pre className="sr-raw">{segs.length
            ? segs.map((s, i) => s.color ? <span key={i} className="sr-tok" style={{ background: s.color + '22', boxShadow: `inset 0 -2px 0 ${s.color}` }} title={s.name}>{s.text}</span> : <span key={i}>{s.text}</span>)
            : <span className="sr-dim">No sample event captured.</span>}</pre>
        </div>
      </section>

      {/* ---- 2. Extraction ---- */}
      <section className="sr-stage">
        <div className="sr-shead"><span className="sr-num">2</span><strong>Extraction</strong><span className="sr-sub">fields pulled from _raw</span><span className="sr-spacer" /><span className={`sr-pill score-${bandOfScore(vm.scores.extraction.v)}`}>{vm.scores.extraction.v ?? 'N/A'}</span></div>
        <div className="sr-sbody">
          {vm.extractionReason && <p className="sr-reason">{vm.extractionReason}</p>}
          <div className="sr-chips">
            {fields.length ? fields.map(f => (
              <span key={f.name} className="sr-chip" style={{ borderColor: f.color + '55', background: f.color + '12', color: f.color }}>
                <span className="k">{f.name}</span><span className="v">{f.value.length > 40 ? f.value.slice(0, 40) + '…' : f.value}</span>
              </span>
            )) : <span className="sr-dim">No extracted fields recorded.</span>}
          </div>
        </div>
      </section>

      {/* ---- 3. Mapping (raw → output diff) ---- */}
      <section className="sr-stage">
        <div className="sr-shead"><span className="sr-num">3</span><strong>Mapping → {vm.formatLabel}</strong><span className="sr-sub">source fields → destination schema</span><span className="sr-spacer" /><span className={`sr-pill score-${bandOfScore(vm.scores.mapping.v)}`}>{vm.scores.mapping.v ?? 'N/A'}</span></div>
        <div className="sr-sbody">
          {vm.mappingReason && <p className="sr-reason">{vm.mappingReason}</p>}
          {(vm.mappings.length || vm.droppedFields.length || vm.addedFields.length) ? (
            <div className="sr-diff">
              <div className="sr-diff-head">Extracted (input)</div><div className="sr-diff-head sr-mid" /><div className="sr-diff-head">Output ({vm.formatLabel})</div>
              {vm.mappings.map((m, i) => (
                <div key={`m${i}`} className="sr-diff-row">
                  <div className="sr-cell sr-src"><span style={{ color: colorOf(m.from) }}>{m.from || '—'}</span>{fields.find(f => f.name === m.from) && <span className="k"> = {fields.find(f => f.name === m.from)!.value.slice(0, 30)}</span>}</div>
                  <div className="sr-cell sr-mid">→</div>
                  <div className="sr-cell sr-dest">{m.to}{m.expr && m.expr !== m.from && m.expr !== m.to && <span className="expr" title={m.expr}> · {m.expr.length > 26 ? m.expr.slice(0, 26) + '…' : m.expr}</span>}</div>
                </div>
              ))}
              {vm.droppedFields.map((d, i) => (
                <div key={`d${i}`} className="sr-diff-row">
                  <div className="sr-cell sr-drop">{d}</div><div className="sr-cell sr-mid">→</div><div className="sr-cell sr-dim">dropped</div>
                </div>
              ))}
              {vm.addedFields.map((a, i) => (
                <div key={`a${i}`} className="sr-diff-row">
                  <div className="sr-cell sr-dim">—</div><div className="sr-cell sr-mid">＋</div><div className="sr-cell sr-add">{a}</div>
                </div>
              ))}
            </div>
          ) : <span className="sr-dim">No field mappings recorded (e.g. JSON passthrough).</span>}
          <div className="sr-legend">
            <span><i className="sw" style={{ background: '#0958d9' }} />mapped from source</span>
            <span><i className="sw" style={{ background: '#98a2b3' }} />extracted but dropped</span>
            <span><i className="sw" style={{ background: '#389e0d' }} />added / enriched</span>
          </div>
          {vm.unmappedRideAlong.length > 0 && <div className="sr-note">Kept, not dropped: <b>{vm.unmappedRideAlong.join(', ')}</b> ride along inside <code>_raw</code>.</div>}
        </div>
      </section>

      {/* ---- 4. Output event (with format-conformance badge) ---- */}
      <section className="sr-stage">
        <div className="sr-shead"><span className="sr-num">4</span><strong>Output event</strong><span className="sr-spacer" />
          {vm.formatValid != null && (vm.formatValid
            ? <span className="sr-fmt ok" title={vm.formatNote}>✓ Format validated</span>
            : <span className="sr-fmt warn" title={vm.formatNote}>⚠ Format issues</span>)}
        </div>
        <div className="sr-sbody">
          <pre className="sr-json">{vm.outputEvent}</pre>
          {vm.formatValid != null && vm.formatNote && <p className={`sr-fmt-note ${vm.formatValid ? 'ok' : 'warn'}`}>{vm.formatValid ? '✓' : '⚠'} {vm.formatNote}</p>}
          {vm.appliedOptimizations.length > 0 && (
            <div className="sr-opts">
              <div className="sr-opts-h">Optimizations applied ({vm.appliedOptimizations.length})</div>
              <ul>{vm.appliedOptimizations.map((o, i) => <li key={i}><b>{o.label}</b>{o.reduction ? ` · ~${o.reduction}%` : ''} — {o.description}</li>)}</ul>
            </div>
          )}
        </div>
      </section>

      {/* ---- Σ Pipeline statistics ---- */}
      <section className="sr-stage sr-statstage">
        <div className="sr-shead"><span className="sr-num">Σ</span><strong>Pipeline statistics</strong><span className="sr-spacer" /><span className="sr-sub">live Cribl pipeline profile</span></div>
        <div className="sr-sbody">
          <div className="sr-statgrid">
            {profile ? (<>
              <div className="sr-stat"><span className="l">Pipeline process time</span><span className="v strong">{fmtMs(P.total)}</span></div>
              <div className="sr-stat"><span className="l">Throughput (bytes)</span><span className="v">{fmtBytes(P.bytesIn)} → {fmtBytes(P.bytesOut)}</span></div>
              <div className="sr-stat"><span className="l">Events in → out</span><span className="v">{P.eventsIn ?? '—'} → {P.eventsOut ?? '—'}{dropDelta ? <span className="drop"> (−{dropDelta})</span> : null}</span></div>
              {P.cpu && <div className="sr-stat"><span className="l">CPU (user / system)</span><span className="v">{fmtMs(P.cpu.user)} / {fmtMs(P.cpu.system)}</span></div>}
            </>) : (
              <div className="sr-stat"><span className="l">Pipeline process time</span><span className="v sr-dim">{profileState === 'loading' ? 'measuring in Cribl…' : profileState === 'error' ? 'unavailable' : '—'}</span></div>
            )}
          </div>

          {profile && P.fns.length > 0 && (
            <table className="sr-fns">
              <thead><tr><th>Function</th><th>Events in → out</th><th>Bytes in → out</th><th>Process time</th><th>%</th></tr></thead>
              <tbody>
                {P.fns.map((f, i) => {
                  const pct = P.total ? Math.round((f.duration / P.total) * 100) : null;
                  const dropped = f.eventsOut < f.eventsIn;
                  return (
                    <tr key={i}>
                      <td><code>{f.func}</code></td>
                      <td className={dropped ? 'drop' : ''}>{f.eventsIn} → {f.eventsOut}{dropped ? ` (−${f.eventsIn - f.eventsOut})` : ''}</td>
                      <td>{fmtBytes(f.bytesIn)} → {fmtBytes(f.bytesOut)}</td>
                      <td>{fmtMs(f.duration)}</td>
                      <td>{pct == null ? '—' : `${pct}%`}</td>
                    </tr>
                  );
                })}
                <tr className="total"><td><strong>Summary total</strong></td><td>{P.eventsIn ?? '—'} → {P.eventsOut ?? '—'}</td><td>{fmtBytes(P.bytesIn)} → {fmtBytes(P.bytesOut)}</td><td><strong>{fmtMs(P.total)}</strong></td><td>100%</td></tr>
              </tbody>
            </table>
          )}

          {st && (
            <div className="sr-statgrid sr-substats">
              <div className="sr-stat"><span className="l">Sample event size in → out</span><span className="v">{fmtBytes(st.bytesIn)} → {fmtBytes(st.bytesOut)}</span></div>
              <div className="sr-stat"><span className="l">Sample _raw before → after</span><span className="v">{fmtBytes(st.rawIn)} → {fmtBytes(st.rawOut)}</span></div>
              <div className="sr-stat"><span className="l">Sample events measured</span><span className="v">{st.measured ?? '—'}</span></div>
              <div className="sr-stat"><span className="l">Sample events dropped / suppressed</span><span className="v drop">{sampleDropped(st, P)} {st.measured != null ? <span className="sr-dim" style={{ fontWeight: 400 }}>of {st.measured}</span> : null}</span></div>
            </div>
          )}
          <p className="sr-statnote">Per-function process time, bytes and events are the live Cribl Pipeline Profile — the same numbers as Cribl's preview "Pipeline Profile" tab. Sample sizes are the serialized preview events (up to 8).</p>
        </div>
      </section>
    </>
  );
}

// Sample events dropped = measured minus what the live profile emitted, when the
// profile measured the same sample; else 0 (nothing observed dropped).
function sampleDropped(st: ReportSampleStats, P: ReturnType<typeof profileNumbers>): number {
  if (st.measured != null && P.eventsIn != null && P.eventsOut != null && P.eventsIn === st.measured) {
    return Math.max(0, P.eventsIn - P.eventsOut);
  }
  if (P.eventsIn != null && P.eventsOut != null) return Math.max(0, P.eventsIn - P.eventsOut);
  return 0;
}

// ---- standalone downloadable HTML report (one page per format) --------------
function downloadReport(data: ReportFormatVM[], profiles: Record<string, CriblPipelineProfile | null>, packId?: string, workerGroup?: string) {
  downloadHtmlFile(buildReportHtml(data, profiles, packId, workerGroup), `pack-scoring-report${packId ? '-' + packId : ''}.html`);
}

/** Save a standalone HTML report as a file (shared by every report download). */
export function downloadHtmlFile(html: string, filename: string) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const reportScoreColor = (b: string) => b === 'good' ? '#389e0d' : b === 'warn' ? '#d48806' : b === 'fail' ? '#cf1322' : '#8c8c8c';

// The report stylesheet, shared verbatim by the single-pack download and the
// batch run report so both read identically (same compact 2×2 layout, same
// bands). A batch adds only the summary index + per-pack banner classes.
const REPORT_STYLE = `
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e;margin:0;padding:20px;background:#fff;font-size:12px;line-height:1.4;}
  .wrap{max-width:1000px;margin:0 auto;}
  h1{font-size:18px;margin:0 0 2px;} .meta{color:#8c8c8c;font-size:11px;margin-bottom:14px;}
  .page{border-top:2px solid #e6e8ee;padding-top:12px;margin-top:16px;}
  .page:first-of-type{border-top:none;margin-top:0;}
  h2{font-size:15px;margin:0 0 8px;} h2 code{font-size:11px;font-weight:400;color:#8c8c8c;} h2 .does{font-size:12px;font-weight:400;color:#8c8c8c;margin-left:6px;}
  h3{font-size:11px;margin:12px 0 5px;text-transform:uppercase;letter-spacing:.03em;color:#3a3a4e;} h3 .sc{font-weight:800;margin-left:6px;}
  .col > h3:first-child{margin-top:2px;}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;}
  .grid2 > *{min-width:0;} .col{min-width:0;overflow-wrap:anywhere;}
  .scorehead{display:flex;gap:14px;background:#f7f9fc;border:1px solid #e6e8ee;border-radius:10px;padding:10px 14px;align-items:center;}
  .overall{border-right:1px solid #e6e8ee;padding-right:16px;text-align:center;min-width:96px;} .overall .big{font-size:30px;font-weight:800;line-height:1;} .overall .lbl{font-size:10px;text-transform:uppercase;color:#8c8c8c;margin-top:4px;}
  .stagescores{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;flex:1;}
  .ss-n{font-size:10px;text-transform:uppercase;color:#8c8c8c;} .ss-v{font-size:18px;font-weight:800;font-family:monospace;line-height:1.1;} .badge{font-size:10px;color:#555;}
  pre.raw,pre.json{background:#0b0f14;color:#e6edf3;border-radius:6px;padding:8px 10px;overflow-x:auto;font-family:'SF Mono',Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0;}
  pre.raw span{border-radius:3px;padding:0 2px;color:#fff;}
  .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;} .chip{border:1px solid;border-radius:6px;padding:2px 7px;font-size:11px;font-family:monospace;}
  .diff{display:grid;grid-template-columns:1fr 20px 1fr;border:1px solid #e6e8ee;border-radius:6px;overflow:hidden;}
  .dh{font-size:10px;text-transform:uppercase;color:#8c8c8c;padding:4px 6px;background:#f7f9fc;border-bottom:1px solid #e6e8ee;}
  .drow{display:contents;} .c{padding:3px 6px;font-family:monospace;font-size:11px;border-bottom:1px solid #f0f1f4;word-break:break-word;}
  .c.mid{text-align:center;color:#b6bcc4;} .c.src{color:#0958d9;} .c.dest{color:#389e0d;} .c.drop{color:#8c8c8c;text-decoration:line-through;} .c.add{color:#389e0d;} .c.dim{color:#b6bcc4;}
  .reason{color:#8c8c8c;font-size:11px;margin:0 0 5px;} .note{font-size:10.5px;color:#8c8c8c;margin:5px 0 0;} .dim{color:#8c8c8c;}
  .fmt{font-size:11px;font-weight:600;margin-left:8px;} .fmt.ok{color:#389e0d;} .fmt.warn{color:#d48806;}
  .fmt-note{font-size:11px;margin:6px 0 0;} .fmt-note.ok{color:#389e0d;} .fmt-note.warn{color:#d48806;}
  .opts{font-size:11px;margin-top:8px;} .opts>b{font-size:10px;text-transform:uppercase;color:#3a3a4e;} .opts ul{margin:3px 0 0;padding-left:16px;} .opts li{margin:1px 0;}
  table.fns{width:100%;border-collapse:collapse;font-size:10.5px;} table.fns th{text-align:left;color:#8c8c8c;font-size:9.5px;text-transform:uppercase;padding:3px 6px;border-bottom:1px solid #e6e8ee;}
  table.fns td{padding:3px 6px;border-bottom:1px solid #f0f1f4;font-family:monospace;} table.fns td.drop{color:#d48806;} table.fns tr.total td{border-top:2px solid #e6e8ee;font-weight:700;}
  table.summary{width:100%;border-collapse:collapse;font-size:11px;margin:0 0 8px;} table.summary th{text-align:left;color:#8c8c8c;font-size:9.5px;text-transform:uppercase;padding:5px 8px;border-bottom:1px solid #e6e8ee;} table.summary th.n,table.summary td.n{text-align:right;}
  table.summary td{padding:5px 8px;border-bottom:1px solid #f0f1f4;} table.summary td.n{font-family:monospace;font-weight:700;} table.summary a{color:#0958d9;text-decoration:none;}
  .packgroup{margin-top:24px;} .packgroup:first-of-type{margin-top:8px;}
  .packeyebrow{font-size:11px;color:#3a3a4e;text-transform:uppercase;letter-spacing:.04em;border-left:3px solid #0958d9;padding-left:8px;margin-bottom:2px;} .packeyebrow b{font-weight:700;}
  .viz-link{color:#5b2cb3;text-decoration:none;}
  .error-box{color:#cf1322;background:#fff1f0;border:1px solid #ffccc7;border-radius:8px;padding:8px 12px;font-size:11px;}
  @media print{ @page{margin:12mm;} .page{page-break-inside:avoid;} .grid2{gap:12px;} .packgroup{page-break-before:auto;} }
`;

// One format's section (score header + the 2×2 stage grid). Shared by the
// single-pack report and every per-pack page inside the batch report; `profile`
// is null when no live pipeline profile was fetched (the batch path), which the
// statistics block degrades to "not available" rather than omitting.
function renderFormatPage(vm: ReportFormatVM, profile: CriblPipelineProfile | null): string {
  const P = profileNumbers(profile);
  const fields = vm.extractedFields.map((f, i) => ({ ...f, color: COLORS[i % COLORS.length] }));
  const segs = vm.rawLine ? rawSegments(vm.rawLine, fields) : [];
  const rawHtml = segs.length ? segs.map(s => s.color ? `<span style="background:${s.color}22;box-shadow:inset 0 -2px 0 ${s.color}">${esc(s.text)}</span>` : esc(s.text)).join('') : '<span style="color:#8c8c8c">No sample event captured.</span>';
  const chips = fields.map(f => `<span class="chip" style="border-color:${f.color}55;background:${f.color}12;color:${f.color}"><b>${esc(f.name)}</b> ${esc(f.value.length > 40 ? f.value.slice(0, 40) + '…' : f.value)}</span>`).join('');
  const mapRows = [
    ...vm.mappings.map(m => `<div class="drow"><div class="c src">${esc(m.from || '—')}</div><div class="c mid">→</div><div class="c dest">${esc(m.to)}</div></div>`),
    ...vm.droppedFields.map(d => `<div class="drow"><div class="c drop">${esc(d)}</div><div class="c mid">→</div><div class="c dim">dropped</div></div>`),
    ...vm.addedFields.map(a => `<div class="drow"><div class="c dim">—</div><div class="c mid">＋</div><div class="c add">${esc(a)}</div></div>`),
  ].join('');
  const fnRows = P.fns.map(f => {
    const pct = P.total ? Math.round((f.duration / P.total) * 100) : null;
    const dropped = f.eventsOut < f.eventsIn;
    return `<tr><td><code>${esc(f.func)}</code></td><td${dropped ? ' class="drop"' : ''}>${f.eventsIn} → ${f.eventsOut}${dropped ? ` (−${f.eventsIn - f.eventsOut})` : ''}</td><td>${fmtBytes(f.bytesIn)} → ${fmtBytes(f.bytesOut)}</td><td>${fmtMs(f.duration)}</td><td>${pct == null ? '—' : pct + '%'}</td></tr>`;
  }).join('');
  // Live profile → the full per-function table. No live profile (every batch
  // page) → fall back to the per-stage measurements persisted at build time so
  // the statistics block still carries real numbers instead of "not available".
  const stageStats = vm.stageStats || [];
  const stageRows = stageStats.map(s =>
    `<tr><td><code>${esc(s.label)}</code></td><td>${s.events ?? '—'}</td><td>${fmtBytes(s.bytesIn)} → ${fmtBytes(s.bytesOut)}</td><td>${s.durationMs == null ? '—' : fmtMs(s.durationMs)}</td></tr>`).join('');
  const statsTable = (profile && P.fns.length)
    ? `<table class="fns"><thead><tr><th>Function</th><th>Events in → out</th><th>Bytes in → out</th><th>Process time</th><th>%</th></tr></thead><tbody>${fnRows}<tr class="total"><td><strong>Summary total</strong></td><td>${P.eventsIn ?? '—'} → ${P.eventsOut ?? '—'}</td><td>${fmtBytes(P.bytesIn)} → ${fmtBytes(P.bytesOut)}</td><td><strong>${fmtMs(P.total)}</strong></td><td>100%</td></tr></tbody></table>`
    : stageStats.length
      ? `<table class="fns"><thead><tr><th>Stage</th><th>Events</th><th>Bytes in → out</th><th>Process time</th></tr></thead><tbody>${stageRows}</tbody></table><p class="note">Per-stage measurements captured during the build (no live pipeline profile in a batch run).</p>`
      : '<p class="dim">Live pipeline profile not available.</p>';
  const ss = (name: string, s: ReportStageScore) => {
    const b = bandOfScore(s.v);
    return `<div class="ss"><div class="ss-n">${name}</div><div class="ss-v" style="color:${reportScoreColor(b)}">${s.v == null ? 'N/A' : s.v}</div><div class="badge">${esc(SRC_LABEL[s.src])}</div></div>`;
  };
  const optsHtml = vm.appliedOptimizations.length
    ? `<div class="opts"><b>Optimizations applied (${vm.appliedOptimizations.length})</b><ul>${vm.appliedOptimizations.map(o => `<li><b>${esc(o.label)}</b>${o.reduction ? ` · ~${o.reduction}%` : ''} — ${esc(o.description)}</li>`).join('')}</ul></div>`
    : '';
  // One pack = one page, split into two columns: the linear read of the event —
  // 1 Raw in, 2 Extraction, 4 Output, then the Σ statistics — stacks down the
  // LEFT, while 3 Mapping (the tall input→output diff) gets the whole RIGHT
  // column to itself so a long field list no longer squeezes everything else.
  // Formats flow with page-break-inside:avoid rather than a forced break each.
  return `<section class="page">
      <h2>${esc(vm.pipelineId)} <span class="does">${esc(vm.formatLabel)}</span></h2>
      <div class="scorehead">
        <div class="overall"><div class="big" style="color:${reportScoreColor(vm.band)}">${vm.average ?? '—'}</div><div class="lbl">Average · value coverage</div></div>
        <div class="stagescores">${ss('Extraction', vm.scores.extraction)}${ss('Mapping', vm.scores.mapping)}${ss('Optimization', vm.scores.optimization)}</div>
      </div>
      <div class="grid2">
        <div class="col">
          <h3>1 · Raw in</h3><pre class="raw">${rawHtml}</pre>
          <h3>2 · Extraction <span class="sc" style="color:${reportScoreColor(bandOfScore(vm.scores.extraction.v))}">${vm.scores.extraction.v ?? 'N/A'}</span></h3>
          ${vm.extractionReason ? `<p class="reason">${esc(vm.extractionReason)}</p>` : ''}<div class="chips">${chips}</div>
          <h3>4 · Output event ${vm.formatValid == null ? '' : vm.formatValid ? '<span class="fmt ok">✓ Format validated</span>' : '<span class="fmt warn">⚠ Format issues</span>'}</h3>
          <pre class="json">${esc(vm.outputEvent)}</pre>
          ${vm.formatValid != null && vm.formatNote ? `<p class="fmt-note ${vm.formatValid ? 'ok' : 'warn'}">${vm.formatValid ? '✓' : '⚠'} ${esc(vm.formatNote)}</p>` : ''}
          ${optsHtml}
          <h3>Σ · Pipeline statistics</h3>${statsTable}
        </div>
        <div class="col">
          <h3>3 · Mapping → ${esc(vm.formatLabel)} <span class="sc" style="color:${reportScoreColor(bandOfScore(vm.scores.mapping.v))}">${vm.scores.mapping.v ?? 'N/A'}</span></h3>
          ${vm.mappingReason ? `<p class="reason">${esc(vm.mappingReason)}</p>` : ''}
          <div class="diff"><div class="dh">Extracted (input)</div><div class="dh"></div><div class="dh">Output (${esc(vm.formatLabel)})</div>${mapRows}</div>
          ${vm.unmappedRideAlong.length ? `<p class="note">Kept, not dropped: <b>${esc(vm.unmappedRideAlong.join(', '))}</b> ride along inside <code>_raw</code>.</p>` : ''}
        </div>
      </div>
    </section>`;
}

/**
 * The standalone report page: shared stylesheet, title, meta line, body. Exported
 * so other screens' downloads (Improve, improve-report.ts) read identically;
 * `extraStyle` is appended after the shared sheet for their own blocks.
 */
export function reportShell(title: string, metaHtml: string, bodyHtml: string, extraStyle = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${REPORT_STYLE}${extraStyle}</style></head><body><div class="wrap">
  <h1>${esc(title)}</h1>
  <div class="meta">${metaHtml}</div>
  ${bodyHtml}
</div></body></html>`;
}

export function buildReportHtml(data: ReportFormatVM[], profiles: Record<string, CriblPipelineProfile | null>, packId?: string, workerGroup?: string): string {
  const pages = data.map(vm => renderFormatPage(vm, profiles[vm.pipelineId] ?? null)).join('\n');
  const meta = `${data.length} output format${data.length === 1 ? '' : 's'}${workerGroup ? ' · on <code>' + esc(workerGroup) + '</code>' : ''} · generated ${new Date().toLocaleString()}`;
  return reportShell(`Pack scoring report${packId ? ' — ' + packId : ''}`, meta, pages);
}

/** One pack inside a batch run report: its formats, or a read error. */
export interface BatchReportPack {
  packId: string;
  sourcetype?: string;
  data: ReportFormatVM[];
  error?: string;   // set when the row's artifact could not be read
}

/**
 * The whole-run scoring report: a summary index of every pack, then one compact
 * per-format page each — the SAME `renderFormatPage` the single-pack download
 * uses, so a batch report reads identically to a hand-built one. Live pipeline
 * profiles are omitted (the statistics block degrades gracefully); everything
 * else is reconstructed from each row's persisted build artifact.
 */
export function buildBatchReportHtml(
  packs: BatchReportPack[],
  meta: { workerGroup?: string; runId?: string; visualizerBaseUrl?: string | null; visualizerAvailability?: VisualizerAvailability | null } = {},
): string {
  // Baked at generation time: this HTML is opened as a standalone blob URL
  // (see openBatchReportHtml in App.tsx), detached from the live app's
  // run-mode context by the time anyone clicks a link in it. A static page
  // cannot show a notice, so links are left out only when the Visualizer is
  // known to be missing; unless it is known to be installed, the header warns.
  const canLinkVisualizer = !!meta.visualizerBaseUrl && !!meta.workerGroup;
  const visualizerInstalled = meta.visualizerAvailability === 'installed';
  const visualizerMissing = meta.visualizerAvailability === 'missing';
  const visualizerLink = (packId: string, pipelineId?: string): string => {
    if (!canLinkVisualizer || visualizerMissing || !meta.visualizerBaseUrl || !meta.workerGroup) return '';
    const href = pipelineVisualizerUrl(meta.visualizerBaseUrl, meta.workerGroup, packId, pipelineId);
    return ` <a class="viz-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="Open in the Pipeline Visualizer">🔗</a>`;
  };
  const cell = (s: ReportStageScore) => `<td class="n" style="color:${reportScoreColor(bandOfScore(s.v))}">${s.v ?? '—'}</td>`;
  const summaryRows = packs.map((p, i) => {
    if (p.error) {
      return `<tr><td><a href="#pack-${i}">${esc(p.packId)}</a></td><td class="dim" colspan="5">read failed — ${esc(p.error)}</td></tr>`;
    }
    return p.data.map(vm => `<tr><td><a href="#pack-${i}">${esc(p.packId)}</a>${visualizerLink(p.packId, vm.pipelineId)}</td><td>${esc(vm.formatLabel)}</td>${cell(vm.scores.extraction)}${cell(vm.scores.mapping)}${cell(vm.scores.optimization)}<td class="n" style="color:${reportScoreColor(vm.band)}">${vm.average ?? '—'}</td></tr>`).join('');
  }).join('');
  const summary = `<table class="summary"><thead><tr><th>Pack</th><th>Output format</th><th class="n">Extract</th><th class="n">Map</th><th class="n">Optimize</th><th class="n">Overall</th></tr></thead><tbody>${summaryRows}</tbody></table>`;
  const sections = packs.map((p, i) => {
    const eyebrow = `<div class="packeyebrow">Pack <b>${esc(p.packId)}</b>${p.sourcetype ? ` · <span class="dim">${esc(p.sourcetype)}</span>` : ''}${visualizerLink(p.packId)}</div>`;
    const body = p.error
      ? `<p class="error-box">Could not read this pack's scorecard: ${esc(p.error)}</p>`
      : (p.data.length ? p.data.map(vm => renderFormatPage(vm, null)).join('\n') : '<p class="dim">No built formats recorded for this pack.</p>');
    return `<section class="packgroup" id="pack-${i}">${eyebrow}${body}</section>`;
  }).join('\n');
  const totalFormats = packs.reduce((n, p) => n + p.data.length, 0);
  const metaHtml = `${packs.length} pack${packs.length === 1 ? '' : 's'} · ${totalFormats} output format${totalFormats === 1 ? '' : 's'}${meta.workerGroup ? ' · on <code>' + esc(meta.workerGroup) + '</code>' : ''}${meta.runId ? ' · run <code>' + esc(meta.runId) + '</code>' : ''} · generated ${new Date().toLocaleString()}${canLinkVisualizer && !visualizerInstalled && !visualizerMissing ? '<br><span class="dim">' + esc(VISUALIZER_REPORT_NOTE) + '</span>' : ''}`;
  return reportShell('Batch scoring report', metaHtml, summary + sections);
}
