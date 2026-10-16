// Where each batch row's sample WILL come from, before the user presses Next.
//
// The check screen used to say "Library sample when you continue" for every row
// without a chosen sample, while the sample pass behind Next (runPreflightPhase2)
// actually does one of four things: uses the store sample, extends a thin one,
// generates one with AI (at most PREFLIGHT_MODEL_CAP sources, generation first),
// or leaves generation to build time. This module replays that decision from a
// store-only lookup (the same reference + bundled read pass 1 does), so the
// column says what the run will do rather than the best case. The model work
// itself runs as the batch run's first stage ("Creating samples"), not on Next.

export type SampleForecastKind =
  /** The store lookup for this key has not answered yet. */
  | 'checking'
  /** The row's own events (picked or uploaded). */
  | 'own'
  /** A store sample with enough events. */
  | 'library'
  /** A store sample below the extension floor. `extendNow` says whether Next extends it. */
  | 'library-thin'
  /** Nothing stored; Next generates one with AI. */
  | 'ai-now'
  /** Nothing stored and over the model-time cap; generated at build time. */
  | 'ai-build'
  /** Nothing stored and AI is not available to generate one. */
  | 'none';

export interface SampleForecast {
  kind: SampleForecastKind;
  events: number;
  /** "reference" / "bundled" for a store sample. */
  source?: string;
  extendNow?: boolean;
}

export interface StoreLookup {
  events: number;
  source: string;
}

export interface ForecastOptions {
  cap: number;
  floor: number;
  aiReady: boolean;
  /** A key that holds the row's own sample (isRowSampleKey). */
  isOwn: (key: string) => boolean;
  /** Event count of a row's own sample, for the label. */
  ownEvents?: (key: string) => number;
}

/**
 * One forecast per unique key, in the order Next resolves them (the batch's row
 * order). Generation takes the model budget first, then extensions, exactly as
 * runPreflightPhase2 spends it. `store` holds `null` for "nothing stored" and no
 * entry for "not looked up yet".
 */
export function forecastSamples(
  keys: readonly string[],
  store: ReadonlyMap<string, StoreLookup | null>,
  opts: ForecastOptions,
): Map<string, SampleForecast> {
  const out = new Map<string, SampleForecast>();
  const unresolved: string[] = [];
  const thin: string[] = [];
  for (const key of new Set(keys)) {
    if (opts.isOwn(key)) {
      out.set(key, { kind: 'own', events: opts.ownEvents?.(key) ?? 0 });
      continue;
    }
    if (!store.has(key)) {
      out.set(key, { kind: 'checking', events: 0 });
      continue;
    }
    const hit = store.get(key);
    if (!hit || hit.events <= 0) {
      unresolved.push(key);
    } else if (hit.events < opts.floor) {
      thin.push(key);
      out.set(key, { kind: 'library-thin', events: hit.events, source: hit.source });
    } else {
      out.set(key, { kind: 'library', events: hit.events, source: hit.source });
    }
  }
  unresolved.forEach((key, i) => {
    out.set(key, { kind: !opts.aiReady ? 'none' : i < opts.cap ? 'ai-now' : 'ai-build', events: 0 });
  });
  const extendBudget = opts.aiReady ? Math.max(0, opts.cap - Math.min(unresolved.length, opts.cap)) : 0;
  thin.forEach((key, i) => {
    out.set(key, { ...out.get(key)!, extendNow: i < extendBudget });
  });
  return out;
}

/** The Sample column's text for a row with no sample chosen yet. */
export function sampleForecastLabel(f: SampleForecast | undefined, cap: number): string {
  if (!f || f.kind === 'checking') return 'Looking in the library…';
  const n = `${f.events} event${f.events === 1 ? '' : 's'}`;
  switch (f.kind) {
    case 'own': return `Your events · ${n}`;
    case 'library': return `Library (${f.source || 'store'}) · ${n}`;
    case 'library-thin': return `Library (${f.source || 'store'}) · ${n}, AI extends it ${f.extendNow ? 'at the start of the run' : 'at build time'}`;
    case 'ai-now': return 'None in the library · AI generates one at the start of the run';
    case 'ai-build': return `None in the library · AI generates one at build time (over the ${cap}-source cap)`;
    case 'none': return 'None in the library · AI is not available to generate one';
  }
}

/** Which forecasts get the warning style: the row builds without real events. */
export function sampleForecastIsWeak(f: SampleForecast | undefined): boolean {
  return !!f && (f.kind === 'ai-now' || f.kind === 'ai-build' || f.kind === 'none' || f.kind === 'library-thin');
}
