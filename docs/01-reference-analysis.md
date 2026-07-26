# Reference Analysis

> Status: **draft for review** · Last updated: 2026-07-26
> Sources gathered by fetching each product's site on 2026-07-26, plus targeted
> searches on algorithms and file formats. Claims below are attributed; where a site
> was vague, that is noted rather than filled in with assumptions.

## 1. Summary table

| Tool | Category | Local? | Editor | Converter | Animation | Takeaway for us |
|---|---|---|---|---|---|---|
| [Pixelorama](https://pixelorama.org/) | FOSS editor (Godot) | ✅ | ★★★ | ✗ | ★★★ | **Primary model for the editor half** |
| [Aseprite](https://www.aseprite.org/docs/files/) | Commercial editor | ✅ | ★★★ | ✗ | ★★★ | File format to import; UX gold standard |
| [Pixel It](https://giventofly.github.io/pixelit/) | JS converter lib | ✅ (browser) | ✗ | ★★ | ✗ | Simple, legible conversion API |
| [Pixel Art Village](https://pixelartvillage.org/) | Web converter | ✅ (browser) | ✗ | ★★★ | ✗ | **Primary model for the converter half** |
| [PixelMe](https://pixel-me.tokyo/) | AI avatar converter | ✗ | ✗ | ★★ (AI) | ✗ | Bead/cross-stitch export idea |
| [Pixellab AI](https://www.pixellab.ai/) | AI generation | ✗ | ★ | ✗ | ★★★ (AI) | Feature *vocabulary* for game assets |
| [pixie.haus](https://pixie.haus/) | AI generation | ✗ | ★ | ★★ (AI) | ★★ (AI) | Lospec palette integration |
| [Adobe Firefly](https://www.adobe.com/products/firefly/features/pixel-art-generator.html) | AI generation | ✗ | ✗ | ✗ | ✗ | Out of our category entirely |

---

## 2. Pixelorama — the editor benchmark

Open-source, built in Godot. This is the closest thing to what we want the editor half
to be, and its feature list is effectively our v2/v3 backlog.

**Features (from pixelorama.org):**

- **Animation:** frame-by-frame drawing, onion skinning, frame tags, real-time drawing
  during playback, audio sync for animations. Exports spritesheets, GIF, and video.
  Imports animations from Aseprite, Photoshop, and Krita.
- **Drawing:** pixel-perfect line drawing, dedicated shading tools, palette management,
  **indexed color mode**.
- **Scaling/rotation algorithms:** cleanEdge, OmniScale, rotxel — pixel-art-aware
  resamplers, not bilinear.
- **Layers:** clipping masks, group blending, **3D layers**, and non-destructive effects
  (outlines, gradient maps, drop shadows) with custom effect import.
- **Game dev:** **tilemap layers for rectangular, isometric, and hexagonal tiles**,
  custom user data on elements, and a **CLI for bulk export / automation**.

**What we take:**

1. Tilemap layers as a first-class layer *type*, not a separate mode. Directly relevant
   to the "game map" use case.
2. Non-destructive effects as a layer property.
3. Pixel-art-aware rotate/scale. Bilinear resampling on pixel art is the single most
   common way a tool reveals it does not understand the medium. `rotxel` and `cleanEdge`
   are the reference implementations to study.
4. Indexed color mode — makes palette swapping trivial, which matters a lot for game
   character variants.
5. A CLI for batch export. Cheap to add once the core exists, and disproportionately
   useful to game devs with dozens of sprites.

**What we skip:** 3D layers, audio sync. Both are far outside our scope.

**Caveat:** the site did not detail panel layout, so our UI layout in `05-ui-design.md`
is informed by the general class of editors (Aseprite/Krita/Photoshop conventions)
rather than copied from Pixelorama specifically.

---

## 3. Pixel Art Village — the converter benchmark

The most directly comparable converter, and closest to the UX we want for our
conversion mode.

**Controls exposed:** pixel size, palette selection (built-in *or* user-created),
brightness/contrast/saturation, dithering options, and "cleanup" settings.

**Workflow:** upload (PNG/JPG/GIF/WEBP) → adjust with **live preview** → export
(PNG/JPEG/WebP), with output scaling for project use and no dimension limits.

**Notably:** processing is entirely browser-side and the site markets this as a privacy
feature — "images stay on your device". This validates local-first as a *selling point*,
not just an implementation detail.

**What we take:**

1. The three-step **upload → adjust (live) → export** spine. This is the whole casual
   user journey and it should be achievable without ever seeing a layer panel.
2. Adjustments (brightness/contrast/saturation) belong *in the conversion panel*, applied
   before quantization. Order matters — see `04-image-pipeline.md` §2.
3. "Cleanup" — the site is vague on what this means, but the need is real: after
   quantization you get isolated stray pixels and jagged runs. We should define this
   concretely (despeckle / morphological open) rather than ship a mystery slider.
4. Export scaling as a first-class export option, not an afterthought.

---

## 4. Pixel It — the algorithm reference

A small JS library. Value here is that its API is *legible* — it shows the minimum viable
conversion pipeline.

**Controls:** block size (0–50), greyscale toggle, palette conversion, max width/height.

**Palettes:** ships a default, and imports `.hex` files, Pixilart text files, and
Paint.net `.txt`. Users can also build palettes by clicking colors, then save/clear them.

**API shape:** chainable — `.pixelate()`, `.convertPalette()`, `.convertGrayscale()`,
resize-to-constraints, then canvas export. The docs explicitly warn that **the order the
methods are applied changes the result**, which is exactly the design tension our
pipeline has to resolve by making the order fixed and explicit.

**What we take:**

1. Palette **file format support** is table stakes: `.hex`, `.gpl` (GIMP), `.pal` (JASC),
   Paint.net `.txt`. Lospec offers all of these (see §7), so supporting them unlocks
   ~4,400 community palettes for free.
2. A fixed, documented pipeline order — learning from their warning rather than
   repeating it.

**What we improve:** their palette mapping is (as far as the docs say) nearest-color in
RGB. RGB distance is perceptually wrong — it makes dark colors mush together and picks
visually bad matches. We use Oklab. See §8.

---

## 5. PixelMe — casual conversion

AI photo→pixel avatar. Upload, AI converts, download. Free on web, no account; a mobile
app adds "advanced AI conversion" and pixel-level editing behind payment.

**Options:** pixel size, and then a set of *output* framings — social icons, game assets,
**bead art patterns and cross-stitch charts** (with adjustable spacing, scale, rotation),
phone wallpapers.

**What we take:** the **bead/cross-stitch chart export** is a genuinely clever
repurposing — a pixel grid with a color-key legend and grid coordinates. It is cheap for
us to implement (we already have an indexed grid and a palette) and opens a whole
non-gaming audience. Filed as a v3 "nice to have" in `08-roadmap.md`.

**What we reject:** the AI conversion core, and the pattern of paywalling the editor.

---

## 6. Pixellab AI & pixie.haus — the AI generation tier

Studied for **feature vocabulary**, not implementation.

**Pixellab AI:** text-prompted character animation; skeleton-based animation control;
**4- and 8-directional sprite rotations** from a single character; isometric support;
style consistency across sprites; true inpainting that "sees the original image";
tilesets for seamless maps; top-down and side-scroller map styles; UI elements
(buttons, health bars, menus).

**pixie.haus:** text→sprite with **"true 1:1 grid snapping"**; image→pixel that
"downsamples to the grid and matches your palette"; image-to-image edits preserving
pixel structure; idle/walk/attack cycles; GIF and spritesheet export; **Lospec-compatible
palette selector** (sweetie-16, pico-8); ~3 min generation time; credit system.

**What we take (as non-AI features):**

1. **Grid snapping is the headline quality signal.** Both tools lead with it. Our
   converter must detect and honour a pixel grid — output where a "pixel" is 6.3 source
   pixels wide is the tell of a bad converter. See `04-image-pipeline.md` §3.
2. **Directional sprite sets and animation cycles** (idle/walk/attack) are the units
   game devs actually think in. Even without AI, our animation UI should offer these as
   *frame tag presets* rather than making users name everything from scratch.
3. **Lospec palette compatibility** is the de facto community standard. Both AI tools
   integrate it. Confirms §4's conclusion.
4. **Tilesets and UI-element assets** are named asset categories worth having export
   presets for.

**What we take (as UX):** pixie.haus's ~3-minute generation with a completion
notification is a reminder that our local background-removal inference (a few seconds)
must still be async and non-blocking with clear progress.

---

## 7. Lospec — the palette ecosystem

[Lospec's Palette List](https://lospec.com/palette-list) is a database of ~4,396 pixel
art palettes, both hardware-derived (Game Boy, etc.) and artist-made.

**Download formats offered:** PNG (various scales), **PAL (JASC)**, **ASE (Photoshop)**,
**TXT (Paint.net)**, **GPL (GIMP)**, and **HEX**.

**Implication:** supporting `.hex`, `.gpl`, `.pal`, and Paint.net `.txt` import covers
the entire Lospec catalog. This is a few hundred lines of parsing for an enormous content
win, and should land in v1. A "paste a Lospec URL" importer is a natural v2 follow-up,
though it needs a network call and should be opt-in given our local-first stance.

---

## 8. Algorithm research findings

From targeted searches on quantization and dithering:

- **Oklab is the right color space** for palette matching and error diffusion. Nearest-
  color in sRGB is perceptually wrong; Oklab is perceptually uniform, so Euclidean
  distance in it approximates perceived difference. Sources indicate error-diffusion
  dithering in Oklab produces materially better results.
- **Quantizer of choice:** Wu's algorithm followed by ~8 iterations of k-means in Oklab
  is described as the best general-purpose approach. For our case, this only applies to
  *auto-palette* generation — when the user picks a fixed palette (the common case) we
  are doing nearest-color mapping, not quantization.
- **Dithering:** Floyd–Steinberg (1976) is the standard error-diffusion method, pushing
  residual quantization error onto neighbouring pixels. Ordered/Bayer dithering uses a
  fixed 2×2/4×4/8×8 threshold matrix producing a structured repeating pattern — better
  for a deliberate retro-screen aesthetic. Atkinson is a third common variant.
  **We should ship all three plus "none"**, since they are aesthetic choices, not
  quality tiers.
- Surma's *Ditherpunk* and shihn.ca's dithering write-up are the two best implementation
  references found; both are linked in `04-image-pipeline.md`.

---

## 9. Aseprite file format

From the [official spec](https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md):

- `.ase` and `.aseprite` are the same format. Preserves color mode, layers, frames,
  palette, tags, slices.
- **Structure:** 128-byte header (dimensions, color depth) → frames. Each frame has a
  header (size, magic number, chunk count, duration) followed by typed chunks (palette,
  layer, cel, …).
- **Cels** are the bridge between a layer and a frame — the content of one layer at one
  frame. This layer×frame → cel model is the correct data model for animation and we
  should adopt it directly (see `03-data-model.md`).
- A Rust crate (`aseprite-io`) exists, worth evaluating before hand-rolling a parser.

**Decision:** adopt the layer/frame/cel model. Implement `.ase` *import* in v2; treat
export as lower priority (users who own Aseprite mostly want to bring work *in*).

---

## 10. What nobody in this list does

The gap we are aiming at, restated concretely:

1. **Convert → edit in one session.** Every converter is a dead end; every editor
   assumes you already have pixel art.
2. **Local background removal integrated with conversion.** The "photo → clean character
   sprite" path currently requires a separate service, usually a cloud one.
3. **Local-first with a real editor.** Pixelorama and Aseprite are local but have no
   converter. Every converter with good UX is a web app.

## 11. Sources

- [Pixelorama](https://pixelorama.org/)
- [Aseprite file format spec](https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md) · [Aseprite files docs](https://www.aseprite.org/docs/files/) · [aseprite-io crate](https://docs.rs/aseprite-io)
- [Pixel It](https://giventofly.github.io/pixelit/)
- [Pixel Art Village](https://pixelartvillage.org/)
- [PixelMe](https://pixel-me.tokyo/)
- [Pixellab AI](https://www.pixellab.ai/)
- [pixie.haus](https://pixie.haus/)
- [Lospec Palette List](https://lospec.com/palette-list)
- [Floyd–Steinberg dithering (Wikipedia)](https://en.wikipedia.org/wiki/Floyd%E2%80%93Steinberg_dithering)
- [Ditherpunk — surma.dev](https://surma.dev/things/ditherpunk/)
- [Reducing Colors In An Image ⇢ Dithering — shihn.ca](https://shihn.ca/posts/2020/dithering/)
- [rembg](https://github.com/danielgatis/rembg) · [rembg-rs](https://lib.rs/crates/rembg-rs) · [U2-Net explainer](https://learnopencv.com/u2-net-image-segmentation/)
- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
