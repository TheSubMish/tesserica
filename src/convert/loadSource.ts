/**
 * Opening a source image into Convert mode.
 *
 * Rust decodes the file and **keeps** it (`docs/02-architecture.md` §6.2); the
 * frontend receives a `SourceId` and a proxy of at most
 * {@link PREVIEW_PROXY_MAX_EDGE} px on the long edge. The full-resolution pixels
 * never enter the WebView, which is what makes a 12 MP photo cost the same in
 * the UI as a thumbnail.
 *
 * Separate from `ConvertMode.tsx` because that file may only export components.
 */

import { fetchSourceProxy, hasBackend, openSource } from '../ipc/commands';
import { bufferFrom } from '../pipeline/buffer.ts';
import { useConvertStore } from '../state/convertStore';
import { PREVIEW_PROXY_MAX_EDGE } from './preview/proxy.ts';
import { previewRuntime } from './previewRuntime.ts';

export async function loadSourceImage(path: string): Promise<void> {
  if (!hasBackend()) throw new Error('opening an image needs the desktop app');

  const info = await openSource(path);
  const proxy = await fetchSourceProxy(info.sourceId, PREVIEW_PROXY_MAX_EDGE);

  previewRuntime.setSource(bufferFrom(proxy.width, proxy.height, proxy.data));
  useConvertStore.getState().setSource({
    sourceId: info.sourceId,
    width: info.width,
    height: info.height,
    path: info.path,
    isProxy: proxy.width !== info.width || proxy.height !== info.height,
  });
}
