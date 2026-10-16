/**
 * Standalone disk store for pseudonymised customer samples.
 *
 * This is intentionally separate from config/ai-samples: one is measured real wire
 * format with identities replaced, the other is model output. Both the UI and the
 * sample tier ladder need to preserve that difference.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { aiSampleKeyToFile, sampleStoreKeys } from '../src/sample-library.ts';
import {
  parseSanitisedSampleDoc,
  sanitisedSampleIndexRow,
} from '../src/sanitised-sample-store.ts';

const DEFAULT_DIR = join(process.cwd(), 'config', 'sanitised-samples');

function safeKey(key) {
  const value = String(key || '');
  return !!value && !/[/\\]/.test(value) && !value.includes('..') && /^[a-z0-9_.:#-]+$/i.test(value);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

export function createSanitisedSampleLibrary(directory = DEFAULT_DIR) {
  const indexPath = join(directory, 'index.json');
  const filePath = key => join(directory, aiSampleKeyToFile(key));

  async function ensure() {
    await mkdir(directory, { recursive: true });
  }

  async function list() {
    const value = await readJson(indexPath, { version: 1, samples: [] });
    return {
      version: 1,
      samples: Array.isArray(value?.samples) ? value.samples : [],
    };
  }

  async function read(key) {
    if (!safeKey(key)) return null;
    const value = await readJson(filePath(key), null);
    const doc = parseSanitisedSampleDoc(value);
    return doc?.key === key ? doc : null;
  }

  async function save(value) {
    const doc = parseSanitisedSampleDoc(value);
    if (!doc || !safeKey(doc.key)) throw new Error('Invalid sanitised sample document.');
    await ensure();
    await atomicJson(filePath(doc.key), doc);
    const index = await list();
    const row = sanitisedSampleIndexRow(doc);
    const samples = index.samples.filter(item => item?.key !== doc.key);
    samples.push(row);
    samples.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    await atomicJson(indexPath, { version: 1, samples });
    return { ok: true, entry: row };
  }

  async function deleteDoc(key) {
    if (!safeKey(key)) return { ok: false, reason: 'Invalid sanitised sample key.' };
    await ensure();
    await rm(filePath(key), { force: true });
    const index = await list();
    await atomicJson(indexPath, {
      version: 1,
      samples: index.samples.filter(item => item?.key !== key),
    });
    return { ok: true, key };
  }

  return { directory, list, read, save, delete: deleteDoc };
}

const defaultLibrary = createSanitisedSampleLibrary();
export const readSanitisedIndex = () => defaultLibrary.list();
export const readSanitisedDoc = key => defaultLibrary.read(key);
export const saveSanitisedDoc = doc => defaultLibrary.save(doc);
export const deleteSanitisedDoc = key => defaultLibrary.delete(key);

export async function getSanitisedLibrarySample(sourcetype, format = null) {
  const st = String(sourcetype || '').trim().toLowerCase();
  if (!st) return null;
  for (const key of sampleStoreKeys(st, format)) {
    const doc = await defaultLibrary.read(key);
    if (doc) return doc;
  }
  return null;
}

export function getSanitisedLibrarySampleSync(sourcetype, format = null) {
  const st = String(sourcetype || '').trim().toLowerCase();
  for (const key of sampleStoreKeys(st, format)) {
    if (!safeKey(key)) continue;
    const path = join(DEFAULT_DIR, aiSampleKeyToFile(key));
    if (!existsSync(path)) continue;
    try {
      const doc = parseSanitisedSampleDoc(JSON.parse(readFileSync(path, 'utf8')));
      if (doc?.key === key) return doc;
    } catch { /* malformed library file is not a hit */ }
  }
  return null;
}

export function toSanitisedReferenceResponse(doc) {
  if (!doc?.events?.length) return null;
  return {
    available: true,
    events: doc.events,
    sourcetype: doc.sourcetype,
    pack: 'sanitised-samples',
    fields: doc.verification?.fields || [],
    sampleName: `${doc.sourcetype}_sanitised_sample`,
    synthetic: false,
    sanitised: true,
    verification: doc.verification || null,
  };
}
