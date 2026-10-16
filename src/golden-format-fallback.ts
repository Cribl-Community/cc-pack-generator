/**
 * Golden mapping parts stored under a BARE format key — the format dimension of
 * the golden store, the sibling of golden-variant.ts's wire-format dimension.
 *
 * A build never asks for a bare family format. `concretizeOcsfFormat` /
 * `concretizeCimFormat` / `concretizeAsimFormat` turn `ocsf` into `ocsf#network`,
 * `cim` into `cim#endpoint`, … before anything looks a golden up, so the mapping
 * part key it reads is `<st>::ocsf#network::__mapping__`. Parts filed under the
 * bare `<st>::ocsf::__mapping__` are therefore never read — 83 of them in the
 * shipped corpus (15 ocsf, 64 cim, 4 asim), mostly minted by
 * scripts/mine-pack-goldens.mjs, which hardcoded the bare key.
 *
 * Promoting a bare part to a concrete class is only safe when the part PROVES it
 * targets that class. OCSF mappings carry the proof in the event: a `class_uid`
 * literal. Of the 15 bare OCSF parts, 9 carry the class the build would ask for
 * and 5 carry a different one (palo_alto_threat is 4002 where the build wants
 * 4001, okta_system is 6002 where it wants 3002, snort_ids is a 2004 Detection
 * Finding, …) — replaying one of those would hand the build a wrong-class mapping
 * that `capOcsfClass` then caps. So the check is the whole point of the fallback,
 * not a formality.
 *
 * CIM and ASIM parts carry NO class marker: the record has no `report`/`recipe`
 * (the miner wrote neither) and CIM data models share their common fields, so
 * nothing in a stored bare CIM part says which model it was built for. Those stay
 * unreachable by design — see `goldenFormatFallbacks`, which only offers a
 * fallback for families whose class is checkable. Guessing the model would be
 * worse than losing the part: the build's deterministic spec mapping still runs.
 *
 * Pure and dependency-free (like pipeline-stages.ts) so the client store
 * (api.ts), the offline probe (scripts/batch-probe.mjs) and the standalone file
 * store can all apply the identical rule. The uid table is asserted against
 * config/golden-formats.json by tests/golden-format-fallback-test.mjs, so the two
 * cannot drift.
 */

/**
 * OCSF class uid per concrete golden-format key. Parity-tested against
 * `ocsfSchemaOptions()` — the destination UI's own class list — by
 * tests/golden-format-fallback-test.mjs, so the two cannot drift. Kept as a
 * literal table rather than derived, because this module is dependency-free (a
 * value import of pack-builder from api.ts would be a cycle).
 *
 * This is the NOMINAL class, which is what matters here: `ocsf#endpoint` and
 * `ocsf#cloud_audit` do not pin a literal in their spec at all — they compute
 * class_uid per event (`emClassUid` sends Sysmon event_code 3 to 4001, 22 to 4003,
 * 11 to 1001, everything else to 1007), and the nominal class is both the default
 * branch and the uid `capOcsfClass`/`ocsfClassAudit` grade the output against. A
 * stored part emitting a legal-but-different variant of the family is therefore
 * rejected rather than promoted — conservative in the direction that cannot ship
 * a wrong-class pack.
 */
export const OCSF_FORMAT_CLASS_UID: Record<string, number> = {
  'ocsf#network': 4001,
  'ocsf#web_proxy': 4002,
  'ocsf#endpoint': 1007,
  'ocsf#cloud_audit': 6003,
  'ocsf#authentication': 3002,
  'ocsf#dns': 4003,
  'ocsf#email': 4009,
  'ocsf#dhcp': 4004,
  'ocsf#authorize_session': 3003,
  'ocsf#base': 0,
};

/**
 * Bare format keys a concrete `destFormat`'s mapping part may fall back to, most
 * specific first. Only families whose class a stored part can PROVE are offered
 * (`ocsf#…` → `ocsf`); `cim#…`/`asim#…` get none, and an already-bare format gets
 * none (there is nothing more general to try).
 */
export function goldenFormatFallbacks(destFormat: string): string[] {
  const fmt = String(destFormat || '');
  const hash = fmt.indexOf('#');
  if (hash <= 0) return [];
  const family = fmt.slice(0, hash);
  if (family !== 'ocsf') return [];
  return [family];
}

interface EvalLike {
  id?: unknown;
  conf?: { add?: { name?: unknown; value?: unknown }[] | null } | null;
}

/**
 * The single OCSF class uid a mapping stage sets, or null when it does not set
 * one unambiguously. Reads `class_uid` and any nested `<envelope>.class_uid`
 * (an `outputShape: 'nested'` spec writes `ocsf.class_uid`), and requires an
 * integer LITERAL: `aws_vpc_flow`'s `class_uid = ocsf.class_uid` copies a value
 * from elsewhere in the event and proves nothing, and two different literals mean
 * the class is conditional. Unprovable is null, never a guess.
 */
export function mappingClassUid(functions: unknown): number | null {
  if (!Array.isArray(functions)) return null;
  const uids = new Set<number>();
  for (const fn of functions as EvalLike[]) {
    if (!fn || fn.id !== 'eval') continue;
    for (const add of fn.conf?.add || []) {
      const name = String(add?.name ?? '');
      if (name !== 'class_uid' && !name.endsWith('.class_uid')) continue;
      const value = String(add?.value ?? '').trim();
      if (!/^\d+$/.test(value)) return null;      // expression, not a literal class
      uids.add(Number(value));
    }
  }
  if (uids.size !== 1) return null;                // none set, or conditional
  return [...uids][0];
}

/**
 * May a mapping part stored under `storedFormat` serve a build asking for
 * `destFormat`? True only on PROOF — the part sets exactly the class uid
 * `destFormat` names. An unmeasurable part is rejected, because the cost of a
 * wrong-class mapping (a capped, garbage pack) beats the cost of losing a
 * learned one (the deterministic spec mapping still runs).
 */
export function mappingServesFormat(functions: unknown, destFormat: string): boolean {
  const expected = OCSF_FORMAT_CLASS_UID[String(destFormat || '')];
  if (expected == null) return false;
  return mappingClassUid(functions) === expected;
}
