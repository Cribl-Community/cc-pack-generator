// Demo environment v2: the IDs, filters and sample helpers every demo object is
// named by. Dependency-free so api.ts and the standalone backend share it with
// the planner (demo-flow.ts) without pulling the pack builder into their bundle.
export const DEMO_DATAGEN_PREFIX = 'demo_datagen';
export const DEMO_OCSF_REPLAY_ID = 'demo_datagen_ocsf_pp';
/** Every demo datagen sends at this rate per source. */
export const DEMO_EVENTS_PER_SEC = 2;
/** Output placeholder for "the demo's Cribl Lake dataset", resolved at build time. */
export const DEMO_LAKE_OUTPUT = '@lake';

export const idPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const demoLaneId = (fmt: string) => `${DEMO_DATAGEN_PREFIX}_${idPart(fmt)}`;
export const demoLaneFilter = (fmt: string) => `__inputId=='datagen:${demoLaneId(fmt)}'`;
export const demoMainPackId = (sourcetype: string) => kebab(`demo ${sourcetype}`);
export const demoPpPackId = (sourcetype: string, eff: string) => kebab(`demo ${sourcetype} ocsf to ${eff} post`);
export const demoPipelineId = (sourcetype: string, fmt: string) => `${idPart(sourcetype)}_to_${idPart(fmt)}`;
/** What the post-processing packs read: the OCSF replay datagen. */
export const DEMO_FEED_FILTER = `__inputId=='datagen:${DEMO_OCSF_REPLAY_ID}'`;
/** Every demo input: what the terminator drops so demo data never reaches production routes. */
export const DEMO_TERMINATOR_FILTER = `__inputId.startsWith('datagen:${DEMO_DATAGEN_PREFIX}')`;

/**
 * One OCSF pipeline output event → one replay datagen line: the event as JSON in
 * `_raw`, which is what step 1 of every post-processing pack parses. Cribl
 * internals and `_time` stay out (datagen stamps its own); OCSF `time` (epoch
 * ms) becomes a rolling datagen timestamp so the replayed events stay current.
 */
export function ocsfReplayLine(event: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === '_raw' || k === '_time' || k.startsWith('__') || k.startsWith('cribl_')) continue;
    out[k] = v;
  }
  if (typeof out.time === 'number') out.time = '${timestamp:%s%L}';
  return JSON.stringify(out);
}

/** Datagen samples quote nothing that is a timestamp template: `"${timestamp:…}"` → `${timestamp:…}`. */
export function unquoteDatagenTimestamps(json: string): string {
  return json.replace(/"(\$\{timestamp:[^"}]*\})"/g, '$1');
}

/**
 * Which demo datagen owns a group sample. Samples are named `<datagenId>_<st>.log`
 * and lane ids prefix each other (`demo_datagen_ocsf` / `demo_datagen_ocsf_pp`),
 * so the owner is the LONGEST id that prefixes the name — never the first match.
 */
export function demoSampleOwner(sampleName: string, datagenIds: string[]): string | null {
  let owner: string | null = null;
  for (const id of datagenIds) {
    if (sampleName.startsWith(`${id}_`) && (!owner || id.length > owner.length)) owner = id;
  }
  return owner;
}

/** Demo inputs (datagens) and outputs (Lake) the scan and cleanup look for. */
export const isDemoInputId = (id: string) => id.startsWith(DEMO_DATAGEN_PREFIX);
export const isDemoOutputId = (id: string) => id.startsWith('demo_lake_');
