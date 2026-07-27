import { beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bufferFrom } from '../../src/pipeline/buffer.ts';
import { convert, type ConvertResult } from '../../src/pipeline/convert.ts';
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
  type RustConvertResult,
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
 * **Dithered modes are held to the same standard here**, and that is stricter
 * than §11's "structural comparison" on purpose. §11's caveat exists because
 * error diffusion is *resolution*-dependent, and preview runs on a proxy while
 * export runs on the original. Inside this harness both implementations get the
 * same bytes at the same size, so the algorithms are fully deterministic and an
 * exact match is a promise they can keep. The genuinely resolution-dependent
 * comparison is `dither.structural.test.ts`.
 *
 * The rendered RGBA is compared too. Identical indices with different RGBA would
 * mean the alpha policy or the palette rendering had diverged, which the index
 * map alone cannot catch.
 */
describe('convert parity: TypeScript vs Rust', () => {
  const cases: MatrixCase[] = [...matrixCases(), ...edgeCases()];
  let reports = new Map<string, JobReport>();
  const ts = new Map<string, ConvertResult>();
  const rust = new Map<string, RustConvertResult>();

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

    // Computed once and shared: the TS pipeline is the slow half of this suite,
    // and each assertion below wants the same results.
    for (const c of cases) {
      const source = readSource(c.source);
      ts.set(c.id, convert(bufferFrom(c.source.width, c.source.height, source), c.settings));
      rust.set(c.id, readConvertPayload(c.id));
    }
  }, 1_800_000);

  it('runs a matrix wide enough to be worth trusting', () => {
    // Breadth is the point: a divergence that only one palette, one downscale
    // mode or one dither mode provokes is exactly what this suite is for.
    expect(cases.length).toBeGreaterThan(3000);
  });

  it('every Rust job succeeded', () => {
    const failures = [...reports.values()].filter((r) => !r.ok);
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
  });

  it('index maps are identical in every case', () => {
    const mismatches: string[] = [];
    let comparedPixels = 0;

    for (const c of cases) {
      const a = ts.get(c.id) as ConvertResult;
      const b = rust.get(c.id) as RustConvertResult;

      if (a.image.width !== b.width || a.image.height !== b.height) {
        mismatches.push(
          `${c.id}: size ${a.image.width}x${a.image.height} vs ${b.width}x${b.height}`,
        );
        continue;
      }

      let differing = 0;
      let firstAt = -1;
      for (let p = 0; p < a.indices.length; p++) {
        if (a.indices[p] !== b.indices[p]) {
          if (firstAt < 0) firstAt = p;
          differing++;
        }
      }
      comparedPixels += a.indices.length;

      if (differing > 0) {
        mismatches.push(
          `${c.id}: ${differing}/${a.indices.length} indices differ, first at pixel ${firstAt} ` +
            `(ts=${a.indices[firstAt]}, rust=${b.indices[firstAt]})`,
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
      const a = ts.get(c.id) as ConvertResult;
      const b = rust.get(c.id) as RustConvertResult;
      if (a.image.data.length !== b.rgba.length) {
        mismatches.push(`${c.id}: rgba length differs`);
        continue;
      }
      for (let i = 0; i < a.image.data.length; i++) {
        if (a.image.data[i] !== b.rgba[i]) {
          mismatches.push(`${c.id}: byte ${i} differs (ts=${a.image.data[i]}, rust=${b.rgba[i]})`);
          break;
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
