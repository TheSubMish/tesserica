import { defineConfig } from 'vitest/config';

/**
 * Cross-implementation parity suite (docs/04-image-pipeline.md §11).
 *
 * Separate from `vitest.config.ts` on purpose: this run compares the TS
 * pipeline against the Rust one, so it is slow and has a native build as a
 * prerequisite. Node environment — there is no DOM involved.
 *
 * The suite itself lands in Phase 2 alongside the first pipeline stage, not
 * after it (docs/08-roadmap.md Phase 2).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/golden/**/*.test.ts'],
  },
});
