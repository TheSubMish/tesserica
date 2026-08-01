//! Lospec URL import (`docs/08-roadmap.md` Phase 7 "Lospec URL import
//! (opt-in network)", `docs/06-workflows.md` W8 step 4, `CLAUDE.md` "No
//! network calls in the core — Model download and Lospec fetch are the only
//! network features, both explicitly user-initiated").
//!
//! **Why this fetch happens in Rust, unlike the segmentation-model
//! download** (`commands::segment`, which deliberately keeps `fetch()` in
//! the frontend): measured directly against the real site, `lospec.com`
//! sends no `Access-Control-Allow-Origin` header, so a same-origin-policy
//! `fetch()` from the WebView is rejected by CORS before any request even
//! leaves the browser engine — reproduced by driving the real Vite dev
//! bundle in a real (headless) browser over CDP, where `fetch()` to a real
//! Lospec URL failed with `TypeError: Failed to fetch`, while the identical
//! request from plain Node (which does not enforce CORS) succeeded. Rust's
//! HTTP client has no such restriction. The frontend still owns URL
//! validation and slug extraction (`src/lib/lospecImport.ts`, no network,
//! unit-tested) and still owns parsing the returned text with the existing
//! `.hex` parser — this command's only job is the one thing that must
//! happen off the WebView's own network stack: the GET itself.
//!
//! **Slug, not URL, crosses the boundary.** The command only ever accepts a
//! bare palette slug (a path segment) and always builds the request against
//! the hardcoded `lospec.com` host itself — it cannot be pointed at an
//! arbitrary URL by a caller, even a malicious one, unlike a command that
//! took a full URL argument.
//!
//! A palette page's data is a few hundred bytes to a handful of KB — nothing
//! like the pixel buffers `docs/02-architecture.md` §6.2 keeps off the
//! ordinary IPC path — so the response body crosses back as a plain JSON
//! return value, not through `crate::staging`.

use std::time::Duration;

use serde::Serialize;

use crate::error::AppError;

/// Real slugs answered in ~1-2s when measured against the live site;
/// nonexistent/mistyped ones (slugs are case-sensitive) hung 30s+ with no
/// response at all rather than 404ing promptly. This bounds that failure
/// mode to a finite, reported error instead of a command that never
/// resolves.
const TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Serialize)]
pub struct LospecFetchResult {
    /// `true` for any 2xx response; `false` for any other HTTP status
    /// (`status` still carries the real code so the frontend can report,
    /// e.g., "no palette named X" for a 404 without Rust needing to know
    /// what that means).
    pub ok: bool,
    pub status: u16,
    pub body: String,
}

/// Fetch `https://lospec.com/palette-list/<slug>.hex` and return its status
/// and body. Only a transport-level failure (unreachable host, timeout, TLS
/// error) is an `Err` — an HTTP error status is still an `Ok(LospecFetchResult
/// { ok: false, .. })`, mirroring how the Web Fetch API itself only rejects
/// on network failure, not on a non-2xx response.
#[tauri::command]
pub fn fetch_lospec_palette(slug: String) -> Result<LospecFetchResult, AppError> {
    if slug.is_empty() || slug.contains(['/', '\\']) || slug.contains("..") {
        return Err(AppError::invalid(format!("invalid palette slug: {slug:?}")));
    }

    let url = format!("https://lospec.com/palette-list/{slug}.hex");

    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(TIMEOUT_SECS)))
        .build();
    let agent: ureq::Agent = config.into();

    match agent.get(&url).call() {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let body = response.body_mut().read_to_string().map_err(|e| {
                AppError::invalid(format!("could not read response from lospec.com: {e}"))
            })?;
            Ok(LospecFetchResult { ok: (200..300).contains(&status), status, body })
        }
        Err(ureq::Error::StatusCode(code)) => {
            Ok(LospecFetchResult { ok: false, status: code, body: String::new() })
        }
        Err(ureq::Error::Timeout(_)) => Err(AppError::invalid(format!(
            "timed out waiting for lospec.com (after {TIMEOUT_SECS}s) — check the slug is exact, palette slugs are case-sensitive"
        ))),
        Err(e) => Err(AppError::invalid(format!("could not reach lospec.com: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_slug_containing_a_path_separator() {
        let err = fetch_lospec_palette("../../etc/passwd".into()).unwrap_err();
        assert!(err.to_string().contains("invalid palette slug"));
    }

    #[test]
    fn rejects_an_empty_slug() {
        let err = fetch_lospec_palette(String::new()).unwrap_err();
        assert!(err.to_string().contains("invalid palette slug"));
    }

    #[test]
    fn rejects_a_slug_with_a_backslash() {
        let err = fetch_lospec_palette("foo\\bar".into()).unwrap_err();
        assert!(err.to_string().contains("invalid palette slug"));
    }

    /// A real GET against the real live site — this is the Rust half of the
    /// same proof `src/lib/lospecImport.test.ts`'s mocked-fetch unit tests
    /// cannot give on their own: that this command really can reach
    /// lospec.com from outside the WebView (the whole reason it exists).
    /// Not run by default so `cargo test` stays offline-safe; reproduce with:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml commands::lospec -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "requires real network access to lospec.com"]
    fn real_fetch_of_a_known_palette_succeeds() {
        let result = fetch_lospec_palette("pear36".into()).expect("transport should succeed");
        assert!(result.ok, "expected a 2xx status, got {}", result.status);
        assert_eq!(result.status, 200);
        // Pear36 is a real, stable 36-colour palette; the first line is a
        // known hex triplet on the live site as of 2026-08-01.
        assert!(result.body.contains("5e315b"));
        assert_eq!(
            result.body.lines().filter(|l| !l.trim().is_empty()).count(),
            36
        );
    }

    /// A real nonexistent slug against the live site — measured to hang
    /// 30s+ rather than 404 promptly (module docs), so this proves the
    /// `TIMEOUT_SECS` bound is real and the command settles with a clean
    /// error rather than blocking forever. Slow by design (~20s); not run by
    /// default for that reason as well as needing real network access.
    #[test]
    #[ignore = "requires real network access; deliberately slow (~20s) — exercises the real timeout bound"]
    fn real_fetch_of_a_nonexistent_slug_times_out_cleanly_rather_than_hanging() {
        let err = fetch_lospec_palette("this-slug-almost-certainly-does-not-exist-xyz123".into())
            .expect_err("a nonexistent slug should not resolve to a successful transport");
        assert!(err.to_string().contains("lospec.com"));
    }
}
