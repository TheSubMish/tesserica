---
name: bundled-asset-license
description: Licensing rules for assets bundled into Tesserica (palettes, ONNX models). Use before adding a new bundled palette, model, or other asset to the repo.
---

The project is MIT, but bundled assets have their own constraints:

- ✅ Hardware palettes (Game Boy, NES, CGA, C64) — factual color lists, safe to bundle
- ❌ **Artist-made Lospec palettes** — individual licenses; users import their own
- ✅ U2-Net / `u2netp` — Apache-2.0
- ❌ **BRIA RMBG** — non-commercial only, never bundle

Verify any additional model's license before shipping it.
