/**
 * Where Convert mode's pixels actually live — **outside React**.
 *
 * The store (`src/state/convertStore.ts`) holds numbers and enums; the source
 * proxy and the latest preview result are `ImageData` kept here, in a module
 * singleton, and components learn about them through a subscription that carries
 * a version counter rather than the buffers themselves.
 *
 * That is the data-model rule (`docs/03-data-model.md`: keep pixel data out of
 * React state) applied to the preview path: putting a 4 MB buffer in a zustand
 * slice would make every slider tick clone-compare it.
 */

import { bufferFrom, type PixelBuffer } from '../pipeline/buffer.ts';
import type { ConvertSettings } from '../pipeline/settings.ts';
import { PreviewSession } from './preview/session.ts';
import type { PreviewResult } from './preview/scheduler.ts';

export interface PreviewFrames {
  /** The proxy, as the pipeline saw it. Drawn as the "before" image. */
  readonly source: ImageData | undefined;
  /** The converted result. Drawn as the "after" image. */
  readonly result: ImageData | undefined;
  /** Bumped whenever either changes, so subscribers can cheaply diff. */
  readonly version: number;
}

type Listener = (frames: PreviewFrames) => void;

export interface PreviewRuntimeHooks {
  readonly onMeta: (meta: {
    width: number;
    height: number;
    colorsUsed: number;
    elapsedMs: number;
  }) => void;
  readonly onError: (message: string) => void;
  readonly onBusyChange: (busy: boolean) => void;
}

class PreviewRuntime {
  private session: PreviewSession | undefined;
  private hooks: PreviewRuntimeHooks | undefined;
  private listeners = new Set<Listener>();

  private frames: PreviewFrames = { source: undefined, result: undefined, version: 0 };

  get current(): PreviewFrames {
    return this.frames;
  }

  /** True when the preview is approximate because the source was large. */
  get isProxy(): boolean {
    return this.session?.isProxy ?? false;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(hooks: PreviewRuntimeHooks): void {
    this.hooks = hooks;
    this.session ??= new PreviewSession({
      onResult: (result) => this.acceptResult(result),
      onError: (message) => this.hooks?.onError(message),
      onBusyChange: (busy) => this.hooks?.onBusyChange(busy),
      onMissingProxy: () => this.recoverProxy(),
    });
  }

  /**
   * Rebuild a proxy from the "before" image this runtime already keeps, for
   * `PreviewScheduler`'s one-shot recovery.
   *
   * That image is a genuine independent copy, not the buffer that was handed
   * to the worker — `setSource` below transfers the buffer it sends, which
   * detaches it on this side, so re-deriving from `frames.source` is the only
   * pixel data left to recover with. In production this is never called: the
   * worker and this runtime are created together and never lose track of each
   * other. It exists for Vite's dev-mode hot reload, which can re-evaluate the
   * worker's module graph independently of the page (`session.ts`).
   */
  private recoverProxy(): PixelBuffer | undefined {
    const source = this.frames.source;
    if (!source) return undefined;
    if (import.meta.env.DEV) {
      // Deliberately visible: this only fires from a dev-mode hiccup and is
      // worth knowing happened.
      console.warn(
        '[preview] worker lost its proxy (likely a hot-reload artifact) — recovering automatically',
      );
    }
    return bufferFrom(source.width, source.height, new Uint8ClampedArray(source.data));
  }

  /**
   * Point the runtime at a source.
   *
   * The buffer is handed to the session, which transfers it to the worker — so
   * a copy is kept here first for the "before" image. That copy is the only
   * duplicate, and it is at proxy resolution, not source resolution.
   */
  setSource(source: PixelBuffer): void {
    if (!this.session) throw new Error('previewRuntime.start must be called first');

    const before = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    this.session.setSource(bufferFrom(source.width, source.height, source.data));

    // The session may have downscaled internally; what the user compares
    // against is the source as supplied, which is what `before` holds.
    this.publish({ source: before, result: undefined });
  }

  request(settings: ConvertSettings): void {
    this.session?.request(settings);
  }

  clear(): void {
    this.publish({ source: undefined, result: undefined });
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
    this.listeners.clear();
    this.frames = { source: undefined, result: undefined, version: 0 };
  }

  private acceptResult(result: PreviewResult): void {
    this.publish({
      source: this.frames.source,
      result: new ImageData(result.data, result.width, result.height),
    });
    this.hooks?.onMeta({
      width: result.width,
      height: result.height,
      colorsUsed: result.colorsUsed,
      elapsedMs: result.elapsedMs,
    });
  }

  private publish(next: Omit<PreviewFrames, 'version'>): void {
    this.frames = { ...next, version: this.frames.version + 1 };
    for (const listener of this.listeners) listener(this.frames);
  }
}

export const previewRuntime = new PreviewRuntime();
