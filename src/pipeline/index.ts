/**
 * The image pipeline, TypeScript half.
 *
 * Mirrors `src-tauri/src/pipeline/` module for module, function for function,
 * parameter struct for parameter struct — deliberately, so the two can be
 * reviewed side by side (`docs/02-architecture.md` §3.3). **When you touch one,
 * touch the other in the same change.**
 *
 * This half owns the live preview: it runs in a Web Worker on a ~1024px proxy
 * and is deliberately approximate. Rust owns full-resolution export.
 *
 * `docs/04-image-pipeline.md` is normative for both. The stage order in its §2
 * is fixed and identical here.
 */

export * from './adjust.ts';
export * from './autopalette.ts';
export * from './backgroundRemoval.ts';
export * from './buffer.ts';
export * from './cleanup.ts';
export * from './convert.ts';
export * from './crop.ts';
export * from './dither.ts';
export * from './downscale.ts';
export * from './oklab.ts';
export * from './quantize.ts';
export * from './settings.ts';
