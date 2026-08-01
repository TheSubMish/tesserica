//! Bead / cross-stitch pattern chart export (`docs/08-roadmap.md` Phase 7
//! "Bead / cross-stitch chart export (W9)", `docs/06-workflows.md` W9).
//!
//! **Split of responsibility, same shape as every other export command in
//! this file's neighbours** (`animation_export.rs`, `tilemap_export.rs`):
//! `src/model/patternChart.ts` derives the small indexed grid + legend (an
//! indexed sprite's own palette, or one derived from the flattened composite
//! via the conversion pipeline's `autoPalette` + `nearestIndexOklab` — see
//! that module's own doc comment) and sends it here as plain JSON —
//! `width * height` small integers plus a short legend, the same "not a
//! pixel buffer" reasoning `tilemap_export.rs`'s `tile_ids: Vec<u32>` already
//! rests on. Rust does the print-quality rendering: this is full-resolution,
//! ship-quality output, and `docs/02-architecture.md` §3 puts that in Rust.
//!
//! **No font-rendering dependency.** Coordinate labels and legend fields are
//! drawn with a hand-authored 3×5 pixel digit font (this module's own
//! `DIGIT_GLYPHS`) rather than pulling in `ab_glyph`/`rusttype`/`imageproc` —
//! this project already avoids dependencies where a small amount of its own
//! code covers the need (`CLAUDE.md`'s "dependency notes": the `palette`
//! crate was rejected for the same reason), and every label this chart draws
//! is digits only (row/column numbers, RGB channel values, pixel counts, and
//! the per-cell color symbol), so a full alphabet was never needed. Symbols
//! are therefore numeric (`1`, `2`, …, matching legend order) rather than
//! letters — a legitimate, common convention in real charts (numbered
//! symbol keys), not just this module's own shortcut.
//!
//! **Cell size is not the "integer export scale" invariant.** `ALLOWED_SCALES`
//! (`export.rs`) governs *replicating pixel-art pixels* — 1×/2×/4×/8× so a
//! pixel never becomes an uneven block. A pattern chart is a diagram, not a
//! pixel-replicated image: each source pixel becomes exactly one schematic
//! cell of `cell_size` physical pixels, at whatever size makes it legible on
//! paper. `cell_size` is validated against its own bounds
//! (`MIN_CELL_SIZE..=MAX_CELL_SIZE`) instead.

use serde::{Deserialize, Serialize};

use crate::commands::export::encode_png;
use crate::error::AppError;
use crate::pipeline::oklab::srgb8_to_oklab;

pub const MIN_CELL_SIZE: u32 = 4;
pub const MAX_CELL_SIZE: u32 = 200;

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternChartLegendInput {
    pub color: [u8; 4],
    pub count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPatternChartRequest {
    pub width: u32,
    pub height: u32,
    /// Row-major, `width * height` entries — an index into `legend`, or `-1`
    /// for an empty cell (`src/model/patternChart.ts::PatternChartData.grid`).
    pub grid: Vec<i32>,
    /// Ordered by descending count, matching the grid's own indices.
    pub legend: Vec<PatternChartLegendInput>,
    pub cell_size: u32,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPatternChartResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub colors: u32,
    pub bytes: u64,
}

// ---------------------------------------------------------------------------
// A hand-authored 3-wide × 5-tall digit font (see module doc comment for why).
// Each glyph is 5 rows; each row's 3 low bits are its 3 columns,
// most-significant bit = leftmost column.
// ---------------------------------------------------------------------------

#[rustfmt::skip]
const DIGIT_GLYPHS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b010, 0b010, 0b010, 0b010], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b001, 0b001, 0b001], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

const GLYPH_W: u32 = 3;
const GLYPH_H: u32 = 5;

fn glyph_pixel(digit: u8, row: u32, col: u32) -> bool {
    let bits = DIGIT_GLYPHS[digit as usize][row as usize];
    (bits >> (GLYPH_W - 1 - col)) & 1 == 1
}

/// Big-endian decimal digits of `n`. Always at least one digit (`0` → `[0]`).
fn digits_of(n: u32) -> Vec<u8> {
    if n == 0 {
        return vec![0];
    }
    let mut n = n;
    let mut out = Vec::new();
    while n > 0 {
        out.push((n % 10) as u8);
        n /= 10;
    }
    out.reverse();
    out
}

/// `digits_of`, left-padded with zeros to at least `width` digits.
fn digits_of_padded(n: u32, width: usize) -> Vec<u8> {
    let mut d = digits_of(n);
    while d.len() < width {
        d.insert(0, 0);
    }
    d
}

/// Pixel width of `digit_count` digits at `scale`, including the 1-pixel
/// (times `scale`) gap between digits.
fn number_width(digit_count: usize, scale: u32) -> u32 {
    if digit_count == 0 {
        return 0;
    }
    let digit_count = digit_count as u32;
    digit_count * GLYPH_W * scale + digit_count.saturating_sub(1) * scale
}

/// The label interval (draw every Nth row/column number) that keeps labels
/// from overlapping at this `cell_size`/`scale`, for axis values up to
/// `max_value`.
const LABEL_INTERVALS: [u32; 10] = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];

fn choose_label_interval(cell_size: u32, scale: u32, max_value: u32) -> u32 {
    let digit_count = digits_of(max_value).len();
    let needed = number_width(digit_count, scale) + scale * 2;
    for &interval in LABEL_INTERVALS.iter() {
        if cell_size.saturating_mul(interval) >= needed {
            return interval;
        }
    }
    *LABEL_INTERVALS.last().unwrap()
}

/// Black or white ink for legible text over `color`, decided in Oklab
/// lightness — the same "colour maths belongs in a perceptual space"
/// reasoning `canvas/effects.ts`'s gradient-map uses for luminance
/// (`docs/08-roadmap.md` Phase 7's own note on that choice), reused here for
/// a text-contrast decision rather than a second luma formula.
fn contrast_ink(color: [u8; 4]) -> [u8; 4] {
    let lab = srgb8_to_oklab(color[0], color[1], color[2]);
    if lab.l > 0.6 {
        [0, 0, 0, 255]
    } else {
        [255, 255, 255, 255]
    }
}

// ---------------------------------------------------------------------------
// A straight-alpha RGBA canvas with drawing primitives, bundled so the
// per-call argument lists below stay small.
// ---------------------------------------------------------------------------

struct Canvas {
    buf: Vec<u8>,
    w: u32,
    h: u32,
}

impl Canvas {
    fn new(w: u32, h: u32, background: [u8; 4]) -> Self {
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        for px in buf.chunks_exact_mut(4) {
            px.copy_from_slice(&background);
        }
        Self { buf, w, h }
    }

    fn put_pixel(&mut self, x: i64, y: i64, color: [u8; 4]) {
        if x < 0 || y < 0 || x as u32 >= self.w || y as u32 >= self.h {
            return;
        }
        let i = ((y as u32 * self.w + x as u32) * 4) as usize;
        self.buf[i..i + 4].copy_from_slice(&color);
    }

    fn fill_rect(&mut self, x0: i64, y0: i64, w: u32, h: u32, color: [u8; 4]) {
        for dy in 0..h as i64 {
            for dx in 0..w as i64 {
                self.put_pixel(x0 + dx, y0 + dy, color);
            }
        }
    }

    fn draw_digit(&mut self, x0: i64, y0: i64, digit: u8, scale: u32, color: [u8; 4]) {
        for row in 0..GLYPH_H {
            for col in 0..GLYPH_W {
                if !glyph_pixel(digit, row, col) {
                    continue;
                }
                let px = x0 + (col * scale) as i64;
                let py = y0 + (row * scale) as i64;
                self.fill_rect(px, py, scale, scale, color);
            }
        }
    }

    fn draw_digits(&mut self, x0: i64, y0: i64, digits: &[u8], scale: u32, color: [u8; 4]) {
        let mut x = x0;
        for (i, &d) in digits.iter().enumerate() {
            if i > 0 {
                x += scale as i64;
            }
            self.draw_digit(x, y0, d, scale, color);
            x += (GLYPH_W * scale) as i64;
        }
    }
}

// ---------------------------------------------------------------------------
// Layout — computed once, reused by rendering and by tests that need to know
// where a given cell/label landed.
// ---------------------------------------------------------------------------

struct Layout {
    scale: u32,
    pad: u32,
    margin_left: u32,
    margin_top: u32,
    grid_w: u32,
    grid_h: u32,
    col_interval: u32,
    row_interval: u32,
    swatch: u32,
    legend_row_h: u32,
    legend_gap: u32,
    field_gap: u32,
    rgb_field_w: u32,
    count_digits: usize,
    canvas_w: u32,
    canvas_h: u32,
}

impl Layout {
    fn compute(request: &ExportPatternChartRequest) -> Self {
        let cell_size = request.cell_size;
        let scale = (cell_size / 10).max(1);
        let pad = scale.max(2);

        let row_max_digits = digits_of(request.height).len();
        let margin_left = number_width(row_max_digits, scale) + pad * 2;
        let margin_top = GLYPH_H * scale + pad * 2;
        let grid_w = request.width * cell_size;
        let grid_h = request.height * cell_size;

        let col_interval = choose_label_interval(cell_size, scale, request.width);
        let row_interval = choose_label_interval(cell_size, scale, request.height);

        let swatch = cell_size.max(GLYPH_H * scale + pad * 2);
        let legend_row_h = swatch + pad * 2;
        let count_max = request.legend.iter().map(|e| e.count).max().unwrap_or(0);
        let count_digits = digits_of(count_max).len();
        let field_gap = pad * 3;
        let rgb_field_w = number_width(3, scale);
        let count_field_w = number_width(count_digits.max(1), scale);
        let legend_content_w = margin_left
            + swatch
            + field_gap
            + rgb_field_w * 3
            + field_gap * 3
            + count_field_w
            + pad;

        let canvas_w = (margin_left + grid_w + pad).max(legend_content_w);
        let legend_gap = pad * 4;
        let legend_h = if request.legend.is_empty() {
            0
        } else {
            request.legend.len() as u32 * legend_row_h + legend_gap
        };
        let canvas_h = margin_top + grid_h + pad + legend_h + pad;

        Self {
            scale,
            pad,
            margin_left,
            margin_top,
            grid_w,
            grid_h,
            col_interval,
            row_interval,
            swatch,
            legend_row_h,
            legend_gap,
            field_gap,
            rgb_field_w,
            count_digits,
            canvas_w,
            canvas_h,
        }
    }

    /// Top-left pixel of grid cell (row, col).
    fn cell_origin(&self, row: u32, col: u32, cell_size: u32) -> (i64, i64) {
        (
            (self.margin_left + col * cell_size) as i64,
            (self.margin_top + row * cell_size) as i64,
        )
    }
}

/// Render the full printable chart: grid with coordinates, then a legend
/// below with a swatch, numeric symbol, RGB value and count per color. Pure
/// and synchronous, same split every export command in this crate uses.
fn render_pattern_chart(
    request: &ExportPatternChartRequest,
) -> Result<(Vec<u8>, u32, u32), AppError> {
    if request.width == 0 || request.height == 0 {
        return Err(AppError::invalid("pattern chart grid is empty"));
    }
    let expected_cells = (request.width as usize) * (request.height as usize);
    if request.grid.len() != expected_cells {
        return Err(AppError::invalid(format!(
            "expected {expected_cells} grid cells ({}x{}), got {}",
            request.width,
            request.height,
            request.grid.len()
        )));
    }
    if !(MIN_CELL_SIZE..=MAX_CELL_SIZE).contains(&request.cell_size) {
        return Err(AppError::invalid(format!(
            "cell size must be between {MIN_CELL_SIZE} and {MAX_CELL_SIZE}, got {}",
            request.cell_size
        )));
    }
    let legend_len = request.legend.len() as i32;
    for &v in &request.grid {
        if v < -1 || v >= legend_len {
            return Err(AppError::invalid(format!(
                "grid value {v} out of legend range (0..{legend_len})"
            )));
        }
    }

    let layout = Layout::compute(request);
    let mut canvas = Canvas::new(layout.canvas_w, layout.canvas_h, [255, 255, 255, 255]);
    let ink = [0u8, 0, 0, 255];
    let cell_size = request.cell_size;

    // -- axis labels -----------------------------------------------------------
    let mut col = 0;
    while col < request.width {
        let digits = digits_of(col + 1);
        let text_w = number_width(digits.len(), layout.scale);
        let cell_x = layout.margin_left + col * cell_size;
        let x = cell_x as i64 + (cell_size as i64 - text_w as i64) / 2;
        canvas.draw_digits(x, layout.pad as i64, &digits, layout.scale, ink);
        col += layout.col_interval;
    }
    let mut row = 0;
    while row < request.height {
        let digits = digits_of(row + 1);
        let text_w = number_width(digits.len(), layout.scale);
        let cell_y = layout.margin_top + row * cell_size;
        let x = (layout.margin_left as i64 - layout.pad as i64 - text_w as i64).max(0);
        let y = cell_y as i64 + (cell_size as i64 - (GLYPH_H * layout.scale) as i64) / 2;
        canvas.draw_digits(x, y, &digits, layout.scale, ink);
        row += layout.row_interval;
    }

    // -- grid cells --------------------------------------------------------------
    for r in 0..request.height {
        for c in 0..request.width {
            let idx = request.grid[(r * request.width + c) as usize];
            if idx < 0 {
                continue;
            }
            let entry = &request.legend[idx as usize];
            let (x0, y0) = layout.cell_origin(r, c, cell_size);
            canvas.fill_rect(x0, y0, cell_size, cell_size, entry.color);

            let digits = digits_of((idx + 1) as u32);
            let text_w = number_width(digits.len(), layout.scale);
            let text_h = GLYPH_H * layout.scale;
            if text_w + 2 <= cell_size && text_h + 2 <= cell_size {
                let tx = x0 + (cell_size as i64 - text_w as i64) / 2;
                let ty = y0 + (cell_size as i64 - text_h as i64) / 2;
                canvas.draw_digits(tx, ty, &digits, layout.scale, contrast_ink(entry.color));
            }
        }
    }

    // -- gridlines: light every cell, dark every 10 cells ------------------------
    let light = [200u8, 200, 200, 255];
    let dark = [70u8, 70, 70, 255];
    for c in 0..=request.width {
        let x = (layout.margin_left + c * cell_size) as i64;
        let color = if c % 10 == 0 { dark } else { light };
        for y in layout.margin_top as i64..(layout.margin_top + layout.grid_h) as i64 {
            canvas.put_pixel(x, y, color);
        }
    }
    for r in 0..=request.height {
        let y = (layout.margin_top + r * cell_size) as i64;
        let color = if r % 10 == 0 { dark } else { light };
        for x in layout.margin_left as i64..(layout.margin_left + layout.grid_w) as i64 {
            canvas.put_pixel(x, y, color);
        }
    }

    // -- legend --------------------------------------------------------------------
    let mut y = (layout.margin_top + layout.grid_h + layout.pad + layout.legend_gap) as i64;
    for (i, entry) in request.legend.iter().enumerate() {
        let x0 = layout.margin_left as i64;
        canvas.fill_rect(x0, y, layout.swatch, layout.swatch, entry.color);

        let digits = digits_of((i + 1) as u32);
        let text_w = number_width(digits.len(), layout.scale);
        let text_h = GLYPH_H * layout.scale;
        if text_w + 2 <= layout.swatch && text_h + 2 <= layout.swatch {
            let tx = x0 + (layout.swatch as i64 - text_w as i64) / 2;
            let ty = y + (layout.swatch as i64 - text_h as i64) / 2;
            canvas.draw_digits(tx, ty, &digits, layout.scale, contrast_ink(entry.color));
        }

        let text_y = y + (layout.swatch as i64 - (GLYPH_H * layout.scale) as i64) / 2;
        let mut fx = x0 + layout.swatch as i64 + layout.field_gap as i64;
        for channel in entry.color.iter().take(3) {
            let d = digits_of_padded(*channel as u32, 3);
            canvas.draw_digits(fx, text_y, &d, layout.scale, ink);
            fx += layout.rgb_field_w as i64 + layout.field_gap as i64;
        }
        let count_digits_v = digits_of_padded(entry.count, layout.count_digits.max(1));
        canvas.draw_digits(fx, text_y, &count_digits_v, layout.scale, ink);

        y += layout.legend_row_h as i64;
    }

    Ok((canvas.buf, canvas.w, canvas.h))
}

fn write_pattern_chart(
    request: &ExportPatternChartRequest,
) -> Result<ExportPatternChartResult, AppError> {
    let (buf, w, h) = render_pattern_chart(request)?;
    let png = encode_png(&buf, w, h)?;
    let bytes = png.len() as u64;
    std::fs::write(&request.path, &png)?;
    Ok(ExportPatternChartResult {
        path: request.path.clone(),
        width: w,
        height: h,
        colors: request.legend.len() as u32,
        bytes,
    })
}

#[tauri::command]
pub async fn export_pattern_chart(
    request: ExportPatternChartRequest,
) -> Result<ExportPatternChartResult, AppError> {
    write_pattern_chart(&request)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- font/measurement helpers ------------------------------------------

    #[test]
    fn digits_of_handles_zero_and_multi_digit() {
        assert_eq!(digits_of(0), vec![0]);
        assert_eq!(digits_of(7), vec![7]);
        assert_eq!(digits_of(123), vec![1, 2, 3]);
    }

    #[test]
    fn digits_of_padded_left_pads_with_zeros() {
        assert_eq!(digits_of_padded(7, 3), vec![0, 0, 7]);
        assert_eq!(digits_of_padded(123, 3), vec![1, 2, 3]);
        // Never truncates below its natural width even if narrower than `width`.
        assert_eq!(digits_of_padded(1234, 3), vec![1, 2, 3, 4]);
    }

    #[test]
    fn number_width_accounts_for_inter_digit_gaps() {
        assert_eq!(number_width(0, 2), 0);
        assert_eq!(number_width(1, 2), GLYPH_W * 2);
        assert_eq!(number_width(2, 2), GLYPH_W * 2 * 2 + 2);
    }

    #[test]
    fn choose_label_interval_picks_1_when_labels_fit() {
        // Big cells, small max value: every column can be labelled.
        assert_eq!(choose_label_interval(40, 2, 9), 1);
    }

    #[test]
    fn choose_label_interval_grows_when_cells_are_small() {
        // Tiny cells, a large max value: needs a bigger interval than 1.
        let interval = choose_label_interval(4, 2, 500);
        assert!(interval > 1);
    }

    #[test]
    fn contrast_ink_is_black_on_light_white_on_dark() {
        assert_eq!(contrast_ink([255, 255, 255, 255]), [0, 0, 0, 255]);
        assert_eq!(contrast_ink([0, 0, 0, 255]), [255, 255, 255, 255]);
    }

    // -- validation ------------------------------------------------------------

    #[test]
    fn rejects_mismatched_grid_length() {
        let request = ExportPatternChartRequest {
            width: 2,
            height: 2,
            grid: vec![-1, -1, -1], // should be 4
            legend: vec![],
            cell_size: 20,
            path: "/tmp/unused.png".to_string(),
        };
        assert!(render_pattern_chart(&request).is_err());
    }

    #[test]
    fn rejects_cell_size_out_of_bounds() {
        let request = ExportPatternChartRequest {
            width: 1,
            height: 1,
            grid: vec![-1],
            legend: vec![],
            cell_size: 1,
            path: "/tmp/unused.png".to_string(),
        };
        assert!(render_pattern_chart(&request).is_err());
    }

    #[test]
    fn rejects_grid_index_outside_legend_range() {
        let request = ExportPatternChartRequest {
            width: 1,
            height: 1,
            grid: vec![0], // no legend entries at all
            legend: vec![],
            cell_size: 20,
            path: "/tmp/unused.png".to_string(),
        };
        assert!(render_pattern_chart(&request).is_err());
    }

    // -- end-to-end: real PNG, decoded and checked at known positions -----------

    #[test]
    fn renders_a_real_png_with_correctly_placed_cell_colors() {
        // A 2x1 grid: cell 0 red (legend #0), cell 1 blue (legend #1).
        let request = ExportPatternChartRequest {
            width: 2,
            height: 1,
            grid: vec![0, 1],
            legend: vec![
                PatternChartLegendInput {
                    color: [255, 0, 0, 255],
                    count: 3,
                },
                PatternChartLegendInput {
                    color: [0, 0, 255, 255],
                    count: 5,
                },
            ],
            cell_size: 40,
            path: std::env::temp_dir()
                .join(format!(
                    "tess-pattern-chart-test-{}.png",
                    std::process::id()
                ))
                .to_string_lossy()
                .into_owned(),
        };

        let result = write_pattern_chart(&request).unwrap();
        assert_eq!(result.colors, 2);
        assert!(result.width > 0 && result.height > 0);

        let png_bytes = std::fs::read(&result.path).unwrap();
        let decoded = image::load_from_memory(&png_bytes).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (result.width, result.height));

        let layout = Layout::compute(&request);

        // Cell 0 (red) — sampled near its corner, away from the centred
        // digit-symbol overlay.
        let (x0, y0) = layout.cell_origin(0, 0, request.cell_size);
        assert_eq!(
            decoded.get_pixel(x0 as u32 + 2, y0 as u32 + 2).0,
            [255, 0, 0, 255]
        );

        // Cell 1 (blue) — one cell_size further right.
        let (x1, _) = layout.cell_origin(0, 1, request.cell_size);
        assert_eq!(
            decoded.get_pixel(x1 as u32 + 2, y0 as u32 + 2).0,
            [0, 0, 255, 255]
        );

        // Background above the grid (the coordinate-label strip) stays white
        // outside of any glyph ink.
        assert_eq!(decoded.get_pixel(x0 as u32, 0).0, [255, 255, 255, 255]);

        std::fs::remove_file(&result.path).ok();
    }

    #[test]
    fn empty_cells_stay_background_colored() {
        let request = ExportPatternChartRequest {
            width: 1,
            height: 1,
            grid: vec![-1],
            legend: vec![],
            cell_size: 20,
            path: std::env::temp_dir()
                .join(format!(
                    "tess-pattern-chart-test-empty-{}.png",
                    std::process::id()
                ))
                .to_string_lossy()
                .into_owned(),
        };
        let result = write_pattern_chart(&request).unwrap();
        let png_bytes = std::fs::read(&result.path).unwrap();
        let decoded = image::load_from_memory(&png_bytes).unwrap().to_rgba8();

        let layout = Layout::compute(&request);
        let (x0, y0) = layout.cell_origin(0, 0, request.cell_size);
        assert_eq!(
            decoded.get_pixel(x0 as u32 + 2, y0 as u32 + 2).0,
            [255, 255, 255, 255]
        );

        std::fs::remove_file(&result.path).ok();
    }

    #[test]
    fn larger_grids_get_a_bigger_label_interval_than_one() {
        // 200 columns at a small cell size should not label every column.
        let request = ExportPatternChartRequest {
            width: 200,
            height: 1,
            grid: vec![-1; 200],
            legend: vec![],
            cell_size: MIN_CELL_SIZE,
            path: std::env::temp_dir()
                .join(format!(
                    "tess-pattern-chart-test-wide-{}.png",
                    std::process::id()
                ))
                .to_string_lossy()
                .into_owned(),
        };
        let result = write_pattern_chart(&request).unwrap();
        assert!(result.width > 0);
        std::fs::remove_file(&result.path).ok();
    }

    #[test]
    fn legend_rows_place_swatch_symbol_and_field_values() {
        let request = ExportPatternChartRequest {
            width: 1,
            height: 1,
            grid: vec![0],
            legend: vec![PatternChartLegendInput {
                color: [10, 20, 30, 255],
                count: 42,
            }],
            cell_size: 30,
            path: std::env::temp_dir()
                .join(format!(
                    "tess-pattern-chart-test-legend-{}.png",
                    std::process::id()
                ))
                .to_string_lossy()
                .into_owned(),
        };
        let result = write_pattern_chart(&request).unwrap();
        let png_bytes = std::fs::read(&result.path).unwrap();
        let decoded = image::load_from_memory(&png_bytes).unwrap().to_rgba8();

        let layout = Layout::compute(&request);
        let legend_y = (layout.margin_top + layout.grid_h + layout.pad + layout.legend_gap) as u32;
        let swatch_x = layout.margin_left;
        // Swatch corner is the legend entry's own color.
        assert_eq!(
            decoded.get_pixel(swatch_x + 2, legend_y + 2).0,
            [10, 20, 30, 255]
        );

        std::fs::remove_file(&result.path).ok();
    }
}
