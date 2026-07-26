# ONNX segmentation models

Background removal, Phase 5 (`docs/08-roadmap.md`).

`.onnx` files are **gitignored** — they are fetched on first use with explicit
user consent, never committed (`docs/07-tech-stack.md` §6).

## Licensing

| Model             | License        | Bundle?          |
| ----------------- | -------------- | ---------------- |
| U2-Net / `u2netp` | Apache-2.0     | ✅ yes (~4.7 MB) |
| BRIA RMBG         | non-commercial | ❌ **never**     |

Verify any additional model's license before shipping it.

Note that ONNX Runtime's native library (~10–15 MB) likely breaks the 20 MB
size budget on its own; that question is resolved in Phase 5
(`docs/07-tech-stack.md` §6).
