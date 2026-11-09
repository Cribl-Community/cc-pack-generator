// Performance mode panel inside the scoring report. Runs the check automatically (both
// versions through Data Preview on the pack sample); offers Apply only at 0 differences.
// Apply and Undo deploy the worker group, so they only ever run from a click.
import { useEffect, useRef, useState } from 'react';
import { applyPerformanceMode, checkPerformanceMode, undoPerformanceMode, type PerfModeCheck, type PerfModeTarget } from './perf-mode';
import type { LibraryState } from './vendor-field-library';

/** What the vendor field library said for this source type: confirmed fields anchor removal, a closed entry also proves absence. */
function LibraryNote({ on, library, neverSeen, sourcetype }: { on: boolean; library: LibraryState | null | undefined; neverSeen: string[]; sourcetype?: string }) {
  if (!on) return <p className="sr-dim">Vendor field library off: evals are merged, every fallback is kept.</p>;
  if (!library) return <p className="sr-dim">No vendor field library entry for {sourcetype || 'this source type'}: every fallback is kept.</p>;
  const shown = neverSeen.slice(0, 30).join(', ') + (neverSeen.length > 30 ? `, … (${neverSeen.length - 30} more)` : '');
  return (
    <>
      {library.status === 'open' && <p className="sr-dim">Vendor field library entry {library.key} is open: {library.confirmed.length} confirmed fields ({library.learned.length} learned from samples on this install). Fallbacks around a confirmed field are removed; a chain without one keeps all its fallbacks.</p>}
      {library.status === 'reopened' && (
        <p className="sr-reason">
          Vendor field library entry {library.key} is closed, but builds saw fields it does not list ({library.unexpected.slice(0, 20).join(', ')}).
          The list is incomplete: fallbacks are only removed around its confirmed fields until the entry is reviewed again.
        </p>
      )}
      {library.status === 'closed' && <p className="sr-dim">Vendor field library entry {library.key} is closed (reviewed {library.entry.reviewedAt || 'n/a'}{library.entry.version ? `, ${library.entry.version}` : ''}).</p>}
      {neverSeen.length > 0 && library.status !== 'closed' && (
        <p className="sr-dim">For the library review: {neverSeen.length} fallback fields are neither documented nor seen on a build for {library.key}: {shown}. Add the real ones to the entry; until it is closed they are only removed in a chain that also reads a confirmed field.</p>
      )}
    </>
  );
}

type Phase = 'checking' | 'checked' | 'applying' | 'applied' | 'undoing' | 'error';

const ms = (v: number | null) => (v == null ? 'n/a' : `${v.toFixed(1)} ms`);

export function PerformanceModePanel({ target }: { target: PerfModeTarget }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [check, setCheck] = useState<PerfModeCheck | null>(null);
  const [error, setError] = useState('');
  // Same StrictMode-safe dedupe as the report's profile fetch.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    checkPerformanceMode(target)
      .then(c => { setCheck(c); setPhase('checked'); })
      .catch(e => { setError(String(e?.message || e)); setPhase('error'); });
  }, [target]);

  const run = (next: Phase, done: Phase, fn: () => Promise<void>) => {
    setPhase(next);
    fn().then(() => setPhase(done)).catch(e => { setError(String(e?.message || e)); setPhase('error'); });
  };

  const ready = check?.status === 'ready' ? check : null;
  return (
    <section className="sr-stage">
      <div className="sr-shead"><span className="sr-num">⚡</span><strong>Performance mode</strong><span className="sr-sub">{target.allowCode ? 'cleaned pipeline compiled into Code functions' : 'cleaned pipeline from standard Functions'}, cross-checked on the pack sample</span></div>
      <div className="sr-sbody">
        {phase === 'checking' && <p className="sr-dim">Running both versions in Data Preview…</p>}
        {phase === 'error' && <p className="sr-reason">Performance mode check failed: {error}</p>}
        {check?.status === 'not-applicable' && (
          <>
            <p className="sr-dim">{check.reason}</p>
            {check.neverSeen && <LibraryNote on={!!target.useLibrary} library={check.library} neverSeen={check.neverSeen} sourcetype={target.sourcetype} />}
          </>
        )}
        {check?.status === 'differs' && (
          <p className="sr-reason">
            Not offered: {check.differing} of {check.events} events differ ({check.fields.join(', ') || 'event count'}). The pipeline stays as generated.
          </p>
        )}
        {ready && (
          <>
            <p className="sr-reason">
              Identical output on all {ready.events} sample events. {ready.before.functions} → {ready.after.functions} Functions,{' '}
              {ready.native.orBefore} → {ready.native.orAfter} <code>||</code> ({ready.native.mergedEvals} evals merged,{' '}
              {ready.native.prunedOperands} fallbacks removed{ready.compiled ? `, ${ready.compiled.compiledCount} compiled into ${ready.compiled.blocks} Code function${ready.compiled.blocks === 1 ? '' : 's'}` : ''});
              function time in preview {ms(ready.before.ms)} → {ms(ready.after.ms)}.
            </p>
            {ready.native.prunedOperands > 0 && (
              <p className="sr-dim">
                Removed fallbacks read fields that the reviewed field list for {ready.library?.key} does not contain: {ready.native.prunedFields.join(', ')}.
                The pipeline carries a comment saying so; Undo restores the generated pipeline.
              </p>
            )}
            {ready.native.pruneBlockedBy && <p className="sr-dim">No fallbacks removed: the pipeline has a {ready.native.pruneBlockedBy} Function whose output fields cannot be listed.</p>}
            <LibraryNote on={!!target.useLibrary} library={ready.library} neverSeen={ready.native.neverSeen} sourcetype={target.sourcetype} />
            {phase === 'checked' && (
              <button className="sr-download" onClick={() => run('applying', 'applied', () => applyPerformanceMode(target, ready))}>
                Apply performance mode and deploy
              </button>
            )}
            {phase === 'applying' && <p className="sr-dim">Deploying…</p>}
            {phase === 'applied' && (
              <>
                <p className="sr-dim">Deployed. The original Functions are kept here until you leave this report.</p>
                <button className="sr-download" onClick={() => run('undoing', 'checked', () => undoPerformanceMode(target, ready))}>
                  Undo and deploy the original
                </button>
              </>
            )}
            {phase === 'undoing' && <p className="sr-dim">Restoring the original Functions…</p>}
          </>
        )}
      </div>
    </section>
  );
}
