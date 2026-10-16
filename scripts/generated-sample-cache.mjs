import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const inFlight = new Map();

function cacheDir() {
  return process.env.AI_SAMPLE_CACHE_DIR || join(process.cwd(), '.cache', 'generated-samples');
}

export function generatedSampleCacheKey({ source = 'ai', sourcetype, count, mode = 'balanced', url = '', format = '' }) {
  return JSON.stringify({
    version: 1,
    source,
    sourcetype: String(sourcetype || '').trim().toLowerCase(),
    count: Number(count) || 0,
    mode: String(mode || 'balanced').trim().toLowerCase(),
    url: String(url || '').trim(),
    format: String(format || '').trim().toLowerCase(),
  });
}

function cachePath(key) {
  const digest = createHash('sha256').update(key).digest('hex');
  return join(cacheDir(), `${digest}.json`);
}

async function readCached(key) {
  try {
    const stored = JSON.parse(await readFile(cachePath(key), 'utf8'));
    if (stored.key !== key || !Array.isArray(stored.result?.events) || stored.result.events.length === 0) return null;
    return { ...stored.result, cached: true };
  } catch {
    return null;
  }
}

async function writeCached(key, result) {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const target = cachePath(key);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ key, savedAt: new Date().toISOString(), result }), 'utf8');
  await rename(temporary, target);
}

// Persist successful generations and collapse concurrent identical requests into
// one AI call. Failed/empty generations are deliberately never cached.
export async function withGeneratedSampleCache(identity, generate) {
  const key = generatedSampleCacheKey(identity);
  const cached = await readCached(key);
  if (cached) return cached;

  if (inFlight.has(key)) return inFlight.get(key);
  const pending = (async () => {
    const secondRead = await readCached(key);
    if (secondRead) return secondRead;
    const result = await generate();
    if (Array.isArray(result?.events) && result.events.length > 0) {
      await writeCached(key, result);
    }
    return { ...result, cached: false };
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}
