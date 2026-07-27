/// <reference lib="webworker" />

/**
 * The conversion preview worker (`docs/02-architecture.md` §8).
 *
 * Deliberately almost empty: everything interesting is in `core.ts`, which has
 * no `self` and is therefore testable without a worker at all. This file exists
 * to be the thing Vite bundles as a worker entry point.
 */

import { PreviewCore } from './core.ts';
import type { PreviewRequest } from './protocol.ts';

const core = new PreviewCore();

self.onmessage = (event: MessageEvent<PreviewRequest>): void => {
  const outgoing = core.handle(event.data);
  if (!outgoing) return;
  (self as unknown as Worker).postMessage(outgoing.response, outgoing.transfer as Transferable[]);
};
