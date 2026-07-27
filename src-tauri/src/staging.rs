//! Getting pixels across the IPC boundary without paying for JSON.
//!
//! **The rule** (`docs/02-architecture.md` §6.2): never send raw pixels
//! through a JSON command. Tauri serializes command arguments to JSON, so a
//! `Vec<u8>` arrives as an array of decimal numbers — several times the size
//! of the data, with a parse cost that dwarfs the image processing itself.
//! Doing that would make the Rust path *slower* than staying in JS, which
//! would quietly defeat the whole architecture.
//!
//! Source images stay in Rust and the frontend holds a handle. But layers the
//! user drew by hand live in the frontend and genuinely have to travel on
//! export. This module is that channel: bytes ride Tauri's **raw invoke body**
//! (`Content-Type: application/octet-stream`, no JSON anywhere) into a staging
//! area, and every subsequent command refers to them by a small integer.
//! Bulk data coming back uses `ipc::Response`, which is likewise raw.
//!
//! > **Q7 is settled: this transport stays (D13).** Measured in the real app
//! > with Q7's own 10 MB payload, the raw invoke body runs at 403 MB/s and a
//! > custom URI protocol at 388 MB/s — indistinguishable — while a JSON command
//! > argument manages 4 MB/s, 97x slower. Channels were eliminated on
//! > capability (they carry data Rust->frontend only) and temp files on
//! > structure (a WebView must pay an IPC transfer before it can write one).
//! > The raw body wins on everything that is not speed: no extra URI scheme, no
//! > CORS surface, one command surface, one error type. Harness in `bench.rs`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::error::AppError;

#[derive(Default)]
pub struct Staging {
    next: AtomicU64,
    slots: Mutex<HashMap<u64, Vec<u8>>>,
}

impl Staging {
    pub fn put(&self, bytes: Vec<u8>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.slots
            .lock()
            .expect("staging poisoned")
            .insert(id, bytes);
        id
    }

    /// Borrow a clone of the staged bytes, leaving them in place. Export may
    /// legitimately run twice over the same staged composite.
    pub fn get(&self, id: u64) -> Result<Vec<u8>, AppError> {
        self.slots
            .lock()
            .expect("staging poisoned")
            .get(&id)
            .cloned()
            .ok_or(AppError::MissingHandle(id))
    }

    pub fn take(&self, id: u64) -> Result<Vec<u8>, AppError> {
        self.slots
            .lock()
            .expect("staging poisoned")
            .remove(&id)
            .ok_or(AppError::MissingHandle(id))
    }

    pub fn release(&self, id: u64) {
        self.slots.lock().expect("staging poisoned").remove(&id);
    }

    pub fn len(&self) -> usize {
        self.slots.lock().expect("staging poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Accept a raw binary body and return a handle to it.
#[tauri::command]
pub fn stage_bytes(request: Request<'_>, staging: State<'_, Staging>) -> Result<u64, AppError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(staging.put(bytes.clone())),
        InvokeBody::Json(_) => Err(AppError::invalid(
            "stage_bytes expects a raw ArrayBuffer body, not JSON",
        )),
    }
}

/// Hand staged bytes back to the frontend as a raw `ArrayBuffer`.
#[tauri::command]
pub fn fetch_staged(id: u64, staging: State<'_, Staging>) -> Result<Response, AppError> {
    Ok(Response::new(staging.take(id)?))
}

#[tauri::command]
pub fn release_staged(id: u64, staging: State<'_, Staging>) {
    staging.release(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_unique_and_nonzero() {
        let staging = Staging::default();
        let a = staging.put(vec![1, 2, 3]);
        let b = staging.put(vec![4]);
        assert_ne!(a, b);
        // Zero is reserved as "no handle" on the TS side.
        assert!(a > 0 && b > 0);
    }

    #[test]
    fn get_leaves_the_bytes_in_place_and_take_removes_them() {
        let staging = Staging::default();
        let id = staging.put(vec![7, 8, 9]);

        assert_eq!(staging.get(id).unwrap(), vec![7, 8, 9]);
        assert_eq!(staging.get(id).unwrap(), vec![7, 8, 9]);

        assert_eq!(staging.take(id).unwrap(), vec![7, 8, 9]);
        assert!(staging.get(id).is_err());
        assert!(staging.is_empty());
    }

    #[test]
    fn unknown_handles_error_rather_than_panic() {
        let staging = Staging::default();
        assert!(matches!(staging.get(42), Err(AppError::MissingHandle(42))));
        // Releasing something that is not there is a no-op, so double-release
        // from the frontend is safe.
        staging.release(42);
    }
}
