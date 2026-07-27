//! The pixel buffer every pipeline stage passes to the next.
//!
//! Mirrors `src/pipeline/buffer.ts`.
//!
//! **Straight alpha, never premultiplied** — the invariant that stops palette
//! quantization from fringing transparent edges (`docs/02-architecture.md` §9).
//! Nothing in the pipeline may premultiply, not even temporarily, without
//! un-premultiplying before the next stage sees it.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelBuffer {
    pub width: u32,
    pub height: u32,
    /// Row-major RGBA, straight alpha, `width * height * 4` bytes.
    pub data: Vec<u8>,
}

impl PixelBuffer {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        Self::check_dimensions(width, height)?;
        Ok(Self {
            width,
            height,
            data: vec![0u8; width as usize * height as usize * 4],
        })
    }

    pub fn from_data(width: u32, height: u32, data: Vec<u8>) -> Result<Self, String> {
        Self::check_dimensions(width, height)?;
        let expected = width as usize * height as usize * 4;
        if data.len() != expected {
            return Err(format!(
                "buffer is {} bytes, expected {expected} for {width}x{height}",
                data.len()
            ));
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    fn check_dimensions(width: u32, height: u32) -> Result<(), String> {
        if width < 1 || height < 1 {
            return Err(format!(
                "buffer dimensions must be positive integers, got {width}x{height}"
            ));
        }
        Ok(())
    }

    pub fn pixel_count(&self) -> usize {
        self.width as usize * self.height as usize
    }

    /// Byte offset of pixel (x, y). No bounds check — callers loop in range.
    pub fn offset(&self, x: u32, y: u32) -> usize {
        (y as usize * self.width as usize + x as usize) * 4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_mismatched_buffer_length() {
        assert!(PixelBuffer::from_data(2, 2, vec![0; 15]).is_err());
        assert!(PixelBuffer::from_data(2, 2, vec![0; 16]).is_ok());
    }

    #[test]
    fn rejects_a_zero_dimension() {
        assert!(PixelBuffer::new(0, 4).is_err());
        assert!(PixelBuffer::new(4, 0).is_err());
    }

    #[test]
    fn offset_is_row_major_rgba() {
        let b = PixelBuffer::new(3, 2).unwrap();
        assert_eq!(b.offset(0, 0), 0);
        assert_eq!(b.offset(2, 0), 8);
        assert_eq!(b.offset(0, 1), 12);
    }
}
