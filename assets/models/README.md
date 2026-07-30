# ONNX segmentation models

Background removal, Phase 5 (`docs/08-roadmap.md`).

`.onnx` files are **gitignored** — never committed. Two different ways they end
up here, deliberately not the same mechanism:

- **`u2netp.onnx`** (the bundled default) is fetched at **build time** by a
  developer/CI step, not by the running app:

  ```bash
  npm run models:fetch
  ```

  `scripts/fetch-model.ts` downloads it from the `rembg` project's GitHub
  Releases (the same maintained source `rembg` itself fetches
  `u2netp.onnx` from), verifies its MD5 against the checksum `rembg` itself
  publishes, and is idempotent — safe to run on every checkout, a no-op once
  the file is already present and correct. This is a one-time, explicit,
  network-requiring step for a fresh checkout; it is not something the shipped
  app ever does on its own.

- **Larger models** (e.g. `isnet-general-use`, `04-image-pipeline.md` §8.1)
  are fetched **at runtime, from inside the running app**, only after the user
  explicitly clicks "Download larger model" in Convert mode's Background
  section and confirms a dialog stating the size and source first — see
  `src/segment/`. Never automatic, never on mode switch or startup
  (`CLAUDE.md` "No network calls in the core"). Saved to the OS app-data
  directory, not here.

## Licensing

| Model                     | License        | Bundle?                            |
| ------------------------- | -------------- | ---------------------------------- |
| U2-Net / `u2netp`         | Apache-2.0     | ✅ yes (~4.7 MB, build-time fetch) |
| DIS / `isnet-general-use` | Apache-2.0     | on-demand only (~170 MB)           |
| BRIA RMBG                 | non-commercial | ❌ **never**                       |

Verify any additional model's license before shipping it.

Note that ONNX Runtime's native library (~10–15 MB) likely breaks the 20 MB
size budget on its own; that question is a separate, still-open Phase 5
roadmap item ("Resolve the ONNX Runtime size question",
`docs/07-tech-stack.md` §6).
