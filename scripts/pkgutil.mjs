import { spawn } from 'node:child_process';
import {
  mkdir,
  rm,
  cp,
  writeFile,
  readFile,
  readdir,
  stat,
  access,
} from 'node:fs/promises';
import { join, dirname, relative, extname, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** @param {string} cwd */
async function runNpmBuild(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `npm run build exited with code ${code}`));
    });
  });
}

/**
 * Cribl's Backend Function ceiling. Inclusive: a bundle AT the cap is already
 * refused by the platform, so refuse it here where the message can say why.
 */
export const BACKEND_BUNDLE_MAX_BYTES = 5_000_000;

/**
 * No single bundled JSON may be bigger than this. The cap above is the fact
 * that matters, but it fires only once a bundle is already broken and gives no
 * clue which import did it; a knowledge file over this size is the way this
 * graph gets there, and naming the file is the actionable half. Two legitimate,
 * needed imports of pack-builder.ts sit under the line: `config/
 * source-samples.json` (621 KB) and `config/xsiam-rule-contracts.json` (1.08 MB,
 * the demisto/content parsing-rule mirror reached via capXsiam). The line sits
 * above both and far below the 11 MB golden corpus it exists to keep out; the
 * total bundle stays well under BACKEND_BUNDLE_MAX_BYTES (measured by
 * tests/backend-function-bundle-safe-test.mjs, which also mirrors this
 * source-graph walk — the same rule enforced on the real build output).
 */
export const BACKEND_BUNDLE_MAX_JSON_BYTES = 1_200_000;

/**
 * Modules that must never be reachable from a Backend Function: the bundled
 * knowledge graph (browser/iframe-only) and the golden corpus behind it.
 */
const BACKEND_BUNDLE_FORBIDDEN_INPUTS = [
  /(^|\/)src\/(bundled-data|bundled-goldens|golden-bundle-loader)\.[jt]sx?$/,
  /(^|\/)config\/golden-pipelines\.json$/,
];

/**
 * What is wrong with one bundle, as a list of human-readable reasons.
 *
 * Pure, and separate from the build so each rule can be checked on its own
 * input instead of hoping the real graph happens to violate it.
 *
 * THROWS on a malformed argument rather than returning `[]`. An empty list
 * means "this bundle is fine", and a guard that could not run must never say
 * that (Hard Rule 32): a caller that passed `{ size }` instead of
 * `{ outputBytes }` would have shipped an unchecked bundle with a clean report.
 *
 * @param {{ script: string, outputBytes: number, inputs?: Record<string, number> }} bundle
 * @returns {string[]}
 */
export function backendBundleViolations(bundle) {
  const fail = (why) => { throw new TypeError(`backendBundleViolations: ${why}`); };
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) fail('expected a bundle object');
  const { script, outputBytes, inputs } = bundle;
  if (typeof script !== 'string' || script.length === 0) fail('`script` must be a non-empty string');
  if (typeof outputBytes !== 'number' || !Number.isFinite(outputBytes) || outputBytes < 0) {
    fail(`\`outputBytes\` must be a non-negative number (got ${JSON.stringify(outputBytes)})`);
  }
  if (inputs !== undefined && (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs))) {
    fail('`inputs` must be a metafile-style path → bytes map');
  }
  for (const [input, bytes] of Object.entries(inputs ?? {})) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
      fail(`input \`${input}\` must map to a byte count (got ${JSON.stringify(bytes)})`);
    }
  }

  const violations = [];
  if (outputBytes >= BACKEND_BUNDLE_MAX_BYTES) {
    violations.push(
      `${script} bundles to ${outputBytes} bytes, at or over the ${BACKEND_BUNDLE_MAX_BYTES}-byte Backend Function cap.`,
    );
  }
  for (const [input, bytes] of Object.entries(inputs ?? {})) {
    // esbuild's metafile keys are relative to `absWorkingDir`, and a caller can
    // still hand us an absolute or `./`-prefixed path. Normalise the separators
    // and strip the leading `./` so the anchored patterns above mean the same
    // thing however the path was spelled — before build 753 the same forbidden
    // module matched or did not depending on where the packager was invoked.
    const normalized = input.split('\\').join('/').replace(/^\.\//, '');
    if (BACKEND_BUNDLE_FORBIDDEN_INPUTS.some(pattern => pattern.test(normalized))) {
      violations.push(`${script} reaches ${input}, which must never be bundled into a Backend Function.`);
      continue;
    }
    if (normalized.endsWith('.json') && bytes > BACKEND_BUNDLE_MAX_JSON_BYTES) {
      violations.push(
        `${script} bundles ${input} (${bytes} bytes), over the ${BACKEND_BUNDLE_MAX_JSON_BYTES}-byte per-JSON limit.`,
      );
    }
  }
  return violations;
}

/**
 * Ceiling on the golden lookup corpus injected into a Backend Function bundle.
 * The corpus is ~160 KB of CSV today; this sits well above that and far below
 * anything that would threaten the 5 MB bundle cap, so a new lookup is free but
 * "someone pointed the index at the sample library" is not.
 */
export const BACKEND_REFERENCE_LOOKUPS_MAX_BYTES = 400_000;

/**
 * The golden lookup corpus, as one injectable object.
 *
 * A Backend Function cannot read `config/` and cannot import the bundled
 * knowledge graph that holds this in the browser, so the packager embeds the
 * corpus as an esbuild define and `src/backend-reference-lookups.ts` reads it.
 * Without this a background-built cisco_asa pack deploys a lookup FUNCTION with
 * no lookup FILE behind it — the pipeline runs and silently extracts nothing.
 *
 * A file the index names but that is not on disk is a BUILD failure: shipping
 * the index without the CSV is the exact defect this exists to prevent.
 *
 * @param {string} rootDir
 * @param {{ index?: object }} [overrides] - test seam; the real build reads config/.
 */
export async function backendReferenceLookupPayload(rootDir, overrides = {}) {
  const dir = join(rootDir, 'config', 'golden-lookups');
  const index = overrides.index ?? JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));

  const files = {};
  for (const category of Object.values(index?.lookups ?? {})) {
    for (const entry of Object.values(category ?? {})) {
      const name = entry?.file;
      if (!name || files[name] !== undefined) continue;
      if (name !== basename(name)) {
        throw new Error(`Golden lookup index entry "${name}" must be a bare filename.`);
      }
      try {
        files[name] = await readFile(join(dir, name), 'utf8');
      } catch {
        throw new Error(`Golden lookup index names ${name}, but config/golden-lookups/${name} does not exist.`);
      }
    }
  }

  const payload = { index, files };
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > BACKEND_REFERENCE_LOOKUPS_MAX_BYTES) {
    throw new Error(
      `Golden lookup corpus is ${bytes} bytes, over the ${BACKEND_REFERENCE_LOOKUPS_MAX_BYTES}-byte injection cap.`,
    );
  }
  return payload;
}

/**
 * Bundle every endpoint declared in a `backend.yml` into a self-contained
 * CommonJS file per Cribl's documented contract ("Bundles each function and
 * its dependencies into one CommonJS .js file... Cribl does not install npm
 * dependencies or resolve relative imports when it deploys the package"), and
 * write a package-local copy of the manifest with each `script:` path
 * rewritten to point at the bundled output.
 *
 * Hand-rolled with esbuild because this repo predates the `@cribl/apps` CLI
 * (Hard Rule 25/26/27) — there is no `apps build` step to do this for us.
 *
 * VERIFIED against a real Cribl org (build 716→717): the first attempt placed
 * `backend-build/` at the package ROOT (sibling to `default/`) and the
 * install/upgrade API rejected it — "backend.yml: declared script … was not
 * found in archive". Cribl resolves a manifest's `script:` path relative to
 * `backend.yml`'s OWN directory (`default/`), not the package root — so the
 * bundle must live at `default/backend-build/*.js`, matching `default/
 * backend.yml`'s neighboring `script: backend-build/<file>.js`.
 *
 * @param {string} manifestPath - source config/backend.yml
 * @param {string} rootDir - project root (script paths in the manifest are relative to this)
 * @param {string} buildDir - package-build/ staging directory
 * @returns {Promise<{ manifestPath: string, bundles: { script: string, outfile: string, bytes: number, inputs: Record<string, number> }[] }>}
 */
export async function bundleBackendFunctions(manifestPath, rootDir, buildDir) {
  const manifest = parseYaml(await readFile(manifestPath, 'utf8'));
  const backendBuildDir = join(buildDir, 'default', 'backend-build');
  await mkdir(backendBuildDir, { recursive: true });
  // `BUILD_NUMBER` is a build-time define everywhere else (vite.config.ts). A
  // Backend Function builds real packs, and their README footer reads it — an
  // undefined one is a guarded literal "build unknown" on every background-built
  // pack, so the backend bundle substitutes it too.
  const backendPkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  // The lookup corpus travels as a define, not an import — see
  // src/backend-reference-lookups.ts for why, and why it is read exactly once
  // there (a `typeof` guard would inline this whole string twice).
  const referenceLookups = await backendReferenceLookupPayload(rootDir);

  // Resolve and check every declared script BEFORE building any of them: an
  // endpoint that escapes the project, or two whose basenames collide in
  // default/backend-build/, must fail the package rather than silently ship one
  // endpoint running another's handler.
  const endpoints = manifest.endpoints ?? [];
  const byOutput = new Map();
  for (const endpoint of endpoints) {
    const script = endpoint.script;
    if (typeof script !== 'string' || script.length === 0) {
      throw new Error(`Backend endpoint "${endpoint.name ?? '(unnamed)'}" declares no script.`);
    }
    if (isAbsolute(script)) {
      throw new Error(`Backend endpoint script "${script}" must be a project-relative path.`);
    }
    const entry = resolvePath(rootDir, script);
    const inside = relative(rootDir, entry);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`Backend endpoint script "${script}" resolves outside the project (${entry}).`);
    }
    const outBase = basename(script).replace(/\.tsx?$/, '.js');
    const clash = byOutput.get(outBase);
    if (clash) {
      throw new Error(
        `Backend endpoints "${clash}" and "${script}" both bundle to backend-build/${outBase} — rename one.`,
      );
    }
    byOutput.set(outBase, script);
  }

  /** @type {{ script: string, outfile: string, bytes: number, inputs: Record<string, number> }[]} */
  const bundles = [];

  for (const endpoint of endpoints) {
    const script = endpoint.script;
    const entry = resolvePath(rootDir, script);
    const outBase = basename(script).replace(/\.tsx?$/, '.js');
    const outfile = join(backendBuildDir, outBase);
    const result = await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      // Pin the graph to the project root so metafile input keys — which the
      // forbidden-input guard matches on — do not depend on the directory the
      // packager happened to be invoked from.
      absWorkingDir: rootDir,
      // NOT 'node' (build 722 finding, verified against a real invocation):
      // Cribl's Backend Function sandbox has its OWN restricted module loader
      // (`__cribl_require`), not full Node — `require('process')` and
      // `require('node:crypto')` both come back "cannot resolve module".
      // Both failures were in third-party packages `src/`'s own code doesn't
      // touch directly: `yaml` (via xsiam-builder.ts, only uses `stringify`,
      // but its Node build's parser submodule does `require('process')` for
      // an unrelated debug-log check) and `@smithy/core` (via ai-client.ts's
      // Bedrock SigV4 signing). Both packages ship a `browser` package.json
      // field/export condition specifically avoiding these — and since every
      // file under `src/` was already written to run in a browser/iframe
      // sandbox (Hard Rule 25), targeting 'browser' here is the right choice
      // for this whole dependency graph, not a workaround for one package.
      platform: 'browser',
      format: 'cjs',
      target: 'node22',
      define: {
        BUILD_NUMBER: JSON.stringify(backendPkg.buildNumber || 0),
        // Injected as JSON TEXT, not as an object literal: one string literal
        // is one substitution site and one lazy JSON.parse at runtime.
        BACKEND_REFERENCE_LOOKUPS: JSON.stringify(JSON.stringify(referenceLookups)),
      },
      // What the bundle actually PULLED IN. Enforcing on the metafile rather
      // than on the output text is what makes the rule nameable: the 5 MB cap
      // says a bundle is too big, the input list says which import did it.
      metafile: true,
      // Whitespace only — names and syntax are kept. Unminified, run-batch-step
      // reached 4.99 MB of the 5 MB cap (2026-10-09); this leaves ~1.4 MB.
      minifyWhitespace: true,
      logLevel: 'warning',
    });
    // Verify the documented handler contract before shipping — a bundle that
    // silently exports nothing is a runtime 500 on every invocation, not a
    // build failure, without this.
    //
    // By LOADING the bundle, not by matching its text: `onRequest:` occurs in a
    // comment, a string, or any unrelated object literal, so the old substring
    // check passed for bundles that export nothing of the sort. The contract is
    // `module.exports.onRequest` being callable, so evaluate it and look.
    await assertExportsOnRequest(script, outfile);

    const bytes = (await stat(outfile)).size;
    const inputs = Object.fromEntries(
      Object.entries(result.metafile?.inputs ?? {}).map(([path, meta]) => [path, meta.bytes]),
    );
    const violations = backendBundleViolations({ script, outputBytes: bytes, inputs });
    if (violations.length > 0) {
      throw new Error(`Backend Function bundle refused:\n  ${violations.join('\n  ')}`);
    }

    bundles.push({ script, outfile, bytes, inputs });
    endpoint.script = `backend-build/${outBase}`;
  }

  const destPath = join(buildDir, 'default', 'backend.yml');
  await writeFile(destPath, stringifyYaml(manifest));
  return { manifestPath: destPath, bundles };
}

/**
 * Load a bundled Backend Function the way Cribl does and assert the documented
 * handler contract: `module.exports.onRequest` is a function.
 *
 * `require` throws rather than resolving — Cribl's sandbox has its own
 * restricted loader, so a bundle that still needs a module at runtime is broken
 * there too. `fetch` is stubbed for the duration so a module that calls out at
 * import time cannot make the packager issue a network request.
 */
async function assertExportsOnRequest(script, outfile) {
  const code = await readFile(outfile, 'utf8');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('packaging: module init must not fetch'); };
  try {
    const mod = { exports: {} };
    const factory = new Function('module', 'exports', 'require', code);
    factory(mod, mod.exports, (name) => {
      throw new Error(`${script} bundle still requires "${name}" — it must be self-contained.`);
    });
    if (typeof mod.exports.onRequest !== 'function') {
      throw new Error(
        `${script} bundle does not export a callable onRequest (got ${typeof mod.exports.onRequest}).`,
      );
    }
  } catch (error) {
    if (/does not export a callable onRequest|still requires/.test(error.message)) throw error;
    throw new Error(`${script} bundle failed to load, so onRequest could not be verified: ${error.message}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

let packageInProgress = false;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRIBL_CREATE_APP_SCRIPT_VERSION = '0.2.0';

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prune `staticDir` down to ONLY the files reachable from `static/index.html`.
 *
 * The shared Vite build emits one `dist/` for both app targets, so a copy of it carries
 * ~1,440 assets and 30 MB — almost all of it the Pack Generator's (ai-core, golden
 * pipelines, vendor samples). The Sample Sanitizer entry references a tiny, provably
 * CLOSED graph (Hard Rule 25: `sanitizer-core-*.js` imports only the modulepreload
 * polyfill, zero `import(` sites, zero `assets/` string refs), so we can safely delete
 * everything the entry does not reach.
 *
 * The walk is a transitive closure over the real reference forms Vite emits — HTML
 * `src`/`href`, JS `from"./x.js"` / `import("./x.js")` / `"assets/x.ext"`, and CSS
 * `url(...)` / `@import`. It is intentionally opt-in (`pruneAssets`): the Pack Generator
 * loads many chunks by dynamic import and MUST keep the whole `dist/`.
 *
 * @param {string} staticDir
 * @returns {Promise<{ kept: string[]; removed: number }>}
 */
export async function pruneStaticToEntry(staticDir) {
  const listFiles = async (dir) => {
    /** @type {string[]} */
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await listFiles(full)));
      else out.push(full);
    }
    return out;
  };

  // Reference forms Vite emits, all yielding a path relative to static/.
  const refPatterns = [
    /(?:src|href)\s*=\s*["']\.?\/?([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)["']/g, // HTML tags
    /from\s*["']\.?\/?((?:assets\/)?[A-Za-z0-9._-]+\.js)["']/g,            // `import … from"./x.js"`
    /\bimport\s*["']\.?\/?((?:assets\/)?[A-Za-z0-9._-]+\.js)["']/g,        // side-effect `import"./x.js"`
    /import\(\s*["']\.?\/?((?:assets\/)?[A-Za-z0-9._-]+\.js)["']\s*\)/g,   // dynamic `import("./x.js")`
    /["']\.?\/?(assets\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+)["']/g,              // JS asset ref
    /url\(\s*["']?\.?\/?((?:assets\/)?[A-Za-z0-9._-]+\.[A-Za-z0-9]+)["']?\s*\)/g, // CSS url()
    /@import\s*["']\.?\/?((?:assets\/)?[A-Za-z0-9._-]+\.css)["']/g,        // CSS @import
  ];

  // A reference is relative to the file that made it. HTML/CSS/JS in this build only ever
  // cross-reference either a sibling in the same dir or an `assets/`-prefixed path, so we
  // resolve a bare name inside assets/ to `assets/<name>` and keep prefixed paths as-is.
  const resolveRef = (fromRel, ref) => {
    if (ref.includes('/')) return ref.replace(/^\.?\//, '');
    const fromDir = dirname(fromRel);
    return fromDir === '.' ? ref : `${fromDir}/${ref}`;
  };

  const keep = new Set(['index.html']);
  const queue = ['index.html'];
  while (queue.length) {
    const rel = queue.shift();
    const full = join(staticDir, rel);
    let text;
    try {
      if (!/\.(html|js|css)$/.test(rel)) continue;
      text = await readFile(full, 'utf8');
    } catch { continue; }
    for (const pattern of refPatterns) {
      for (const match of text.matchAll(pattern)) {
        const resolved = resolveRef(rel, match[1]);
        if (keep.has(resolved)) continue;
        // Only follow references that resolve to a real file in the pack.
        try { await stat(join(staticDir, resolved)); } catch { continue; }
        keep.add(resolved);
        queue.push(resolved);
      }
    }
  }

  let removed = 0;
  for (const full of await listFiles(staticDir)) {
    const rel = relative(staticDir, full).split('\\').join('/');
    if (!keep.has(rel)) { await rm(full, { force: true }); removed += 1; }
  }
  return { kept: [...keep].sort(), removed };
}

/**
 * Materialize the pack layout at the repo ROOT for Cribl "Import from Git": a
 * git clone of the release tag must look like an unpacked .tgz. Writes
 * `static/` (from `dist/`), `default/proxies.yml`, `default/policies.yml` and,
 * when `config/backend.yml` exists, the bundled Backend Functions under
 * `default/backend-build/` with `default/backend.yml` pointing at them — the same
 * layout `createAppPack` builds. The community repo's release workflow runs this
 * and commits the output onto the tag (scripts/prepare-git-pack.mjs).
 */
export async function prepareGitPackLayout() {
  const rootDir = join(__dirname, '..');
  const distDir = join(rootDir, 'dist');
  const staticDir = join(rootDir, 'static');
  const defaultDir = join(rootDir, 'default');
  if (!(await pathExists(distDir))) {
    throw new Error('dist folder not found. Run npm run build first.');
  }
  await rm(staticDir, { recursive: true, force: true });
  await rm(defaultDir, { recursive: true, force: true });
  await mkdir(defaultDir, { recursive: true });
  await cp(distDir, staticDir, { recursive: true });
  for (const name of ['proxies.yml', 'policies.yml']) {
    const src = join(rootDir, 'config', name);
    if (await pathExists(src)) await cp(src, join(defaultDir, name));
  }
  const backendPath = join(rootDir, 'config', 'backend.yml');
  if (await pathExists(backendPath)) {
    await bundleBackendFunctions(backendPath, rootDir, rootDir);
  }
}

/**
 * Package the built app into an App Platform .tgz stream.
 *
 * Two app targets are produced from ONE Vite build (see vite.config.ts): the Pack
 * Generator (index.html) and the Sample Sanitizer (sanitizer.html). Both ship the
 * same shared `dist/` assets; the caller picks which HTML entry becomes the pack's
 * `static/index.html`, and supplies that target's manifest / policies / proxies.
 *
 * Back-compat: `createAppPack(true)` / `createAppPack(false)` still work (the old
 * boolean-`dev` signature); options are the new form.
 *
 * @param {boolean | {
 *   dev?: boolean,
 *   manifestPath?: string,   // JSON manifest (name/version/displayName/…); default root package.json
 *   entryHtml?: string,      // dist HTML that becomes static/index.html; default 'index.html'
 *   proxiesPath?: string | null, // outbound-host proxies; null = none (sanitizer has no external hosts)
 *   policiesPath?: string | null, // RBAC policies
 *   pruneAssets?: boolean,   // strip every dist/ asset the entry HTML does not reach (sanitizer)
 *   readmePath?: string | null,  // README.md shipped at pack root (Marketplace renders it)
 *   licensePath?: string | null, // LICENSE shipped at pack root
 *   logoPath?: string | null,    // app logo shipped at pack root (logo.<ext>)
 * }} [opts]
 * @returns {Promise<{ closePromise: Promise<void>; stdout: import('node:stream').Readable }>}
 */
export async function createAppPack(opts = false) {
  const {
    dev = false,
    manifestPath = null,
    entryHtml = 'index.html',
    proxiesPath: proxiesOverride,
    policiesPath: policiesOverride,
    backendPath: backendOverride,
    pruneAssets = false,
    readmePath = null,
    licensePath = null,
    logoPath = null,
  } = typeof opts === 'boolean' ? { dev: opts } : (opts || {});

  const rootDir = join(__dirname, '..');
  const buildDir = join(rootDir, 'package-build');
  const distDir = join(rootDir, 'dist');
  const staticDir = join(buildDir, 'static');
  // `undefined` (key omitted) → default config; explicit `null` → deliberately none.
  const proxiesPath = proxiesOverride === undefined
    ? join(rootDir, 'config', 'proxies.yml')
    : proxiesOverride;
  const policiesPath = policiesOverride === undefined
    ? join(rootDir, 'config', 'policies.yml')
    : policiesOverride;
  // Same convention, but the default is conditional on the file existing at
  // all — most apps (the sanitizer, today) have no backend functions, and
  // `config/backend.yml` not existing must not be an error.
  const backendPath = backendOverride === undefined
    ? join(rootDir, 'config', 'backend.yml')
    : backendOverride;

  if (await pathExists(buildDir)) {
    await rm(buildDir, { recursive: true });
  }

  await mkdir(buildDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await mkdir(join(buildDir, 'default'), { recursive: true });

  const packageJsonSource = manifestPath || join(rootDir, 'package.json');
  const rootPackageJson = JSON.parse(await readFile(packageJsonSource, 'utf8'));

  if (!dev) {
    if (!(await pathExists(distDir))) {
      throw new Error('dist folder not found. Run npm run build first.');
    }
    await cp(distDir, staticDir, { recursive: true });

    // Pick the pack's entry HTML. Both app HTMLs live in dist/; the platform serves
    // static/index.html, so a non-default entry (sanitizer.html) overwrites it. The
    // baked `window.CRIBL_APP_ID` (a dev artifact of the shared build — nothing in the
    // app reads it) is corrected to this pack's id for hygiene.
    if (entryHtml !== 'index.html') {
      const entryPath = join(staticDir, entryHtml);
      if (!(await pathExists(entryPath))) {
        throw new Error(`entry HTML "${entryHtml}" not found in dist. Did vite build emit it?`);
      }
      const appId = `${dev ? '__dev__' : ''}${rootPackageJson.name}`;
      let entryHtmlText = await readFile(entryPath, 'utf8');
      entryHtmlText = entryHtmlText.replace(
        /window\.CRIBL_APP_ID\s*=\s*'[^']*';/,
        `window.CRIBL_APP_ID = '${appId}';`
      );
      await writeFile(join(staticDir, 'index.html'), entryHtmlText);
      await rm(entryPath, { force: true });
    }

    // Strip everything the chosen entry does not reach. The shared build bakes both
    // apps' assets into one dist/; without this the sanitizer pack would ship the Pack
    // Generator's ~30 MB of chunks it can never load (Hard Rule 25).
    if (pruneAssets) {
      const { kept, removed } = await pruneStaticToEntry(staticDir);
      // eslint-disable-next-line no-console
      console.log(`Pruned ${removed} unreferenced asset(s); kept ${kept.length}: ${kept.join(', ')}`);
    }
  }

  if (proxiesPath && (await pathExists(proxiesPath))) {
    await cp(proxiesPath, join(buildDir, 'default', 'proxies.yml'));
  }

  if (policiesPath && (await pathExists(policiesPath))) {
    await cp(policiesPath, join(buildDir, 'default', 'policies.yml'));
  }

  if (backendPath && (await pathExists(backendPath))) {
    await bundleBackendFunctions(backendPath, rootDir, buildDir);
  }

  // Marketplace review-readiness metadata shipped at the pack root: the reviewer/store
  // renders README.md, honours LICENSE, and shows the logo. The packager only lifts
  // whitelisted manifest fields (below), so these must be copied as real files.
  if (readmePath && (await pathExists(readmePath))) {
    await cp(readmePath, join(buildDir, 'README.md'));
  }
  if (licensePath && (await pathExists(licensePath))) {
    await cp(licensePath, join(buildDir, 'LICENSE'));
  }
  if (logoPath && (await pathExists(logoPath))) {
    const ext = extname(logoPath).toLowerCase() || '.png';
    await cp(logoPath, join(buildDir, `logo${ext}`));
  }

  const packageInfo = Object.fromEntries(
    ['name', 'version', 'displayName', 'description', 'author', 'license', 'tags', 'cribl']
      .filter((k) => rootPackageJson?.[k])
      .map((k) => [k, rootPackageJson[k]])
  );
  packageInfo.cribl = {
    ...(packageInfo.cribl ?? {}),
    createAppScriptVersion: CRIBL_CREATE_APP_SCRIPT_VERSION,
  };

  if (dev && packageInfo.name) {
    packageInfo.name = `__dev__${packageInfo.name}`;
    packageInfo.displayName = `__dev__${packageInfo.displayName || packageInfo.name}`;
  }

  await writeFile(
    join(buildDir, 'package.json'),
    JSON.stringify(packageInfo, null, 2)
  );

  const child = spawn(
    'tar',
    ['-czf', '-', '-C', 'package-build', '.'],
    {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const closePromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (/** @type {Error | null} */ err) => {
      if (settled) return;
      settled = true;
      try {
        await rm(buildDir, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    child.once('error', (err) => {
      child.stdout.destroy(err);
      void finish(err);
    });

    child.once('close', (code) => {
      if (code !== 0) {
        void finish(new Error(`tar exited with code ${code}`));
        return;
      }
      void finish(null);
    });
  });

  return { closePromise, stdout: child.stdout };
}

/**
 * HTTP handler: full build + pack stream, or dev pack (skip build) when `?dev=true`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root - project root (npm cwd)
 */
export async function servePackageTgz(req, res, root) {
  if (packageInProgress) {
    res.statusCode = 503;
    res.setHeader('Retry-After', '30');
    res.setHeader('Content-Type', 'text/plain');
    res.end('Package build in progress. Retry in 30 seconds.');
    return;
  }
  packageInProgress = true;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const dev = url.searchParams.get('dev') === 'true';

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const baseName = pkg.name ?? 'plugin';
    const version = pkg.version ?? '0.0.0';
    const tgzBase = dev && pkg.name ? `__dev__${pkg.name}` : baseName;
    const tgzName = `${tgzBase}-${version}.tgz`;

    if (!dev) {
      const distExists = await pathExists(join(root, 'dist', 'index.html'));
      if (!distExists) {
        await runNpmBuild(root);
      }
    }

    const { closePromise, stdout } = await createAppPack(dev);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${tgzName}"`);

    await Promise.all([pipeline(stdout, res), closePromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`Package failed: ${message}`);
    } else if (!res.writableEnded) {
      res.destroy();
    }
  } finally {
    packageInProgress = false;
  }
}
