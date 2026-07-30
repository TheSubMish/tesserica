/**
 * Build-time step: fetch the bundled `u2netp.onnx` segmentation model into
 * the gitignored `assets/models/` directory.
 *
 *     npm run models:fetch
 *
 * Per `docs/08-roadmap.md` Phase 5 ("Bundle `u2netp`; on-demand download for
 * larger models with explicit consent"), the model binary is **not**
 * committed to git — this script is the one explicit step a fresh checkout
 * needs to run before offline background removal works
 * (`docs/07-tech-stack.md` §8, `assets/models/README.md`).
 *
 * Idempotent: running it again with the file already present and correct is
 * a no-op. Requires network access — this is a developer/build-time action,
 * never something the shipped app does on its own (`CLAUDE.md` "No network
 * calls in the core").
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assetsModelsDir,
  ensureModelFetched,
  ModelFetchError,
  U2NETP_SPEC,
} from './lib/modelFetch.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const destDir = assetsModelsDir(projectRoot);

async function main() {
  console.log(`Fetching ${U2NETP_SPEC.id} (${U2NETP_SPEC.license}) from:`);
  console.log(`  ${U2NETP_SPEC.url}`);
  console.log(`into ${destDir} ...`);

  const outcome = await ensureModelFetched(U2NETP_SPEC, destDir, fetch);

  if (outcome.kind === 'skipped-already-present') {
    console.log(`Already present and checksum-verified at ${outcome.path} — nothing to do.`);
  } else {
    console.log(`Downloaded and checksum-verified: ${outcome.path} (${outcome.bytes} bytes).`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ModelFetchError) {
    console.error(`\nfetch-model failed: ${err.message}\n`);
  } else {
    console.error('\nfetch-model failed with an unexpected error:', err, '\n');
  }
  process.exitCode = 1;
});
