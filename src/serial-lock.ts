/**
 * Runs async tasks one at a time, in call order.
 *
 * Used where the far side cannot take calls in parallel: Cribl AI (one shared org
 * agent behind the app proxy's 30s ceiling) and pack installs into a worker group
 * (the leader fails a concurrent install with `reading 'REST_list'` or a false
 * "Pack Id conflicts"). A task that rejects does not block the ones behind it.
 */
export type SerialLock = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialLock(): SerialLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
