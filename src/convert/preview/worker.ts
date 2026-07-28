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

// If Vite's worker HMR re-executes this module in place, `core` above is
// recreated with an empty proxy map while the main thread — unaware anything
// happened — keeps posting jobs against the id it already registered. That
// mismatch is exactly `previewRuntime.ts`'s `recoverProxy` exists for, but
// invalidating here means the worker itself is torn down and recreated
// cleanly instead of silently forgetting its state in place, so the two sides
// cannot diverge to begin with.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate('the preview worker cannot be hot-swapped in place');
  });
}
