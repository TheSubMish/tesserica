import { describe, it } from 'vitest';

/**
 * Cross-implementation parity suite — the harness itself lands in Phase 2,
 * alongside the first pipeline stage rather than after it
 * (docs/04-image-pipeline.md §11, docs/08-roadmap.md Phase 2).
 *
 * This file exists so `npm run test:golden` is wired and runnable from Phase 0
 * onward. It reports todos, never passes — there is nothing to compare until a
 * pipeline stage exists in both languages.
 */
describe('golden parity corpus', () => {
  it.todo('non-dithered modes match the Rust implementation byte for byte');
  it.todo('dithered modes match structurally within tolerance');
});
