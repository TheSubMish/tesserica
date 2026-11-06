//! Standalone image-format conversion — decode a file in one format and
//! re-encode it in another. Unrelated to `pipeline::convert`: no resize, no
//! palette, no dither, just a transcode, so any bitmap can go in and out
//! regardless of pixel-art content.
//!
//! Follows the same "paths cross IPC, pixels never do" shape every other
//! file command in this module uses (`docs/02-architecture.md` §6.2) —
//! trivially, since this command never even brings the pixels into the
//! frontend's world: Rust reads the source file and writes the target file
//! itself, and only the two paths plus the target format name cross the
//! wire.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Every format this build can both decode *and* encode, as the canonical
/// name `image::ImageFormat::from_extension` accepts for it. Kept as the one
/// source of truth `parse_format` checks against — `Cargo.toml`'s `image`
/// features, this list, and the frontend's own copy
/// (`src/app/imageFormats.ts`) must all change together, or a format offered
/// in the UI would fail at the `image` crate instead of being refused
/// up front.
pub const SUPPORTED_FORMATS: &[&str] = &[
    "png", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tga", "pnm", "qoi", "ff", "hdr", "exr",
];

/// Resolve a target format name to the `image` crate's enum, restricted to
/// exactly `SUPPORTED_FORMATS` — not just whatever `image::ImageFormat::
/// from_extension` happens to recognise, since that also answers for `avif`
/// and `dds`, neither of which this build compiles an encoder for
/// (`Cargo.toml`'s comment on the `image` dependency). Accepting either would
/// surface as an opaque `image` crate error deep inside `save_with_format`
/// instead of an honest refusal here.
fn parse_format(name: &str) -> Result<image::ImageFormat, AppError> {
    let lower = name.to_ascii_lowercase();
    if !SUPPORTED_FORMATS.contains(&lower.as_str()) {
        return Err(AppError::invalid(format!(
            "unsupported target format '{name}' — expected one of {SUPPORTED_FORMATS:?}"
        )));
    }
    // Every entry in `SUPPORTED_FORMATS` is one `image::ImageFormat::
    // from_extension` already recognises by construction, so this can only
    // fail if the two lists have drifted apart.
    image::ImageFormat::from_extension(&lower).ok_or_else(|| {
        AppError::invalid(format!(
            "'{name}' is in SUPPORTED_FORMATS but image::ImageFormat::from_extension doesn't \
             recognise it — the two lists have drifted apart"
        ))
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertImageFormatRequest {
    pub input_path: String,
    pub output_path: String,
    /// One of `SUPPORTED_FORMATS`. Drives the encoder Rust picks — kept
    /// separate from whatever extension `output_path` happens to carry so
    /// the caller's own choice (a `<select>`, not path-sniffing) is always
    /// what gets written, the same way `ExportPngRequest::scale` isn't
    /// inferred from anything either.
    pub format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertImageFormatResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// Decode `input` (format taken from its own extension, same as every other
/// `image::open` call in this codebase) and re-encode it as `format` to
/// `output`.
///
/// `DynamicImage::save_with_format`'s built-in color conversion (dropping
/// alpha, packing to a palette, …) only covers 8-bit color types. Three of
/// `SUPPORTED_FORMATS` don't encode 8-bit at all — Farbfeld is always 16-bit
/// per channel, HDR and OpenEXR are always float — so those three are
/// special-cased, converting to the exact pixel type each format's own
/// encoder demands before writing to it. Verified per-format, not assumed:
/// see `every_supported_format_round_trips_through_png` below, which failed
/// with `does not support the color type` for exactly these three until this
/// existed.
fn convert_one(
    input: &Path,
    output: &Path,
    format: image::ImageFormat,
) -> Result<(u32, u32, u64), AppError> {
    let img = image::open(input)?;
    let (width, height) = (img.width(), img.height());

    match format {
        image::ImageFormat::Farbfeld => img.to_rgba16().save_with_format(output, format)?,
        // Radiance HDR has no alpha channel at all — dropping it here is the
        // format's own limit, not a choice this function makes.
        image::ImageFormat::Hdr => img.to_rgb32f().save_with_format(output, format)?,
        image::ImageFormat::OpenExr => img.to_rgba32f().save_with_format(output, format)?,
        _ => img.save_with_format(output, format)?,
    }

    let bytes = std::fs::metadata(output)?.len();
    Ok((width, height, bytes))
}

#[tauri::command]
pub fn convert_image_format(
    request: ConvertImageFormatRequest,
) -> Result<ConvertImageFormatResult, AppError> {
    let format = parse_format(&request.format)?;
    let input = Path::new(&request.input_path);
    let output = Path::new(&request.output_path);
    if input == output {
        return Err(AppError::invalid(
            "output path must be different from the input path",
        ));
    }

    let (width, height, bytes) = convert_one(input, output, format)?;
    Ok(ConvertImageFormatResult {
        path: request.output_path,
        width,
        height,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "tess-format-convert-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn write_png(path: &Path, width: u32, height: u32, color: [u8; 4]) {
        let mut data = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            data.extend_from_slice(&color);
        }
        image::save_buffer(path, &data, width, height, image::ColorType::Rgba8).unwrap();
    }

    #[test]
    fn every_supported_format_round_trips_through_png() {
        let src = temp_path("src").with_extension("png");
        write_png(&src, 4, 3, [10, 20, 30, 255]);

        let mut failures = Vec::new();
        for &name in SUPPORTED_FORMATS {
            let out = temp_path(&format!("out-{name}"));
            match convert_one(&src, &out, parse_format(name).unwrap()) {
                Ok((width, height, bytes)) => {
                    if (width, height) != (4, 3) {
                        failures.push(format!("{name}: wrong dims {width}x{height}"));
                    }
                    if bytes == 0 {
                        failures.push(format!("{name}: wrote an empty file"));
                    }
                    let out_named = out.with_extension(name);
                    std::fs::rename(&out, &out_named).unwrap();
                    match image::open(&out_named) {
                        Ok(decoded) => {
                            if (decoded.width(), decoded.height()) != (4, 3) {
                                failures.push(format!("{name}: decode dims mismatch"));
                            }
                        }
                        Err(e) => failures.push(format!("{name}: reopen failed: {e}")),
                    }
                    std::fs::remove_file(&out_named).ok();
                }
                Err(e) => failures.push(format!("{name}: encode failed: {e}")),
            }
        }
        std::fs::remove_file(&src).ok();
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn unsupported_format_name_is_refused_up_front() {
        let err = parse_format("avif").unwrap_err();
        assert!(err.to_string().contains("unsupported target format"));

        let err = parse_format("dds").unwrap_err();
        assert!(err.to_string().contains("unsupported target format"));

        let err = parse_format("not-a-format").unwrap_err();
        assert!(err.to_string().contains("unsupported target format"));
    }

    #[test]
    fn format_names_are_case_insensitive() {
        assert_eq!(parse_format("PNG").unwrap(), image::ImageFormat::Png);
    }

    #[test]
    fn same_input_and_output_path_is_rejected() {
        let src = temp_path("same").with_extension("png");
        write_png(&src, 2, 2, [1, 2, 3, 255]);

        let request = ConvertImageFormatRequest {
            input_path: src.to_string_lossy().into_owned(),
            output_path: src.to_string_lossy().into_owned(),
            format: "png".to_string(),
        };
        let err = convert_image_format(request).unwrap_err();
        assert!(err.to_string().contains("must be different"));

        std::fs::remove_file(&src).ok();
    }

    #[test]
    fn the_command_writes_the_requested_format_end_to_end() {
        let src = temp_path("cmd-src").with_extension("png");
        write_png(&src, 5, 5, [200, 100, 50, 255]);
        let out = temp_path("cmd-out").with_extension("bmp");

        let result = convert_image_format(ConvertImageFormatRequest {
            input_path: src.to_string_lossy().into_owned(),
            output_path: out.to_string_lossy().into_owned(),
            format: "bmp".to_string(),
        })
        .unwrap();

        assert_eq!((result.width, result.height), (5, 5));
        assert_eq!(result.path, out.to_string_lossy());
        let decoded = image::open(&out).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (5, 5));

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&out).ok();
    }
}
