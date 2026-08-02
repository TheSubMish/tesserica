//! Tile-id bit packing (`docs/03-data-model.md` §4), mirroring
//! `src/model/tileIds.ts` exactly — bits 0–27 are the tile index, bit 28 is
//! flip-horizontal, bit 29 is flip-vertical, bit 30 is transpose (diagonal
//! flip). Shared by every Rust module that reads or writes a packed tile id:
//! `commands::tilemap_export` (Tesserica → Tiled GID, unpack only — Tiled's
//! ids are always well-formed by construction) and `commands::ase_import`
//! (Aseprite → Tesserica, both directions — an `.ase` file is untrusted
//! input, so packing has to be a total function, see [`pack_tile_id`]).

/// Bits 0–27.
pub const TILE_INDEX_BITS: u32 = 28;
pub const TILE_INDEX_MASK: u32 = (1 << TILE_INDEX_BITS) - 1; // 0x0FFF_FFFF
pub const FLIP_H_BIT: u32 = 1 << 28;
pub const FLIP_V_BIT: u32 = 1 << 29;
pub const TRANSPOSE_BIT: u32 = 1 << 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TileFlags {
    pub flip_h: bool,
    pub flip_v: bool,
    pub transpose: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnpackedTileId {
    pub index: u32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub transpose: bool,
}

/// Unpack a wire id into its tile index and flip/rotate flags — the Rust
/// mirror of `model/tileIds.ts::unpackTileId`.
pub fn unpack_tile_id(id: u32) -> UnpackedTileId {
    UnpackedTileId {
        index: id & TILE_INDEX_MASK,
        flip_h: id & FLIP_H_BIT != 0,
        flip_v: id & FLIP_V_BIT != 0,
        transpose: id & TRANSPOSE_BIT != 0,
    }
}

/// Pack a tile index plus flip/rotate flags into one wire id.
///
/// Unlike `model/tileIds.ts::packTileId` (which throws a `RangeError` on an
/// out-of-range index), this masks the index to the low 28 bits rather than
/// rejecting it: every caller in this codebase constructs the index itself
/// from a trusted source *except* `commands::ase_import`, which is
/// translating another format's own bit-packed ids and needs a total
/// function rather than a panic on a hostile or malformed `.ase` file.
pub fn pack_tile_id(index: u32, flags: TileFlags) -> u32 {
    let mut id = index & TILE_INDEX_MASK;
    if flags.flip_h {
        id |= FLIP_H_BIT;
    }
    if flags.flip_v {
        id |= FLIP_V_BIT;
    }
    if flags.transpose {
        id |= TRANSPOSE_BIT;
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_index_and_every_flag() {
        let id = pack_tile_id(
            42,
            TileFlags {
                flip_h: true,
                flip_v: false,
                transpose: true,
            },
        );
        let unpacked = unpack_tile_id(id);
        assert_eq!(unpacked.index, 42);
        assert!(unpacked.flip_h);
        assert!(!unpacked.flip_v);
        assert!(unpacked.transpose);
    }

    #[test]
    fn packing_masks_an_out_of_range_index_instead_of_panicking() {
        let id = pack_tile_id(TILE_INDEX_MASK + 5, TileFlags::default());
        assert_eq!(unpack_tile_id(id).index, 4);
    }

    #[test]
    fn no_flags_set_round_trips_a_plain_index() {
        let id = pack_tile_id(0, TileFlags::default());
        assert_eq!(id, 0);
    }
}
