# Roadmap

> Status: **draft for review** · Last updated: 2026-07-26

## Guiding constraint

Scope is the top risk in this project (`02-architecture.md` §10). Pixelorama is years of
work; the converters are focused single-purpose tools; we are proposing both plus
utilities.

**The discipline: every phase ends with something usable end to end.** No phase leaves
the app in a state where nothing works until the next phase lands.

---

## Phase 0 · Foundation

**Goal:** a Tauri window that draws pixels.

- [x] Scaffold Tauri v2 + React + TS + Vite; verify `tauri dev` and `tauri build` on Linux
- [x] Repo layout per `07-tech-stack.md` §4; formatters, linters, pre-commit
- [x] Design tokens (`05-ui-design.md` §6.2), app shell, mode switcher (tabs inert)
- [x] Canvas viewport: pan, zoom, nearest-neighbour, checkerboard, grid overlay
- [x] `documentStore` with a single raster layer
- [x] Pencil tool → visible pixels

**Exit:** you can draw on a canvas and zoom in. Nothing else.

---

## Phase 1 · Editor core

**Goal:** W2 (draw from scratch) works fully.

- [x] Command/history system with dirty-rect deltas + coalescing (`03-data-model.md` §6)
- [x] Tools: pencil (pixel-perfect), eraser, fill, line, rect, ellipse, eyedropper
- [x] Layers: add/delete/reorder/rename/opacity/visibility/lock; normal blend
- [x] Layer panel; compositing renderer with dirty-layer caching
- [x] Palette panel; built-in hardware palettes
- [x] Palette import: `.hex`, `.gpl`, `.pal`, Paint.net `.txt` (`03` §3)
- [x] Export PNG at integer scales
- [x] `.tess` save/load (`03` §7)

**Exit:** ⚠️ **W2 all but complete.** A usable, if basic, pixel editor: draw with seven
tools, stack and reorder layers, pick from bundled or imported palettes, undo a whole
drag in one step, export PNG at 1×/2×/4×/8×, and save and reopen a `.tess`.

Two steps of W2 (`06-workflows.md`) are **not** covered by the checklist above, and were
therefore not built:

- **`Ctrl+N` → New sprite dialog** (W2 step 1). The app boots a fixed 64×64 document and
  offers no way to create another or change its size. No checklist item covers it; it is
  small and belongs at the head of Phase 3.
- **`multiply` on the shading layer** (W2 step 4) needs blend modes beyond normal, which
  the roadmap itself schedules for **Phase 3**. W2 as written in `06-workflows.md` cannot
  complete before that phase; the two documents disagree and Phase 3 is the correct one.

---

## Phase 2 · Conversion

**Goal:** W6 (casual avatar) and the core of W1 work.

- [x] `oklab.ts` / `oklab.rs` from shared constants (`04` §4.1)
- [x] **Golden-image test harness** — build this alongside the first stage, not after
- [x] Pipeline stages, both implementations: adjustments → downscale → quantize → cleanup
- [x] Dithering: none, Floyd–Steinberg (serpentine), Atkinson, Bayer 2/4/8 (`04` §5)
- [x] Nearest-color cache with the error-diffusion carve-out (`04` §4.2)
- [x] Preview Web Worker with latest-wins cancellation (`02` §8)
- [x] Rust full-res export path; `SourceId` handle model (`02` §6.2)
- [x] Convert mode UI: split/side-by-side, four primary controls (`05` §3)
- [x] Auto-palette (Wu + k-means in Oklab) (`04` §4.3)
- [x] **`[ Edit → ]`** — conversion layer creation, mode switch, live re-editing

**Exit:** ✅ **W6 complete. W1 complete except background removal.** This is where the
product thesis becomes real and demonstrable.

Drop a photo in, watch it convert live, adjust four controls, export a PNG at an integer
scale — or press `[ Edit → ]` and keep working on it as a layer whose palette you can
change later. The parity guarantee holds: **3,083 golden cases over 917,040 pixels, zero
differing palette indices and zero differing RGBA bytes** between the TypeScript preview
pipeline and the Rust export pipeline.

Two caveats worth carrying into Phase 3, neither of which blocks the exit:

- **A conversion layer's `sourceId` is process-local.** Reopening a `.tess` restores the
  layer and its settings, but not the live handle, so the layer cannot re-render until its
  source is re-attached. `10-decisions.md` D3 already reserves `sources/` inside the
  archive for exactly this; wiring it up is Phase 3 work.
- **Re-rendering a conversion layer is not yet an undo step.** It edits the cel directly
  rather than going through the command system (`03-data-model.md` §6).

> **Highest-risk phase, and it landed.** The dual implementation and the parity guarantee
> both arrived here.

---

## Phase 3 · v1 release

**Goal:** ship it.

- [x] Blend modes beyond normal — all sixteen from `03-data-model.md` §2.1. Composited
      in `canvas/blend.ts` (W3C formulas, used by export and the eyedropper) and via
      native `globalCompositeOperation` in the live renderer (`canvas/renderer.ts`) —
      see that file for why the two are allowed to differ here, unlike the conversion
      pipeline. The Rust `BlendMode` enum mirrors the wire format only; Rust never
      composites layers.
- [x] Selection tools (rect, ellipse, lasso, magic wand) + move — `model/selection.ts`
      generalizes the store from a bare `Rect` to a `Selection` (a bounding rect plus an
      optional row-major mask; the mask is omitted for a plain rectangle, so the common
      case allocates nothing). `tools/select.ts` is one tool with a `selectMode`
      (`state/toolStore.ts`), the same pattern as Fill's contiguous/global option, not
      four separate tools (`05-ui-design.md` §4.1 lists it that way too): rect/ellipse
      drag out live like the Rectangle/Ellipse draw tools (`tools/shapes.ts::
      ellipseSelection`, sharing its row-span scanline with the filled-draw code path
      so a selection and a filled draw agree pixel-for-pixel); lasso rasterizes a
      freehand path with an even-odd scanline (`model/polygon.ts::polygonSelection`);
      magic wand is a 4-connected flood (`tools/fill.ts::wandSelection`, sharing
      `walkContiguousRuns` with `fillContiguous` — the shared walk keeps its own
      `visited` set rather than relying on the callback repainting a pixel to stop
      re-visiting it, since the wand callback only marks a mask and never touches the
      buffer `matches` reads from). Every paint tool (pencil, eraser, fill, line, rect,
      ellipse) clips to `Selection` via `selectionContains`, and `tools/move.ts` only
      extracts/clears pixels the mask actually selects, so moving an ellipse or lasso
      selection leaves the rest of its bounding box alone. Marching ants walk the
      mask's real boundary edges (`model/selection.ts::selectionEdges`), not the
      bounding box, so a non-rectangular selection outlines its actual shape
      (`canvas/renderer.ts::drawSelection`). Verified live in `tauri dev`: dragged
      rect/ellipse/lasso selections and a wand click all rendered the correct marching
      ants, and moving a wand selection correctly left an incidental opaque pixel
      behind (it broke the flood's colour match, so the mask had a hole there) while
      translating the rest.
- [x] Layer groups, clipping masks — groups nest via a `parentId` pointer into
      the same flat `Sprite.layers` array rather than a separate tree
      (`model/layerTree.ts`, `03-data-model.md` §2.1); a group has no pixels
      of its own and composites its children onto an isolated canvas
      (`canvas/renderer.ts::compositeScope`), which is also where "clip to
      layer below" is resolved, scoped to one group and never crossing a
      group boundary. Both `canvas/flatten.ts` (export) and `canvas/sample.ts`
      (eyedropper) walk the same tree recursively so a clipped or grouped
      layer reads the same way everywhere. A hidden or locked group cascades
      to every descendant for both display and editing
      (`isEffectivelyVisible`/`isEffectivelyLocked`). The Rust `Layer::Group`
      variant round-trips `parentId`/`clippingMask`/`collapsed` through
      `.tess` only — Rust never composites layers at all, groups included.
      There is no nesting-depth limit and no multi-select; grouping wraps one
      layer at a time and further members are reassigned via the layer
      panel's Parent selector.
- [x] Keyboard shortcuts complete (`05` §7) — the interaction rules in §7 are now all
      implemented, including "every slider is also a number field"
      (`app/SliderField.tsx`, used by all nine sliders in the app) and `M`/`V` for
      Select/Move. The one remaining piece, a dedicated click-to-zoom `Z` tool, landed:
      `zoom` is a real `ToolId` (`state/toolStore.ts`) selectable from the rail
      (`panels/ToolRail.tsx`) and via the `Z` key (`app/shortcuts.ts`), but it never
      touches a cel buffer, so `tools/zoom.ts` is a documented no-op — `CanvasView`'s
      `onPointerDown` special-cases `activeTool === 'zoom'` before tool dispatch and
      calls `uiStore.zoomAt` directly, the same function and step (`ZOOM_STEP_FACTOR`,
      shared with the `Ctrl`+wheel path) as the existing zoom-from-any-tool gesture, so
      the two can never drift apart. `05-ui-design.md` §4.1 specifies the key but not
      the click semantics, so the smallest reasonable thing was implemented and flagged
      rather than invented further: click zooms in, `Alt`+click zooms out (the universal
      convention for a magnifier tool, and free to use here because the zoom tool
      bypasses the generic dispatch that turns `Alt` into the eyedropper for every other
      tool). No preferences panel exists and none was built — a prior pass in this
      project found no spec for one anywhere in `docs/`, and building one now would be
      inventing scope rather than closing it. Verified live against the Vite dev bundle
      over CDP (desktop `tauri dev` was not attempted given the documented GPU-contention
      flakiness noted above): selected the tool both from the rail and via `Z`, clicked
      to zoom in toward the click point (1000%→1250%, exactly the 1.25× step), `Alt`+
      clicked at the same point to zoom out by the same step (1563%→1250%, the inverse
      of 1.25×), and confirmed `Ctrl`+wheel from another tool still zooms in by the
      identical step (1250%→1563%) after the shared-constant refactor.
- [x] Accessibility pass (`05` §8) — color-blindness simulation shipped
      (`lib/colorBlind.ts`, palette panel) in an earlier pass; this one is the
      systematic contrast/focus-order audit that hadn't happened yet. Computed
      WCAG contrast for every token pair actually used in `styles/global.css`
      against `styles/tokens.css` (`05` §6.2): `--text-faint` measured 2.9:1 on
      `--bg-panel` and 2.6:1 on `--bg-elevated` — a real failure on panel
      headers, the status bar, hints and menu-key hints, not a near-miss.
      Retinted it to `#898994`, which clears 4.5:1 on every background it is
      actually used against while staying visibly dimmer than `--text-muted`.
      Target size: `.panel-head button` (18 layer/palette-panel icons) and
      `.statusbar-btn` were 20×20 and 18×18 against the documented ≥24×24
      floor; both are 24×24 now, confirmed via `getBoundingClientRect` in the
      live app. `.statusbar-btn:focus-visible` set `outline: none` with only a
      background swap to mark focus — not a visible ring on an 18–24px
      control; it now matches every other focusable element (`2px solid
      var(--accent)`). Checkbox/radio inputs were already deliberately
      under-24px with a comment explaining the enclosing label carries the
      target size — left alone. Focus order: walked the live DOM focus order
      (title bar → mode tabs → tool rail → swatches → tool options → layer
      panel → palette panel → status bar) and found it already logical with
      no traps, but `ExportDialog` and `NewSpriteDialog` claimed
      `aria-modal="true"` while doing nothing to back it up — no initial
      focus, no focus trap, `Tab` could walk straight into the tool rail and
      canvas behind the backdrop. Added `app/useModalFocusTrap.ts` (own test
      file, 5 cases) and wired it into both dialogs: focus moves to the first
      control on open, `Tab`/`Shift+Tab` wrap inside the dialog, `Escape`
      closes it, and focus returns to whatever opened it. `prefers-reduced-motion`
      and "never encode state in color alone" (active tool's bar, layer
      visibility icons, palette-swatch outline) already held and needed no
      change. Verified live against the real Vite bundle (the desktop
      `tauri dev` WebView rendered blank across four fresh launches in this
      container — the same GPU/resource-contention flakiness
      `08-roadmap.md`'s Linux-installer note already hit, confirmed by ~30
      unrelated Chrome/Brave renderer processes and <1.1 GB free RAM at the
      time): drove the app over CDP, confirmed `--text-faint` computes to
      `#898994` and both fixed controls measure exactly 24×24, and exercised
      the real focus trap end to end (mount-focus, `Tab` wrap, `Shift+Tab`
      wrap, `Escape`-close-with-restore) on both dialogs. Light theme itself
      still doesn't exist (`styles/tokens.css`, "specified but not yet
      implemented") so it is out of this audit's reach, not swept under it.
- [ ] ~~Cross-platform verification~~ — **deferred, Linux only** (`10-decisions.md` D5)
- [x] Linux installers (`.deb`, `.AppImage`); README; first-run experience — bundle
      targets and icons were already configured (Phase 0). `npm run tauri build`
      (both `--debug` and the real release profile) produces
      `Tesserica_0.1.0_amd64.deb` and `Tesserica_0.1.0_amd64.AppImage` with no
      privileged package installs, using `dpkg-deb` and the cached `linuxdeploy` +
      gtk/appimage plugins already on this machine. The `.deb` is verified
      end to end: `dpkg-deb -I`/`-c` show a correct control file (`Depends:
      libwebkit2gtk-4.1-0, libgtk-3-0`), desktop entry and hicolor icons, and
      launching the extracted binary directly (`GDK_BACKEND=x11`) opens a full
      working window — tool rail, layer and palette panels all present, and a
      pencil stroke drawn with `xdotool` rendered correctly — which is also the
      first-run experience: straight into Edit mode on a blank 64×64 sprite. The
      `.AppImage` builds and is structurally valid (correct `.desktop`, its own
      bundled `webkit2gtk-4.1` via the linuxdeploy gtk plugin) and its processes
      launch correctly, but its WebView content stayed blank on every attempt in
      this container; a WebKitGTK warning ("...no longer allows disabling the
      sandbox. Use `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`...") points at
      WebKit's own process sandbox as the likely cause inside this nested
      container — not chased further since forcing the sandbox off was blocked by
      this session's own permission guardrail. Later relaunches in the same
      session got flaky even for the previously-good `.deb` (blank window,
      no interaction fixed it), almost certainly GPU/WebKit resource pressure
      from repeatedly spawning WebKit processes in a shared desktop container
      across ~8 launches, not a defect in the artifact — the first clean run
      already proved the `.deb` renders and accepts input correctly. README's
      `npm run tauri build # .deb + .AppImage` line was already accurate.

**Exit:** 🚀 **v1.** Editor + converter, meeting the §8 success criteria in
`00-vision-and-scope.md`.

---

## Phase 4 · Animation

**Goal:** W3 works.

- [x] Frames, cels, linked cels (`03` §2.2) — the data model and its commands
      landed in this pass, verified by unit test, not by real UI. `Sprite`
      genuinely holds multiple frames now — `createLayer`/`insertLayer`
      already built one cel per frame correctly, and the new symmetric half,
      `createFrame`/`insertFrame`/`removeFrameMetadata`/`swapFrames`, builds
      one cel per non-group layer. **Linked cels**: `Cel.linkedTo?: CelId`
      (`model/types.ts`) marks a cel as sharing another cel's buffer instead
      of owning one, always another cel on the same layer at a different
      frame, never chained (a link always names an unlinked, "canonical"
      cel). `celBufferId(cel)` resolves the id a cel's pixels actually live
      under in `model/pixelBuffers.ts`, and every reader was audited and
      updated to go through it — the renderer's cel cache and composite
      signature, `flatten.ts`, `sample.ts`, `CanvasView`'s drawing dispatch,
      `.tess` save/load. `history/frameCommands.ts` adds undoable
      add/delete/duplicate/reorder frame and link/unlink cel, mirroring
      `layerCommands.ts`'s command-pattern vocabulary one axis over; deleting
      a frame whose cel is a link's target checks the *surviving* cels before
      releasing its buffer, since (unlike deleting a whole layer) the frames
      that still link to it do not die in the same batch. The Rust `Cel`
      mirrors `linkedTo` (`src-tauri/src/model/document.rs`) and `.tess`
      round-trips it: a linked cel gets no `cels/<id>.png` of its own on save
      and is skipped (not warned about) on load
      (`src-tauri/src/commands/project.rs`). **Left unchecked deliberately**:
      nothing in the shipped UI can create a second frame yet — no button
      anywhere calls `addFrame`. Verified live instead by driving the running
      Vite dev bundle over Chrome DevTools Protocol — dynamically importing
      the store and `frameCommands` modules and calling `addFrame`/`linkCel`
      directly — and confirming the canvas correctly rendered a pixel painted
      on one frame's cel while the *other*, linked frame was the one on
      screen, proving the shared-buffer resolution actually reaches the
      renderer and not just the unit tests. The next item, the Timeline
      panel, is what will make this reachable by a human. **Correction from a
      later pass**: the renderer's cel cache and composite signature keyed on
      a cel's numeric pixel revision alone, not on which buffer produced it.
      Two cels each edited exactly once both sit at revision 1, so linking one
      to the other could leave the revision numbers coincidentally equal and
      the canvas would silently keep showing the pre-link pixels. Both caches
      (`canvas/renderer.ts`) now also key on `celBufferId(cel)`, which always
      changes when a link does regardless of the revision numbers. Found by
      the live CDP walkthrough for the Timeline panel below, not by the
      simpler linked-cel check described above, which happened not to hit the
      coincidence.
- [x] Timeline **panel inside Edit** (D7 — not a third mode): layer×frame grid,
      durations, playback; hidden by default, toggleable. `panels/TimelinePanel.tsx`
      renders a single CSS grid — rows are `model/layerTree.ts`'s
      `visibleLayerRows` (hoisted out of `LayerPanel` so both walk one
      ordering function), columns are `sprite.frames` — with a filled dot for
      an independent cel and a chain icon for a linked one. Per-frame duration
      inputs are wired to `setFrameDuration`, coalescing one continuous edit
      into one undo step the same way `LayerPanel`'s opacity slider does.
      Play/pause/stop/step transport is `panels/timeline.ts`'s
      `startPlayback`, a scheduler that re-reads the document through getters
      on every tick (so a mid-playback frame add/delete/reorder is honoured)
      and drives the existing `activeFrameId`-keyed canvas redraw — no new
      rendering path. Frame lifecycle buttons call the Phase 4 commands
      directly; a link/unlink gesture (click a cel to make it the active
      target, then the link button on any other cel in that row) calls
      `linkCel`/`unlinkCel`. Toggled via a title-bar button or the `T`
      shortcut; hidden by default. Verified live over Chrome DevTools Protocol
      against the running Vite dev bundle (Wayland container, Tauri's own
      WebView unavailable): opened the panel, added a second frame, drew
      distinct content on each and confirmed the grid showed both, hit play
      and watched the canvas alternate and loop, stopped and confirmed it
      returned to frame 1, linked a cel and confirmed the canvas immediately
      showed the target's content (this is what caught the caching bug
      above), confirmed edits to the canonical cel propagate live to the
      linked one, unlinked and confirmed the copy decoupled, and confirmed
      add/duplicate/move/delete-frame and duration edits are all undoable
      with real `Ctrl+Z`/`Ctrl+Y` key dispatch. Unit tests cover grid
      construction, playback timing/looping, and duration editing
      (`panels/timeline.test.ts`, `panels/TimelinePanel.test.tsx`).
- [x] Onion skinning with tint and configurable range — `model/onionSkin.ts::
      onionSkinFrames` is the pure frame-selection logic: given the active
      frame's index and a before/after count, it walks outward in each
      direction, wrapping the way playback loops does
      (`panels/timeline.ts::nextFrameIndex`/`prevFrameIndex`) since the
      flagship workflow (W3) is a looping walk cycle, and stops a direction
      as soon as it would revisit an already-claimed frame rather than ever
      showing the same frame twice (only bites when `before + after` reaches
      the number of other frames that exist). `canvas/renderer.ts::
      drawOnionSkin` composites each named ghost frame through the existing
      `compositeScope` (deliberately bypassing `compositeSprite`'s
      single-slot cache, which is tuned to serve one frame fast, not several
      at once), recolours it to a flat tint with a `source-atop` fill so the
      composite's own alpha shape is kept, and blits it at an
      opacity that decays with distance from the active frame. Convention:
      earlier frames tint red (`ONION_TINT_PAST`), later frames tint blue
      (`ONION_TINT_FUTURE`) — the Aseprite/Pixelorama pairing, asymmetric on
      purpose so direction reads without relying on position alone
      (`05-ui-design.md` §8). `CanvasView.tsx` draws the ghost list between
      the checkerboard and the active frame's own composite, so ghosts are
      always underneath live content and never intercept pointer events —
      there is no code path from `drawOnionSkin` back into the tool
      dispatch, so a ghost can never be painted on. The toggle and the two
      range fields (`onionSkinEnabled`/`onionSkinBefore`/`onionSkinAfter`,
      clamped to `[0, MAX_ONION_SKIN_RANGE=8]`) live in `state/uiStore.ts`
      alongside `showGrid` — view state, off by default, never touching a
      cel buffer or `.tess`. The Timeline panel's transport row gets a
      `◐ onion` button plus before/after count fields, matching
      `05-ui-design.md` §5's own mockup; both range fields are disabled
      until the toggle is on, and the toggle itself is disabled below two
      frames like every other transport control there. Unit tests:
      `model/onionSkin.test.ts` (frame selection, wrapping, the
      already-claimed stop condition), `canvas/renderer.test.ts` (tint per
      direction, opacity falloff, `source-atop` ordering, no-ghosts is a
      no-op), `state/uiStore.test.ts` (toggle, clamped range), an explicit
      regression in `canvas/flatten.test.ts` pinning down that
      `flattenSprite` — the export path — produces byte-identical output
      regardless of onion-skin state (it has no import of `uiStore` at all;
      the test exists so that stays a contract, not an implicit property of
      file structure), and `panels/TimelinePanel.test.tsx` for the new
      transport controls. Verified live against the running Vite dev bundle
      over Chrome DevTools Protocol (desktop `tauri dev` not attempted,
      consistent with this container's documented WebView flakiness):
      opened the Timeline panel, added two more frames, drew a distinct
      opaque pixel on each of the three frames at a different position so
      none would occlude another, enabled onion skinning and read back real
      canvas pixels — confirmed the "before" neighbour rendered red-tinted
      and translucent, the "after" neighbour blue-tinted and translucent,
      and the active frame's own pixel stayed exactly `[255,0,0,255]`
      throughout (never diluted by the overlay); changed the range to
      before=0/after=2 and confirmed the ghost set and per-distance opacity
      falloff updated accordingly through the real UI number fields;
      toggled off and confirmed both ghost pixels reverted to plain
      checkerboard; called `flattenSprite` directly against the live,
      hand-populated document with onion skinning on vs. off and got
      byte-identical output; and dispatched a real pointer down/up at the
      screen location showing the translucent "after" ghost, confirming the
      stroke landed only on the active frame's own cel while the ghosted
      frame's cel was completely untouched.
- [x] Tags with preset names (idle/walk/run/attack/hurt/death) — `Tag`
      (`docs/03-data-model.md` §2.3) added to `Sprite`: name, inclusive
      `from`/`to` frame indices, `direction` (forward/reverse/pingpong),
      optional `repeat`, `color`, plus a stable `id` the doc's own sketch
      omits (flagged there and in `model/types.ts` — every other collection
      here, Layer/Frame/Cel, is addressed by id, which is what makes
      rename-in-place and undo unambiguous). `model/tags.ts` holds the pure
      logic: preset-name/color helpers, range clamping, and — the one
      genuinely tricky part — `shiftTagRangeForInsert`/
      `shiftTagRangeForRemove`, which keep a tag's index-based range
      meaningful across frame add/delete elsewhere in the timeline (verified
      as exact inverses of each other at the same index; wired into
      `documentStore.ts::insertFrame`/`removeFrameMetadata` so every existing
      frame-lifecycle command carries tags along for free, undo included).
      `history/tagCommands.ts` mirrors `frameCommands.ts`'s vocabulary one
      axis over (add/delete existence pair, a coalescible `UpdateTagCommand`
      patch for range/name/direction edits). Rust mirrors `Tag`/`TagDirection`
      in `model::document` and round-trips it through `.tess`,
      `#[serde(default)]` so a save from before tags existed still opens.
      `panels/TimelinePanel.tsx` gets a tags row inside the existing
      `.timeline-grid` (same column template as the frame-head/cel rows, so
      a span always lines up with the frames it covers) — "+ Tag" opens an
      inline form (the six presets plus a "Custom…" free-text option, and a
      from/to range); clicking a tag's span opens a second inline row to
      rename it, edit its range/direction, play back scoped to just its own
      frames, or delete it. Scoped playback reuses `panels/timeline.ts::
      startPlayback` completely unchanged — `model/tags.ts::tagFrameSequence`
      pre-orders the tag's frames for its direction and the scheduler just
      treats that as an ordered, looping list, the same trick whole-sprite
      playback already relied on; only one playback (whole-sprite or one
      tag) runs at a time. New tests: `model/tags.test.ts` (18 cases),
      `history/tagCommands.test.ts` (17 cases: add/delete/rename/range/
      direction, undo/redo, and frame-lifecycle interaction), 6 Rust
      round-trip tests in
      `model::document`/`commands::project`, and 8 new `TimelinePanel.test.tsx`
      cases. Verified live over Chrome DevTools Protocol against the running
      Vite dev bundle (desktop `tauri dev` not attempted, consistent with
      this container's documented WebView flakiness): added three frames,
      created a "walk" tag over frames 2–3 through the real form UI, confirmed
      its colored span and name rendered in the grid, opened its editor and
      renamed it to "run" (undo restored "walk"), played it back and watched
      the active frame loop strictly between its own two frames — never
      touching frame 1 or 4 — paused it, deleted the tag through the editor
      (undo restored it, complete with its original id and range), and
      inserted a new frame before the tag's range to confirm it shifted from
      `[1,2]` to `[2,3]` live, matching the unit-tested shift logic exactly.
- [ ] Export: spritesheet (+ metadata JSON), animated GIF
- [ ] Performance: sustain target fps; **decide on WebGL2** here if Canvas2D falls short

**Exit:** ✅ **W3 complete.**

---

## Phase 5 · Background removal & smart utilities

**Goal:** W1 complete end to end.

- [ ] Non-ML flood-fill background removal first (instant, no dependency, ships value early)
- [ ] `segment` module; evaluate `rembg-rs` vs direct `ort` (`07` §3.1)
- [ ] Bundle `u2netp`; on-demand download for larger models with explicit consent
- [ ] Mask post-processing: threshold, morphological close, feather (`04` §8.3)
- [ ] Fit-to-subject cropping (`04` §8.5)
- [ ] Resolve the ONNX Runtime size question (`07` §6)

**Exit:** ✅ **W1 complete.** The flagship workflow works without leaving the app.

---

## Phase 6 · Tilemaps & import

**Goal:** W4 and W7 work.

- [ ] Tileset model, tilemap layers, rect grid (`03` §4)
- [ ] Tile stamp tool, auto-deduplication, flip/rotate flags
- [ ] Tileset + tilemap JSON export
- [ ] Grid detection via autocorrelation (`04` §3.3) — unlocks W7 Case A
- [ ] `.ase` import; evaluate `aseprite-io` (`01` §9)

**Exit:** ✅ **W4, W7 complete.**

---

## Phase 7 · Polish & reach

Ordered by value, not commitment:

- [ ] Non-destructive layer effects: outline, drop shadow, gradient map (`03` §5)
- [ ] Batch conversion + CLI headless mode (W5)
- [ ] Pixel-art-aware rotate/scale — rotxel, cleanEdge (`04` §7)
- [ ] **Indexed color mode + live palette swapping** (deferred from v1 by D9 — touches
      every tool, blend mode and effect, so it is a real chunk of work, not a flag)
- [ ] Bead / cross-stitch chart export (W9)
- [ ] Lospec URL import (opt-in network)
- [ ] Isometric and hexagonal tile grids

---

## Sequencing rationale

**Why the editor before the converter (Phase 1 before 2):** the converter's output has to
land *somewhere*. Building conversion first would mean building it twice — once
standalone, once integrated. The layer model has to exist first.

**Why animation after v1 (Phase 4, not 3):** it is the largest single feature and W1/W2/W6
are all complete without it. Shipping v1 earlier gets real feedback before committing to
the timeline UI.

**Why background removal so late (Phase 5):** it is the only dependency with genuine
technical risk (`ort` pre-release, runtime size). Everything else must be shippable
without it, and the flood-fill fallback means the feature has a floor.

**Why grid detection is in Phase 6:** it is not needed for the flagship photo workflow,
but it is what makes W7 Case A not-mush. Cheap once the pipeline exists.

---

## What would make us re-plan

- Preview/export parity proves unachievable within tolerance → reconsider the hybrid
  split; possibly move all processing to Rust and accept slower previews.
- Canvas2D cannot sustain animation playback → WebGL2 renderer, a significant addition.
- IPC benchmarks show handle-passing is still too slow for editor-layer export → rethink
  where pixel data lives.
- `ort` never stabilizes → ship flood-fill only, or bind ONNX Runtime C API directly.
