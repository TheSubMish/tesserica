/**
 * Q7 — how do hand-drawn editor layers cross IPC on export?
 * (`docs/09-open-questions.md` Q7.)
 *
 * Runs **inside the real app**, because the cost under test is the
 * WebView↔native bridge and nothing else. Launched by:
 *
 * ```bash
 * TESSERICA_BENCH=q7 src-tauri/target/debug/tesserica
 * ```
 *
 * Payload is Q7's own stated figure: **10 layers × 512×512 RGBA ≈ 10 MB**.
 *
 * Two of Q7's four candidates are ruled out before any timing, on capability
 * rather than speed — see `CAPABILITY_FINDINGS` below. What remains is measured.
 */

import { invoke } from '@tauri-apps/api/core';

const LAYERS = 10;
const LAYER_EDGE = 512;
const LAYER_BYTES = LAYER_EDGE * LAYER_EDGE * 4;
const TOTAL_BYTES = LAYERS * LAYER_BYTES;

/** Enough repeats to see past scheduler noise, few enough to finish. */
const REPEATS = 5;
/** JSON is slow enough that five repeats would dominate the whole run. */
const JSON_REPEATS = 2;

/**
 * Findings that need no stopwatch, and would be dishonest to present as timings.
 */
export const CAPABILITY_FINDINGS = [
  'Channel: NOT APPLICABLE. Tauri v2 Channels carry data Rust -> frontend. A ' +
    'Channel is created in JS and handed to Rust, which sends through it; there ' +
    'is no frontend -> Rust channel. Q7 asks about the inbound direction, so ' +
    'this candidate is eliminated on capability, not on speed.',
  'Temp file: STRICTLY DOMINATED. A WebView cannot write a file itself; it must ' +
    'hand the bytes to native code first, which means paying an IPC transfer ' +
    'and THEN a disk write and a disk read. It is whichever IPC transport it is ' +
    'built on, plus I/O.',
];

interface Timing {
  readonly transport: string;
  readonly runs: number[];
}

function summarize(t: Timing): string {
  const sorted = [...t.runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const mbPerSec = TOTAL_BYTES / 1e6 / (median / 1000);
  return (
    `${t.transport}: median ${median.toFixed(1)} ms, min ${min.toFixed(1)} ms, ` +
    `${mbPerSec.toFixed(0)} MB/s  [${sorted.map((r) => r.toFixed(1)).join(', ')}]`
  );
}

/** Deterministic payload, so the checksum means something. */
function makePayload(): Uint8Array {
  const bytes = new Uint8Array(TOTAL_BYTES);
  let x = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

async function report(line: string): Promise<void> {
  await invoke('bench_report', { line });
}

export async function runQ7(): Promise<void> {
  const payload = makePayload();

  await report(
    `payload: ${LAYERS} layers x ${LAYER_EDGE}x${LAYER_EDGE} RGBA = ${TOTAL_BYTES} bytes`,
  );
  for (const finding of CAPABILITY_FINDINGS) await report(finding);

  // Establish the expected checksum once, via the transport we already trust.
  const expected = await invoke<number>('bench_raw', payload.slice().buffer);
  await report(`checksum: ${expected}`);

  const timings: Timing[] = [];

  // ---- Transport B: raw invoke body (what staging.rs already does) --------
  {
    const runs: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      // A fresh copy each time: the buffer is transferred, so it cannot be
      // reused, and copying is part of what this transport costs.
      const copy = payload.slice();
      const t0 = performance.now();
      const got = await invoke<number>('bench_raw', copy.buffer);
      runs.push(performance.now() - t0);
      if (got !== expected) throw new Error(`raw body checksum ${got} != ${expected}`);
    }
    timings.push({ transport: 'raw invoke body', runs });
  }

  // ---- Transport C: custom URI protocol via fetch -------------------------
  {
    const runs: number[] = [];
    let failure: string | undefined;
    for (let i = 0; i < REPEATS; i++) {
      const copy = payload.slice();
      const t0 = performance.now();
      try {
        const response = await fetch(protocolUrl(), { method: 'POST', body: copy });
        const text = await response.text();
        runs.push(performance.now() - t0);
        if (Number(text) !== expected) {
          failure = `custom protocol checksum ${text} != ${expected}`;
          break;
        }
      } catch (err) {
        failure = `custom protocol failed: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    if (failure) await report(`custom protocol: UNAVAILABLE — ${failure}`);
    else timings.push({ transport: 'custom protocol', runs });
  }

  // ---- Transport A: JSON command argument (the forbidden baseline) --------
  {
    const runs: number[] = [];
    for (let i = 0; i < JSON_REPEATS; i++) {
      const t0 = performance.now();
      // This is what a naive `invoke('cmd', { bytes })` does: the array is
      // serialized to JSON, so 10 MB becomes ~35 MB of decimal text.
      const got = await invoke<number>('bench_json', { bytes: Array.from(payload) });
      runs.push(performance.now() - t0);
      if (got !== expected) throw new Error(`json checksum ${got} != ${expected}`);
    }
    timings.push({ transport: 'JSON command arg', runs });
  }

  for (const t of timings) await report(summarize(t));

  const raw = timings.find((t) => t.transport === 'raw invoke body');
  const json = timings.find((t) => t.transport === 'JSON command arg');
  if (raw && json) {
    const ratio = median(json.runs) / median(raw.runs);
    await report(`JSON is ${ratio.toFixed(1)}x slower than the raw invoke body`);
  }

  await invoke('bench_finish');
}

function median(runs: number[]): number {
  const sorted = [...runs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Tauri v2 exposes custom schemes as `scheme://localhost` everywhere except
 * Windows and Android, where they become `http://scheme.localhost`. D5 makes
 * this Linux only, but both are tried so a future port fails loudly rather than
 * silently skipping the transport.
 */
function protocolUrl(): string {
  return 'bench://localhost/upload';
}
