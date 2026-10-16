// The mapping counterpart to extraction-delimiter.ts. Extraction can be perfect
// and the OCSF output still come out empty when the MAPPING reads field names the
// parser never produced. That is exactly what happened to the ZIA TSV pack: the
// serde split 29 clean tab columns (`time`, `http_method`, `bytes_sent`,
// `bytes_received`, `device_hostname`, …) but the Copilot/schematizer OCSF map
// reads a FIXED canonical vocabulary (`log_time`, `request_method`, `bytes_in`,
// `bytes_out`, `host`) and none of the produced names were bridged to it — so
// `time`, `http_request.http_method`, `traffic.bytes_in/out` and the OCSF-required
// `time` all came out undefined despite a good extraction.
//
// CANONICAL_FIELD_ALIASES is the single source of truth for that bridge: canonical
// name → the vendor/Copilot spellings that mean the same thing. buildCanonicalAliasAdd
// turns it into the `add` list for the one alias eval that runs BEFORE every
// destination map. repairCanonicalAliases is the deterministic backstop: given the
// field names the parse stage ACTUALLY produced, it ensures each produced field that
// is a known synonym is present in its canonical's `||` chain — so a source whose
// serde happens to name a column something the static table missed still self-heals
// instead of silently emptying the output.

// canonical → synonyms, in preference order (canonical itself is prepended by the
// builder). A produced field matching any synonym populates the canonical the OCSF
// maps read. Each assignment is `canonical || syn…`, so listing a synonym that is
// absent from a given source is harmless — a golden parser that already emits the
// canonical name is unchanged.
export const CANONICAL_FIELD_ALIASES: Record<string, string[]> = {
  src_ip: ['source__ip', 'client__ip', 'srcaddr', 'srcip', 'id_orig_h'],
  dest_ip: ['dst_ip', 'destination__ip', 'server__ip', 'dstaddr', 'dstip', 'id_resp_h'],
  src_port: ['source__port', 'spt', 'srcport', 'sport', 'id_orig_p'],
  dest_port: ['dst_port', 'destination__port', 'dpt', 'dstport', 'dport', 'id_resp_p'],
  protocol: ['transport', 'network__transport', 'proto'],
  transport: ['protocol', 'network__transport', 'proto'],
  action: ['event__outcome', 'act'],
  application: ['app', 'network__application', 'service'],
  // bytes: the ZIA feed uses bytes_received / bytes_sent — neither was bridged.
  // Zeek/Corelight: orig_* is the originator (src) side → out; resp_* → in.
  bytes_in: ['destination__bytes', 'rcvd_bytes', 'rcvdbyte', 'bytes_received', 'received_bytes', 'rcvd_octets', 'resp_bytes'],
  bytes_out: ['source__bytes', 'sent_bytes', 'sentbyte', 'bytes_sent', 'sent_octets', 'orig_bytes'],
  packets_in: ['destination__packets', 'rcvd_pkts', 'rcvdpkt', 'resp_pkts'],
  packets_out: ['source__packets', 'sent_pkts', 'sentpkt', 'orig_pkts'],
  session_id: ['uid', 'sessionid', 'session__id'],
  community_id: ['network__community_id', 'communityid'],
  duration: ['event__duration'],
  rule_name: ['rule__name', 'policy_name', 'policyname'],
  src_zone: ['observer__ingress__zone'],
  dest_zone: ['dst_zone', 'observer__egress__zone', 'observer__egress_zone'],
  // host: ZIA names it device_hostname / device_name.
  host: ['observer__hostname', 'hostname', 'device_hostname', 'device_name', 'dvchost', 'devname'],
  // log_time: the OCSF time-assembly reads ONLY log_time; ZIA names the column `time`.
  log_time: ['generated_time', 'receive_time', 'start_time', 'event__created', 'timestamp', 'event__start', 'time', 'event_time', 'datetime', 'logtime'],
  // request_method: the http_request.http_method map reads `request_method || method`;
  // ZIA (and many web proxies) name it http_method.
  request_method: ['method', 'http_method', 'httpmethod', 'requestmethod', 'cs_method', 'verb', 'http_verb'],
};

/** Build the `add` list for the schematizer→canonical alias eval from the table. */
export function buildCanonicalAliasAdd(): Array<{ name: string; value: string }> {
  return Object.entries(CANONICAL_FIELD_ALIASES).map(([canonical, syns]) => ({
    name: canonical,
    value: [canonical, ...syns].join(' || '),
  }));
}

interface FnLike {
  id?: string;
  description?: string;
  conf?: Record<string, unknown>;
}

// The one alias eval, identified the same way withSchematizerCanonicalAliases finds it.
const ALIAS_DESC = /Alias Copilot\/schematizer/i;

/**
 * Ensure the canonical alias eval bridges every produced field that is a known
 * synonym. Pure: returns a new array (and new objects) only when it adds a term;
 * otherwise returns the input untouched.
 *
 * `producedFields` are the field names the parse stage actually emits (serde
 * `conf.fields` + eval `add` names). A produced field is matched to a canonical
 * case-insensitively, but appended with its real casing so the eval reads the
 * field that exists.
 */
export function repairCanonicalAliases<T extends FnLike>(functions: T[], producedFields: string[]): T[] {
  if (!Array.isArray(functions)) return functions;
  const produced = (producedFields || []).filter(f => typeof f === 'string' && f.trim().length > 0);
  if (produced.length === 0) return functions;

  // canonical → set of already-listed alias terms (lowercased), and canonical itself.
  const idx = functions.findIndex(f => ALIAS_DESC.test(String(f?.description || '')));
  if (idx === -1) return functions; // no alias eval on this path — nothing to repair
  const aliasFn = functions[idx];
  const add = aliasFn.conf?.add;
  if (!Array.isArray(add)) return functions;

  // Which synonyms belong to which canonical (lowercased synonym → canonical).
  const synToCanonical = new Map<string, string>();
  for (const [canonical, syns] of Object.entries(CANONICAL_FIELD_ALIASES)) {
    for (const s of syns) synToCanonical.set(s.toLowerCase(), canonical);
  }

  // Terms already present in each canonical's chain (lowercased).
  const presentTerms = new Map<string, Set<string>>();
  for (const a of add) {
    const canonical = String(a?.name || '');
    const terms = String(a?.value || '').split('||').map(t => t.trim().toLowerCase());
    presentTerms.set(canonical, new Set(terms));
  }

  // For each produced field that is a known synonym, ensure it is in the chain.
  const toAppend = new Map<string, string[]>(); // canonical → produced names to append (real casing)
  for (const field of produced) {
    const canonical = synToCanonical.get(field.toLowerCase());
    if (!canonical) continue;
    const present = presentTerms.get(canonical);
    if (!present) continue; // canonical not in this eval — leave it
    if (present.has(field.toLowerCase())) continue; // already bridged
    if (!toAppend.has(canonical)) toAppend.set(canonical, []);
    toAppend.get(canonical)!.push(field);
    present.add(field.toLowerCase());
  }
  if (toAppend.size === 0) return functions;

  const newAdd = add.map(a => {
    const canonical = String(a?.name || '');
    const extra = toAppend.get(canonical);
    if (!extra || extra.length === 0) return a;
    return { ...a, value: `${String(a?.value || '')} || ${extra.join(' || ')}` };
  });
  const out = functions.slice();
  out[idx] = { ...aliasFn, conf: { ...aliasFn.conf, add: newAdd } } as T;
  return out;
}

/**
 * Field names the parse stage produces: serde `conf.fields` (positional/csv columns)
 * plus eval `add` names. Used to ground repairCanonicalAliases in what actually
 * exists — the serde columns are exactly what the fixed-vocabulary map was blind to.
 */
export function producedParseFields(parseFns: FnLike[]): string[] {
  const names = new Set<string>();
  for (const fn of parseFns || []) {
    const conf = (fn?.conf || {}) as Record<string, unknown>;
    if (Array.isArray(conf.fields)) {
      for (const f of conf.fields) if (typeof f === 'string' && f) names.add(f);
    }
    if (Array.isArray(conf.add)) {
      for (const a of conf.add as Array<{ name?: string }>) if (a?.name) names.add(String(a.name));
    }
  }
  return [...names];
}
