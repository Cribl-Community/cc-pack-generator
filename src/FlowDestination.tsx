// Bottom-up destination flow canvas for "Build pack flow (including
// post-processing)". Rows, top → bottom: destination systems, post-processing
// band, pack pipelines, source. React port of
// docs/destination-redesign-mockup-v5-bottom-up.html; all plan logic (labels,
// counts, which packs get built) lives in flow-builder.ts.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  FLOW_SYSTEMS, flowFormatInfo, flowFormatOptimizable, flowSourceRules, flowHasOcsf, flowCounts, newPpOutput, ppOutputLabel, ppOutputSystem,
  ppChoices, ppChoiceFor, ppOutputPinned, ppBuildableSchemas, flowPackCheck, nextFreePackName, flowPackId, ppPackCheck, nextFreePpName, FLOW_ROUTE_FILTER,
  flowDestPickerGroups, flowStageToggle, flowStageSummary, ppPickerItems, OCSF_VALUE,
  flowDestinationSetup, flowDestinationSetupHeading, flowRecommendedFor,
  type FlowPpState, type FlowSystem, type FlowExistingPack, type FlowModelPick,
} from './flow-builder';
import './FlowDestination.css';

export interface FlowDestinationProps {
  sourcetype: string;
  /** The sample, so a card can check its shape against what the destination parses. */
  sampleEvents?: string;
  eventCount: number;
  /** Replaces the "N sample events" line under the source (the demo has several sources). */
  sourceNote?: string;
  destOptions: { value: string; label: string }[];
  destFormats: string[];
  /** Adds every format in one go (the picker stages several, then confirms). */
  onAddDests?: (fmts: string[]) => void;
  onRemoveDest?: (fmt: string) => void;
  /** Per-card Full fidelity (false/absent) / Optimize (true). */
  optimize: Record<string, boolean>;
  onOptimize?: (fmt: string, v: boolean) => void;
  /** Source noise-drop rule checkboxes (absent = the rule's default). */
  srcRules: Record<string, boolean>;
  onSrcRule?: (id: string, v: boolean) => void;
  ocsfKeepRaw: boolean;
  onOcsfKeepRaw?: (v: boolean) => void;
  pp: FlowPpState;
  onPpChange?: (pp: FlowPpState) => void;
  /** Review / done: same canvas, nothing clickable. */
  readOnly?: boolean;
  /** Default post-processing name when it is first added. */
  defaultPpName: string;
  /** Main pack name band (Build pack flow has no Name step). Absent = no band. */
  pack?: FlowPackBandProps;
  /** Per-format model / table / class picker shown in the card (flowModelPick). */
  models?: Record<string, FlowModelPick | null>;
  /** Current picks, keyed by FlowModelPick.field. */
  modelValues?: Partial<Record<FlowModelPick['field'], string>>;
  onModel?: (field: FlowModelPick['field'], value: string) => void;
}

export interface FlowPackBandProps {
  name: string;
  group: string;
  /** Packs already on the group; the band warns when the name's ID is one of them. */
  existing: FlowExistingPack[];
  loading?: boolean;
  overwrite: boolean;
  onName?: (v: string) => void;
  onOverwrite?: (v: boolean) => void;
  /** "<source> to <destinations>": the name follows it until the user types their own. */
  defaultName?: string;
  onResetName?: () => void;
  /** The same exists → rename / overwrite choice for the post-processing packs (ppPackCheck). */
  ppOverwrite?: boolean;
  onPpOverwrite?: (v: boolean) => void;
}

/** Pack name, live ID, and the exists → rename / overwrite choice. */
function PackBand({ pack, editable }: { pack: FlowPackBandProps; editable: boolean }) {
  const chk = flowPackCheck(pack.name, pack.existing, pack.overwrite);
  const ver = chk.existing?.version ? ` v${chk.existing.version}` : '';
  return (
    <div className="fd-pack-band">
      <div className="pk-row">
        <div className="pk-name">
          <label htmlFor="fd-pack-name">Pack name</label>
          <input id="fd-pack-name" type="text" value={pack.name} readOnly={!editable} placeholder="e.g. cisco asa to ocsf"
            onChange={e => { pack.onName?.(e.target.value); if (pack.overwrite) pack.onOverwrite?.(false); }} />
        </div>
        <p className="pk-meta">
          ID <code>{chk.id || '…'}</code> · description = name · route filter <code>{FLOW_ROUTE_FILTER}</code> (all events)
          {editable && pack.defaultName && pack.name !== pack.defaultName && (
            <> · <button type="button" className="pk-link" onClick={() => pack.onResetName?.()} title={`Back to “${pack.defaultName}”`}>use default name</button></>
          )}
        </p>
      </div>
      {editable && (pack.loading ? (
        <div className="pk-note">Checking packs on <code>{pack.group}</code>…</div>
      ) : !chk.id ? null : !chk.existing ? (
        <div className="pk-note ok">✓ New pack on <code>{pack.group}</code></div>
      ) : pack.overwrite ? (
        <div className="pk-note red" role="status">
          <span>Building will <b>overwrite</b> <code>{chk.id}</code>{ver} on <code>{pack.group}</code>.</span>
          <button type="button" className="pk-btn" onClick={() => pack.onOverwrite?.(false)}>Undo</button>
        </div>
      ) : (
        <div className="pk-note warn" role="status">
          <span>⚠ A pack <code>{chk.id}</code>{ver} already exists on <code>{pack.group}</code>.</span>
          <button type="button" className="pk-btn" onClick={() => pack.onName?.(nextFreePackName(pack.name, pack.existing))}>
            Rename to “{nextFreePackName(pack.name, pack.existing)}”
          </button>
          <button type="button" className="pk-btn danger" onClick={() => pack.onOverwrite?.(true)}>Overwrite it</button>
        </div>
      ))}
    </div>
  );
}

/** Post-processing band: warns when an output's pack ID already exists on the group. */
function PpExistsNote({ pack, pp, sourcetype, destFormats, onName }: {
  pack: FlowPackBandProps; pp: FlowPpState; sourcetype: string; destFormats: string[]; onName: (v: string) => void;
}) {
  const chk = ppPackCheck(pp.name, sourcetype, destFormats, pp, pack.existing, !!pack.ppOverwrite);
  if (pack.loading || !chk.existing.length) return null;
  const ids = chk.existing.map((h, i) => <span key={h.id}>{i > 0 && ', '}<code>{h.id}</code>{h.version ? ` v${h.version}` : ''}</span>);
  const many = chk.existing.length > 1;
  if (pack.ppOverwrite) {
    return (
      <div className="pk-note red" role="status">
        <span>Building will <b>overwrite</b> {ids} on <code>{pack.group}</code>.</span>
        <button type="button" className="pk-btn" onClick={() => pack.onPpOverwrite?.(false)}>Undo</button>
      </div>
    );
  }
  const rename = nextFreePpName(pp.name, sourcetype, destFormats, pp, pack.existing);
  return (
    <div className="pk-note warn" role="status">
      <span>⚠ {many ? 'Packs' : 'A pack'} {ids} already exist{many ? '' : 's'} on <code>{pack.group}</code>.</span>
      <button type="button" className="pk-btn" onClick={() => onName(rename)}>Rename to “{rename}”</button>
      <button type="button" className="pk-btn danger" onClick={() => pack.onPpOverwrite?.(true)}>Overwrite {many ? 'them' : 'it'}</button>
    </div>
  );
}

type WireColor = 'teal' | 'violet' | 'amber';
interface Wire { from: string; to: string; color: WireColor; pill?: string }
const WIRE: Record<WireColor, string> = { teal: '#5cc9c9', violet: '#a78bfa', amber: '#e0b84a' };
const STEP2 = 'Step 2 · after OCSF';

function SysBox({ sys, violet }: { sys: FlowSystem; violet?: boolean }) {
  return (
    <div className={`fd-sys${violet ? ' violet' : ''}`}>
      <span className="sl" style={{ background: sys.color }} aria-hidden="true">{sys.letter}</span>
      <div className="sn">{sys.name}</div>
    </div>
  );
}

function Seg({ value, onChange, labels, disabled }: { value: boolean; onChange?: (v: boolean) => void; labels: [string, string]; disabled?: boolean }) {
  return (
    <div className="fd-seg">
      {[false, true].map(v => (
        <button key={String(v)} type="button" className={`fd-seg-opt${value === v ? ' on' : ''}`} aria-pressed={value === v}
          disabled={disabled} onClick={() => onChange?.(v)}>
          <span className="d" />{labels[v ? 1 : 0]}
        </button>
      ))}
    </div>
  );
}

export default function FlowDestination(p: FlowDestinationProps) {
  const editable = !p.readOnly;
  const [picker, setPicker] = useState<'dest' | 'pp' | null>(null);
  // Destinations ticked in the picker but not yet added (confirmed by the footer button).
  const [staged, setStaged] = useState<string[]>([]);
  const closePicker = () => { setPicker(null); setStaged([]); };
  const rootRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; color: WireColor }[]>([]);
  const [pills, setPills] = useState<{ x: number; y: number; t: string }[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);

  const hasOcsf = flowHasOcsf(p.destFormats);
  const pp = hasOcsf ? p.pp : { ...p.pp, added: false, outputs: [] };
  const setPp = (next: Partial<FlowPpState>) => p.onPpChange?.({ ...p.pp, ...next });

  // ---- layout: grid cells + wires (mirrors the mockup's layout()) ----
  const cells: ReactNode[] = [];
  const wires: Wire[] = [];
  const narrow = new Set<number>();
  let c = 0;
  let addCol: number | null = null;
  const cell = (row: number, col: number, id: string, node: ReactNode, span = 1) =>
    cells.push(<div key={id} className="fd-cell" data-n={id} style={{ gridRow: row, gridColumn: `${col + 2} / span ${span}` }}>{node}</div>);
  // OCSF last, so its post-processing columns can extend to the right.
  const order = [...p.destFormats].sort((a, b) => (a === 'ocsf' ? 1 : 0) - (b === 'ocsf' ? 1 : 0));
  const ppChoiceCount = ppChoices().length;

  for (const fmt of order) {
    const info = flowFormatInfo(fmt);
    const sys = FLOW_SYSTEMS[info.system];
    wires.push({ from: 'src', to: `card-${fmt}`, color: 'teal' });
    const card = (
      <div className={`fd-card${info.ocsf ? ' ocsf' : ''}${editable ? '' : ' ro'}`}>
        {editable && <button type="button" className="rm" aria-label={`Remove ${info.label}`} title="Remove" onClick={() => p.onRemoveDest?.(fmt)}>×</button>}
        <div className="top">
          <div className={`ic ${info.ocsf ? 'ocsf' : info.group}`}>{info.ocsf ? '🗄️' : info.group === 'lake' ? '📦' : '📊'}</div>
          <div>
            <span className="name">{p.destOptions.find(o => o.value === fmt)?.label || info.label}</span>
            {info.aiReady && <span className="fd-ai-badge">AI-ready</span>}
            {info.notAiReady && <span className="fd-raw-chip">Raw · not AI-ready</span>}
            <span className="kind">{info.ocsf ? 'Lake / storage · your hub copy' : info.group === 'lake' ? 'Lake / storage' : 'Analytics tool'}</span>
          </div>
        </div>
        {(() => {
          const pick = p.models?.[fmt];
          if (!pick) return null;
          const cur = p.modelValues?.[pick.field];
          const value = pick.options.some(o => o.key === cur) ? cur! : pick.options[0].key;
          return (
            <label className="fd-model">
              <span>{pick.label}</span>
              <select className="fd-schema" value={value} disabled={!editable} onChange={e => p.onModel?.(pick.field, e.target.value)} aria-label={`${info.label} ${pick.label.toLowerCase()}`}>
                {pick.options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
          );
        })()}
        <div className="what">{info.what}</div>
        {(() => {
          const setup = flowDestinationSetup(fmt, p.sourcetype, p.sampleEvents);
          if (!setup) return null;
          const warn = setup.status !== 'ready';
          return (
            <div className={`fd-dest-setup${warn ? ' warn' : ''}`}>
              <div className="fd-dest-setup-h">{flowDestinationSetupHeading(setup)}</div>
              {setup.lines.map((l, i) => <p key={i}>{l}</p>)}
              {setup.routeEntries && <pre className="fd-dest-setup-code" aria-label="cribl integration route_entries">{setup.routeEntries}</pre>}
            </div>
          );
        })()}
        {flowFormatOptimizable(fmt, p.sourcetype) ? (() => {
          const on = p.optimize[fmt] === true;
          const rules = flowSourceRules(fmt, p.sourcetype);
          return (
            <div className="opt">
              <div className="opt-q">How should we send it?</div>
              <Seg value={on} onChange={v => p.onOptimize?.(fmt, v)} labels={['Full fidelity', 'Optimize']} disabled={!editable} />
              <div className="fd-seg-help">{on
                ? <><b>Optimize</b>: {fmt === 'cim' ? <>only the clean CIM model goes into <code>_raw</code>; unmapped vendor fields are dropped.</> : <>known-noise events are dropped before mapping.</>}</>
                : fmt === 'cim'
                  ? <><b>Full fidelity</b>: unmapped source fields are kept in <code>_raw</code> next to the CIM fields.</>
                  : <><b>Full fidelity</b>: every event is sent.</>}</div>
              {on && rules.length > 0 && (
                <div className="fd-rules" role="group" aria-label="Noise reduction rules">
                  <div className="fd-rules-h">Noise reduction (Cribl packs + same-category rules)</div>
                  {rules.map(r => (
                    <label key={r.id} className="fd-rule" title={r.description}>
                      <input type="checkbox" checked={p.srcRules[r.id] ?? r.defaultEnabled} disabled={!editable}
                        onChange={e => p.onSrcRule?.(r.id, e.target.checked)} />
                      <span>{r.label}{r.lookup && <small> · lookup <code>{r.lookup.file}</code></small>}{r.origin === 'generalized' && <small> · same-category rule</small>}</span>
                    </label>
                  ))}
                  <div className="fd-rules-note">Unticked rules still ship, switched off. Rules apply to every optimized destination.</div>
                </div>
              )}
            </div>
          );
        })() : (
          <div className="fd-fixed-note">{info.fixedNote}</div>
        )}
        {info.ocsf && (
          <div className="fd-raw-opt">
            <label className="fd-mini-switch">
              <input type="checkbox" checked={p.ocsfKeepRaw} disabled={!editable} onChange={e => p.onOcsfKeepRaw?.(e.target.checked)} />
              <span className="track2" />
            </label>
            <div>
              <div className="raw-title">Keep original <code>_raw</code><span className="fd-tag-compliance">compliance</span></div>
              <div className="raw-help">Carries the untouched source event in the OCSF <code>raw_data</code> field. Larger events; not counted in the quality score.</div>
            </div>
          </div>
        )}
      </div>
    );
    if (!info.ocsf) {
      cell(1, c, `sys-${fmt}`, <SysBox sys={sys} />);
      cell(3, c, `card-${fmt}`, card);
      wires.push({ from: `card-${fmt}`, to: `sys-${fmt}`, color: 'teal' });
      c += 1;
      continue;
    }
    const outs = pp.added ? pp.outputs : [];
    const canAdd = editable && pp.added && outs.length < ppChoiceCount;
    const extra = editable && (!pp.added || canAdd) ? 1 : 0;
    const k = 1 + outs.length + extra;
    cell(1, c, `sys-${fmt}`, <SysBox sys={sys} violet />);
    cell(3, c, `card-${fmt}`, card);
    if (k > 1) addCol = c + 1;
    wires.push({ from: `card-${fmt}`, to: `sys-${fmt}`, color: 'violet' });
    if (pp.added) {
      const inner: ReactNode[] = [];
      outs.forEach((o, j) => {
        const schemaOpts = ppOutputPinned(o) ? [] : ppBuildableSchemas(o.fmt);
        const setOut = (patch: Partial<typeof o>) => setPp({ outputs: p.pp.outputs.map((x, i) => i === j ? { ...x, ...patch } : x) });
        inner.push(
          <div key={`pp-${j}`} className="fd-cell" data-n={`pp-${j}`} style={{ gridColumn: j + 1 }}>
            <div className={`fd-ppo${editable ? '' : ' ro'}`}>
              {editable && <button type="button" className="rm" aria-label={`Remove ${ppOutputLabel(o)}`} onClick={() => setPp({ outputs: p.pp.outputs.filter((_, i) => i !== j) })}>×</button>}
              <div className="o-name">{ppOutputLabel(o)}</div>
              {schemaOpts.length > 0 && (
                <select className="fd-schema" value={o.schema ?? schemaOpts[0].key} disabled={!editable} onChange={e => setOut({ schema: e.target.value })} aria-label="Schema">
                  {schemaOpts.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              )}
              <div className="opt-q">Send as</div>
              <Seg value={o.optimize} onChange={v => setOut({ optimize: v })} labels={['Full copy', 'Optimize by category']} disabled={!editable} />
              <div className="fd-seg-help">{o.optimize
                ? <><b>Optimize by category</b>: drops and trims to what this product category needs.</>
                : <><b>Full copy</b>: the complete reshaped event, every field kept.</>}</div>
            </div>
          </div>,
        );
        cell(1, c + 1 + j, `ppsys-${j}`, <SysBox sys={ppOutputSystem(o.fmt)} violet />);
        wires.push({ from: `card-${fmt}`, to: `pp-${j}`, color: 'violet', pill: j === 0 ? STEP2 : undefined });
        wires.push({ from: `pp-${j}`, to: `ppsys-${j}`, color: 'violet' });
      });
      if (canAdd) {
        inner.push(
          <div key="ppadd" className="fd-cell" data-n="ppadd" style={{ gridColumn: outs.length + 1, alignSelf: 'stretch' }}>
            <button type="button" className="fd-tile amber out" onClick={() => setPicker('pp')}>
              ＋ Add an output format<small>{outs.length ? 'reshape the OCSF for another SIEM' : 'which SIEM should this OCSF reach?'}</small>
            </button>
          </div>,
        );
        narrow.add(c + 1 + outs.length);
        if (!outs.length) wires.push({ from: `card-${fmt}`, to: 'ppadd', color: 'amber', pill: STEP2 });
      }
      if (outs.length + extra > 0) {
        cells.push(
          <div key="pp-band" className="fd-pp-band" style={{ gridColumn: `${c + 3} / span ${outs.length + extra}` }}>
            <div className="pp-top">
              <div className="pp-h">
                <span className="pp-badge">OCSF add-on</span>
                <span className="pp-title">Post-processing packs</span>
                {editable && <button type="button" className="rm" style={{ marginLeft: 'auto' }} aria-label="Remove post-processing" title="Remove post-processing" onClick={() => setPp({ added: false, outputs: [] })}>×</button>}
              </div>
              <div className="pp-row">
                <div className="pp-name">
                  <label htmlFor="fd-pp-name">Name</label>
                  <input id="fd-pp-name" type="text" value={p.pp.name} readOnly={!editable} onChange={e => { setPp({ name: e.target.value }); if (p.pack?.ppOverwrite) p.pack.onPpOverwrite?.(false); }} />
                </div>
                <p className="pp-desc">Reshapes the OCSF from below into SIEM formats on the way out. Each output is its own attachable pack (<code>{flowPackId(p.pp.name || p.defaultPpName || 'source')}_to_&lt;format&gt;_post</code>). This is the only place data gets optimized.</p>
              </div>
              {editable && p.pack && <PpExistsNote pack={p.pack} pp={p.pp} sourcetype={p.sourcetype} destFormats={p.destFormats} onName={name => setPp({ name })} />}
            </div>
            {inner}
          </div>,
        );
      }
    } else if (editable) {
      cell(2, c + 1, 'suggest', (
        <div className="fd-suggest big">
          <h4>{OCSF_VALUE.title}</h4>
          <div className="fd-tiers">
            <div className="tier"><b>{OCSF_VALUE.tiers[0].name}</b>{OCSF_VALUE.tiers[0].what}<span className="c">{OCSF_VALUE.tiers[0].cost}</span></div>
            <div className="arr" aria-hidden="true">→</div>
            <div className="tier"><b>{OCSF_VALUE.tiers[1].name}</b>{OCSF_VALUE.tiers[1].what}<span className="c hi">{OCSF_VALUE.tiers[1].cost}</span></div>
          </div>
          <ul className="fd-ticks">
            {OCSF_VALUE.benefits.map(b => <li key={b.key}><span><b>{b.label}:</b> {b.text}</span></li>)}
          </ul>
          <button type="button" onClick={() => setPp({ added: true, name: p.pp.name || p.defaultPpName, outputs: p.pp.outputs.length ? p.pp.outputs : [] })}>＋ {OCSF_VALUE.cta}</button>
        </div>
      ));
      wires.push({ from: `card-${fmt}`, to: 'suggest', color: 'amber', pill: STEP2 });
    }
    c += k;
  }
  if (editable) {
    const ac = addCol ?? c;
    cell(3, ac, 'add', (
      <button type="button" className="fd-tile" onClick={() => setPicker('dest')}>
        ＋ Add a destination<small>{p.destFormats.length ? 'send this source somewhere else too' : 'pick where the data should go'}</small>
      </button>
    ));
    if (addCol == null) c += 1;
  }
  const n = Math.max(c, 1);
  const labels: [string, string, string][] = [
    ['l1', 'Destination systems', 'Where each output lands (labels only)'],
    ['l2', 'Post-processing', hasOcsf ? 'OCSF add-on: reshape for more SIEMs' : 'Only after OCSF. Add OCSF to unlock'],
    ['l3', 'Pack pipelines', 'One pipeline per format'],
    ['l4', 'Source', 'Your sample'],
  ];
  const srcSpan = Math.max(1, p.destFormats.length);
  const cols = `120px ${Array.from({ length: n }, (_, i) => (narrow.has(i) && pp.outputs.length ? '190px' : '270px')).join(' ')}`;
  const layoutKey = JSON.stringify([order, pp, p.optimize, p.srcRules, p.ocsfKeepRaw, editable]);

  // ---- zoom-to-fit + wire measurement ----
  const measure = () => {
    const root = rootRef.current, cv = cvRef.current;
    if (!root || !cv) return;
    const grid = cv.querySelector('.fd-grid') as HTMLElement | null;
    if (!grid) return;
    const avail = root.clientWidth - 28;
    const z = Math.max(0.6, Math.min(1, avail / grid.offsetWidth));
    if (Math.abs(z - zoom) > 0.01) { setZoom(z); return; }
    const wr = cv.getBoundingClientRect();
    const scale = grid.getBoundingClientRect().width / grid.offsetWidth || 1;
    const box = (id: string) => {
      const e = cv.querySelector(`[data-n="${id}"]`) as HTMLElement | null;
      if (!e) return null;
      const el = (e.firstElementChild as HTMLElement) || e;
      const r = el.getBoundingClientRect();
      // wires into the post-processing band attach to the band edge, so arrowheads aren't hidden under it
      const band = e.closest('.fd-pp-band');
      const v = band ? band.getBoundingClientRect() : r;
      return { l: (r.left - wr.left) / scale, t: (v.top - wr.top) / scale, w: r.width / scale, h: v.height / scale };
    };
    const groups = new Map<string, Wire[]>();
    for (const w of wires) groups.set(w.from, [...(groups.get(w.from) || []), w]);
    const nextPaths: { d: string; color: WireColor }[] = [];
    const nextPills: { x: number; y: number; t: string }[] = [];
    for (const [from, list] of groups) {
      const a = box(from);
      if (!a) continue;
      const tg = list.map(w => ({ w, b: box(w.to) })).filter(x => x.b)
        .sort((x, y) => (x.b!.l + x.b!.w / 2) - (y.b!.l + y.b!.w / 2));
      const m = tg.length, spread = Math.min(a.w * 0.7, (m - 1) * 46);
      tg.forEach((x, k) => {
        const b = x.b!;
        const x1 = a.l + a.w / 2 + (m > 1 ? (k / (m - 1) - 0.5) * spread : 0), y1 = a.t;
        const x2 = b.l + b.w / 2, y2 = b.t + b.h + 3, ym = (y1 + y2) / 2;
        if (x.w.pill) nextPills.push({ x: (x1 + x2) / 2, y: ym, t: x.w.pill });
        nextPaths.push({ d: `M${x1},${y1} C${x1},${ym} ${x2},${ym} ${x2},${y2}`, color: x.w.color });
      });
    }
    setSvgSize({ w: cv.scrollWidth, h: cv.scrollHeight });
    setPaths(nextPaths);
    setPills(nextPills);
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { measureRef.current(); }, [layoutKey, zoom]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureRef.current());
    ro.observe(root);
    const grid = cvRef.current?.querySelector('.fd-grid');
    if (grid) ro.observe(grid);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePicker(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picker]);

  const counts = flowCounts(p.destFormats, pp);
  // Post-processing choices already on the canvas, and the shared picker footer.
  const ppAdded = p.pp.outputs.map(o => ppChoiceFor(o)?.key).filter((k): k is string => !!k);
  const stageSum = picker === 'pp'
    ? flowStageSummary(staged, k => ppChoices().find(c => c.key === k)?.label || k, 'output')
    : flowStageSummary(staged);
  const confirmStaged = () => {
    if (picker === 'dest') p.onAddDests?.(staged);
    else {
      const add = staged.map(k => ppChoices().find(c => c.key === k)).filter(c => !!c).map(c => newPpOutput(c.fmt, c.schema));
      setPp({ outputs: [...p.pp.outputs, ...add] });
    }
    closePicker();
  };
  const idp = editable ? 'e' : 'r';

  return (
    <div className="fd" ref={rootRef}>
      {p.pack && <PackBand pack={p.pack} editable={editable} />}
      <div className="fd-legend">
        <span><i style={{ borderColor: WIRE.teal }} /> Main pack</span>
        <span><i style={{ borderColor: WIRE.violet }} /> OCSF and post-processing</span>
        {editable && <span><i style={{ borderColor: WIRE.amber, borderTopStyle: 'dashed' }} /> Optional next step</span>}
      </div>
      <div className="fd-canvas">
        <div className="fd-cv" ref={cvRef} style={{ zoom }}>
          <div className="fd-grid" style={{ gridTemplateColumns: cols }}>
            {labels.map(([cls, t, h], r) => [
              <div key={`bg-${cls}`} className={`fd-layer-bg ${cls}`} style={{ gridRow: r + 1 }} />,
              <div key={`lb-${cls}`} className="fd-layer-label" style={{ gridRow: r + 1 }}>
                <div className="lt">{t}</div><div className="lh">{h}</div>
                {r === 3 && <div className="up-hint">▲ data flows up</div>}
              </div>,
            ])}
            {cells}
            <div className="fd-cell" data-n="src" style={{ gridRow: 4, gridColumn: `2 / span ${srcSpan}` }}>
              <div className="fd-src">
                <div className="tag">Source</div><div className="si">📄</div>
                <div className="sn">{p.sourcetype || 'source'}</div>
                <small>{p.sourceNote ?? `${p.eventCount.toLocaleString()} sample event${p.eventCount === 1 ? '' : 's'}`}</small>
              </div>
            </div>
          </div>
          <svg className="fd-wires" width={svgSize.w} height={svgSize.h} aria-hidden="true">
            <defs>
              {(Object.keys(WIRE) as WireColor[]).map(k => (
                <marker key={k} id={`fd-ah-${k}-${idp}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={WIRE[k]} />
                </marker>
              ))}
            </defs>
            {paths.map((w, i) => (
              <path key={i} d={w.d} fill="none" stroke={WIRE[w.color]} strokeWidth={2.5}
                strokeDasharray={w.color === 'amber' ? '6 5' : undefined} markerEnd={`url(#fd-ah-${w.color}-${idp})`} />
            ))}
          </svg>
          {pills.map((x, i) => <span key={i} className="fd-wire-pill" style={{ left: x.x, top: x.y }}>{x.t}</span>)}
        </div>
      </div>
      {editable && (
        <div className="fd-foot-sum">
          {p.destFormats.length
            ? <><b>{counts.pipelines}</b> pipeline{counts.pipelines === 1 ? '' : 's'} across <b>{counts.packs}</b> pack{counts.packs === 1 ? '' : 's'}</>
            : 'Add a destination to continue'}
        </div>
      )}

      {picker && (
        <div className="fd-modal-bg" onClick={e => { if (e.target === e.currentTarget) closePicker(); }}>
          <div className="fd-modal" role="dialog" aria-modal="true" aria-labelledby="fd-modal-title">
            <div className="fd-modal-h">
              <h3 id="fd-modal-title">{picker === 'dest' ? 'Add a destination' : 'Add a post-processing output'}</h3>
              <p>{picker === 'dest' ? 'Tick where the data should go, then add them together.' : 'Tick the SIEM formats the OCSF should be reshaped into, then add them together.'}</p>
              <button type="button" className="x" aria-label="Close" onClick={closePicker}>×</button>
            </div>
            {picker === 'dest'
              ? <>
                {flowDestPickerGroups().map(g => (
                  <div key={g.group} className="fd-pick-group">
                    <div className="gh">{g.title}</div>
                    {g.items.map(item => {
                      if (item.kind === 'family') {
                        const addedCount = item.variants.filter(v => p.destFormats.includes(v.value)).length;
                        const shown = item.variants.filter(v => p.destFormats.includes(v.value) || staged.includes(v.value));
                        return (
                          <div key={item.key} className="fd-family">
                            <div className="fd-family-row">
                              <div className="fd-family-top">
                                <div className="pic analytics">📊</div>
                                <div>
                                  <div className="pname">{item.label}{addedCount > 0 && <span className="fd-ai-badge">{addedCount} added</span>}</div>
                                  <div className="pwhat">{item.what} → {FLOW_SYSTEMS[item.system].name}</div>
                                </div>
                              </div>
                              <div className="fd-family-seg" role="group" aria-label={`${item.label} output`}>
                                {item.variants.map(v => {
                                  const added = p.destFormats.includes(v.value);
                                  const on = staged.includes(v.value);
                                  return (
                                    <button key={v.value} type="button" className={`fd-family-opt${added ? ' added' : on ? ' on' : ''}`}
                                      disabled={added} aria-pressed={added || on} title={added ? 'Already on the canvas' : undefined}
                                      onClick={() => setStaged(st => flowStageToggle(st, v.value, p.destFormats))}>
                                      {v.label}{flowRecommendedFor(v.value, p.sourcetype, p.sampleEvents) === true && <span className="fd-rec-badge" title={`Recommended for ${p.sourcetype || 'this source'}`}>Recommended</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            {shown.length > 0 && (
                              <div className="fd-family-desc">
                                {shown.map(v => {
                                  const info = flowFormatInfo(v.value);
                                  return (
                                    <div key={v.value}>
                                      <b>{info.label}</b>: {info.what}{p.destFormats.includes(v.value) ? ' (on canvas)' : ''}
                                      {info.notAiReady && <span className="fd-raw-chip">Raw · not AI-ready</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      }
                      const info = flowFormatInfo(item.value);
                      const added = p.destFormats.includes(item.value);
                      const on = staged.includes(item.value);
                      return (
                        <button key={item.value} type="button" className={`fd-pick${info.aiReady ? ' hero' : ''}${added ? ' added' : on ? ' on' : ''}`}
                          disabled={added} aria-pressed={added || on}
                          onClick={() => setStaged(st => flowStageToggle(st, item.value, p.destFormats))}>
                          <div className={`pic ${info.ocsf ? 'ocsf' : g.group}`}>{info.ocsf ? '🗄️' : g.group === 'lake' ? '📦' : '📊'}</div>
                          <div>
                            <div className="pname">{item.label}{flowRecommendedFor(item.value, p.sourcetype, p.sampleEvents) === true && <span className="fd-rec-badge" title={`Recommended for ${p.sourcetype || 'this source'}`}>Recommended</span>}{info.aiReady && <span className="fd-ai-badge">AI-ready</span>}{info.notAiReady && <span className="fd-raw-chip">Raw · not AI-ready</span>}</div>
                            <div className="pwhat">{info.what} → {FLOW_SYSTEMS[info.system].name}</div>
                            {info.ocsf && <div className="fd-value-chips">{OCSF_VALUE.benefits.map(b => <span key={b.key} className={`fd-value-chip ${b.key}`}>{b.label}</span>)}</div>}
                          </div>
                          {added ? <div className="chk">on canvas</div> : <div className="box" aria-hidden="true">{on ? '✓' : ''}</div>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </>
              : (
                <div className="fd-pick-group">
                  {ppPickerItems().map(item => {
                    if (item.kind === 'family') {
                      const addedCount = item.variants.filter(v => ppAdded.includes(v.key)).length;
                      return (
                        <div key={item.key} className="fd-family">
                          <div className="fd-family-row">
                            <div className="fd-family-top">
                              <div className="pic analytics">📊</div>
                              <div>
                                <div className="pname">{item.label}{addedCount > 0 && <span className="fd-ai-badge">{addedCount} added</span>}</div>
                                <div className="pwhat">{item.what} → {item.system.name}</div>
                              </div>
                            </div>
                            <div className="fd-family-seg" role="group" aria-label={`${item.label} output`}>
                              {item.variants.map(v => {
                                const added = ppAdded.includes(v.key);
                                const on = staged.includes(v.key);
                                return (
                                  <button key={v.key} type="button" className={`fd-family-opt${added ? ' added' : on ? ' on' : ''}`}
                                    disabled={added} aria-pressed={added || on} title={added ? 'Already on the canvas' : undefined}
                                    onClick={() => setStaged(st => flowStageToggle(st, v.key, ppAdded))}>
                                    {v.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    }
                    const added = ppAdded.includes(item.key);
                    const on = staged.includes(item.key);
                    return (
                      <button key={item.key} type="button" className={`fd-pick${added ? ' added' : on ? ' on' : ''}`}
                        disabled={added} aria-pressed={added || on}
                        onClick={() => setStaged(st => flowStageToggle(st, item.key, ppAdded))}>
                        <div className="pic analytics">📊</div>
                        <div><div className="pname">{item.label}</div><div className="pwhat">→ {item.system.name}</div></div>
                        {added ? <div className="chk">on canvas</div> : <div className="box" aria-hidden="true">{on ? '✓' : ''}</div>}
                      </button>
                    );
                  })}
                </div>
              )}
            <div className="fd-modal-f">
              <span className="sum">{stageSum.text}</span>
              <button type="button" onClick={closePicker}>Cancel</button>
              <button type="button" className="primary" disabled={!staged.length} onClick={confirmStaged}>{stageSum.button}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
