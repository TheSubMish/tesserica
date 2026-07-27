/**
 * Drag-and-drop of a source image (`docs/05-ui-design.md` §3: "Drop target is
 * the entire window when no image is loaded").
 *
 * Tauri delivers *file paths*, not `File` objects — the WebView never reads the
 * bytes. That fits the handle model exactly (`docs/02-architecture.md` §6.2):
 * the path goes straight to `open_source`, Rust decodes and keeps the image, and
 * the frontend gets a `SourceId` plus a proxy. Dropping a 12 MP photo therefore
 * costs the same as picking one from the dialog.
 *
 * The path-selection logic is pure and lives here so it can be tested without a
 * WebView; only {@link listenForImageDrop} touches Tauri.
 */

import { getCurrentWebview } from '@tauri-apps/api/webview';

import { hasBackend } from '../ipc/commands';

/**
 * Extensions the Rust decoder is actually built for.
 *
 * Kept in step with `src-tauri/Cargo.toml`'s `image` features (`png`, `jpeg`)
 * and with the file dialog's filter in `src/app/project.ts`. Accepting a `.webp`
 * here would produce a decode error at the far end instead of an honest refusal
 * at the near one.
 */
export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const;

/** Case-insensitive, because `PHOTO.PNG` is the same file as `photo.png`. */
export function isSupportedImage(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const extension = path.slice(dot + 1).toLowerCase();
  return (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * The first droppable image in a drop payload, or `undefined`.
 *
 * A drop can carry several files — Convert mode holds one source at a time, so
 * taking the first supported one is the only behaviour that does not silently
 * discard the user's intent *and* does not need a picker on top of a drop. A
 * drop of nothing but unsupported files returns `undefined` so the caller can
 * say why rather than doing nothing.
 */
export function firstImagePath(paths: readonly string[]): string | undefined {
  return paths.find(isSupportedImage);
}

export interface DropHandlers {
  /** A drag carrying at least one supported image entered the window. */
  readonly onDragOver: () => void;
  /** The drag left, or the drop finished. */
  readonly onDragLeave: () => void;
  /** A supported image was dropped. */
  readonly onDrop: (path: string) => void;
  /** A drop happened but carried nothing we can open. */
  readonly onUnsupported: (paths: readonly string[]) => void;
}

/**
 * Listen for file drops on the whole window.
 *
 * Returns a promise for an unlisten function. Outside the Tauri shell there is
 * nothing to listen to, so it resolves to a no-op rather than throwing — the
 * browser dev server should still render.
 */
export async function listenForImageDrop(handlers: DropHandlers): Promise<() => void> {
  if (!hasBackend()) return () => {};

  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    switch (payload.type) {
      case 'enter':
        // Only light up for something we can actually accept; highlighting for
        // a dragged text file promises an outcome that will not happen.
        if (firstImagePath(payload.paths)) handlers.onDragOver();
        break;

      case 'leave':
        handlers.onDragLeave();
        break;

      case 'drop': {
        handlers.onDragLeave();
        const path = firstImagePath(payload.paths);
        if (path) handlers.onDrop(path);
        else handlers.onUnsupported(payload.paths);
        break;
      }

      // 'over' fires continuously while the pointer moves; the highlight is
      // already on from 'enter', so reacting again would only cause churn.
      default:
        break;
    }
  });
}
