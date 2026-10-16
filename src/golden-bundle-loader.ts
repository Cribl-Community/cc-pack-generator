export interface BundledGoldenStore {
  pipelines?: Record<string, any>;
}

/** Build a lazy loader whose factory runs once and whose promise is shared. */
export function createCachedLoader<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= factory();
    return cached;
  };
}

/** The only browser-side load path for the full bundled golden body store. */
export const loadBundledGoldenPipelines = createCachedLoader(async (): Promise<BundledGoldenStore> => {
  const mod = await import('../config/golden-pipelines.json');
  return ((mod as { default?: BundledGoldenStore }).default ?? mod) as BundledGoldenStore;
});

export async function seedGoldenDefaultsSafely(
  loadModule: () => Promise<{ seedGoldenDefaults: (build: number) => Promise<void> }>,
  currentBuild: number,
  log: (...args: unknown[]) => void = console.warn,
): Promise<boolean> {
  try {
    const module = await loadModule();
    await module.seedGoldenDefaults(currentBuild);
    return true;
  } catch (error) {
    log('[goldens] Bundled defaults could not be loaded; continuing without idle seeding.', error instanceof Error ? error.message : String(error));
    return false;
  }
}
