# Bundled palettes

> **The built-in palettes are compiled in, not read from this directory.** They live in
> `src/lib/palettes/builtin.ts` (Phase 1). The core makes no I/O and no network calls
> (`docs/02-architecture.md` §9), and compiling them in means the app, the unit tests and
> the eventual Rust export path all see byte-identical data with no load-order concerns.
> The whole set is a few kilobytes.
>
> This directory remains for anything that genuinely has to ship as a file — and the rules
> below bind either way.

## What may live here

Only **hardware palettes** — Game Boy, NES, CGA, C64 and similar. These are
factual lists of the colors a machine could display, not authored works, so
bundling them is safe (`docs/07-tech-stack.md` §8).

## What may not

**Artist-made Lospec palettes.** Each carries its own license. Users import
their own instead; Lospec URL import is an opt-in Phase 7 feature.

Verify provenance before adding anything to this directory.
