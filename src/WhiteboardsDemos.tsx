/**
 * Whiteboards & demos — the live demos on every worker group, and Stop / Start / Destroy
 * for ONE of them while the others keep running. The model is src/demo-control.ts;
 * this file scans, acts and draws a demo's strip. Actions on one worker group run one
 * after another (each edits that group's route table or inputs, then commits + deploys).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cleanupDemo, deleteLakeDataset, listGroups, scanDemo, setDemoRunning, type DemoScanResult } from './api';
import { loadBoard, loadLibrary, saveBoard } from './whiteboard-store';
import { markGroupReleased } from './discovery-demo-seed';
import { intakeFingerprint } from './whiteboard/board-model';
import type { DemoDeploymentRecord, WhiteboardDoc, WhiteboardIndexEntry, WhiteboardLibV5 } from './whiteboard/types';
import {
  DEMO_STATE_LABEL, boardsByNamespace, demoFlowLabel, destroySelection, liveDemosOnGroup, liveRecordsByGroup,
  missingRecords, runToggleIds, type LiveDemo,
} from './demo-control';

type Busy = 'stopping' | 'starting' | 'destroying' | 'forgetting';
const BUSY_LABEL: Record<Busy, string> = { stopping: 'Stopping…', starting: 'Starting…', destroying: 'Destroying…', forgetting: 'Saving…' };
const msgOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export interface LiveDemos {
  loading: boolean;
  /** Groups read on the last check (null = not checked yet). */
  checkedGroups: number | null;
  failed: { group: string; message: string }[];
  byBoard: Map<string, LiveDemo[]>;
  /** Made by hand, or their whiteboard is not in this app (deleted, or in another browser). */
  unlinked: LiveDemo[];
  /** A board's live records that the scan no longer finds on their group. */
  missingByBoard: Map<string, DemoDeploymentRecord[]>;
  busy: Record<string, Busy>;
  otherDemosOn: (d: LiveDemo) => number;
  refresh: () => Promise<void>;
  stop: (d: LiveDemo, label: string) => void;
  start: (d: LiveDemo, label: string) => void;
  destroy: (d: LiveDemo, label: string, deleteLake: boolean) => void;
  forget: (boardId: string, rec: DemoDeploymentRecord) => void;
}

export function useLiveDemos(rows: WhiteboardIndexEntry[] | null, opts: {
  /** false = no demos on this page: nothing is scanned. */
  enabled: boolean;
  onToast: (msg: string) => void;
  /** A board's deployment records changed: re-read the list. */
  onBoardsChanged: () => void;
}): LiveDemos {
  const { enabled, onToast, onBoardsChanged } = opts;
  const [scans, setScans] = useState<Map<string, DemoScanResult>>(new Map());
  const [failed, setFailed] = useState<{ group: string; message: string }[]>([]);
  const [checkedGroups, setCheckedGroups] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [docs, setDocs] = useState<Map<string, WhiteboardDoc>>(new Map());
  const [lib, setLib] = useState<WhiteboardLibV5 | null>(null);
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const queues = useRef(new Map<string, Promise<unknown>>());
  const alive = useRef(true);
  // Set on every mount: StrictMode mounts, unmounts and mounts again, and a ref left false drops every result.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const groups = (await listGroups()).filter(g => g.type === 'stream').map(g => g.id);
      const results = await Promise.all(groups.map(g => scanDemo(g).then(
        scan => ({ group: g, scan, message: '' }),
        err => ({ group: g, scan: null, message: msgOf(err) }),
      )));
      if (!alive.current) return;
      setScans(new Map(results.filter(r => r.scan).map(r => [r.group, r.scan!])));
      setFailed(results.filter(r => !r.scan).map(r => ({ group: r.group, message: r.message })));
      setCheckedGroups(groups.length);
    } catch (err) {
      if (alive.current) setFailed([{ group: '', message: `The worker groups could not be listed: ${msgOf(err)}` }]);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  // The boards that ever had a demo: their records say what each demo shows and since when.
  const withDemo = (enabled ? rows || [] : []).filter(r => r.demo).map(r => `${r.id}@${r.updatedAt}`).join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = withDemo ? withDemo.split(',').map(s => s.split('@')[0]) : [];
    void Promise.all([loadLibrary(), ...ids.map(id => loadBoard(id))]).then(([l, ...ds]) => {
      if (cancelled) return;
      setLib(l as WhiteboardLibV5 | null);
      setDocs(new Map((ds as (WhiteboardDoc | null)[]).filter((d): d is WhiteboardDoc => !!d).map(d => [d.id, d])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [withDemo]);

  const model = useMemo(() => {
    const boardOfNs = boardsByNamespace(rows || []);
    for (const d of docs.values()) if (d.demoNs) boardOfNs.set(d.demoNs, d.id);
    const records = [...docs.values()].flatMap(doc => {
      const fp = intakeFingerprint(lib, doc.meet);
      return liveRecordsByGroup(doc.deployments).map(record => ({ boardId: doc.id, record, stale: record.intakeFingerprint !== fp }));
    });
    const all = [...scans.entries()].flatMap(([group, scan]) => liveDemosOnGroup(group, scan, boardOfNs, records));
    const byBoard = new Map<string, LiveDemo[]>();
    for (const d of all) if (d.boardId) byBoard.set(d.boardId, [...(byBoard.get(d.boardId) || []), d]);
    const missingByBoard = new Map<string, DemoDeploymentRecord[]>();
    for (const doc of docs.values()) {
      const gone = missingRecords(liveRecordsByGroup(doc.deployments), scans);
      if (gone.length) missingByBoard.set(doc.id, gone);
    }
    return { all, byBoard, unlinked: all.filter(d => !d.boardId), missingByBoard };
  }, [rows, docs, lib, scans]);

  /** One action at a time per worker group; the demo shows what it is doing meanwhile. */
  const run = (group: string, key: string, what: Busy, fn: () => Promise<void>) => {
    setBusy(b => ({ ...b, [key]: what }));
    const prev = queues.current.get(group) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn)
      .catch(err => onToast(msgOf(err)))
      .finally(() => { if (alive.current) setBusy(b => { const { [key]: _, ...rest } = b; return rest; }); });
    queues.current.set(group, next);
  };
  const rescan = async (group: string) => {
    try {
      const scan = await scanDemo(group);
      if (alive.current) setScans(m => new Map(m).set(group, scan));
    } catch (err) {
      onToast(`Could not check ${group} again: ${msgOf(err)}`);
    }
  };
  const scanOf = (group: string) => {
    const s = scans.get(group);
    if (!s) throw new Error(`${group} has not been checked yet. Press Check again.`);
    return s;
  };

  const toggle = (d: LiveDemo, label: string, running: boolean) =>
    run(d.group, d.key, running ? 'starting' : 'stopping', async () => {
      const ids = runToggleIds(scanOf(d.group), d.ns, running);
      const r = ids.length ? await setDemoRunning(d.group, ids, running) : { changed: [], errors: [] };
      await rescan(d.group);
      if (r.errors.length) onToast(`${running ? 'Started' : 'Stopped'} ${r.changed.length} of ${ids.length} data generators of the ${label} demo on ${d.group}. ${r.errors.join('; ')}`);
      else onToast(running ? `Started the ${label} demo on ${d.group}.` : `Stopped the ${label} demo on ${d.group}. Its packs and routes are kept.`);
    });

  const release = async (group: string, ns: string) => {
    const at = new Date();
    let changed = false;
    for (const doc of docs.values()) {
      const next = markGroupReleased(doc, group, at, new Set([ns]));
      if (!next) continue;
      const saved = await saveBoard(next, lib);
      if (!saved.ok) throw new Error(`The demo is gone, but its whiteboard could not be updated: ${saved.message}`);
      changed = true;
    }
    if (changed) onBoardsChanged();
  };

  const destroy = (d: LiveDemo, label: string, deleteLake: boolean) =>
    run(d.group, d.key, 'destroying', async () => {
      const result = await cleanupDemo(d.group, destroySelection(scanOf(d.group), d.ns));
      const errors = [...result.errors];
      if (deleteLake && d.lakeDataset) {
        try { await deleteLakeDataset(d.lakeDataset); }
        catch (err) { errors.push(`Lake dataset ${d.lakeDataset}: ${msgOf(err)}`); }
      }
      await rescan(d.group);
      await release(d.group, d.ns);
      onToast(errors.length
        ? `Destroyed the ${label} demo on ${d.group}, except: ${errors.join('; ')}`
        : `Destroyed the ${label} demo on ${d.group}.`);
    });

  const forget = (boardId: string, rec: DemoDeploymentRecord) =>
    run(rec.group, `${boardId}::${rec.group}`, 'forgetting', async () => {
      const doc = docs.get(boardId);
      const next = doc && markGroupReleased(doc, rec.group, new Date(), new Set([rec.ns || '']));
      if (!next) return;
      const saved = await saveBoard(next, lib);
      if (!saved.ok) throw new Error(`Not saved: ${saved.message}`);
      onBoardsChanged();
    });

  return {
    loading, checkedGroups, failed, busy,
    byBoard: model.byBoard, unlinked: model.unlinked, missingByBoard: model.missingByBoard,
    otherDemosOn: (d) => model.all.filter(x => x.group === d.group && x.key !== d.key).length,
    refresh,
    stop: (d, label) => toggle(d, label, false),
    start: (d, label) => toggle(d, label, true),
    destroy,
    forget,
  };
}


const STATE_TONE: Record<LiveDemo['state'], string> = { running: 'teal', stopped: 'none', partial: 'warn' };

/** One demo: where it runs, what it shows, its state, and Stop/Start + Destroy. */
export function DemoStrip({ demo, busy, title, onStop, onStart, onDestroy }: {
  demo: LiveDemo;
  busy?: Busy;
  /** Shown before the group (the unlinked list names whose demo it is). */
  title?: string;
  onStop: () => void;
  onStart: () => void;
  onDestroy: () => void;
}) {
  const facts = [
    demo.state !== 'stopped' && demo.eventsPerSec ? `${demo.eventsPerSec} events/s` : '',
    demo.deployedAt ? `since ${day(demo.deployedAt)}` : '',
    `${demo.packs.length} pack${demo.packs.length === 1 ? '' : 's'}, ${demo.routes.length} route${demo.routes.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');
  const canStart = demo.datagens.length > 0;
  return (
    <div className="wb-demo">
      <div className="wb-demo-where">
        {title && <b className="wb-demo-title">{title}</b>}
        <span className="wb-demo-group">{demo.group}</span>
      </div>
      <div className="wb-demo-what">
        <span title={demo.sourcetypes.join(', ')}>{demoFlowLabel(demo)}</span>
        <small>{facts}{demo.stale && <span className="wb-demo-stale"> · Board changed since this demo</span>}</small>
      </div>
      <span className={`wb-chip ${busy ? 'none wb-chip-busy' : STATE_TONE[demo.state]}`}>{busy ? BUSY_LABEL[busy] : DEMO_STATE_LABEL[demo.state]}</span>
      <div className="wb-demo-acts">
        {demo.state === 'stopped'
          ? <button type="button" className="btn-secondary" disabled={!!busy || !canStart} onClick={onStart}
              title={canStart ? 'Turn its data generators back on' : 'This demo has no data generator left to start'}>Start</button>
          : <button type="button" className="btn-secondary" disabled={!!busy} onClick={onStop}
              title="Pause its data. Packs and routes stay, so Start brings it back in seconds">Stop</button>}
        <button type="button" className="btn-secondary wb-danger" disabled={!!busy} onClick={onDestroy}>Destroy</button>
      </div>
    </div>
  );
}

/** A board's demo the scan no longer finds: removed outside this app, most likely. */
export function MissingDemoStrip({ rec, busy, onForget }: { rec: DemoDeploymentRecord; busy?: boolean; onForget: () => void }) {
  return (
    <div className="wb-demo wb-demo-missing">
      <div className="wb-demo-where"><span className="wb-demo-group">{rec.group}</span></div>
      <div className="wb-demo-what">
        <span>Not found on {rec.group} any more</span>
        <small>Generated on {day(rec.deployedAt)}. It was probably removed outside this app.</small>
      </div>
      <span />
      <div className="wb-demo-acts">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onForget}>{busy ? 'Saving…' : 'Mark as removed'}</button>
      </div>
    </div>
  );
}

/** Destroy one demo: says exactly what goes, and that the other demos on the group stay. */
export function DestroyDemoDialog({ demo, label, others, onCancel, onConfirm }: {
  demo: LiveDemo; label: string; others: number;
  onCancel: () => void; onConfirm: (deleteLake: boolean) => void;
}) {
  const [lake, setLake] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onCancel]);
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  return (
    <div className="wb-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="wb-modal wb-destroy" role="dialog" aria-modal="true" aria-labelledby="wb-destroy-title">
        <div className="wb-modal-head">
          <h3 id="wb-destroy-title">Destroy the {label} demo on {demo.group}?</h3>
          <button type="button" className="wb-x" aria-label="Close" onClick={onCancel}>×</button>
        </div>
        <p className="wb-modal-sub">This removes from <b>{demo.group}</b>, then deploys the group:</p>
        <ul className="wb-destroy-list">
          <li>{n(demo.routes.length, 'route')}</li>
          <li>{n(demo.datagens.length, 'data generator')} and their samples</li>
          <li>{n(demo.packs.length, 'pack')}</li>
        </ul>
        <p className="wb-destroy-keep">
          {others > 0
            ? `The ${n(others, 'other demo')} on ${demo.group} keep running. Customer routes are not touched.`
            : `No other demo runs on ${demo.group}, so the shared demo terminator route goes too. Customer routes are not touched.`}
        </p>
        {demo.lakeDataset && (
          <label className="wb-cleanup-lake">
            <input type="checkbox" checked={lake} onChange={e => setLake(e.target.checked)} />
            Also delete Lake dataset <code>{demo.lakeDataset}</code> and the demo data in it
          </label>
        )}
        <div className="wb-destroy-row">
          <button type="button" ref={keepRef} className="btn-secondary" onClick={onCancel}>Keep the demo</button>
          <button type="button" className="btn-primary wb-danger-solid" onClick={() => onConfirm(lake)}>Destroy demo</button>
        </div>
      </div>
    </div>
  );
}
