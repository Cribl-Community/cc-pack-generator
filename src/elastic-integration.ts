// Elastic integration routing — which Elastic integration data stream an app
// sourcetype belongs to, and whether Cribl can feed it at all.
//
// The Elastic `cribl` integration receives every Cribl event on
// `logs-cribl-default` and reroutes it on `_dataId` to an integration's data
// stream (its policy var `route_entries`), whose own ingest pipeline then parses
// `message`. So the integration path needs three things to line up: the pack
// stamps `_dataId` and puts the original line in `message`
// (destination-metadata.ts, family `elastic`), the user's `route_entries` maps
// that `_dataId` to the right data stream (rendered here), and the line has the
// shape that data stream's pipeline parses (`expects`, checked here against the
// user's sample). Some integrations parse in Elastic Agent, not in the ingest
// pipeline (Windows winlog.*, decode_cef, an S3 object path) — nothing Cribl
// sends parses there, so those routes are `via: 'agent'` and are never stamped.
//
// A LEAF module (imports only its data) so destination-metadata callers,
// flow-builder and the card can all reach it. Callers pass a CANONICAL
// sourcetype (canonicalizeSourcetype) — the `_dataId` is that name.
import data from '../config/elastic-integration-datasets.json';

export interface ElasticIntegrationRoute {
  /** The `_dataId` the pack stamps = the canonical app sourcetype. */
  dataId: string;
  /** `logs-<package>.<dataset>`, the `datastream` of a route_entries row. */
  datastream: string;
  /** `cribl` = the ingest pipeline parses `message`; `agent` = only Elastic Agent's input does. */
  via: 'cribl' | 'agent';
  /** Does the app's reference sample have the shape the pipeline parses? */
  fit?: 'native' | 'reshape';
  /** Set `input.type` (system.auth / system.syslog dispatch their sub-pipeline on it). */
  inputType?: string;
  /** JS regex for the line shape the data stream's pipeline parses. */
  expects?: string;
  shape: string;
  note?: string;
}

interface RawRoute { datastream: string; via: string; fit?: string; inputType?: string; expects?: string; shape: string; note?: string }

export const ELASTIC_CRIBL_INTEGRATION: { package: string; version: string; kibana: string; index: string; dataIdField: string; docs: string } = data.integration;

const ROUTES = data.routes as Record<string, RawRoute>;

/** Kibana's own rule (sanitize.ts in the cribl integration): non-empty, ≤100 chars, [A-Za-z0-9._-]. */
export function isValidElasticDataId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && /^[a-zA-Z0-9._-]+$/.test(value);
}

/** The route for a canonical sourcetype, or null when no integration data stream is known. */
export function elasticIntegrationRoute(canonicalSourcetype: string | null | undefined): ElasticIntegrationRoute | null {
  const key = String(canonicalSourcetype || '');
  const r = Object.prototype.hasOwnProperty.call(ROUTES, key) ? ROUTES[key] : null;
  if (!r) return null;
  return {
    dataId: key, datastream: r.datastream, via: r.via === 'agent' ? 'agent' : 'cribl',
    fit: r.fit === 'reshape' ? 'reshape' : r.fit === 'native' ? 'native' : undefined,
    inputType: r.inputType, expects: r.expects, shape: r.shape, note: r.note,
  };
}

/** Every route in the table (tests and docs). */
export function elasticIntegrationRoutes(): ElasticIntegrationRoute[] {
  return Object.keys(ROUTES).map(k => elasticIntegrationRoute(k)!);
}

/**
 * What the pack stamps for the destination-metadata `elastic` contract, or null
 * when nothing should be stamped (no route, an agent-only route, an invalid id).
 */
export function elasticIntegrationStamp(canonicalSourcetype: string | null | undefined): { dataId: string; inputType?: string } | null {
  const r = elasticIntegrationRoute(canonicalSourcetype);
  if (!r || r.via !== 'cribl' || !isValidElasticDataId(r.dataId)) return null;
  return r.inputType ? { dataId: r.dataId, inputType: r.inputType } : { dataId: r.dataId };
}

/**
 * The `route_entries` policy value to paste into the Elastic `cribl`
 * integration: a JSON string of `[{dataId, datastream, namespace?}]`, the shape
 * Kibana's translator reads (namespace omitted when blank). Agent-only routes
 * are left out — routing them would land unparsed events in the data stream.
 */
export function elasticRouteEntriesJson(routes: (ElasticIntegrationRoute | null | undefined)[], namespace?: string): string {
  const ns = String(namespace || '').trim();
  const seen = new Set<string>();
  const rows: { dataId: string; datastream: string; namespace?: string }[] = [];
  for (const r of routes) {
    if (!r || r.via !== 'cribl' || seen.has(r.dataId)) continue;
    seen.add(r.dataId);
    rows.push(ns ? { dataId: r.dataId, datastream: r.datastream, namespace: ns } : { dataId: r.dataId, datastream: r.datastream });
  }
  return JSON.stringify(rows, null, 2);
}

/**
 * The sample's events, each on one line. A JSON sample is split by object, not
 * by line, and compacted: a pretty-printed CloudTrail record is one event (the
 * data stream's json processor parses it whole), not twenty fragments. A JSON
 * array counts its elements. Anything else is one event per non-blank line.
 */
export function elasticSampleEvents(sampleText: string): string[] {
  const text = String(sampleText || '').trim();
  if (/^[{[]/.test(text)) {
    try {
      const v = JSON.parse(text);
      return (Array.isArray(v) ? v : [v]).map(e => (typeof e === 'string' ? e : JSON.stringify(e)));
    } catch { /* concatenated objects: split on top-level braces below */ }
    const out: string[] = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth++ === 0) start = i; }
      else if (c === '}' && depth > 0 && --depth === 0) {
        const chunk = text.slice(start, i + 1);
        try { out.push(JSON.stringify(JSON.parse(chunk))); } catch { out.push(chunk.replace(/\s*\n\s*/g, ' ')); }
      }
    }
    if (out.length) return out;
  }
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * The share of sample events with the shape the data stream's pipeline parses
 * (`ok` at ≥70%, the same agreement bar column detection uses). null = not
 * measurable: no `expects` for the route, or no sample.
 */
export function elasticSampleFit(route: ElasticIntegrationRoute | null | undefined, sampleText: string | null | undefined): { matched: number; total: number; ok: boolean } | null {
  if (!route?.expects) return null;
  const lines = elasticSampleEvents(sampleText || '');
  if (!lines.length) return null;
  let re: RegExp;
  try { re = new RegExp(route.expects); } catch { return null; }
  const matched = lines.filter(l => re.test(l)).length;
  return { matched, total: lines.length, ok: matched / lines.length >= 0.7 };
}

export type ElasticSetupStatus = 'ready' | 'reshape' | 'agent' | 'none';

export interface ElasticIntegrationAdvice {
  status: ElasticSetupStatus;
  route: ElasticIntegrationRoute | null;
  /** The Elastic card this source should use: the integration when it can parse, else ECS. */
  recommended: 'elastic_raw' | 'ecs';
  /** The `route_entries` JSON to paste (only when status is ready or reshape). */
  routeEntries: string | null;
  /** Plain-language setup and warnings, in order. */
  lines: string[];
}

/**
 * Everything the Elastic integration card says for a source: the setup to do in
 * Elastic, and why it will or will not parse. The sample, when given, decides
 * the fit; without one the committed `fit` (measured on the app's reference
 * sample) stands in.
 */
export function elasticIntegrationAdvice(canonicalSourcetype: string | null | undefined, sampleText?: string | null): ElasticIntegrationAdvice {
  const route = elasticIntegrationRoute(canonicalSourcetype);
  const I = ELASTIC_CRIBL_INTEGRATION;
  if (!route) {
    return {
      status: 'none', route: null, recommended: 'ecs', routeEntries: null,
      lines: [`No Elastic integration is mapped for ${canonicalSourcetype || 'this source'}: the event is forwarded unchanged with no _dataId. Use Elastic ECS (a custom logs-* data stream) unless you add the route yourself.`],
    };
  }
  if (route.via === 'agent') {
    return {
      status: 'agent', route, recommended: 'ecs', routeEntries: null,
      lines: [
        `${route.datastream} is parsed by Elastic Agent, not by its ingest pipeline: ${route.note || route.shape}. Collect this source with Elastic Agent, or send it as Elastic ECS.`,
        'The pack forwards the event unchanged and stamps no _dataId, so nothing lands unparsed in the integration data stream.',
      ],
    };
  }
  const measured = elasticSampleFit(route, sampleText);
  const fits = measured ? measured.ok : route.fit !== 'reshape';
  const lines = [
    `Install the Elastic "${I.package}" integration (${I.version}+, Kibana ${I.kibana}) and the ${route.datastream.replace(/^logs-/, '').split('.')[0]} integration's assets in Fleet.`,
    `Point the Cribl Elasticsearch destination at the index ${I.index}. The pack sends ${I.dataIdField}=${route.dataId} and the original line in message (_raw is not sent).`,
    `Add the route below to the cribl integration's route_entries.`,
  ];
  if (route.inputType) lines.push(`The pack also sets input.type=${route.inputType}: ${route.datastream} picks its sub-pipeline on it.`);
  if (!fits) {
    lines.push(measured
      ? `Only ${measured.matched}/${measured.total} sample events look like what ${route.datastream} parses (${route.shape}).${route.note ? ` ${route.note}` : ''}`
      : `This source's usual shape is not what ${route.datastream} parses (${route.shape}).${route.note ? ` ${route.note}` : ''}`);
  } else if (route.note) {
    lines.push(route.note);
  }
  return {
    status: fits ? 'ready' : 'reshape', route, recommended: fits ? 'elastic_raw' : 'ecs',
    routeEntries: elasticRouteEntriesJson([route]), lines,
  };
}
