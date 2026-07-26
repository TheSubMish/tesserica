//! Rust mirror of the TypeScript document types (`docs/03-data-model.md` §8).
//!
//! `#[serde(tag = "kind")]` matches the TS discriminated union exactly, so the
//! wire format needs no translation layer — the same JSON that the frontend
//! holds is what lands in `sprite.json`.
//!
//! **These types are metadata only.** No variant carries pixels; cels name a
//! file inside the archive instead (`docs/02-architecture.md` §6.2).

pub mod document;
