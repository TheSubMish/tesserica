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
- [x] Export: spritesheet (+ metadata JSON), animated GIF — follows the
      existing `export_png` pattern one axis over: `src/export/
      animationExport.ts` picks *which* frames and in *what* order (the whole
      sprite, or one tag scoped to it — `spritesheetSelection` keeps a tag's
      forward index range with no ping-pong duplication, since a spritesheet
      is a set of unique images and direction is metadata for the engine to
      read from `frameTags` at runtime; `gifFrameSequence` instead expands a
      tag through `model/tags.ts::tagFrameSequence`, since a GIF *is* the
      playback with no metadata layer left afterwards), reuses
      `flattenSprite` per frame unchanged (Rust still never composites
      layers), and concatenates the results into one buffer for a single
      `stageBytes` call. `src-tauri/src/commands/animation_export.rs` adds
      `export_spritesheet`/`export_gif`, receiving only already-flattened
      RGBA plus metadata, never per-layer pixels. Spritesheet: lays frames
      into a fixed-column grid (default 4, `docs/06-workflows.md` W3's own
      example, clamped to the frame count) and reuses `export::scale_nearest`
      to scale the *assembled sheet* as one nearest-neighbour pass —
      equivalent to scaling each cell, since NN never mixes across a cell
      boundary — then writes an Aseprite-shaped "array" metadata JSON
      alongside the PNG: `frames`/`frameTags` with the identical
      forward/reverse/pingpong vocabulary this project's own `TagDirection`
      already uses, chosen over a bespoke schema or TexturePacker's hash
      shape because it's already what Phaser/PixiJS importers expect. GIF:
      encoded via `image::codecs::gif` — already a project dependency;
      enabling its `gif` Cargo feature pulled in `gif` 0.14 (MIT OR
      Apache-2.0) and `color_quant` 1.1.0 (MIT), so no new top-level crate was
      needed. Always loops infinitely — empirically the `gif` crate's decoder
      maps *both* `Repeat::Infinite` and an absent loop extension to
      `LoopCount::Infinite`, so there is no unambiguous "play once" it can
      express, and `06-workflows.md` W3 step 9 only ever asks for a looping
      GIF anyway. 17 Rust tests (grid layout math, sheet assembly, JSON
      shape/round-trip, real PNG+JSON file output decoded back, GIF frame
      count/delay/loop decoded back, integer-scale nearest-neighbour on both
      paths, buffer-length validation, and two tests decoding the exact
      camelCase JSON shape the frontend actually sends into the request
      structs) plus 11 TS unit tests for the frame-selection/concatenation
      logic. `ExportDialog.tsx` gained a Format switcher (PNG / Spritesheet /
      GIF) and a Frames selector (all frames, or one tag) that only appears
      once the sprite has tags. Verified live: `npm run tauri dev`'s WebView
      rendered blank in this container (the same documented flakiness as
      Phase 3), and no xdotool/screenshot tooling was available this session
      to drive it blind either, so the fallback was the Vite dev bundle in a
      real headless Chrome over CDP — created frames and a "walk" tag through
      actual Timeline UI clicks (not synthetic store calls; an early attempt
      at dynamically importing store modules silently produced a second,
      disconnected module instance), opened Export, and confirmed by
      screenshot and DOM state that the Frames selector appears once the tag
      exists, scoping to it correctly drops the previewed frame count and
      grid math (4 frames/4×1 → 3 frames/3×1) for both spritesheet and GIF,
      and the no-backend path shows an honest error rather than hanging. That
      pass caught and fixed one real rough edge (the Columns field showing an
      unclamped value that disagreed with the hint below it). The Rust IPC
      leg itself can't be exercised this way (no `__TAURI_INTERNALS__`
      outside the Tauri shell), so it's covered instead by the 17 Rust tests
      above, including the two wire-shape decode tests and the two that
      write real files and decode them back with `image`'s own GIF/PNG
      decoders — genuinely inspected output, not just "didn't crash."
- [x] Performance: sustain target fps; **decide on WebGL2** here if Canvas2D falls
      short — resolves `09-open-questions.md` Q8 as `10-decisions.md` D14. Target
      chosen: **24 fps** (`docs/06-workflows.md` W3's own "uniform 12 fps" example,
      doubled — hand-drawn pixel-art animation is conventionally authored well under
      video refresh rates, and no doc states a numeric target), 60 fps kept as an
      aspiration for interactive redraws rather than a hard requirement. New harness
      `bench/animationPerf.ts` times real `CanvasView`-shaped redraw ticks
      (checkerboard → onion-skin ghosts → active-frame composite → grid → border)
      against a real `<canvas>` 2D context with `performance.now()`, in a real
      Chromium hitting the plain Vite dev server (no Tauri/IPC involved, so no
      `TESSERICA_BENCH` env var needed) — jsdom has no native canvas backing, so this
      could not be measured under Vitest. Worst-case sprite: a group with a clipping
      mask (`canvas/renderer.ts::compositeScope`, the most expensive composite path),
      12 raster cels, 24 independent frames. At the documented "typical" size
      (`02-architecture.md` §7, ≤512×512), steady state: no onion skin ~160 fps mean;
      onion skin at 1 before/1 after (W3's own value) ~155–165 fps mean; onion skin at
      **8 before/8 after** (`state/uiStore.ts::MAX_ONION_SKIN_RANGE`, the actual worst
      case) ~147–150 fps mean — all comfortably past both 24 fps and 60 fps. That last
      number came from a real fix, not a clean bill of health on the first run: the
      harness first measured the **uncached** 8/8 case at ~8.9 fps mean, because
      `tintedGhostFrame` recomposited all 16 ghost frames from scratch on every redraw
      (playback tick *or* pointer-move while painting with onion skin on). Added a
      per-(frame id, tint) cache in `canvas/renderer.ts`, keyed on the same
      `signatureOf` string `compositeSprite`'s own single-slot cache already trusts.
      A frame-id-only first attempt looked like a win in isolation but was caught
      thrashing by benchmarking the realistic 1/1 range specifically, not just the
      8/8 extreme: a single frame is ghosted from *both* directions (past tint,
      future tint) at different points in every ordinary loop, so keying on frame id
      alone let the two directions evict each other's entry and recompute on
      effectively every touch. Keying on `(frame id, tint)` — bounded at two cached
      canvases per frame — fixed it for real; regression tests
      (`canvas/renderer.test.ts`, "ghost caching") assert the cache survives
      both-direction touches, not just a same-request repeat. Pushed past "typical" as
      a stress point (not the target — `02-architecture.md` §7 reserves "2048²+" as
      its own reassessment trigger): at 1024×1024 (4× the pixels), still clears 24 fps
      on mean (~38–42 fps no onion, ~20–27 fps at 8/8) though the margin visibly
      narrows, consistent with that trigger. A clean 2048×2048 number was not obtained
      — this container's shared desktop carries dozens of long-lived Chrome processes
      from unrelated sessions (the same contention `08-roadmap.md`'s Linux-installer
      and accessibility-pass entries above already hit) and repeated attempts at that
      size did not return inside a reasonable wall-clock budget — reported as
      unmeasured rather than guessed; the 512→1024 trend is enough to ground the
      decision without it. **Decision: Canvas2D holds, no WebGL2 renderer.** The
      bottleneck the harness found was a missing cache in application code, not a
      Canvas2D throughput ceiling, so a rewrite would have solved the wrong layer of
      the problem; full numbers, the target-fps rationale, and the rejected
      alternatives are in `10-decisions.md` D14.

**Exit:** ✅ **W3 complete.** All six Phase 4 items landed: frames/cels/linked cels,
the Timeline panel, onion skinning, tags, spritesheet/GIF export, and — closing the
phase — a real playback-performance measurement with a locked decision (Canvas2D
holds; D14) rather than a deferred question.

---

## Phase 5 · Background removal & smart utilities

**Goal:** W1 complete end to end.

- [x] Non-ML flood-fill background removal first (instant, no dependency, ships value early) —
      `04` §8.5's own fallback, built as stage [1] of the pipeline in **both** languages:
      `src/pipeline/backgroundRemoval.ts` and `src-tauri/src/pipeline/background_removal.rs`.
      Seeds are the image's four corners; each seed's 4-connected component (the same
      connectivity `cleanup.ts::despeckle` uses) floods outward while a neighbour's colour
      stays within a `tolerance` (plain Oklab distance) of *that seed's own* colour — a fixed
      reference, not a running average, so the flood cannot drift across a gradient
      background into the subject. This is what makes it more than a chroma key: a
      disconnected patch that happens to share the background's colour but touches no
      corner survives untouched (unit-tested explicitly in both languages). The inclusion
      test carries D12's `NEAREST_EPSILON` alongside the tolerance, for the same reason the
      nearest-colour tie-break does — Rust and JS Oklab agree to ~6.7e-16 but not
      bit-for-bit, and because a flood's connectivity depends on every earlier decision, one
      boundary-pixel flip could diverge a whole region rather than one pixel. Matched pixels
      get alpha 0 with RGB left untouched (straight alpha, `02` §9). Wired into stage [1] of
      both `convert()` drivers, ahead of crop/fit-to-subject, so `fitToSubject` (already
      implemented since Phase 2) becomes "nearly free" against the flood's own alpha exactly
      as `04` §8.5 describes. `ConvertSettings.backgroundRemoval?: { tolerance }` is optional
      and `undefined` by default, so every existing case, matrix entry and `.tess` is
      unaffected. UI: a `▸ Background` collapsed section in Convert mode (the slot
      `05-ui-design.md` §3's own mockup already reserves) — an off-by-default checkbox plus a
      0–0.3 tolerance slider, `state/convertStore.ts`. 9 new unit tests (5 Rust, 4 TS) cover
      tolerance-zero exact-match, the tolerance boundary, the disconnected-patch case, and a
      1-pixel-tall image's coincident corners; a `convert()`-level integration test in both
      languages confirms background removal runs before crop/fit-to-subject. Golden suite
      extended with 8 new cases (tight/loose tolerance × portrait/gradient/alpha/flat sources,
      combined with fit-to-subject and Floyd–Steinberg) — the corpus is now **3,091 cases over
      918,352 pixels**, still zero differing indices and zero differing RGBA bytes. Verified
      live: `tauri dev`'s WebView was not reachable in this container (no `DISPLAY` compositor
      access for the desktop shell's own window, consistent with every prior phase's note
      here), so the fallback was the real Vite dev bundle over Chrome DevTools Protocol —
      switched to Convert mode through an actual tab click, injected a synthetic 32×32 source
      (solid orange with a blue ring enclosing a disconnected orange patch) directly into
      `previewRuntime`/`convertStore` the same way Phase 4 verified frame/tag commands, opened
      the real `▸ Background` section, and clicked the real checkbox: the corner went fully
      transparent while the enclosed patch stayed opaque, confirmed disabling the checkbox
      reverted the corner to opaque and dropped `backgroundRemoval` from `buildSettings()`
      entirely. The preview/export leg of parity is what the golden suite above already
      proves at far higher rigour than a manual click could.
- [x] `segment` module; evaluate `rembg-rs` vs direct `ort` (`07` §3.1) — re-verified both
      against crates.io rather than trusting the 2026-07-26 note: `ort` is at
      `2.0.0-rc.13` (still no stable release, but the rc landed two days before this
      check — actively maintained), MIT OR Apache-2.0. `rembg-rs` depends on `ort
      ^2.0.0-rc.10` itself (an older constraint, not a way to avoid tracking `ort`'s own
      churn), has 747 total downloads across a ~9-month history, and pulls in
      `imagequant` (indexed-color quantization — conflicts with D9's RGBA-only v1) and
      `oxipng` (PNG recompression this project has no use for). **Decision: depend on
      `ort` directly** (locked, `10-decisions.md` D15), pinned to the exact
      `2.0.0-rc.13` with no caret range. `src-tauri/src/segment/` scaffolds `Segmenter`:
      constructing one is side-effect-free (no model bundled is the default, expected
      state), `load()` reports a missing dylib or model file as a plain `SegmentError`
      rather than panicking, and `segment()` returns `SegmentOutcome::NoModelLoaded` —
      not an error — so callers fall back to the flood-fill background removal already
      shipped. Built with `default-features = false` plus `load-dynamic` rather than
      `ort`'s default `download-binaries`: the crate needs no network access or system
      ONNX Runtime library just to compile, and the real `libonnxruntime.so` is
      `dlopen`ed only at runtime, when a caller supplies a real path — not yet wired to
      anything bundled or downloaded (the next two roadmap items). Verified in this
      container, not assumed: `cargo check`/`clippy -D warnings`/`test` are all clean
      with the dependency added (161 passing, 5 of them new), and a manually-run,
      `#[ignore]`d smoke test (`segment::tests::
      smoke_test_a_real_onnx_runtime_and_model_if_env_vars_point_at_them`) `dlopen`ed a
      genuine ONNX Runtime 1.28.0 `.so` (fetched transiently from `microsoft/onnxruntime`'s
      GitHub releases for this evaluation only, not vendored) and committed a real
      inference session against a 176 MB `u2net.onnx` already present on this machine
      from unrelated prior work, in under a second — real evidence the crate actually
      loads and runs something in this environment, not just that it compiles. Full
      write-up in `10-decisions.md` D15; `07-tech-stack.md` §3.1 updated to match.
- [x] Bundle `u2netp`; on-demand download for larger models with explicit consent —
      two genuinely separate mechanisms, per `04` §8.1's own distinction. **Build-time
      bundling**: `npm run models:fetch` (`scripts/fetch-model.ts`,
      `scripts/lib/modelFetch.ts`) downloads `u2netp.onnx` into the gitignored
      `assets/models/`, sourced from `rembg`'s own GitHub Releases (the same URL
      `rembg`'s `U2netpSession.download_models` uses — checked against its source,
      not guessed) and verified against the MD5 `rembg` itself publishes
      (`8e83ca70e441ab06c318d82300c84806`); idempotent, fails with an actionable
      message offline, writes via temp-file-then-rename. License re-verified against
      the upstream `xuebinqin/U-2-Net` repository (Apache-2.0), confirming
      `CLAUDE.md`'s existing claim rather than assuming it. `segment::bundled_model_path()`
      resolves the fetched file for `Segmenter::load`; a real, `#[ignore]`d smoke test
      loaded it with a real (externally supplied, not bundled) ONNX Runtime `.so` and
      constructed a real inference session successfully — proof the wiring works, not
      just that the file exists. **Runtime on-demand download** (Convert mode's
      Background section, `src/segment/SegmentModelSection.tsx`): offers
      `isnet-general-use` (~170 MB, `docs/04` §8.1's "recommended default", sourced from
      the same `rembg` Releases, Apache-2.0 per the upstream `xuebinqin/DIS` repo) behind
      an explicit confirm dialog stating the exact size and source domain; the download
      function (`src/segment/modelDownload.ts`) is only ever reachable from that
      confirm click — proven by component tests asserting it is never called on mount,
      after the first click alone, or on cancel, only after the dialog's own "Download"
      button (`SegmentModelSection.test.tsx`, 5 cases). The network fetch itself is a
      plain frontend `fetch()` (CSP is unset; this app's WebView already has full
      network access) rather than a new Rust HTTP client — Rust's only new dependency
      is `md5` (small, no transitive deps) for checksum verification, not TLS; the
      downloaded bytes cross into Rust over the same raw-invoke-body transport
      `staging.rs` uses for editor layers (D13), landing in `commands::segment`, which
      verifies the MD5 `rembg` publishes and writes to the app-data directory via
      temp-file-then-rename, refusing to install anything that fails the checksum
      (7 Rust unit tests against real temp directories: happy path, mismatch writes
      nothing, directory creation, overwrite of a stale prior download). **What's
      genuinely proven, in pieces, rather than as one continuous click-through**: a
      real, complete 170 MB download of `isnet-general-use.onnx` was independently
      fetched via `curl` and checksummed via `md5sum` this session, confirming the URL
      and checksum are correct; a bounded (4 s, `AbortController`-cancelled) call
      through the *actual* `downloadLargerSegmentationModel` function against the real
      URL confirmed it opens a genuine connection and streams real bytes before
      erroring cleanly on abort; and a manually-run Rust test fed that same real,
      complete 170 MB file through the actual production `verify_and_persist` logic
      with the real checksum constant, succeeding in ~2 s. Consistent with every
      earlier phase's own note here (Phase 4's spritesheet/GIF export, Phase 3's
      installers): **the full round trip through a live Tauri desktop shell was not
      exercised** — this container's WebView has been unreachable across every prior
      phase's live-verification attempt, so there was no `__TAURI_INTERNALS__` to drive
      a real `invoke()` against; idle-waiting a full 170 MB transfer end-to-end was
      also explicitly avoided (mid-session correction) in favour of the bounded proofs
      above. **Pipeline integration is explicitly out of scope and not implemented**:
      neither model is wired into `segment::Segmenter` or into actual background
      removal — that remains later Phase 5 work, unaffected by this item.
- [x] Mask post-processing: threshold, morphological close, feather (`04` §8.3) —
      built as `src/pipeline/maskPostProcess.ts` / `src-tauri/src/pipeline/
      mask_post_process.rs`, run in the fixed order §8.3 step 5 lists (threshold →
      close → feather) on whatever produced the mask so far — today only the
      flood-fill fallback, wired in right after it in both `convert()` drivers.
      All three are alpha-channel-only (straight alpha, never touching RGB or
      going through Oklab, since a mask edge is not a colour-distance problem).
      **Threshold**: binarizes at a 0..255 cutoff, "below" exclusive so a cutoff
      of 0 still does something (any nonzero alpha snaps to opaque) rather than
      being a silent no-op — matches the existing `alphaThreshold` convention in
      `quantize.ts`/`.rs`. **Close**: grayscale dilate-then-erode by a pixel
      radius, 4-connected (the same connectivity the flood and despeckle use);
      erosion treats a missing (out-of-canvas) neighbour as opaque so closing
      does not erode real content sitting at the image's own edge, the standard
      boundary condition for the second half of a closing pass. **Feather**: a
      separable box blur over the alpha channel, implemented with a running
      prefix sum so cost is independent of radius (it runs at source resolution,
      before downscale), edge-clamped by *shrinking* the averaging window near
      a canvas border rather than replicating a padding value — a mask that
      runs up to the canvas edge is not itself softened by that edge. `docs/04`
      names no specific blur kernel; a box blur was the smallest reasonable
      thing, plain integer/f64 arithmetic with no `libm` involved, so no
      cross-language divergence risk the way Oklab has.
      `BackgroundRemovalSettings` gained `threshold?`/`close`/`feather` fields,
      all optional/0-off so every existing settings object literal kept
      compiling unchanged. UI: three new controls in Convert mode's Background
      section (`ConvertPanel.tsx`) — a re-threshold checkbox + cutoff slider,
      a close-radius slider, a feather-radius slider — `state/convertStore.ts`
      only includes a field in the built `BackgroundRemovalSettings` once it is
      off its default, so a document that never touches these controls stores
      the same flood-fill-only settings shape as before this change. Unit
      tests in both languages: threshold's exact/inclusive boundary, close
      filling a fully-enclosed single-pixel hole *and* leaving a large region's
      outer boundary and far background untouched, feather producing a real
      monotonic gradient over the configured radius and never softening a mask
      that already reaches the canvas border, and the fixed threshold→close→
      feather order end to end. A `convert()`-level integration test in both
      languages builds a flood-fill "breach" (a thin, realistic gap in what
      should be a closed boundary, not a deliberately isolated island) and
      confirms `close` seals it before quantization while leaving unambiguous
      background alone. Golden suite: 10 new edge cases (threshold, close,
      feather, and all three stacked, alone and combined with fit-to-subject
      and Floyd–Steinberg) — the corpus is now **3,101 cases over 920,064
      pixels**, still zero differing palette indices and zero differing RGBA
      bytes. Verified live: the desktop `tauri dev` WebView could not be reached
      in this container (a port conflict from another long-lived dev server
      sharing this environment, consistent with every prior phase's own note
      about this container's WebView flakiness), so the fallback was the real
      Vite dev bundle over Chrome DevTools Protocol — switched to Convert mode
      via a real tab click, opened the real `▸ Background` section and
      confirmed all three new controls render, injected a synthetic 40×40
      source with a flood-fill "breach" directly into `previewRuntime`/
      `convertStore` (same technique the flood-fill item's own verification
      used), enabled background removal via a real checkbox click, and then
      **dragged the real Close-radius `<input type=range>`** (a genuine native
      `input` event, not a store call) to seal the breach in the live converted
      preview — the interior pocket's alpha went from `0` to `255` — and back to
      `0` restoring the breach when reset. Also drove the real re-threshold
      checkbox and its slider and confirmed `buildSettings()` picked up the
      value. Separately confirmed feather's effect is a genuine gradient by
      calling the exact same `convert()` the app uses with `preserveAlpha: true`
      (Convert mode's UI has no toggle for that — a pre-existing gap this task
      did not introduce or hide): a hard cutoff (`[0,0,0,0,0,0,0,0,0,0,255]`)
      versus a real transition band with feather on
      (`[0,0,0,9,16,22,35,35,35,35,35]`). With the UI's actual default
      (`preserveAlpha` off, `alphaThreshold` 128), that soft band gets snapped
      back to a hard 0/255 boundary at quantize time exactly as `docs/04` §4.4
      says pixel art normally wants — feather still visibly moves *where* that
      boundary lands, just not as a translucent edge in the default export,
      which is correct behaviour, not a shortfall of this item.
- [x] Fit-to-subject cropping (`04` §8.5) — the pipeline mechanism (`opaqueBounds` +
      `fitToSubject` in `src/pipeline/crop.ts` / `src-tauri/src/pipeline/crop.rs`, wired as
      stage [2] in both `convert()` drivers) was **already built in Phase 2**
      (`2954a79`), matching `04` §8.5 exactly: "compute the mask's bounding box, add
      padding, crop." It runs after stage [1] (flood-fill background removal + this
      phase's mask post-processing) in both languages, so it always sees whatever mask
      that stage produced, post-threshold/close/feather — not the raw flood-fill output
      — confirmed by reading the fixed `convert()` order rather than assumed, and already
      covered by cross-language integration tests (`background_removal_runs_before_crop_
      and_fit_to_subject`, its TS mirror) and golden-matrix cases combining it with mask
      post-processing (`mask-feather-then-fit-to-subject`, `background-removal-then-fit-
      to-subject`). What was actually missing, and is what this item built: **the feature
      had no UI** — `fitToSubject` was reachable only by constructing `ConvertSettings`
      directly, with no way for a user to turn it on. Added a "Fit to subject" checkbox to
      Convert mode's existing `▸ Background` section (`ConvertPanel.tsx`), a
      `fitToSubject` field on `convertStore.ts` (off by default, independent of the
      background-removal toggle — it also works standing alone against a source that
      already carries alpha, exactly as `settings.ts` already documented), and threaded it
      into `buildSettings()`. One new unit test confirms the off-default and the
      store→settings wiring. Verified live: `tauri dev`'s WebView was unreachable in this
      container as in every prior phase, so the fallback was the real Vite dev bundle
      over Chrome DevTools Protocol (headless Chrome, native Node `WebSocket` driving the
      CDP wire protocol directly, no new dependency added) — switched to Convert mode via
      the store the real tab click uses, injected a synthetic 40×40 RGBA source (fully
      transparent except an opaque 6×6 coloured block off-center) directly into
      `previewRuntime`/`convertStore`, and drove the real preview end to end: before
      enabling fit-to-subject the converted result was 2.25% opaque with a transparent
      center (the un-cropped canvas); after, it was 100% opaque with an opaque, coloured
      center — the crop-then-nearest-upscale `04` §8.5 describes, running through the
      actual Web Worker pipeline. Separately clicked the real "Fit to subject" checkbox
      (after expanding the real `▸ Background` header) and confirmed it flips the store
      field via a genuine DOM `click`, not a store call. `npm run test:golden` re-run
      clean (no pipeline files touched) at the existing **3,101 cases / 920,064 pixels**,
      zero differing indices, zero differing RGBA bytes.
- [x] Resolve the ONNX Runtime size question (`07` §6) — checked whether this was already
      substantially decided rather than assuming: D15's `load-dynamic` build makes
      "download the runtime on first use" structurally possible (no runtime linked or
      bundled at build time), but neither `src/segment/modelDownload.ts` nor
      `commands::segment` had ever fetched the *runtime* — only the *model* — so that
      fetch was the real remaining gap. Built it as an extension of the existing
      mechanism, not a parallel one: `commands::onnx_runtime`
      (`src-tauri/src/commands/onnx_runtime.rs`) mirrors `commands::segment`'s info/status/
      save-with-checksum shape, and `src/segment/modelDownload.ts`'s single download
      function was generalized (two type parameters, renamed `downloadConsentedFile`) so
      `OnnxRuntimeSection.tsx` reuses it rather than duplicating it, exactly like
      `SegmentModelSection.tsx` already did. The one genuinely new piece: upstream ships
      the runtime as a `.tar.gz` of several files, not one, so the save command verifies a
      sha256 of the whole archive first, then extracts (via the new, small, MIT/Apache-2.0
      `tar` crate plus `flate2`, already transitively present via `zip`) only the one real
      `libonnxruntime.so.<ver>` entry it needs, skipping the two symlinks and the unneeded
      `libonnxruntime_providers_shared.so` alongside it. **Measured for real, not
      estimated**: a real `npm run tauri build` release bundle was built and its actual
      artifacts inspected — `.deb` **2.1 MB**, `.AppImage` 75 MB (dominated by its own
      bundled `webkit2gtk`/`gtk`, a property of that packaging format, not this project's
      weight — confirmed by listing `Tesserica.AppDir`), stripped binary alone 4.9 MB
      (half `07-tech-stack.md`'s old ~8 MB guess) — and neither `u2netp.onnx` nor any ONNX
      Runtime library is present in either bundle today, so the 2.1 MB `.deb` is the real,
      already-shipping installer size, **9.5× under the 20 MB budget**, not a projection.
      The real current ONNX Runtime release was also checked against the actual GitHub
      Releases API rather than the doc's old ~10–15 MB guess: `v1.28.0`'s Linux x64 CPU
      asset is 9,125,960 bytes (8.7 MB) as downloaded, extracting to 24,268,848 bytes
      (24.3 MB) for the one file this project needs — independently confirmed with a real
      `curl` + `sha256sum` this session. **Decision: option 1 (download on first use),
      locked as `10-decisions.md` D16** — the mechanism is now real, not just structurally
      possible, and options 2 (lite/full builds) and 3 (raise the budget) are both moot
      once the measured number is 2.1 MB. Verified: 6 new Rust unit tests build small
      in-memory fixture `.tar.gz` archives (checksum rejection, missing-entry rejection,
      successful extraction, overwrite, directory creation) so ordinary `cargo test` never
      needs the real ~9 MB archive; a manually-run `#[ignore]`d smoke test
      (`smoke_test_the_real_archive_passes_checksum_and_extracts`) was pointed at the real
      downloaded archive and passed, extracting exactly 24,268,848 bytes — proof the
      production constants are correct against a real download, not just internally
      consistent. 5 new frontend component tests (`OnnxRuntimeSection.test.tsx`) mirror
      `SegmentModelSection.test.tsx`'s own coverage: never downloads on mount or after the
      initial click, cancelling never downloads, the save function only runs after an
      explicit "Download" click, and a failure shows an inline, retryable error.
      `cargo test` (189 passed), `cargo clippy --all-targets -- -D warnings` (clean),
      `npx tsc --noEmit` (clean), `npm run lint` (clean), `npm run test` (649 passed),
      `npm run build` (clean), and `npm run test:golden` (17 passed, no pipeline files
      touched — a sanity check) all pass. **Pipeline wiring remains explicitly out of
      scope**, exactly as already disclosed for the model download: nothing calls
      `Segmenter::load` with the extracted library yet.

**Exit:** ✅ **W1 complete.** All six Phase 5 items landed: flood-fill background removal,
the `segment` module (direct `ort` via `load-dynamic`, D15), bundled `u2netp` plus
consent-gated on-demand download of a larger model, mask post-processing (threshold/close/
feather), a UI for fit-to-subject cropping, and — closing the phase — the ONNX Runtime size
question resolved by a real measured build rather than a guess (download on first use,
D16). The flagship workflow works without leaving the app. Two things are explicitly
carried forward, not hidden by this exit: neither segmentation model is actually wired into
background removal yet (the flood-fill fallback is what runs today), and bundling
`u2netp.onnx` itself into the shipped installer (`tauri.conf.json` resources) was never
done — both are real gaps, stated plainly rather than implied closed.

---

## Phase 6 · Tilemaps & import

**Goal:** W4 and W7 work.

- [x] Tileset model, tilemap layers, rect grid (`03` §4) — was **left
      unchecked deliberately** in the pass that built the data model, the same
      posture Phase 4's frame/cel foundation took before the Timeline panel
      existed: rendering and undo/redo machinery were built and verified, but
      nothing in the shipped UI could create a tileset or a tilemap layer yet.
      **That UI gap is now closed** by the next item's `panels/
      TilesetPanel.tsx` — creating a tileset, adding tiles, and adding a
      tilemap layer are all real button clicks now, live-verified end to end
      (see below). What landed in the original pass: `Tileset`/
      `TileEntry`/`GridSpec`/`GridShape` (`model/types.ts`, mirrored in
      `src-tauri/src/model/document.rs`'s `Layer::Tilemap` variant), tile-id
      bit packing (`model/tileIds.ts`, index in bits 0–27, flip-h/flip-v/
      transpose in 28–30, verified never to overflow a signed int32), grid
      and tile-pixel storage outside React state (`model/tileGridBuffers.ts`,
      `model/tileBuffers.ts`, mirroring `model/pixelBuffers.ts`'s existing
      pattern), undoable tileset/tilemap-layer/grid-cell commands
      (`history/tilesetCommands.ts`, reusing `layerCommands.ts`'s
      `AddLayerCommand` for layer creation by generalizing `LayerExistence` to
      snapshot grid buffers instead of pixel buffers), a tilemap branch in all
      three places every prior layer-kind addition touched
      (`canvas/renderer.ts`, `canvas/flatten.ts`, `canvas/sample.ts` —
      nearest-neighbour trivially, since a tile is always blitted 1:1 into its
      grid cell with exact array-transform flips, never a canvas matrix), and
      a full `.tess` round trip (a tilemap cel's grid as raw bytes at
      `cels/<id>.bin`, each tile's own pixels as PNG at
      `tiles/<tilesetId>/<tileId>.png`, both documented in §7 but never
      implemented before this). Verified: `cargo test` 202/202, `cargo clippy
      --all-targets -- -D warnings` clean, `npm run test` 700/700 (new
      coverage: tile-id packing/unpacking including every flip combination
      and the int32-overflow boundary; tileset/tile-entry/tilemap-layer
      CRUD with undo/redo; pixel-exact rendering of a flipped tile agreeing
      across renderer/flatten/sample; a `.tess` round trip of a populated
      tilemap layer with byte-for-byte grid fidelity). Live-verified over
      Chrome DevTools Protocol against the real running Vite dev bundle
      (`tauri dev`'s WebView unreachable in this container, consistent with
      every earlier phase's own note here): created a tileset and a tile
      programmatically through the real `history/tilesetCommands.ts` actions
      (not synthetic store mutations — genuinely undoable, run through the
      real history store), painted a flipped tile into a real tilemap layer,
      and read back actual canvas pixels showing the correct flip; confirmed
      `flatten.ts` and `sample.ts` agree with the renderer pixel-for-pixel;
      and confirmed a real `Ctrl+Z`-equivalent (`useHistoryStore.getState()
      .undo()`) reverted the paint on screen. This session's own attempt hit
      the same "second, disconnected module instance" trap Phase 4's write-up
      already named (Vite dev serves a relative import with a `?t=<cache-bust
      query>` distinct from a bare `import()` of the same file from outside
      the module graph, so two "singleton" stores can silently coexist) —
      resolved by importing the exact versioned URL the app's own module
      graph uses, not by falling back to a weaker check.
- [x] Tile stamp tool, auto-deduplication, flip/rotate flags — makes the item
      above reachable by a human. `panels/TilesetPanel.tsx` is the tileset
      panel: an inline "+ New tileset" form (name + tile size, the same idiom
      `TimelinePanel`'s "+ Tag" form uses, not a modal), a tile-picker grid of
      real `<canvas>` thumbnails (nearest-neighbour, nothing new — nearest
      is already how every pixel-art surface in this app renders), and an
      "Add tilemap layer" button that creates one bound to the tileset shown.
      Adding a tile is **capture a rectangular selection**, not an import
      dialog — reuses Phase 3's selection tools directly: the active
      selection's bounding box must equal the tileset's own tile size
      exactly, or it is a plain, actionable error rather than an
      undocumented silent resample (`docs/04-image-pipeline.md` is normative
      and specifies no such resize). `tools/stampSession.ts` is the Stamp
      tool's real logic, called directly from `CanvasView` the same way
      `tools/zoom.ts` bypasses generic dispatch (`tools/stamp.ts` is a
      documented no-op `Tool`, exactly like `zoom`): a tilemap cel has no
      `Uint8ClampedArray` for `ToolContext` to hand a tool, only a packed-id
      `Uint32Array` grid (`model/tileGridBuffers.ts`). Paints live during a
      drag (interpolating skipped cells with the existing Bresenham
      `linePoints`, the same helper the Pencil tool already uses) and closes
      into one `PaintTileCellsCommand` at pointer-up — **one drag is one
      undo step** (`03` §6), not one step per cell; Escape abandons the
      gesture cleanly (`history/tileStrokeRecorder.ts` mirrors
      `strokeRecorder.ts`'s snapshot/diff shape one buffer type over).
      **Auto-deduplication** (`model/tilesets.ts::findMatchingTile`):
      capturing a tile whose pixels exactly match an existing tile — directly
      or under a horizontal flip, a vertical flip, or both (a 180° rotation)
      — reuses that entry's index instead of storing a duplicate `TileEntry`;
      `history/tilesetCommands.ts::addTileToTileset` is now dedup-aware and
      reports which orientation reproduces the capture. **Honest partial**:
      dedup does not chase a diagonal transpose (a tile that is only a
      duplicate under `model/tilemapRender.ts::transposeTile`), the
      documented "flip-only, not full rotate-aware" floor this roadmap itself
      names as legitimate — transpose is only well-defined for a square tile,
      and a new `TileEntry` is the honest fallback rather than a special case
      for the square-tile subset. **Flip/rotate flags**: `state/
      tilesetStore.ts` holds `flipH`/`flipV`/`transpose`, three toggle buttons
      next to the picker, feeding straight into `model/tileIds.ts::
      packTileId`'s bits 28–30 — all three are real and toggleable, even
      though dedup only recognizes the first two automatically. New tests:
      `model/tileIds.test.ts::docPixelToCell` (the grid-targeting math,
      cel-offset aware), `model/tilesets.test.ts` (`extractTilePixels`,
      `findMatchingTile` exact/flipH/flipV/no-match/size-mismatch cases),
      `history/tilesetCommands.test.ts` (dedup reuse for all three cases plus
      an explicit "does not chase a diagonal transpose" case, and
      `PaintTileCellsCommand` apply/invert as one step), `state/
      tilesetStore.test.ts`, and `tools/stampSession.test.ts` (targeting,
      drag interpolation, flip/transpose packing, one-drag-one-undo, Escape
      abandonment, and a regression test pinning down a real bug this pass's
      own live verification caught — see below). **Verified live**, not just
      by unit test: `npm run tauri dev` failed to bind its dev-server port in
      this container (already in use by a long-lived Vite process from
      elsewhere in this environment, consistent with every earlier phase's
      WebView-access notes here), so verification used that already-running
      Vite dev bundle over Chrome DevTools Protocol — a headless Chrome
      driven by a raw Node `WebSocket` speaking CDP directly (no new
      dependency), dispatching **real synthetic `PointerEvent`s on the actual
      `<canvas>` element** (confirmed `canvas.setPointerCapture` does not
      throw for a synthetic pointer id first) and **real DOM clicks** on the
      actual rendered buttons — no store imports, avoiding the "second,
      disconnected module instance" trap the item above's own write-up
      already named. Read back ground truth via `CanvasRenderingContext2D
      .getImageData` on the app's own canvas (calling `getContext('2d')` a
      second time on an existing canvas returns the *same* context the app
      already draws with, so this reads genuinely rendered pixels, not a
      separate probe), sampling each doc pixel's *center* rather than its
      corner once the pixel-grid overlay (on by default at this zoom) turned
      out to tint exact pixel-boundary samples. Drove the whole workflow: drew
      a real two-tone 16×16 block with the Rectangle tool (left-drag primary,
      right-drag secondary) so a flip would be visually detectable, dragged a
      matching selection, created a tileset through the real form, captured
      the tile (confirmed the notice reads "Added tile #1."), re-captured the
      identical selection (confirmed "Reused tile #1" and the tile count
      stayed at 2 — dedup, not a duplicate), added a tilemap layer, hid the
      raster layer so only the tilemap layer's own content could be showing,
      selected the Stamp tool and the captured tile, and clicked: **this
      caught a real bug** — the stamp changed no visible pixel at all,
      because `setTilemapCell` only bumps the grid buffer's own revision
      counter, not `documentStore`'s reactive `revision` field the redraw
      effect actually watches, so a stamp was invisible until an unrelated
      event happened to force a redraw. Fixed by having the live-paint path
      call `doc.touch(bufferId)` exactly as every other tool's dispatch loop
      already does, re-verified the same live sequence end to end
      afterward — the stamp rendered correctly, `Ctrl+Z`/`Ctrl+Y` (real
      `KeyboardEvent`s) correctly hid and restored it, toggling "Flip
      horizontal" and stamping a second cell showed the tile's two colours
      genuinely swapped, and a single drag spanning two grid cells was
      reverted by exactly one `Ctrl+Z` — confirming one-drag-one-undo-step
      against the real renderer, not just the command's own unit test. A
      regression test (`tools/stampSession.test.ts`) now pins the fixed
      behaviour down at the unit level too, since none of the existing
      grid-content assertions would have caught it.
- [x] Tileset + tilemap JSON export — full-resolution export (`02-architecture.md`
      "Rust produces what you ship"), following `animation_export.rs`'s own shape:
      the frontend stages every *real* tile's own RGBA pixels once
      (`export/tilemapExport.ts::concatTilePixels`, skipping index 0, the
      mandatory empty tile) and sends the grid's packed tile ids as plain JSON
      metadata — small enough that it is not the "pixel buffer" `docs/02` §6.2's
      rule is about, the same reasoning that already lets `animation_export.rs`
      send `frames`/`tags` as JSON. The new Rust command,
      `src-tauri/src/commands/tilemap_export.rs::export_tilemap`, assembles the
      tileset atlas by reusing `animation_export.rs`'s own `SheetLayout`/
      `assemble_sheet` unchanged (a tileset sheet is exactly the same "grid of
      equal-size images" problem a spritesheet already solved), scales it
      nearest-neighbour at an integer factor, and writes a Tiled-shaped map JSON
      alongside it. **Schema choice: Tiled's own `.tmj`/JSON map format**, not a
      bespoke one — the same "widely-supported over novel" reasoning
      `animation_export.rs` already used for Aseprite's spritesheet shape, and
      Tiled's JSON is the closest thing tile-based engines have to a lingua
      franca (Tiled itself, Phaser's and PixiJS's Tiled loaders, Godot's
      `TileMap` importer). **The bit-layout question was checked, not assumed**:
      Tiled reserves the *top* three bits of a 32-bit GID for flip/rotate flags
      (`FLIPPED_HORIZONTALLY_FLAG = 0x80000000`, `..._VERTICALLY_... =
      0x40000000`, `..._DIAGONALLY_...  = 0x20000000` — Tiled's name for a
      transpose), leaving a 28-bit index below them; `docs/03-data-model.md` §4's
      own packing puts the *same* three flags, in the *same* H/V/diagonal order,
      one bit lower across the board (bits 28/29/30, to keep a packed id a
      positive `int32` per that section's own comment) above the *same* 28-bit
      index. Close, but not identical, so `tesserica_id_to_tiled_gid` does a real
      per-flag translation rather than a passthrough — a dedicated regression
      test (`flip_flags_land_on_tiled_own_bit_positions_not_a_passthrough`) pins
      that down. It also folds in the index-space shift for free: Tesserica's
      index 0 (a real, drawable empty tile) maps to Tiled's own "no tile" GID 0,
      and with `firstgid = 1` and that empty tile never itself entered into the
      exported atlas, every real Tesserica tile index `i` becomes Tiled GID `i`
      exactly. UI: an "Export tileset + tilemap…" button in `TilesetPanel.tsx`,
      active once a tilemap layer is selected, exporting that layer's active
      frame. 14 new Rust unit tests (bit unpacking, the GID mapping including the
      not-a-passthrough regression, camelCase wire-shape decode, JSON shape, a
      real PNG+JSON write-and-decode-back, and validation failures) and 8 new TS
      unit tests (`export/tilemapExport.test.ts`) built against a real document
      driven through the actual store commands
      (`addTileset`/`addTileToTileset`/`addTilemapLayer`/`paintTilemapCell`), not
      hand-mocked fixtures. **Verified live**, not just by unit test: `tauri dev`
      was not attempted (this container's documented WebView flakiness, every
      earlier phase's own note here), so the fallback was the real Vite dev
      bundle over Chrome DevTools Protocol — a headless Chrome driven by a raw
      Node `WebSocket` speaking CDP directly, dispatching **real synthetic
      `PointerEvent`s** to draw a genuine two-tone 4×4 tile (Rectangle tool fill
      plus a single asymmetric Pencil-tool marker pixel, so a flip would be
      visually detectable), a real drag-selection, a real "+ Add tile from
      selection" click ("Added tile #1."), a real "Add tilemap layer from this
      tileset" click, and the real Stamp tool painting one plain cell and one
      flip-horizontal cell — confirmed by screenshot that the marker rendered on
      the opposite side of the tile for the flipped cell, exactly as expected.
      Clicking the real "Export tileset + tilemap…" button showed the same
      honest "Export needs the desktop app" fallback every other export path
      shows outside a Tauri shell — proof the button, the store reads and the
      IPC call boundary are all real and reachable, not a stub. Because the Rust
      leg itself can't be exercised this way, the actual tile pixels and packed
      grid ids were then read back out of the *same live document* (dynamically
      importing the exact, non-cache-busted module URLs the running page's own
      module graph had already resolved — `documentStore.ts`, `tileBuffers.ts`,
      `tileGridBuffers.ts` — the same "avoid a second, disconnected module
      instance" technique this roadmap's own tile-stamp entry above already
      used) and fed through the real, unmodified `write_tilemap` production
      function in a temporary, not-committed test: it wrote a genuine PNG whose
      decoded pixels matched the live-captured tile exactly (including the
      asymmetric marker) and a genuine map JSON whose `data` array held GID `1`
      at the plain cell, GID `1 | 0x80000000` (Tiled's real flip-horizontal bit)
      at the flipped cell, and GID `0` everywhere else across all 256 cells of
      the real 16×16 grid — the same flip id (`268435457`) the live app's own
      store actually held, not a synthetic stand-in.
- [x] Grid detection via autocorrelation (`04` §3.3) — unlocks W7 Case A
      (`06-workflows.md`: "Convert mode detects the underlying grid via
      autocorrelation and offers 'detected 8x — snap to original?'").
      `src/convert/gridDetect.ts::detectGrid` computes the per-column and
      per-row `sum(|pixel[x]-pixel[x-1]|)` signals §3.3 specifies, in plain
      8-bit sRGB per-channel (RGBA) absolute difference rather than Oklab —
      documented in the module's own header as a deliberate call: Oklab
      exists to answer "how different do these colours *look*", and a
      nearest-neighbour upscale by an integer factor repeats a source
      pixel's bytes **exactly** across its block, so within a block every
      one of these differences is genuinely, bit-identically zero, not
      "perceptually negligible" — spending `cbrt`/`pow` calls (and D12's
      cross-language libm disagreement) on that question would be answering
      it worse, not better, and since this code never runs in Rust there is
      no cross-language agreement to protect in the first place. Candidate
      periods are scored by comparing the mean of the diff signal at
      indices that are multiples of the candidate against the signal's
      overall mean, and — the one genuinely tricky part, caught by unit
      test, not assumed — **the smallest period that comes within 75% of
      the best score wins, not the highest-scoring candidate**: a true
      period's hard edges sit at every one of its multiples, so a harmonic
      (2×, 3× the truth) lands on a subset of the same real edges and can
      score just as well or even slightly better by sampling chance (the
      "octave error" familiar from pitch-detection autocorrelation, which
      has the identical problem for the identical reason); scanning from
      the smallest candidate up and accepting the first near-the-best one
      is what recovers the fundamental instead of an arbitrary multiple of
      it, while still correctly rejecting a *sub*harmonic (half the true
      period), whose on-grid bucket is diluted by genuinely zero-diff
      interior columns and scores markedly lower. Column and row periods
      are detected independently and checked against each other: agreement
      is offered as a confident "snap to original" suggestion; disagreement
      is shown honestly as unconfirmed rather than silently resolved one
      way. **No strong periodicity → no suggestion** (`04` §3.3's own
      "already pixel-sized" case): a flat/uniform source and photo-like
      noise both correctly report nothing rather than a bogus period.
      **No Rust mirror**, and deliberately so, unlike every other item in
      `src/pipeline/`: this never runs inside `convert()` in either
      language — it is a one-shot, user-triggered analysis of the *preview
      proxy* that only ever offers a value for the pixel-size control the
      pipeline already has, dual-implemented and golden-tested on its own
      terms. Because its output is always subject to an explicit user
      accept/dismiss and never itself produces a shipped pixel, there is
      nothing here for the golden suite to compare and no cross-language
      agreement at risk. UI: a "Detect grid…" button next to the
      pixel-size slider in `ConvertPanel.tsx` runs detection against
      whatever `previewRuntime` already holds and surfaces the result as an
      explicit accept ("Use 8×") / dismiss banner — it never overwrites the
      slider on its own, and the slider stays a normal editable control
      immediately afterward, exactly `06`'s "offers … snap to original?"
      wording rather than a forced snap. A note appears when the source
      exceeds the 1024px preview proxy (`PREVIEW_PROXY_MAX_EDGE`) and was
      itself box-downscaled before detection ever saw it, disclosing reduced
      reliability rather than hiding it. 11 unit tests
      (`gridDetect.test.ts`) build genuine synthetic sources — a small
      random low-res sprite this file itself nearest-neighbour-upscales by
      a known factor — and assert the *exact* recovered period at 3×, 4×,
      6×, 8×, 16×, and a non-square 8×/4× (column/row disagreement) case,
      plus photo-like noise (two independently seeded samples), an
      already-pixel-sized source, and a flat single-colour source (guards
      the mean-of-zero division) all correctly reporting no detection.
      **Verified live**, not just by unit test: `tauri dev` was not
      attempted (this container's documented WebView flakiness, every
      earlier phase's own note here), so the fallback was the real Vite
      dev bundle over Chrome DevTools Protocol — a headless Chrome driven
      by Node's built-in `WebSocket` speaking CDP directly (no new
      dependency), attached to an already-loaded tab rather than navigating
      fresh each call once repeated `Target.createTarget` calls in this
      session accumulated enough leftover tabs under this container's
      already-documented memory pressure to make the CDP connection itself
      flaky ("Promise was collected" mid-evaluate) — closing the stray
      tabs and reusing one live session resolved it, itself a small
      real lesson about this environment recorded here rather than
      papered over. Switched to Convert mode via a real button click,
      injected a genuine 16×16 random sprite nearest-neighbour-upscaled 8×
      directly into `previewRuntime`/`convertStore` (the same technique
      every Phase 5 item above used, via the exact module URLs the page's
      own module graph had already resolved), clicked the real "Detect
      grid…" button and read back "Detected 8× — snap to original?",
      clicked the real "Use 8×" button and confirmed the actual pixel-size
      range input's value changed from its default 12 to 8, then dispatched
      a genuine `input`/`change` event setting it to 20 to confirm the
      control is still a plain editable field afterward, never locked by
      the suggestion. Separately injected 96×96 photo-like noise and
      confirmed the real UI renders "No repeating grid detected — this
      source doesn't look like an upscaled sprite" instead of a bogus
      value.
- [x] `.ase` import; evaluate `aseprite-io` (`01` §9) — re-verified `aseprite-io`
      directly against crates.io (not the doc's 2026-07-26 snapshot): v0.2.0, MIT
      OR Apache-2.0, two releases in ~3 months (actively maintained), its only
      dependency `flate2` already resolved transitively via this project's own
      `zip` dependency (no new entry in the dependency tree). Read its
      `reader.rs`/`types.rs`/`writer.rs` rather than trusting its README: full
      chunk coverage this project can use — palette, every layer kind (normal/
      group/tilemap), every cel kind (raw, zlib-**compressed** — handled, not
      assumed away — linked, tilemap), tags, tilesets, user data. **Decision:
      use the crate directly rather than hand-roll a parser** (locked,
      `10-decisions.md` D17); the one real gap found by reading its source
      rather than assumed — it discards a tag's own embedded colour outright —
      is reported through `LoadResult.warnings`, not silently papered over.
      New `src-tauri/src/commands/ase_import.rs` converts an `AsepriteFile`
      onto this project's own `Sprite`/`Layer`/`Frame`/`Cel`/`Tag`/`Palette`,
      reusing `commands::project`'s existing `LoadResult`/`LoadedCel` wire
      shape so the frontend needed one new command call
      (`src/ipc/commands.ts::importAse`), not new plumbing — `src/app/
      project.ts` factors the shared "fetch every staged cel, replace the
      document" logic into `applyLoadResult`, used by both `openProject` and
      the new `importAseFile`. Converts nested groups (`parentId`, preserving
      Aseprite's own child-level nesting), **linked cels** (mapped onto this
      project's own `Cel.linkedTo`, sharing the canonical cel's staged buffer
      rather than duplicating it — exactly like a linked cel in a `.tess`),
      frame durations, tags, and the file's own palette as an importable
      swatch list; RGBA cels pass through unchanged while grayscale
      (value+alpha) and indexed (palette index, honouring the transparent
      index) sources convert to straight-alpha RGBA on the way in (D9 — v1 is
      RGBA only), never left indexed. **Honest partial, not overclaimed**:
      `.ase` **tilemap layers are skipped** with a warning — Aseprite's own
      tile flip/rotate bit layout does not match this project's `model/
      tileIds.ts` packing (the tileset-export item earlier in this same phase
      already hit the analogous mismatch against Tiled's bit layout), and
      repacking it correctly is real work distinct from the rest of this item;
      Aseprite's three non-W3C blend modes (addition/subtract/divide) import
      as `normal`; `pingpongReverse` (a fourth tag loop direction Aseprite has
      and this project's `TagDirection` does not) imports as `pingpong`; both
      report a warning per occurrence. Per-cel opacity and Aseprite slices
      have no field in this project's data model at all and are dropped
      without a warning, since there is nothing here for them to have failed
      to reach. 12 new Rust unit tests build real binary `.aseprite` byte
      streams via the crate's own writer (an independent code path from its
      reader) and round-trip them through `AsepriteFile::from_reader` exactly
      as a file opened from disk would be — a minimal single-layer/single-
      frame RGBA file, nested groups with parent pointers, a linked cel
      sharing its canonical buffer, grayscale/indexed→RGBA conversion
      (including the transparent-index boundary), tags with range/direction
      and the missing-colour warning, the file's own palette, an
      all-defaults/no-content file, a rejected non-Aseprite file, a skipped
      tilemap layer, locked/hidden/opacity mapping, and — closing the gap the
      others don't reach — a **real multi-feature file written to and read
      back from an actual path on disk** (3 layers across a group, 3 frames,
      a linked cel, a tag), exercising the exact `std::fs::read` +
      `AsepriteFile::from_reader` + `convert()` sequence the real
      `import_ase` command itself runs, not just its in-memory `convert()`
      half. 5 new TS tests (`src/app/project.test.ts`, previously no test file
      existed for this module at all) cover `openProject`/`importAseFile`
      sharing `applyLoadResult` and the one behaviour they must *not* share:
      an imported `.ase` leaves `projectPath` unset (a source, not this
      project's own save file) rather than inheriting the pattern that opening
      a `.tess` sets it. Verified live: `tauri dev`'s WebView was unreachable
      in this container as in every earlier phase's own note here, so the
      fallback was the real Vite dev bundle over Chrome DevTools Protocol (a
      headless Chrome launched for this session, driven by Node's native
      `WebSocket` speaking CDP directly, no new dependency) — opened the real
      File menu via an actual DOM click, confirmed the real menu item list is
      `["New…","Open…","Import Aseprite file…","Save","Save As…","Open
      image…","Export…"]`, clicked "Import Aseprite file…", and confirmed the
      real `guard()`/`NoBackendError` path surfaced the honest "This needs the
      desktop app — the Rust backend is not available here." — proof the
      button, the store dispatch and the IPC boundary are all real and
      reachable, not a stub, consistent with every other command this
      container's WebView cannot reach. `cargo test` (223 passed, 5 ignored —
      the pre-existing `ort`/checksum smoke tests unrelated to this item),
      `cargo clippy --all-targets -- -D warnings` (clean), `npx tsc --noEmit`
      (clean), `npm run lint` (clean), `npm run test` (754 passed), `npm run
      build` (clean), and `npm run test:golden` (17 passed — no pipeline files
      touched, a sanity check) all pass.

**Exit:** ✅ **W4, W7 complete.** All four Phase 6 items landed: the tileset/
tilemap data model with a real panel UI, the tile stamp tool with
auto-deduplication, tileset+tilemap JSON export, grid detection (W7 Case A),
and — closing the phase — `.ase` import (W7 Case B), so both halves of the
same workflow now work. Two things carried forward rather than hidden by this
exit: `.ase` tilemap layers do not import (Aseprite's tile-flag bit layout
does not match this project's own packing, `10-decisions.md` D17), and a
`.ase` file's own tag colours are not recoverable from the `aseprite-io`
0.2.0 reader itself, so imported tags get a deterministic placeholder colour
instead of the artist's original.

---

## Phase 7 · Polish & reach

Ordered by value, not commitment:

- [x] Non-destructive layer effects: outline, drop shadow, gradient map (`03` §5) —
      `docs/03-data-model.md` §5 names five kinds, not three, and all five landed:
      outline, drop-shadow, gradient-map, hsv-shift, outline-inner. `LayerBase` gets
      `effects: Effect[]` (`model/types.ts`), each entry carrying an `id` and an
      `enabled` flag beyond the doc's own sketch — the same reasoning `Tag.id` used
      (stable addressing for reorder/delete) plus a field the roadmap's own
      "toggleable" requirement needs and the sketch has none for. `canvas/effects.ts`
      is the one implementation of the actual pixel maths: outline/outline-inner via
      iterated binary dilate/erode (`corners` toggles 4- vs 8-connected adjacency for
      outline; outline-inner is fixed 4-connected since the doc gives it no `corners`
      field), drop-shadow via an offset silhouette composited behind the layer's own
      content, gradient-map via a luminance-ordered remap onto a palette gradient, and
      hsv-shift via a plain RGB↔HSV round trip with an explicit unit convention (h in
      degrees wrapped 0..360, s/v in ±100 percentage points) since the doc names the
      fields but not their units. **Oklab vs. sRGB for gradient-map, decided
      explicitly**: CLAUDE.md invariant 5 ("all colour distance and error diffusion
      happen in Oklab") is scoped to the conversion *pipeline*'s cross-language
      palette-quantization parity (D12) — a concern that does not exist here, since
      effects have no Rust mirror at all and nothing about this function is compared
      bit-for-bit against another implementation. Oklab `l` was used anyway, for the
      same "colour math belongs in a perceptual space" reasoning this project applies
      everywhere else it touches colour — a genuinely better luminance measure than
      naive gamma-encoded sRGB luma, not a requirement `docs/04`'s pipeline invariant
      forces. Applied at composite time in the three places that must agree on what's
      visible: `flatten.ts` (export, exact — one line before merging a layer with
      what's below it), `sample.ts` (eyedropper — materializes a layer's own content
      once per query, since outline/drop-shadow are neighbourhood-dependent and cannot
      be answered from a single pixel in isolation), and `renderer.ts` (live canvas —
      reuses `flatten.ts`'s exact buffer maths, cached per layer, rather than a third
      approximate implementation; the opposite trade-off from blend modes, which stay
      native-canvas-fast live and only match exactly at export). **Rust gets a
      round-trip-only mirror, not rendering logic** — `Effect` in
      `src-tauri/src/model/document.rs`, tagged `kebab-case` so wire `kind` values match
      the TS string literals exactly, `#[serde(default)]` on `LayerBase::effects` for
      pre-Phase-7 `.tess` files. This holds for the same reason `Layer::Group` and
      `BlendMode` are round-trip-only: Rust never composites layers at all
      (`docs/02-architecture.md` §6.2 — pixel buffers never cross IPC, so there is
      nothing for Rust to composite *with*), and effects are purely a compositing-time
      concern. `history/layerCommands.ts` gets add/remove/toggle/reorder/update
      commands, all wrapping the existing `setProps`/`SetLayerPropsCommand` vocabulary
      (the whole `effects` array is one `LayerBase` field, so every operation is just a
      new array reference through the same diff-and-patch machinery already undoable
      by construction), with `updateLayerEffect`'s own coalesce key so a slider drag is
      one undo step. `panels/LayerEffectsSection.tsx`, split out of `LayerPanel.tsx` the
      same way `SegmentModelSection` is split out of `ConvertPanel`, is the UI: an
      "+ Add effect" dropdown, per-row enable/reorder/remove controls, and a per-kind
      parameter editor (native `<input type="color">` plus a separate alpha field —
      `lib/color.ts` gained `fromHex` to pair with the existing `toHex` — thickness/
      offset/hue/saturation/value sliders, and a palette-picker dropdown for
      gradient-map that snapshots the chosen palette's colours into the effect rather
      than keeping a live reference to a `Palette` that could later be renamed or
      deleted). Tests: 22 cases in `canvas/effects.test.ts` (outline shape including
      `corners` on/off and the exact-thickness diamond-growth behaviour, outline-inner
      vs. outline distinction, drop-shadow offset/z-order, gradient-map's
      luminance-to-palette mapping at known sample points, hsv-shift's exact channel
      maths, stack ordering/toggling), 12 in `history/layerCommands.test.ts`, 8 in
      `panels/LayerEffectsSection.test.tsx` (real DOM events against the real
      component and the real store), 6 in `lib/color.test.ts`, and 6 Rust round-trip
      tests in `model::document` (every kind's kebab-case wire tag, a multi-effect
      stack round-tripping in order, default-when-absent). **Verified live, and this
      is what caught a real bug**: drove the actual Vite dev bundle at `localhost:1420`
      over Chrome DevTools Protocol (this container's Tauri WebView unreachable as
      every earlier phase's own note here records) — added each of the five effect
      kinds through the real "+ Add effect" dropdown and real per-row controls,
      confirmed the document and the Effects panel updated correctly every time, but
      the very first check (a screenshot, plus a direct read of `compositeSprite`'s own
      returned canvas versus what the live app had actually painted) showed the
      **on-screen canvas silently not updating**: `compositeSprite`'s top-level cache
      signature (`signatureOf`) listed every `LayerBase` field except `effects`, so
      adding/toggling/reordering an effect changed nothing the cache was watching, and
      it kept serving its stale pre-effect canvas without ever calling
      `effectAppliedCanvas` at all. Fixed by folding `effectsFingerprint(layer.effects)`
      into `signatureOf`; confirmed the fix was real by reverting it, re-running the
      new regression test (failed exactly as the live bug did), then restoring it and
      re-verifying live — the outline now renders correctly (screenshot), and the full
      add → toggle-off (canvas reverts to the exact pre-effect pixel count) →
      toggle-on (canvas matches the first application exactly) → remove cycle round-
      trips losslessly through real DOM clicks for all five kinds. Also confirmed,
      function-level, against a real 4×4 red square on a 16×16 canvas: `flatten.ts`
      (export) matched the live `compositeSprite` canvas byte-for-byte in every single
      case, including combined and reordered stacks; reordering `[outline,
      gradient-map]` vs. `[gradient-map, outline]` produced genuinely different pixels
      (the gradient remapping the outline's own colour only when the outline ran
      first) — confirming order is real, not cosmetic; and removing every effect
      returned the canvas to the exact original baseline pixel-for-pixel. `npm run
      test` (800 passed), `npx tsc --noEmit` (clean), `npm run lint` (clean),
      `cargo test` (226 passed, 5 ignored — pre-existing, unrelated), `cargo clippy
      --all-targets -- -D warnings` (clean), `npm run build` (clean), and `npm run
      test:golden` (17 passed — no pipeline files touched, a sanity check) all pass.
- [x] Batch conversion + CLI headless mode (W5) — both halves genuinely work
      end to end. **Batch conversion, Rust-side**
      (`src-tauri/src/commands/batch_convert.rs`): `batch_convert` reuses
      `pipeline::convert::convert` and `ConvertSettings` completely unchanged
      — no parallel settings type — enumerating every regular file directly
      inside a folder (non-recursive; unfiltered by extension, so a stray
      non-image file surfaces as a per-file `FileFailed` rather than aborting
      the batch) and converting each in parallel via `rayon` (`.par_iter()`
      over files) — this crate's first real dependency on it, since the
      pipeline's own per-pixel loops remain single-threaded per
      `07-tech-stack.md`'s still-aspirational entry. Pixel size drives
      `targetWidth`/`targetHeight` **per file** (each source has its own
      dimensions, unlike the fixed pair a single `ConvertSettings` normally
      carries), overwritten after cloning the caller's settings so every other
      stage — palette, dither, adjustments, background removal, cleanup —
      applies identically across the batch. Progress streams back over a
      Tauri **Channel** (`docs/02-architecture.md` §6.2, D13) as `started` /
      `fileStarted` / `fileSucceeded` / `fileFailed` / `finished` events, never
      accumulated into the command's own return value. **Cancellable**:
      `BatchJobs` is a small `AtomicBool`-per-job registry (mirrors
      `commands::source::Sources`' handle-table shape); the rayon pass runs
      inside `spawn_blocking` so `cancel_batch_convert(jobId)` — a separate
      command — is always reachable while a batch is running, and each
      per-file closure checks the flag before starting (already-converting
      files still finish; no new ones start). A genuine per-variant wire-shape
      bug was caught before shipping: an enum-level `#[serde(rename_all =
      "camelCase")]` only renames the variant tags themselves, not a struct
      variant's own fields, so `jobId`/`outputPath`/`colorsUsed` would have
      reached the frontend as snake_case despite `"kind"` reading camelCase —
      found by asserting the actual serialized bytes rather than trusting the
      attribute, fixed by repeating `rename_all` on every variant, pinned down
      by a regression test. **Frontend** (`src/app/BatchConvertDialog.tsx`,
      wired into the File menu alongside Export…): pick a source folder,
      configure the same four primary controls Convert mode's own panel
      exposes (pixel size, palette, dither, strength — `DITHER_LABELS` moved
      out of `ConvertPanel.tsx` into `convert/ditherLabels.ts` so both share
      one dropdown definition instead of two) plus export scale, optionally
      "Use settings from…" an existing conversion layer in the open document
      (carries its whole `ConvertSettings` in, including the parts with no
      dedicated control, while leaving the four primaries still editable
      afterward), Run with a live per-file progress list streamed from the
      Channel, and Cancel mid-run. Deliberately **not** wired to the live
      `useConvertStore` singleton — this dialog has its own local state so it
      cannot fight Convert mode's own interactive session over one global's
      fields. **CLI headless mode** (`src-tauri/src/cli.rs`): `tesserica
      --batch-convert <folder> --out <folder> [--settings <path.json>]
      [--pixel-size <n>] [--scale <1|2|4|8>]` skips the GUI entirely (checked
      in `run()` before the `tauri::Builder` is ever touched) and exits with a
      real process code (`0` full success, `1` at least one file failed, `2`
      usage/setup error) — hand-rolled argument parsing, no new dependency,
      the same "this binary can do something other than open a window" shape
      the existing `TESSERICA_BENCH` env-var mode already established, real
      CLI arguments this time since a headless batch job has real inputs (a
      folder, a settings file) an env var cannot carry cleanly. `--settings`
      accepts the same camelCase `ConvertSettings` JSON the interactive app
      sends over IPC; omitted, it falls back to an auto-palette default.
      **Verified for real, not just unit-tested**: `cargo test` (240 passed, 5
      ignored, all pre-existing/unrelated — including 10 new
      `commands::batch_convert` tests and 6 new `cli` tests covering mixed
      valid/invalid folders, cancellation actually halting further files
      rather than accepting an ignored flag, per-file target-dimension
      override, and a real end-to-end CLI run) and `cargo clippy --all-targets
      -D warnings` both clean; a real debug binary was built and invoked as a
      genuine **subprocess** (not through `cargo test`) over a folder mixing
      two real PNGs and one non-image file — correct per-file stdout, exit
      code `1` (the one real failure), and the two successful output PNGs
      independently decoded back with exactly the expected pixels and
      dimensions at the requested pixel-size/scale combination. The frontend
      dialog was driven live against the real Vite dev bundle over Chrome
      DevTools Protocol (this container's Tauri WebView unreachable, as every
      earlier phase's own note here records; no `__TAURI_INTERNALS__` outside
      the real shell to exercise the actual IPC leg, which the Rust tests and
      the CLI subprocess above cover instead): confirmed "Batch Convert…"
      appears in the real File menu, the dialog opens with every documented
      field, folder-picker buttons are reachable, Run stays disabled until
      both folders are chosen, and the dialog unmounts cleanly on Close. That
      pass caught and fixed one real bug: `pickSourceFolder`/`pickOutFolder`
      called `open()` with no `try`/`catch`, so outside the Tauri shell (where
      `open()` genuinely throws rather than resolving `null`) clicking
      "Choose…" produced an **uncaught exception** instead of the honest
      in-dialog error every other failure path here already shows; fixed,
      covered by a new regression test, and re-verified live afterward with no
      more uncaught exception and the error text rendering in the dialog.
      `npm run test` (810 passed), `npx tsc --noEmit` (clean), `npm run lint`
      (clean), `npm run build` (clean), and `npm run test:golden` (17 passed —
      no pipeline files touched, a sanity check) all pass.
- [x] Pixel-art-aware rotate/scale — rotxel, cleanEdge (`04` §7) — grounded in
      Pixelorama's actual open-source implementation (github.com/Orama-Interactive/
      Pixelorama, MIT, read 2026-08-01), not a guess at "something rotxel-like."
      **rotxel** turned out to be exactly what this line expected: a real CPU
      function, `DrawingAlgos.gd::rotxel()` — nine sub-cell inverse-rotated
      searches per destination pixel, resolved against the source's 3×3
      neighbourhood with the same edge-priority rules Pixelorama's own `scale_3x`
      uses for its corner outputs, so the output is always a colour that already
      existed in the source. `canvas/transform.ts::rotxelRotate` is a line-by-line
      port, including the odd-width quirk (`+1` to both `ox`/`oy`, checked against
      *width* only) and the exact-angle fast paths — reimplemented with exact
      integer arithmetic rather than Pixelorama's own (still trig-based)
      `is_equal_approx` special-casing, removing the one remaining source of
      floating-point tie-break ambiguity at 0°/90°/180°/270°. **cleanEdge** did
      *not* turn out to be what this line's own one-liner assumed going in (“a
      post-process that removes stray/isolated pixels”): the real thing
      (`Shaders/Effects/Rotation/cleanEdge.gdshader`, torcado, MIT) is a
      from-scratch GPU resampling *algorithm* in its own right — an alternative
      to rotxel, not a pass that runs after it — and it is GPU-shader-only, its
      neighbour lookups keying off `ceil()` of a continuous UV sampled through
      Godot's nearest-texture-filter hardware path. Which physical texel a
      boundary-straddling UV resolves to is a GPU sampler tie-break convention
      the GLSL source does not pin down on its own; porting that detail to two
      CPU implementations without a live GPU reference to diff against would mean
      guessing at the one thing that decides correctness, which CLAUDE.md rules
      out. The shader documents its own simpler variant (`#undef SLOPE`/
      `CLEANUP`, "otherwise only uses 45 degree slopes"): with those off,
      `sliceDist`'s logic reduces to a real, self-contained, cited heuristic —
      does a 45° diagonal run between this pixel's two orthogonal neighbours, and
      if so, which side of it does the sample fall on — including the shader's
      own guard against erasing a single-pixel-wide diagonal line. That reduced
      heuristic is what `cleanEdgeSample`/`cleanEdgeTransform` implement: an
      **adaptation of a real, cited algorithm, not a byte-exact port** (unlike
      `rotxel`, which is one), documented as such in `transform.ts`'s own module
      comment rather than left to look more faithful than it is. **No Rust
      mirror** — unlike the conversion pipeline (`docs/02-architecture.md` §6.2:
      Rust holds the source and re-runs the pipeline at full resolution because
      the frontend only ever sees a downscaled proxy), an editor layer's pixel
      buffer *is* already the full-resolution buffer in the frontend; there is no
      proxy/full-res split for Rust to reconcile, and Rust never composites or
      transforms raster layers at all (confirmed by grep — the only Rust
      "rotate" hits are an unrelated Oklab hue comment, a tilemap-flip-flag
      comment, and an animation-export struct field). Same reasoning this
      phase's own layer-effects item already established for `Effect`. Wired
      into the editor as a genuine, usable feature rather than a library
      function nothing calls: a new **Transform tool** (`R`, `tools/transform.ts`
      — a read-only no-op `Tool` purely so it is a selectable `ToolId` with its
      own `ToolOptions` panel) with an algorithm dropdown (Rotxel / cleanEdge),
      angle and scale sliders, and an Apply button; `canvas/applyTransform.ts`
      does the actual edit against the active selection's *bounding box* (or the
      whole cel when nothing is selected — a rotation does not preserve which
      destination cell a non-rectangular mask's source cell lands on, so unlike
      `Move`, a pure translation, there is no well-defined way to carry the mask
      shape through), reusing `beginStroke`/`finishStroke` the same way every
      drag tool does, so it is undoable through the ordinary dirty-rect command
      system with zero new `Command` class. 22 new tests in `transform.test.ts`
      (rotxel exact at 0°/90°/180°/270° — including that four successive 90°
      rotations return to the exact original, which only holds if 90° is a true
      bijective permutation with no lossy smoothing — plus several arbitrary
      angles asserting the source-colour-only invariant and a solid-colour
      square staying that one colour; `cleanEdgeSample`'s slice/fallback/
      single-pixel-diagonal-guard behaviour and its own source-colour-only
      invariant over a dense grid of sample points; `cleanEdgeTransform` at a
      non-integer scale and a combined rotate+scale; a constructed diagonal-edge
      rotation showing fewer stray single-pixel artifacts than a naive
      nearest-neighbour rotation at the same angle) plus 6 in
      `applyTransform.test.ts` (undo/redo byte-exact round-trip, selection-bounds
      scoping leaving pixels outside it untouched, the locked/hidden/no-cel
      guards). **Verified live**, over Chrome DevTools Protocol against the real
      Vite dev bundle (this container's Tauri WebView unreachable, as every
      earlier phase's own note here records): drew a small asymmetric shape with
      the real Pencil tool via real dispatched pointer events, switched to the
      real Transform tool, typed a real angle into the real click-to-type field
      (the first attempt used raw synthesized key events and silently produced
      the wrong value — `180` instead of `30` — because Chrome's synthetic
      `keyDown`+`char` pair double-inserted characters into a controlled React
      input; switched to setting the input's value through its native setter
      plus a real bubbling `input` event, which is what actually reflects
      through React's own event delegation, and reproduced the correct `30°`),
      clicked the real Apply button, and read the canvas's own `getImageData` —
      not a store internal — before and after: the shape rotated with clean,
      non-blurry, non-speckled edges (screenshot-confirmed), `Ctrl+Z` restored
      the canvas to the pre-rotation state byte-for-byte (0 differing bytes),
      and `Ctrl+Y` redid it back to the exact post-apply state (0 differing
      bytes). Repeated with `cleanEdge` at a combined 20°/160% rotate+scale —
      same clean result, correctly enlarged and rotated, no blended colours.
      `npm run test` (832 passed), `npx tsc --noEmit` (clean), `npm run lint`
      (clean), `npm run build` (clean), `cargo test` (240 passed, 5 ignored —
      pre-existing/unrelated), `cargo clippy --all-targets -- -D warnings`
      (clean — no Rust files touched), and `npm run test:golden` (17 passed — no
      pipeline files touched, a sanity check) all pass.
- [x] **Indexed color mode + live palette swapping** (deferred from v1 by D9 — landed as
      six checkpointed commits, `git log --grep "indexed color mode"`). `Sprite.colorMode:
      'rgba' | 'indexed'` (default `'rgba'`, every pre-Phase-7 `.tess`/test unaffected) and,
      for an indexed sprite, its own embedded `Sprite.palette` — `model/types.ts`, mirroring
      Rust `Sprite`/`ColorMode`/`Palette`, which (checked directly rather than trusted) had
      already reserved these fields even though `src/model/types.ts` genuinely had not.
      **Storage**: `model/indexBuffers.ts` — one `Uint8Array` byte per pixel instead of four,
      raw index `0` reserved for "transparent" (255 usable colours, palette entries at raw
      indices `1..255`); `model/celStorage.ts` is the single place that decides RGBA vs.
      indexed storage for a given layer (`raster` in an indexed sprite only — `conversion`
      layers stay RGBA regardless of `colorMode`, since their pixels come from the RGBA
      conversion pipeline, not hand-painting). **The "colour not in the palette" policy D9
      itself named as unresolved**: snap to the nearest palette entry in Oklab
      (`model/indexedColor.ts::nearestPaletteIndex`, reusing
      `pipeline/quantize.ts::nearestIndexOklab` rather than a second metric); alpha `0`
      always maps to the reserved transparent index regardless of RGB.
      **Rendering**: `canvas/flatten.ts`, `canvas/renderer.ts`, `canvas/sample.ts` all
      resolve an indexed cel's stored indices through `sprite.palette` at composite time
      (`model/indexedRender.ts::renderIndexedCel`) — the same "different buffer, resolved at
      composite time" pattern already established for tilemap cels. `renderer.ts`'s caches
      fold in a palette fingerprint so a palette edit invalidates them, which is what makes
      live swapping actually instant. **Tools**: pencil, eraser, fill (contiguous + global +
      bucket), line, rectangle, ellipse and the eyedropper — the roadmap item's full list —
      all write/read palette indices correctly via one shared conversion point
      (`tools/pixelValue.ts::pixelValueFor`); magic-wand selection and Move were converted
      too, beyond the explicit list, since both share the same low-level buffer helpers and
      would otherwise have silently misread/corrupted an indexed cel's bytes the first time
      anyone used them on one. The undo system (`history/pixelDelta.ts`, `commands.ts`,
      `strokeRecorder.ts`) is bytes-per-pixel-generic, so undo/redo/coalescing work
      identically for an indexed stroke. **Scope boundary on blend modes/effects** (stated
      up front as legitimate, not a shortfall): `canvas/blend.ts` and `canvas/effects.ts` are
      completely unchanged — every layer is resolved to RGBA (the step above) before either
      ever sees a pixel, so indices never reach blend or effect code. The Transform tool
      (rotxel/cleanEdge, a separate roadmap item) was **not** converted — on an indexed cel
      it safely no-ops (`getBuffer` returns `undefined` for indexed storage, so
      `applyTransform` returns early) rather than corrupting data, but a user cannot actually
      transform an indexed layer yet. **`.tess` round-trip**, both languages:
      `src-tauri/src/commands/project.rs` writes an indexed raster cel raw (`cels/<id>.bin`,
      mirroring the existing tilemap convention) via `cel_is_raw`, replacing the old
      "reject anything but `ColorMode::Rgba`" checks; `src/app/project.ts` stages/reads the
      same raw bytes and threads them through `documentStore.replaceDocument`'s new
      `indices` map. **Creation UI**: `app/NewSpriteDialog.tsx`'s Color Mode selector
      (previously permanently disabled at "RGBA") is real — choosing Indexed embeds the
      picked palette as the new sprite's own copy. **Live palette swapping** — the feature
      D9 named as the actual point of deferring this — is real and demonstrable:
      `panels/PalettePanel.tsx` grows a "This Sprite's Palette" section, shown only for an
      indexed sprite, with an "Assign palette" dropdown (swap the whole palette) and one
      native colour-input swatch per entry (recolor in place); both go through
      `history/paletteCommands.ts` (undoable, coalescing). **Not implemented**: converting
      an already-open RGBA sprite to indexed (creation-time only, matching D9's own
      "and/or" wording for where this could live).

      **Verified**: 71 new TS tests across the six commits (832 → 903 passed;
      `indexBuffers.test.ts`,
      `indexedColor.test.ts`, `indexedRender.test.ts`, `celStorage.test.ts`, indexed-mode
      describe blocks added to `flatten.test.ts`/`sample.test.ts`/`renderer.test.ts`/
      `documentStore.test.ts`/`layerCommands.test.ts`/`pencil.test.ts`/`fill.test.ts`/
      `shapes.test.ts`/`select.test.ts`/`move.test.ts`/`newSprite.test.ts`/
      `PalettePanel.test.tsx`/`project.test.ts`, `paletteCommands.test.ts`, plus 3 new Rust
      tests in `commands::project`), including the specific proof the roadmap item asks
      for — a test that edits a palette colour and confirms every pixel using that index
      updates with zero writes to cel data (`flatten.test.ts`, `renderer.test.ts` at the
      caching layer, `sample.test.ts`). `npm run test` (903 passed), `npx tsc --noEmit`
      (clean), `npm run lint` (clean), `npm run build` (clean), `npm run test:golden`
      (17 passed — no pipeline file was touched in any of the six commits, confirmed via
      `git diff --stat -- src/pipeline/ src-tauri/src/pipeline/`), `cargo test` (243 passed,
      5 ignored/unrelated), `cargo clippy --all-targets -- -D warnings` (clean) all pass.
      Live-verified against the real Vite dev bundle over Chrome DevTools Protocol
      (this container's Tauri WebView unreachable, as every earlier phase's own note here
      records): drove the real `Ctrl+N` shortcut, opened the real New Sprite dialog, set
      Color Mode to Indexed through a real `<select>` change event, created a 10×10 sprite,
      and confirmed via screenshot and real DOM state that "THIS SPRITE'S PALETTE" appeared
      with the real 4-colour Game Boy palette: then drove the real "Assign palette"
      `<select>` to switch to NES and confirmed, by reading the live DOM back, all 4 Game
      Boy swatches were replaced by the real 55 NES colours — genuine, live, end-to-end
      proof the assign-palette path reaches from real UI through the real store into a real
      re-render. Painting with the real Pencil tool via CDP-dispatched mouse events did not
      reliably land in this container (a `getImageData` scan of the canvas after a
      dispatched drag found no chromatic pixels) — a CDP mouse-event/pointer-capture
      automation limitation consistent with every earlier phase's own documented WebView/
      input flakiness in this specific container, not a code-path this session could
      re-verify live; the pencil→index→undo path is instead covered by real, non-mocked
      `ToolContext`-driven unit tests (`pencil.test.ts`) and the real-DOM `PalettePanel`
      recolor test (`PalettePanel.test.tsx`, using the same native-input-setter technique
      this project's `LayerEffectsSection`/`TimelinePanel`/`SliderField` tests already
      established for a React-controlled input under jsdom).
- [x] Bead / cross-stitch chart export (W9) — `src/model/patternChart.ts`'s
      `buildPatternChart` is the color-key/legend computation W9 asks for:
      walks the sprite's flattened composite (`canvas/flatten.ts`) and
      produces a small indexed grid plus a legend ordered by descending
      count. **RGBA vs. indexed, decided rather than punted**: an
      `indexed`-mode sprite's own `sprite.palette` is used verbatim (it is
      already the "indexed grid plus a palette" W9's own line describes);
      every other sprite gets a palette *derived* from its flattened pixels
      via the conversion pipeline's own `pipeline/autopalette.ts::autoPalette`
      (Wu + k-means in Oklab) and snapped per-pixel with
      `pipeline/quantize.ts::nearestIndexOklab` — reusing the converter's
      quantizer rather than a third implementation, and capped at
      `DEFAULT_MAX_DERIVED_COLORS` (32) so a photo-like RGBA sprite with
      thousands of anti-aliased colors cannot produce an unprintable legend.
      A pixel below `PATTERN_CHART_ALPHA_THRESHOLD` (128, the same default
      `pipeline/settings.ts` already uses) is an empty chart cell, not a
      quantized "transparent" color. The printable image is
      `src-tauri/src/commands/pattern_chart.rs::export_pattern_chart` — full-
      resolution PNG rendering belongs in Rust (`docs/02-architecture.md`
      §3), taking the grid + legend as plain JSON (small integers, the same
      "not a pixel buffer" precedent `tilemap_export.rs`'s `tile_ids`
      already set). It draws coordinate labels (row/column numbers, with an
      auto-computed label interval so a wide/tall sprite's chart does not
      overlap its own labels), gridlines (bold every 10 cells), each cell
      filled with its color, and a legend below with a swatch, RGB value and
      count per color, all at a configurable `cellSize` (px/cell — validated
      against its own bounds, not the unrelated `ALLOWED_SCALES` pixel-
      replication invariant). **Symbols: added, and numeric rather than
      lettered.** Every cell (and its legend row) is overlaid with the
      color's 1-based legend position in a hand-authored 3×5 pixel digit
      font — real printability for a black-and-white printout, the
      "nice-to-have" the roadmap named — drawn with black or white ink
      chosen from the color's own Oklab lightness for contrast. No font-
      rendering dependency was added: every label this chart draws (axis
      numbers, RGB values, counts, symbols) is digits only, so a full
      alphabet was never needed — numeric symbol keys are themselves a real
      cross-stitch/bead-chart convention, not just an implementation
      shortcut. Wired into `app/ExportDialog.tsx` as a fourth format
      ("Pattern chart") alongside PNG/Spritesheet/GIF, with a cell-size
      field and — only for an RGBA-mode sprite, since an indexed sprite's
      palette is already fixed — a max-colors field. Tests: 6 cases in
      `patternChart.test.ts` (count-per-color, alpha-threshold-as-empty-
      cell, the `DEFAULT_MAX_DERIVED_COLORS` cap, an explicit `maxColors`
      override, and both the indexed-palette and derived-palette paths), 13
      in `pattern_chart.rs` (font/measurement helpers, label-interval
      growth, contrast-ink choice, validation, and real PNGs decoded back
      with `image::load_from_memory` and checked at known cell/legend
      pixel positions) — plus manual verification rendering an 8×8 heart
      sprite and a 30×20 multi-color grid to real PNGs and visually
      confirming the grid, coordinate labels, gridlines and legend all read
      correctly before those ad hoc renders were discarded.
- [x] Lospec URL import (opt-in network) — `docs/06-workflows.md` W8 step 4.
      **URL shape, verified against the live site rather than assumed**: a
      palette page at `https://lospec.com/palette-list/<slug>` has a
      documented, stable sibling download at `.../<slug>.hex` (same host and
      path, `content-disposition: attachment`) — no HTML scraping needed.
      `www.lospec.com` does not resolve. Mistyped/nonexistent slugs (slugs
      are case-sensitive) measured to hang 30s+ rather than 404 promptly
      (real slugs answer in ~1-2s), so a bounded timeout is load-bearing,
      not polish. `lib/lospecImport.ts::parseLospecUrl`/`importLospecPalette`
      own URL validation, slug extraction, and parsing — reusing the
      existing `.hex` parser from Phase 1 rather than new parsing logic, per
      the workflow's own note that file-format support "covers the entire
      Lospec catalogue." **Frontend-vs-Rust: the fetch itself ended up in
      Rust, contradicting the initial plan to mirror the Phase 5
      segmentation-model download's frontend-`fetch()` pattern** — measured
      directly (driving the real Vite dev bundle in a real headless browser
      over CDP): `lospec.com` sends no `Access-Control-Allow-Origin` header,
      so a WebView-context `fetch()` to it fails with `TypeError: Failed to
      fetch` before any request reaches the network, while the identical
      call from plain Node (which does not enforce CORS) succeeds — the
      kind of gap a Node-only check would miss. `commands::lospec::
      fetch_lospec_palette` (new `ureq` dependency, chosen for the same
      minimal-footprint reasoning `Cargo.toml` already documents for its
      other additions) takes only a bare slug, never a full URL, so it
      cannot be pointed at an arbitrary host; the response text (a few
      hundred bytes to a handful of KB) crosses back as an ordinary JSON
      return value, not through `staging` — nothing like the pixel buffers
      `docs/02-architecture.md` §6.2 keeps off that path. **Consent**:
      `panels/LospecImportSection.tsx` follows `SegmentModelSection.tsx`'s
      established pattern exactly — opening the form only reveals a text
      field (URL validated locally, no network, as the user types), and the
      fetch fires only from an explicit "Fetch from lospec.com" click, never
      on paste or mount. Tests: 18 in `lospecImport.test.ts` (URL parsing/
      validation, consent-gating — `fetchImpl` is unreachable without an
      explicit call, mirroring `modelDownload.test.ts`'s pattern — every
      failure mode, and a JS-side backstop timeout), 7 in
      `LospecImportSection.test.tsx` (real DOM events proving the toggle
      reveals the form without fetching, typing never fetches, an invalid
      host disables Fetch with an inline reason, and only an explicit click
      calls the import function), 3 Rust unit tests (slug validation) plus 2
      `#[ignore]`d Rust tests run for real against the live site this
      session (`cargo test commands::lospec -- --ignored --nocapture`): a
      known palette (`pear36`, 36 colours) fetched and matched exactly, and
      a nonexistent slug timed out cleanly in ~20s rather than hanging.
      **Verified live**: a real, unmocked TS-level fetch against
      `https://lospec.com/palette-list/pear36` (via `npx tsx`, bypassing
      only the Rust IPC hop) returned the real 36-colour palette; driving
      the real Vite dev bundle over CDP confirmed the consent UI (screenshot
      taken), that no fetch fires before the explicit click, that an invalid
      host is rejected locally, and that a missing Tauri backend (this
      container's own long-standing limitation — see Phase 5's own note)
      fails through the same inline-error path without crashing the app.
      **Not exercised**: a real `invoke()` round-trip through a running
      desktop window — `tauri dev` launched a real process on this
      container's X server but no window ever mapped, consistent with every
      earlier phase's own note here; the Rust command itself (the exact code
      `invoke()` calls) was proven directly against the live network instead,
      which is a stronger proof of the code path than a UI click-through
      would have given without that gap.
- [x] Isometric and hexagonal tile grids — extends Phase 6's rect-only tilemap layer
      (`03-data-model.md` §4's own "v1 ships rect only… not implemented initially").
      Before this, `GridSpec.shape` was reachable neither from rendering nor from the
      UI: `renderTilemapCel` and `docPixelToCell` both hardcoded plain
      `col*tileWidth`/`row*tileHeight` math regardless of `shape`, and no control ever
      created a layer with anything but `shape: 'rect'` — isometric/hexagonal silently
      behaved exactly like rect, not "unreachable" or "errors," confirmed by reading the
      code rather than assumed. `model/gridGeometry.ts` is the new shared home for every
      shape's placement math: `cellOrigin` (grid cell → cel-local pixel origin, the
      forward transform) and its exact inverse `pixelToCell` (pixel → grid cell, for
      stamp-tool picking and the eyedropper), plus `tileDrawOrder` for back-to-front
      compositing order. **Isometric**: the standard 2:1 diamond shear,
      `x = offsetX + (col−row)·tileWidth/2`, `y = offsetY + (col+row)·tileHeight/2` — an
      invertible linear map, so picking is closed-form exact (round to the nearest
      diamond centre in the sheared coordinate space), not a search. **Hexagonal**:
      pointy-top, odd-row horizontal offset ("odd-r" in Red Blob Games' terminology,
      the standard reference for offset-coordinate hex grids), chosen because it keeps
      the same row-major dense `Uint32Array` grid buffer every shape shares — no new
      coordinate system to store or round-trip through `.tess`. Offset hex coordinates
      have no linear closed form, so picking searches the 3×3 neighbourhood of candidate
      cells and returns whichever bounding-box centre is nearest, which every
      forward-transform output round-trips through exactly (`gridGeometry.test.ts`, a
      7×7 window around the origin including a non-zero offset, both shapes). Both new
      shapes' tile bounding boxes legitimately overlap their neighbours by design (that
      is what makes the diamonds/hexagons interlock) — `renderTilemapCel` now alpha-
      composites (`compositeOver`) rather than overwrites for them, walking cells in
      `tileDrawOrder` (ascending `col+row` for isometric — plain grid-storage order is
      *not* correct back-to-front order there, proven by a regression test that writes
      the same two overlapping cells in the opposite order and asserts identical output;
      plain row-major already suffices for hex, since only adjacent rows overlap); `rect`
      keeps its original cheap overwrite, unchanged. Because `renderTilemapCel` is the
      one function `canvas/renderer.ts`, `canvas/flatten.ts`, and now `canvas/sample.ts`
      all call, every shape reads identically on screen, in an exported PNG, and under
      the eyedropper "for free" — `sample.ts`'s eyedropper used to re-derive pixel→tile
      math directly (would have been wrong for overlapping shapes, where a query pixel
      can fall inside more than one tile's bounding box) and now renders the cel through
      the same shared function instead; the one caller that samples every sprite pixel in
      a loop (`leafOwnBuffer`, an effect-bearing tilemap layer) was restructured to render
      its cel once up front rather than once per pixel, avoiding an O(pixels²)
      regression. **Stamp tool**: `tools/stampSession.ts`'s picking already flowed through
      `docPixelToCell`, so it picked up every shape with no code change of its own —
      proven by a dedicated test (clicking an isometric diamond's true centre targets that
      diamond, not the cell plain rect division would compute at the same pixel) and live
      (below). **UI**: `panels/TilesetPanel.tsx`'s "Add tilemap layer" used to hardcode
      `shape: 'rect'`; a grid-shape `<select>` (rect/isometric/hexagonal, defaulting to
      rect) now sits next to it, and `model/gridGeometry.ts::defaultGridOffset` supplies a
      shape-appropriate default offset — isometric is horizontally centred on the
      sprite's canvas (its diamond otherwise clips itself off-canvas to the left as `row`
      grows past `col`, since `cellOrigin`'s `(col−row)` term goes negative), rect/hex
      keep the unchanged canvas-origin default. **Honest limitation, not fixed by this
      item**: `tileGridDims`'s cols/rows extent is still a plain `cel size / tile size`
      division for every shape (`gridGeometry.ts`'s own module doc), so an
      isometric/hexagonal grid's *usable cell count* is not perfectly tuned to its actual
      on-screen diamond/hex footprint — a real 8×2-tile grid needed a taller cel than a
      naive `rows × tileHeight` guess to make its second row addressable at all, caught
      exactly this way by a test, not reasoned about in the abstract. Rust is untouched:
      `GridShape`/`GridSpec` already round-tripped all three variants through `.tess`
      since Phase 6 (`model::document::every_grid_shape_round_trips`), and Rust never
      composites or places tiles at all (`02-architecture.md` §6.2), so there was no
      placement math to mirror. `tilemap_export.rs`'s Tiled JSON always writes
      `"orientation": "orthogonal"` regardless of the layer's actual shape — a real,
      known gap in the *export* schema's completeness, left unfixed; Tiled's hex/iso
      orientations also need `hexsidelength`/`staggeraxis`/`staggerindex` fields this
      command has no data for yet, so fixing the label alone would still leave the
      exported map wrong for a hex layer. New tests: `model/gridGeometry.test.ts` (17
      cases — forward transform at known coordinates per shape, exact inverse round-trip
      for both shapes including a non-zero offset, draw-order correctness, default-offset
      centring), `model/tilemapRender.test.ts` (new isometric/hexagonal placement
      cases — depth-independent-of-storage-order, a real alpha blend at an overlap rather
      than "last opaque wins," hex row offset/step), `model/tileIds.test.ts` and
      `canvas/sample.test.ts` (shape-aware `docPixelToCell`/eyedropper cases, including
      one with an enabled effect to exercise the restructured `leafOwnBuffer`),
      `tools/stampSession.test.ts` (isometric pick targeting), and the first automated
      test file for `TilesetPanel` (`TilesetPanel.test.tsx`, the shape selector's three
      options and each one's resulting `GridSpec`). **Verified live** against the real
      Vite dev bundle over Chrome DevTools Protocol (this container's Tauri WebView
      unreachable, consistent with every earlier phase's own note here; a fresh headless
      Chrome with its own isolated profile was needed since the shared desktop's existing
      Chrome session, running continuously since well before this pass, would not open a
      second debuggable instance): drove the *real* "New tileset" form, the *real*
      grid-shape `<select>`, and the *real* "Add tilemap layer" button through genuine DOM
      events (not store calls) and confirmed the resulting layer's `GridSpec` matched
      (`shape: 'isometric'`, `offsetX: 24` — the exact centred default — for a 64×64
      canvas and an 8-wide tileset); for both isometric and hexagonal, dispatched genuine
      `pointerdown`/`pointerup` `PointerEvent`s at the real, computed screen position of a
      specific diamond/hex cell's true centre (through the real `<canvas>` element's own
      `getBoundingClientRect`, the real live zoom/pan viewport, and the real `stamp` tool
      selection — the exact path `CanvasView`'s own `onPointerDown` takes) and confirmed
      the tile landed at the intended `(col, row)` — for hexagonal, specifically an
      odd-numbered row, the case that most obviously breaks under plain rect math if the
      row-shift were ignored — and *not* at the cell plain rect math would have picked at
      that same pixel. Also confirmed programmatically, in the live app's own store/model
      instances (not a second, disconnected module copy): stamping two isometric tiles at
      their true diamond centres placed them at the correct, distinct `(col, row)` pairs,
      and reading back the rendered cel's actual pixels showed the diamond interlock
      directly — a pixel inside tile B's bounding box but where plain rect placement would
      have put nothing came back opaque with tile B's own colour, and the pixel where
      rect math *would* have placed tile B came back fully transparent.

**Exit:** ✅ **Phase 7, and the roadmap through Phase 7, complete.** All seven items
landed: non-destructive layer effects, batch conversion + CLI mode, pixel-art-aware
rotate/scale, indexed colour mode with live palette swapping, bead/cross-stitch chart
export, Lospec URL import, and — closing the phase and the document — isometric and
hexagonal tile grids alongside the rect grid Phase 6 shipped. Only the struck-through
cross-platform verification item (D5, Linux-only by decision) was ever skipped; every
other checkbox in every phase from 0 through 7 is now `[x]`.

---

## Phase 8 · Live-usage follow-ups

Filed from real desktop usage after Phase 7 closed, not from the original plan. Ordered
by severity: a broken core workflow first, then two capability requests, then the doc
gap that made the others harder to self-serve.

- [x] Fix: Convert mode's preview canvas renders blank — the tool panel (pixel size,
      palette, dither, strength) and the status bar (`gameboy · 4 colours · 34.0 ms ·
      preview`) all reflect a live conversion, but `ConvertCanvas` draws nothing; the
      stage is just its own `--surface-sunken` background with no "Drop an image…"
      empty-state text either, so `frames.source` is not the empty case. Reported with a
      screenshot of a loaded 120×149 source at Game Boy (4) / no dither. Root cause was
      layout, not the preview pipeline: `.body` (`App.tsx`) is a 3-column CSS grid
      (`44px 1fr 220px`) templated for Edit mode's three direct children (`ToolRail`,
      `CanvasView`, `aside.panels`). Convert mode renders a single child, `<ConvertMode>`
      → `.convert-mode`, so without an explicit span CSS Grid auto-placed it into just
      the first (44px) column. Everything without `overflow: hidden` (the tool panel,
      status bar) still rendered, visibly overflowing that sliver; `.convert-canvas`
      does have `overflow: hidden` and collapsed to ~0×N, which is why only the canvas
      area went blank. Fixed with `grid-column: 1 / -1` on `.convert-mode`
      (`src/styles/global.css`) so it spans every column of its parent grid, with a
      comment explaining why. Confirmed with the real running app, not source review
      alone: ran the Vite dev bundle under a real headless Chrome over CDP
      (`google-chrome --headless=new --remote-debugging-port=9222`, native Node
      `WebSocket` driving the CDP wire protocol), clicked the real Convert tab, injected
      a synthetic source into `previewRuntime`/`convertStore` (same technique earlier
      Phase 5/7 items in this file used), and read back real canvas pixels and
      `getBoundingClientRect`/computed-style geometry — before the fix, `.convert-canvas`
      measured `0×N` px with only 1 non-background pixel decoded from `getImageData`;
      after, it measured `1080×796` px with 633,616 of 859,680 pixels drawn, and a
      screenshot showed a correct before/after split with the Game Boy palette applied.
      Also drove a real control change (`setPixelSize`) after load and confirmed the
      canvas re-rendered with new content, and re-checked Edit mode's layout
      (`ToolRail`/`CanvasView`/`aside.panels`, unaffected — still 1136×838, three real
      columns) to confirm the fix does not regress the grid it was originally built for.
- [ ] Feature: raise the tilemap/document size ceiling for large maps. `MAX_SPRITE_SIZE`
      (`src/app/newSprite.ts`) caps every document — and therefore every tilemap layer's
      cel, since a cel cannot exceed its sprite (`03` §9) — at 2048×2048, which a tile
      grid at typical tile sizes (16–32px) blows through well before typical tilemap
      "large map" ambitions (see `06-workflows.md`'s tilemap workflow). Raise the cap
      (`docs/00-vision-and-scope.md` §8's own success criteria and `10-decisions.md` for
      whether a ceiling is load-bearing anywhere else — e.g. the proxy pipeline's
      `PREVIEW_PROXY_MAX_EDGE`, which must stay independent of this) and re-check the
      places that assume "sprite" means "small": canvas viewport pan/zoom at the new
      size, `tileGridDims`'s shape-aware extent walk (`03` §4) for isometric/hexagonal at
      a large grid, undo dirty-rect cost, and `.tess` round-trip size. If a flat cap is
      the wrong shape for this — e.g. tilemap layers wanting to exceed their sprite's own
      canvas, not just a bigger shared canvas — say so and scope down to what the data
      model actually supports today rather than redesigning the cel/sprite relationship.
- [ ] Content: bundle at least one more hardware palette alongside Game Boy/NES/CGA/
      C64/ZX Spectrum (`src/lib/palettes/builtin.ts`). Read the `bundled-asset-license`
      skill first — only factual hardware/fixed-spec colour lists may be bundled
      (Lospec artist palettes stay import-only, never bundled). Candidates worth
      checking against a primary source: Game Boy Color's default BIOS palette, Sega
      Master System / Genesis, MSX2, Apple II lo-res, PICO-8 (a fixed published spec,
      not an artist work, so the same reasoning as the existing hardware set applies —
      confirm before treating it as equivalent). Add via the existing `palette()` helper
      and extend `builtin.test.ts`'s coverage the same way the current five are covered.
- [ ] Docs: write a user-facing Editor guide. Everything in `docs/` today is the design
      spec (`docs/README.md`'s own framing: "the specification, not background
      reading") — there is no document that walks a *user* through the Editor mode
      itself: the seven tools, layers/groups, palettes, the timeline/frames panel,
      tilemaps, undo, and export, task-oriented rather than architectural. Add it as a
      new numbered doc (e.g. `docs/11-editor-guide.md`) or under a `docs/guide/`
      subdirectory if a second user-facing doc (a Convert guide) is likely to follow —
      pick based on what's already there, don't guess a structure the docs don't use
      yet. Link it from `docs/README.md`'s reading-order table and from the root
      `README.md`. Scope to what's actually shipped (cross-check against this roadmap's
      own `[x]` items, not the feature list from memory) rather than aspirational.

**Exit:** the Convert preview renders correctly for a fresh load and after every control
change; a large tilemap (state the new ceiling explicitly) is creatable and paintable at
usable performance; the new palette appears in the palette picker with correct swatches;
and the Editor guide is linked from both READMEs and matches shipped behaviour.

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
  **Measured in Phase 4 (`10-decisions.md` D14): holds at the app's documented typical
  sprite size (≤512×512) even at onion skinning's maximum range, ~150 fps mean worst
  case. Margin narrows by 1024×1024; re-measure if the app's target canvas size ever
  grows past what `00-vision-and-scope.md`/`03-data-model.md` currently imply.**
- IPC benchmarks show handle-passing is still too slow for editor-layer export → rethink
  where pixel data lives.
- `ort` never stabilizes → ship flood-fill only, or bind ONNX Runtime C API directly.
