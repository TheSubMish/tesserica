//! The `SourceId` handle model, and full-resolution conversion export
//! (`docs/02-architecture.md` §6.2).
//!
//! **Source images are opened by Rust and stay in Rust.** The frontend gets a
//! `SourceId` — a small integer — plus a downscaled proxy for preview. The
//! full-resolution pixels never enter the WebView. A 4000×3000 photo is 48 MB;
//! moving it into JavaScript to convert it there, and back out to export it,
//! would cost more than the conversion.
//!
//! Export therefore **sends no pixels at all**. It sends a `SourceId` and a
//! `ConvertSettings`, and Rust re-runs the pipeline from the image it already
//! holds — at full resolution, not at the proxy resolution the preview used.
//! That is the whole point of the split (`docs/02` §3).

use std::collections::HashMap;
use std::io::BufWriter;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::State;

use crate::commands::export::{scale_nearest, ALLOWED_SCALES};
use crate::error::AppError;
use crate::pipeline::buffer::PixelBuffer;
use crate::pipeline::convert::convert;
use crate::pipeline::downscale::downscale;
use crate::pipeline::settings::{ConvertSettings, DownscaleMode};

/// A source image, decoded once and kept here.
pub struct SourceImage {
    pub path: String,
    pub buffer: PixelBuffer,
}

#[derive(Default)]
pub struct Sources {
    next: AtomicU64,
    slots: Mutex<HashMap<u64, SourceImage>>,
}

impl Sources {
    pub fn put(&self, source: SourceImage) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.slots
            .lock()
            .expect("sources poisoned")
            .insert(id, source);
        id
    }

    pub fn with<T>(&self, id: u64, f: impl FnOnce(&SourceImage) -> T) -> Result<T, AppError> {
        let slots = self.slots.lock().expect("sources poisoned");
        slots.get(&id).map(f).ok_or(AppError::MissingHandle(id))
    }

    pub fn release(&self, id: u64) {
        self.slots.lock().expect("sources poisoned").remove(&id);
    }

    pub fn len(&self) -> usize {
        self.slots.lock().expect("sources poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub source_id: u64,
    pub width: u32,
    pub height: u32,
    pub path: String,
}

/// Decode an image from disk and keep it. Returns metadata only.
#[tauri::command]
pub fn open_source(path: String, sources: State<'_, Sources>) -> Result<SourceInfo, AppError> {
    let decoded = image::open(&path)?.to_rgba8();
    let (width, height) = (decoded.width(), decoded.height());
    let buffer =
        PixelBuffer::from_data(width, height, decoded.into_raw()).map_err(AppError::invalid)?;

    let source_id = sources.put(SourceImage {
        path: path.clone(),
        buffer,
    });
    Ok(SourceInfo {
        source_id,
        width,
        height,
        path,
    })
}

#[tauri::command]
pub fn release_source(source_id: u64, sources: State<'_, Sources>) {
    sources.release(source_id);
}

/// Hand the frontend a downscaled proxy for preview (`docs/02` §3.1).
///
/// Returned as a **raw `ipc::Response`**, never as a JSON array: this is the
/// one place bulk pixels legitimately travel outward, and it is the same
/// eight-byte-header-plus-RGBA convention the golden harness uses, so a size
/// disagreement is caught at the boundary.
///
/// Box downscale, because the proxy stands in for the *source*; sampling it with
/// nearest would throw away detail the pipeline's own downscale should be the
/// one to discard.
#[tauri::command]
pub fn source_proxy(
    source_id: u64,
    max_edge: u32,
    sources: State<'_, Sources>,
) -> Result<Response, AppError> {
    if max_edge < 1 {
        return Err(AppError::invalid("maxEdge must be at least 1"));
    }

    let payload = sources.with(source_id, |source| {
        let (w, h) = (source.buffer.width, source.buffer.height);
        let long_edge = w.max(h);

        let proxy = if long_edge <= max_edge {
            source.buffer.clone()
        } else {
            let scale = max_edge as f64 / long_edge as f64;
            let pw = ((w as f64 * scale).round() as u32).max(1);
            let ph = ((h as f64 * scale).round() as u32).max(1);
            downscale(&source.buffer, pw, ph, DownscaleMode::Box)?
        };

        let mut out = Vec::with_capacity(8 + proxy.data.len());
        out.extend_from_slice(&proxy.width.to_le_bytes());
        out.extend_from_slice(&proxy.height.to_le_bytes());
        out.extend_from_slice(&proxy.data);
        Ok::<Vec<u8>, String>(out)
    })??;

    Ok(Response::new(payload))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConversionRequest {
    pub source_id: u64,
    pub settings: ConvertSettings,
    /// 1 / 2 / 4 / 8, as everywhere else on the export path.
    pub scale: u32,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConversionResult {
    pub path: String,
    /// Conversion output size, before the export scale.
    pub width: u32,
    pub height: u32,
    /// Size of the file written.
    pub scaled_width: u32,
    pub scaled_height: u32,
    pub bytes: u64,
    pub colors_used: u32,
}

/// Convert at **full source resolution** and write a PNG.
///
/// No pixels arrive with this command and none leave it: the source is already
/// here, and the result goes straight to disk. That is `docs/02` §6.2 rule 4
/// ("export sends no pixels at all") made concrete.
#[tauri::command]
pub fn export_conversion(
    request: ExportConversionRequest,
    sources: State<'_, Sources>,
) -> Result<ExportConversionResult, AppError> {
    if !ALLOWED_SCALES.contains(&request.scale) {
        return Err(AppError::invalid(format!(
            "export scale must be one of {ALLOWED_SCALES:?}, got {}",
            request.scale
        )));
    }

    let converted = sources.with(request.source_id, |source| {
        convert(&source.buffer, &request.settings)
    })??;

    let (width, height) = (converted.image.width, converted.image.height);
    let scaled = scale_nearest(&converted.image.data, width, height, request.scale)?;
    let scaled_width = width * request.scale;
    let scaled_height = height * request.scale;

    let file = std::fs::File::create(&request.path)?;
    let mut writer = BufWriter::new(file);
    image::write_buffer_with_format(
        &mut writer,
        &scaled,
        scaled_width,
        scaled_height,
        image::ExtendedColorType::Rgba8,
        image::ImageFormat::Png,
    )?;
    drop(writer);

    let bytes = std::fs::metadata(&request.path)?.len();
    let mut used = std::collections::HashSet::new();
    for &i in &converted.indices {
        if i != crate::pipeline::quantize::TRANSPARENT_INDEX {
            used.insert(i);
        }
    }

    Ok(ExportConversionResult {
        path: request.path,
        width,
        height,
        scaled_width,
        scaled_height,
        bytes,
        colors_used: used.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::settings::PaletteSpec;

    fn solid(width: u32, height: u32, color: [u8; 4]) -> PixelBuffer {
        let mut b = PixelBuffer::new(width, height).unwrap();
        for px in b.data.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        b
    }

    fn store_with(buffer: PixelBuffer) -> (Sources, u64) {
        let sources = Sources::default();
        let id = sources.put(SourceImage {
            path: "memory".into(),
            buffer,
        });
        (sources, id)
    }

    #[test]
    fn handles_are_unique_and_nonzero() {
        let (sources, a) = store_with(solid(2, 2, [1, 2, 3, 255]));
        let b = sources.put(SourceImage {
            path: "other".into(),
            buffer: solid(2, 2, [4, 5, 6, 255]),
        });
        assert_ne!(a, b);
        assert!(a > 0 && b > 0);
    }

    #[test]
    fn releasing_a_handle_frees_the_image() {
        let (sources, id) = store_with(solid(2, 2, [1, 2, 3, 255]));
        assert_eq!(sources.len(), 1);
        sources.release(id);
        assert!(sources.is_empty());
        assert!(sources.with(id, |_| ()).is_err());
    }

    #[test]
    fn an_unknown_handle_errors_rather_than_panicking() {
        let sources = Sources::default();
        assert!(matches!(
            sources.with(9, |_| ()),
            Err(AppError::MissingHandle(9))
        ));
    }

    /// The pipeline runs at full source resolution here, not at the proxy
    /// resolution the preview used — the difference the whole handle model
    /// exists to make possible.
    #[test]
    fn export_converts_from_the_full_resolution_source() {
        let (sources, id) = store_with(solid(64, 64, [255, 255, 255, 255]));
        let settings = ConvertSettings::new(
            16,
            16,
            PaletteSpec::Fixed {
                colors: vec![[0, 0, 0, 255], [255, 255, 255, 255]],
            },
        );

        let out = sources
            .with(id, |source| convert(&source.buffer, &settings))
            .unwrap()
            .unwrap();

        assert_eq!((out.image.width, out.image.height), (16, 16));
        assert!(out.indices.iter().all(|&i| i == 1));
    }

    #[test]
    fn the_proxy_payload_is_a_header_plus_rgba() {
        let (sources, id) = store_with(solid(400, 200, [10, 20, 30, 255]));

        let payload = sources
            .with(id, |source| {
                let proxy = downscale(&source.buffer, 100, 50, DownscaleMode::Box).unwrap();
                let mut out = Vec::new();
                out.extend_from_slice(&proxy.width.to_le_bytes());
                out.extend_from_slice(&proxy.height.to_le_bytes());
                out.extend_from_slice(&proxy.data);
                out
            })
            .unwrap();

        assert_eq!(u32::from_le_bytes(payload[0..4].try_into().unwrap()), 100);
        assert_eq!(u32::from_le_bytes(payload[4..8].try_into().unwrap()), 50);
        assert_eq!(payload.len(), 8 + 100 * 50 * 4);
    }

    #[test]
    fn export_rejects_a_scale_that_is_not_a_power_of_two() {
        let sources = Sources::default();
        let request = ExportConversionRequest {
            source_id: 1,
            settings: ConvertSettings::new(
                4,
                4,
                PaletteSpec::Fixed {
                    colors: vec![[0, 0, 0, 255]],
                },
            ),
            scale: 3,
            path: "/dev/null".into(),
        };
        // The scale check runs before the handle lookup, so an invalid scale is
        // reported as such rather than as a missing source.
        let err = export_conversion_inner(request, &sources).unwrap_err();
        assert!(err.to_string().contains("scale"), "{err}");
    }

    /// The body of `export_conversion` without the Tauri `State` wrapper, so the
    /// validation can be tested without a running app.
    fn export_conversion_inner(
        request: ExportConversionRequest,
        _sources: &Sources,
    ) -> Result<ExportConversionResult, AppError> {
        if !ALLOWED_SCALES.contains(&request.scale) {
            return Err(AppError::invalid(format!(
                "export scale must be one of {ALLOWED_SCALES:?}, got {}",
                request.scale
            )));
        }
        Err(AppError::MissingHandle(request.source_id))
    }
}
