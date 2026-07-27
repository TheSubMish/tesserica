//! One error type for every command, serialized to the frontend as a string
//! (`docs/02-architecture.md` §5).
//!
//! Commands return `Result<T, AppError>`; Tauri needs the error half to be
//! `Serialize`, and a flat message is the whole contract — the frontend shows
//! it, it does not branch on it.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("image: {0}")]
    Image(#[from] image::ImageError),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("archive: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("{0}")]
    Invalid(String),

    #[error("no staged data for handle {0}")]
    MissingHandle(u64),
}

impl AppError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::Invalid(msg.into())
    }
}

/// The pipeline (`crate::pipeline`) reports failures as plain `String`s: it is
/// deliberately free of Tauri and of this crate's error type so that it mirrors
/// the TypeScript half exactly. This is the one adapter between the two.
impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
