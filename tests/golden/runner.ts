/**
 * Harness plumbing for the cross-implementation parity suite
 * (`docs/04-image-pipeline.md` §11).
 *
 * The shape of the thing: the TS pipeline runs in this process, the Rust
 * pipeline runs as `cargo run --example golden`, both read the *same raw RGBA
 * bytes* from `sources/`, and the comparison happens here.
 *
 * Adding a pipeline stage means adding a job `kind` in **both**
 * `src-tauri/examples/golden.rs` and this file — never one without the other.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCES, type GoldenSource } from './corpus.ts';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SOURCES_DIR = join(REPO_ROOT, 'tests', 'golden', 'sources');
export const ACTUAL_DIR = join(REPO_ROOT, 'tests', 'golden', 'actual');

export interface Job {
  readonly id: string;
  readonly kind: 'sourceIntegrity' | 'oklab';
  readonly rgba: string;
  readonly png?: string;
  readonly width: number;
  readonly height: number;
}

export interface JobReport {
  readonly id: string;
  readonly kind: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** Raw straight-alpha RGBA for a committed source, exactly as Rust reads it. */
export function readSource(source: GoldenSource): Uint8ClampedArray {
  const bytes = readFileSync(join(SOURCES_DIR, `${source.name}.rgba`));
  const expected = source.width * source.height * 4;
  if (bytes.length !== expected) {
    throw new Error(
      `${source.name}.rgba is ${bytes.length} bytes, expected ${expected}. ` +
        `Run \`npm run golden:corpus\`.`,
    );
  }
  return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length);
}

/**
 * The committed `.rgba` must still be what `corpus.ts` renders.
 *
 * Without this, editing a renderer and forgetting to regenerate would leave the
 * suite silently testing a stale corpus.
 */
export function assertCorpusIsCurrent(): void {
  for (const source of SOURCES) {
    const committed = readSource(source);
    const rendered = source.render(source.width, source.height);
    for (let i = 0; i < committed.length; i++) {
      if (committed[i] !== rendered[i]) {
        throw new Error(
          `tests/golden/sources/${source.name}.rgba is stale (first difference at byte ${i}). ` +
            `Run \`npm run golden:corpus\`.`,
        );
      }
    }
  }
}

export function jobsForAllSources(kind: Job['kind']): Job[] {
  return SOURCES.map((s) => ({
    id: `${kind}/${s.name}`,
    kind,
    rgba: join(SOURCES_DIR, `${s.name}.rgba`),
    png: join(SOURCES_DIR, `${s.name}.png`),
    width: s.width,
    height: s.height,
  }));
}

/**
 * Run the Rust half.
 *
 * Throws with the runner's own stderr attached on failure — a parity suite that
 * says only "exit code 1" is a parity suite nobody will debug.
 */
export function runRust(jobs: readonly Job[]): JobReport[] {
  mkdirSync(ACTUAL_DIR, { recursive: true });
  const jobFile = join(ACTUAL_DIR, 'jobs.json');
  writeFileSync(jobFile, `${JSON.stringify({ outDir: ACTUAL_DIR, jobs }, null, 2)}\n`);

  try {
    execFileSync(
      'cargo',
      [
        'run',
        '--quiet',
        '--manifest-path',
        join(REPO_ROOT, 'src-tauri', 'Cargo.toml'),
        '--example',
        'golden',
        '--',
        jobFile,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new Error(
      `cargo run --example golden failed\n${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}`,
      { cause: err },
    );
  }

  const report = JSON.parse(readFileSync(join(ACTUAL_DIR, 'report.json'), 'utf8')) as {
    jobs: JobReport[];
  };
  return report.jobs;
}

/** A Rust `oklab` job payload: little-endian `f64` triples, one per pixel. */
export function readOklabPayload(id: string): Float64Array {
  const bytes = readFileSync(join(ACTUAL_DIR, `${id}.bin`));
  if (bytes.byteLength % 24 !== 0) {
    throw new Error(`${id}.bin is ${bytes.byteLength} bytes, not a whole number of f64 triples`);
  }
  // Little-endian is assumed and is correct on every platform the project
  // targets (D5: Linux/x86_64 and aarch64 are both LE). A big-endian host would
  // need a byte swap here; noted rather than handled, since one does not exist
  // in the support matrix.
  return new Float64Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}
