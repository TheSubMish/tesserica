import { beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bufferFrom } from '../../src/pipeline/buffer.ts';
import { convert } from '../../src/pipeline/convert.ts';
import { edgeCases, matrixCases, type MatrixCase } from './matrix.ts';
import {
  ACTUAL_DIR,
  SOURCES_DIR,
  assertCorpusIsCurrent,
  readConvertPayload,
  readSource,
  runRust,
  type Job,
  type JobReport,
} from './runner.ts';

/**
 * **The test this project exists to have.**
 *
 * Every case runs the whole pipeline in both languages on identical input bytes
 * and asserts the two index maps are equal element for element. That is what
 * "exact match" means for non-dithered modes (D12, `docs/04` §11.1) — not equal
 * floats, which are unachievable across libms, but equal *palette indices*,
 * which are what the user sees.
 *
 * The rendered RGBA is compared too. Identical indices with different RGBA would
 * mean the alpha policy or the palette rendering had diverged, which the index
 * map alone cannot catch.
 */
describe('convert parity: TypeScript vs Rust', () => {
  const cases: MatrixCase[] = [...matrixCases(), ...edgeCases()];
  let reports = new Map<string, JobReport>();

  beforeAll(() => {
    assertCorpusIsCurrent();
    const jobs: Job[] = cases.map((c) => ({
      id: c.id,
      kind: 'convert',
      rgba: join(SOURCES_DIR, `${c.source.name}.rgba`),
      width: c.source.width,
      height: c.source.height,
      settings: c.settings,
    }));
    reports = new Map(runRust(jobs).map((r) => [r.id, r]));
  }, 900_000);

  it('runs a matrix wide enough to be worth trusting', () => {
    // Breadth is the point: a divergence that only one palette or one downscale
    // mode provokes is exactly the kind this suite exists to find.
    expect(cases.length).toBeGreaterThan(400);
  });

  it('every Rust job succeeded', () => {
    const failures = [...reports.values()].filter((r) => !r.ok);
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
  });

  it('index maps are identical in every case', () => {
    const mismatches: string[] = [];
    let comparedPixels = 0;

    for (const c of cases) {
      const source = readSource(c.source);
      const ts = convert(bufferFrom(c.source.width, c.source.height, source), c.settings);
      const rust = readConvertPayload(c.id);

      if (ts.image.width !== rust.width || ts.image.height !== rust.height) {
        mismatches.push(
          `${c.id}: size ${ts.image.width}x${ts.image.height} vs ${rust.width}x${rust.height}`,
        );
        continue;
      }

      let differing = 0;
      let firstAt = -1;
      for (let p = 0; p < ts.indices.length; p++) {
        if (ts.indices[p] !== rust.indices[p]) {
          if (firstAt < 0) firstAt = p;
          differing++;
        }
      }
      comparedPixels += ts.indices.length;

      if (differing > 0) {
        mismatches.push(
          `${c.id}: ${differing}/${ts.indices.length} indices differ, first at pixel ${firstAt} ` +
            `(ts=${ts.indices[firstAt]}, rust=${rust.indices[firstAt]})`,
        );
      }
    }

    writeFileSync(
      join(ACTUAL_DIR, 'convert-parity.json'),
      `${JSON.stringify({ cases: cases.length, comparedPixels, mismatches }, null, 2)}\n`,
    );

    expect(mismatches).toEqual([]);
  });

  it('rendered RGBA is identical in every case', () => {
    const mismatches: string[] = [];

    for (const c of cases) {
      const source = readSource(c.source);
      const ts = convert(bufferFrom(c.source.width, c.source.height, source), c.settings);
      const rust = readConvertPayload(c.id);
      if (ts.image.data.length !== rust.rgba.length) {
        mismatches.push(`${c.id}: rgba length differs`);
        continue;
      }
      for (let i = 0; i < ts.image.data.length; i++) {
        if (ts.image.data[i] !== rust.rgba[i]) {
          mismatches.push(
            `${c.id}: byte ${i} differs (ts=${ts.image.data[i]}, rust=${rust.rgba[i]})`,
          );
          break;
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
