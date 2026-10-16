/**
 * The background batch READ-FAILURE taxonomy: what a failed App KV read means,
 * and which run it was about.
 *
 * Pure and import-free, deliberately. The classification is what the pure
 * runtime (`background-batch-runtime.ts`) and the progress UI decide with, and
 * those must stay importable without pulling in a transport — the store module
 * these types used to live in constructs the real fetch-backed App KV client at
 * module init, so importing a pure helper reached the network layer.
 * `background-batch-store.ts` re-exports everything here, so existing importers
 * and `instanceof` both keep working: one definition, two doors.
 */

/**
 * The read did not complete, and says nothing about the document.
 *
 * Very likely to succeed on the next tick, so a caller must retry rather than
 * conclude anything — above all, never conclude that a run is gone.
 */
export class BackgroundBatchTransientReadError extends Error {
  override name = 'BackgroundBatchTransientReadError';
}

export function isBackgroundBatchTransientReadError(
  error: unknown,
): error is BackgroundBatchTransientReadError {
  return error instanceof BackgroundBatchTransientReadError;
}

/**
 * The document was delivered and cannot be parsed.
 *
 * The opposite fact to a transient read, and the reason it is its own type: a
 * transient failure will very likely succeed on the next tick, while this one
 * will fail identically forever. That makes it the ONE read failure a delete is
 * allowed to proceed through — a manifest nobody can parse is also the manifest
 * whose active pointer refuses the next Start, so refusing to clean it up
 * leaves the operator with no move at all. Every other failure (auth, policy,
 * transport) says nothing about the document and must never license a delete.
 */
export class BackgroundBatchCorruptDocumentError extends Error {
  override name = 'BackgroundBatchCorruptDocumentError';
}

export function isBackgroundBatchCorruptDocumentError(
  error: unknown,
): error is BackgroundBatchCorruptDocumentError {
  return error instanceof BackgroundBatchCorruptDocumentError;
}

/**
 * Which run a failed read was about.
 *
 * The caller that knows (it asked by id) tags the error on the way out, so a
 * read that never produced a manifest can still be acted on: a corrupt document
 * found at mount has no checkpoint to take a run id from, and without one the
 * only remaining move — cleaning it up — has nothing to name.
 */
export function tagBackgroundRunId<E>(error: E, runId: string): E {
  if (error && typeof error === 'object') (error as { runId?: string }).runId = runId;
  return error;
}

export function backgroundRunIdOf(error: unknown): string | undefined {
  const runId = error && typeof error === 'object' ? (error as { runId?: unknown }).runId : undefined;
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}
