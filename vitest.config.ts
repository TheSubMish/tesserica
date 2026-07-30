import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the frontend and the TS half of the image pipeline
 * (docs/07-tech-stack.md §5).
 *
 * The cross-implementation golden suite is deliberately a *separate* run —
 * `vitest.golden.config.ts` — because it is slow, it shells out to the Rust
 * binary, and it must be possible to run it alone in CI.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    restoreMocks: true,
  },
});
