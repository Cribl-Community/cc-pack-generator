/**
 * "What we can demo" — the validation screen (spec R10, R15; plan Task 9;
 * docs/mockups/discovery-whiteboard.html). Each row pairs what was said on the board
 * (in the board's own handwriting face) with what the app will build. The rules live
 * in src/discovery-validation.ts; this file is the screen.
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { placePicker } from './picker-placement';
import { extractIntake } from './discovery-intake';
import { demoFormatOptions, destFormatChoices, type DestFormatGroup } from './discovery-match';
import {
  aliasesToRemember, initValidation, lakeFormat, lakeIncluded, mergeAliases, reduceValidation, toDiscoveryValidation,
  validationBlockers, validationPlan, type DestRow, type SourceRow, type ValidationState,
} from './discovery-validation';
import { demoSeedFromPlan, type DemoSeed } from './discovery-demo-seed';
import { DEMO_MAX_FORMATS, DEMO_MAX_SOURCES } from './demo-flow';
import { FLOW_FORMATS, FLOW_SYSTEMS } from './flow-builder';
import { lakeDatasetDecision } from './lake-dataset';
import { demoNamespaceFor } from './demo-flow-ids';
import { searchSupportedSourcetypes } from './pack-builder';
import { aiSuggestDemoFormat, aiSuggestSourceForLabel, fetchReferenceAvailability, listLakeAndSearchDatasetIds } from './api';
import { REFERENCE_SOURCES } from './discovery-match';
import { getSupportedSourcetypeCatalog } from './source-recognition';
import { createAutosaver, saveBoard, saveLibrary } from './whiteboard-store';
import type { WhiteboardDoc, WhiteboardLibV5 } from './whiteboard/types';

const RETENTION_CHOICES = [7, 30, 90, 365];

function Join({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'off' }) {
  return (
    <span className={`wbv-join ${tone}`} aria-hidden="true">
      {tone === 'off' || tone === 'bad'
        ? <svg viewBox="0 0 56 22" preserveAspectRatio="none"><path d="M2 11c10 0 16-4 24 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="3 5" /></svg>
        : <svg viewBox="0 0 56 22" preserveAspectRatio="none"><path d="M2 12c12-6 22 5 34-1 6-3 10-2 16 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><path d="M48 7l6 5-7 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </span>
  );
}

function FormatChip({ format }: { format: string }) {
  const info = FLOW_FORMATS[format];
  const sys = info ? FLOW_SYSTEMS[info.system] : undefined;
  return (
    <span className="wbv-fmt">
      <i style={{ background: sys?.color || '#6b7280' }}>{sys?.letter || '?'}</i>{info?.label || format}
    </span>
  );
}

/** A row's format options: one system is a flat list, several are grouped by system. */
function FormatOptions({ groups }: { groups: DestFormatGroup[] }) {
  if (groups.length === 1) return <>{groups[0].options.map(o => <option key={o.format} value={o.format}>{o.label}</option>)}</>;
  return <>{groups.map(g => (
    <optgroup key={g.title} label={g.title}>{g.options.map(o => <option key={o.format} value={o.format}>{o.label}</option>)}</optgroup>
  ))}</>;
}

function SourcePicker({ row, onAdd, onClose }: { row: SourceRow; onAdd: (st: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    if (!q.trim()) return row.match.candidates.map(c => ({ name: c.sourcetype, description: c.description, sample: c.sample }));
    return searchSupportedSourcetypes(q, 12).map(r => ({ name: r.name, description: r.description, sample: undefined as undefined | 'ready' | 'ai' }));
  }, [q, row.match.candidates]);
  const ref = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Fit the whole picker on screen, its Done included: below the row when there is room above the
  // sticky bar, otherwise above the row, with a max-height for the space it has (picker-placement.ts).
  // Re-measured when the results change or the frame resizes.
  useLayoutEffect(() => {
    const el = box.current, anchor = el?.offsetParent;
    if (!el || !anchor) return;
    const place = () => placePicker(el, anchor, document.querySelector('.wbv-dock'));
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [results.length]);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return (
    <div ref={box} className="wbv-picker" role="dialog" aria-label={`Choose sources for ${row.label}`} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <input ref={ref} type="search" value={q} placeholder="Search every supported source" aria-label="Search sources" onChange={e => setQ(e.target.value)} />
      {results.length === 0 && <p className="wbv-empty">No supported source matches “{q}”.</p>}
      {results.map(r => {
        const on = row.picks.includes(r.name);
        return (
          <button key={r.name} type="button" className={`wbv-opt${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onAdd(r.name)}>
            <span><code>{r.name}</code>{r.description && <small>{r.description}</small>}</span>
            {r.sample && <span className={`wbv-tier ${r.sample}`}>{r.sample === 'ready' ? 'Sample ready' : 'AI-generated at deploy'}</span>}
          </button>
        );
      })}
      <div className="wbv-picker-foot"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
    </div>
  );
}

interface ScreenProps {
  board: WhiteboardDoc;
  lib: WhiteboardLibV5 | null;
  onBack: () => void;
  onContinue: (seed: DemoSeed) => void;
  onToast: (msg: string) => void;
}

/** Loads what the matcher needs (sample availability), then mounts the screen. */
export default function DiscoveryValidate(props: ScreenProps) {
  const intake = useMemo(() => extractIntake(props.board.meet, props.lib), [props.board.meet, props.lib]);
  const [availability, setAvailability] = useState<Record<string, { hasSamples: boolean }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchReferenceAvailability()
      .then(r => { if (!cancelled) setAvailability(r.availability || {}); })
      .catch(() => { if (!cancelled) setAvailability({}); });   // no badges, still usable
    return () => { cancelled = true; };
  }, []);
  if (!availability) return <p className="wb-loading">Checking the board against the app…</p>;
  const initial = initValidation(intake, { availability, aliases: props.lib?.discoveryAliases }, props.board.validation);
  return <ValidateScreen {...props} intake={intake} availability={availability} initial={initial} />;
}

function ValidateScreen({ board, lib, onBack, onContinue, onToast, intake, availability, initial }: ScreenProps & {
  intake: ReturnType<typeof extractIntake>;
  availability: Record<string, { hasSamples: boolean }>;
  initial: ValidationState;
}) {
  const [s, dispatch] = useReducer(reduceValidation, initial);
  const act = dispatch;
  const [picking, setPicking] = useState<string | null>(null);
  // AI suggestions for rows nothing matched (spec R18): shown under the row, applied only on a click.
  const [ai, setAi] = useState<Record<string, { asking: boolean; picks?: string[]; format?: string | null; why?: string }>>({});
  const catalogNames = useMemo(() => [...getSupportedSourcetypeCatalog().map(c => c.name), ...REFERENCE_SOURCES], []);
  const askSource = async (r: SourceRow) => {
    setAi(a => ({ ...a, [r.key]: { asking: true } }));
    const res = await aiSuggestSourceForLabel(r.label, catalogNames).catch(err => ({ status: 'unavailable' as const, picks: [], why: `The AI did not answer: ${err instanceof Error ? err.message : String(err)}` }));
    setAi(a => ({ ...a, [r.key]: { asking: false, picks: res.picks, why: res.why } }));
  };
  const askDest = async (r: DestRow) => {
    setAi(a => ({ ...a, [r.key]: { asking: true } }));
    const res = await aiSuggestDemoFormat(r.label, r.match.status === 'unresolved' ? demoFormatOptions() : destFormatChoices(r.match, r.format).flatMap(g => g.options));
    setAi(a => ({ ...a, [r.key]: { asking: false, format: res.format, why: res.why } }));
  };
  const aiBlock = (key: string, ask: () => void, askLabel: string, apply: (v: string) => void, chips: (v: { picks?: string[]; format?: string | null }) => Array<{ value: string; label: string }>) => {
    const st = ai[key];
    if (!st) return <button type="button" className="wbv-ai-ask" onClick={ask}>{askLabel}</button>;
    if (st.asking) return <span className="wbv-why" role="status">Asking AI…</span>;
    const list = chips(st);
    return (
      <span className="wbv-ai">
        {list.map(c => <button key={c.value} type="button" className="wbv-ai-chip" onClick={() => apply(c.value)}><i>AI</i>{c.label}</button>)}
        {st.why && <span className="wbv-why">{list.length ? '' : 'AI: '}{st.why}</span>}
      </span>
    );
  };
  const docRef = useRef(board);

  const lakeAsked = useRef(false);
  useEffect(() => {
    if (lakeAsked.current || s.lake.available !== null || !s.dests.some(r => r.match.status === 'lake')) return;
    lakeAsked.current = true;
    listLakeAndSearchDatasetIds()
      .then(ids => act({ type: 'lake-status', available: true, lakeIds: ids.lakeIds, searchIds: ids.searchIds, deletingIds: ids.deletingIds }))
      .catch(() => act({ type: 'lake-status', available: false, lakeIds: [], searchIds: [] }));
  }, [s.lake.available, s.dests]);

  // Every decision is saved on the board (spec R10), debounced like the board itself.
  const saver = useMemo(() => createAutosaver<WhiteboardDoc>(d => saveBoard(d, lib), { delayMs: 600 }), [lib]);
  useEffect(() => () => { void saver.flush().then(() => saver.dispose()); }, [saver]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }   // opening the screen is not an edit
    docRef.current = { ...docRef.current, validation: toDiscoveryValidation(s) };
    saver.push(docRef.current);
  }, [s, saver]);


  const plan = validationPlan(s);
  const blockers = validationBlockers(s);
  const blocked = blockers.length > 0;

  const persistAndContinue = async () => {
    await saver.flush();
    const remembered = aliasesToRemember(s);
    if (lib && (Object.keys(remembered.sources).length || Object.keys(remembered.dests).length)) {
      const r = await saveLibrary({ ...lib, discoveryAliases: mergeAliases(lib.discoveryAliases, remembered) });
      if (!r.ok) onToast(`Your choices were not remembered: ${r.message}`);
    }
    // The board's demo namespace, fixed on its first generate (renaming the prospect does not move the demo).
    const ns = docRef.current.demoNs || demoNamespaceFor(s.prospect, board.id);
    if (!docRef.current.demoNs) {
      docRef.current = { ...docRef.current, demoNs: ns };
      const r = await saveBoard(docRef.current, lib);
      if (!r.ok) { onToast(`Not saved: ${r.message}`); return; }
    }
    onContinue(demoSeedFromPlan(plan, { id: board.id, prospect: s.prospect, fingerprint: s.fingerprint, ns }));
  };

  const sourceTone = (r: SourceRow): 'ok' | 'warn' | 'bad' | 'off' =>
    r.leftOut ? 'off' : r.picks.length === 0 ? (r.match.status === 'choose' ? 'warn' : 'bad') : r.match.status === 'choose' && !r.changed ? 'warn' : 'ok';
  const destTone = (r: DestRow): 'ok' | 'warn' | 'bad' | 'off' =>
    r.leftOut || r.match.status === 'cribl' ? 'off' : r.match.status === 'lake' ? 'ok' : !r.format ? (r.match.status === 'hint' ? 'warn' : 'bad') : r.match.status === 'choose' || r.match.status === 'no-format' ? 'warn' : 'ok';

  const leaveBtn = (key: string, leftOut: boolean) => (
    <button type="button" className="wbv-leave" onClick={() => act({ type: 'leave-out', key, leftOut: !leftOut })}>{leftOut ? 'Put back' : 'Leave out of the demo'}</button>
  );
  const rememberBox = (key: string, on: boolean, text = 'Remember for next time') => (
    <label className="wbv-remember"><input type="checkbox" checked={on} onChange={e => act({ type: 'remember', key, remember: e.target.checked })} />{text}</label>
  );

  return (
    <div className="wbv">
      <div className="wbv-steps"><b>Check what we can demo</b><i>/</i>Worker group<i>/</i>Destinations<i>/</i>Routing<i>/</i>Deploy</div>
      <div className="wb-head">
        <div>
          <h2>{s.prospect || 'Untitled prospect'}: what we can demo</h2>
          <p>Each line pairs what was written on the board with what the app will build. Change any line; your choices are saved on the board, so you can stop and come back.</p>
        </div>
        <div className="wb-actions"><button type="button" className="btn-secondary" onClick={onBack}>Back to the board</button></div>
      </div>

      {(intake.pains.length > 0 || intake.useCases.length > 0) && (
        <div className="wbv-context">
          {intake.pains.length > 0 && <><span className="wbv-lbl">Situation</span>{intake.pains.map(p => <span key={p} className="wbv-pain">{p}</span>)}</>}
          {intake.useCases.length > 0 && <><span className="wbv-lbl">Use cases</span>{intake.useCases.map(u => <span key={u} className="wbv-uc">{u}</span>)}</>}
        </div>
      )}

      <section className="wbv-ledger" aria-labelledby="wbv-src-h">
        <div className="wbv-lhead"><h3 id="wbv-src-h">Sources</h3>
          <span className={`wbv-meter${plan.sources.length > DEMO_MAX_SOURCES ? ' over' : ''}`}><b>{plan.sources.length}</b> of {DEMO_MAX_SOURCES} sources</span></div>
        <div className="wbv-cols"><span>Said on the board</span><span /><span>We’ll build</span><span /></div>
        {s.sources.length === 0 && <p className="wbv-empty">No sources on the board yet.</p>}
        {s.sources.map(r => (
          <div key={r.key} className={`wbv-row${r.leftOut ? ' out' : ''}`}>
            <div className="wb-said">{r.label}{r.isNew && <span className="wbv-new">New since last check</span>}
              {r.match.status === 'transport' && <small>A transport, not a source</small>}</div>
            <Join tone={sourceTone(r)} />
            <div className="wbv-build">
              {r.picks.map(p => {
                const c = r.match.candidates.find(x => x.sourcetype === p);
                const tier = c?.sample ?? (availability[p]?.hasSamples ? 'ready' : 'ai');
                return (
                  <span key={p} className="wbv-pick"><code>{p}</code>
                    <span className={`wbv-tier ${tier}`}>{tier === 'ready' ? 'Sample ready' : 'AI-generated at deploy'}</span>
                    <button type="button" className="wbv-x" aria-label={`Remove ${p}`} onClick={() => act({ type: 'source-remove', key: r.key, sourcetype: p })}>&times;</button>
                  </span>
                );
              })}
              {!r.leftOut && (
                <button type="button" className="wbv-add" aria-expanded={picking === r.key} onClick={() => setPicking(picking === r.key ? null : r.key)}>
                  {r.picks.length ? 'Add another' : r.match.status === 'transport' ? `Pick the source sent over ${r.label}` : `Choose the source for ${r.label}`}
                </button>
              )}
              {r.match.why && !r.leftOut && <span className={`wbv-why ${sourceTone(r)}`}>{r.match.why}</span>}
              {r.match.status === 'unresolved' && !r.leftOut && r.picks.length === 0 && aiBlock(r.key, () => void askSource(r), 'Ask AI for a match',
                st => act({ type: 'source-add', key: r.key, sourcetype: st }),
                v => (v.picks || []).map(p => ({ value: p, label: p })))}
              {r.leftOut && <span className="wbv-why">Left out of the demo; it stays on the board.</span>}
            </div>
            <div className="wbv-ctl">
              {r.changed && !r.leftOut && rememberBox(r.key, r.remember)}
              {leaveBtn(r.key, r.leftOut)}
            </div>
            {picking === r.key && <SourcePicker row={r} onAdd={st => act(r.picks.includes(st) ? { type: 'source-remove', key: r.key, sourcetype: st } : { type: 'source-add', key: r.key, sourcetype: st })} onClose={() => setPicking(null)} />}
          </div>
        ))}
      </section>

      <section className="wbv-ledger" aria-labelledby="wbv-dst-h">
        <div className="wbv-lhead"><h3 id="wbv-dst-h">Destinations</h3>
          <span className={`wbv-meter${plan.formats.length > DEMO_MAX_FORMATS ? ' over' : ''}`}><b>{plan.formats.length}</b> of {DEMO_MAX_FORMATS} formats</span></div>
        <div className="wbv-cols"><span>Said on the board</span><span /><span>We’ll build</span><span /></div>
        {s.dests.length === 0 && <p className="wbv-empty">No destinations on the board yet.</p>}
        {s.dests.map(r => {
          const isLake = r.match.status === 'lake';
          const lakeOn = isLake && !r.leftOut && s.lake.available !== false;
          const decision = lakeOn && s.lake.available ? lakeDatasetDecision(s.lake.datasetId, s.lake.retentionPeriodInDays, s.lake.lakeIds, s.lake.searchIds, s.lake.deletingIds) : null;
          return (
            <div key={r.key} className={`wbv-row${r.leftOut || r.match.status === 'cribl' ? ' out' : ''}`}>
              <div className="wb-said">{r.label}{r.isNew && <span className="wbv-new">New since last check</span>}</div>
              <Join tone={destTone(r)} />
              <div className="wbv-build">
                {r.match.status === 'cribl' && <span className="wbv-why">{r.match.why}</span>}
                {isLake && s.lake.available === false && <span className="wbv-why bad">Cribl Lake needs a Cribl.Cloud organization; this one has none. Left out.</span>}
                {lakeOn && (
                  <>
                    <span className="wbv-fmt"><i style={{ background: '#00CCCC' }}>L</i>{decision?.ok && decision.reuse ? 'Existing Lake dataset' : 'New Lake dataset'}</span>
                    <label className="wbv-field">Dataset id
                      <input value={s.lake.datasetId} spellCheck={false} aria-invalid={decision ? !decision.ok : undefined}
                        onChange={e => act({ type: 'lake-id', datasetId: e.target.value })} /></label>
                    <label className="wbv-field">Format
                      <select value={lakeFormat(s)} onChange={e => act({ type: 'dest-format', key: r.key, format: e.target.value })}>
                        <FormatOptions groups={destFormatChoices(r.match, lakeFormat(s))} />
                      </select></label>
                    <label className="wbv-field">Keep for
                      <select value={s.lake.retentionPeriodInDays} onChange={e => act({ type: 'lake-retention', days: Number(e.target.value) })}>
                        {[...new Set([...RETENTION_CHOICES, s.lake.retentionPeriodInDays])].sort((a, b) => a - b).map(d => <option key={d} value={d}>{d === 365 ? '1 year' : `${d} days`}</option>)}
                      </select></label>
                    <label className="wbv-remember wbv-dash">
                      <input type="checkbox" checked={s.lake.dashboard} onChange={e => act({ type: 'lake-dashboard', on: e.target.checked })} />
                      Also build a Cribl Search dashboard on this dataset
                    </label>
                    <span className={`wbv-why${decision && !decision.ok ? ' bad' : ''}`}>
                      {s.lake.available === null ? 'Checking Cribl Lake on this organization…'
                        : decision && !decision.ok ? decision.message
                        : decision?.ok && decision.reuse ? `The demo reuses ${s.lake.datasetId} as it is, adds a Cribl Lake destination in Stream and routes the ${FLOW_FORMATS[validationPlan(s).lake?.format || 'ocsf']?.label || 'OCSF'} copy of each source to it.`
                        : `The demo creates this dataset, a Cribl Lake destination in Stream and routes the ${FLOW_FORMATS[validationPlan(s).lake?.format || 'ocsf']?.label || 'OCSF'} copy of each source to it. Searchable at once as dataset="${s.lake.datasetId}". Kept when the demo is cleaned up, unless you choose to delete it.`}
                      {s.lake.dashboard && s.lake.available && decision?.ok && ' Then it builds a Cribl Search dashboard over the dataset, with KPIs the AI picks from the fields each source stores there.'}
                    </span>
                  </>
                )}
                {!isLake && r.match.status !== 'cribl' && !r.leftOut && (
                  <>
                    {r.format && <FormatChip format={r.format} />}
                    {r.match.status === 'hint' && !r.format ? (
                      <div className="wbv-hint"><p>{r.match.why}</p>
                        <button type="button" className="btn-primary" onClick={() => act({ type: 'dest-format', key: r.key, format: r.match.format! })}>Use {FLOW_FORMATS[r.match.format!]?.label}</button></div>
                    ) : (r.match.why && <span className={`wbv-why ${destTone(r)}`}>{r.match.why}</span>)}
                    {(r.match.status === 'unresolved' || r.match.status === 'no-format') && aiBlock(r.key, () => void askDest(r), 'Ask AI which format',
                      f => act({ type: 'dest-format', key: r.key, format: f }),
                      v => (v.format ? [{ value: v.format, label: FLOW_FORMATS[v.format]?.label || v.format }] : []))}
                    {(() => {
                      const groups = destFormatChoices(r.match, r.format);
                      // Only the format the row already builds (XSIAM, CrowdStrike): nothing to change.
                      if (r.format && groups.every(g => g.options.every(o => o.format === r.format))) return null;
                      return (
                        <select className="wbv-select" aria-label={`Change the format for ${r.label}`} value=""
                          onChange={e => e.target.value && act({ type: 'dest-format', key: r.key, format: e.target.value })}>
                          <option value="">{r.format ? 'Change format…' : 'Pick a format…'}</option>
                          <FormatOptions groups={groups} />
                        </select>
                      );
                    })()}
                  </>
                )}
                {r.leftOut && !isLake && r.match.status !== 'cribl' && <span className="wbv-why">Left out of the demo; it stays on the board.</span>}
              </div>
              <div className="wbv-ctl">
                {r.changed && !r.leftOut && !isLake && rememberBox(r.key, r.remember, `Remember ${r.label} as ${FLOW_FORMATS[r.format || '']?.label || r.format}`)}
                {r.match.status !== 'cribl' && !(isLake && s.lake.available === false) && leaveBtn(r.key, r.leftOut)}
              </div>
            </div>
          );
        })}
      </section>

      <div className="wbv-dock">
        {blocked
          ? <p className="block" role="status">{blockers.length === 1 ? '1 thing' : `${blockers.length} things`} to settle: {blockers.map(b => b.message).join('. ')}.</p>
          : <p role="status"><b>{plan.sources.length} source{plan.sources.length === 1 ? '' : 's'} to {plan.formats.length} format{plan.formats.length === 1 ? '' : 's'}{lakeIncluded(s) ? ', with Cribl Lake' : ''}.</b> Next you pick the worker group; nothing is written to Cribl until Deploy.</p>}
        <button type="button" className="btn-secondary" onClick={() => { void saver.flush().then(() => onToast('Saved on the board')); }}>Save and finish later</button>
        <button type="button" className="btn-primary" disabled={blocked} onClick={() => void persistAndContinue()}>Continue to worker group</button>
      </div>
    </div>
  );
}
