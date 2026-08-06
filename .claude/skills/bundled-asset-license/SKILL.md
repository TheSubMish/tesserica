---
name: bundled-asset-license
description: Licensing rules for assets bundled into Tesserica (palettes, ONNX models). Use before adding a new bundled palette, model, or other asset to the repo.
---

The project is MIT, but bundled assets have their own constraints:

- ✅ Hardware palettes (Game Boy, NES, CGA, C64, ZX Spectrum) — factual color lists,
  safe to bundle
- ✅ PICO-8's default palette — not silicon, but a single fixed spec published by the
  platform itself (Lexaloffle's manual), not an individually-licensed artist submission.
  See `docs/10-decisions.md` D18 for exactly where this line is drawn and why it does
  not extend to Sweetie-16/Dawnbringer-16/-32.
- ❌ **Artist-made Lospec palettes** (Sweetie-16, Dawnbringer-16/-32, etc.) — individual
  licenses; users import their own
- ✅ U2-Net / `u2netp` — Apache-2.0
- ❌ **BRIA RMBG** — non-commercial only, never bundle

Verify any additional model's license before shipping it. For a bundled palette
specifically, also verify the actual color values against a primary source before
relying on them for production art — `docs/10-decisions.md` D18 candidly notes its own
PICO-8 values were transcribed from model knowledge, not re-fetched, and flags that gap
rather than hiding it.
