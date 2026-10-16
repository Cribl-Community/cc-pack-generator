/**
 * Materialize the Cribl App Platform pack layout at the repo root for Git-based
 * installs: `static/` (from `dist/`) and `default/` (proxies, policies and the
 * bundled Backend Functions). Run after `npm run build`; the Cribl-Community
 * release workflow commits the output onto the release tag so "Import from Git"
 * can serve it.
 *
 * Usage: node scripts/prepare-git-pack.mjs [--version X.Y.Z]
 * (`--version` is accepted for the org's release workflow; `npm run package`
 * has already written the version into package.json.)
 */
import { prepareGitPackLayout } from './pkgutil.mjs';

await prepareGitPackLayout();
console.log('Git pack layout ready: static/, default/');
