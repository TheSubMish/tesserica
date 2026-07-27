//! Rust half of the cross-implementation parity harness
//! (`docs/04-image-pipeline.md` §11).
//!
//! An example rather than a bin: it must never be part of the shipped bundle,
//! but it must be built and linted by `cargo clippy --all-targets`, and an
//! example is exactly that.
//!
//! Usage:
//!
//! ```text
//! cargo run --quiet --example golden -- <jobfile.json>
//! ```
//!
//! The job file carries absolute paths, so the harness does not care what the
//! working directory is:
//!
//! ```json
//! {
//!   "outDir": "/abs/tests/golden/actual",
//!   "jobs": [
//!     { "id": "integrity/gradient", "kind": "sourceIntegrity",
//!       "rgba": "/abs/gradient.rgba", "png": "/abs/gradient.png",
//!       "width": 128, "height": 64 },
//!     { "id": "oklab/gradient", "kind": "oklab",
//!       "rgba": "/abs/gradient.rgba", "width": 128, "height": 64 }
//!   ]
//! }
//! ```
//!
//! Each job writes `<outDir>/<id>.bin` (job-specific payload) and the run
//! writes `<outDir>/report.json`. Job ids may contain `/`; directories are
//! created as needed.
//!
//! Adding a pipeline stage means adding a `kind` here and the matching case in
//! `tests/golden/runner.ts` — never one without the other.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tesserica_lib::pipeline::buffer::PixelBuffer;
use tesserica_lib::pipeline::settings::ConvertSettings;
use tesserica_lib::pipeline::{convert, oklab};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobFile {
    out_dir: PathBuf,
    jobs: Vec<Job>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    kind: String,
    rgba: PathBuf,
    #[serde(default)]
    png: Option<PathBuf>,
    width: u32,
    height: u32,
    /// Present for `convert` jobs. Deserializing it here is itself part of the
    /// test: if the two `ConvertSettings` ever stop agreeing on the wire format,
    /// the harness fails at the boundary rather than producing a mysterious
    /// pixel difference later.
    #[serde(default)]
    settings: Option<ConvertSettings>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobReport {
    id: String,
    kind: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    jobs: Vec<JobReport>,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let job_path = args
        .next()
        .unwrap_or_else(|| fail("usage: golden <jobfile.json>"));

    let text = fs::read_to_string(&job_path)
        .unwrap_or_else(|e| fail(&format!("cannot read {job_path}: {e}")));
    let file: JobFile =
        serde_json::from_str(&text).unwrap_or_else(|e| fail(&format!("bad job file: {e}")));

    fs::create_dir_all(&file.out_dir)
        .unwrap_or_else(|e| fail(&format!("cannot create out dir: {e}")));

    let mut reports = Vec::with_capacity(file.jobs.len());
    let mut failed = false;

    for job in &file.jobs {
        let report = match run_job(job, &file.out_dir) {
            Ok(()) => JobReport {
                id: job.id.clone(),
                kind: job.kind.clone(),
                ok: true,
                detail: None,
            },
            Err(detail) => {
                failed = true;
                JobReport {
                    id: job.id.clone(),
                    kind: job.kind.clone(),
                    ok: false,
                    detail: Some(detail),
                }
            }
        };
        reports.push(report);
    }

    let report = Report { jobs: reports };
    let out = file.out_dir.join("report.json");
    fs::write(
        &out,
        serde_json::to_string_pretty(&report).expect("report serializes"),
    )
    .unwrap_or_else(|e| fail(&format!("cannot write report: {e}")));

    if failed {
        // The harness still reads report.json for the detail, so exit non-zero
        // only after it has been written.
        eprintln!("golden: one or more jobs failed; see {}", out.display());
        std::process::exit(1);
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("golden: {msg}");
    std::process::exit(2);
}

fn run_job(job: &Job, out_dir: &Path) -> Result<(), String> {
    let pixels = read_rgba(&job.rgba, job.width, job.height)?;

    match job.kind.as_str() {
        "sourceIntegrity" => {
            let png = job
                .png
                .as_ref()
                .ok_or_else(|| "sourceIntegrity job has no png path".to_string())?;
            check_png_matches(png, &pixels, job.width, job.height)
        }
        "oklab" => {
            let payload = oklab_payload(&pixels);
            write_payload(out_dir, &job.id, &payload)
        }
        "convert" => {
            let settings = job
                .settings
                .as_ref()
                .ok_or_else(|| "convert job has no settings".to_string())?;
            let source = PixelBuffer::from_data(job.width, job.height, pixels)?;
            let result = convert::convert(&source, settings)?;
            write_payload(out_dir, &job.id, &convert_payload(&result))
        }
        other => Err(format!("unknown job kind {other}")),
    }
}

fn read_rgba(path: &Path, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let expected = width as usize * height as usize * 4;
    if bytes.len() != expected {
        return Err(format!(
            "{} is {} bytes, expected {expected} for {width}x{height}",
            path.display(),
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// The `.png` review copy must decode to exactly the `.rgba` the pipeline reads,
/// or the thing a human looks at is not the thing under test.
fn check_png_matches(png: &Path, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    let img = image::open(png).map_err(|e| format!("cannot decode {}: {e}", png.display()))?;
    let img = img.to_rgba8();
    if img.width() != width || img.height() != height {
        return Err(format!(
            "{} is {}x{}, expected {width}x{height}",
            png.display(),
            img.width(),
            img.height()
        ));
    }
    if img.as_raw().as_slice() != rgba {
        let differing = img
            .as_raw()
            .iter()
            .zip(rgba)
            .filter(|(a, b)| a != b)
            .count();
        return Err(format!(
            "{} decodes to different pixels than the .rgba ({differing} bytes differ)",
            png.display()
        ));
    }
    Ok(())
}

/// Every pixel's Oklab, as little-endian `f64` triples.
///
/// Straight from the 8-bit entry point the pipeline itself uses; alpha is not
/// involved, because alpha never travels through colour distance
/// (`docs/04` §4.4).
fn oklab_payload(pixels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len() / 4 * 24);
    for px in pixels.chunks_exact(4) {
        let c = oklab::srgb8_to_oklab(px[0], px[1], px[2]);
        out.extend_from_slice(&c.l.to_le_bytes());
        out.extend_from_slice(&c.a.to_le_bytes());
        out.extend_from_slice(&c.b.to_le_bytes());
    }
    out
}

/// A converted image, as a self-describing blob:
///
/// ```text
///   u32 LE  width
///   u32 LE  height
///   u16 LE  × width*height   palette indices (0xffff = transparent)
///   u8      × width*height*4 the rendered RGBA
/// ```
///
/// Both halves are sent because they fail differently: the indices are what
/// "exact match" is *defined* on (D12, §11.1), while the RGBA catches a
/// disagreement in the alpha policy or the palette rendering that identical
/// indices would hide.
fn convert_payload(result: &convert::ConvertResult) -> Vec<u8> {
    let img = &result.image;
    let mut out = Vec::with_capacity(8 + result.indices.len() * 2 + img.data.len());
    out.extend_from_slice(&img.width.to_le_bytes());
    out.extend_from_slice(&img.height.to_le_bytes());
    for idx in &result.indices {
        out.extend_from_slice(&idx.to_le_bytes());
    }
    out.extend_from_slice(&img.data);
    out
}

fn write_payload(out_dir: &Path, id: &str, payload: &[u8]) -> Result<(), String> {
    let path = out_dir.join(format!("{id}.bin"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    fs::write(&path, payload).map_err(|e| format!("cannot write {}: {e}", path.display()))
}
