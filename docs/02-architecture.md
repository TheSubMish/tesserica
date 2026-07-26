# Architecture

> Status: **draft for review** · Last updated: 2026-07-26

## 1. Stack decision

**Tauri v2 + React + TypeScript, with image processing split between a TS/Canvas
frontend and a Rust backend.**

Verified available on this machine (2026-07-26): Rust 1.89.0, Node 22.18.0, npm 10.9.3,
`webkit2gtk-4.1` present. No blockers.

### Why Tauri over Electron

| | Tauri v2 | Electron |
|---|---|---|
| Installer size | ~10–15 MB | ~150–200 MB |
| Memory | Uses system WebView | Bundles Chromium |
| Heavy pixel loops | Native Rust, `rayon` multithreading | JS/WASM only |
| Cost | Two languages; WebView differs per OS | One language |

The deciding factor is that our workload is **pixel-loop-bound**. Quantizing a
4000×3000 image against a 32-color palette is 12M pixels × 32 distance computations =
~384M operations. In Rust with `rayon` that is comfortably sub-second; in single-threaded
JS it is several seconds.

**The real cost of this choice** (stated plainly so it is not a surprise later): the
WebView is not Chromium on every platform. Linux gets WebKitGTK, macOS gets WKWebView,
Windows gets Edge WebView2. Canvas behaviour is broadly consistent but **not identical** —
`OffscreenCanvas`, `createImageBitmap` options, and WebGL2 extensions vary. Mitigation is
in §6.

---

## 2. Process model

```
┌──────────────────────────────────────────────────────────┐
│  Tauri Core (Rust)                    — main process     │
│  · window & menu management                              │
│  · filesystem, dialogs                                   │
│  · IPC command router                                    │
└───────────────┬──────────────────────────────────────────┘
                │  IPC (JSON commands + raw binary channels)
┌───────────────┴──────────────────────────────────────────┐
│  WebView (React + TypeScript)         — renderer         │
│  · UI, panels, tool interaction                          │
│  · document state (zustand)                              │
│  · Canvas2D rendering + LIVE PREVIEW pipeline            │
│  └── Web Worker: preview processing off the main thread  │
└──────────────────────────────────────────────────────────┘
                │  spawn_blocking / rayon thread pool
┌───────────────┴──────────────────────────────────────────┐
│  Rust worker threads                                     │
│  · full-resolution export pipeline                       │
│  · ONNX background-removal inference                     │
│  · file encode/decode (PNG, GIF, .ase, project format)   │
└──────────────────────────────────────────────────────────┘
```

---

## 3. The hybrid split — the central design decision

**Rule: the frontend renders what you *see*; Rust produces what you *ship*.**

### 3.1 Frontend (TS + Canvas, in a Web Worker)

Handles anything that must respond within one frame:

- Live conversion preview while dragging sliders
- All drawing tools (pencil, fill, shapes) — these are inherently interactive
- Layer compositing for on-screen display
- Zoom / pan / grid overlay

Preview is **deliberately approximate** for speed:

- Operates on a **downscaled proxy** of the source image, capped at ~1024 px on the long
  edge. The user is looking at a pixelated result on a screen a few hundred pixels wide;
  processing 12M source pixels to show them 64×64 blocks is pure waste.
- May use a cheaper dither or a coarser color-distance approximation.

### 3.2 Rust backend

Handles anything where **correctness at full resolution** matters:

- Final export at true source resolution
- Background-removal inference (ONNX)
- Encoding PNG / GIF / spritesheets
- Project file read/write
- `.ase` import

### 3.3 The correctness obligation

This split creates one real risk: **preview and export disagree**, and the user exports
something that does not match what they approved. That is the failure mode that would
make the whole architecture a mistake.

Mitigations, all of which are requirements not suggestions:

1. **One algorithm specification, two implementations.** `04-image-pipeline.md` is
   normative. Both implementations conform to it.
2. **Golden-image tests.** A fixed corpus of source images × settings, processed by both
   paths, compared. Preview-vs-export must stay within a defined perceptual tolerance
   (ΔE in Oklab), with dithering compared structurally rather than pixel-exactly, since
   error diffusion legitimately differs at different input resolutions.
3. **Preview parity mode.** For the final check before export, a "full quality preview"
   button runs the *Rust* pipeline and displays that. Slower, exact, opt-in.
4. **Honest labelling.** The preview is marked as a preview in the UI when it is running
   in proxy mode.

> **Known and accepted:** dithering at proxy resolution genuinely cannot match dithering
> at full resolution — error diffusion is resolution-dependent by nature. The preview
> shows the *pattern character*, not the exact pixels. This is why (3) exists.

---

## 4. Frontend structure

```
src/
├── main.tsx
├── app/
│   ├── App.tsx
│   ├── routes.tsx             # mode switching: Convert | Edit
│   └── shortcuts.ts
├── state/
│   ├── documentStore.ts       # sprite: layers, frames, palette
│   ├── historyStore.ts        # undo/redo (see 03-data-model.md §6)
│   ├── toolStore.ts           # active tool, brush size, colors
│   └── uiStore.ts             # panel visibility, zoom, theme
├── canvas/
│   ├── CanvasView.tsx         # viewport, pan/zoom, event capture
│   ├── renderer.ts            # layer compositing → screen
│   ├── overlays.ts            # grid, selection marching ants, onion skin
│   └── coords.ts              # screen ↔ document coordinate mapping
├── tools/
│   ├── Tool.ts                # interface: onPointerDown/Move/Up → Command
│   ├── pencil.ts  eraser.ts  fill.ts  line.ts
│   ├── shapes.ts  picker.ts  select.ts  move.ts
│   └── registry.ts
├── pipeline/                  # ← mirrors src-tauri/src/pipeline/
│   ├── preview.worker.ts      # runs the pipeline off-thread
│   ├── pixelate.ts  quantize.ts  dither.ts
│   ├── adjust.ts  palette.ts
│   └── oklab.ts
├── panels/
│   ├── LayerPanel.tsx  PalettePanel.tsx  ToolPanel.tsx
│   ├── ConvertPanel.tsx  TimelinePanel.tsx  AdjustPanel.tsx
├── ipc/
│   └── commands.ts            # typed wrappers over Tauri invoke()
└── lib/
    ├── formats/               # .hex .gpl .pal .txt palette parsers
    └── color.ts
```

**State:** `zustand` — small, no boilerplate, and easy to keep the hot pixel data *out*
of React. Layer pixel buffers live in plain `Uint8ClampedArray`s referenced by the store,
never in React state. Only metadata (name, opacity, visibility) is reactive.

---

## 5. Backend structure

```
src-tauri/src/
├── lib.rs                     # builder, plugin + command registration
├── commands/
│   ├── mod.rs
│   ├── export.rs              # export_image, export_spritesheet, export_gif
│   ├── convert.rs             # full-res conversion
│   ├── project.rs             # save/load project
│   ├── segment.rs             # background removal
│   └── import.rs              # .ase and image import
├── pipeline/                  # ← mirrors src/pipeline/
│   ├── mod.rs
│   ├── pixelate.rs  quantize.rs  dither.rs
│   ├── adjust.rs  palette.rs
│   └── oklab.rs
├── model/
│   ├── document.rs  layer.rs  frame.rs  cel.rs
│   └── project_io.rs
├── segment/
│   ├── mod.rs                 # ONNX session management
│   └── postprocess.rs         # mask cleanup, alpha matting
└── error.rs                   # one error type → serializable to TS
```

The **parallel `pipeline/` directories are intentional**. Same module names, same
function names, same parameter structs. Reviewing them side by side is how we keep the
two implementations honest.

---

## 6. IPC design

### 6.1 Command surface

Typed via `#[tauri::command]` with `serde`-derived structs, mirrored by hand-maintained
TypeScript types in `src/ipc/commands.ts`.

```rust
#[tauri::command]
async fn export_image(
    doc: DocumentSnapshot,
    settings: ExportSettings,
    path: String,
) -> Result<ExportResult, AppError>;

#[tauri::command]
async fn convert_full_res(
    source_id: SourceId,
    settings: ConvertSettings,
) -> Result<ImageHandle, AppError>;

#[tauri::command]
async fn remove_background(
    source_id: SourceId,
    model: SegModel,
) -> Result<MaskHandle, AppError>;
```

### 6.2 Moving pixels across the boundary — the performance trap

Tauri IPC serializes to JSON by default. **A 4000×3000 RGBA image is 48 MB; as JSON it is
worse and the serialize/parse cost dwarfs the actual image processing.** Naively passing
buffers through `invoke()` would make Rust *slower* than doing everything in JS, which
would quietly defeat the entire architecture.

Rules:

1. **Never send raw pixels through a JSON command.** Send handles.
2. **Large source images are opened by Rust and stay in Rust.** The frontend gets a
   `SourceId` plus a downscaled proxy for preview. Full-resolution pixels never enter the
   WebView.
3. **Rust→frontend bulk data** uses Tauri v2 **Channels** (streaming binary) or a custom
   protocol, not command return values.
4. **Export sends no pixels at all.** The frontend sends a `DocumentSnapshot`
   (metadata + layer *edits*), and Rust re-runs the pipeline from the source it already
   holds.

> **Open item:** for *editor* layers the user has hand-drawn, Rust does not hold the
> pixels — the frontend does. Those buffers do have to cross the boundary on export.
> Options: a custom Tauri URI protocol, a Channel, or writing to a temp file. Needs a
> benchmark before we commit. Tracked in `09-open-questions.md`.

---

## 7. Rendering

**Canvas2D first, WebGL2 only if measured to be necessary.**

Canvas2D with `imageSmoothingEnabled = false` gives correct nearest-neighbour zoom for
free, which is exactly what pixel art needs. Compositing a handful of layers at typical
sprite sizes (≤512×512) is trivial work.

Layer stack:

1. Checkerboard transparency background
2. Composited layers (offscreen canvas, redrawn only when a layer is dirty)
3. Active-stroke overlay (the in-progress stroke, so we do not recomposite per pointer move)
4. Overlays: grid, selection, onion skin, cursor preview

**Reassess WebGL2 if:** very large canvases (2048²+), many layers with blend modes, or
animation playback drops frames. Blend modes are the most likely trigger — Canvas2D
`globalCompositeOperation` does not cover everything and manual per-pixel blending in JS
is slow.

---

## 8. Threading

**Frontend:** conversion preview runs in a dedicated Web Worker, with transferable
`ArrayBuffer`s (zero-copy). Rapid slider drags cancel the in-flight job — latest-wins,
so we never queue stale work.

**Backend:** `rayon` parallel iterators over scanlines for the pixel loops. Tauri async
commands must not block the main thread — long jobs go through `spawn_blocking`, with
progress reported back over a Channel.

---

## 9. Non-negotiable constraints

1. **No network calls in the core pipeline.** The optional model download and optional
   Lospec fetch are the only network features, both explicit and user-initiated.
2. **Nearest-neighbour on every pixel-art path.** No bilinear/bicubic on upscale, ever.
3. **Integer scale factors on export.**
4. **The pipeline order in `04-image-pipeline.md` is fixed** and identical in both
   implementations.
5. **Alpha is premultiplied nowhere.** Straight alpha throughout — premultiplication
   plus palette quantization produces color fringing on transparent edges.

---

## 10. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Preview/export divergence | **High** | §3.3 — golden tests, parity mode |
| IPC serialization cost | **High** | §6.2 — handles, never buffers |
| WebView inconsistency across OS | Medium | Canvas2D only; feature-detect; test all three before v1 |
| Two implementations drift over time | Medium | Mirrored module layout; golden tests in CI |
| ONNX model size vs installer budget | Medium | Download on first use, not bundled |
| `ort` crate is pre-release (2.0.0-rc.12, no stable) | Medium | Pin exact version; isolate behind our own `segment` module so it can be swapped |
| Scope (editor + converter + utilities) | **High** | Phased roadmap; v1 is a walking skeleton |
