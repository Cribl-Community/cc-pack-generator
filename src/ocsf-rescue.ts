// OCSF leftover rescue (packtester audit 2026-10-10: 181 packs, avg 68).
//
// The output shaping (ocsf-finalize.ts) folds every field the mapping did not
// consume into `unmapped`. A third of all sample values ended up there, and the
// most common ones are generic fields with a well-known OCSF home: `pid` (36
// packs), `user`, `process` (28), the Zeek tuple `id.orig_h`… (25), `_path`,
// `event_id`, `srcintf`. Carry credits `unmapped` at 0.25, and an analyst cannot
// query it like a typed attribute.
//
// This runs AFTER the fold: it only ever sees values that really were left over,
// moves one into its typed attribute when that attribute is still empty and the
// class allows its top-level object, and deletes it from `unmapped`. A mapping
// that already set the attribute always wins. Targets are restricted to object
// attributes that have existed since OCSF 1.1 (the vendored index only types
// top-level attributes, so sub-attributes are listed here by hand). Fields whose
// meaning differs by vendor (`level`, `type`, `version`, country names) are left
// alone on purpose.
//
// Cribl eval semantics relied on: adds run in order; assigning `undefined` to a
// top-level field removes it; an object literal key set to `undefined` is dropped
// from the serialized event.
import { ocsfAttributeTypes } from './ocsf-schema';

export interface EvalAdd { name: string; value: string }
interface Fn { id: string; description?: string; filter?: string; conf?: any }

type Shape = 'ip' | 'num' | 'iso' | 'mac' | 'any';
type Cast = 'num' | 'str' | 'lower';

interface RescueRule {
  /** Source keys in preference order (case-sensitive, as parsers emit them). */
  from: string[];
  /** Candidate targets: the first whose top-level object the class allows wins. */
  to: string[];
  shape: Shape;
  cast: Cast;
  /** Extra guard on the event (e.g. `uid` is only a connection id for Zeek). */
  when?: string;
}

export const OCSF_LEFTOVER_RESCUE: RescueRule[] = [
  // Zeek/Corelight connection id: only with the Zeek `_path` marker. Before the
  // `_path` rule, which moves `_path` out of unmapped.
  { from: ['uid'], to: ['connection_info.uid'], shape: 'any', cast: 'str', when: "unmapped['_path'] != null" },
  { from: ['id.orig_h', 'src_ip', 'source_ip', 'srcip', 'client_ip', 'src_addr', 'srcaddr'], to: ['src_endpoint.ip'], shape: 'ip', cast: 'str' },
  { from: ['id.orig_p', 'src_port', 'srcport', 'source_port', 'sport', 'spt'], to: ['src_endpoint.port'], shape: 'num', cast: 'num' },
  { from: ['id.resp_h', 'dst_ip', 'dest_ip', 'dstip', 'destination_ip', 'dst_addr', 'dstaddr'], to: ['dst_endpoint.ip'], shape: 'ip', cast: 'str' },
  { from: ['id.resp_p', 'dst_port', 'dest_port', 'dstport', 'destination_port', 'dport', 'dpt'], to: ['dst_endpoint.port'], shape: 'num', cast: 'num' },
  { from: ['srcintf', 'src_interface'], to: ['src_endpoint.interface_name'], shape: 'any', cast: 'str' },
  { from: ['dstintf', 'dst_interface'], to: ['dst_endpoint.interface_name'], shape: 'any', cast: 'str' },
  { from: ['srcmac', 'src_mac'], to: ['src_endpoint.mac'], shape: 'mac', cast: 'str' },
  { from: ['dstmac', 'dst_mac'], to: ['dst_endpoint.mac'], shape: 'mac', cast: 'str' },
  { from: ['srcname', 'src_host', 'src_hostname'], to: ['src_endpoint.hostname'], shape: 'any', cast: 'str' },
  { from: ['dstname', 'dst_host', 'dst_hostname', 'dest_host'], to: ['dst_endpoint.hostname'], shape: 'any', cast: 'str' },
  { from: ['host', 'hostname', 'device_hostname', 'dvchost', 'devname'], to: ['device.hostname'], shape: 'any', cast: 'str' },
  { from: ['devid', 'device_id'], to: ['device.uid'], shape: 'any', cast: 'str' },
  { from: ['interface', 'iface'], to: ['device.interface_name'], shape: 'any', cast: 'str' },
  { from: ['vlan', 'vlan_id'], to: ['device.vlan_uid'], shape: 'any', cast: 'str' },
  { from: ['pid', 'process_id', 'processid', 'procid', 'ProcessID'], to: ['actor.process.pid'], shape: 'num', cast: 'num' },
  { from: ['process', 'program', 'process_name', 'prog'], to: ['actor.process.name'], shape: 'any', cast: 'str' },
  // Authentication-family classes carry the subject user as top-level `user`.
  { from: ['user', 'username', 'user_name', 'usr', 'suser'], to: ['user.name', 'actor.user.name'], shape: 'any', cast: 'str' },
  { from: ['component', 'subsystem', 'app', 'application', 'appname'], to: ['app_name', 'actor.app_name'], shape: 'any', cast: 'str' },
  { from: ['proto', 'protocol', 'transport'], to: ['connection_info.protocol_name'], shape: 'any', cast: 'lower' },
  { from: ['policyid', 'policy_id', 'poluuid', 'rule_id'], to: ['firewall_rule.uid'], shape: 'any', cast: 'str' },
  { from: ['policyname', 'policy_name', 'rule_name'], to: ['firewall_rule.name'], shape: 'any', cast: 'str' },
  { from: ['policytype'], to: ['firewall_rule.type'], shape: 'any', cast: 'str' },
  { from: ['auth_method', 'authentication_method', 'auth_type'], to: ['auth_protocol'], shape: 'any', cast: 'str' },
  { from: ['_path', 'Channel', 'log_name', 'logname'], to: ['metadata.log_name'], shape: 'any', cast: 'str' },
  { from: ['event_id', 'eventid', 'event_code', 'EventID', 'logid', 'msgid', 'message_id'], to: ['metadata.event_code'], shape: 'any', cast: 'str' },
  { from: ['syslog_version', 'cef_version'], to: ['metadata.log_version'], shape: 'any', cast: 'str' },
  // time_dt is an RFC 3339 datetime: only an ISO-shaped source string qualifies.
  { from: ['timestamp', 'syslog_timestamp', 'log_time', 'eventtime', 'event_time', 'source_timestamp', 'source_time', 'date'], to: ['time_dt'], shape: 'iso', cast: 'str' },
  { from: ['msg', 'log_message'], to: ['message'], shape: 'any', cast: 'str' },
];

const SLOT = '__ocsf_rk';    // the unmapped key this rule takes its value from
const FLAG = '__ocsf_rs';    // whether this rule moves it
const RULES_PER_EVAL = 40;   // one eval today (~30 rules); chunks if the table grows

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const isPlainObj = (p: string) => `${p} && typeof ${p} == 'object' && !Array.isArray(${p})`;
const chainTo = (parts: string[], n: number) => parts.slice(0, n).map((_, i) => parts.slice(0, i + 1).join('.')).join(' && ');

function shapeTest(v: string, shape: Shape): string {
  switch (shape) {
    case 'ip': return `/^(\\d{1,3}(\\.\\d{1,3}){3}|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]+)$/.test(String(${v}))`;
    case 'num': return `Number.isFinite(Number(${v}))`;
    case 'iso': return `/^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}/.test(String(${v}))`;
    case 'mac': return `/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(String(${v}))`;
    default: return 'true';
  }
}

function castExpr(v: string, cast: Cast): string {
  return cast === 'num' ? `Number(${v})` : cast === 'lower' ? `String(${v}).toLowerCase()` : `String(${v})`;
}

/** `a.b.c = v` as one expression for `a`, keeping whatever `a` / `a.b` already hold. */
function nestedSet(parts: string[], value: string): string {
  let inner = value;
  for (let i = parts.length - 1; i >= 1; i--) {
    const parent = parts.slice(0, i).join('.');
    const guard = chainTo(parts, i);
    const existing = `(${guard} && typeof ${parent} == 'object' && !Array.isArray(${parent}) ? ${parent} : {})`;
    inner = `Object.assign(${existing}, {${parts[i]}: ${inner}})`;
  }
  return inner;
}

function ruleAdds(rule: RescueRule, target: string): EvalAdd[] {
  const parts = target.split('.');
  const top = parts[0];
  // Never `unmapped[${SLOT}]`: live, a bare field as the whole key fails the
  // expression, and the rescue then wiped its target object (audit 2026-10-12).
  const v = `unmapped[__e[${q(SLOT)}]]`;
  const present = (k: string) => `unmapped[${q(k)}] != null && unmapped[${q(k)}] !== '' && unmapped[${q(k)}] !== '-'`;
  const pick = rule.from.reduceRight((acc, k) => `${present(k)} ? ${q(k)} : ${acc}`, 'undefined');
  const targetSet = parts.length === 1 ? `${top} != null && ${top} !== ''` : `${chainTo(parts, parts.length)} != null`;
  const topFree = parts.length === 1 ? 'true' : `(${top} == null || (${isPlainObj(top)}))`;
  const cond = [`${SLOT} != null`, shapeTest(v, rule.shape), `!(${targetSet})`, topFree, rule.when].filter(Boolean).join(' && ');
  const value = parts.length === 1 ? castExpr(v, rule.cast) : nestedSet(parts, castExpr(v, rule.cast));
  // Static keys only: no computed property names in Cribl expressions.
  const drop = rule.from.reduceRight((acc, k) => `${SLOT} == ${q(k)} ? {${q(k)}: undefined} : ${acc}`, '{}');
  return [
    { name: SLOT, value: `${isPlainObj('unmapped')} ? (${pick}) : undefined` },
    { name: FLAG, value: `${cond} ? true : false` },
    { name: top, value: `${FLAG} ? ${value} : ${top}` },
    { name: 'unmapped', value: `${FLAG} ? Object.assign({}, unmapped, ${drop}) : unmapped` },
  ];
}

/** The rules that apply to this class set, each with the target it resolves to. */
export function applicableRescues(classNames: string[]): { rule: RescueRule; target: string }[] {
  const types = ocsfAttributeTypes(classNames);
  const out: { rule: RescueRule; target: string }[] = [];
  for (const rule of OCSF_LEFTOVER_RESCUE) {
    const target = rule.to.find(t => t.split('.')[0] in types);
    if (target) out.push({ rule, target });
  }
  return out;
}

/**
 * Eval functions that move well-known leftovers out of `unmapped` into their
 * typed OCSF attribute. Runs after the shaping fold; empty when no rule applies.
 */
export function buildOcsfLeftoverRescue(classNames: string[]): Fn[] {
  const rules = applicableRescues(classNames);
  const fns: Fn[] = [];
  for (let i = 0; i < rules.length; i += RULES_PER_EVAL) {
    const chunk = rules.slice(i, i + RULES_PER_EVAL);
    const last = i + RULES_PER_EVAL >= rules.length;
    const add = chunk.flatMap(r => ruleAdds(r.rule, r.target));
    if (last) add.push({ name: 'unmapped', value: `${isPlainObj('unmapped')} && JSON.stringify(unmapped) == '{}' ? undefined : unmapped` });
    fns.push({
      id: 'eval',
      description: `OCSF: move well-known leftovers from unmapped into typed attributes${rules.length > RULES_PER_EVAL ? ` (${Math.floor(i / RULES_PER_EVAL) + 1}/${Math.ceil(rules.length / RULES_PER_EVAL)})` : ''}`,
      conf: { add, remove: [SLOT, FLAG] },
    });
  }
  return fns;
}

export function isOcsfRescueFn(fn: Fn): boolean {
  return !!fn && fn.id === 'eval' && Array.isArray(fn.conf?.remove) && fn.conf.remove.includes(FLAG);
}
