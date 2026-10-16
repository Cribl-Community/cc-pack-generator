/**
 * Replace-and-install of a pack on a worker group, one install at a time.
 *
 * A batch runs several pack groups side by side, and the leader does not take
 * concurrent installs into one group: a 4-wide run failed rows with
 * `Cannot read properties of undefined (reading 'REST_list')` and with
 * `Pack Id conflicts with existing Pack "infobloxdns-cim"` for a pack that no
 * longer existed a minute later. The old sequence also ignored a failed DELETE,
 * so an install could land on a pack still being removed.
 *
 * So: every install goes through one lock, the old pack must be confirmed gone
 * (GET → 404) before the upload, and those two leader errors get one retry.
 */
import { createSerialLock } from './serial-lock';

export interface PackInstallSteps {
  /** DELETE the pack; rejects with the API error (a 404 is fine). */
  remove(): Promise<void>;
  /** Whether the pack is still listed on the group. */
  exists(): Promise<boolean>;
  /** PUT the .crbl; resolves to the leader's `source` for the install. */
  upload(): Promise<string>;
  /** POST the install of an uploaded `source`. */
  install(source: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
  log?(msg: string): void;
}

export const PACK_GONE_CHECKS = 5;
export const PACK_GONE_WAIT_MS = 1000;
export const PACK_INSTALL_RETRY_WAIT_MS = 2000;

/** The leader errors a concurrent install produces — worth exactly one retry. */
export const RETRYABLE_PACK_INSTALL = /REST_list|Pack Id conflicts/i;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function removePackFully(packId: string, steps: PackInstallSteps): Promise<void> {
  const sleep = steps.sleep || wait;
  let deleteError = '';
  try { await steps.remove(); } catch (err) {
    if (!/\(404\)/.test(errText(err))) deleteError = errText(err);
  }
  for (let i = 0; i < PACK_GONE_CHECKS; i++) {
    if (!(await steps.exists())) return;
    await sleep(PACK_GONE_WAIT_MS);
  }
  throw new Error(`Could not remove the existing pack "${packId}" before reinstalling it${deleteError ? `: ${deleteError}` : ' — it is still listed on the worker group'}.`);
}

const installLock = createSerialLock();

export function installPackSerially(packId: string, steps: PackInstallSteps): Promise<void> {
  const sleep = steps.sleep || wait;
  return installLock(async () => {
    await removePackFully(packId, steps);
    const source = await steps.upload();
    try {
      await steps.install(source);
    } catch (err) {
      if (!RETRYABLE_PACK_INSTALL.test(errText(err))) throw err;
      steps.log?.(`Install of ${packId} hit a leader error (${errText(err)}) — retrying once...`);
      await sleep(PACK_INSTALL_RETRY_WAIT_MS);
      await removePackFully(packId, steps);
      await steps.install(await steps.upload());
    }
  });
}
