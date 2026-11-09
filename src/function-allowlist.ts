/**
 * The Cribl functions a generated pipeline may contain, and the check every write goes through.
 *
 * A pipeline reaches a worker group from three places the app does not fully control: a golden
 * imported from the public shared pool, AI output, and a stored golden replayed without AI. Each
 * is just a function list, so a poisoned pool document or a prompt-injected sample could add a
 * function the generator itself never builds — `tee` runs a command on the worker, `redis` and
 * `dns_lookup` reach the network, `chain` and `clone` move events elsewhere. This list is the
 * builder's own vocabulary (measured over src/, backend/ and every bundled golden); anything
 * outside it is refused at import and again at deploy, in every run mode.
 */
export const GENERATOR_FUNCTIONS: ReadonlySet<string> = new Set([
  'auto_timestamp', 'cef', 'code', 'comment', 'drop', 'eval', 'flatten', 'lookup',
  'numerify', 'regex_extract', 'rename', 'sampling', 'serde', 'serialize', 'suppress', 'unroll',
]);

/** Function ids in `functions` the generator never emits, in order, without repeats. */
export function disallowedFunctions(functions: unknown): string[] {
  if (!Array.isArray(functions)) return [];
  const bad: string[] = [];
  for (const fn of functions) {
    const id = fn && typeof fn === 'object' ? (fn as { id?: unknown }).id : undefined;
    const name = typeof id === 'string' ? id : String(id);
    if (!GENERATOR_FUNCTIONS.has(name) && !bad.includes(name)) bad.push(name);
  }
  return bad;
}

export class DisallowedFunctionError extends Error {
  readonly functions: string[];
  constructor(functions: string[], where: string) {
    super(`${where} uses ${functions.length === 1 ? 'a function' : 'functions'} the Pack Generator never builds (${functions.join(', ')}), so it is not deployed.`);
    this.name = 'DisallowedFunctionError';
    this.functions = functions;
  }
}

/** Throws when a pipeline conf holds a function outside GENERATOR_FUNCTIONS. */
export function assertGeneratorFunctions(conf: { functions?: unknown } | null | undefined, where = 'This pipeline'): void {
  const bad = disallowedFunctions(conf?.functions);
  if (bad.length) throw new DisallowedFunctionError(bad, where);
}
