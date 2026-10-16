// Cribl Copilot "schematizer" agent client — delegates OCSF (and later ECS/UDM)
// pipeline generation to Cribl's own agent, which produces a complete
// parse+map+enrich pipeline in ONE artifact. Runs on the ORG API with the
// standard OAuth token (NOT Aperture/Tailscale).
//
// Protocol (reverse-engineered from a real Copilot session; see memory
// reference_cribl_schematizer_protocol): the server is STATELESS — we hold the
// transcript and resend `messages[]` each turn. The agent emits a tool_call; we
// answer the INTERACTIVE UI tools (next_steps / select_sample / select_objectives
// / select_schema) with a `tool` result and re-POST. The server itself executes
// get_recommended_schemas / get_schema / pipeline-generator-agent / save_pipeline
// and streams their results back. We capture the pipeline from the save_pipeline
// tool_call's arguments and stop.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRIBL_ORG, getToken } from './cribl-auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The schematizer agent REQUIRES the full tool catalog in every request (the
// server does `.filter` on it → 500 if absent). Captured verbatim from a real
// Copilot session; the agent only ever emits tools from this list.
let TOOLS = [];
try { TOOLS = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'schematizer-tools.json'), 'utf-8')); } catch { /* leave empty → runSchematizer returns null */ }

// Which destFormats delegate to the schematizer. OCSF first; ECS/UDM ready to
// switch on once the loop is proven (they use the same protocol — only the
// schema-family prefix in the recommended list differs).
// Our destFormat strings → the schematizer schema-family prefix. Note our app
// uses 'chronicle' for Google Chronicle UDM, whose schematizer family is 'udm@'.
export const SCHEMATIZER_DESTS = new Set(['ocsf', 'ecs', 'chronicle']);
const DEST_SCHEMA_PREFIX = { ocsf: 'ocsf@', ecs: 'ecs@', chronicle: 'udm@', udm: 'udm@' };

const MAX_TURNS = 16;                    // hard stop on the agent loop
const PER_TURN_TIMEOUT_MS = 120_000;     // one generation turn can take ~90s
const OVERALL_DEADLINE_MS = 240_000;     // total budget before giving up → golden/AI
const AGENT_PATH = '/api/v1/ai/q/agents/schematizer';

// Parse the ndjson streamed response → array of assistant messages (each may
// carry tool_calls). The server may also stream tool results inline; we only
// need the assistant tool_calls to know what to answer + to capture save_pipeline.
function parseNdjson(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip partial/non-json line */ }
  }
  return out;
}

// The canned answers for the interactive UI tools. destSchemaId is filled in
// once get_recommended_schemas has run and we've chosen the class.
function answerFor(toolName, args, state) {
  switch (toolName) {
    case 'next_steps': {
      // Pick the option that drives toward "create new pipeline from a sample".
      const steps = (args?.steps || []).map(String);
      const pick =
        steps.find(s => /create a new pipeline/i.test(s)) ||
        steps.find(s => /select an existing sample/i.test(s)) ||
        steps.find(s => /review .*mapping/i.test(s)) ||
        steps[0] || '';
      return `The user selected option: ${pick}`;
    }
    case 'select_sample':
      return `The user selected and saved sample ${state.sampleId}`;
    case 'select_objectives':
      return 'User Selected Options: Convert my input events to a specific target schema like OCSF or UDM';
    case 'select_schema': {
      // We MUST pick a schema in the user's requested family (ocsf/ecs/udm) —
      // never silently switch families just because the agent's top recommendation
      // is a different one. Order of preference:
      //   1) a recommended id in our family (agent's best in-family fit),
      //   2) an id built from allSupportedTargetSchemas for our family,
      //   3) none → mark unavailable so the run aborts (→ fall back to golden/AI).
      const prefix = DEST_SCHEMA_PREFIX[state.destFormat] || '';
      const recs = (args?.recommendedTargetSchemas || []).map(String);
      let chosen = recs.find(s => s.startsWith(prefix)) || '';
      if (!chosen && prefix) {
        // Family key inside allSupportedTargetSchemas ('ocsf'|'ecs'|'udm'); its
        // entries are BARE (e.g. 'v1.8.0-network_activity-4001', 'base') — prepend
        // the family prefix to fully-qualify.
        const fam = prefix.replace('@', '');
        const all = state.recommend?.allSupportedTargetSchemas?.[fam] || [];
        if (all.length) {
          // Prefer a recommended class number if the agent hinted one for another
          // family (e.g. it recommended ocsf@…network_activity-4001 → try to find
          // the same "network" concept in our family); else take the first.
          chosen = `${prefix}${all[0]}`;
        }
      }
      if (!chosen) { state.noFamilyMatch = true; return `No ${state.destFormat} schema is available for this data.`; }
      state.chosenSchema = chosen;
      return `The user selected target schema: ${chosen}.`;
    }
    default:
      // Unknown interactive tool — acknowledge generically so the loop proceeds.
      return 'ok';
  }
}

// Interactive tools we answer client-side. Everything else (get_recommended_schemas,
// get_schema, pipeline-generator-agent, save_pipeline, save_target_schema,
// run_and_validate_pipeline) is executed by the server and streamed back.
const CLIENT_TOOLS = new Set(['next_steps', 'select_sample', 'select_objectives', 'select_schema']);

// Extract the generated pipeline functions from a save_pipeline tool_call.
function pipelineFromSaveCall(tc) {
  try {
    const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
    const fns = args?.pipeline?.conf?.functions;
    if (Array.isArray(fns) && fns.length) return { functions: fns, pipelineId: args.pipeline.id, description: args.pipeline.description };
  } catch { /* bad args */ }
  return null;
}

// Run the agent loop for one sourcetype+sample+destFormat. Returns
// { functions, schemaId, pipelineId } or null (unreachable / no Copilot /
// no pipeline produced). Best-effort — never throws.
export async function runSchematizer({ sourcetype, destFormat, sampleId, inputEvents }) {
  // Callers concretize OCSF/nextgen to a sub-class key (e.g. 'ocsf#network'),
  // but the schematizer negotiates schemas at the FAMILY level ('ocsf'/'ecs'/
  // 'chronicle') — SCHEMATIZER_DESTS and DEST_SCHEMA_PREFIX are family-keyed.
  // Without this, 'ocsf#network' fails the has() check and the whole
  // schematizer delegation is silently dead for OCSF (build 586 bug).
  const family = String(destFormat || '').split('#')[0];
  if (!SCHEMATIZER_DESTS.has(family)) return null;
  if (!Array.isArray(TOOLS) || TOOLS.length === 0) return null;   // tool catalog missing
  let token;
  try { token = await getToken(); } catch { return null; }
  const base = CRIBL_ORG.replace(/\/+$/, '');
  // A stable-ish session id per run (Date.now/random are fine server-side here).
  const sessionId = `pg-${sourcetype}-${family}-${inputEvents.length}`;

  const state = { sampleId, destFormat: family, chosenSchema: null };
  // Seed the transcript exactly like the UI does: an opening assistant next_steps
  // the user has "answered" to create a new pipeline, then select the sample.
  const messages = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'seed_0', function: { name: 'next_steps', arguments: JSON.stringify({ steps: ['Create a new Pipeline', 'Edit an existing Pipeline'], justification: 'Start.' }) } }] },
    { role: 'tool', id: 'next_steps', tool_call_id: 'seed_0', content: 'The user selected option: Create a new Pipeline' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'seed_1', function: { name: 'next_steps', arguments: JSON.stringify({ steps: ['Select an existing sample file', 'Capture live events from a Source', 'Paste raw events into chat'], justification: 'Need a sample.' }) } }] },
    { role: 'tool', id: 'next_steps', tool_call_id: 'seed_1', content: 'The user selected option: Select an existing sample file' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'seed_2', function: { name: 'select_sample', arguments: '{}' } }] },
    { role: 'tool', id: 'select_sample', tool_call_id: 'seed_2', content: `The user selected and saved sample ${sampleId}` },
  ];
  const context = {
    resources: { sample: sampleId },
    files: { input_events: inputEvents, sample: sampleId },
  };

  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() > deadline) return null;        // overall budget exceeded
    let resp;
    // Per-request timeout so a hung generation can't stall the whole build.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PER_TURN_TIMEOUT_MS);
    try {
      resp = await fetch(`${base}${AGENT_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, stream: true, context, tools: TOOLS, sessionId }),
        signal: ac.signal,
      });
    } catch { clearTimeout(timer); return null; }  // abort/network → soft null
    finally { clearTimeout(timer); }
    if (!resp.ok) return null;                     // Copilot not enabled / no access
    const items = parseNdjson(await resp.text());
    // Collect assistant tool_calls the server emitted this turn.
    const toolCalls = [];
    for (const it of items) {
      if (it.role === 'assistant' && Array.isArray(it.tool_calls)) toolCalls.push(...it.tool_calls);
    }
    if (!toolCalls.length) return null;            // nothing to do → give up

    // Capture the recommend-schemas result so select_schema can pick an
    // in-family fully-qualified id even when the agent didn't recommend one.
    for (const it of items) {
      if (it.role === 'tool' && it.id === 'get_recommended_schemas') {
        try { state.recommend = typeof it.content === 'string' ? JSON.parse(it.content) : it.content; } catch { /* */ }
      }
    }

    // 1) If the agent saved a pipeline this turn, we're done — capture it.
    //    Guard: only accept it if the chosen schema is in the requested family
    //    (never return e.g. an OCSF pipeline when the user asked for ECS).
    const saveCall = toolCalls.find(tc => tc.function?.name === 'save_pipeline');
    if (saveCall) {
      const prefix = DEST_SCHEMA_PREFIX[family] || '';
      if (prefix && state.chosenSchema && !state.chosenSchema.startsWith(prefix)) return null;
      const pipe = pipelineFromSaveCall(saveCall);
      if (pipe) return { ...pipe, schemaId: state.chosenSchema };
    }

    // 2) Append each assistant tool_call to the transcript, then answer the
    //    CLIENT-side interactive tools. Server-side tools already ran and their
    //    results are in `items` — re-append them so the transcript stays whole.
    //    NORMALIZE assistant messages: the streamed form has `content:null` and a
    //    `name` field; resending that verbatim makes the server 500 ("string
    //    argument must be of type string"). The UI resends `content:''`, an `id`,
    //    and no `name` — mirror that.
    let idc = 0;
    for (const it of items) {
      if (it.role === 'assistant') {
        messages.push({
          id: it.id || `pg-a-${turn}-${idc++}`,
          role: 'assistant',
          content: typeof it.content === 'string' ? it.content : '',
          tool_calls: it.tool_calls || [],
        });
      } else if (it.role === 'tool') {
        messages.push({ role: 'tool', id: it.id, tool_call_id: it.tool_call_id, content: typeof it.content === 'string' ? it.content : JSON.stringify(it.content ?? '') });
      }
    }
    // Answer any client-interactive tool_calls that DON'T yet have a result.
    let answeredAny = false;
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      if (!CLIENT_TOOLS.has(name)) continue;
      const already = messages.some(m => m.role === 'tool' && m.tool_call_id === tc.id);
      if (already) continue;
      let args = {};
      try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); } catch { /* */ }
      messages.push({ role: 'tool', id: name, tool_call_id: tc.id, content: answerFor(name, args, state) });
      answeredAny = true;
    }
    // If we couldn't pick an in-family schema, don't let the agent proceed with a
    // different family — abort and let the caller fall back to golden/AI.
    if (state.noFamilyMatch) return null;

    if (!answeredAny && !saveCall) {
      // The agent emitted only server-side tools and no pipeline yet — loop again
      // so the server can continue (e.g. get_recommended_schemas → next turn).
      // If two consecutive turns produce nothing new, bail via the turn cap.
    }
  }
  return null;   // hit the turn cap without a pipeline
}

// Dev-server HTTP handler: POST /api/pack-generator/schematizer
// body { sourcetype, destFormat, sampleId, inputEvents:[...], workerGroup }
export async function handleSchematizer(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const b = JSON.parse(body || '{}');
    if (!b.sampleId || !Array.isArray(b.inputEvents) || !b.inputEvents.length) {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ pipeline: null, reason: 'sampleId + inputEvents required' }));
    }
    const result = await runSchematizer(b);
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pipeline: result }));
  } catch (err) {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pipeline: null, error: err.message }));
  }
}
