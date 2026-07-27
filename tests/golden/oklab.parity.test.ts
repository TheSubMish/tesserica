import { beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { srgb8ToOklab } from '../../src/pipeline/oklab.ts';
import { SOURCES } from './corpus.ts';
import {
  ACTUAL_DIR,
  assertCorpusIsCurrent,
  jobsForAllSources,
  readOklabPayload,
  readSource,
  runRust,
  type JobReport,
} from './runner.ts';

/**
 * The first parity check: Oklab, over the whole corpus, in both languages.
 *
 * This is D12's measurement turned into a standing test. D12 established, over
 * a 4,096-sample grid, that Rust `f64` and JS `f64` agree to 6.661e-16 but are
 * *not* bit-identical, because `cbrt` and `powf` come from different libms.
 * That is the number the whole parity guarantee is built on, so it is checked
 * on every run rather than trusted from a one-off experiment.
 *
 * The bound asserted is 1e-12 — six orders of magnitude above the observed
 * residual, and three below the 1e-9 nearest-colour tie-break that has to
 * absorb it. A regression that mattered (someone reintroducing `f32`, at
 * 3.6e-7) would blow through it by five orders of magnitude.
 */
describe('Oklab parity: TypeScript vs Rust', () => {
  let reports: JobReport[];
  const worst = new Map<string, number>();
  let bitIdentical = 0;
  let total = 0;

  beforeAll(() => {
    assertCorpusIsCurrent();
    reports = [
      ...runRust(jobsForAllSources('sourceIntegrity')),
      ...runRust(jobsForAllSources('oklab')),
    ];
  }, 600_000);

  it('every Rust job succeeded', () => {
    const failures = reports.filter((r) => !r.ok);
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
  });

  it('the committed .png review copies decode to the .rgba the pipeline reads', () => {
    const integrity = reports.filter((r) => r.kind === 'sourceIntegrity');
    expect(integrity).toHaveLength(SOURCES.length);
    expect(integrity.every((r) => r.ok)).toBe(true);
  });

  for (const source of SOURCES) {
    it(`${source.name} — every pixel agrees within 1e-12`, () => {
      const pixels = readSource(source);
      const rust = readOklabPayload(`oklab/${source.name}`);
      expect(rust.length).toBe(source.width * source.height * 3);

      let maxDiff = 0;
      let maxAt = -1;
      for (let p = 0, i = 0; i < pixels.length; p += 3, i += 4) {
        const ts = srgb8ToOklab(pixels[i], pixels[i + 1], pixels[i + 2]);
        const dl = Math.abs(ts.l - rust[p]);
        const da = Math.abs(ts.a - rust[p + 1]);
        const db = Math.abs(ts.b - rust[p + 2]);
        const d = Math.max(dl, da, db);
        if (d > maxDiff) {
          maxDiff = d;
          maxAt = i / 4;
        }
        if (dl === 0 && da === 0 && db === 0) bitIdentical++;
        total++;
      }

      worst.set(source.name, maxDiff);
      expect(
        maxDiff,
        `worst divergence ${maxDiff} at pixel ${maxAt} of ${source.name}`,
      ).toBeLessThan(1e-12);
    });
  }

  it('records the measurement and confirms bit-identity is not achievable', () => {
    const rate = bitIdentical / total;
    const summary = {
      note:
        'Measured by tests/golden/oklab.parity.test.ts. The bound asserted is 1e-12; ' +
        'D12 records the original 4,096-sample experiment.',
      pixelsCompared: total,
      bitIdenticalRate: rate,
      maxAbsDivergenceBySource: Object.fromEntries(worst),
      maxAbsDivergence: Math.max(...worst.values()),
    };
    writeFileSync(join(ACTUAL_DIR, 'oklab-parity.json'), `${JSON.stringify(summary, null, 2)}\n`);

    // The point of D12: identical constants do not buy identical floats, so
    // parity is defined on palette indices instead. If this ever became 1.0 the
    // reasoning behind D12 would need revisiting — so assert it, rather than
    // leaving the claim in a document nobody re-checks.
    expect(rate).toBeLessThan(1);
    expect(rate).toBeGreaterThan(0.5);
  });
});
