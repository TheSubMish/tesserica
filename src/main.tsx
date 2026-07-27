import React from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { App } from './app/App';
import './styles/global.css';

/**
 * `TESSERICA_BENCH=q7` starts the app in benchmark mode instead of rendering it
 * (`docs/09-open-questions.md` Q7). The benchmark has to run inside the real
 * WebView, because the WebView↔native bridge is the entire thing being measured.
 *
 * `bench_mode` only exists in debug builds, so a release bundle takes the
 * `catch` and renders normally.
 */
async function benchMode(): Promise<string | undefined> {
  try {
    return (await invoke<string | null>('bench_mode')) ?? undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if ((await benchMode()) === 'q7') {
    const { runQ7 } = await import('./bench/q7.ts');
    await runQ7();
    return;
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void main();
