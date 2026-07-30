# Tech Stack & Tooling

> Status: **draft for review** · Last updated: 2026-07-26
>
> **All versions below were verified against npm and crates.io on 2026-07-26.** Re-verify
> before scaffolding — these move fast.

## 1. Verified environment

| Tool | Version | Status |
|---|---|---|
| Rust / cargo | 1.89.0 | ✅ installed |
| Node | 22.18.0 | ✅ installed |
| npm | 10.9.3 | ✅ installed |
| `webkit2gtk-4.1` | present | ✅ Tauri v2 Linux dep satisfied |
| `webkit2gtk-4.0` | absent | ⚠️ not needed — v2 uses 4.1 |

No blockers for Tauri v2 on this machine.

---

## 2. Frontend dependencies

| Package | Latest | Installed (Phase 0) | Use |
|---|---|---|---|
| `@tauri-apps/api` | 2.11.1 | 2.11.1 | IPC, dialogs, fs |
| `@tauri-apps/cli` | 2.11.4 | 2.11.4 | dev/build tooling |
| `react` / `react-dom` | 19.2.8 | 19.2.8 | UI |
| `vite` | 8.1.5 | 8.1.5 | bundler / dev server |
| `typescript` | 7.0.2 | **5.8.3** ⚠️ | types |
| `zustand` | 5.0.14 | 5.0.14 | state (`02-architecture.md` §4) |

> ⚠️ **TypeScript 7.0 is the native (Go) compiler port.** Substantially faster, but new.
> If tooling friction appears, pinning to the latest 5.x is a legitimate fallback — this
> is not a load-bearing choice.
>
> **Phase 0 took that fallback.** `typescript-eslint@8.65.0` declares
> `peerDependencies.typescript: ">=4.8.4 <6.1.0"`, so TS 7 cannot be linted. Since the
> lint gate is worth more than compiler speed at this size, the project is pinned to
> `typescript@~5.8.3`. Revisit when `typescript-eslint` supports 7.x.

> ⚠️ **Vite 8 and React 19** are both current majors. Verify the Tauri v2 template
> targets them before assuming; the official template may lag.
>
> It did: `create-tauri-app` scaffolds `vite@^7` / `@vitejs/plugin-react@^4`. Phase 0
> upgraded to `vite@8.1.5` + `@vitejs/plugin-react@6.0.4` (which peers on `vite@^8`) and
> re-verified `tauri dev` and `tauri build` on Linux afterwards.

**Deliberately not using:**

- **A component library** (MUI, Chakra, shadcn). A pixel editor's UI is almost entirely
  custom — canvas, tool rails, timelines, palette grids. A component library would
  contribute a theme system and little else, at real bundle and override cost. Hand-rolled
  CSS with the tokens in `05-ui-design.md` §6.2.
- **A canvas framework** (Konva, Fabric, PixiJS). These are built for scene graphs of
  objects. We have a pixel buffer. Direct Canvas2D is simpler and faster for this.
- **Redux.** Overkill; `zustand` covers it without the ceremony.
- **Tailwind.** Reasonable alternative, but the token set is small and hand-written CSS
  keeps the canvas-adjacent code readable. Low-stakes, revisit if preferred.

---

## 3. Backend dependencies

| Crate | Latest stable | Use |
|---|---|---|
| `tauri` | 2.11.5 | app framework |
| `serde` / `serde_json` | 1.0.229 | IPC + project format |
| `image` | 0.25.10 | decode/encode PNG, JPEG, GIF, WebP |
| `imageproc` | 0.27.0 | morphology, connected components (`04` §6.1) |
| `rayon` | 1.12.0 | parallel pixel loops |
| ~~`palette`~~ | ~~0.7.6~~ | ❌ **not used** — Oklab hand-rolled instead (D10, §3.2) |
| `zip` | — | `.tess` archive |
| `thiserror` | — | error types |
| `ort` | **2.0.0-rc.13** | ⚠️ ONNX runtime — **no stable release**, direct dependency (D15) |

### 3.1 On `ort`

`ort` has no stable 2.x release (re-verified 2026-07-30; latest is `2.0.0-rc.13`, up from
the `2.0.0-rc.12` this table previously recorded — actively maintained, not stalled: that
release landed two days before this re-check). This is the riskiest dependency in the
stack.

**Decision (locked, `10-decisions.md` D15): depend on `ort` directly, not `rembg-rs`.**
`rembg-rs` was evaluated as this section originally asked: real crates.io data shows it
depends on `ort ^2.0.0-rc.10` itself (an older constraint, not a replacement for one), has
747 total downloads across a ~9-month history, and pulls in `imagequant` (indexed-color
quantization — conflicts with D9's RGBA-only v1) and `oxipng` (PNG recompression this
project has no use for). It adds an extra dependency layer and an opinionated
postprocessing pipeline without removing any of the actual risk. Full write-up in
`10-decisions.md` D15.

Mitigations, now implemented (`src-tauri/src/segment/`):
- **Pin the exact rc version.** No caret ranges — `ort = "=2.0.0-rc.13"` in `Cargo.toml`.
- **Isolate behind `src-tauri/src/segment/`.** Every other module talks to
  `segment::Segmenter`, never to `ort`.
- **Built with `load-dynamic`, not the default `download-binaries`.** The crate compiles
  with zero system or network dependencies; the real ONNX Runtime shared library is
  `dlopen`ed only when `Segmenter::load` is actually called with a path, which is not yet
  wired to any bundled or downloaded runtime (that is Q9/the next Phase 5 roadmap item) —
  a missing dylib is a plain, gracefully-reported error, never a build failure or a panic.
- **Verified working in this container**, not just compiling: a manually-run smoke test
  (`#[ignore]`d, not part of ordinary `cargo test`) `dlopen`ed a real ONNX Runtime 1.28.0
  and committed a real inference session against a real (if oversized, non-`u2netp`)
  `.onnx` file, in under a second. See D15 for exact reproduction.
- **Background removal is a v2 feature**, so there is time for a stable `ort` release; the
  non-ML corner flood-fill fallback (`04` §8.5) already shipped, so the feature degrades
  rather than disappears if `ort` proves unworkable later.

### 3.2 On `palette`

We need Oklab conversions (`04` §4.1), which are ~30 lines. The `palette` crate is
well-built but adds a type-heavy API for a small need — and critically, **the TS side has
to hand-roll it anyway**, and the two implementations must match bit-for-bit.

**Decision: hand-roll `oklab.rs` / `oklab.ts` from identical constants** — locked,
`10-decisions.md` D10. Parity becomes structural rather than hoped-for. The `palette`
crate is therefore **not a dependency**; it stays in the table above only as the
alternative that was considered.

---

## 4. Repository layout

```
tesserica/
├── docs/                       # this knowledge base
├── src/                        # React frontend (02-architecture.md §4)
├── src-tauri/                  # Rust backend (02-architecture.md §5)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
├── assets/
│   ├── palettes/               # bundled built-in palettes
│   └── models/                 # bundled u2netp.onnx (~4.7 MB)
├── tests/
│   ├── golden/                 # cross-implementation corpus (04 §11)
│   │   ├── sources/
│   │   └── expected/
│   └── fixtures/               # real Lospec palette files
├── package.json
└── README.md
```

---

## 5. Testing

| Layer | Tool | Scope |
|---|---|---|
| Rust unit | `cargo test` | pipeline stages, parsers, color math |
| TS unit | `vitest` | pipeline mirror, parsers, geometry |
| **Cross-impl** | custom harness | **golden corpus — the critical one** (`04` §11) |
| Component | `vitest` + Testing Library | panels, tool state |
| E2E | deferred | WebDriver on Tauri is awkward; revisit post-v1 |

**The golden-image harness is the highest-value test in the project.** It is the only
thing standing between us and silent preview/export divergence
(`02-architecture.md` §3.3). Build it in the same phase as the first pipeline stage, not
after.

---

## 6. Build & packaging

**Linux only for now** (`10-decisions.md` D5). Windows and macOS remain the eventual
goal but are not verified or built.

| Platform | Artifact | Status |
|---|---|---|
| **Linux** | `.deb`, `.AppImage`, `.rpm` | ✅ **in scope** — `webkit2gtk-4.1` present |
| Windows | `.msi`, `.exe` (NSIS) | deferred — WebView2 auto-installed when we get there |
| macOS | `.dmg`, `.app` | deferred — needs Apple Developer account (~$99/yr) to sign |

**Size budget** (`00-vision-and-scope.md` §8): under 20 MB.

| Component | Est. |
|---|---|
| Tauri binary + WebView glue | ~8 MB |
| Frontend bundle | ~1 MB |
| Built-in palettes | <100 KB |
| `u2netp.onnx` | ~4.7 MB |
| ONNX Runtime native lib | ~10–15 MB ⚠️ |

⚠️ **ONNX Runtime's native library likely breaks the 20 MB budget on its own.** Options,
to decide before v2:

1. **Download the runtime on first use** along with the model — keeps the base installer
   small, costs a first-run network prompt.
2. **Ship two builds** — lite and full.
3. **Raise the budget** to ~40 MB. Still far under Electron's ~150 MB.

Leaning toward (1): it keeps the promise that the app does nothing over the network
unless asked, and background removal is inherently an opt-in feature.

macOS signing needs an Apple Developer account (~$99/yr). Not needed for local
development or Linux/Windows distribution — flagged so it is not a surprise.

---

## 7. Development

```bash
npm install
npm run tauri dev      # hot-reload frontend, rebuild Rust on change
npm run tauri build    # production bundle
cargo test  --manifest-path src-tauri/Cargo.toml
npm run test           # vitest
npm run test:golden    # cross-implementation parity
```

**Recommended tooling:** `rustfmt` + `clippy` (deny warnings in CI), `prettier` +
`eslint`, and a pre-commit hook running format + clippy + unit tests.

**CI:** GitHub Actions, **Linux only** (`10-decisions.md` D5). The golden-parity suite
must run on every PR.

⚠️ **Standing risk from the Linux-only decision:** Tauri uses the OS WebView, so Canvas
and `OffscreenCanvas` behaviour differs across platforms. Building Linux-only means those
differences surface *later and in bulk* rather than incrementally. Mitigation: avoid
WebView-specific APIs, prefer plain Canvas2D, and leave a comment wherever something
smells platform-dependent so the eventual port has a trail to follow.

---

## 8. Licensing

**Our code: MIT.** Locked — `10-decisions.md` D2.

Bundled-asset constraints are independent of that choice and still bind:

- ✅ **Hardware palettes** (Game Boy, NES, CGA, C64) — factual color lists, not
  copyrightable. Safe to ship.
- ❌ **Artist-made Lospec palettes** — individual licenses. Do not bundle; users import
  their own.
- ✅ **U2-Net / `u2netp`** — Apache-2.0. Safe to bundle.
- ❌ **BRIA RMBG** — non-commercial only. Never bundle.

Verify any additional model's license before shipping it.
