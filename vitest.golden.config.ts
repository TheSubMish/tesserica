import { defineConfig } from 'vitest/config';

/**
 * Cross-implementation parity suite (docs/04-image-pipeline.md §11).
 *
 * Separate from `vitest.config.ts` on purpose: this run compares the TS
 * pipeline against the Rust one, so it is slow and has a native build as a
 * prerequisite. Node environment — there is no DOM involved.
 *
 * The timeouts are generous because a cold `cargo run --example golden` has to
 * build the Rust half first, which can take minutes. That is not a hang.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/golden/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // The suite shells out to one cargo build; running files in parallel would
    // just make several processes contend for the same target directory lock.
    fileParallelism: false,
  },
});
