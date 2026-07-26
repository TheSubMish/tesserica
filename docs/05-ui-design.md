# UI & Design

> Status: **draft for review** · Last updated: 2026-07-26

## 1. The core tension

`00-vision-and-scope.md` §4 sets two requirements that pull against each other:

- A casual user must get from photo to pixel art **in 10 seconds**.
- A game dev must be able to **live in this app for hours**.

An editor that opens with 40 tools fails the first. A converter with three sliders fails
the second. The resolution is **modes**.

## 2. Mode-based structure

**Two modes** sharing one document (locked — `10-decisions.md` D6, D7):

| Mode | Purpose | Shown by default |
|---|---|---|
| **Convert** | Image → pixel art. Source view, settings, live preview. | When opening an image file |
| **Edit** | Full drawing editor. Tools, layers, palette, timeline. | When creating a new sprite |

Animation is **a panel inside Edit**, not a third mode (§5) — it shares Edit's canvas,
tools, layers and palette entirely, and a mode that is 90% identical to another mode is
not a mode.

Modes are **views over the same document**, not separate apps. Switching is instant and
lossless. A conversion layer stays live and re-editable in Edit mode; switching back to
Convert re-opens its settings.

This is the structural expression of the product thesis: convert is *the first step of an
editing session*, and the mode switch is the seam that no reference tool has.

```
┌──────────────────────────────────────────────────────────────┐
│  ≡  [ Convert │ Edit ]                        ⚙  ◑  ─ □ ✕   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│         (mode-specific layout — see §3, §4, §5)              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  64×48  ·  PICO-8 (16)  ·  Layer 1  ·  100%  ·  x:12 y:31   │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Convert mode

The 10-second path. Modelled on Pixel Art Village's upload → adjust → export spine
(`01-reference-analysis.md` §3).

```
┌──────────────────────────────────────────────────────────────────────┐
│  ≡  [ Convert │ Edit ]                                 ⚙  ◑  ─ □ ✕  │
├─────────────────────────────────┬────────────────────────────────────┤
│                                 │  CONVERT                           │
│    ┌─────────┐   ┌─────────┐    │  ┌──────────────────────────────┐  │
│    │         │   │▄▄▄  ▄▄▄ │    │  │ Pixel size      ────●───  12  │  │
│    │ source  │ → │ ▀▀█▄▄█▀ │    │  │ Output          64 × 48       │  │
│    │  photo  │   │  ▐████▌ │    │  └──────────────────────────────┘  │
│    │         │   │  ▀▀  ▀▀ │    │  ┌──────────────────────────────┐  │
│    └─────────┘   └─────────┘    │  │ Palette    [ PICO-8   ▾ ] 16 │  │
│                                 │  │ ■■■■■■■■■■■■■■■■             │  │
│    [ ⇄ split ] [ ⬓ side ]       │  │ Dither     [ Floyd–St. ▾ ]   │  │
│                                 │  │ Strength   ──────●──   0.8   │  │
│    ⊖ ──────●────── ⊕   fit      │  └──────────────────────────────┘  │
│                                 │  ▸ Adjustments                     │
│                                 │  ▸ Background                      │
│                                 │  ▸ Cleanup                         │
│                                 │  ┌──────────────────────────────┐  │
│                                 │  │  [ Export… ]  [ Edit → ]     │  │
│                                 │  └──────────────────────────────┘  │
├─────────────────────────────────┴────────────────────────────────────┤
│  photo.jpg 4000×3000 → 64×48  ·  PICO-8  ·  preview (proxy)          │
└──────────────────────────────────────────────────────────────────────┘
```

Design notes:

- **Before/after is the default view.** Users judge conversion by comparison. Split-slider
  and side-by-side both offered.
- **Only four controls visible.** Pixel size, palette, dither, strength. Everything else
  is behind collapsed sections. This is what makes 10 seconds achievable.
- **`[ Edit → ]` is the whole thesis in one button.** It creates a conversion layer and
  switches modes. Prominent, always visible.
- **Status bar states when the preview is a proxy** (`02-architecture.md` §3.3), with the
  full-quality parity check available from the Export dialog.
- Drop target is the entire window when no image is loaded.

---

## 4. Edit mode

Conventional editor layout — deliberately. Users arrive with Aseprite/Photoshop/Krita
muscle memory and there is no upside to being different.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ≡  [ Convert │ Edit ]                                 ⚙  ◑  ─ □ ✕  │
├────┬────────────────────────────────────────────┬────────────────────┤
│ ✏  │                                            │ LAYERS       + ⧉ 🗑│
│ ⌫  │        ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁                  │ ┌────────────────┐ │
│ 🪣 │      ░░░░░░░░░░░░░░░░░░░░░░                │ │👁 🔒 outline   │ │
│ ╱  │      ░░░░▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░                │ │👁    character │ │
│ ▭  │      ░░░▓▓░░▓▓▓▓░░▓▓▓░░░░░░                │ │👁    ▸ photo ⚙ │ │
│ ◯  │      ░░░▓▓░░▓▓▓▓░░▓▓▓░░░░░░                │ │👁    bg        │ │
│ ⬚  │      ░░░░▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░                │ └────────────────┘ │
│ ✋ │      ░░░░░░░░░░░░░░░░░░░░░░                │ Normal ▾  100% ──● │
│ 💧 │                                            ├────────────────────┤
├────┤                                            │ PALETTE     ▾ ⊞ ⬇ │
│ ██ │                                            │ ■■■■■■■■           │
│ ▨  │                                            │ ■■■■■■■■           │
│ ⇄  │                                            │ PICO-8 · 16 colors │
├────┴────────────────────────────────────────────┴────────────────────┤
│  64×48  ·  Pencil 1px  ·  character  ·  400%  ·  x:12 y:31           │
└──────────────────────────────────────────────────────────────────────┘
```

- **Left rail:** tools, single column, icon-only with tooltips showing the shortcut.
- **Right panels:** layers (top), palette (bottom). Both collapsible and detachable.
- **Conversion layers get a ⚙ badge** in the layer list — click to reopen Convert mode
  for that layer. This is the visible affordance for non-destructive conversion.
- **Canvas** is checkerboard-backed, nearest-neighbour zoom, grid overlay appearing
  automatically above ~400% zoom.

### 4.1 Tools (v1)

| Tool | Key | Notes |
|---|---|---|
| Pencil | `B` | Pixel-perfect mode on by default (removes L-corner doubling) |
| Eraser | `E` | |
| Fill | `G` | Contiguous + global modes, tolerance |
| Line | `L` | Bresenham, pixel-perfect |
| Rectangle | `U` | Filled/outline |
| Ellipse | `O` | Midpoint algorithm — **not** a scaled circle |
| Eyedropper | `I` | `Alt` from any tool |
| Select | `M` | Rect, ellipse, lasso, magic wand |
| Move | `V` | |
| Pan | `Space` | Held, from any tool |
| Zoom | `Z` | `Ctrl`+wheel from any tool |

**Pixel-perfect mode** matters more than it sounds. A freehand diagonal stroke naturally
produces doubled corner pixels that look wrong in pixel art; pixel-perfect mode removes
them in real time. Pixelorama leads with this and it is table stakes.

---

## 5. Timeline panel (inside Edit)

Toggleable bottom panel within Edit mode — **not** a separate mode (`10-decisions.md` D7).
Hidden by default so people making single sprites never see it; toggled from the View
menu or a keyboard shortcut.

```
├──────────────────────────────────────────────────────────────────────┤
│ TIMELINE   ⏮ ⏵ ⏭  ◐ onion   [idle ][ walk    ][ attack ]   12 fps   │
│         │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │11 │12 │           │
│ outline │ ● │   │   │   │ ● │   │   │   │ ● │   │   │   │           │
│ charact │ ● │ ● │ ● │ ● │ ● │ ● │ ● │ ● │ ● │ ● │ ● │ ● │           │
│ bg      │ ●─┼───┼───┼───┼───┼───┼───┼───┼───┼───┼───┼──▶│  linked   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Layer × frame grid** — the direct visual expression of the cel model
  (`03-data-model.md` §2.2). Filled dot = cel present, hollow = empty, horizontal bar =
  linked cel.
- **Tags shown as colored spans** above the frames, with preset names (idle/walk/run/
  attack/hurt/death) offered on creation.
- **Onion skinning** toggle with configurable before/after counts and tint.

---

## 6. Visual design

### 6.1 Principles

1. **The artwork is the only saturated thing on screen.** Chrome is neutral gray;
   saturated color is reserved for the canvas, the palette, and selection state. A
   colorful UI actively interferes with color judgement.
2. **Dark by default.** Standard for art tools, and it keeps the UI from influencing
   perceived brightness of the work. Light theme provided.
3. **Dense but not cramped.** Pro tools earn density; 8px base spacing, 28px control
   height.
4. **No animation on anything in the hot path.** Panel transitions are fine. Tool
   switching, canvas updates, and slider feedback are instant.

### 6.2 Tokens

```css
:root {
  /* dark (default) */
  --bg-app:        #1a1a1e;
  --bg-panel:      #232329;
  --bg-elevated:   #2c2c34;
  --bg-canvas:     #141417;
  --border:        #35353d;
  --border-strong: #4a4a55;

  --text:          #e8e8ec;
  --text-muted:    #9a9aa5;
  --text-faint:    #6a6a75;

  --accent:        #6c9fff;   /* selection, focus, active tool */
  --accent-muted:  #3a5ba8;
  --warn:          #ffb347;
  --danger:        #ff6b6b;

  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 24px; --space-6: 32px;

  --radius:    4px;
  --radius-lg: 8px;

  --font-ui:   system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Menlo, monospace;

  --control-h:    28px;
  --control-h-sm: 22px;
}
```

Numeric readouts (coordinates, dimensions, hex values) use `--font-mono` — they change
constantly and proportional digits jitter.

### 6.3 The canvas checkerboard

Fixed **8px screen-space** squares in `#2a2a30` / `#232329`, *not* scaling with zoom.
Zoom-scaled checkerboard is easily mistaken for artwork at high zoom levels.

---

## 7. Interaction rules

1. **Space-drag pans from any tool.** Universal across art software.
2. **`Ctrl`+wheel zooms toward the cursor**, plain wheel scrolls vertically,
   `Shift`+wheel horizontally.
3. **`Alt` picks color from any painting tool**, releasing returns to the previous tool.
4. **`[` / `]` adjust brush size** without leaving the canvas.
5. **`X` swaps foreground/background**, `D` resets to black/white.
6. **Every slider is also a number field.** Click the value to type it. Precision matters
   at these sizes and dragging cannot hit an exact 12.
7. **`Ctrl+Z` is global and coalesced** — one drag is one undo (`03-data-model.md` §6).
8. **Escape cancels the in-progress operation**, never closes the document.

---

## 8. Accessibility

- **All targets ≥24×24 px** even in the dense tool rail.
- **Text contrast ≥4.5:1** against its background; verify `--text-muted` on `--bg-panel`.
- **Never encode state in color alone.** Active tool gets a background *and* a left bar;
  layer visibility uses an icon, not a color.
- **Full keyboard access** to tools, layers, and menus; visible focus rings.
- **Respect `prefers-reduced-motion`** for panel transitions.
- Color blindness is a genuine consideration for a *palette* tool: offer a simulation
  preview (protanopia/deuteranopia/tritanopia) in the palette panel. Cheap to implement,
  meaningful for users choosing game palettes.

## 9. Open UI questions

Convert-as-mode and Animate-as-panel are **resolved** (`10-decisions.md` D6, D7).

Still open: floating vs docked panels, and whether panels should be detachable into
separate windows at all given the Linux-only target (`10-decisions.md` D5).
